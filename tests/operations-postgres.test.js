import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// The existing CI PostgreSQL service owns this synthetic fixture. Run only
// after 003's opt-in suite; never seed/apply schema on a VPS or arbitrary DB.
const enabled=process.env.MEPCHAT_TEST_PG_OPERATIONS==='1';
function localUrl(value) {
  if (!value) throw new Error('Operations tests require the explicit local PostgreSQL fixture URLs.');
  const url=new URL(value);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname)
      || url.pathname!=='/mepchat' || !['15438','5432'].includes(url.port||'5432')) throw new Error('Operations tests require the explicit local mepchat fixture.');
  return value;
}
function snapshot() {
  const id=`tenant_${randomUUID()}`, resellerId=`reseller_${randomUUID()}`, channelId=randomUUID(), conversationId=randomUUID();
  const contactId=randomUUID(), departmentId=randomUUID(), userId=randomUUID(), date=new Date().toISOString();
  const contact={id:contactId,name:'Contato CRM sintético',type:'person',phone:'5511999990001',email:'fixture@example.test',notes:'Nota sintética',tags:['Fixture'],identities:[],version:1,createdAt:date,updatedAt:date};
  const department={id:departmentId,name:'Suporte sintético',color:'#3157d5',description:'Fixture',memberIds:[userId],distribution:'round_robin',cursor:1,version:2,active:true};
  const event={id:randomUUID(),type:'assignment',actorId:userId,actorName:'Pessoa sintética',from:{owner:'queue',assignedUserId:null,departmentId},to:{owner:'human',assignedUserId:userId,assignedUserName:'Pessoa sintética',departmentId},createdAt:date,origin:'inbox'};
  return {id,resellerId,name:'Empresa operacional sintética',brand:{},segment:'QA',plan:'Local',reseller:{name:'Revenda sintética',brand:{}},
    channels:[{id:channelId,kind:'telegram',name:'Canal sintético',state:'planned'}],agents:[],flows:[],runs:[],audit:[],outbox:[],
    contacts:[contact],departments:[department],defaultDepartmentId:departmentId,
    authUsers:[{id:userId,password_hash:'DO_NOT_PROJECT_AUTH_FIXTURE'}],
    conversations:[{id:conversationId,channelId,contact:'Contato CRM sintético',contactId,departmentId,department:department.name,assignedUserId:userId,assignedUserName:'Pessoa sintética',attendantEvents:[event],owner:'human',status:'open',version:2,unread:0,updatedAt:date,
      messages:[{id:randomUUID(),kind:'human',text:'Resposta sintética',authorUserId:userId,authorName:'Pessoa sintética',delivery:'sent',createdAt:date}]}]};
}

test('PostgreSQL operações/CRM: projeção durável, compatibilidade, rollback e isolamento',{
  skip:!enabled&&'MEPCHAT_TEST_PG_OPERATIONS=1 é opt-in; exige fixture local com 003'
},async t=>{
  const app=new Pool({connectionString:localUrl(process.env.MEPCHAT_TEST_PG_URL),max:3});
  const admin=new Pool({connectionString:localUrl(process.env.MEPCHAT_TEST_PG_ADMIN_URL),max:1});
  t.after(async()=>{await Promise.all([app.end(),admin.end()]);});
  const {rows:[capability]}=await admin.query("SELECT source_id FROM mepchat_private.reseller_sources WHERE reseller_id='mep-demo'");
  assert.ok(capability,'Execute o gate sintético de onboarding 003 antes desta suíte.');
  const source=capability.source_id, a=snapshot(), b=snapshot();
  const migration=(await readFile(new URL('../db/004-operations-crm.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  async function apply() {
    const client=await admin.connect();
    try {await client.query(migration);} catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async function scoped(data,callback,options={}) {
    const client=await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('mepchat.user_id',$1,true),set_config('mepchat.reseller_id',$2,true),set_config('mepchat.tenant_id',$3,true)",[options.user??'mepchat-local-bridge',options.resellerId??data.resellerId,options.tenantId??data.id]);
      const result=await callback(client); await client.query('COMMIT'); return result;
    } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  const sync=(data,revision=1,options={})=>scoped(data,async client=>{
    if(options.provision!==false) await client.query('SELECT mepchat_private.provision_reseller($1,$2,$3)',[data.resellerId,data.id,options.source??source]);
    return client.query('SELECT mepchat_private.sync_workspace($1::jsonb,$2,$3::bigint) AS result',[JSON.stringify(data),options.source??source,revision]);
  },options);
  const persisted=async data=>{
    const {rows:[tenant]}=await admin.query('SELECT name,settings FROM mepchat.tenants WHERE id=$1',[data.id]);
    const {rows:[bridge]}=await admin.query('SELECT revision::text FROM mepchat_private.bridge_state WHERE tenant_id=$1',[data.id]);
    const {rows:messages}=await admin.query('SELECT content FROM mepchat.messages WHERE tenant_id=$1 ORDER BY id',[data.id]);
    return {tenant,bridge,messages};
  };

  await t.test('004 é reaplicável, wrapper tem dono/search_path seguro e base não é executável pelo app',async()=>{
    await apply();
    const before=await admin.query("SELECT oid::text,proname FROM pg_proc WHERE oid IN (to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)')) ORDER BY proname");
    await apply();
    const after=await admin.query("SELECT oid::text,proname FROM pg_proc WHERE oid IN (to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)')) ORDER BY proname");
    assert.equal(before.rows.length,2); assert.deepEqual(after.rows,before.rows);
    const functions=await admin.query(`SELECT p.proname,p.prosecdef,r.rolname AS owner,p.proconfig,
      has_function_privilege('mepchat_app',p.oid,'EXECUTE') AS app,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid IN (to_regprocedure('mepchat_private.sync_workspace(jsonb,text,bigint)'),to_regprocedure('mepchat_private.sync_workspace_base_003(jsonb,text,bigint)'))`);
    for(const fn of functions.rows){assert.equal(fn.prosecdef,true);assert.equal(fn.owner,'supabase_admin');assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);assert.equal(fn.public,false);assert.equal(fn.app,fn.proname==='sync_workspace');}
    await assert.rejects(app.query('SELECT mepchat_private.sync_workspace_base_003($1::jsonb,$2,1)',[JSON.stringify(a),source]),error=>error.code==='42501');
    await assert.rejects(app.query('SELECT * FROM mepchat_private.reseller_sources'),error=>error.code==='42501');
  });

  await t.test('duas revendas projetam contatos/departamentos/default e mantêm responsáveis, eventos e autores',async()=>{
    for(const data of [a,b]){
      assert.equal((await sync(data)).rows[0].result.state,'synced');
      const selected=await scoped(data,client=>client.query('SELECT settings FROM mepchat.tenants WHERE id=$1',[data.id]));
      assert.deepEqual(selected.rows[0].settings.contacts,data.contacts);assert.deepEqual(selected.rows[0].settings.departments,data.departments);
      assert.equal(selected.rows[0].settings.defaultDepartmentId,data.defaultDepartmentId);
      const conversation=await scoped(data,client=>client.query('SELECT attributes FROM mepchat.conversations WHERE id=$1',[data.conversations[0].id]));
      assert.equal(conversation.rows[0].attributes.assignedUserId,data.conversations[0].assignedUserId);
      assert.equal(conversation.rows[0].attributes.contactId,data.contacts[0].id);
      assert.deepEqual(conversation.rows[0].attributes.attendantEvents,data.conversations[0].attendantEvents);
      const message=await scoped(data,client=>client.query('SELECT content FROM mepchat.messages WHERE id=$1',[data.conversations[0].messages[0].id]));
      assert.equal(message.rows[0].content.authorUserId,data.conversations[0].assignedUserId);
      assert.equal(message.rows[0].content.authorName,'Pessoa sintética');
      assert.equal(JSON.stringify([selected.rows,conversation.rows,message.rows]).includes('DO_NOT_PROJECT_AUTH_FIXTURE'),false);
      assert.equal(selected.rows[0].settings.authUsers,undefined);
    }
  });

  await t.test('RLS bloqueia leitura sem contexto, de outro tenant/revenda e principal forjado',async()=>{
    assert.equal((await app.query('SELECT count(*)::int AS n FROM mepchat.tenants')).rows[0].n,0);
    for(const data of [a,b]){
      const own=await scoped(data,client=>client.query('SELECT id FROM mepchat.tenants'));assert.deepEqual(own.rows.map(row=>row.id),[data.id]);
      const other=data.id===a.id?b:a;
      const blocked=await scoped(data,client=>client.query('SELECT count(*)::int AS n FROM mepchat.tenants WHERE id=$1',[other.id]));assert.equal(blocked.rows[0].n,0);
      const foreignMessages=await scoped(data,client=>client.query('SELECT count(*)::int AS n FROM mepchat.messages WHERE tenant_id=$1',[other.id]));assert.equal(foreignMessages.rows[0].n,0);
    }
    const forged=await scoped(a,client=>client.query('SELECT count(*)::int AS n FROM mepchat.tenants'),{user:'principal-forjado'});assert.equal(forged.rows[0].n,0);
  });

  await t.test('replay antigo não apaga arrays recentes; snapshot novo sem campos preserva a extensão existente',async()=>{
    const newer=structuredClone(a);newer.contacts[0].notes='Nota revisão 2';newer.departments[0].description='Departamento revisão 2';
    assert.equal((await sync(newer,2)).rows[0].result.state,'synced');
    const baseline=await persisted(a);
    const stale={...a,contacts:[],departments:[],defaultDepartmentId:null};
    assert.equal((await sync(stale,1)).rows[0].result.state,'already_synced');
    assert.equal((await sync({...stale,contacts:null},2)).rows[0].result.state,'already_synced');
    assert.deepEqual(await persisted(a),baseline);
    const legacy=structuredClone(newer);delete legacy.contacts;delete legacy.departments;delete legacy.defaultDepartmentId;
    legacy.name='Snapshot compatível sem campos novos';
    assert.equal((await sync(legacy,3)).rows[0].result.state,'synced');
    const preserved=await persisted(a);assert.equal(preserved.tenant.name,legacy.name);
    for(const field of ['contacts','departments','defaultDepartmentId'])assert.deepEqual(preserved.tenant.settings[field],baseline.tenant.settings[field]);
    const cleared={...legacy,contacts:[],departments:[],defaultDepartmentId:null};assert.equal((await sync(cleared,4)).rows[0].result.state,'synced');
    const settings=(await persisted(a)).tenant.settings;assert.deepEqual(settings.contacts,[]);assert.deepEqual(settings.departments,[]);assert.equal(settings.defaultDepartmentId,null);
  });

  await t.test('arrays/IDs inválidos revertem base, mensagem, settings e revisão na mesma transação',async()=>{
    const baseline=await persisted(b);
    for(const fields of [{contacts:{}},{contacts:null},{departments:'bad'},{contacts:[null]},
      {departments:[{id:'duplicate'},{id:'duplicate'}]},{contacts:[{id:''}]},{defaultDepartmentId:{id:'bad'}}]){
      const bad=structuredClone(b);Object.assign(bad,fields);bad.name='Nome que deve reverter';bad.conversations[0].messages[0].text='Texto que deve reverter';
      await assert.rejects(sync(bad,2),error=>error.code==='22023');assert.deepEqual(await persisted(b),baseline);
    }
    const fresh=snapshot();fresh.contacts={};await assert.rejects(sync(fresh),error=>error.code==='22023');
    for(const [table,column,id] of [['mepchat.resellers','id',fresh.resellerId],['mepchat.tenants','id',fresh.id],['mepchat_private.reseller_sources','reseller_id',fresh.resellerId],['mepchat_private.bridge_state','tenant_id',fresh.id]]){
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,[id])).rows[0].n,0);
    }
  });

  await t.test('source/GUC/reseller divergentes recusam projeção sem alterar dados existentes',async()=>{
    const beforeA=await persisted(a),beforeB=await persisted(b);
    for(const options of [{resellerId:b.resellerId},{tenantId:b.id},{user:'principal-forjado'},{source:randomUUID()}]) await assert.rejects(sync(a,10,{...options,provision:false}));
    await assert.rejects(sync({...a,resellerId:b.resellerId},10,{provision:false}));
    assert.deepEqual(await persisted(a),beforeA);assert.deepEqual(await persisted(b),beforeB);
  });
});
