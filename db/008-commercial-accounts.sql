-- Commercial hierarchy is public metadata inside the existing tenant RLS scope.
-- No account relationship creates memberships, principals or operational grants.
-- Preserve the complete capability-checked 003/004/005/006/007 projection chain.
BEGIN;
SET LOCAL search_path=pg_catalog;

DO $preserve_knowledge$
DECLARE definition text;
BEGIN
 IF to_regprocedure('mepchat_private.sync_workspace_base_006(jsonb,text,bigint)') IS NULL
  OR to_regprocedure('mepchat_private.valid_knowledge_source(jsonb)') IS NULL
  OR to_regprocedure('mepchat_private.valid_knowledge_pin(jsonb,boolean)') IS NULL THEN
  RAISE EXCEPTION 'Commercial projection requires knowledge migration 007';
 END IF;
 IF to_regprocedure('mepchat_private.sync_workspace_base_007(jsonb,text,bigint)') IS NULL THEN
  IF to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)') IS NULL THEN
   RAISE EXCEPTION 'Knowledge bridge function absent';
  END IF;
  SELECT pg_get_functiondef('mepchat_private.sync_workspace(jsonb,text,bigint)'::regprocedure) INTO definition;
  ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) RENAME TO sync_workspace_base_007;
  definition:=replace(definition,'FUNCTION mepchat_private.sync_workspace(', 'FUNCTION mepchat_private.sync_workspace_base_007(');
  EXECUTE definition;
 END IF;
END;
$preserve_knowledge$;
ALTER FUNCTION mepchat_private.sync_workspace_base_007(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace_base_007(jsonb,text,bigint) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.valid_commercial_account(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $account$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) field(name)
  WHERE name NOT IN ('id','name','accountKind','parentWorkspaceId','version','createdAt')) THEN RETURN false; END IF;
 IF jsonb_typeof(value->'id') IS DISTINCT FROM 'string' OR length(value->>'id') NOT BETWEEN 1 AND 120
  OR value->>'id'<>btrim(value->>'id') OR value->>'id'~'[[:cntrl:]]'
  OR jsonb_typeof(value->'name') IS DISTINCT FROM 'string' OR length(btrim(value->>'name')) NOT BETWEEN 1 AND 80
  OR value->>'name'~'[[:cntrl:]]'
  OR jsonb_typeof(value->'accountKind') IS DISTINCT FROM 'string' OR value->>'accountKind' NOT IN ('platform','reseller','business')
  OR jsonb_typeof(value->'version') IS DISTINCT FROM 'number' OR (value->>'version') !~ '^[1-9][0-9]{0,15}$'
  OR NOT value ? 'parentWorkspaceId' OR NOT value ? 'createdAt'
 THEN RETURN false; END IF;
 IF (value->>'version')::numeric>9007199254740991 THEN RETURN false; END IF;
 IF jsonb_typeof(value->'parentWorkspaceId') IS DISTINCT FROM 'null' THEN
  IF jsonb_typeof(value->'parentWorkspaceId') IS DISTINCT FROM 'string' OR length(value->>'parentWorkspaceId') NOT BETWEEN 1 AND 120
   OR value->>'parentWorkspaceId'<>btrim(value->>'parentWorkspaceId') OR value->>'parentWorkspaceId'~'[[:cntrl:]]'
   OR value->>'parentWorkspaceId'=value->>'id' THEN RETURN false; END IF;
 END IF;
 IF value->>'accountKind'='platform' AND jsonb_typeof(value->'parentWorkspaceId') IS DISTINCT FROM 'null' THEN RETURN false; END IF;
 IF jsonb_typeof(value->'createdAt') IS DISTINCT FROM 'null' THEN
  IF jsonb_typeof(value->'createdAt') IS DISTINCT FROM 'string' OR length(value->>'createdAt') NOT BETWEEN 1 AND 80
   OR (value->>'createdAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  BEGIN PERFORM (value->>'createdAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false; END;
 END IF;
 RETURN true;
END;
$account$;
ALTER FUNCTION mepchat_private.valid_commercial_account(jsonb) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.valid_commercial_account(jsonb) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.valid_unit_metadata(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $unit$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) field(name) WHERE name NOT IN ('parentTenantId','identityVersion')) THEN RETURN false; END IF;
 IF NOT value ? 'parentTenantId' OR jsonb_typeof(value->'identityVersion') IS DISTINCT FROM 'number'
  OR (value->>'identityVersion') !~ '^[1-9][0-9]{0,15}$' THEN RETURN false; END IF;
 IF (value->>'identityVersion')::numeric>9007199254740991 THEN RETURN false; END IF;
 IF jsonb_typeof(value->'parentTenantId') IS DISTINCT FROM 'null' THEN
  IF jsonb_typeof(value->'parentTenantId') IS DISTINCT FROM 'string' OR length(value->>'parentTenantId') NOT BETWEEN 1 AND 120
   OR value->>'parentTenantId'<>btrim(value->>'parentTenantId') OR value->>'parentTenantId'~'[[:cntrl:]]' THEN RETURN false; END IF;
 END IF;
 RETURN true;
END;
$unit$;
ALTER FUNCTION mepchat_private.valid_unit_metadata(jsonb) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.valid_unit_metadata(jsonb) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb,source_id text,revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $commercial$
DECLARE tid text:=snapshot->>'id'; rid text:=snapshot->>'resellerId'; result jsonb; previous_account jsonb; previous_unit jsonb; account jsonb; unit jsonb;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Commercial bridge context denied';
 END IF;
 IF tid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0)); END IF;
 SELECT t.settings->'commercialAccount',t.settings->'unit' INTO previous_account,previous_unit FROM mepchat.tenants t WHERE t.id=tid;
 result:=mepchat_private.sync_workspace_base_007(snapshot,source_id,revision);
 -- An obsolete revision cannot replace metadata or fail on malformed new fields.
 IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF;
 -- A degraded/rollback runtime omits the new fields. Retain only those existing
 -- metadata objects; the absence never erases a newer commercial relationship.
 account:=CASE WHEN snapshot ? 'commercialAccount' THEN snapshot->'commercialAccount' ELSE previous_account END;
 unit:=CASE WHEN snapshot ? 'unit' THEN snapshot->'unit' ELSE previous_unit END;
 IF account IS NOT NULL THEN
  IF mepchat_private.valid_commercial_account(account) IS DISTINCT FROM true OR account->>'id' IS DISTINCT FROM rid THEN
   RAISE EXCEPTION 'Invalid commercial metadata; credentials and access grants must remain private' USING ERRCODE='22023';
  END IF;
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('commercialAccount',account) WHERE t.id=tid AND t.reseller_id=rid;
 END IF;
 IF unit IS NOT NULL THEN
  IF mepchat_private.valid_unit_metadata(unit) IS DISTINCT FROM true OR unit->>'parentTenantId'=tid THEN
   RAISE EXCEPTION 'Invalid unit metadata' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM mepchat.tenants parent WHERE parent.id=unit->>'parentTenantId' AND parent.reseller_id<>rid) THEN
   RAISE EXCEPTION 'Unit parent belongs to another account' USING ERRCODE='22023';
  END IF;
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('unit',unit) WHERE t.id=tid AND t.reseller_id=rid;
 END IF;
 RETURN result;
END;
$commercial$;
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
