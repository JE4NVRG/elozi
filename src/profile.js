const fields = new Set(['name', 'phone', 'bio', 'avatar', 'locale']);
const avatarLimit = 24 * 1024;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function ensureProfileSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(auth_users)').all().map(column => column.name));
  for (const [name, definition] of [['phone', "TEXT NOT NULL DEFAULT ''"], ['bio', "TEXT NOT NULL DEFAULT ''"], ['avatar', 'TEXT'], ['locale', "TEXT NOT NULL DEFAULT 'pt-BR' CHECK(locale IN ('pt-BR','en'))"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE auth_users ADD COLUMN ${name} ${definition}`);
  }
}

export function profileOf(row) {
  return { phone: row.phone ?? '', bio: row.bio ?? '', avatar: row.avatar ?? null, locale: row.locale === 'en' ? 'en' : 'pt-BR' };
}

function optionalText(value, limit, label) {
  if (typeof value !== 'string' || value.trim().length > limit) invalid(`Informe ${label} com até ${limit} caracteres.`);
  return value.trim();
}

export function validateProfileAvatar(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > avatarLimit) invalid('Use uma foto PNG, JPEG ou WebP com até 24 KiB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) invalid('Use uma foto PNG, JPEG ou WebP válida.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) invalid('Use uma foto PNG, JPEG ou WebP válida.');
  const png = bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  const webp = bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('latin1', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16));
  if (!({ png, jpeg, webp })[match[1]]) invalid('O formato da foto não corresponde ao conteúdo enviado.');
  return value;
}

export function updateUserProfile(db, userId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('Informe os dados do perfil.');
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => !fields.has(key))) invalid('Edite somente nome, telefone, bio, foto e idioma do perfil.');
  const values = {};
  if (Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) invalid('Informe um nome entre 1 e 80 caracteres.');
    values.name = input.name.trim();
  }
  if (Object.hasOwn(input, 'phone')) {
    values.phone = optionalText(input.phone, 25, 'um telefone');
    if (values.phone && (!/^[0-9 +()-]+$/.test(values.phone) || !/[0-9]/.test(values.phone))) invalid('Use apenas números, espaços, +, parênteses e traços no telefone.');
  }
  if (Object.hasOwn(input, 'bio')) values.bio = optionalText(input.bio, 180, 'uma bio');
  if (Object.hasOwn(input, 'avatar')) values.avatar = validateProfileAvatar(input.avatar);
  if (Object.hasOwn(input, 'locale')) {
    if (!['pt-BR', 'en'].includes(input.locale)) invalid('Escolha Português (Brasil) ou English para o seu perfil.');
    values.locale = input.locale;
  }
  const row = typeof userId === 'string' ? db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId) : null;
  if (!row) throw Object.assign(new Error('Perfil não encontrado.'), { status: 404 });
  const changes = Object.keys(values);
  if (changes.length) db.prepare(`UPDATE auth_users SET ${changes.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...changes.map(key => values[key]), userId);
  return db.prepare('SELECT * FROM auth_users WHERE id=?').get(userId);
}
