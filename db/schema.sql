-- Baseline PostgreSQL 15+ do produto. Executar no banco exclusivo mepchat.
BEGIN;
CREATE SCHEMA mepchat AUTHORIZATION mepchat_owner;
CREATE SCHEMA mepchat_private AUTHORIZATION mepchat_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA mepchat, mepchat_private FROM PUBLIC;
SET LOCAL ROLE mepchat_owner;
SET LOCAL search_path = mepchat, pg_catalog;

CREATE TABLE schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resellers (id text PRIMARY KEY, name text NOT NULL, brand jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id text PRIMARY KEY, display_name text NOT NULL, disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tenants (id text PRIMARY KEY, reseller_id text NOT NULL REFERENCES resellers(id), name text NOT NULL, brand jsonb NOT NULL DEFAULT '{}', settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(reseller_id,id));
CREATE TABLE mepchat_private.tenant_memberships (tenant_id text NOT NULL REFERENCES tenants(id), user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','supervisor','operator','service','viewer')), active boolean NOT NULL DEFAULT true, PRIMARY KEY(tenant_id,user_id));
CREATE TABLE mepchat_private.reseller_memberships (reseller_id text NOT NULL REFERENCES resellers(id), user_id text NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN ('owner','admin','viewer')), active boolean NOT NULL DEFAULT true, PRIMARY KEY(reseller_id,user_id));
CREATE TABLE mepchat_private.auth_identities (provider text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES users(id), PRIMARY KEY(provider,subject));
CREATE TABLE mepchat_private.principal_state (user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, enabled boolean NOT NULL);
CREATE FUNCTION mepchat_private.sync_principal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN INSERT INTO mepchat_private.principal_state VALUES(NEW.id,NEW.disabled_at IS NULL) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION mepchat_private.sync_principal() FROM PUBLIC;
CREATE TRIGGER user_state AFTER INSERT OR UPDATE OF disabled_at ON users FOR EACH ROW EXECUTE FUNCTION mepchat_private.sync_principal();

CREATE FUNCTION mepchat_private.tenant_access(target text, write_access boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT target = nullif(current_setting('mepchat.tenant_id', true),'') AND EXISTS (
   SELECT 1 FROM mepchat_private.tenant_memberships m JOIN mepchat_private.principal_state p ON p.user_id=m.user_id AND p.enabled
   WHERE m.tenant_id=target AND m.user_id=nullif(current_setting('mepchat.user_id', true),'') AND m.active
   AND (NOT write_access OR m.role IN ('admin','operator','service'))
 );
$$;
CREATE FUNCTION mepchat_private.reseller_access(target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT target = nullif(current_setting('mepchat.reseller_id', true),'') AND EXISTS (
   SELECT 1 FROM mepchat_private.reseller_memberships m JOIN mepchat_private.principal_state p ON p.user_id=m.user_id AND p.enabled
   WHERE m.reseller_id=target AND m.user_id=nullif(current_setting('mepchat.user_id', true),'') AND m.active AND m.role IN ('owner','admin')
 );
$$;
REVOKE ALL ON FUNCTION mepchat_private.tenant_access(text,boolean), mepchat_private.reseller_access(text) FROM PUBLIC;
CREATE FUNCTION mepchat_private.tenant_admin(target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
 SELECT target = nullif(current_setting('mepchat.tenant_id',true),'') AND EXISTS (
   SELECT 1 FROM mepchat_private.tenant_memberships m JOIN mepchat_private.principal_state p ON p.user_id=m.user_id AND p.enabled WHERE m.tenant_id=target AND m.user_id=nullif(current_setting('mepchat.user_id',true),'') AND m.active AND m.role='admin'
 );
$$;
REVOKE ALL ON FUNCTION mepchat_private.tenant_admin(text) FROM PUBLIC;

CREATE TABLE channels (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, kind text NOT NULL CHECK(kind IN ('whatsapp_qr','whatsapp_cloud','webchat','telegram','instagram','messenger','email')), name text NOT NULL, external_account_id text, state text NOT NULL DEFAULT 'disconnected', capabilities jsonb NOT NULL DEFAULT '{}', credential_ref text, settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(kind,external_account_id));
CREATE TABLE contacts (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, attributes jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
CREATE TABLE contact_identities (tenant_id text NOT NULL, channel_id text NOT NULL, external_id text NOT NULL, contact_id text NOT NULL, verified_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,channel_id,external_id), FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id));
CREATE TABLE departments (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, PRIMARY KEY(tenant_id,id));
CREATE TABLE agents (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, provider text NOT NULL, state text NOT NULL DEFAULT 'planned', service_plan jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,id));
CREATE TABLE agent_versions (tenant_id text NOT NULL, agent_id text NOT NULL, version integer NOT NULL CHECK(version>0), config jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,agent_id,version), FOREIGN KEY(tenant_id,agent_id) REFERENCES agents(tenant_id,id));
CREATE TABLE flows (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, state text NOT NULL DEFAULT 'draft', PRIMARY KEY(tenant_id,id));
CREATE TABLE flow_versions (tenant_id text NOT NULL, flow_id text NOT NULL, version integer NOT NULL CHECK(version>0), graph jsonb NOT NULL CHECK(jsonb_typeof(graph)='object'), published_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,flow_id,version), FOREIGN KEY(tenant_id,flow_id) REFERENCES flows(tenant_id,id));
CREATE TABLE conversations (tenant_id text NOT NULL, id text NOT NULL, channel_id text NOT NULL, contact_id text NOT NULL, department_id text, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','closed')), owner_kind text NOT NULL DEFAULT 'human' CHECK(owner_kind IN ('human','agent','queue')), assigned_user_id text REFERENCES users(id), assigned_agent_id text, version bigint NOT NULL DEFAULT 1 CHECK(version>0), unread integer NOT NULL DEFAULT 0 CHECK(unread>=0), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,channel_id), FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id), FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,id), FOREIGN KEY(tenant_id,assigned_agent_id) REFERENCES agents(tenant_id,id));
CREATE TABLE messages (tenant_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, channel_id text NOT NULL, external_id text, direction text NOT NULL CHECK(direction IN ('in','out','system')), content jsonb NOT NULL, status text NOT NULL CHECK(status IN ('received','pending','sent','delivered','read','failed','unknown')), created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, read_at timestamptz, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,channel_id,external_id), FOREIGN KEY(tenant_id,conversation_id,channel_id) REFERENCES conversations(tenant_id,id,channel_id));
CREATE TABLE inbound_events (tenant_id text NOT NULL, id text NOT NULL, channel_id text NOT NULL, dedupe_key text NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,channel_id,dedupe_key), FOREIGN KEY(tenant_id,channel_id) REFERENCES channels(tenant_id,id));
CREATE TABLE outbox_commands (tenant_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, channel_id text NOT NULL, conversation_version bigint NOT NULL, idempotency_key text NOT NULL, content_hash text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_flight','confirmed','failed','unknown','cancelled')), attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key), FOREIGN KEY(tenant_id,conversation_id,channel_id) REFERENCES conversations(tenant_id,id,channel_id));
CREATE TABLE runs (tenant_id text NOT NULL, id text NOT NULL, conversation_id text NOT NULL, conversation_version bigint NOT NULL, agent_id text, agent_version integer, flow_id text, flow_version integer, external_run_id text, state text NOT NULL DEFAULT 'pending', budget jsonb NOT NULL DEFAULT '{}', cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id), FOREIGN KEY(tenant_id,agent_id,agent_version) REFERENCES agent_versions(tenant_id,agent_id,version), FOREIGN KEY(tenant_id,flow_id,flow_version) REFERENCES flow_versions(tenant_id,flow_id,version), CHECK((agent_id IS NULL)=(agent_version IS NULL)), CHECK((flow_id IS NULL)=(flow_version IS NULL)));
CREATE TABLE approvals (tenant_id text NOT NULL, id text NOT NULL, run_id text NOT NULL, conversation_version bigint NOT NULL, content_hash text NOT NULL, approver_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, approved_at timestamptz, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id));
CREATE TABLE audit_events (tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, actor_id text REFERENCES users(id), legacy_actor text, action text NOT NULL, resource_type text, resource_id text, created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,id));

CREATE INDEX conversations_inbox ON conversations(tenant_id,status,updated_at DESC);
CREATE INDEX messages_timeline ON messages(tenant_id,conversation_id,created_at,id);
CREATE INDEX outbox_ready ON outbox_commands(state,next_attempt_at) WHERE state='pending';
CREATE INDEX events_unprocessed ON inbound_events(tenant_id,received_at) WHERE processed_at IS NULL;

ALTER TABLE resellers ENABLE ROW LEVEL SECURITY; ALTER TABLE resellers FORCE ROW LEVEL SECURITY;
CREATE POLICY reseller_scope ON resellers TO mepchat_app USING(mepchat_private.reseller_access(id)) WITH CHECK(mepchat_private.reseller_access(id));
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON tenants FOR SELECT TO mepchat_app USING(mepchat_private.tenant_access(id) OR mepchat_private.reseller_access(reseller_id));
CREATE POLICY tenant_write ON tenants FOR ALL TO mepchat_app USING(mepchat_private.reseller_access(reseller_id)) WITH CHECK(mepchat_private.reseller_access(reseller_id));
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY self_user ON users FOR SELECT TO mepchat_app USING(id=nullif(current_setting('mepchat.user_id',true),''));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['channels','contacts','contact_identities','departments','agents','agent_versions','flows','flow_versions','conversations','messages','inbound_events','outbox_commands','runs','approvals','audit_events'] LOOP
   EXECUTE format('ALTER TABLE mepchat.%I ENABLE ROW LEVEL SECURITY',tab);
   EXECUTE format('ALTER TABLE mepchat.%I FORCE ROW LEVEL SECURITY',tab);
   EXECUTE format('CREATE POLICY tenant_read ON mepchat.%I FOR SELECT TO mepchat_app USING(mepchat_private.tenant_access(tenant_id))',tab);
   IF tab = ANY(ARRAY['channels','departments','agents','agent_versions','flows','flow_versions']) THEN
     EXECUTE format('CREATE POLICY tenant_write ON mepchat.%I FOR ALL TO mepchat_app USING(mepchat_private.tenant_admin(tenant_id)) WITH CHECK(mepchat_private.tenant_admin(tenant_id))',tab);
   ELSE
     EXECUTE format('CREATE POLICY tenant_write ON mepchat.%I FOR ALL TO mepchat_app USING(mepchat_private.tenant_access(tenant_id,true)) WITH CHECK(mepchat_private.tenant_access(tenant_id,true))',tab);
   END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA mepchat, mepchat_private TO mepchat_app;
GRANT EXECUTE ON FUNCTION mepchat_private.tenant_access(text,boolean), mepchat_private.reseller_access(text) TO mepchat_app;
GRANT EXECUTE ON FUNCTION mepchat_private.tenant_admin(text) TO mepchat_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA mepchat TO mepchat_app;
REVOKE ALL ON schema_migrations FROM mepchat_app;
REVOKE INSERT,UPDATE,DELETE ON users FROM mepchat_app;
REVOKE UPDATE,DELETE ON agent_versions,flow_versions,inbound_events,audit_events FROM mepchat_app;
GRANT UPDATE(processed_at) ON inbound_events TO mepchat_app;
-- Aprovações só serão gravadas por procedimento específico após integrar auth/runs.
REVOKE INSERT,UPDATE,DELETE ON approvals FROM mepchat_app;
COMMIT;
