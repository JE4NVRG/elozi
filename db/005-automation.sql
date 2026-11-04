-- Preserve 004's exact operational projection and source capability guards.
-- Automation configuration is tenant JSON; receipts and SLA cycle markers use
-- the existing conversation.attributes/message.content projections.
BEGIN;
SET LOCAL search_path=pg_catalog;

DO $preserve_operations$
DECLARE definition text;
BEGIN
 IF to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)') IS NULL THEN
  RAISE EXCEPTION 'Automation projection requires operations migration 004';
 END IF;
 IF to_regprocedure('mepchat_private.sync_workspace_base_004(jsonb,text,bigint)') IS NULL THEN
  IF to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)') IS NULL THEN
   RAISE EXCEPTION 'Operations bridge function absent';
  END IF;
  SELECT pg_get_functiondef('mepchat_private.sync_workspace(jsonb,text,bigint)'::regprocedure) INTO definition;
  ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) RENAME TO sync_workspace_base_004;
  definition:=replace(definition,'FUNCTION mepchat_private.sync_workspace(', 'FUNCTION mepchat_private.sync_workspace_base_004(');
  EXECUTE definition;
 END IF;
END;
$preserve_operations$;
ALTER FUNCTION mepchat_private.sync_workspace_base_004(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace_base_004(jsonb,text,bigint) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.valid_automation_calendar(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $calendar$
DECLARE beginning integer; ending integer;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)='null' THEN RETURN true; END IF;
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR jsonb_typeof(value->'timezone') IS DISTINCT FROM 'string'
  OR length(value->>'timezone') NOT BETWEEN 1 AND 80 OR jsonb_typeof(value->'days') IS DISTINCT FROM 'array'
  OR jsonb_array_length(value->'days') NOT BETWEEN 1 AND 7
  OR (value->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  OR (value->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  OR value->>'start' IS NULL OR value->>'end' IS NULL
 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(value->'days') AS day(entry) WHERE jsonb_typeof(entry) IS DISTINCT FROM 'number'
   OR entry::text !~ '^[0-6]$') OR
  (SELECT count(*) FROM jsonb_array_elements(value->'days'))<>(SELECT count(DISTINCT entry::text) FROM jsonb_array_elements(value->'days') AS day(entry))
 THEN RETURN false; END IF;
 beginning:=substring(value->>'start',1,2)::integer*60+substring(value->>'start',4,2)::integer;
 ending:=substring(value->>'end',1,2)::integer*60+substring(value->>'end',4,2)::integer;
 RETURN ending-beginning>=15;
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RETURN false;
END;
$calendar$;
ALTER FUNCTION mepchat_private.valid_automation_calendar(jsonb) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.valid_automation_calendar(jsonb) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb,source_id text,revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $automation$
DECLARE tid text:=snapshot->>'id'; result jsonb; previous_automation jsonb; configuration jsonb; bindings jsonb; binding jsonb; sla jsonb;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Automation bridge context denied';
 END IF;
 IF tid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0)); END IF;
 SELECT t.settings->'automation' INTO previous_automation FROM mepchat.tenants t WHERE t.id=tid;
 result:=mepchat_private.sync_workspace_base_004(snapshot,source_id,revision);
 IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF;
 IF snapshot ? 'automation' THEN
  configuration:=snapshot->'automation'; bindings:=configuration->'bindings'; sla:=configuration->'sla';
  IF jsonb_typeof(configuration) IS DISTINCT FROM 'object' OR length(configuration::text)>262144
   OR jsonb_typeof(configuration->'version') IS DISTINCT FROM 'number'
   OR (configuration->>'version') !~ '^[1-9][0-9]{0,15}$'
   OR jsonb_typeof(bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(bindings)>50
   OR jsonb_typeof(sla) IS DISTINCT FROM 'object' OR jsonb_typeof(sla->'enabled') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(sla->'firstReplyMinutes') IS DISTINCT FROM 'number' OR (sla->>'firstReplyMinutes') !~ '^[1-9][0-9]{0,4}$'
   OR jsonb_typeof(sla->'resolutionMinutes') IS DISTINCT FROM 'number' OR (sla->>'resolutionMinutes') !~ '^[1-9][0-9]{0,4}$'
   OR mepchat_private.valid_automation_calendar(sla->'calendar') IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'Invalid automation configuration' USING ERRCODE='22023'; END IF;
  IF (configuration->>'version')::numeric>9007199254740991 OR (sla->>'firstReplyMinutes')::numeric>43200
   OR (sla->>'resolutionMinutes')::numeric>43200
  THEN RAISE EXCEPTION 'Invalid automation numeric bounds' USING ERRCODE='22023'; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(bindings) LOOP
   IF jsonb_typeof(binding) IS DISTINCT FROM 'object' OR jsonb_typeof(binding->'id') IS DISTINCT FROM 'string'
    OR length(binding->>'id') NOT BETWEEN 1 AND 160 OR jsonb_typeof(binding->'name') IS DISTINCT FROM 'string'
    OR length(binding->>'name') NOT BETWEEN 1 AND 80 OR jsonb_typeof(binding->'enabled') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(binding->'channelId') IS DISTINCT FROM 'string' OR length(binding->>'channelId') NOT BETWEEN 1 AND 160
    OR jsonb_typeof(binding->'flowId') IS DISTINCT FROM 'string' OR length(binding->>'flowId') NOT BETWEEN 1 AND 160
    OR jsonb_typeof(binding->'flowVersion') IS DISTINCT FROM 'number' OR (binding->>'flowVersion') !~ '^[1-9][0-9]{0,15}$'
    OR (binding->>'trigger') NOT IN ('incoming','new_conversation','command') OR binding->>'trigger' IS NULL
    OR jsonb_typeof(binding->'authorizedBy') IS DISTINCT FROM 'string' OR length(binding->>'authorizedBy') NOT BETWEEN 1 AND 160
    OR mepchat_private.valid_automation_calendar(binding->'calendar') IS DISTINCT FROM true
    OR ((binding->>'trigger')='command' AND ((binding->>'command') !~ '^/[a-z][a-z0-9_]{0,31}$' OR binding->>'command' IS NULL))
   THEN RAISE EXCEPTION 'Invalid automation binding' USING ERRCODE='22023'; END IF;
   IF (binding->>'flowVersion')::numeric>9007199254740991 THEN RAISE EXCEPTION 'Invalid automation flow revision' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(bindings))<>(SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(bindings) entry(value)) THEN
   RAISE EXCEPTION 'Duplicate automation binding identifier' USING ERRCODE='22023';
  END IF;
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('automation',configuration)
  WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 ELSIF previous_automation IS NOT NULL THEN
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('automation',previous_automation)
  WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 END IF;
 RETURN result;
END;
$automation$;
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
