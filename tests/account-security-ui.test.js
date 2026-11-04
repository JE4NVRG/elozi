import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountSecurityUI} from '../public/account-security-ui.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const session=(id,current=false)=>({id,current,createdAt:'2026-10-03T12:00:00Z',expiresAt:'2026-10-04T12:00:00Z'});
function fixture(t,request) {
  const previous=globalThis.document,targets={'[data-security-sessions]':{innerHTML:''},'[data-account-security-error]':{textContent:''}};
  globalThis.document={querySelector:selector=>targets[selector]||null};t.after(()=>{globalThis.document=previous;});
  const state={account:{user:{id:'user-a'}},workspaceId:'workspace-a',boot:{csrfToken:'csrf-a'},securitySessions:[session('current-a',true),session('other-a')]},calls=[],messages=[];
  const ui=createAccountSecurityUI({state,escape,icon:()=>'',api:async(path,init)=>{calls.push({path,init});return request?request(path,init):path==='/api/auth/sessions'?{sessions:[session('current-a',true),session('other-a')]}:path.endsWith('/revoke')?{revoked:true,current:false}:{changed:true,revokedSessions:1};},toast:message=>messages.push(message)});
  function form() {
    const markup=ui.markup(),fields={currentPassword:{value:'Old!Password'},password:{value:'New!Password'},passwordConfirm:{value:'New!Password'}},error={textContent:''},success={textContent:''},button={disabled:false};
    return {dataset:{accountSecurityForm:'password',accountSecurityToken:markup.match(/data-account-security-token="([^"]+)"/)[1]},elements:{namedItem:name=>fields[name]},querySelector:selector=>selector==='.form-error'?error:selector==='[data-password-success]'?success:selector==='[type="submit"]'?button:null,reset(){for(const field of Object.values(fields))field.value='';this.resetCount=(this.resetCount||0)+1;},fields,error,success,button,markup};
  }
  return {ui,state,calls,messages,targets,form};
}

test('segurança mostra política, sessões reais e nenhum botão para encerrar a atual',t=>{
  const env=fixture(t),form=env.form();assert.ok(form.markup.includes('autocomplete="current-password"'));assert.ok(form.markup.includes('minlength="8"'));assert.ok(form.markup.includes('maxlength="128"'));assert.match(form.markup,/<button type="submit" class="ui-btn ui-btn--primary ui-btn--md">/,'botão do design system (alvo de 44 px abaixo de 900 px)');assert.ok(form.markup.includes('data-id="other-a"'));assert.equal(form.markup.includes('data-id="current-a"'),false);assert.equal(form.markup.includes('Dispositivo'),false);assert.equal(form.markup.includes('IP:'),false);
});
test('confirmação diferente impede POST e mantém os campos',async t=>{
  const env=fixture(t),form=env.form();form.fields.passwordConfirm.value='Outra!Senha';assert.equal(await env.ui.submit(form),true);assert.match(form.error.textContent,/confirmação/);assert.equal(env.calls.length,0);assert.equal(form.fields.password.value,'New!Password');
});
test('senha atual obrigatória e nova senha segue a política do servidor',async t=>{
  const env=fixture(t),form=env.form();form.fields.currentPassword.value='';await env.ui.submit(form);assert.match(form.error.textContent,/senha atual/);form.fields.currentPassword.value='Old!Password';
  for(const value of ['curta!','lowercase!','NoSpecial123','No Special ']) {form.fields.password.value=value;form.fields.passwordConfirm.value=value;await env.ui.submit(form);assert.match(form.error.textContent,/8 a 128/);}
  assert.equal(env.calls.length,0);
});
test('alteração envia só senhas atual/nova, limpa após confirmação e remove outras sessões',async t=>{
  const env=fixture(t),form=env.form();await env.ui.submit(form);const [call]=env.calls;assert.equal(call.path,'/api/auth/password/change');assert.deepEqual(JSON.parse(call.init.body),{currentPassword:'Old!Password',password:'New!Password'});assert.equal(call.init.headers['X-Elozi-Workspace'],'workspace-a');assert.equal(form.resetCount,1);assert.equal(form.fields.currentPassword.value,'');assert.deepEqual(env.state.securitySessions,[session('current-a',true)]);assert.match(form.success.textContent,/1 outra sessão/);assert.equal(form.button.disabled,false);assert.equal('password' in env.state,false);
});
test('senha aceita maiúscula Unicode sem divergência com o servidor',async t=>{
  const env=fixture(t),form=env.form();form.fields.password.value='Árvore!2026';form.fields.passwordConfirm.value='Árvore!2026';await env.ui.submit(form);assert.equal(env.calls.length,1);assert.equal(form.resetCount,1);
});
test('falha visível preserva senhas e permite corrigir, sem reset',async t=>{
  const env=fixture(t,async()=>{throw Object.assign(new Error('Senha atual incorreta.'),{status:400});}),form=env.form();await env.ui.submit(form);assert.equal(form.error.textContent,'Senha atual incorreta.');assert.equal(form.resetCount,undefined);assert.equal(form.fields.currentPassword.value,'Old!Password');assert.equal(form.fields.password.value,'New!Password');assert.equal(form.button.disabled,false);assert.equal(form.fields.password.readOnly,false);
});
test('resposta sem changed:true não limpa os campos nem anuncia sucesso',async t=>{
  const env=fixture(t,async()=>({})),form=env.form();await env.ui.submit(form);assert.match(form.error.textContent,/não confirmou/);assert.equal(form.resetCount,undefined);assert.equal(env.messages.length,0);
});
test('campos ficam somente leitura durante a requisição e duplo submit não duplica',async t=>{
  let resolve;const env=fixture(t,()=>new Promise(done=>resolve=done)),form=env.form(),waiting=env.ui.submit(form);assert.equal(form.fields.password.readOnly,true);assert.equal(form.button.disabled,true);await env.ui.submit(form);assert.equal(env.calls.length,1);resolve({changed:true,revokedSessions:0});await waiting;assert.equal(form.fields.password.readOnly,false);
});
test('formulário antigo ou sessão trocada não envia senhas',async t=>{
  const env=fixture(t),old=env.form();env.form();await env.ui.submit(old);assert.match(old.error.textContent,/Abra Minha conta/);const form=env.form();env.state.boot.csrfToken='changed';await env.ui.submit(form);assert.match(form.error.textContent,/Abra Minha conta/);assert.equal(env.calls.length,0);
});
test('resposta atrasada depois de troca de usuário não limpa ou publica sucesso',async t=>{
  let resolve;const env=fixture(t,()=>new Promise(done=>resolve=done)),form=env.form(),waiting=env.ui.submit(form);env.state.account.user.id='user-b';resolve({changed:true,revokedSessions:1});await waiting;assert.equal(form.resetCount,undefined);assert.equal(form.success.textContent,'');assert.equal(env.messages.length,0);
});
test('atualizar sessões usa GET e guarda somente os metadados contratados',async t=>{
  const returned={...session('fresh-a'),userAgent:'do-not-store',token:'do-not-store'};const env=fixture(t,async()=>({sessions:[returned]}));env.form();await env.ui.action('refresh-security-sessions');assert.equal(env.calls[0].path,'/api/auth/sessions');assert.deepEqual(env.state.securitySessions,[session('fresh-a')]);assert.ok(env.targets['[data-security-sessions]'].innerHTML.includes('fresh-a'));assert.equal(env.targets['[data-security-sessions]'].innerHTML.includes('do-not-store'),false);
});
test('resposta de sessões de outro workspace é descartada',async t=>{
  let resolve;const env=fixture(t,()=>new Promise(done=>resolve=done));env.form();const waiting=env.ui.action('refresh-security-sessions');env.state.workspaceId='workspace-b';resolve({sessions:[session('wrong')]});await waiting;assert.equal(env.state.securitySessions.some(item=>item.id==='wrong'),false);assert.equal(env.targets['[data-security-sessions]'].innerHTML,'');
});
test('sessão atual ou ausente não pode ser encerrada pela interface',async t=>{
  const env=fixture(t);env.form();await env.ui.action('revoke-security-session','current-a');await env.ui.action('revoke-security-session','missing');assert.equal(env.calls.length,0);assert.match(env.targets['[data-account-security-error]'].textContent,/outra sessão/);
});
test('encerrar outra sessão confirma no servidor e conserva a atual',async t=>{
  const env=fixture(t);env.form();await env.ui.action('revoke-security-session','other-a');assert.equal(env.calls[0].path,'/api/auth/sessions/other-a/revoke');assert.equal(env.calls[0].init.method,'POST');assert.equal(env.calls[0].init.body,'{}');assert.deepEqual(env.state.securitySessions,[session('current-a',true)]);assert.equal(env.messages.at(-1),'Sessão encerrada.');
});
test('falha de encerramento deixa sessão na lista e erro visível',async t=>{
  const env=fixture(t,async()=>{throw new Error('Serviço indisponível.');});env.form();await env.ui.action('revoke-security-session','other-a');assert.equal(env.state.securitySessions.length,2);assert.equal(env.targets['[data-account-security-error]'].textContent,'Serviço indisponível.');
});
test('GET atrasado não restaura sessões revogadas pela troca de senha',async t=>{
  let resolve;const env=fixture(t,(path)=>path==='/api/auth/sessions'?new Promise(done=>resolve=done):Promise.resolve({changed:true,revokedSessions:1})),form=env.form();const loading=env.ui.action('refresh-security-sessions');await env.ui.submit(form);resolve({sessions:[session('current-a',true),session('other-a')]});await loading;assert.deepEqual(env.state.securitySessions,[session('current-a',true)]);
});
test('reset invalida formulário e lista sem armazenar credenciais',async t=>{
  const env=fixture(t),form=env.form();env.ui.reset();await env.ui.submit(form);assert.equal(env.calls.length,0);assert.deepEqual(env.state.securitySessions,[]);assert.equal(await env.ui.action('unrelated'),false);assert.equal(await env.ui.submit({dataset:{}}),false);
});
