-- Preserve 003's capability guards and the 004/005 operational projections.
-- MCP server metadata is tenant-scoped and contains no bearer credentials.
-- Agent grants and run proposals/receipts already use service_plan and budget.
BEGIN;
SET LOCAL search_path=pg_catalog;

DO $preserve_automation$
DECLARE definition text;
BEGIN
 IF to_regprocedure('mepchat_private.sync_workspace_base_004(jsonb,text,bigint)') IS NULL
  OR to_regprocedure('mepchat_private.valid_automation_calendar(jsonb)') IS NULL THEN
  RAISE EXCEPTION 'MCP projection requires automation migration 005';
 END IF;
 IF to_regprocedure('mepchat_private.sync_workspace_base_005(jsonb,text,bigint)') IS NULL THEN
  IF to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)') IS NULL THEN
   RAISE EXCEPTION 'Automation bridge function absent';
  END IF;
  SELECT pg_get_functiondef('mepchat_private.sync_workspace(jsonb,text,bigint)'::regprocedure) INTO definition;
  ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) RENAME TO sync_workspace_base_005;
  definition:=replace(definition,'FUNCTION mepchat_private.sync_workspace(', 'FUNCTION mepchat_private.sync_workspace_base_005(');
  EXECUTE definition;
 END IF;
END;
$preserve_automation$;
ALTER FUNCTION mepchat_private.sync_workspace_base_005(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace_base_005(jsonb,text,bigint) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb,source_id text,revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $mcp$
DECLARE tid text:=snapshot->>'id'; result jsonb; previous_servers jsonb; servers jsonb; server jsonb; tool jsonb;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'MCP bridge context denied';
 END IF;
 -- Hold the same tenant lock across the old and new projections.
 IF tid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0)); END IF;
 SELECT t.settings->'mcpServers' INTO previous_servers FROM mepchat.tenants t WHERE t.id=tid;
 result:=mepchat_private.sync_workspace_base_005(snapshot,source_id,revision);
 IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF;

 IF snapshot ? 'mcpServers' THEN
  servers:=snapshot->'mcpServers';
  IF jsonb_typeof(servers) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid MCP server catalogue' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(servers)>16 OR octet_length(servers::text)>1048576 THEN
   RAISE EXCEPTION 'MCP server catalogue exceeds limits' USING ERRCODE='22023';
  END IF;
  FOR server IN SELECT value FROM jsonb_array_elements(servers) LOOP
   IF jsonb_typeof(server) IS DISTINCT FROM 'object' OR jsonb_typeof(server->'id') IS DISTINCT FROM 'string'
    OR length(server->>'id') NOT BETWEEN 1 AND 120
    OR jsonb_typeof(server->'name') IS DISTINCT FROM 'string' OR length(server->>'name') NOT BETWEEN 1 AND 120
    OR (server->>'kind') NOT IN ('internal','remote') OR server->>'kind' IS NULL
    OR jsonb_typeof(server->'endpoint') IS DISTINCT FROM 'string' OR length(server->>'endpoint')>2048
    OR jsonb_typeof(server->'enabled') IS DISTINCT FROM 'boolean'
    OR (server->>'state') NOT IN ('configured','verified') OR server->>'state' IS NULL
    OR jsonb_typeof(server->'tools') IS DISTINCT FROM 'array'
    OR jsonb_typeof(server->'version') IS DISTINCT FROM 'number'
    OR (server->>'version') !~ '^[1-9][0-9]{0,15}$'
   THEN RAISE EXCEPTION 'Invalid MCP server metadata' USING ERRCODE='22023'; END IF;
   IF (server->>'version')::numeric>9007199254740991 THEN
    RAISE EXCEPTION 'Invalid MCP server revision' USING ERRCODE='22023';
   END IF;
   IF jsonb_array_length(server->'tools')>32 THEN
    RAISE EXCEPTION 'MCP tool catalogue exceeds limits' USING ERRCODE='22023';
   END IF;
   FOR tool IN SELECT value FROM jsonb_array_elements(server->'tools') LOOP
    IF jsonb_typeof(tool) IS DISTINCT FROM 'object' OR jsonb_typeof(tool->'name') IS DISTINCT FROM 'string'
     OR length(tool->>'name') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(tool->'inputSchema') IS DISTINCT FROM 'object'
     OR (tool ? 'outputSchema' AND jsonb_typeof(tool->'outputSchema') IS DISTINCT FROM 'object')
     OR jsonb_typeof(tool->'hash') IS DISTINCT FROM 'string' OR (tool->>'hash') !~ '^[a-f0-9]{64}$'
     OR (tool ? 'readOnly' AND jsonb_typeof(tool->'readOnly') IS DISTINCT FROM 'boolean')
    THEN RAISE EXCEPTION 'Invalid MCP tool metadata' USING ERRCODE='22023'; END IF;
   END LOOP;
   IF (SELECT count(*) FROM jsonb_array_elements(server->'tools'))<>(SELECT count(DISTINCT value->>'name') FROM jsonb_array_elements(server->'tools') AS entry(value)) THEN
    RAISE EXCEPTION 'Duplicate MCP tool name' USING ERRCODE='22023';
   END IF;
   -- Only server metadata belongs here. Do not inspect schema property names:
   -- a tool can legitimately describe a token argument without containing one.
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(server) AS field(name)
    WHERE lower(name) IN ('token','bearer','apikey','secret','configsecret','credentials','authorization','headers')) THEN
    RAISE EXCEPTION 'MCP credentials must remain outside the projection' USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(servers))<>(SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(servers) AS entry(value)) THEN
   RAISE EXCEPTION 'Duplicate MCP server identifier' USING ERRCODE='22023';
  END IF;
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('mcpServers',servers)
  WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 ELSIF previous_servers IS NOT NULL THEN
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('mcpServers',previous_servers)
  WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 END IF;
 RETURN result;
END;
$mcp$;
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
