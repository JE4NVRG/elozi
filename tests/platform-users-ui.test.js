import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformUsersUI, platformUsersMarkup, platformUsersQuery } from '../public/platform-users-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));


test('identidade vem apenas de nome, email do DTO ou username intencional; não exibe ID nem inventa email', t => {
 const oldLocale = getLocale(); t.after(() => setLocale(oldLocale, { persist:false, notify:false }));
 const generated = 'u_0123456789abcdef0123456789abcdef';
 const base = { id:'technical-id-never-display', role:'operator', reseller:{name:'Conta'}, tenants:[], tenantCount:0 };
 const cases = [
  [{name:'Ana',username:generated,email:'ana@example.test'},'Ana','ana@example.test'],
  [{name:'',username:generated,email:'ana@example.test'},'ana@example.test',null],
  [{name:'Só nome',username:generated,email:null},'Só nome',null],
  [{name:'',username:generated,email:null},null,null],
  [{name:'Legado',username:'u_cafe',email:null},'Legado','u_cafe'],
  [{name:'Intencional',username:'u_1234',email:'real@example.test'},'Intencional','u_1234'],
  [{name:'Intencional',username:'u_0123456789abcdef0123456789abcdef-extra',email:'real@example.test'},'Intencional','u_0123456789abcdef0123456789abcdef-extra'],
  [{name:'Sem nome legível',username:generated,email:{value:'not-an-email'}},'Sem nome legível',null],
  [{name:'Escape',username:generated,email:'<img src=x onerror=alert(1)>@example.test'},'Escape','&lt;img src=x onerror=alert(1)&gt;@example.test']
 ];
 for (const locale of ['pt-BR','en','pt-BR']) {
  setLocale(locale,{persist:false,notify:false});
  for (const [fields, primary, secondary] of cases) {
   const markup=platformUsersMarkup({total:1,offset:0,users:[{...base,...fields}]},{escape});
   const identity=markup.match(/<div class="pg-settings__identity-text">(.*?)<\/div>/)?.[1];
   assert.ok(identity); assert.ok(identity.includes(`<strong>${primary || (locale==='en'?'Person':'Pessoa')}</strong>`));
   if (secondary) assert.ok(identity.includes(`<span class="pg-settings__sub">${secondary}</span>`));
   else assert.equal(identity.includes('pg-settings__sub'),false);
   if (fields.username===generated) assert.equal(identity.includes(generated),false);
   assert.equal(markup.includes(base.id),false); assert.equal(markup.includes('<img src=x'),false);
   if (!fields.email || typeof fields.email!=='string') assert.equal(identity.includes('@'),false);
  }
 }
});

test('busca por email, atualização e limpar filtros percorrem caller real e preservam username manual em PT→EN→PT', async t => {
 const oldLocale=getLocale(); t.after(()=>setLocale(oldLocale,{persist:false,notify:false}));
 const generated='u_0123456789abcdef0123456789abcdef';
 const users=[{name:'Ana',username:generated,email:'ana@example.test'},{name:'Legado',username:'u_cafe',email:null},{name:'Outra pessoa',username:generated,email:null}].map(user=>({...user,role:'operator',reseller:{name:'Conta'},tenants:[],tenantCount:0}));
 const calls=[]; const context={userId:'owner',workspaceId:'platform',platformOwner:true,active:true};
 const ui=createPlatformUsersUI({getContext:()=>context,escape,openModal:()=>assert.fail('Página não deve abrir modal'),request:async(path,init)=>{
  calls.push({path,init}); const query=new URL(path,'http://local').searchParams;
  const q=query.get('q').toLowerCase(),offset=Number(query.get('offset')),limit=Number(query.get('limit'));
  const selected=users.filter(user=>[user.name,user.username,user.email].some(value=>String(value||'').toLowerCase().includes(q)));
  return {users:selected.slice(offset,offset+limit),total:selected.length,offset,limit,hasMore:offset+limit<selected.length};
 }});
 for(const locale of ['pt-BR','en','pt-BR']) {
  setLocale(locale,{persist:false,notify:false}); await ui.load();
  assert.ok(ui.view().includes('u_cafe')); assert.equal(ui.view().includes(generated),false);
  const submit={disabled:false,isConnected:true};
  const form={matches:selector=>selector==='[data-platform-users-form]',elements:{namedItem:name=>({value:name==='q'?'ana@example.test':'all'})},querySelector:()=>submit};
  assert.equal(await ui.submit(form),true); assert.equal(submit.disabled,false);
  for(const html of [ui.view(),(await ui.action('platform-users-refresh'),ui.view())]) {
   assert.ok(html.includes('ana@example.test')); assert.equal(html.includes('Legado'),false); assert.equal(html.includes(generated),false);
  }
  assert.equal(new URL(calls.at(-1).path,'http://local').searchParams.get('q'),'ana@example.test');
  await ui.action('platform-users-clear'); assert.ok(ui.view().includes('Legado')); assert.ok(ui.view().includes('u_cafe'));
  assert.equal(new URL(calls.at(-1).path,'http://local').searchParams.get('q'),'');
 }
 assert.ok(calls.every(call=>call.init.headers['X-Elozi-Workspace']==='platform'&&!call.init.method));
 const n=calls.length; context.platformOwner=false; await ui.action('platform-users-refresh'); assert.equal(calls.length,n); assert.equal(ui.view().includes('ana@example.test'),false);
});

test('diretório mostra revenda e empresas, escapa campos externos e não oferece intervenção', () => {
 const markup = platformUsersMarkup({total:1,offset:0,hasMore:false,users:[{name:'<img src=x onerror=alert(1)>',username:'nome',role:'operator',reseller:{name:'Revenda & Cia'},tenants:[{name:'Empresa <A>'}],tenantCount:2}]},{escape});
 assert.ok(markup.includes('&lt;img')); assert.ok(markup.includes('Revenda &amp; Cia')); assert.ok(markup.includes('Empresa &lt;A&gt;')); assert.ok(markup.includes('+1')); assert.ok(!markup.includes('<img')); assert.ok(!markup.includes('data-action="edit-user"'));
 const url = new URL(platformUsersQuery({q:'a&b',state:'disabled',offset:50}),'http://localhost'); assert.equal(url.searchParams.get('q'),'a&b'); assert.equal(url.searchParams.get('limit'),'50');
});

test('diretório renderiza foto salva, monograma sem foto e selo de presença sem aceitar imagem externa', () => {
 const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
 const person = { name: '<Jean "QA">', username: 'jean.qa', role: 'operator', reseller: {name:'Revenda'}, tenants: [], tenantCount:0, presence:'available' };
 const render = (avatar, extra = {}) => platformUsersMarkup({total:1,offset:0,users:[{...person,avatar,...extra}]},{escape});
 const markup = render(photo);
 assert.match(markup, /class="ui-avatar__img" src="data:image\/png;base64,/);
 assert.match(markup, /data-presence="available"/); assert.match(markup, /&lt;Jean &quot;QA&quot;&gt;/);
 assert.doesNotMatch(markup, /<Jean|data-action="edit-user"/);
 for (const unsafe of [null, undefined, 'https://untrusted.invalid/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
   const fallback = render(unsafe); assert.match(fallback, /class="ui-avatar__initials"/); assert.doesNotMatch(fallback, /<img/);
 }
 assert.doesNotMatch(render(photo, {disabled:true}), /data-presence=/);
});
test('resultado atrasado não reabre diretório fechado nem atravessa workspace', async () => {
 let context={userId:'admin',workspaceId:'a',platformOwner:true}, resolveRequest, opened=0;
 const ui=createPlatformUsersUI({request:()=>new Promise(resolve=>resolveRequest=resolve),getContext:()=>context,openModal:()=>opened++,escape,toast:()=>{}});
 const first=ui.open(); ui.reset(); resolveRequest({users:[],total:0}); assert.equal(await first,false); assert.equal(opened,0);
 const second=ui.open(); context={...context,workspaceId:'b'};resolveRequest({users:[],total:0});assert.equal(await second,false); assert.equal(opened,0);
});
test('interface do diretório não solicita dados para gestor da revenda', async () => {
 let calls=0;const ui=createPlatformUsersUI({request:async()=>calls++,getContext:()=>({userId:'r',workspaceId:'a',platformOwner:false}),openModal:()=>{},escape,toast:()=>{}});
 await assert.rejects(ui.open(),/administrador da plataforma/); assert.equal(calls,0);
});

test('perfil administrativo da conta não implica revenda e conserva principal distinto', () => {
 const markup=platformUsersMarkup({total:3,offset:0,hasMore:false,users:[
  {name:'Administrador empresa',username:'empresa',role:'reseller',reseller:{name:'Minha empresa'},tenants:[]},
  {name:'Principal',username:'principal',role:'reseller',platformAdmin:true,reseller:{name:'Plataforma'},tenants:[]},
  {name:'Atendente',username:'operador',role:'operator',reseller:{name:'Minha empresa'},tenants:[]}
 ]},{escape});
 assert.ok(markup.includes('Administrador da conta'));
 assert.ok(markup.includes('Administrador da plataforma'));
 assert.ok(!markup.includes('Gestão da revenda'));
 assert.ok(!markup.includes('data-action="edit-user"'));
});
