import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setLocale } from '../public/i18n.js';
import { WEBCHAT_INSTALL_STEPS, renderWebchatInstallGuide, renderWebchatInstallation, renderWebchatValidation, renderWebchatServiceChoices, webchatInstallReadiness, copyWebchatInstallCode } from '../public/webchat-install-guide.js';

const snippet = '<script type="module" src="https://elozi.example/widget.js" data-tenant-id="company-a" data-channel-id="channel-a"></script>';
const status = { enabled:true, origins:['https://site.example'], install:{embedSnippet:snippet} };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };

test('four-step shell exposes the active step and server authorization without inferred installation or test completion', () => {
  assert.deepEqual(WEBCHAT_INSTALL_STEPS, ['authorize','appearance','install','validate']);
  for (const step of WEBCHAT_INSTALL_STEPS) {
    const markup = renderWebchatInstallGuide({step,status:{...status,installed:true,tested:true},token:'17',content:'<form>existing form</form>'});
    assert.equal((markup.match(/aria-current="step"/g)||[]).length,1);
    assert.match(markup,new RegExp(`data-webchat-install-step="${step}"`));
    assert.match(markup,/Origem habilitada no servidor/);
    assert.match(markup,/<form>existing form<\/form>/);
    assert.doesNotMatch(markup,/data-webchat-step-state="(complete|installed|tested)"/);
  }
});

test('prerequisites precede supplied fields and draft message distinguishes saved configuration', () => {
  const markup = renderWebchatInstallGuide({step:'authorize',status:{enabled:false,origins:[]},content:'<textarea name="origins"></textarea>',hasDraft:true});
  assert.ok(markup.indexOf('Tenha acesso para publicar scripts') < markup.indexOf('<textarea'));
  assert.match(markup,/Seu rascunho está preservado neste painel/);
  assert.match(markup,/Instalação e teste usam a configuração salva no servidor/);
  assert.match(markup,/Autorize e habilite o site/);
});

test('install instructions encode the canonical code as text and never render it as an executable script', () => {
  const markup=renderWebchatInstallation({status,token:'1'});
  assert.match(markup,/&lt;script type=&quot;module&quot;/);
  assert.match(markup,/antes de &lt;\/body&gt;/);
  assert.match(markup,/data-connector-action="copy-webchat-code"/);
  assert.match(markup,/Copiar o código não confirma a instalação/);
  assert.doesNotMatch(markup,/<script/);
  const hostile=renderWebchatInstallation({status:{...status,install:{embedSnippet:'</textarea><img src=x onerror="alert(1)">'}},token:'"><img>'});
  assert.doesNotMatch(hostile,/<img/);
  assert.match(hostile,/&lt;\/textarea&gt;&lt;img/);
  assert.match(hostile,/data-connector-token="&quot;&gt;&lt;img&gt;"/);
});

test('installation readiness uses confirmed enabled origins and install DTO; unmet prerequisites hide copy and test actions', () => {
  assert.equal(webchatInstallReadiness(status),true);
  for(const unavailable of [{...status,enabled:false},{...status,enabled:'true'},{...status,origins:[]},{...status,origins:null},{...status,install:null},{...status,install:{embedSnippet:''}}]) {
    assert.equal(webchatInstallReadiness(unavailable),false);
    assert.doesNotMatch(renderWebchatInstallation({status:unavailable}),/data-connector-action="copy-webchat-code"/);
    assert.doesNotMatch(renderWebchatValidation({status:unavailable}),/data-connector-action="test-journey"/);
    assert.match(renderWebchatInstallation({status:unavailable}),/Salve uma origem autorizada/);
  }
});

test('authenticated SaaS guide uses server supplied example and explains account lifecycle without claiming identity acceptance',()=>{
  const example='import { createSaasWebchat } from "https://elozi.example/widget-saas.js";';
  const markup=renderWebchatInstallation({platform:'saas',status:{...status,install:{embedSnippet:snippet,authenticatedSnippet:example}}});
  assert.match(markup,/accountId/);assert.match(markup,/JWT v2/);assert.match(markup,/troca de conta, logout/);assert.match(markup,/parâmetros do navegador não concedem acesso/);
  assert.match(markup,/createSaasWebchat/);assert.doesNotMatch(markup,/&lt;script type=/);assert.match(markup,/identity-settings/);
  const legacy=renderWebchatInstallation({platform:'saas',status});assert.doesNotMatch(legacy,/copy-webchat-code/);assert.match(legacy,/Atualize o servidor/);
});

test('platform guides use a generic authorized scripts resource and do not invent WordPress plugins, PHP or detection', () => {
  for(const platform of ['html','wordpress','other']) {
    const markup=renderWebchatInstallation({status,platform});
    assert.match(markup,new RegExp(`webchat-platform-${platform}"[^>]*aria-pressed="true"`));
    assert.equal((markup.match(/aria-pressed="true"/g)||[]).length,1);
    assert.match(markup,/<ol>/);
    assert.doesNotMatch(markup,/<\?php|functions\.php|instalação detectada|plugin recomendado|wp_head/i);
  }
  const wordpress=renderWebchatInstallation({status,platform:'wordpress'});
  assert.match(wordpress,/recurso autorizado de scripts globais ou código personalizado/);
  assert.match(wordpress,/depende da hospedagem, do plano e das permissões/);
  assert.match(wordpress,/pessoa responsável pelo site/);
});

test('validation opens the existing channel test and service choices link only to existing management pages', () => {
  const markup=renderWebchatValidation({status,token:'8'}), choices=renderWebchatServiceChoices({token:'8'});
  assert.match(markup,/data-connector-action="test-journey" data-connector-token="8"/);
  assert.match(markup,/não marca o site como instalado nem envia mensagem por você/);
  assert.deepEqual([...choices.matchAll(/href="([^"]+)"/g)].map(match=>match[1]),['#settings/team','#agents','#agents/connect']);
  assert.match(choices,/não cria acessos nem escolhe um modelo/);
});

test('PT/EN copy is registered literally and leaves snippet customer identifiers untouched', t => {
  t.after(()=>setLocale('pt-BR',{persist:false,notify:false}));
  setLocale('en',{persist:false,notify:false});
  const markup=renderWebchatInstallGuide({step:'install',status,token:'4',content:renderWebchatInstallation({status,platform:'wordpress'})});
  assert.match(markup,/Authorize website/);
  assert.match(markup,/Customize/);
  assert.match(markup,/Install/);
  assert.match(markup,/Validate/);
  assert.match(markup,/Copy code/);
  assert.match(markup,/This feature’s availability depends on your website’s hosting/);
  assert.match(markup,/company-a/);
  assert.doesNotMatch(markup,/Autorizar site|Copiar código|recurso autorizado/);
  setLocale('pt-BR',{persist:false,notify:false});
  assert.match(renderWebchatInstallation({status}),/Copiar código/);
});

test('copy writes the supplied canonical DTO snippet only after the guard and reports success after confirmation', async () => {
  const events=[], result=await copyWebchatInstallCode({snippet,clipboard:{async writeText(text){events.push(['copy',text]);}},guard:()=>true,onSuccess:()=>events.push(['success']),onFailure:()=>events.push(['failure'])});
  assert.equal(result,true);assert.deepEqual(events,[['copy',snippet],['success']]);
});

test('copy denies invalid or stale views before clipboard invocation, including a throwing scope guard', async () => {
  let writes=0,feedback=0;
  for(const guard of [()=>false,()=>{throw Error('scope unavailable');}]) {
    assert.equal(await copyWebchatInstallCode({snippet,clipboard:{writeText(){writes++;}},guard,onFailure:()=>feedback++}),false);
  }
  for(const invalid of [null,undefined,'',42])assert.equal(await copyWebchatInstallCode({snippet:invalid,clipboard:{writeText(){writes++;}},guard:()=>true}),false);
  assert.equal(writes,0);assert.equal(feedback,0);
});

test('clipboard success or rejection after a view/scope change cannot write feedback into the next panel', async () => {
  for(const fail of [false,true]){
    const pending=deferred();let valid=true,feedback=0;
    const copying=copyWebchatInstallCode({snippet,clipboard:{writeText:()=>pending.promise},guard:()=>valid,onSuccess:()=>feedback++,onFailure:()=>feedback++});
    valid=false;if(fail)pending.reject(Error('clipboard denied'));else pending.resolve();
    assert.equal(await copying,false);assert.equal(feedback,0);
  }
});

test('denied or unavailable clipboard keeps a manual-copy fallback in the current view', async () => {
  for(const clipboard of [undefined,{}, {writeText:async()=>{throw Error('denied');}}]) {
    let failed=0;const result=await copyWebchatInstallCode({snippet,clipboard,guard:()=>true,onFailure:()=>failed++});
    assert.equal(result,false);assert.equal(failed,1);
  }
});

test('guide stylesheet uses real semantic tokens, component layer, narrow-width layouts and visible keyboard focus', async () => {
  const css=await readFile(new URL('../public/webchat-install-guide.css',import.meta.url),'utf8');
  const tokens=await readFile(new URL('../public/tokens.css',import.meta.url),'utf8');
  assert.match(css,/@layer components/);assert.match(css,/@media \(max-width: 900px\)/);assert.match(css,/:focus-visible/);assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/min-height: var\(--target-touch\)/);assert.doesNotMatch(css,/#[a-f\d]{3,8}\b|rgb\(|hsl\(/i);
  for(const name of new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(match=>match[1])))assert.ok(tokens.includes(`${name}:`),`undefined token ${name}`);
});
