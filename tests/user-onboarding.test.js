import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Auth } from '../src/auth.js';

const secret = () => 'Local-QA-' + randomBytes(12).toString('hex');
const status = code => error => error.status===code;
async function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id),data TEXT NOT NULL);`);
  for (const workspace of ['workspace-a','workspace-b']) {
    db.prepare('INSERT INTO resellers VALUES (?,?)').run(workspace,JSON.stringify({name:workspace}));
    db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('company-'+workspace.slice(-1),workspace,JSON.stringify({name:'Empresa '+workspace,channels:[{id:'shared-channel'}],departments:[{id:'support'}]}));
  }
  const key = randomBytes(32); let clock = Date.now();
  const options = {resellerId:'workspace-a',invitationKey:()=>Promise.resolve(key),now:()=>clock,
    validateTenant(actor,id) {
      const row = db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
      if (!row || row.reseller_id!==actor.resellerId) throw Object.assign(new Error('Empresa indisponível'),{status:403});
      return JSON.parse(row.data);
    }};
  const auth = new Auth(db,options), password = secret(), owner = await auth.setup({name:'Admin QA',username:'admin.qa',password,email:'admin@example.test'});
  t.after(()=>db.close());
  return {db,auth,owner,password,key,options,advance(ms){clock+=ms;}};
}
const invite = (extra={}) => ({requestId:randomBytes(12).toString('hex'),name:'Pessoa QA',email:'person@example.test',role:'operator',tenantIds:['company-a'],permissions:['inbox.read','inbox.reply'],scopeRules:{'company-a':{channelIds:['shared-channel'],departmentIds:['support']}},...extra});
const person = (extra={}) => ({name:'Pessoa QA',username:'person.qa',password:secret(),...extra});

test('convite cria conta somente no workspace, empresa e escopos explicitamente autorizados', async t => {
  const {auth,db,owner} = await fixture(t), input = invite(), created = await auth.createInvitation(owner.actor,input);
  assert.equal(created.invitation.state,'pending'); assert.equal(created.invitation.canRevoke,true);
  assert.deepEqual(auth.previewInvitation(created.token).tenants,[{id:'company-a',name:'Empresa workspace-a'}]);
  const account = person(), session = await auth.acceptInvitation(created.token,account);
  assert.equal(session.actor.resellerId,'workspace-a'); assert.deepEqual(session.actor.tenantIds,['company-a']);
  assert.deepEqual(session.actor.permissions,input.permissions); assert.deepEqual(session.actor.scopeRules,input.scopeRules);
  assert.equal(session.actor.email,'person@example.test'); assert.equal(session.actor.emailVerified,false); assert.equal(session.actor.platformAdmin,false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM resellers').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tenants').get().n,2);
  assert.equal(auth.listInvitations(owner.actor)[0].state,'accepted');
  assert.equal((await auth.login({email:'person@example.test',password:account.password})).actor.userId,session.actor.userId);
  await assert.rejects(auth.acceptInvitation(created.token,person({username:'replay.qa'})),status(400));
  assert.throws(()=>auth.previewInvitation(created.token),status(400));
  assert.throws(()=>auth.revokeInvitation(owner.actor,created.invitation.id),status(409));
});

test('token fica cifrado e hash no banco, retry recupera somente mesmo payload e autoridade', async t => {
  const {auth,db,owner} = await fixture(t), input = invite(), first = await auth.createInvitation(owner.actor,input);
  const retry = await auth.createInvitation(owner.actor,{...input,tenantIds:[...input.tenantIds]});
  assert.deepEqual(retry,first); assert.equal(db.prepare('SELECT count(*) AS n FROM auth_invitations').get().n,1);
  const row = db.prepare('SELECT * FROM auth_invitations').get();
  assert.equal(row.token_hash,createHash('sha256').update(first.token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(first.token),false); assert.equal(JSON.stringify(auth.listInvitations(owner.actor)).includes(row.token_hash),false);
  await assert.rejects(auth.createInvitation(owner.actor,{...input,name:'Outro nome'}),status(409));
  const swapped = new Auth(db,{invitationKey:randomBytes(32)});
  await assert.rejects(swapped.createInvitation(owner.actor,input),status(503));
  await auth.acceptInvitation(first.token,person());
  await assert.rejects(auth.createInvitation(owner.actor,input),status(409));
});

test('criações concorrentes idempotentes devolvem mesmo link e AAD impede transplantar cifra', async t => {
  const {auth,db,owner} = await fixture(t), input = invite();
  const [first,second] = await Promise.all([auth.createInvitation(owner.actor,input),auth.createInvitation(owner.actor,input)]);
  assert.deepEqual(first,second); assert.equal(db.prepare('SELECT count(*) AS n FROM auth_invitations').get().n,1);
  const anotherInput = invite({email:'another@example.test'}), another = await auth.createInvitation(owner.actor,anotherInput);
  const ciphertext = db.prepare('SELECT token_secret FROM auth_invitations WHERE id=?').get(first.invitation.id).token_secret;
  db.prepare('UPDATE auth_invitations SET token_secret=? WHERE id=?').run(ciphertext,another.invitation.id);
  await assert.rejects(auth.createInvitation(owner.actor,anotherInput),status(503));
  assert.equal(auth.previewInvitation(another.token).id,another.invitation.id);
});

test('chave indisponível e validade inválida falham sem convite parcial', async t => {
  const {auth,db,owner} = await fixture(t);
  await assert.rejects(auth.createInvitation(owner.actor,invite({expiresInHours:0})),status(400));
  await assert.rejects(auth.createInvitation(owner.actor,invite({expiresInHours:169})),status(400));
  await assert.rejects(new Auth(db,{invitationKey:Buffer.alloc(12)}).createInvitation(owner.actor,invite()),status(503));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_invitations').get().n,0);
});

test('convite por link sem e-mail permite cadastro com e-mail próprio sem inferir verificação', async t => {
  const {auth,owner} = await fixture(t), created = await auth.createInvitation(owner.actor,invite({email:null,name:null}));
  assert.equal(auth.previewInvitation(created.token).email,null);
  const session = await auth.acceptInvitation(created.token,person({email:'own@example.test'}));
  assert.equal(session.actor.email,'own@example.test'); assert.equal(session.actor.emailVerified,false);
});

test('e-mail próprio do convite permite recuperar senha da mesma identidade sem ampliar acesso ou vincular Google', async t => {
  const {auth,owner,db} = await fixture(t), input = invite({email:null}), created = await auth.createInvitation(owner.actor,input), identity = person({email:' Own@EXAMPLE.test '});
  const accepted = await auth.acceptInvitation(created.token,identity), second = await auth.login({username:identity.username,password:identity.password});
  const users = db.prepare('SELECT count(*) AS n FROM auth_users').get().n, workspaces = db.prepare('SELECT count(*) AS n FROM resellers').get().n;
  const challenge = auth.passwordResetChallenge('OWN@example.test'), next = secret();
  assert.equal(challenge.userId,accepted.actor.userId); assert.equal(challenge.email,'own@example.test');
  assert.equal(accepted.actor.emailVerified,false); assert.equal(auth.me(accepted.actor).googleLinked,false);
  await auth.consumePasswordReset(challenge.token,{password:next});
  assert.throws(()=>auth.authenticate(accepted.token),status(401)); assert.throws(()=>auth.authenticate(second.token),status(401));
  const recovered = await auth.login({email:'own@example.test',password:next});
  assert.equal(recovered.actor.userId,accepted.actor.userId); assert.equal(recovered.actor.role,'operator'); assert.equal(recovered.actor.resellerId,'workspace-a');
  assert.deepEqual(recovered.actor.tenantIds,input.tenantIds); assert.deepEqual(recovered.actor.permissions,input.permissions); assert.deepEqual(recovered.actor.scopeRules,input.scopeRules);
  assert.equal(recovered.actor.emailVerified,false); assert.equal(auth.me(recovered.actor).googleLinked,false); assert.equal(recovered.actor.platformAdmin,false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,users); assert.equal(db.prepare('SELECT count(*) AS n FROM resellers').get().n,workspaces);
  assert.equal(auth.listInvitations(owner.actor)[0].state,'accepted'); await assert.rejects(auth.acceptInvitation(created.token,person({username:'retry.qa'})),status(400));
});

test('e-mail digitado no convite não toma conta existente nem endereço de identidade Google vinculada', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite({email:null}));
  auth.linkGoogle(owner.actor,{sub:'synthetic-owner-subject',name:'Google sintético',email:'google-alias@example.test',email_verified:true});
  const before = db.prepare('SELECT * FROM auth_users WHERE id=?').get(owner.actor.userId), google = db.prepare('SELECT * FROM auth_google_identities').all();
  for (const address of ['ADMIN@example.test','GOOGLE-ALIAS@example.test']) {
    await assert.rejects(auth.acceptInvitation(created.token,person({email:address})),status(409));
    assert.equal(auth.previewInvitation(created.token).email,null); assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
    assert.deepEqual(db.prepare('SELECT * FROM auth_users WHERE id=?').get(owner.actor.userId),before); assert.deepEqual(db.prepare('SELECT * FROM auth_google_identities').all(),google);
  }
  const accepted = await auth.acceptInvitation(created.token,person({email:'own@example.test'}));
  assert.notEqual(accepted.actor.userId,owner.actor.userId); assert.equal(accepted.actor.emailVerified,false); assert.equal(auth.me(accepted.actor).googleLinked,false);
  assert.deepEqual(db.prepare('SELECT * FROM auth_google_identities').all(),google);
});

test('aceite com e-mail opcional preserva reserva de outro convite pendente sem consumir token', async t => {
  const {auth,owner,db} = await fixture(t), fixed = await auth.createInvitation(owner.actor,invite({email:'reserved@example.test'}));
  const link = await auth.createInvitation(owner.actor,invite({email:null})), identity = person({email:'RESERVED@example.test'});
  const pending = db.prepare('SELECT * FROM auth_invitations WHERE id=?').get(fixed.invitation.id);
  await assert.rejects(auth.acceptInvitation(link.token,identity),error=>{
    assert.equal(error.status,409);assert.equal(error.message.includes(fixed.invitation.id),false);assert.equal(error.message.includes('workspace-a'),false);
    return true;
  });
  assert.equal(auth.previewInvitation(link.token).email,null);assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
  assert.deepEqual(db.prepare('SELECT * FROM auth_invitations WHERE id=?').get(fixed.invitation.id),pending);
  auth.revokeInvitation(owner.actor,fixed.invitation.id);
  const accepted = await auth.acceptInvitation(link.token,identity);assert.equal(accepted.actor.email,'reserved@example.test');assert.equal(accepted.actor.emailVerified,false);
});

test('reserva opcional ignora convite expirado e mantém contrato de convite fixo e conta já existente', async t => {
  const {auth,owner,advance} = await fixture(t), expired = await auth.createInvitation(owner.actor,invite({email:'expired-reservation@example.test',expiresInHours:1}));
  advance(3600000);assert.throws(()=>auth.previewInvitation(expired.token),status(400));
  const link = await auth.createInvitation(owner.actor,invite({email:null}));
  const accepted = await auth.acceptInvitation(link.token,person({email:'expired-reservation@example.test'}));assert.equal(accepted.actor.emailVerified,false);
  const first = await auth.createInvitation(owner.actor,invite({email:'fixed-reservation@example.test'}));
  const second = await auth.createInvitation(owner.actor,invite({email:'fixed-reservation@example.test'}));
  const optional = await auth.createInvitation(owner.actor,invite({email:null}));
  const fixedAccount = await auth.acceptInvitation(first.token,person({username:'fixed.qa'}));assert.equal(fixedAccount.actor.email,'fixed-reservation@example.test');
  await assert.rejects(auth.acceptInvitation(second.token,person({username:'other-fixed.qa'})),status(409));
  await assert.rejects(auth.acceptInvitation(optional.token,person({username:'other-link.qa',email:'fixed-reservation@example.test'})),status(409));
  assert.equal(auth.previewInvitation(optional.token).email,null);assert.equal(auth.previewInvitation(second.token).email,'fixed-reservation@example.test');
});

test('reserva criada durante hash do aceite opcional é revalidada antes de criar usuário ou consumir convite', async t => {
  const {auth,owner,db} = await fixture(t), link = await auth.createInvitation(owner.actor,invite({email:null}));
  const accepting = auth.acceptInvitation(link.token,person({email:'race-reservation@example.test'}));
  const rejected = assert.rejects(accepting,status(409));
  const fixed = await auth.createInvitation(owner.actor,invite({email:'race-reservation@example.test'}));
  await rejected;assert.equal(auth.previewInvitation(link.token).email,null);assert.equal(auth.previewInvitation(fixed.token).email,'race-reservation@example.test');
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,1);
});

test('campos de elevação de privilégio e e-mail divergente não consomem convite', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite());
  for (const extra of [{role:'reseller'},{resellerId:'workspace-b'},{tenantIds:['company-b']},{platformAdmin:true},{permissions:[]},{email:'different@example.test'}]) {
    await assert.rejects(auth.acceptInvitation(created.token,person(extra)),status(400));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
  assert.equal(auth.previewInvitation(created.token).email,'person@example.test');
});

test('duplicata de username é revertida sem conta parcial ou consumo do convite', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite());
  await assert.rejects(auth.acceptInvitation(created.token,person({username:'admin.qa'})),status(409));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
  assert.equal(auth.previewInvitation(created.token).id,created.invitation.id);
  await auth.acceptInvitation(created.token,person());
});

test('duas aceitações concorrentes criam exatamente uma conta e sessão', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite()), input = person();
  const results = await Promise.allSettled([auth.acceptInvitation(created.token,input),auth.acceptInvitation(created.token,input)]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(results.find(item=>item.status==='rejected').reason.status,400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,2);
});

test('convite expirado e revogado não permite preview, aceite ou retry', async t => {
  const {auth,owner,advance} = await fixture(t), revokedInput = invite(), revoked = await auth.createInvitation(owner.actor,revokedInput);
  assert.equal(auth.revokeInvitation(owner.actor,revoked.invitation.id).state,'revoked');
  assert.equal(auth.revokeInvitation(owner.actor,revoked.invitation.id).state,'revoked');
  assert.throws(()=>auth.previewInvitation(revoked.token),status(400));
  await assert.rejects(auth.acceptInvitation(revoked.token,person()),status(400));
  await assert.rejects(auth.createInvitation(owner.actor,revokedInput),status(409));
  const expired = await auth.createInvitation(owner.actor,invite({expiresInHours:1}));
  advance(3600000); assert.throws(()=>auth.previewInvitation(expired.token),status(400));
  await assert.rejects(auth.acceptInvitation(expired.token,person()),status(400));
  assert.equal(auth.listInvitations(owner.actor).find(item=>item.id===expired.invitation.id).state,'expired');
});

test('empresa de outra revenda, IDs de canal e departamento inválidos são rejeitados', async t => {
  const {auth,owner} = await fixture(t);
  for (const input of [invite({tenantIds:['company-b'],scopeRules:null}),invite({scopeRules:{'company-a':{channelIds:['missing']}}}),invite({scopeRules:{'company-a':{departmentIds:['missing']}}})]) await assert.rejects(auth.createInvitation(owner.actor,input),status(400));
  const user = await auth.createUser(owner.actor,{...person({username:'operator.qa',email:null}),role:'operator',tenantIds:['company-a']});
  await assert.rejects(auth.createInvitation({...auth.actor(auth.db.prepare('SELECT * FROM auth_users WHERE id=?').get(user.id)),role:'reseller'},invite()),status(403));
});

test('workspace não autorizado não lista, revoga ou recupera convite de outro workspace', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite());
  const other = await auth.createUser(owner.actor,{...person({username:'other.admin',email:null}),role:'reseller',tenantIds:[]});
  db.prepare('UPDATE auth_users SET reseller_id=? WHERE id=?').run('workspace-b',other.id);
  const actor = auth.actor(db.prepare('SELECT * FROM auth_users WHERE id=?').get(other.id));
  assert.deepEqual(auth.listInvitations(actor),[]); assert.throws(()=>auth.revokeInvitation(actor,created.invitation.id),status(404));
  assert.throws(()=>auth.listInvitations({...owner.actor,resellerId:'workspace-b'}),status(403));
});

test('nome do criador preserva convite, mudança de acesso revoga e reativação não restaura', async t => {
  const {auth,owner} = await fixture(t);
  const admin = await auth.createUser(owner.actor,{...person({username:'other.admin',email:null}),role:'reseller',tenantIds:[]}), adminActor = auth.actor(auth.db.prepare('SELECT * FROM auth_users WHERE id=?').get(admin.id));
  const first = await auth.createInvitation(adminActor,invite());
  auth.updateUser(owner.actor,admin.id,{name:'Nome novo'}); assert.equal(auth.previewInvitation(first.token).id,first.invitation.id);
  auth.updateUser(owner.actor,admin.id,{role:'operator',tenantIds:['company-a']});
  assert.throws(()=>auth.previewInvitation(first.token),status(400));
  auth.updateUser(owner.actor,admin.id,{role:'reseller',tenantIds:[]});
  assert.throws(()=>auth.previewInvitation(first.token),status(400));
  const second = await auth.createInvitation(adminActor,invite());
  auth.disableUser(owner.actor,admin.id); auth.reactivateUser(owner.actor,admin.id);
  assert.throws(()=>auth.previewInvitation(second.token),status(400));
});

test('consumo revalida empresa, canais, permissões e concessão do administrador plataforma', async t => {
  const {auth,owner,db} = await fixture(t), input = invite(), created = await auth.createInvitation(owner.actor,input);
  db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify({name:'Empresa',channels:[],departments:[{id:'support'}]}),'company-a');
  assert.throws(()=>auth.previewInvitation(created.token),status(400));
  await assert.rejects(auth.acceptInvitation(created.token,person()),status(400));
  db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify({name:'Empresa',channels:[{id:'shared-channel'}],departments:[{id:'support'}]}),'company-a');
  db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run('[]',owner.actor.userId);
  assert.throws(()=>auth.previewInvitation(created.token),status(400));
  db.prepare('UPDATE auth_users SET permissions=NULL WHERE id=?').run(owner.actor.userId);
  db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(owner.actor.userId,'workspace-b',42);
  const scoped = {...owner.actor,resellerId:'workspace-b'}, extra = await auth.createInvitation(scoped,invite({tenantIds:['company-b'],scopeRules:null}));
  db.prepare('DELETE FROM auth_workspace_access WHERE user_id=? AND reseller_id=?').run(owner.actor.userId,'workspace-b');
  assert.throws(()=>auth.previewInvitation(extra.token),status(400));
  db.prepare('INSERT INTO auth_workspace_access VALUES (?,?,?)').run(owner.actor.userId,'workspace-b',43);
  assert.throws(()=>auth.previewInvitation(extra.token),status(400));
});

test('revogação de criador durante hash assíncrono impede conta nova', async t => {
  const {auth,owner,db} = await fixture(t), created = await auth.createInvitation(owner.actor,invite());
  const pending = auth.acceptInvitation(created.token,person());
  db.prepare('UPDATE auth_users SET disabled_at=1 WHERE id=?').run(owner.actor.userId);
  await assert.rejects(pending,status(400)); assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
});

test('convite cifrado e id de sessão sobrevivem a backup SQLite sem materializar credenciais', async t => {
  const {auth,owner,db,key,options} = await fixture(t), input = invite(), created = await auth.createInvitation(owner.actor,input);
  const before = auth.sessions(owner.actor,owner.token), directory = await mkdtemp(join(tmpdir(),'elozi-auth-'));
  let restored; t.after(async()=>{restored?.close();await rm(directory,{recursive:true,force:true});}); const path = join(directory,'backup.sqlite'); await backup(db,path);
  restored = new DatabaseSync(path); restored.exec('PRAGMA foreign_keys=ON');
  const again = new Auth(restored,{...options,invitationKey:key});
  assert.equal((await again.createInvitation(owner.actor,input)).token,created.token);
  assert.deepEqual(again.sessions(owner.actor,owner.token),before); assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('reset desconhecido/desativado/supressão repetida retornam null internamente sem criar desafio', async t => {
  const {auth,owner,db,advance} = await fixture(t);
  assert.equal(auth.passwordResetChallenge('missing@example.test'),null);
  const user = await auth.createUser(owner.actor,{...person({email:'disabled@example.test'}),role:'operator',tenantIds:['company-a']});
  auth.disableUser(owner.actor,user.id); assert.equal(auth.passwordResetChallenge(user.email),null);
  const first = auth.passwordResetChallenge('ADMIN@example.test');
  assert.equal(first.email,'admin@example.test'); assert.equal(first.userId,owner.actor.userId); assert.equal(first.name,'Admin QA');
  assert.equal(auth.passwordResetChallenge('admin@example.test'),null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_password_resets').get().n,1);
  const row = db.prepare('SELECT * FROM auth_password_resets').get(); assert.equal(JSON.stringify(row).includes(first.token),false);
  advance(60000); const second = auth.passwordResetChallenge('admin@example.test'); assert.notEqual(second.token,first.token);
  await assert.rejects(auth.consumePasswordReset(first.token,{password:secret()}),status(400));
});

test('reset de senha consome uma vez, mantém acesso e revoga todas as sessões', async t => {
  const {auth,owner,password} = await fixture(t), second = await auth.login({username:'admin.qa',password});
  const challenge = auth.passwordResetChallenge('admin@example.test'), next = secret();
  assert.deepEqual(await auth.consumePasswordReset(challenge.token,{password:next}),{changed:true});
  assert.throws(()=>auth.authenticate(owner.token),status(401)); assert.throws(()=>auth.authenticate(second.token),status(401));
  await assert.rejects(auth.login({username:'admin.qa',password}),status(401));
  const session = await auth.login({username:'admin.qa',password:next}); assert.equal(session.actor.platformAdmin,true); assert.equal(session.actor.resellerId,'workspace-a');
  await assert.rejects(auth.consumePasswordReset(challenge.token,{password:secret()}),status(400));
});

test('reset expirado, email trocado e conta desativada durante hash são recusados', async t => {
  const {auth,owner,db,advance} = await fixture(t);
  const expired = auth.passwordResetChallenge('admin@example.test'); advance(1800000);
  await assert.rejects(auth.consumePasswordReset(expired.token,{password:secret()}),status(400));
  const changed = auth.passwordResetChallenge('admin@example.test'); db.prepare('UPDATE auth_users SET email=? WHERE id=?').run('new@example.test',owner.actor.userId);
  await assert.rejects(auth.consumePasswordReset(changed.token,{password:secret()}),status(400));
  advance(60000); const disabled = auth.passwordResetChallenge('new@example.test'), pending = auth.consumePasswordReset(disabled.token,{password:secret()});
  db.prepare('UPDATE auth_users SET disabled_at=1 WHERE id=?').run(owner.actor.userId);
  await assert.rejects(pending,status(400));
});

test('reset concorrente admite somente uma senha nova e login antigo em corrida não retorna sessão', async t => {
  const {auth,password,owner,db} = await fixture(t), challenge = auth.passwordResetChallenge('admin@example.test');
  const results = await Promise.allSettled([auth.consumePasswordReset(challenge.token,{password:secret()}),auth.consumePasswordReset(challenge.token,{password:secret()})]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1); assert.equal(results.find(item=>item.status==='rejected').reason.status,400);
  const pending = auth.login({username:'admin.qa',password});
  db.prepare("UPDATE auth_users SET password_version='google-only' WHERE id=?").run(owner.actor.userId);
  await assert.rejects(pending,status(401));
});

test('troca autenticada exige senha atual, mantém sessão corrente e invalida outras e reset pendente', async t => {
  const {auth,owner,password} = await fixture(t), other = await auth.login({username:'admin.qa',password}), challenge = auth.passwordResetChallenge('admin@example.test'), next = secret();
  await assert.rejects(auth.changePassword(owner.actor,{currentPassword:secret(),password:next},{sessionToken:owner.token}),status(401));
  assert.equal(auth.authenticate(other.token).userId,owner.actor.userId);
  assert.deepEqual(await auth.changePassword(owner.actor,{currentPassword:password,password:next},{sessionToken:owner.token}),{changed:true,revokedSessions:1});
  assert.equal(auth.authenticate(owner.token).userId,owner.actor.userId); assert.throws(()=>auth.authenticate(other.token),status(401));
  await assert.rejects(auth.login({username:'admin.qa',password}),status(401));
  assert.equal((await auth.login({username:'admin.qa',password:next})).actor.userId,owner.actor.userId);
  await assert.rejects(auth.consumePasswordReset(challenge.token,{password:secret()}),status(400));
});

test('sessões listam identificador opaco e só o titular pode revogar; corrente exige novo login', async t => {
  const {auth,owner,password,db} = await fixture(t), other = await auth.login({username:'admin.qa',password});
  const user = await auth.createUser(owner.actor,{...person(),role:'operator',tenantIds:['company-a']}), foreign = auth.session(db.prepare('SELECT * FROM auth_users WHERE id=?').get(user.id));
  const rows = auth.sessions(owner.actor,owner.token).sessions; assert.equal(rows.length,2); assert.equal(rows.filter(item=>item.current).length,1);
  assert.equal(JSON.stringify(rows).includes(owner.token),false); assert.equal(JSON.stringify(rows).includes(createHash('sha256').update(owner.token).digest('hex')),false);
  const foreignId = auth.sessions(foreign.actor,foreign.token).sessions[0].id;
  assert.throws(()=>auth.revokeSession(owner.actor,foreignId,owner.token),status(404));
  const otherId = rows.find(item=>!item.current).id;
  assert.deepEqual(auth.revokeSession(owner.actor,otherId,owner.token),{revoked:true,current:false}); assert.throws(()=>auth.authenticate(other.token),status(401));
  assert.equal(auth.authenticate(foreign.token).userId,user.id);
  const currentId = rows.find(item=>item.current).id;
  assert.deepEqual(auth.revokeSession(owner.actor,currentId,owner.token),{revoked:true,current:true}); assert.throws(()=>auth.authenticate(owner.token),status(401));
});

test('revogação de sessão durante hash bloqueia troca de senha e mantém senha original', async t => {
  const {auth,owner,password} = await fixture(t), pending = auth.changePassword(owner.actor,{currentPassword:password,password:secret()},{sessionToken:owner.token});
  auth.logout(owner.token); await assert.rejects(pending,status(401));
  assert.equal((await auth.login({username:'admin.qa',password})).actor.userId,owner.actor.userId);
});

test('schema de sessão legado ganha id sem modificar token, datas ou autorização', async t => {
  const {auth,owner,db,password} = await fixture(t), original = db.prepare('SELECT * FROM auth_sessions').get();
  db.exec('DROP TABLE auth_session_ids;');
  const again = new Auth(db), migrated = db.prepare('SELECT * FROM auth_sessions').get();
  assert.deepEqual(migrated,original);
  assert.equal(migrated.token_hash,original.token_hash); assert.equal(migrated.created_at,original.created_at); assert.equal(migrated.expires_at,original.expires_at);
  assert.equal(again.authenticate(owner.token).userId,owner.actor.userId); assert.match(again.sessions(owner.actor,owner.token).sessions[0].id,/^[a-f0-9-]{36}$/);
  assert.equal((await auth.login({username:'admin.qa',password})).actor.userId,owner.actor.userId);
});
