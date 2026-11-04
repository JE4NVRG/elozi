-- LGPD account deletion: the trusted local bridge removes one projected company of a self-registered workspace.
-- Same capability model as provision_reseller/sync_workspace: bridge principal, private source capability per reseller,
-- advisory locks per reseller/company. The platform workspace (mep-demo) is never a target.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Precondition: 002 (bridge principal/state) and 003 (reseller onboarding capability) must already be applied.
-- Without them the function would be created but fail at runtime; refuse instead (the whole transaction rolls back).
DO $workspace_deletion_guard$
BEGIN
 IF current_database()<>'mepchat'
  OR to_regclass('mepchat.resellers') IS NULL OR to_regclass('mepchat.tenants') IS NULL
  OR to_regclass('mepchat_private.bridge_state') IS NULL OR to_regclass('mepchat_private.principal_state') IS NULL
  OR to_regclass('mepchat_private.reseller_sources') IS NULL
  OR to_regprocedure('mepchat_private.provision_reseller(text,text,text)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mepchat_app') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN
  RAISE EXCEPTION 'Workspace deletion migration requires 002-workspace-bridge and 003-reseller-onboarding (bridge_state, principal_state, reseller_sources, provision_reseller)' USING ERRCODE='55000';
 END IF;
END;
$workspace_deletion_guard$;

CREATE OR REPLACE FUNCTION mepchat_private.delete_workspace_tenant(rid text,tid text,source_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $delete$
DECLARE target record; remaining integer; pass integer; removed bigint:=0; count_now bigint; known boolean;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR nullif(current_setting('mepchat.user_id',true),'') IS DISTINCT FROM 'mepchat-local-bridge'
 OR NOT EXISTS(SELECT 1 FROM mepchat_private.principal_state WHERE user_id='mepchat-local-bridge' AND enabled) THEN RAISE EXCEPTION 'Deletion service context denied'; END IF;
 IF rid IS NULL OR rid!~'^reseller_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR tid IS NULL OR tid!~'^tenant_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR source_id IS NULL OR length(source_id)<1 OR length(source_id)>100
 OR rid IS DISTINCT FROM nullif(current_setting('mepchat.reseller_id',true),'')
 OR tid IS DISTINCT FROM nullif(current_setting('mepchat.tenant_id',true),'') THEN RAISE EXCEPTION 'Invalid deletion scope'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-onboard:'||rid,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0));
 known:=EXISTS(SELECT 1 FROM mepchat.resellers WHERE id=rid);
 IF NOT known THEN RETURN jsonb_build_object('state','absent'); END IF;
 -- Only the source that created the reseller may erase it.
 IF NOT EXISTS(SELECT 1 FROM mepchat_private.reseller_sources s WHERE s.reseller_id=rid AND s.source_id=delete_workspace_tenant.source_id) THEN RAISE EXCEPTION 'Source capability denied'; END IF;
 IF EXISTS(SELECT 1 FROM mepchat.tenants WHERE id=tid AND reseller_id<>rid) THEN RAISE EXCEPTION 'Cross-reseller target denied'; END IF;
 IF EXISTS(SELECT 1 FROM mepchat.tenants WHERE id=tid) THEN
  -- Every table keyed by tenant_id, children first: retry passes until foreign keys allow each delete.
  FOR pass IN 1..12 LOOP
   remaining:=0;
   FOR target IN SELECT c.table_schema,c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
     WHERE c.table_schema IN ('mepchat','mepchat_private') AND c.column_name='tenant_id' AND NOT (c.table_schema='mepchat' AND c.table_name='tenants') ORDER BY c.table_schema,c.table_name LOOP
    BEGIN
     EXECUTE format('DELETE FROM %I.%I WHERE tenant_id=$1',target.table_schema,target.table_name) USING tid;
     GET DIAGNOSTICS count_now=ROW_COUNT; removed:=removed+count_now;
    EXCEPTION WHEN foreign_key_violation THEN remaining:=remaining+1;
    END;
   END LOOP;
   EXIT WHEN remaining=0;
  END LOOP;
  IF remaining>0 THEN RAISE EXCEPTION 'Tenant rows still referenced'; END IF;
  DELETE FROM mepchat.tenants WHERE id=tid AND reseller_id=rid; removed:=removed+1;
 END IF;
 -- The last company takes the workspace projection with it.
 IF NOT EXISTS(SELECT 1 FROM mepchat.tenants WHERE reseller_id=rid) THEN
  FOR pass IN 1..6 LOOP
   remaining:=0;
   FOR target IN SELECT c.table_schema,c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
     WHERE c.table_schema IN ('mepchat','mepchat_private') AND c.column_name='reseller_id' AND NOT (c.table_schema='mepchat' AND c.table_name IN ('resellers','tenants')) ORDER BY c.table_schema,c.table_name LOOP
    BEGIN
     EXECUTE format('DELETE FROM %I.%I WHERE reseller_id=$1',target.table_schema,target.table_name) USING rid;
     GET DIAGNOSTICS count_now=ROW_COUNT; removed:=removed+count_now;
    EXCEPTION WHEN foreign_key_violation THEN remaining:=remaining+1;
    END;
   END LOOP;
   EXIT WHEN remaining=0;
  END LOOP;
  IF remaining>0 THEN RAISE EXCEPTION 'Workspace rows still referenced'; END IF;
  DELETE FROM mepchat.resellers WHERE id=rid; removed:=removed+1;
 END IF;
 RETURN jsonb_build_object('state','deleted','rows',removed);
END;
$delete$;
ALTER FUNCTION mepchat_private.delete_workspace_tenant(text,text,text) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.delete_workspace_tenant(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.delete_workspace_tenant(text,text,text) TO mepchat_app;
COMMIT;
