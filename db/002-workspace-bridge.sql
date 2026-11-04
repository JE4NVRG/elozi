-- Bridge restricted to the existing local reseller; all statements are atomic.
BEGIN;
SET LOCAL search_path=pg_catalog;
CREATE TABLE IF NOT EXISTS mepchat_private.bridge_state (tenant_id text PRIMARY KEY REFERENCES mepchat.tenants(id), source_id text NOT NULL, revision bigint NOT NULL, synced_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE mepchat_private.bridge_state OWNER TO mepchat_owner;
INSERT INTO mepchat.users(id,display_name) VALUES('mepchat-local-bridge','MEPChat local bridge') ON CONFLICT(id) DO NOTHING;
INSERT INTO mepchat.resellers(id,name) VALUES('mep-demo','MEP Partner') ON CONFLICT(id) DO NOTHING;
INSERT INTO mepchat_private.reseller_memberships VALUES('mep-demo','mepchat-local-bridge','admin',true) ON CONFLICT(reseller_id,user_id) DO NOTHING;
ALTER TABLE mepchat.conversations ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb, source_id text, revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tid text:=snapshot->>'id'; item jsonb; msg jsonb; contact_id text; current_source text; current_revision bigint;
BEGIN
 IF current_user <> 'supabase_admin' OR nullif(current_setting('mepchat.user_id',true),'') <> 'mepchat-local-bridge' OR NOT mepchat_private.reseller_access('mep-demo') THEN RAISE EXCEPTION 'Bridge context denied'; END IF;
 IF snapshot->>'resellerId' IS DISTINCT FROM 'mep-demo' OR tid IS NULL OR length(tid)>100 OR source_id IS NULL OR length(source_id)>100 OR revision IS NULL OR revision<1 THEN RAISE EXCEPTION 'Invalid bridge scope'; END IF;
 IF tid IS DISTINCT FROM nullif(current_setting('mepchat.tenant_id',true),'') THEN RAISE EXCEPTION 'Tenant context mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0));
 IF EXISTS(SELECT 1 FROM mepchat.tenants WHERE id=tid AND reseller_id<>'mep-demo') THEN RAISE EXCEPTION 'Cross-reseller target denied'; END IF;
 SELECT b.source_id,b.revision INTO current_source,current_revision FROM mepchat_private.bridge_state b WHERE tenant_id=tid;
 IF current_source IS NOT NULL AND current_source<>source_id THEN RAISE EXCEPTION 'Different source requires explicit recovery'; END IF;
 IF current_revision>=revision THEN RETURN jsonb_build_object('state','already_synced','revision',current_revision); END IF;
 IF jsonb_typeof(snapshot->'channels')<>'array' OR jsonb_typeof(snapshot->'conversations')<>'array' THEN RAISE EXCEPTION 'Invalid workspace'; END IF;
 UPDATE mepchat.resellers SET name=COALESCE(snapshot->'reseller'->>'name',name),brand=COALESCE(snapshot->'reseller'->'brand',brand) WHERE id='mep-demo';
 INSERT INTO mepchat.tenants(id,reseller_id,name,brand,settings) VALUES(tid,'mep-demo',snapshot->>'name',COALESCE(snapshot->'brand','{}'),jsonb_build_object('segment',snapshot->>'segment','plan',snapshot->>'plan','flows',COALESCE(snapshot->'flows','[]'),'runs',COALESCE(snapshot->'runs','[]')))
 ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,brand=EXCLUDED.brand,settings=EXCLUDED.settings;
 INSERT INTO mepchat_private.tenant_memberships VALUES(tid,'mepchat-local-bridge','admin',true) ON CONFLICT(tenant_id,user_id) DO NOTHING;
 FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'channels') LOOP
  INSERT INTO mepchat.channels(tenant_id,id,kind,name,external_account_id,state,settings) VALUES(tid,item->>'id',item->>'kind',item->>'name',CASE WHEN item->>'transport'='baileys' THEN item->>'expectedNumber' WHEN item->>'transport'='telegram-bot' THEN item->>'botAccountId' ELSE NULL END,COALESCE(item->>'state','planned'),item)
  ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,external_account_id=EXCLUDED.external_account_id,settings=EXCLUDED.settings;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'agents','[]')) LOOP
  INSERT INTO mepchat.agents(tenant_id,id,name,provider,state,service_plan) VALUES(tid,item->>'id',item->>'name',item->>'provider',COALESCE(item->>'state','planned'),item)
  ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,service_plan=EXCLUDED.service_plan;
  FOR msg IN SELECT value FROM jsonb_array_elements(COALESCE(item->'versions','[]')) LOOP
   INSERT INTO mepchat.agent_versions(tenant_id,agent_id,version,config) VALUES(tid,item->>'id',(msg->>'version')::integer,msg->'config') ON CONFLICT(tenant_id,agent_id,version) DO NOTHING;
  END LOOP;
  INSERT INTO mepchat.agent_versions(tenant_id,agent_id,version,config) VALUES(tid,item->>'id',COALESCE((item->>'version')::integer,1),item-'versions') ON CONFLICT(tenant_id,agent_id,version) DO NOTHING;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'conversations') LOOP
  contact_id:=item->>'id';
  INSERT INTO mepchat.contacts(tenant_id,id,name,attributes) VALUES(tid,contact_id,item->>'contact',jsonb_build_object('tags',COALESCE(item->'tags','[]'),'initials',item->>'initials')) ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,attributes=EXCLUDED.attributes;
  INSERT INTO mepchat.conversations(tenant_id,id,channel_id,contact_id,status,owner_kind,assigned_agent_id,version,unread,updated_at,attributes)
  VALUES(tid,item->>'id',item->>'channelId',contact_id,COALESCE(item->>'status','open'),COALESCE(item->>'owner','human'),item->>'agentId',(item->>'version')::bigint,COALESCE((item->>'unread')::integer,0),(item->>'updatedAt')::timestamptz,item-'messages')
  ON CONFLICT(tenant_id,id) DO UPDATE SET status=EXCLUDED.status,owner_kind=EXCLUDED.owner_kind,assigned_agent_id=EXCLUDED.assigned_agent_id,version=EXCLUDED.version,unread=EXCLUDED.unread,updated_at=EXCLUDED.updated_at,attributes=EXCLUDED.attributes;
  FOR msg IN SELECT value FROM jsonb_array_elements(item->'messages') LOOP
   INSERT INTO mepchat.messages(tenant_id,id,conversation_id,channel_id,external_id,direction,content,status,created_at)
   VALUES(tid,msg->>'id',item->>'id',item->>'channelId',msg->>'externalId',CASE msg->>'kind' WHEN 'customer' THEN 'in' WHEN 'human' THEN 'out' ELSE 'system' END,msg,CASE COALESCE(msg->>'delivery','received') WHEN 'sandbox' THEN 'sent' WHEN 'unconfirmed' THEN 'unknown' ELSE COALESCE(msg->>'delivery','received') END,(msg->>'createdAt')::timestamptz)
   ON CONFLICT(tenant_id,id) DO UPDATE SET external_id=EXCLUDED.external_id,status=EXCLUDED.status,content=EXCLUDED.content;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'flows','[]')) LOOP
  INSERT INTO mepchat.flows(tenant_id,id,name,state) VALUES(tid,item->>'id',item->>'name',item->>'state') ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state;
  FOR msg IN SELECT value FROM jsonb_array_elements(COALESCE(item->'versions','[]')) LOOP
   INSERT INTO mepchat.flow_versions(tenant_id,flow_id,version,graph,published_at) VALUES(tid,item->>'id',(msg->>'version')::integer,msg->'graph',(msg->>'publishedAt')::timestamptz) ON CONFLICT(tenant_id,flow_id,version) DO NOTHING;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'runs','[]')) LOOP
  INSERT INTO mepchat.runs(tenant_id,id,conversation_id,conversation_version,agent_id,agent_version,state,budget,created_at,cancelled_at)
  VALUES(tid,item->>'id',item->>'conversationId',(item->>'conversationVersion')::bigint,item->>'agentId',(item->>'agentVersion')::integer,item->>'state',item,(item->>'startedAt')::timestamptz,(item->>'cancelledAt')::timestamptz)
  ON CONFLICT(tenant_id,id) DO UPDATE SET state=EXCLUDED.state,budget=EXCLUDED.budget,cancelled_at=EXCLUDED.cancelled_at;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'outbox','[]')) LOOP
  INSERT INTO mepchat.outbox_commands(tenant_id,id,conversation_id,channel_id,conversation_version,idempotency_key,content_hash,payload,state,attempts,created_at)
  VALUES(tid,item->>'id',item->>'conversation_id',item->>'channel_id',(item->>'version')::bigint,item->>'idempotency_key',item->>'content_hash',(item->>'payload')::jsonb,item->>'state',(item->>'attempts')::integer,(item->>'created_at')::timestamptz)
  ON CONFLICT(tenant_id,id) DO UPDATE SET state=EXCLUDED.state,attempts=EXCLUDED.attempts;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'audit','[]')) LOOP
  INSERT INTO mepchat.audit_events(tenant_id,id,legacy_actor,action,created_at) VALUES(tid,item->>'id',item->>'actor',item->>'action',(item->>'created_at')::timestamptz) ON CONFLICT(tenant_id,id) DO NOTHING;
 END LOOP;
 INSERT INTO mepchat_private.bridge_state VALUES(tid,source_id,revision,now()) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,synced_at=EXCLUDED.synced_at;
 RETURN jsonb_build_object('state','synced','revision',revision);
END $$;
-- This explicitly limited projection procedure requires the maintenance definer;
-- the runtime role itself retains NO SUPERUSER, NO BYPASSRLS and no memberships.
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
