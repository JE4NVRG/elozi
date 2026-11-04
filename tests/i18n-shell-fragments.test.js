import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import '../public/locales-shell.js';
import { createOverviewMarkup } from '../public/overview-ui.js';
import { excerpt } from './helpers/app-source.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const tree = acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const registrationNode = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'updateChannelRegistration');
assert.ok(registrationNode, 'Exercise the served channel registration helper.');
const channelRegistration = source.slice(registrationNode.start, registrationNode.end);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
const channelRendering = excerpt('generated-channel-labels');
const maps = ['channelNames', 'providerNames', 'connectionStateNames'].map(name => {
  const line = source.split('\n').find(line => line.startsWith('const ' + name + ' = '));
  assert.ok(line, 'Exercise the served label map: ' + name);
  return line;
}).join('\n');
const fields = excerpt('field-helpers');
const actions = excerpt('act');
const applyContact = excerpt('contact-link-result');
const connection = excerpt('connection-timer');
const toastSource = source.split('\n').find(line => line.startsWith('function toast('));

function fixture(channelList = []) {
  const mounted = [], footer = { innerHTML: '' }, panel = { innerHTML: '', textContent: '' };
  const conversation = { id: 'conversation-a', contactId: null, version: 3, messages: [{ id: 'message-a', text: 'Bot aguardando conexão' }] };
  const state = { boot: { session: { role: 'reseller' } }, tenant: { conversations: [conversation] } };
  const idle = { action: async () => false, act: async () => false, reset() {} };
  const globals = {
    ...i18n, state, escape, channels: () => channelList,
    icon: () => '<svg></svg>', badge: text => `<span>${escape(text)}</span>`,
    formModal: (title, description, type, markup, submitLabel) => mounted.push({ title, description, type, markup, submitLabel }),
    currentConversation: () => conversation, $: selector => selector === '.context-version' ? footer : selector === '#connection-panel' ? panel : null,
    accountSecurityUI: idle, supportUI: idle, billingUI: idle, unitsUI: idle, knowledgeUI: idle, mcpUI: idle,
    integrationsUI: idle, contactLinksUI: idle, workspaceUI: idle, automationUI: idle, contactRefresh: idle, memoryUI: idle,
    attendanceAction: async () => false, updateContactsPage() {}, updateClientRecord() {}, toast() {}
  };
  const api = runInNewContext(maps + '\n' + channelRendering + '\n' + fields + '\n' + channelRegistration + '\n' + actions + '\n' + applyContact + '\n({act,displayChannelLabel,applyContactLinkResult})', globals);
  return { ...api, globals, mounted, footer, panel, conversation, state };
}

test('registered onboarding copy changes PT/EN/PT without changing authorized input', () => {
  const input = { tenant: { id: 'company-a', name: 'CPF/CNPJ registrado para esta conta' }, session: { role: 'reseller' }, access: {manageCompany:true,manageChannels:true,manageTeam:true,inboxRead:true}, accountOnboarding: { publicTrialEnabled: true, documentRegistered: true, lifecycle: {} } };
  const before = JSON.stringify(input);
  locale('pt-BR'); const pt = createOverviewMarkup(input);
  locale('en'); const en = createOverviewMarkup(input);
  // Visão geral of P7 (§5.4): the registered-document line below the trial; the company name is data.
  assert.match(en, /data-home-trial="document">Tax ID registered for this account<\/p>/);
  assert.match(en, /<span class="ui-company__name">CPF\/CNPJ registrado para esta conta<\/span>/);
  locale('pt-BR'); assert.equal(createOverviewMarkup(input), pt);
  assert.equal(JSON.stringify(input), before);
});

test('channel metadata uses only exact known labels; other values remain byte for byte', () => {
  const f = fixture(), known = [
    ['Número A · demonstração', 'Number A · demo'], ['Número B · demonstração', 'Number B · demo'],
    ['Widget de demonstração', 'Demo widget'], ['Integração pendente', 'Integration pending'],
    ['Webchat por origens autorizadas', 'Webchat for authorized origins'], ['Webchat desativado', 'Webchat disabled'],
    ['Meta configurada · aceite da conta pendente', 'Meta configured · account approval pending'], ['Meta desativada', 'Meta disabled'],
    ['Webhook Meta recebido', 'Meta webhook received'], ['MepMail e relay assinado; caixa postal externa necessária', 'MepMail and signed relay; external mailbox required'],
    ['Canal de e-mail desativado', 'Email channel disabled'], ['Bot aguardando conexão', 'Bot awaiting connection'],
    ['Aguardando configuração do canal', 'Awaiting channel setup'], ['Número de teste · final 0042', 'Test number · ending 0042']
  ];
  const unknown = ['@Bot_Équipe', '+55 •••• 0042', 'Número conectado · 0042', 'Número de teste · final 12345', 'Número de teste · final 0042\n', ' Bot aguardando conexão', 'Bot aguardando conexão personalizado', 'Descrição manual <PT> 😺', '', undefined, null];
  for (const language of ['pt-BR', 'en', 'pt-BR']) {
    locale(language);
    for (const [label, english] of known) {
      const channel = { name: label, label }, before = JSON.stringify(channel);
      assert.equal(f.displayChannelLabel(channel), language === 'en' ? english : label);
      assert.equal(JSON.stringify(channel), before);
    }
    for (const label of unknown) assert.equal(f.displayChannelLabel({ label }), label);
  }
});

test('new conversation choices translate known metadata without changing source IDs or manual names', async () => {
  const channels = [{ id: 'wa-a', name: 'Bot aguardando conexão', label: 'Número de teste · final 0042', transport: 'baileys', state: 'connected' }];
  const before = JSON.stringify(channels), f = fixture(channels);
  locale('en'); await f.act('new-conversation');
  assert.match(f.mounted.at(-1).markup, /value="wa-a">Bot aguardando conexão · Test number · ending 0042<\/option>/);
  locale('pt-BR'); await f.act('new-conversation');
  assert.match(f.mounted.at(-1).markup, /value="wa-a">Bot aguardando conexão · Número de teste · final 0042<\/option>/);
  assert.equal(JSON.stringify(channels), before);
});

test('new channel modal translates literal fragments while preserving field names and connection contract', async () => {
  const f = fixture(); locale('pt-BR'); await f.act('new-channel'); const pt = f.mounted.at(-1);
  locale('en'); await f.act('new-channel'); const en = f.mounted.at(-1);
  assert.match(en.markup, /Prepare real connection/); assert.match(en.markup, /Expected number with area code/);
  assert.match(en.markup, /Fill in for WhatsApp only\. Enter the Telegram token at the Connect bot step\./);
  assert.match(en.markup, /type="checkbox" name="real" checked/); assert.match(en.markup, /name="expectedNumber" inputmode="tel" placeholder="11 9XXXX XXXX" maxlength="20"/);
  assert.ok(en.markup.includes('value="telegram"')); assert.equal(en.markup.includes('value="whatsapp_cloud"'), false);
  assert.equal(en.type, pt.type); locale('pt-BR'); await f.act('new-channel'); assert.deepEqual(f.mounted.at(-1), pt);
});

test('new agent modal translates its guidance while copilot mode and provider values stay unchanged', async () => {
  const f = fixture(); locale('pt-BR'); await f.act('new-agent'); const pt = f.mounted.at(-1);
  locale('en'); await f.act('new-agent'); const en = f.mounted.at(-1);
  assert.match(en.markup, /For an existing Claude, Codex, OpenClaw or Hermes agent, choose Agent via MCP\./);
  assert.match(en.markup, /Registration keeps copilot mode and does not start a connection\./);
  assert.match(en.markup, /type="hidden" name="mode" value="copilot"/); assert.match(en.markup, /value="mcp"/);
  assert.equal(en.type, pt.type); locale('pt-BR'); await f.act('new-agent'); assert.deepEqual(f.mounted.at(-1), pt);
});

test('associate, merge and undo update the translated version footer without changing messages', () => {
  const f = fixture(), messages = JSON.stringify(f.conversation.messages);
  for (const language of ['pt-BR', 'en', 'pt-BR']) {
    locale(language);
    for (const operation of ['associate', 'merge', 'undo']) {
      const link = { conversationId: 'conversation-a', contactId: 'contact-a', version: 8 };
      f.applyContactLinkResult(operation === 'associate' ? { operation, conversationId: link.conversationId, contact: { id: link.contactId }, version: link.version } : { operation, links: [link] });
      assert.match(f.footer.innerHTML, language === 'en' ? /Version 8<p>Conversation changes invalidate responses prepared with the previous context\.<\/p>/ : /Versão 8<p>Alterações da conversa invalidam respostas preparadas no contexto anterior\.<\/p>/);
      assert.equal(f.conversation.version, 8); assert.equal(f.conversation.contactId, 'contact-a');
    }
  }
  assert.equal(JSON.stringify(f.conversation.messages), messages);
});

test('connection status translates generated label using the same helper and keeps the request payload', async () => {
  const f = fixture(), calls = [], modal = { open: true, dataset: {} }, status = { state: 'wrong_number', label: 'Número de teste · final 0042', qr: null };
  const before = JSON.stringify(status);
  const loaded = runInNewContext(maps + '\n' + channelRendering + '\n' + connection + '\n({connectChannel})', {
    ...f.globals, $: selector => selector === '#modal' ? modal : f.panel,
    tenantApi: path => '/api/tenants/company-a/' + path, openModal() {}, refresh: async () => {}, render() {},
    api: async (path, options) => { calls.push({ path, options }); return options ? {} : status; }, clearTimeout() {}, setTimeout() { assert.fail('Terminal state must not start a new poll.'); }
  });
  locale('en'); await loaded.connectChannel('wa-a');
  assert.match(f.panel.innerHTML, /<strong>Test number · ending 0042<\/strong>/);
  assert.equal(calls[0].path, '/api/tenants/company-a/channels/wa-a/connect');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[1].path, '/api/tenants/company-a/channels/wa-a/connection'); assert.equal(JSON.stringify(status), before);
});

test('error toasts translate canonical send failures and neutralize unknown errors while normal data stays intact', () => {
  // toast() delegates to the two live regions of ui.js (FRONTEND-V2 §4.1): errors go to #toast-alert
  // (role=alert, persistent) and everything else to #toast (role=status).
  const shown = [], last = () => shown.at(-1);
  const { toast } = runInNewContext(toastSource + '\n({toast})', { ...i18n, toasts: { show: options => { shown.push({ ...options }); return 'toast-id'; } } });
  locale('en'); assert.equal(toast('Atualize o atendimento antes de enviar.', true), undefined); assert.deepEqual(last(), { message: 'Refresh the conversation before sending.', tone: 'error' });
  toast('Não foi possível preparar este envio.', true); assert.deepEqual(last(), { message: 'This send could not be prepared.', tone: 'error' });
  toast('Falha privada desconhecida <identificador>', true); assert.deepEqual(last(), { message: 'Unable to complete this action. Please try again.', tone: 'error' });
  toast('Bot aguardando conexão'); assert.deepEqual(last(), { message: 'Bot aguardando conexão', tone: 'info' });
  toast('Atualize o atendimento antes de enviar.'); assert.deepEqual(last(), { message: 'Atualize o atendimento antes de enviar.', tone: 'info' });
  locale('pt-BR'); toast('Atualize o atendimento antes de enviar.', true); assert.deepEqual(last(), { message: 'Atualize o atendimento antes de enviar.', tone: 'error' });
  assert.equal(shown.length, 6);
});
