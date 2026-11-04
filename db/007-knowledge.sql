-- Knowledge text and excerpts remain private in SQLite. PostgreSQL receives
-- only a strict tenant-scoped metadata catalogue and immutable publication pins.
-- Keep 003's capability guards and the complete 004/005/006 projection chain.
BEGIN;
SET LOCAL search_path=pg_catalog;

DO $preserve_mcp$
DECLARE definition text;
BEGIN
 IF to_regprocedure('mepchat_private.sync_workspace_base_005(jsonb,text,bigint)') IS NULL THEN
  RAISE EXCEPTION 'Knowledge projection requires MCP migration 006';
 END IF;
 IF to_regprocedure('mepchat_private.sync_workspace_base_006(jsonb,text,bigint)') IS NULL THEN
  IF to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)') IS NULL THEN
   RAISE EXCEPTION 'MCP bridge function absent';
  END IF;
  SELECT pg_get_functiondef('mepchat_private.sync_workspace(jsonb,text,bigint)'::regprocedure) INTO definition;
  ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) RENAME TO sync_workspace_base_006;
  definition:=replace(definition,'FUNCTION mepchat_private.sync_workspace(', 'FUNCTION mepchat_private.sync_workspace_base_006(');
  EXECUTE definition;
 END IF;
END;
$preserve_mcp$;
ALTER FUNCTION mepchat_private.sync_workspace_base_006(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace_base_006(jsonb,text,bigint) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.valid_knowledge_source(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $source$
DECLARE publication jsonb;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) field(name)
  WHERE name NOT IN ('id','title','category','version','archived','createdAt','updatedAt','published','publicationCounter')) THEN RETURN false; END IF;
 IF jsonb_typeof(value->'id') IS DISTINCT FROM 'string' OR length(value->>'id') NOT BETWEEN 1 AND 120
  OR jsonb_typeof(value->'title') IS DISTINCT FROM 'string' OR length(value->>'title') NOT BETWEEN 1 AND 120
  OR jsonb_typeof(value->'category') IS DISTINCT FROM 'string' OR length(value->>'category')>80
  OR jsonb_typeof(value->'version') IS DISTINCT FROM 'number' OR (value->>'version') !~ '^[1-9][0-9]{0,15}$'
  OR jsonb_typeof(value->'archived') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(value->'publicationCounter') IS DISTINCT FROM 'number' OR (value->>'publicationCounter') !~ '^(0|[1-9][0-9]{0,15})$'
  OR jsonb_typeof(value->'createdAt') IS DISTINCT FROM 'string' OR length(value->>'createdAt') NOT BETWEEN 1 AND 80
  OR jsonb_typeof(value->'updatedAt') IS DISTINCT FROM 'string' OR length(value->>'updatedAt') NOT BETWEEN 1 AND 80
 THEN RETURN false; END IF;
 IF (value->>'version')::numeric>9007199254740991 OR (value->>'publicationCounter')::numeric>9007199254740991 THEN RETURN false; END IF;
 IF value ? 'published' AND jsonb_typeof(value->'published') IS DISTINCT FROM 'null' THEN
  publication:=value->'published';
  IF jsonb_typeof(publication) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(publication) field(name)
   WHERE name NOT IN ('version','title','hash','publishedAt')) THEN RETURN false; END IF;
  IF jsonb_typeof(publication->'version') IS DISTINCT FROM 'number' OR (publication->>'version') !~ '^[1-9][0-9]{0,15}$'
   OR jsonb_typeof(publication->'title') IS DISTINCT FROM 'string' OR length(publication->>'title') NOT BETWEEN 1 AND 120
   OR jsonb_typeof(publication->'hash') IS DISTINCT FROM 'string' OR (publication->>'hash') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(publication->'publishedAt') IS DISTINCT FROM 'string' OR length(publication->>'publishedAt') NOT BETWEEN 1 AND 80
  THEN RETURN false; END IF;
  IF (publication->>'version')::numeric>9007199254740991 OR (publication->>'version')::numeric>(value->>'publicationCounter')::numeric THEN RETURN false; END IF;
 END IF;
 RETURN true;
END;
$source$;
ALTER FUNCTION mepchat_private.valid_knowledge_source(jsonb) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.valid_knowledge_source(jsonb) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.valid_knowledge_pin(value jsonb,reference boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $pin$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) field(name)
  WHERE name NOT IN ('sourceId','publicationVersion','publicationHash')
   AND NOT (reference AND name IN ('title','chunkId'))) THEN RETURN false; END IF;
 IF jsonb_typeof(value->'sourceId') IS DISTINCT FROM 'string' OR length(value->>'sourceId') NOT BETWEEN 1 AND 120
  OR jsonb_typeof(value->'publicationVersion') IS DISTINCT FROM 'number' OR (value->>'publicationVersion') !~ '^[1-9][0-9]{0,15}$'
  OR jsonb_typeof(value->'publicationHash') IS DISTINCT FROM 'string' OR (value->>'publicationHash') !~ '^[a-f0-9]{64}$'
 THEN RETURN false; END IF;
 IF (value->>'publicationVersion')::numeric>9007199254740991 THEN RETURN false; END IF;
 IF reference AND (jsonb_typeof(value->'title') IS DISTINCT FROM 'string' OR length(value->>'title') NOT BETWEEN 1 AND 120
  OR jsonb_typeof(value->'chunkId') IS DISTINCT FROM 'string' OR length(value->>'chunkId') NOT BETWEEN 1 AND 160) THEN RETURN false; END IF;
 RETURN true;
END;
$pin$;
ALTER FUNCTION mepchat_private.valid_knowledge_pin(jsonb,boolean) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.valid_knowledge_pin(jsonb,boolean) FROM PUBLIC,mepchat_app;

CREATE OR REPLACE FUNCTION mepchat_private.sync_workspace(snapshot jsonb,source_id text,revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $knowledge$
DECLARE tid text:=snapshot->>'id'; result jsonb; previous_sources jsonb; sources jsonb; item jsonb; configuration jsonb;
 entries jsonb; entry jsonb; projected jsonb; previous jsonb; field text; reference boolean; count_limit integer; byte_limit integer;
BEGIN
 IF current_user<>'supabase_admin' OR session_user<>'mepchat_app' OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Knowledge bridge context denied';
 END IF;
 IF tid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('mepchat-bridge:'||tid,0)); END IF;
 SELECT t.settings->'knowledgeSources' INTO previous_sources FROM mepchat.tenants t WHERE t.id=tid;
 -- A rollback runtime omits knowledge fields. Merge only the known fields from
 -- its existing tenant rows; an explicit empty array still clears the field.
 IF jsonb_typeof(snapshot->'agents')='array' THEN
  projected:='[]'::jsonb;
  FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'agents') LOOP
   IF jsonb_typeof(item)='object' AND NOT item ? 'knowledgeGrants' THEN
    SELECT a.service_plan INTO previous FROM mepchat.agents a WHERE a.tenant_id=tid AND a.id=item->>'id';
    IF previous ? 'knowledgeGrants' THEN item:=item||jsonb_build_object('knowledgeGrants',previous->'knowledgeGrants'); END IF;
   END IF;
   projected:=projected||jsonb_build_array(item);
  END LOOP;
  snapshot:=jsonb_set(snapshot,'{agents}',projected);
 END IF;
 IF jsonb_typeof(snapshot->'runs')='array' THEN
  projected:='[]'::jsonb;
  FOR item IN SELECT value FROM jsonb_array_elements(snapshot->'runs') LOOP
   IF jsonb_typeof(item)='object' THEN
    SELECT r.budget INTO previous FROM mepchat.runs r WHERE r.tenant_id=tid AND r.id=item->>'id';
    FOREACH field IN ARRAY ARRAY['knowledgeSnapshot','knowledgeReferences','knowledgeState'] LOOP
     IF NOT item ? field AND previous ? field THEN item:=item||jsonb_build_object(field,previous->field); END IF;
    END LOOP;
   END IF;
   projected:=projected||jsonb_build_array(item);
  END LOOP;
  snapshot:=jsonb_set(snapshot,'{runs}',projected);
 END IF;
 result:=mepchat_private.sync_workspace_base_006(snapshot,source_id,revision);
 -- Preserve replay semantics: an obsolete input cannot replace or erase newer
 -- knowledge, and validation failures in a new revision roll back every layer.
 IF result->>'state' IS DISTINCT FROM 'synced' THEN RETURN result; END IF;
 sources:=CASE WHEN snapshot ? 'knowledgeSources' THEN snapshot->'knowledgeSources' ELSE previous_sources END;
 IF sources IS NOT NULL THEN
  IF jsonb_typeof(sources) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid knowledge catalogue' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(sources)>50 OR octet_length(sources::text)>2097152 THEN RAISE EXCEPTION 'Knowledge catalogue exceeds limits' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(sources) LOOP
   IF mepchat_private.valid_knowledge_source(item) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid knowledge metadata; private text must remain outside the projection' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(sources))<>(SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(sources) entry(value)) THEN
   RAISE EXCEPTION 'Duplicate knowledge source identifier' USING ERRCODE='22023';
  END IF;
  UPDATE mepchat.tenants t SET settings=t.settings||jsonb_build_object('knowledgeSources',sources)
  WHERE t.id=tid AND t.reseller_id=snapshot->>'resellerId';
 END IF;
 -- Current and historical grants use the same scalar pin schema. A publication
 -- may since have changed; old versions/hashes remain valid historical metadata.
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'agents','[]')) LOOP
  FOR configuration IN SELECT item UNION ALL SELECT value->'config' FROM jsonb_array_elements(COALESCE(item->'versions','[]')) LOOP
   IF configuration ? 'knowledgeGrants' THEN
    entries:=configuration->'knowledgeGrants';
    IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid knowledge grants' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(entries)>16 OR octet_length(entries::text)>65536 THEN RAISE EXCEPTION 'Knowledge grants exceed limits' USING ERRCODE='22023'; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
     IF mepchat_private.valid_knowledge_pin(entry) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(sources,'[]')) source(value) WHERE value->>'id'=entry->>'sourceId') THEN
      RAISE EXCEPTION 'Invalid tenant knowledge grant' USING ERRCODE='22023';
     END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(entries))<>(SELECT count(DISTINCT value->>'sourceId') FROM jsonb_array_elements(entries) pin(value)) THEN
     RAISE EXCEPTION 'Duplicate knowledge grant' USING ERRCODE='22023';
    END IF;
   END IF;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(snapshot->'runs','[]')) LOOP
  IF item ? 'knowledgeState' AND (jsonb_typeof(item->'knowledgeState') IS DISTINCT FROM 'string' OR (item->>'knowledgeState') NOT IN ('matched','no_match','not_configured')) THEN
   RAISE EXCEPTION 'Invalid knowledge run state' USING ERRCODE='22023';
  END IF;
  FOREACH field IN ARRAY ARRAY['knowledgeSnapshot','knowledgeReferences'] LOOP
   IF item ? field THEN
    entries:=item->field; reference:=field='knowledgeReferences'; count_limit:=CASE WHEN reference THEN 5 ELSE 16 END; byte_limit:=CASE WHEN reference THEN 8192 ELSE 65536 END;
    IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid knowledge run metadata' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(entries)>count_limit OR octet_length(entries::text)>byte_limit THEN RAISE EXCEPTION 'Knowledge run metadata exceeds limits' USING ERRCODE='22023'; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
     IF mepchat_private.valid_knowledge_pin(entry,reference) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(sources,'[]')) source(value) WHERE value->>'id'=entry->>'sourceId') THEN
      RAISE EXCEPTION 'Invalid tenant knowledge run pin; excerpts must remain private' USING ERRCODE='22023';
     END IF;
     IF reference AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(item->'knowledgeSnapshot','[]')) pin(value)
      WHERE value->>'sourceId'=entry->>'sourceId' AND value->'publicationVersion'=entry->'publicationVersion' AND value->>'publicationHash'=entry->>'publicationHash') THEN
      RAISE EXCEPTION 'Knowledge reference does not match run snapshot' USING ERRCODE='22023';
     END IF;
    END LOOP;
    IF reference THEN
     IF (SELECT count(*) FROM jsonb_array_elements(entries))<>(SELECT count(DISTINCT (value->>'sourceId',value->>'chunkId')) FROM jsonb_array_elements(entries) pin(value)) THEN
      RAISE EXCEPTION 'Duplicate knowledge reference' USING ERRCODE='22023';
     END IF;
    ELSIF (SELECT count(*) FROM jsonb_array_elements(entries))<>(SELECT count(DISTINCT value->>'sourceId') FROM jsonb_array_elements(entries) pin(value)) THEN
     RAISE EXCEPTION 'Duplicate knowledge run source' USING ERRCODE='22023';
    END IF;
   END IF;
  END LOOP;
 END LOOP;
 RETURN result;
END;
$knowledge$;
ALTER FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) OWNER TO supabase_admin;
REVOKE ALL ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mepchat_private.sync_workspace(jsonb,text,bigint) TO mepchat_app;
COMMIT;
