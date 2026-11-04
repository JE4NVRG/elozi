-- Widen the existing channel kind only. No projection, data, RLS or privilege changes.
-- Standalone transaction; an operator may append the source SHA receipt before the final COMMIT.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $telegram_account$
DECLARE
 channel_table oid:=to_regclass('mepchat.channels');
 kind_attribute smallint;
 existing record;
 definition text;
 legacy_definition constant text:=$legacy$CHECK ((kind = ANY (ARRAY['whatsapp_qr'::text, 'whatsapp_cloud'::text, 'webchat'::text, 'telegram'::text, 'instagram'::text, 'messenger'::text, 'email'::text])))$legacy$;
 widened_definition constant text:=$widened$CHECK ((kind = ANY (ARRAY['whatsapp_qr'::text, 'whatsapp_cloud'::text, 'webchat'::text, 'telegram'::text, 'instagram'::text, 'messenger'::text, 'email'::text, 'telegram_user'::text])))$widened$;
BEGIN
 IF current_database()<>'mepchat' OR channel_table IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='mepchat' AND r.rolname='mepchat_owner')
  OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=channel_table AND c.relkind='r' AND r.rolname='mepchat_owner' AND c.relrowsecurity AND c.relforcerowsecurity) THEN
  RAISE EXCEPTION 'Telegram account migration requires the existing mepchat channel table and enforced tenant RLS' USING ERRCODE='55000';
 END IF;
 -- Bound the wait and hold one lock across preflight and replacement. A timeout rolls everything back.
 LOCK TABLE mepchat.channels IN ACCESS EXCLUSIVE MODE;
 SELECT a.attnum INTO kind_attribute FROM pg_attribute a
  WHERE a.attrelid=channel_table AND a.attname='kind' AND a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated='';
 IF kind_attribute IS NULL OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=channel_table AND a.attname IN ('tenant_id','id') AND a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND NOT a.attisdropped)<>2 THEN
  RAISE EXCEPTION 'Unexpected channel identity or kind columns; explicit recovery required' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=channel_table AND c.contype='c' AND kind_attribute=ANY(c.conkey))<>1 THEN
  RAISE EXCEPTION 'Unexpected channel kind constraints; explicit recovery required' USING ERRCODE='55000';
 END IF;
 SELECT c.* INTO existing FROM pg_constraint c WHERE c.conrelid=channel_table AND c.conname='channels_kind_check';
 IF NOT FOUND OR existing.contype<>'c' OR existing.conkey<>ARRAY[kind_attribute]::smallint[]
  OR NOT existing.convalidated OR existing.connoinherit OR NOT existing.conislocal OR existing.coninhcount<>0 THEN
  RAISE EXCEPTION 'Expected validated channels_kind_check is absent or changed' USING ERRCODE='55000';
 END IF;
 definition:=regexp_replace(pg_get_constraintdef(existing.oid,false),'[[:space:]]','','g');
 IF definition=regexp_replace(legacy_definition,'[[:space:]]','','g') THEN
  ALTER TABLE mepchat.channels DROP CONSTRAINT channels_kind_check;
  ALTER TABLE mepchat.channels ADD CONSTRAINT channels_kind_check
   CHECK(kind IN ('whatsapp_qr','whatsapp_cloud','webchat','telegram','instagram','messenger','email','telegram_user'));
 ELSIF definition<>regexp_replace(widened_definition,'[[:space:]]','','g') THEN
  RAISE EXCEPTION 'Channel kind check differs from the known baseline or migration 009' USING ERRCODE='55000';
 END IF;
END;
$telegram_account$;
COMMIT;
