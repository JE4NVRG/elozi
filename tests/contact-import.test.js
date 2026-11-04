import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { ContactService } from '../src/contacts.js';
import { CONTACT_IMPORT_LIMITS, ContactImportService, normalizeImportedPhone, parseContactImport } from '../src/contact-import.js';

const admin = { userId: 'synthetic-import-admin', name: 'Gestor sintético', role: 'reseller', resellerId: 'mep-demo' };
const status = value => error => error.status === value;
const record = (name = 'Pessoa sintética', phone = '11 98765-4321', extra = {}) => ({ name, phone, ...extra });
function fixture(t, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tenantId = store.createTenant(admin, { name: 'Empresa sintética', segment: 'Teste' }).id;
  store.mutate(admin, tenantId, 'Fixture: canais', state => { state.channels = [{ id: 'wa-a', kind: 'whatsapp_qr' }, { id: 'wa-b', kind: 'whatsapp_cloud' }, { id: 'tg', kind: 'telegram' }]; });
  const auth = { denied: false, calls: [], can(actor, permission, scope) {
    this.calls.push({ permission, scope });
    return Boolean(actor.userId && !this.denied && !actor.deny && ['contacts.read', 'contacts.write'].includes(permission) && (!actor.channels || actor.channels.includes(scope.channelId)) && !actor.departments);
  } };
  return { store, auth, tenantId, service: new ContactImportService(store, auth, options), contacts: new ContactService(store, auth) };
}
function preview(f, records, channelId = 'wa-a', actor = admin) { return f.service.preview(actor, f.tenantId, { channelId, format: 'json', content: JSON.stringify(records) }); }
function confirmation(value) { return { previewId: value.previewId, hash: value.hash, version: value.version }; }
function raw(f) { return f.store.tenant(admin, f.tenantId); }

test('CSV BOM/semicolon, commas/quotes and multiline notes are plain strings', () => {
  const parsed = parseContactImport({ format: 'csv', content: '\uFEFFNome;Número;E-mail;Observações;Etiquetas\r\n"Pessoa; Sintética";"(11) 98765-4321";"PERSON@EXAMPLE.TEST";"Nota com ""aspas""\r\ne segunda linha";"Cliente|Suporte"\r\n' });
  assert.equal(parsed[0].status, 'valid');
  assert.equal(parsed[0].name, 'Pessoa; Sintética');
  assert.equal(parsed[0].phone, '5511987654321');
  assert.equal(parsed[0].email, 'person@example.test');
  assert.equal(parsed[0].notes, 'Nota com "aspas"\r\ne segunda linha');
  assert.deepEqual(parsed[0].tags, ['Cliente', 'Suporte']);
  const comma = parseContactImport({ format: 'csv', content: 'name,phone,notes\n"Pessoa, sintética",11987654321,"=SUM(1,2)"\n' });
  assert.equal(comma[0].notes, '=SUM(1,2)');
  for (const content of ['nome;telefone\n"aberto;11987654321', 'nome;telefone\n"fechado"x;11987654321', 'nome;telefone\na"b;11987654321']) assert.throws(() => parseContactImport({ format: 'csv', content }), status(400));
});

test('JSON accepts only known contact fields, aliases and text tags', () => {
  for (const envelope of [items => items, contacts => ({ contacts }), contatos => ({ contatos }), data => ({ data })]) {
    const rows = parseContactImport({ format: 'json', content: JSON.stringify(envelope([{ Nome: 'Pessoa', Número: '11987654321', 'E-mail': 'PERSON@EXAMPLE.TEST', Etiquetas: ['Cliente', 'Cliente'], id: 'ignored', companyId: 'ignored', extraInfo: [{ name: 'ignored', value: 'ignored' }] }])) });
    assert.equal(rows[0].status, 'valid'); assert.deepEqual(rows[0].tags, ['Cliente']);
    assert.equal(rows[0].email, 'person@example.test'); assert.equal(Object.hasOwn(rows[0], 'id'), false);
  }
  const invalid = parseContactImport({ format: 'json', content: JSON.stringify([record('Nome', 11987654321), record('Nome', '11987654321', { tags: [{ name: 'Cliente' }] }), record('Grupo', '11987654321', { isGroup: true }), { name: 'Nome', nome: 'Outro', number: '11987654321' }]) });
  assert.equal(invalid.filter(row => row.status === 'invalid').length, 4);
  for (const content of ['[{"__proto__":{"role":"reseller"},"name":"Pessoa","number":"11987654321"}]', '[{"extraInfo":{"constructor":"x"}}]', '{"contacts":[],"data":[]}']) assert.throws(() => parseContactImport({ format: 'json', content }), status(400));
  assert.equal(Object.prototype.role, undefined);
});

test('BR phone normalization preserves eight/nine subscriber digits and refuses ambiguous forms', () => {
  for (const phone of ['(11) 98765-4321', '+55 11 98765-4321', '5511987654321']) assert.equal(normalizeImportedPhone(phone), '5511987654321');
  assert.equal(normalizeImportedPhone('11 8765-4321'), '551187654321');
  assert.equal(normalizeImportedPhone('11 3456-7890'), '551134567890');
  for (const phone of ['98765-4321', '+1 212 555 1234', '5511987654321@s.whatsapp.net', '11 98765-4321 ramal 1', '11 87654-3210', '20 98765-4321', '11 1111-1111', '11\n98765-4321', '=11987654321', '005511987654321', 11987654321, null]) assert.throws(() => normalizeImportedPhone(phone), status(400));
});

test('file bytes/row/column limits and CSV shape are bounded', () => {
  assert.throws(() => parseContactImport({ format: 'csv', content: 'x'.repeat(CONTACT_IMPORT_LIMITS.bytes + 1) }), status(413));
  assert.throws(() => parseContactImport({ format: 'json', content: JSON.stringify(Array(CONTACT_IMPORT_LIMITS.rows + 1).fill(record())) }), status(413));
  assert.throws(() => parseContactImport({ format: 'csv', content: 'name,phone\n' + Array(CONTACT_IMPORT_LIMITS.rows + 1).fill('Pessoa,11987654321').join('\n') }), status(413));
  assert.throws(() => parseContactImport({ format: 'csv', content: Array(41).fill('x').join(',') }), status(413));
  for (const content of ['name,name,phone\nA,B,11987654321', 'name,phone,number\nA,11987654321,11987654321', '__proto__,name,phone\nx,A,11987654321', 'name,email\nPessoa,a@example.test']) assert.throws(() => parseContactImport({ format: 'csv', content }), status(400));
  const malformed = parseContactImport({ format: 'csv', content: 'name,phone\nPessoa,11987654321,extra' });
  assert.equal(malformed[0].status, 'invalid');
});

test('preview does not mutate; apply creates only CRM records and retry returns the receipt', t => {
  const f = fixture(t), before = raw(f), auditBefore = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const p = preview(f, [record(), record(), record('Incompleto', '123')]);
  assert.deepEqual(p.counts, { total: 3, valid: 1, review: 0, duplicate: 1, conflict: 0, invalid: 1 });
  assert.deepEqual(raw(f), before); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditBefore);
  const applied = f.service.apply(admin, f.tenantId, confirmation(p));
  assert.equal(applied.imported, 1); assert.equal(applied.replayed, false);
  const after = raw(f), contact = after.contacts[0];
  assert.deepEqual(contact.identities, [{ channelId: 'wa-a', kind: 'person', externalId: '5511987654321@s.whatsapp.net' }]);
  assert.equal(contact.version, 1); assert.deepEqual(after.conversations, before.conversations);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'contacts'].sort());
  const auditAfter = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const replay = f.service.apply(admin, f.tenantId, confirmation(p));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.contactIds, applied.contactIds);
  assert.deepEqual(raw(f), after); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditAfter);
  assert.equal(f.service.previews.get(p.previewId).rows.length, 0);
});

test('same name never merges; equal phone stays separate by channel and tenant', t => {
  const f = fixture(t);
  const first = preview(f, [record('Mesmo nome'), record('Mesmo nome', '11 98765-4322')]);
  assert.equal(f.service.apply(admin, f.tenantId, confirmation(first)).imported, 2);
  const anotherChannel = preview(f, [record('Mesmo nome')], 'wa-b');
  assert.equal(anotherChannel.counts.valid, 1); assert.equal(f.service.apply(admin, f.tenantId, confirmation(anotherChannel)).imported, 1);
  const otherId = f.store.createTenant(admin, { name: 'Empresa separada', segment: 'Teste' }).id;
  f.store.mutate(admin, otherId, 'Fixture: canal', state => { state.channels = [{ id: 'wa-a', kind: 'whatsapp_qr' }]; });
  const other = f.service.preview(admin, otherId, { channelId: 'wa-a', format: 'json', content: JSON.stringify([record()]) });
  assert.equal(f.service.apply(admin, otherId, confirmation(other)).imported, 1);
  assert.equal(raw(f).contacts.length, 3);
});

test('existing exact identity skips, divergent/archived/unverified contacts report conflicts without overwrite', t => {
  const f = fixture(t), initial = preview(f, [record()]);
  f.service.apply(admin, f.tenantId, confirmation(initial));
  const before = JSON.stringify(raw(f));
  const same = preview(f, [record()]); assert.equal(same.counts.duplicate, 1);
  const different = preview(f, [record('Nome importado')]); assert.equal(different.counts.conflict, 1);
  assert.equal(f.service.apply(admin, f.tenantId, confirmation(different)).imported, 0);
  assert.equal(JSON.stringify(raw(f)), before);
  f.store.mutate(admin, f.tenantId, 'Fixture: arquivo e manual', state => {
    state.contacts[0].archivedAt = '2026-10-02T00:00:00.000Z'; state.contacts[0].version++;
    state.contacts.push({ id: 'manual', name: 'Manual', type: 'person', phone: '11 98765-4322', identities: [], version: 1 });
  });
  const archived = preview(f, [record(), record('Manual', '11 98765-4322')]);
  assert.equal(archived.counts.conflict, 2); assert.equal(f.service.apply(admin, f.tenantId, confirmation(archived)).imported, 0);
  assert.equal(raw(f).contacts.length, 2);
});

test('in-file data divergence prevents choosing an arbitrary winner', t => {
  const f = fixture(t), p = preview(f, [record('Nome A'), record('Nome B'), record('Nome único', '11 98765-4322')]);
  assert.equal(p.counts.conflict, 2); assert.equal(p.counts.valid, 1);
  assert.equal(f.service.apply(admin, f.tenantId, confirmation(p)).imported, 1);
  assert.equal(raw(f).contacts[0].name, 'Nome único');
});

test('apply requires matching preview actor/workspace/tenant/hash and current contact revision', t => {
  const f = fixture(t), p = preview(f, [record()]);
  const token = confirmation(p);
  assert.throws(() => f.service.apply({ ...admin, userId: 'other' }, f.tenantId, token), status(409));
  assert.throws(() => f.service.apply({ ...admin, resellerId: 'other' }, f.tenantId, token), status(409));
  assert.throws(() => f.service.apply(admin, 'studio-demo', token), status(409));
  assert.throws(() => f.service.apply(admin, f.tenantId, { ...token, hash: 'f'.repeat(64) }), status(409));
  assert.throws(() => f.service.apply(admin, f.tenantId, { ...token, version: 'f'.repeat(64) }), status(409));
  assert.throws(() => f.service.apply(admin, f.tenantId, { ...token, rows: [] }), status(400));
  f.store.mutate(admin, f.tenantId, 'Fixture: concorrência', state => { state.contacts = [{ id: 'other', name: 'Pessoa', type: 'person', version: 1, identities: [] }]; });
  assert.throws(() => f.service.apply(admin, f.tenantId, token), status(409));
  assert.equal(raw(f).contacts.length, 1);
});

test('expiry or service restart requires repreview; receipt reuse remains authorized', t => {
  let time = Date.parse('2026-10-02T00:00:00.000Z');
  const f = fixture(t, { clock: () => time }), p = preview(f, [record()]);
  assert.throws(() => new ContactImportService(f.store, f.auth).apply(admin, f.tenantId, confirmation(p)), status(409));
  time += CONTACT_IMPORT_LIMITS.ttlMs;
  assert.throws(() => f.service.apply(admin, f.tenantId, confirmation(p)), status(409));
  assert.equal(f.service.previews.size, 0);
  const fresh = preview(f, [record()]); f.service.apply(admin, f.tenantId, confirmation(fresh));
  f.auth.denied = true;
  assert.throws(() => f.service.apply(admin, f.tenantId, confirmation(fresh)), status(403));
});

test('authorization is current, channel-specific and refuses invented department context', t => {
  const f = fixture(t), scoped = { ...admin, channels: ['wa-a'] };
  const p = preview(f, [record()], 'wa-a', scoped);
  assert.throws(() => preview(f, [record()], 'wa-b', scoped), status(403));
  assert.throws(() => preview(f, [record()], 'tg', scoped), status(403));
  assert.throws(() => preview(f, [record()], 'foreign', scoped), status(403));
  assert.throws(() => preview(f, [record()], 'foreign'), status(404));
  assert.throws(() => preview(f, [record()], 'tg'), status(400));
  assert.throws(() => preview(f, [record()], 'wa-a', { ...admin, departments: ['support'] }), status(403));
  assert.throws(() => f.service.preview(admin, f.tenantId, { channelId: 'wa-a', format: 'json', content: '[]', departmentId: 'support' }), status(400));
  f.auth.denied = true;
  assert.throws(() => f.service.apply(scoped, f.tenantId, confirmation(p)), status(403));
  assert.equal(raw(f).contacts, undefined);
  assert.ok(f.auth.calls.every(call => Object.keys(call.scope).sort().join(',') === 'channelId,tenantId'));
});

test('Store mutation failure rolls back the whole import and does not cache success', t => {
  const f = fixture(t), p = preview(f, [record(), record('Pessoa B', '11 98765-4322')]), before = JSON.stringify(raw(f));
  const auditCount = f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  f.store.queuePostgres = () => { throw new Error('Falha sintética da transação'); };
  assert.throws(() => f.service.apply(admin, f.tenantId, confirmation(p)), /Falha sintética/);
  assert.equal(JSON.stringify(raw(f)), before); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditCount);
  assert.equal(f.service.previews.get(p.previewId).result, undefined);
  delete f.store.queuePostgres;
  assert.equal(f.service.apply(admin, f.tenantId, confirmation(p)).imported, 2);
});

test('returned preview data is detached from the authorized apply payload', t => {
  const f = fixture(t), p = preview(f, [record()]);
  p.rows[0].name = 'Nome alterado no browser'; p.rows[0].phone = '5511987654322'; p.counts.valid = 100;
  const applied = f.service.apply(admin, f.tenantId, confirmation(p));
  assert.equal(applied.imported, 1); assert.equal(raw(f).contacts[0].name, 'Pessoa sintética');
  assert.equal(raw(f).contacts[0].phone, '5511987654321');
  assert.equal(f.contacts.list(admin, f.tenantId).length, 1);
});

test('10.000-row intake keeps full counts, bounded preview and imports every valid identity once', t => {
  const f = fixture(t);
  const rows = Array.from({ length: 9544 }, (_, index) => record(`Pessoa sintética ${index}`, `119${String(10000000 + index)}`));
  rows.push(record('Número ambíguo', '98765-4321'));
  const p = preview(f, rows);
  assert.deepEqual(p.counts, { total: 9545, valid: 9544, review: 0, duplicate: 0, conflict: 0, invalid: 1 });
  assert.equal(p.rows.length, 100); assert.equal(p.truncated, true);
  const applied = f.service.apply(admin, f.tenantId, confirmation(p));
  assert.equal(applied.imported, 9544); assert.equal(new Set(applied.contactIds).size, 9544);
  const repeat = preview(f, rows);
  assert.equal(repeat.counts.valid, 0); assert.equal(repeat.counts.duplicate, 9544);
  assert.equal(f.service.apply(admin, f.tenantId, confirmation(repeat)).imported, 0);
  assert.equal(raw(f).contacts.length, 9544);
});

test('optional review preserves original phone in notes and never creates a phone/identity or inbox entry', t => {
  const f = fixture(t), input = record('Pessoa para revisão', '+1 212 555 1234', { sourceRef: 'synthetic-contact-1', notes: 'Nome original preservado', email: 'person@example.test', tags: ['Origem: P2Tech'] });
  const normal = preview(f, [input]); assert.equal(normal.counts.invalid, 1); assert.equal(normal.counts.review, 0);
  const before = raw(f), p = f.service.preview(admin, f.tenantId, { channelId: 'wa-a', format: 'json', content: JSON.stringify([input]), preserveInvalid: true });
  assert.equal(p.counts.review, 1); assert.equal(p.counts.invalid, 0); assert.equal(p.rows[0].phone, '');
  assert.equal(p.rows[0].originalPhone, input.phone); assert.match(p.rows[0].notes, /Nome original preservado\n\nTelefone original MEPChat: \+1 212 555 1234/);
  assert.deepEqual(p.rows[0].tags, ['Origem: P2Tech', 'Revisar telefone']); assert.deepEqual(raw(f), before);
  const result = f.service.apply(admin, f.tenantId, confirmation(p)), stored = raw(f).contacts[0];
  assert.equal(result.imported, 1); assert.equal(result.reviewImported, 1); assert.equal(stored.phone, ''); assert.deepEqual(stored.identities, []);
  assert.deepEqual(stored.importSource, { provider: 'mepchat', ref: input.sourceRef });
  assert.deepEqual(raw(f).conversations, before.conversations);
  assert.equal(f.contacts.list(admin, f.tenantId)[0].importSource, undefined);
});

test('review source references deduplicate exactly per tenant across restarts and never by name or invalid phone', t => {
  const f = fixture(t), rows = [record('Mesmo nome', '123', { sourceRef: 'source-A' }), record('Mesmo nome', '123', { sourceRef: 'source-B' }), record('Mesmo nome', '123', { sourceRef: 'source-A' })];
  const input = { channelId: 'wa-a', format: 'json', content: JSON.stringify(rows), preserveInvalid: true };
  const p = f.service.preview(admin, f.tenantId, input); assert.equal(p.counts.review, 2); assert.equal(p.counts.duplicate, 1);
  const applied = f.service.apply(admin, f.tenantId, confirmation(p)); assert.equal(applied.reviewImported, 2);
  const restarted = new ContactImportService(f.store, f.auth), repeat = restarted.preview(admin, f.tenantId, { ...input, channelId: 'wa-b' });
  assert.equal(repeat.counts.duplicate, 3); assert.equal(repeat.counts.review, 0); assert.equal(restarted.apply(admin, f.tenantId, confirmation(repeat)).imported, 0);
  const distinctCase = f.service.preview(admin, f.tenantId, { ...input, content: JSON.stringify([record('Mesmo nome', '123', { sourceRef: 'source-a' })]) });
  assert.equal(distinctCase.counts.review, 1);
  const other = f.store.createTenant(admin, { name: 'Outra empresa revisão', segment: 'Teste' }).id;
  f.store.mutate(admin, other, 'Fixture: canal revisão', state => { state.channels = [{ id: 'wa-a', kind: 'whatsapp_qr' }]; });
  assert.equal(f.service.preview(admin, other, input).counts.review, 2);
});

test('review cannot conceal other invalid fields, truncate notes, drop tags or omit stable source', () => {
  const good = record('Nome válido', '123', { sourceRef: 'source-1' });
  const cases = [record('Nome', '123'), { ...good, name: '' }, { ...good, email: 'bad' }, { ...good, notes: 'n'.repeat(1999) }, { ...good, tags: Array.from({ length: 20 }, (_, index) => `tag-${index}`) }, { ...good, sourceRef: ' source-1 ' }, { ...good, sourceRef: 1 }, { ...good, sourceRef: 'x'.repeat(121) }, { ...good, phone: '1\u00002' }, { ...good, phone: 123 }];
  const parsed = parseContactImport({ format: 'json', content: JSON.stringify(cases), preserveInvalid: true });
  assert.equal(parsed.every(row => row.status === 'invalid'), true);
  const retainedTag = parseContactImport({ format: 'json', content: JSON.stringify([{ ...good, tags: [...Array.from({ length: 19 }, (_, index) => `tag-${index}`), 'Revisar telefone'] }]), preserveInvalid: true })[0];
  assert.equal(retainedTag.status, 'review'); assert.equal(retainedTag.tags.length, 20);
  assert.throws(() => parseContactImport({ format: 'json', content: '[]', preserveInvalid: 'true' }), status(400));
});

test('source collisions, changed original phone and later valid phone require explicit review without overwrite', t => {
  const f = fixture(t), input = { channelId: 'wa-a', format: 'json', preserveInvalid: true };
  const collisions = f.service.preview(admin, f.tenantId, { ...input, content: JSON.stringify([record('Pessoa A', '123', { sourceRef: 'source-1' }), record('Pessoa B', '1234', { sourceRef: 'source-1' })]) });
  assert.equal(collisions.counts.conflict, 2); assert.equal(collisions.counts.review, 0);
  const first = f.service.preview(admin, f.tenantId, { ...input, content: JSON.stringify([record('Pessoa A', '123', { sourceRef: 'source-1' })]) }); f.service.apply(admin, f.tenantId, confirmation(first));
  const before = JSON.stringify(raw(f));
  for (const row of [record('Pessoa A', '1234', { sourceRef: 'source-1' }), record('Pessoa A', '11987654321', { sourceRef: 'source-1' })]) {
    const p = f.service.preview(admin, f.tenantId, { ...input, content: JSON.stringify([row]) }); assert.equal(p.counts.conflict, 1);
    assert.equal(f.service.apply(admin, f.tenantId, confirmation(p)).imported, 0);
  }
  assert.equal(JSON.stringify(raw(f)), before);
  f.store.mutate(admin, f.tenantId, 'Fixture: referência conflitante', state => { state.contacts.push({ ...state.contacts[0], id: 'synthetic-collision' }); });
  assert.equal(f.service.preview(admin, f.tenantId, { ...input, content: JSON.stringify([record('Pessoa A', '123', { sourceRef: 'source-1' })]) }).counts.conflict, 1);
});

test('review needs company-wide authority and rechecks it for apply and receipt replay', t => {
  const f = fixture(t), input = { channelId: 'wa-a', format: 'json', content: JSON.stringify([record('Pessoa', '123', { sourceRef: 'source-1' })]), preserveInvalid: true };
  const restricted = { ...admin, channels: ['wa-a'] };
  assert.throws(() => f.service.preview(restricted, f.tenantId, input), status(403));
  const p = f.service.preview(admin, f.tenantId, input);
  assert.throws(() => f.service.apply(restricted, f.tenantId, confirmation(p)), status(403));
  assert.equal(raw(f).contacts, undefined);
  f.service.apply(admin, f.tenantId, confirmation(p));
  assert.throws(() => f.service.apply(restricted, f.tenantId, confirmation(p)), status(403));
});

test('source reference participates in CAS and valid import carries metadata without exposing it', t => {
  const f = fixture(t), p = preview(f, [record('Pessoa', '11987654321', { sourceRef: 'valid-source-1' })]);
  const applied = f.service.apply(admin, f.tenantId, confirmation(p)); assert.equal(applied.reviewImported, 0);
  assert.deepEqual(raw(f).contacts[0].importSource, { provider: 'mepchat', ref: 'valid-source-1' });
  const later = f.service.preview(admin, f.tenantId, { channelId: 'wa-a', format: 'json', preserveInvalid: true, content: JSON.stringify([record('Revisão', '123', { sourceRef: 'review-source-1' })]) });
  f.store.mutate(admin, f.tenantId, 'Fixture: referência mudou', state => { state.contacts[0].importSource.ref = 'changed-source'; });
  assert.throws(() => f.service.apply(admin, f.tenantId, confirmation(later)), status(409));
  assert.equal(raw(f).contacts.length, 1);
});
