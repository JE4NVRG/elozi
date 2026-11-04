import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../public/i18n.js';
import { PRODUCT_AGENT_CONNECTIONS, PRODUCT_AGENT_CLIENTS, productAgentClientConfig, renderProductAgentConnections } from '../public/product-agent-connections.js';

test('produtos têm endpoints HTTPS próprios e Send/Correio mantêm autenticações distintas',()=>{
  assert.equal(PRODUCT_AGENT_CONNECTIONS.length,4);assert.ok(Object.isFrozen(PRODUCT_AGENT_CONNECTIONS));
  const send=productAgentClientConfig('mepmail-send','claude'),mailbox=productAgentClientConfig('mepmail-correio','claude');
  assert.equal(send.endpoint,'https://api.mepmail.dev/mcp');assert.equal(send.authentication,'oauth');assert.equal(send.tokenEnv,null);
  assert.equal(mailbox.endpoint,'https://api.mepmail.dev/mcp/correio');assert.equal(mailbox.authentication,'bearer');assert.notEqual(send.name,mailbox.name);
  assert.equal(JSON.parse(send.code).mcpServers.mepmail_send.headers,undefined);
  assert.equal(JSON.parse(mailbox.code).mcpServers.mepmail_correio.headers.Authorization,'Bearer ${MEPMAIL_CORREIO_MCP_TOKEN}');
  for(const product of PRODUCT_AGENT_CONNECTIONS)assert.equal(new URL(product.endpoint).protocol,'https:');
});

test('templates de todos os clientes usam somente formatos oficiais e referências sem credenciais',()=>{
  for(const product of PRODUCT_AGENT_CONNECTIONS)for(const client of Object.keys(PRODUCT_AGENT_CLIENTS)){
    const config=productAgentClientConfig(product.id,client,{token:'synthetic-private-value',clientId:'workspace-a',accountId:'account-a'});
    assert.equal(config.client,client);assert.doesNotMatch(JSON.stringify(config),/synthetic-private-value|elozi_svc_|<sua chave>|your.key|echo |print|console/);
    if(client==='claude'){const entry=Object.values(JSON.parse(config.code).mcpServers)[0];assert.equal(entry.type,'http');assert.equal(entry.url,config.endpoint);}
    if(client==='codex'&&product.auth==='bearer')assert.match(config.code,/bearer_token_env_var/);
    if(client==='codex'&&product.auth==='agent-key'){assert.match(config.code,/env_http_headers = \{ "X-Agent-Key" = "FULLCOMMERCE_AGENT_KEY" \}/);assert.doesNotMatch(config.code,/Authorization|bearer_token_env_var/);}
    if(client==='hermes'&&product.auth==='oauth')assert.match(config.code,/auth: oauth/);
    if(client==='hermes'&&product.auth!=='oauth')assert.match(config.code,/headers:/);
  }
  assert.equal(productAgentClientConfig('unknown','codex'),null);assert.equal(productAgentClientConfig('urlpivot','unknown'),null);
});

test('FullCommerce recebe contexto público explícito e não infere nem injeta parâmetros',()=>{
  const empty=productAgentClientConfig('fullcommerce','codex');assert.equal(empty.contextRequired,true);assert.equal(new URL(empty.endpoint).search,'');
  const explicit=productAgentClientConfig('fullcommerce','claude',{clientId:'workspace-a',accountId:'account-a'});const url=new URL(explicit.endpoint);
  assert.equal(explicit.contextRequired,false);assert.equal(url.searchParams.get('client_id'),'workspace-a');assert.equal(url.searchParams.get('account_id'),'account-a');assert.equal(url.searchParams.size,2);
  for(const bad of ['//outside.invalid','a&token=synthetic-secret','<script>alert(1)</script>'])assert.equal(productAgentClientConfig('fullcommerce','codex',{clientId:bad,accountId:'account-a'}).contextRequired,true);
  const html=String(renderProductAgentConnections({client:'hermes',fullcommerce:{clientId:'workspace-a',accountId:'account-a',token:'synthetic-private-value'}}));assert.match(html,/client_id=workspace-a&amp;account_id=account-a/);assert.doesNotMatch(html,/synthetic-private-value/);
});

test('seção didática oferece opções nativas acessíveis, escopos separados e não executa integração',()=>{
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw Error('a seção não pode chamar a rede');};
  try{const html=String(renderProductAgentConnections());assert.match(html,/id="product-agent-connections"/);assert.match(html,/aria-labelledby="product-agent-connections-title"/);assert.equal((html.match(/<details /g)||[]).length,12);assert.equal((html.match(/<pre tabindex="0" aria-label=/g)||[]).length,12);assert.match(html,/emails:read/);assert.match(html,/emails:send/);assert.match(html,/A chave Elozi não abre/);assert.match(html,/tools\/list/);assert.match(html,/urlpivot:\/\/capabilities/);assert.match(html,/X-Agent-Key/);assert.doesNotMatch(html,/<script|<iframe|data-action=|data-form=|type="password"|input.*token/);}finally{globalThis.fetch=previous;}
});

test('catálogo inglês real traduz a seção mantendo produtos, endpoints e variáveis',()=>{
  setLocale('en',{persist:false,notify:false});try{const html=String(renderProductAgentConnections({client:'claude'}));assert.match(html,/Connect operations across your products/);assert.match(html,/The Elozi key does not unlock/);assert.match(html,/Authorized actions/);assert.match(html,/MEPMAIL_CORREIO_MCP_TOKEN/);assert.match(html,/https:\/\/api.mepmail.dev\/mcp/);assert.doesNotMatch(html,/Conectar operações|Ações autorizadas|A chave Elozi não abre/);}finally{setLocale('pt-BR',{persist:false,notify:false});}
});
