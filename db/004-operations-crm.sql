-- Extend the trusted 003 bridge without changing either 002 or 003 on disk.
-- CRM/departments remain an exact tenant-scoped snapshot in settings. Auth does
-- not enter this projection; human assignment/events already use attributes.
BEGIN;
SET LOCAL search_path=pg_catalog;

DO $preserve_base$
DECLARE definition text;
BEGIN
 IF to_regclass('mepchat_private.reseller_sources') IS NULL THEN
  RAISE EXCEPTION 'Operations projection requires onboarding migration 003';
 END IF;
 IF to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)') IS NULL THEN
  IF to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)') IS NULL THEN
   RAISE EXCEPTION 'Onboarding bridge function absent';
  END IF;
  SELECT pg_get_functiondef('mepchat_private.sync_workspace(jsonb,text,bigint)'::regprocedure) INTO definition;
  ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) RENAME TO sync_workspace_base_003;
  -- PL/pgSQL's implicit parameter block has the function's current name.
  -- Keep 003's source capability guard valid when this body is recompiled.
  definition:=replace(definition,'FUNCTION mepchat_private.sync_workspace(', 'FUNCTION mepchat_private.sync_workspace_base_003(');
  definition:=replace(definition,'sync_workspace.source_id','sync_workspace_base_003.source_id');
  EXECUTE definition;
 END IF;
END;
$preserve_base$;

ALTER FUNCTION mepchat_private.sync_workspace_base_003(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace_base_003(jsonb,text,bigint) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb,source_id text,revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $operations$
DECLARE tid text:=snapshot->>'id'; result jsonb; previous_settings jsonb; projection jsonb:='{}'::jsonb; field text; entries jsonb; limit_count integer;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Operations bridge context denied';
 END IF;
 -- Serialize before reading the prior projection. The same lock is acquired
 -- by 003 and stays held until commit, including the settings extension.
 IF tid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0)); END IF;
 SELECT t.settings INTO previous_settings FROM mepchat.tenants t WHERE t.id=tid;
 previous_settings:=COALESCE(previous_settings,'{}'::jsonb);

 -- All source, revision, principal, reseller and tenant authorization remains
 -- in the preserved 003 function. Validation failures below also roll back its
 -- relational projection; replay never replaces newer operational settings.
 result:=mepchat_private.sync_workspace_base_003(snapshot,source_id,revision);
 IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF;

 FOREACH field IN ARRAY ARRAY['contacts','departments'] LOOP
  IF snapshot ? field THEN
   entries:=snapshot->field;
   IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid operations array: %',field USING ERRCODE='22023';
   END IF;
   limit_count:=CASE WHEN field='contacts' THEN 10000 ELSE 100 END;
   IF jsonb_array_length(entries)>limit_count OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(entries) AS entry(value)
    WHERE jsonb_typeof(value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(value->'id') IS DISTINCT FROM 'string'
     OR length(value->>'id') NOT BETWEEN 1 AND 120
   ) THEN RAISE EXCEPTION 'Invalid operations entries: %',field USING ERRCODE='22023'; END IF;
   IF (SELECT count(*) FROM jsonb_array_elements(entries))<>(SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(entries) AS entry(value)) THEN
    RAISE EXCEPTION 'Duplicate operations identifiers: %',field USING ERRCODE='22023';
   END IF;
   projection:=projection||jsonb_build_object(field,entries);
  ELSIF previous_settings ? field THEN
   projection:=projection||jsonb_build_object(field,previous_settings->field);
  END IF;
 END LOOP;
 IF snapshot ? 'defaultDepartmentId' THEN
  IF jsonb_typeof(snapshot->'defaultDepartmentId') NOT IN ('null','string')
   OR (jsonb_typeof(snapshot->'defaultDepartmentId')='string' AND length(snapshot->>'defaultDepartmentId') NOT BETWEEN 1 AND 120)
  THEN RAISE EXCEPTION 'Invalid default department identifier' USING ERRCODE='22023'; END IF;
  projection:=projection||jsonb_build_object('defaultDepartmentId',snapshot->'defaultDepartmentId');
 ELSIF previous_settings ? 'defaultDepartmentId' THEN
  projection:=projection||jsonb_build_object('defaultDepartmentId',previous_settings->'defaultDepartmentId');
 END IF;

 UPDATE mepchat.tenants t SET settings=t.settings||projection
 WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 RETURN result;
END;
$operations$;
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
