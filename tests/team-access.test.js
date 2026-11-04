import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Auth } from '../src/auth.js';
import { BUSINESS_PERMISSIONS } from '../src/access.js';

const password = () => 'Synthetic-' + randomBytes(12).toString('hex');
const status = code => error => error.status === code;
const row = (db,id) => db.prepare('SELECT * FROM auth_users WHERE id=?').get(id);
const sessions = (db,id) => db.prepare('SELECT * FROM auth_sessions WHERE user_id=? ORDER BY token_hash').all(id);
const immutable = user => Object.fromEntries(Object.entries(user).filter(([key]) => !['name','role','tenant_ids','permissions','scope_rules','disabled_at','presence'].includes(key)));

function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); t.after(()=>db.close());
  db.exec('CREATE TABLE resellers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE tenants(id TEXT PRIMARY KEY,reseller_id TEXT NOT NULL REFERENCES resellers(id));');
  for (const id of ['mep-demo','foreign-reseller']) db.prepare('INSERT INTO resellers VALUES (?,?)').run(id,JSON.stringify({name:id}));
  const states = new Map([
    ['alpha',{ id:'alpha', resellerId:'mep-demo', channels:[{id:'alpha-wa'},{id:'alpha-tg'}], departments:[{id:'sales'},{id:'support'}] }],
    ['beta',{ id:'beta', resellerId:'mep-demo', channels:[{id:'beta-wa'}], departments:[{id:'beta-sales'}] }],
    ['foreign',{ id:'foreign', resellerId:'foreign-reseller', channels:[{id:'foreign-wa'}], departments:[] }]
  ]);
  for (const state of states.values()) db.prepare('INSERT INTO tenants VALUES (?,?)').run(state.id,state.resellerId);
  const validateTenant = (actor,id) => {
    const state = states.get(id);
    if (!state || state.resellerId!==actor.resellerId) throw Object.assign(new Error('Empresa fora do workspace.'),{status:404});
    if (actor.role==='operator' && !actor.tenantIds.includes(id)) throw Object.assign(new Error('Empresa não vinculada.'),{status:403});
    return state;
  };
  const auth = new Auth(db,{validateTenant});
  const provision = ({resellerId,tenantId,name}) => {
    db.prepare('INSERT INTO resellers VALUES (?,?)').run(resellerId,JSON.stringify({name}));
    db.prepare('INSERT INTO tenants VALUES (?,?)').run(tenantId,resellerId);
    states.set(tenantId,{id:tenantId,resellerId,channels:[],departments:[]});
  };
  return { db, auth, states, validateTenant, provision };
}

const owner = auth => auth.setup({name:'Owner sintético',username:'synthetic.owner',password:password()});
async function member(auth,actor,username,extra={}) {
  const secret=password();
  return { ...await auth.createUser(actor,{name:username,username,password:secret,role:'operator',tenantIds:['alpha'],...extra}), secret };
}
const login = (auth,user) => auth.login({username:user.username,password:user.secret});
async function founder(auth,provision) {
  const account=await auth.register({name:'Fundador sintético',email:'founder@example.test',company:'Empresa pública',password:password()},{provision});
  auth.promoteFirstPlatformAdmin({userId:account.actor.userId,expectedEmail:account.actor.email,expectedResellerId:account.actor.resellerId});
  return { ...account, actor:auth.workspaceActor(auth.authenticate(account.token),'mep-demo') };
}

test('migração de acesso preserva legado, credenciais e sessão e adiciona padrões nullable', t => {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(`CREATE TABLE auth_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
    role TEXT NOT NULL,reseller_id TEXT NOT NULL,tenant_ids TEXT NOT NULL,password_salt BLOB NOT NULL,password_hash BLOB NOT NULL,
    password_version TEXT NOT NULL DEFAULT 'scrypt-v1',created_at INTEGER NOT NULL,disabled_at INTEGER);
    CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
    INSERT INTO auth_users VALUES('legacy','legacy.operator','Legado','operator','mep-demo','["alpha"]',X'0001',X'0203','scrypt-v1',1,NULL);
    INSERT INTO auth_sessions VALUES('existing-session','legacy',1,9999999999999,NULL);`);
  const before=row(db,'legacy'), beforeSessions=sessions(db,'legacy');
  const auth=new Auth(db), again=new Auth(db), actor=again.actor(row(db,'legacy'));
  assert.deepEqual(immutable(row(db,'legacy')).password_hash,before.password_hash);
  assert.deepEqual(row(db,'legacy').password_salt,before.password_salt);
  assert.deepEqual(sessions(db,'legacy'),beforeSessions);
  assert.equal(actor.permissions,null); assert.equal(actor.scopeRules,null); assert.equal(actor.presence,'available');
  assert.equal(auth.me(actor).presence,'available');
  for (const permission of BUSINESS_PERMISSIONS) assert.equal(auth.can(actor,permission,{tenantId:'alpha'}),true);
  assert.equal(auth.can(actor,'inbox.read',{tenantId:'beta'}),false);
  assert.equal(auth.can(actor,'inbox.read'),false);
});

test('permissões explícitas vazias negam operador; administrador conserva acesso de negócio sem flag global', async t => {
  const {auth,db}=fixture(t), first=await owner(auth);
  const empty=await member(auth,first.actor,'empty.operator',{permissions:[]}), emptySession=await login(auth,empty);
  for (const permission of BUSINESS_PERMISSIONS) assert.equal(auth.can(emptySession.actor,permission,{tenantId:'alpha'}),false);
  assert.deepEqual(auth.me(emptySession.actor).permissions,[]);
  assert.equal(auth.can({...emptySession.actor,role:'reseller',platformAdmin:true,permissions:BUSINESS_PERMISSIONS},'inbox.reply',{tenantId:'alpha'}),false);
  const business=await member(auth,first.actor,'business.admin',{role:'reseller',tenantIds:[],permissions:[]});
  const businessSession=await login(auth,business);
  assert.equal(row(db,business.id).platform_admin,0);
  for (const permission of BUSINESS_PERMISSIONS) assert.equal(auth.can(businessSession.actor,permission,{tenantId:'alpha'}),true);
  assert.equal(auth.can(businessSession.actor,'inbox.read',{tenantId:'foreign'}),false);
  assert.equal(auth.can(businessSession.actor,'invented.permission',{tenantId:'alpha'}),false);
  assert.equal(auth.can({...businessSession.actor,resellerId:'foreign-reseller'},'inbox.read',{tenantId:'foreign'}),false);
  assert.equal(auth.can({userId:'missing',resellerId:'mep-demo'},'inbox.read',{tenantId:'alpha'}),false);
});

test('cadastro valida dependências, campos permitidos, empresas e recursos reais antes de gravar', async t => {
  const {auth,db}=fixture(t), first=await owner(auth), before=db.prepare('SELECT count(*) AS n FROM auth_users').get().n;
  for (const extra of [
    {permissions:['inbox.reply']},{permissions:['inbox.transfer']},{permissions:['contacts.write']},
    {permissions:['unknown']},{permissions:'inbox.read'},{permissions:Array(8).fill('inbox.read')},
    {role:null},{role:''},{platformAdmin:true},{platform_admin:1},{resellerId:'foreign-reseller'},
    {presence:'available'},{unknown:true},{scopeRules:[]},
    {scopeRules:{beta:{channelIds:['beta-wa']}}},{scopeRules:{alpha:{unknown:[]}}},
    {scopeRules:{alpha:{channelIds:['foreign-wa']}}},{scopeRules:{alpha:{departmentIds:['beta-sales']}}},
    {scopeRules:{alpha:{channelIds:[' alpha-wa']}}},{scopeRules:{alpha:{departmentIds:'sales'}}},
    JSON.parse('{"__proto__":{"platformAdmin":true}}')
  ]) await assert.rejects(member(auth,first.actor,'invalid.member',extra),status(400));
  await assert.rejects(member(auth,first.actor,'foreign.member',{tenantIds:['foreign']}),status(404));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,before);
  const valid=await member(auth,first.actor,'valid.member',{permissions:['inbox.read','inbox.reply','contacts.read','contacts.write'],scopeRules:{alpha:{channelIds:['alpha-wa'],departmentIds:['unassigned','sales']}}});
  assert.deepEqual(valid.scopeRules,{alpha:{channelIds:['alpha-wa'],departmentIds:['unassigned','sales']}});
});

test('edição de nome mantém sessão; mudanças de acesso revogam todas sem mudar identidade ou senha', async t => {
  const {auth,db}=fixture(t), first=await owner(auth);
  const created=await member(auth,first.actor,'edited.operator',{email:'operator@example.test',tenantIds:['alpha','beta']});
  const initial=row(db,created.id), one=await login(auth,created), two=await login(auth,created), beforeSessions=sessions(db,created.id);
  const renamed=auth.updateUser(first.actor,created.id,{name:'Nome novo'});
  assert.equal(renamed.name,'Nome novo'); assert.deepEqual(sessions(db,created.id),beforeSessions);
  assert.equal(auth.authenticate(one.token).name,'Nome novo');
  const edited=auth.updateUser(first.actor,created.id,{tenantIds:['alpha'],permissions:['inbox.read'],scopeRules:{alpha:{channelIds:['alpha-wa']}}});
  assert.deepEqual(edited.tenantIds,['alpha']); assert.deepEqual(edited.permissions,['inbox.read']);
  assert.deepEqual(immutable(row(db,created.id)),immutable(initial));
  assert.throws(()=>auth.authenticate(one.token),status(401)); assert.throws(()=>auth.authenticate(two.token),status(401));
  assert.equal(sessions(db,created.id).every(session=>session.revoked_at!==null),true);
  assert.equal(auth.can({...one.actor,role:'reseller',permissions:BUSINESS_PERMISSIONS},'inbox.reply',{tenantId:'alpha',channelId:'alpha-wa'}),false);
  const renewed=await login(auth,created);
  assert.equal(auth.can(renewed.actor,'inbox.read',{tenantId:'alpha',channelId:'alpha-wa'}),true);
  assert.equal(auth.can(renewed.actor,'inbox.read',{tenantId:'beta'}),false);
  assert.deepEqual(row(db,created.id).password_hash,initial.password_hash);
});

test('edição rejeita campos de identidade e elevação sem alteração parcial; remover empresa remove regra antiga', async t => {
  const {auth,db}=fixture(t), first=await owner(auth);
  const created=await member(auth,first.actor,'guarded.operator',{tenantIds:['alpha','beta'],scopeRules:{alpha:{channelIds:['alpha-wa']},beta:{channelIds:['beta-wa']}}});
  const session=await login(auth,created), original=row(db,created.id), beforeSessions=sessions(db,created.id);
  for (const extra of [
    {email:'changed@example.test'},{password:password()},{username:'changed.user'},{resellerId:'foreign-reseller'},
    {reseller_id:'foreign-reseller'},{platformAdmin:true},{platform_admin:1},{userId:'other'},{id:'other'},
    {presence:'offline'},{unknown:true},{permissions:['inbox.reply']},{scopeRules:{alpha:{departmentIds:['missing']}}},
    JSON.parse('{"__proto__":{"role":"reseller"}}')
  ]) assert.throws(()=>auth.updateUser(first.actor,created.id,{name:'Não salvar',...extra}),status(400));
  assert.deepEqual(row(db,created.id),original); assert.deepEqual(sessions(db,created.id),beforeSessions);
  const updated=auth.updateUser(first.actor,created.id,{tenantIds:['alpha']});
  assert.deepEqual(updated.scopeRules,{alpha:{channelIds:['alpha-wa']}});
  assert.throws(()=>auth.authenticate(session.token),status(401));
  assert.throws(()=>auth.updateUser({...session.actor,role:'reseller'},first.actor.userId,{name:'Inválido'}),status(403));
});

test('desativação e reativação preservam credenciais e nunca ressuscitam sessões antigas', async t => {
  const {auth,db}=fixture(t), first=await owner(auth), created=await member(auth,first.actor,'reactivated.operator',{permissions:['inbox.read']});
  const before=row(db,created.id), session=await login(auth,created);
  const disabled=auth.disableUser(first.actor,created.id); assert.equal(disabled.disabled,true);
  assert.equal(auth.can(session.actor,'inbox.read',{tenantId:'alpha'}),false);
  assert.throws(()=>auth.authenticate(session.token),status(401));
  await assert.rejects(login(auth,created),status(401));
  const revoked=sessions(db,created.id), active=auth.reactivateUser(first.actor,created.id);
  assert.equal(active.disabled,false); assert.deepEqual(immutable(row(db,created.id)),immutable(before));
  assert.deepEqual(sessions(db,created.id),revoked); assert.throws(()=>auth.authenticate(session.token),status(401));
  const next=await login(auth,created); assert.equal(auth.authenticate(next.token).userId,created.id);
  assert.deepEqual(auth.reactivateUser(first.actor,created.id),auth.me(next.actor));
  assert.equal(auth.can(next.actor,'inbox.reply',{tenantId:'alpha'}),false);
});

test('equipe não altera o próprio acesso nem o administrador global; último gestor ativo é preservado', async t => {
  const {auth,db,provision}=fixture(t), global=await founder(auth,provision);
  for (const action of [()=>auth.updateUser(global.actor,global.actor.userId,{name:'Próprio'}),()=>auth.disableUser(global.actor,global.actor.userId),()=>auth.reactivateUser(global.actor,global.actor.userId)]) assert.throws(action,status(409));
  const last=await member(auth,global.actor,'last.business',{role:'reseller',tenantIds:[]});
  assert.throws(()=>auth.updateUser(global.actor,last.id,{role:'operator',tenantIds:['alpha']}),status(409));
  assert.throws(()=>auth.disableUser(global.actor,last.id),status(409));
  const second=await member(auth,global.actor,'second.business',{role:'reseller',tenantIds:[]});
  const demoted=auth.updateUser(global.actor,last.id,{role:'operator',tenantIds:['alpha']});
  assert.equal(demoted.role,'operator');
  assert.equal(auth.disableUser(global.actor,last.id).disabled,true);
  const homeActor=auth.workspaceActor(global.actor,row(db,global.actor.userId).reseller_id);
  const homeAdmin=await member(auth,homeActor,'home.business',{role:'reseller',tenantIds:[]}), homeSession=await login(auth,homeAdmin);
  for (const action of [()=>auth.updateUser(homeSession.actor,global.actor.userId,{name:'Indevido'}),()=>auth.disableUser(homeSession.actor,global.actor.userId),()=>auth.reactivateUser(homeSession.actor,global.actor.userId)]) assert.throws(action,status(403));
  assert.equal(row(db,second.id).disabled_at,null);
});

test('regras de canal e departamento exigem contexto concreto; aggregate só descobre escopos não vazios', async t => {
  const {auth,db}=fixture(t), first=await owner(auth);
  const created=await member(auth,first.actor,'scoped.operator',{tenantIds:['alpha','beta'],permissions:['inbox.read','inbox.reply','inbox.transfer'],scopeRules:{alpha:{channelIds:['alpha-wa'],departmentIds:['sales','unassigned']},beta:null}});
  const session=await login(auth,created), context={tenantId:'alpha',channelId:'alpha-wa',departmentId:'sales'};
  assert.equal(auth.can(session.actor,'inbox.reply',context),true);
  assert.equal(auth.can(session.actor,'inbox.reply',{...context,departmentId:'unassigned'}),true);
  assert.equal(auth.can(session.actor,'inbox.reply',{...context,departmentId:'support'}),false);
  assert.equal(auth.can(session.actor,'inbox.reply',{...context,channelId:'alpha-tg'}),false);
  assert.equal(auth.can(session.actor,'inbox.reply',{tenantId:'alpha'}),false);
  assert.equal(auth.can(session.actor,'inbox.reply',{tenantId:'alpha',channelId:'alpha-wa'}),false);
  assert.equal(auth.can(session.actor,'inbox.reply',{tenantId:'alpha',aggregate:true}),true);
  assert.equal(auth.can(session.actor,'inbox.reply',{...context,channelId:'alpha-tg',aggregate:true}),false);
  assert.equal(auth.can(session.actor,'inbox.reply',{tenantId:'beta'}),true);
  assert.equal(auth.can(first.actor,'inbox.reply',{...context,channelId:'foreign-wa'}),false);
  auth.updateUser(first.actor,created.id,{scopeRules:{alpha:{channelIds:[],departmentIds:null},beta:{departmentIds:[]}}});
  for (const tenantId of ['alpha','beta']) assert.equal(auth.can(session.actor,'inbox.reply',{tenantId,aggregate:true}),false);
  db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run('["invented"]',created.id);
  assert.equal(auth.can(session.actor,'inbox.reply',context),false);
});

test('roster mínimo filtra empresa, grants, inativos e permissões; operador com leitura pode consultar', async t => {
  const {auth,db,provision}=fixture(t), global=await founder(auth,provision);
  const reader=await member(auth,global.actor,'read.only',{permissions:['inbox.read']});
  const allowed=await member(auth,global.actor,'allowed.operator',{permissions:['inbox.read','inbox.reply'],scopeRules:{alpha:{channelIds:['alpha-wa'],departmentIds:['sales']}}});
  const otherChannel=await member(auth,global.actor,'other.channel',{scopeRules:{alpha:{channelIds:['alpha-tg']}}});
  const inactive=await member(auth,global.actor,'inactive.operator'); auth.disableUser(global.actor,inactive.id);
  const foreign=await auth.register({name:'Outro workspace',email:'other@example.test',company:'Outra',password:password()},{provision});
  for (const action of [()=>auth.updateUser(global.actor,foreign.actor.userId,{name:'Inválido'}),()=>auth.disableUser(global.actor,foreign.actor.userId),()=>auth.reactivateUser(global.actor,foreign.actor.userId)]) assert.throws(action,status(404));
  auth.updatePresence((await login(auth,allowed)).actor,'busy');
  const readerSession=await login(auth,reader), context={channelId:'alpha-wa',departmentId:'sales'};
  const roster=auth.assignees(readerSession.actor,'alpha',context);
  assert.deepEqual(roster.map(person=>person.id).sort(),[global.actor.userId,allowed.id].sort());
  assert.equal(roster.find(person=>person.id===allowed.id).presence,'busy');
  for (const person of roster) assert.deepEqual(Object.keys(person).sort(),['id','name','role','avatar','presence'].sort());
  assert.equal(roster.some(person=>person.id===foreign.actor.userId || person.id===inactive.id || person.id===reader.id || person.id===otherChannel.id),false);
  assert.deepEqual(auth.assignees(global.actor,'alpha',{aggregate:true}).map(person=>person.id).sort(),[global.actor.userId,allowed.id,otherChannel.id].sort());
  assert.throws(()=>auth.assignees(readerSession.actor,'beta',context),status(403));
  db.prepare('DELETE FROM auth_workspace_access WHERE user_id=?').run(global.actor.userId);
  assert.equal(auth.assignees(readerSession.actor,'alpha',context).some(person=>person.id===global.actor.userId),false);
  assert.equal(auth.can(global.actor,'inbox.reply',{tenantId:'alpha',...context}),false);
});

test('presença é editada somente na própria conta e não revoga sessão ou altera acesso', async t => {
  const {auth,db}=fixture(t), first=await owner(auth), created=await member(auth,first.actor,'present.operator');
  const session=await login(auth,created), original=row(db,created.id), beforeSessions=sessions(db,created.id);
  for (const presence of ['busy','away','offline','available']) assert.equal(auth.updatePresence(session.actor,presence).presence,presence);
  assert.deepEqual(sessions(db,created.id),beforeSessions);
  assert.deepEqual(immutable(row(db,created.id)),immutable(original));
  assert.equal(auth.authenticate(session.token).presence,'available');
  for (const presence of ['online','AVAILABLE',null,{presence:'busy',userId:first.actor.userId}]) assert.throws(()=>auth.updatePresence(session.actor,presence),status(400));
  assert.throws(()=>auth.updatePresence({...session.actor,resellerId:'foreign-reseller'},'busy'),status(403));
  assert.equal(row(db,first.actor.userId).presence,'available');
  assert.equal(auth.can(session.actor,'inbox.reply',{tenantId:'alpha',channelId:'alpha-wa',departmentId:'unassigned'}),true);
});

test('criação revalida o administrador e os recursos após hash assíncrono; callback assíncrono é recusado', async t => {
  const {auth,db,states}=fixture(t), first=await owner(auth);
  const pending=member(auth,first.actor,'stale.scope',{scopeRules:{alpha:{channelIds:['alpha-wa']}}});
  states.get('alpha').channels=states.get('alpha').channels.filter(channel=>channel.id!=='alpha-wa');
  await assert.rejects(pending,status(400));
  const revoked=member(auth,first.actor,'revoked.admin');
  db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(),first.actor.userId);
  await assert.rejects(revoked,status(403));
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_users').get().n,1);
  assert.throws(()=>new Auth(db,{validateTenant:async()=>({})}),/síncrona/);
  const withoutState=new Auth(db,{validateTenant:()=>undefined});
  db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(first.actor.userId);
  assert.equal(withoutState.can(first.actor,'inbox.read',{tenantId:'alpha'}),false);
  await assert.rejects(member(withoutState,first.actor,'missing.state'),status(500));
});
