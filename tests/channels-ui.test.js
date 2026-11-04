import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelsUI, lastConversationByChannel } from '../public/channels-ui.js';
import { setLocale, t } from '../public/i18n.js';
import { parseHash } from '../public/router.js';

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

const qr = (more = {}) => ({ id: 'wa-1', name: 'Número pessoal', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', label: 'Número de teste · final 4321', ...more });
function uiFor(channels, role = 'reseller', permissions = null) {
  return createChannelsUI({ state: { workspaceId: 'w-1', boot: { session: { role, permissions, userId: 'u-1' } }, tenant: { id: 't-1', name: 'Empresa QA', channels, conversations: [] } } });
}
const route = (params = {}) => ({ section: 'channels', params });
const cardMarkup = (ui, id) => new RegExp(`<li class="pg-channels__card" data-channel-card="${id}"[^>]*>([\\s\\S]*?)</li>`).exec(ui.view(route()))?.[1] || '';

test('canal abre seu histórico autorizado diretamente, inclusive offline, sem supor propósito ou envio', () => {
  for (const role of ['reseller', 'operator']) for (const state of ['connected', 'logged_out']) {
    const html = cardMarkup(uiFor([qr({ state })], role), 'wa-1');
    const href = /href="([^"]+)" data-channel-conversations="wa-1"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
    const route = parseHash(href);
    assert.equal(route.section, 'inbox'); assert.equal(route.workspaceId, 'w-1');
    assert.deepEqual(route.query, { tenant: 't-1', channel: 'wa-1' });
    assert.match(html, /Abrir conversas de Número pessoal em Empresa QA/);
    assert.doesNotMatch(html, /data-action="channels:start"|data-action="send-message"/);
  }
  assert.doesNotMatch(cardMarkup(uiFor([qr()], 'operator', []), 'wa-1'), /data-channel-conversations/);
  assert.doesNotMatch(cardMarkup(uiFor([qr({ id: 'bad id' })]), 'bad id'), /data-channel-conversations/);
  setLocale('en', { persist: false, notify: false });
  assert.match(cardMarkup(uiFor([qr()]), 'wa-1'), /Open conversations from Número pessoal in Empresa QA/);
  assert.match(cardMarkup(uiFor([qr()]), 'wa-1'), />Open conversations</);
});

test('retry agendado e aviso de frescura têm PT/EN sem oferecer conexão duplicada', () => {
  for (const [language, title, stale, code] of [
    ['pt-BR', 'Retentativa agendada', 'Não foi possível atualizar esta conexão; verificando novamente.', 'O código exibido pode estar desatualizado.'],
    ['en', 'Retry scheduled', 'Could not refresh this connection; checking again.', 'The displayed code may be out of date.']
  ]) {
    setLocale(language, { persist: false, notify: false });
    const ui = uiFor([qr({ state: 'failed', nextRetryAt: new Date(Date.now() + 60000).toISOString() })]);
    const markup = ui.view(route({ channelId: 'wa-1', tab: 'connect' }));
    assert.ok(markup.includes(title)); assert.doesNotMatch(markup, /data-action="channels:start"/);
    assert.equal(t('Não foi possível atualizar esta conexão; verificando novamente.'), stale);
    assert.ok(t('O código exibido pode estar desatualizado. Aguarde a próxima verificação.').startsWith(code));
  }
});

test('atividade do canal usa mensagem pública e não leitura, nota ou recibo', () => {
  const first = '2026-10-06T12:00:00Z', newest = '2026-10-07T12:00:00Z';
  const rows = [
    { channelId: 'wa-1', lastMessageAt: first, updatedAt: '2026-10-08T18:00:00Z' },
    { channelId: 'wa-1', lastMessageAt: newest, updatedAt: '2026-10-07T12:00:00Z' },
    { channelId: 'tg-1', lastMessageAt: first, updatedAt: '2026-10-08T18:00:00Z' }
  ];
  assert.deepEqual([...lastConversationByChannel(rows)], [['wa-1', Date.parse(newest)], ['tg-1', Date.parse(first)]]);
  rows[0].updatedAt = '2026-10-09T20:00:00Z';
  assert.equal(lastConversationByChannel(rows).get('wa-1'), Date.parse(newest));
});

test('fallback de atividade legado vale somente quando lastMessageAt está ausente', () => {
  const date = '2026-10-07T12:00:00Z';
  const rows = [
    { channelId: 'legacy', updatedAt: date },
    ...[null, undefined, '', 'inválido'].map((lastMessageAt, index) => ({ channelId: `empty-${index}`, lastMessageAt, updatedAt: date })),
    { updatedAt: date }, null
  ];
  assert.deepEqual([...lastConversationByChannel(rows)], [['legacy', Date.parse(date)]]);
  assert.equal(lastConversationByChannel(null).size, 0);
});

test('WhatsApp mostra somente o final público e o estado factual, sem inferir propósito pelo nome', () => {
  for (const name of ['Número pessoal', 'Agência', 'Número de teste']) {
    const markup = cardMarkup(uiFor([qr({ name })]), 'wa-1');
    assert.match(markup, /Número conectado · final 4321/);
    assert.doesNotMatch(markup, /Número de teste · final/);
    assert.match(markup, new RegExp(`<h3 class="pg-channels__name">${name}</h3>`));
    assert.match(markup, /data-action="channels:open"/);
    assert.match(markup, /data-action="channels:groups"/);
    assert.match(markup, /data-action="channels:agenda"/);
  }
  assert.match(cardMarkup(uiFor([qr({ state: 'logged_out' })]), 'wa-1'), /Número cadastrado · final 4321/);
  assert.match(cardMarkup(uiFor([qr({ label: 'Identificação manual' })]), 'wa-1'), /Identificação manual/);
});

test('Telegram não repete username já contido na identificação e normaliza um prefixo @', () => {
  for (const label of ['@empresa_bot', 'Bot @empresa_bot']) {
    const markup = cardMarkup(uiFor([{ id: 'tg-1', name: 'Telegram', kind: 'telegram', transport: 'telegram-bot', state: 'connected', label, botUsername: '@empresa_bot' }]), 'tg-1');
    assert.equal((markup.match(/@empresa_bot/g) || []).length, 1);
  }
  const markup = cardMarkup(uiFor([{ id: 'tg-1', name: 'Telegram', kind: 'telegram', transport: 'telegram-bot', state: 'connected', label: '', botUsername: 'empresa_bot' }]), 'tg-1');
  assert.equal((markup.match(/@empresa_bot/g) || []).length, 1);
});

test('formulário QR explica empresa e acesso e mantém aviso do número esperado', () => {
  const markup = uiFor([]).view(route({ kind: 'whatsapp_qr' }));
  assert.match(markup, /As mensagens deste número entram nesta empresa/);
  assert.match(markup, /Em Equipe, confira as permissões; administradores da conta têm acesso a todas as empresas/);
  assert.match(markup, /aria-describedby="channels-number-hint channels-access-hint"/);
  assert.match(markup, /O QR só é aceito quando lido por este número/);
  assert.doesNotMatch(uiFor([]).view(route({ kind: 'telegram' })), /id="channels-access-hint"/);
});

test('gaveta conectada usa a mesma identificação factual e atendente só recebe Ver conexão', () => {
  assert.match(uiFor([qr()]).view(route({ channelId: 'wa-1', tab: 'connect' })), /Número conectado · final 4321/);
  const markup = cardMarkup(uiFor([qr()], 'operator'), 'wa-1');
  assert.match(markup, /data-action="channels:open"/);
  assert.doesNotMatch(markup, /data-action="channels:(groups|agenda)"/);
});

test('agente e respostas: só o administrador vê agente padrão, perfil de respostas e conversas de equipe/QA', () => {
  const channel = qr({ defaultAgentId: 'agent-1', replyPolicy: { profile: 'assistant', perHour: 90, perMinute: 9, notice: 'Já volto <já>' } });
  const ui = createChannelsUI({ state: { workspaceId: 'w-1', boot: { session: { role: 'reseller', userId: 'u-1' } }, tenant: { id: 't-1', name: 'Empresa QA', channels: [channel],
    agents: [{ id: 'agent-1', name: 'Agente FC', provider: 'mcp', mode: 'copilot', configured: true }, { id: 'h-1', name: 'Hermes interno', provider: 'hermes', mode: 'copilot', configured: true }],
    conversations: [{ id: 'c-1', channelId: 'wa-1', contact: 'Jean <QA>', conversationKind: 'direct', replyExempt: true }, { id: 'g-1', channelId: 'wa-1', contact: 'Grupo', conversationKind: 'group' }] } } });
  const markup = cardMarkup(ui, 'wa-1');
  for (const value of ['Agente e respostas', 'Agente padrão: Agente FC', 'Assistente de produto', 'data-channel-default-agent="wa-1"', 'value="agent-1" selected', 'value="90"', 'value="9"',
    'Já volto &lt;já&gt;', 'data-reply-exempt="c-1" checked', 'Jean &lt;QA&gt;', 'data-channel-reply-policy="wa-1"']) assert.ok(markup.includes(value), value);
  assert.equal(markup.includes('Hermes interno'), false, 'only connected MCP agents can be the default agent');
  assert.equal(markup.includes('data-reply-exempt="g-1"'), false, 'groups are never team/QA conversations');
  assert.equal(cardMarkup(uiFor([qr()], 'operator'), 'wa-1').includes('Agente e respostas'), false);
});
