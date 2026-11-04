import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureProfileSchema, profileOf, updateUserProfile } from '../src/profile.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';
const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const status = code => error => error.status === code;

function fixture(t, extraColumns = '') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE auth_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL, reseller_id TEXT NOT NULL, password_hash BLOB NOT NULL${extraColumns});`);
  db.prepare('INSERT INTO auth_users(id,name,email,role,reseller_id,password_hash) VALUES (?,?,?,?,?,?)').run('one', 'Pessoa um', 'one@example.test', 'reseller', 'reseller-one', Buffer.from([1, 2, 3]));
  db.prepare('INSERT INTO auth_users(id,name,email,role,reseller_id,password_hash) VALUES (?,?,?,?,?,?)').run('two', 'Pessoa dois', 'two@example.test', 'operator', 'reseller-two', Buffer.from([4, 5, 6]));
  return db;
}

test('migração adiciona somente campos faltantes e preserva perfil e identidade existentes', t => {
  const db = fixture(t, ", phone TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT ''");
  db.prepare('UPDATE auth_users SET phone=?,bio=? WHERE id=?').run('+55 11 99999-9999', 'Bio existente', 'one');
  const before = db.prepare('SELECT * FROM auth_users WHERE id=?').get('one');
  ensureProfileSchema(db); ensureProfileSchema(db);
  const after = db.prepare('SELECT * FROM auth_users WHERE id=?').get('one');
  assert.deepEqual({ ...after, avatar: undefined, locale: undefined }, { ...before, avatar: undefined, locale: undefined });
  assert.deepEqual(profileOf(after), { phone: '+55 11 99999-9999', bio: 'Bio existente', avatar: null, locale: 'pt-BR' });
  assert.equal(db.prepare('PRAGMA table_info(auth_users)').all().filter(column => ['phone', 'bio', 'avatar', 'locale'].includes(column.name)).length, 4);
});

test('schema antigo recebe padrões e leitura de perfil não expõe identidade nem credenciais', t => {
  const db = fixture(t);
  ensureProfileSchema(db);
  assert.deepEqual(profileOf(db.prepare('SELECT * FROM auth_users WHERE id=?').get('one')), { phone: '', bio: '', avatar: null, locale: 'pt-BR' });
  assert.deepEqual(profileOf({ name: 'Legado', password_hash: 'sigiloso' }), { phone: '', bio: '', avatar: null, locale: 'pt-BR' });
});

test('edição atualiza uma única pessoa e preserva credenciais, e-mail, papel e campos omitidos', t => {
  const db = fixture(t); ensureProfileSchema(db);
  const original = db.prepare('SELECT * FROM auth_users WHERE id=?').get('one');
  const other = db.prepare('SELECT * FROM auth_users WHERE id=?').get('two');
  const edited = updateUserProfile(db, 'one', { name: ' Jean ', phone: ' +55 (11) 99999-9999 ', bio: ' Administrador ', avatar: png });
  assert.equal(edited.name, 'Jean');
  assert.deepEqual(profileOf(edited), { phone: '+55 (11) 99999-9999', bio: 'Administrador', avatar: png, locale: 'pt-BR' });
  for (const key of ['id', 'email', 'role', 'reseller_id', 'password_hash']) assert.deepEqual(edited[key], original[key]);
  assert.deepEqual(db.prepare('SELECT * FROM auth_users WHERE id=?').get('two'), other);
  const renamed = updateUserProfile(db, 'one', { name: 'Jean Admin' });
  assert.deepEqual(profileOf(renamed), profileOf(edited));
  assert.deepEqual(updateUserProfile(db, 'one', {}), renamed);
  assert.deepEqual(profileOf(updateUserProfile(db, 'one', { phone: '', bio: '', avatar: null })), { phone: '', bio: '', avatar: null, locale: 'pt-BR' });
});

test('whitelist rejeita privilégios, identidade, e-mail, chaves desconhecidas e objetos abusivos sem edição parcial', t => {
  const db = fixture(t); ensureProfileSchema(db);
  const before = db.prepare('SELECT * FROM auth_users WHERE id=?').get('one');
  for (const key of ['role', 'email', 'userId', 'id', 'platformAdmin', 'platform_admin', 'resellerId', 'reseller_id', 'tenantIds', 'password', 'username', 'unknown', '__proto__']) {
    const input = JSON.parse(JSON.stringify({ name: 'Nome alterado', [key]: 'indevido' }));
    assert.throws(() => updateUserProfile(db, 'one', input), status(400));
  }
  for (const input of [null, [], 'perfil', new Date(), Object.assign(Object.create({ role: 'reseller' }), { name: 'Alterado' }), { [Symbol('role')]: 'reseller' }]) {
    assert.throws(() => updateUserProfile(db, 'one', input), status(400));
  }
  assert.deepEqual(db.prepare('SELECT * FROM auth_users WHERE id=?').get('one'), before);
});

test('campos respeitam limites e rejeitam tipos inválidos antes de gravar', t => {
  const db = fixture(t); ensureProfileSchema(db);
  updateUserProfile(db, 'one', { name: 'N'.repeat(80), phone: '1'.repeat(25), bio: 'B'.repeat(180) });
  const before = db.prepare('SELECT * FROM auth_users WHERE id=?').get('one');
  for (const input of [{ name: '' }, { name: '   ' }, { name: 'N'.repeat(81) }, { name: null }, { phone: '1'.repeat(26) }, { phone: '+ () -' }, { phone: '55.ext.123' }, { phone: '12\n34' }, { phone: null }, { bio: 'B'.repeat(181) }, { bio: null }, { name: 'Alterado', avatar: 'https://example.test/image.png' }]) {
    assert.throws(() => updateUserProfile(db, 'one', input), status(400));
  }
  assert.deepEqual(db.prepare('SELECT * FROM auth_users WHERE id=?').get('one'), before);
});

test('foto aceita raster declarado e rejeita SVG, scripts, base64 inválido e assinatura incompatível', t => {
  const db = fixture(t); ensureProfileSchema(db);
  for (const image of [png, jpeg, webp]) assert.equal(updateUserProfile(db, 'one', { avatar: image }).avatar, image);
  const bad = ['https://example.test/image.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', png.replace('image/png', 'image/jpeg'), png + '\n', png.replace('base64,', 'base64, '), 'data:image/png;base64,AAA', 'data:image/png;base64,AAAA===', 'data:image/png;base64,AB==', '', 1];
  for (const image of [png, webp]) {
    const bytes = Buffer.from(image.split(',')[1], 'base64');
    bytes[12] |= 128; // ASCII decoding must not hide a changed format signature.
    bad.push(image.split(',')[0] + ',' + bytes.toString('base64'));
  }
  for (const image of bad) assert.throws(() => updateUserProfile(db, 'one', { avatar: image }), status(400));
  assert.equal(db.prepare('SELECT avatar FROM auth_users WHERE id=?').get('one').avatar, webp);
});

test('foto acima de 24 KiB e perfil inexistente não alteram nenhuma linha', t => {
  const db = fixture(t); ensureProfileSchema(db);
  const before = db.prepare('SELECT * FROM auth_users ORDER BY id').all();
  const oversized = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(19000), Buffer.from([255, 217])]).toString('base64');
  assert.throws(() => updateUserProfile(db, 'one', { avatar: oversized }), status(400));
  for (const id of ['missing', "one' OR 1=1--", null]) assert.throws(() => updateUserProfile(db, id, { name: 'Alterado' }), status(404));
  assert.deepEqual(db.prepare('SELECT * FROM auth_users ORDER BY id').all(), before);
});
