// Inbox list v2 (FRONTEND-V2 §5.2.2, §8.4; P3): keyed rows that survive the polls with their focus,
// frozen order under the pointer or the focus with the "↑ N novas conversas" pill, focus that never
// opens (j/k) and Enter that opens, lenses and filters, empty states and the owner=agent alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, FakeEvent } from './helpers/inbox-dom.js';
import * as i18n from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import { inboxListMarkup, createInboxList, inboxRowMarkup, inboxEmptyMarkup, inboxFiltersMarkup, autopilotOn, defaultLens, filtersActive, rowId, inboxFooterMarkup, inboxFilterCount, setInboxFiltersOpen } from '../public/inbox-list-ui.js';
import { dispatchAction, registerActions } from '../public/actions.js';
import { readFileSync } from 'node:fs';
import { cssRules, parseCss } from './helpers/css-tree.js';
import { runInNewContext } from './helpers/modal-route-adapter.js';
import { excerpt } from './helpers/app-source.js';
import { inboxChoice } from '../public/consolidated-inbox-ui.js';
import { hashForView } from '../public/nav-config.js';

const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
const item = (id, overrides = {}) => ({ tenantId: 't1', tenantName: 'Loja Centro', id, conversationId: id, contact: `Contato ${id}`, channelId: 'ch1', channelName: 'WhatsApp Vendas', channelKind: 'whatsapp_qr', owner: 'queue', status: 'open', unread: 0, updatedAt: '2026-10-06T10:00:00Z', preview: { text: `Prévia ${id}` }, ...overrides });
const data = (items, more = {}) => ({ workspaceId: 'w', items, total: items.length, offset: 0, limit: 50, hasMore: false, tenants: [{ id: 't1', name: 'Loja Centro' }], channels: [{ tenantId: 't1', id: 'ch1', name: 'WhatsApp Vendas', state: 'connected' }], departments: [], assignees: [], countTabs: { all: items.length, mine: 0, queue: items.length, agent: 0 }, counts: { closed: 3 }, ...more });
const filters = (more = {}) => ({ inboxCompany: 'all', channel: 'all', department: 'all', assignedUser: 'all', filter: 'all', status: 'active', kind: 'all', sort: 'recent', search: '', unread: false, ...more });
const options = (items, more = {}) => ({ data: data(items), filters: filters(), workspaceId: 'w', userId: 'u', tenants: [{ id: 't1', name: 'Loja Centro', brand: { accent: '#e11d48' } }], ...more });

function mount(initial) {
  const doc = createDocument(String(inboxListMarkup(initial)));
  const opened = [];
  const list = createInboxList({ doc, onOpen: (tenantId, conversationId) => opened.push([tenantId, conversationId]), motion: () => false });
  const box = () => doc.getElementById('conversation-items');
  const rows = () => box().children.map(node => node.id);
  const key = (target, name) => { const event = new FakeEvent('keydown', { key: name, target }); list.keydown(event); return event; };
  return { doc, list, box, rows, opened, key };
}

test('o mesmo nó de linha sobrevive a 3 polls, com o foco, e só o conteúdo muda', () => {
  const first = options([item('a'), item('b'), item('c')]);
  const f = mount(first);
  list: {
    const before = f.box().children.slice(), focused = f.doc.getElementById(rowId(item('b')));
    focused.focus();
    for (const count of [1, 2, 3]) {
      const result = f.list.patch(options([item('a'), item('b', { unread: count, preview: { text: `Mensagem nova ${count}` } }), item('c')]));
      assert.ok(result, 'a lista está na tela');
    }
    assert.deepEqual(f.box().children, before, 'nenhuma linha foi recriada');
    assert.ok(f.doc.activeElement === focused, 'o foco continua na mesma linha');
    assert.match(focused.textContent, /Mensagem nova 3/); assert.match(focused.innerHTML, /3 mensagens não lidas/);
    assert.equal(focused.getAttribute('data-state'), 'unread'); assert.equal(focused.getAttribute('tabindex'), '0', 'a linha focada guarda a parada de tabulação');
    break list;
  }
  assert.equal(f.box().getAttribute('role'), 'listbox'); assert.equal(f.box().children.every(node => node.getAttribute('role') === 'option'), true);
});

test('com o ponteiro ou o foco na lista a ordem congela e a pílula conta as novas; Enter na pílula aplica', () => {
  const f = mount(options([item('a'), item('b')]));
  f.box().__hover = true;
  f.list.patch(options([item('new'), item('b'), item('a')]));
  assert.deepEqual(f.rows(), [rowId(item('a')), rowId(item('b'))], 'nada se move sob o ponteiro');
  const pill = f.doc.querySelector('[data-inbox-pill]');
  assert.equal(pill.hidden, false); assert.equal(pill.querySelector('[data-inbox-pill-label]').textContent, '1 nova conversa'); assert.deepEqual(f.list.pending, [rowId(item('new'))]);
  f.list.patch(options([item('new'), item('new2'), item('b'), item('a')]));
  assert.equal(pill.querySelector('[data-inbox-pill-label]').textContent, '2 novas conversas');
  f.box().__hover = false;
  f.key(pill, 'Enter');
  assert.deepEqual(f.rows(), [rowId(item('new')), rowId(item('new2')), rowId(item('b')), rowId(item('a'))]);
  assert.equal(pill.hidden, true); assert.ok(f.doc.activeElement === f.doc.getElementById(rowId(item('new'))), 'o foco vai para o topo aplicado');
  // Focus inside the list freezes the order as well.
  f.doc.getElementById(rowId(item('b'))).focus();
  f.list.patch(options([item('a'), item('b'), item('new'), item('new2')]));
  assert.deepEqual(f.rows(), [rowId(item('new')), rowId(item('new2')), rowId(item('b')), rowId(item('a'))], 'o foco também congela');
  f.doc.body.focus();
  f.list.patch(options([item('a'), item('b'), item('new'), item('new2')]));
  assert.deepEqual(f.rows(), [rowId(item('a')), rowId(item('b')), rowId(item('new')), rowId(item('new2'))], 'sem ponteiro nem foco, a ordem do servidor vale');
});

test('uma lente ou filtro escolhido pela pessoa aplica na hora, mesmo com o ponteiro na lista', () => {
  const f = mount(options([item('a'), item('b')]));
  f.box().__hover = true;
  f.list.patch({ ...options([item('a'), item('b')], { filters: filters({ unread: true }) }), loading: true });
  f.list.patch(options([item('z', { unread: 2 })], { filters: filters({ unread: true }) }));
  assert.deepEqual(f.rows(), [rowId(item('z'))]); assert.equal(f.doc.querySelector('[data-inbox-pill]').hidden, true);
});

test('j/k e as setas só movem o foco; Enter (ou o) abre e só então a conversa é aberta', () => {
  const f = mount(options([item('a'), item('b'), item('c')]));
  const a = f.doc.getElementById(rowId(item('a')));
  a.focus();
  assert.equal(f.key(a, 'j').defaultPrevented, true);
  assert.ok(f.doc.activeElement === f.doc.getElementById(rowId(item('b'))));
  f.key(f.doc.activeElement, 'ArrowDown'); assert.ok(f.doc.activeElement === f.doc.getElementById(rowId(item('c'))));
  f.key(f.doc.activeElement, 'k'); f.key(f.doc.activeElement, 'Home');
  assert.ok(f.doc.activeElement === a); assert.deepEqual(f.opened, [], 'mover o foco nunca abre');
  assert.equal(a.getAttribute('aria-selected'), 'false', 'foco não é seleção');
  f.key(f.doc.activeElement, 'End'); f.key(f.doc.activeElement, 'Enter');
  assert.deepEqual(f.opened, [['t1', 'c']]);
  f.key(a, 'o'); assert.deepEqual(f.opened.at(-1), ['t1', 'a']);
  const tabbable = f.box().children.filter(node => node.getAttribute('tabindex') === '0');
  assert.equal(tabbable.length, 1, 'uma única parada de tabulação (roving tabindex)');
  const search = f.doc.getElementById('conversation-search');
  assert.equal(f.list.keydown(new FakeEvent('keydown', { key: 'j', target: search })), false, 'teclas da lista não agem em campos');
  assert.equal(f.list.keydown(new FakeEvent('keydown', { key: 'Enter', target: a, ctrlKey: true })), false);
});

test('linha: avatar com selo do canal, monograma e nome da empresa, prévia escapada e chips só quando pedem ação', () => {
  const row = String(inboxRowMarkup(item('x', { contact: '<img onerror=x>', preview: { text: '<script>bad</script>' }, unread: 120, owner: 'agent', agentId: 'ag', channelState: 'logged_out', channelTransport: 'baileys' }), {
    selection: { workspaceId: 'w', tenantId: 't1', conversationId: 'x' }, workspaceId: 'w', userId: 'u', tenants: [{ id: 't1', name: 'Loja Centro' }],
    agents: () => [{ id: 'ag', name: 'Assistente', provider: 'hermes', configured: true, autopilot: { enabled: false, channelIds: [] } }], hasDraft: () => true, listGlyph: () => '<span class="glyph-p4">✦</span>'
  }));
  assert.match(row, /role="option" id="row-t1-x"/); assert.match(row, /aria-selected="true"/); assert.match(row, /data-channel="whatsapp_qr"/);
  assert.match(row, /ui-company__mark/); assert.match(row, /Loja Centro/); assert.match(row, /&lt;img onerror=x&gt;/); assert.doesNotMatch(row, /<script>/);
  assert.match(row, /99\+/); assert.match(row, /Sem resposta automática/); assert.match(row, /Canal desconectado/); assert.match(row, /Rascunho seu salvo/); assert.match(row, /glyph-p4/);
  const plain = String(inboxRowMarkup(item('y'), { workspaceId: 'w', tenants: [] }));
  assert.doesNotMatch(plain, /pg-inbox__chip/, 'sem chips quando nada pede ação');
});

test('linha mantém empresa e canal distintos, tira só o prefixo exato e põe a leitura junto ao horário', () => {
  const row = entry => createDocument(String(inboxRowMarkup(entry, { tenants: [{ id: 't1', name: 'Loja Centro' }] })));
  const doc = row(item('compact', { channelName: 'Loja Centro · Pessoal', unread: 3 }));
  assert.equal(doc.querySelector('.ui-company__name').textContent, 'Loja Centro');
  assert.equal(doc.querySelector('.pg-inbox__row-channel').textContent, 'Pessoal');
  assert.equal(doc.querySelector('.pg-inbox__row-channel').getAttribute('title'), 'Loja Centro · Pessoal');
  const activity = doc.querySelector('.pg-inbox__row-activity');
  assert.ok(activity.querySelector('time'));
  assert.match(activity.querySelector('.pg-inbox__row-unread').textContent, /3 mensagens não lidas/);
  assert.equal(doc.querySelector('.pg-inbox__row-meta').querySelector('.pg-inbox__row-unread'), null, 'leitura não é um estado de atendimento');
  for (const channelName of ['Loja Centro Norte · Pessoal', 'Outra empresa · Pessoal', 'loja centro · Pessoal', 'Loja Centro · ']) {
    assert.equal(row(item('exact', { channelName })).querySelector('.pg-inbox__row-channel').textContent, channelName, 'sem inferência por nome parecido');
  }
  const other = row(item('other', { tenantId: 't2', tenantName: 'Outra empresa', channelName: 'Outra empresa · Agência' }));
  assert.equal(other.querySelector('.ui-company__name').textContent, 'Outra empresa');
  assert.equal(other.querySelector('.pg-inbox__row-channel').textContent, 'Agência', 'usa a empresa da própria linha');
});

test('fotos da lista usam a empresa de cada linha, preservando fallback, selo do canal e referências escapadas', () => {
  for (const [transport, kind, group] of [['baileys', 'whatsapp_qr', false], ['telegram-bot', 'telegram', true]]) {
    const row = String(inboxRowMarkup(item('same', { tenantId: 'tenant-b', channelTransport: transport, channelKind: kind, conversationKind: group ? 'group' : 'direct' }), { workspaceId: 'w' }));
    const doc = createDocument(row), photo = doc.querySelector('.ui-avatar');
    assert.equal(photo.dataset.avatarTenant, 'tenant-b'); assert.equal(photo.dataset.avatarKind, 'conversations');
    assert.equal(photo.dataset.avatarId, 'same'); assert.equal(photo.dataset.channel, kind);
    assert.ok(photo.querySelector(group ? '.ui-avatar__stack' : '.ui-avatar__initials'), 'fallback permanece');
    assert.ok(photo.querySelector('.ui-avatar__channel'), 'selo permanece'); assert.equal(photo.querySelector('img'), null);
  }
  const unsafe = String(inboxRowMarkup(item('id" onclick="bad', { tenantId: 'tenant" title="bad', channelTransport: 'baileys' })));
  assert.match(unsafe, /data-avatar-id="id&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(unsafe, /\sonclick="bad"/);
  for (const channelTransport of ['elozi-webchat', 'mepmail-channel', 'meta-instagram', 'meta-messenger', null]) {
    const row = String(inboxRowMarkup(item('same', { channelTransport })));
    assert.doesNotMatch(row, /data-avatar-(?:kind|tenant|id)/, 'transporte sem foto de perfil não consulta a API');
  }
});

test('patch de linha mantém referência de foto inalterada; mudar empresa cria a referência da empresa correta', () => {
  const first = item('same', { channelTransport: 'baileys' }), f = mount(options([first]));
  const row = f.doc.getElementById(rowId(first));
  f.list.patch(options([{ ...first, unread: 1, version: 2 }]));
  assert.equal(f.doc.getElementById(rowId(first)), row);
  assert.equal(row.querySelector('.ui-avatar').dataset.avatarTenant, 't1');
  const other = { ...first, tenantId: 't2', tenantName: 'Outra empresa' };
  f.list.patch(options([other]));
  assert.equal(f.doc.getElementById(rowId(first)), null);
  assert.equal(f.doc.getElementById(rowId(other)).querySelector('.ui-avatar').dataset.avatarTenant, 't2');
});

test('owner=agent: piloto automático só com autopilot ligado no canal; desconhecido é "Com agente", nunca falso', () => {
  const agent = { id: 'ag', provider: 'hermes', configured: true, autopilot: { enabled: true, channelIds: ['ch1'] } };
  assert.equal(autopilotOn(agent, 'ch1'), true); assert.equal(autopilotOn(agent, 'other'), false);
  assert.equal(autopilotOn({ ...agent, configured: false }, 'ch1'), false); assert.equal(autopilotOn({ id: 'ag', provider: 'hermes', configured: true }, 'ch1'), false);
  assert.equal(autopilotOn(null, 'ch1'), null);
  const chip = agents => String(inboxRowMarkup(item('x', { owner: 'agent', agentId: 'ag' }), { workspaceId: 'w', tenants: [], agents }));
  assert.match(chip(() => [agent]), /✦ Piloto automático/);
  assert.match(chip(() => [{ ...agent, autopilot: { enabled: false, channelIds: [] } }]), /Sem resposta automática/);
  assert.match(chip(() => null), /✦ Com agente/, 'empresa nunca aberta nesta aba: sem afirmar o que não sabe');
});

test('horário da linha acompanha a última mensagem e permanece ao atualizar leitura e estado operacional', () => {
  const initial = item('old', { lastMessageAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z', unread: 3 });
  const f = mount(options([initial]));
  const date = () => f.doc.getElementById(rowId(initial)).querySelector('time');
  const original = date().textContent;
  assert.equal(date().getAttribute('datetime'), initial.lastMessageAt);
  f.list.patch(options([{ ...initial, updatedAt: '2026-10-08T12:00:00Z', unread: 0, version: 3 }]));
  assert.equal(date().getAttribute('datetime'), initial.lastMessageAt); assert.equal(date().textContent, original);
  f.list.patch(options([{ ...initial, lastMessageAt: '2026-10-04T10:00:00Z', updatedAt: '2026-10-08T13:00:00Z' }]));
  assert.equal(date().getAttribute('datetime'), '2026-10-04T10:00:00Z'); assert.notEqual(date().textContent, original);
});

test('data ausente explícita fica vazia; snapshot legado prefere data da prévia e aceita relógio antigo', () => {
  const time = entry => createDocument(String(inboxRowMarkup(entry))).querySelector('time');
  const empty = time(item('empty', { lastMessageAt: null }));
  assert.equal(empty.getAttribute('datetime'), null); assert.equal(empty.textContent, '');
  const legacy = item('legacy', { preview: { text: 'Mensagem antiga', createdAt: '2026-10-02T10:00:00Z' } });
  assert.equal(time(legacy).getAttribute('datetime'), legacy.preview.createdAt);
  assert.equal(time(item('old-server')).getAttribute('datetime'), item('old-server').updatedAt);
});

test('estados vazios do §5.2.3, por papel e por lente', () => {
  const empty = more => String(inboxEmptyMarkup({ data: data([]), filters: filters(), ...more }));
  assert.match(empty({ filters: filters({ search: 'x' }) }), /Nenhum atendimento com estes filtros\.[\s\S]*Limpar filtros/);
  const noChannel = { data: data([], { channels: [{ tenantId: 't1', id: 'ch1', state: 'disconnected' }] }) };
  assert.match(empty({ ...noChannel, canManageChannels: true }), /Nenhum canal conectado\.[\s\S]*Conecte o WhatsApp ou o webchat[\s\S]*Conectar canal/);
  assert.match(empty(noChannel), /Peça ao administrador para conectar um canal\./); assert.doesNotMatch(empty(noChannel), /Conectar canal/);
  // A new account that opened Grupos first: with no channel connected, "connect a channel" wins over "no results with these filters".
  assert.match(empty({ ...noChannel, filters: filters({ kind: 'group' }), canManageChannels: true }), /Nenhum canal conectado\./); assert.doesNotMatch(empty({ ...noChannel, filters: filters({ kind: 'group' }) }), /estes filtros/);
  assert.match(empty({ filters: filters({ filter: 'queue' }) }), /Fila zerada\.[\s\S]*Ninguém esperando agora\./);
  assert.match(empty({}), /Tudo pronto\.[\s\S]*As conversas aparecem aqui assim que um cliente escrever\./);
  const f = mount(options([], { canManageChannels: true }));
  assert.equal(f.box().hidden, true); assert.equal(f.doc.querySelector('[data-inbox-empty]').hidden, false);
  f.list.patch(options([item('a')]));
  assert.equal(f.box().hidden, false); assert.equal(f.doc.querySelector('[data-inbox-empty]').hidden, true); assert.deepEqual(f.rows(), [rowId(item('a'))]);
});

test('lentes com contagem do servidor, Grupos e Não lidas como filtros, Carregar mais até 200 e páginas depois', () => {
  const markup = String(inboxListMarkup(options([item('a')], { filters: filters({ kind: 'group', unread: true }) })));
  assert.match(markup, /data-filter="all" aria-pressed="true">Todos<span class="pg-inbox__lens-count" data-inbox-count="all">1</);
  assert.match(markup, /data-action="inbox:toggle-groups" aria-pressed="true"/); assert.match(markup, /data-action="inbox:toggle-unread" aria-pressed="true"/);
  assert.match(String(inboxFooterMarkup({ data: data([item('a')], { total: 120, hasMore: true }) })), /1–1 de 120[\s\S]*data-action="inbox:load-more"/);
  const capped = String(inboxFooterMarkup({ data: data(Array.from({ length: 200 }, (_, index) => item(`r${index}`)), { total: 260, hasMore: true }) }));
  // Past 200 loaded rows the list pages by 200: every conversation stays reachable (no dead end).
  assert.doesNotMatch(capped, /inbox:load-more/); assert.match(capped, /data-action="inbox:next-page"[\s\S]*Próxima página/); assert.doesNotMatch(capped, /inbox:previous-page|Refine os filtros/);
  const second = String(inboxFooterMarkup({ data: data(Array.from({ length: 60 }, (_, index) => item(`s${index}`)), { total: 260, offset: 200, limit: 200, hasMore: false }) }));
  assert.match(second, /201–260 de 260/); assert.match(second, /data-action="inbox:previous-page"[\s\S]*Página anterior/); assert.doesNotMatch(second, /inbox:next-page|inbox:load-more/);
  const middle = String(inboxFooterMarkup({ data: data(Array.from({ length: 200 }, (_, index) => item(`m${index}`)), { total: 450, offset: 200, limit: 200, hasMore: true }) }));
  assert.match(middle, /201–400 de 450[\s\S]*inbox:previous-page[\s\S]*inbox:next-page/);
  assert.equal(filtersActive(filters()), false); assert.equal(filtersActive(filters({ kind: 'group' })), true);
  assert.equal(defaultLens({ role: 'operator' }), 'mine'); assert.equal(defaultLens({ role: 'reseller' }), 'all');
});

test('a lista que esvazia com o foco numa linha entrega o foco ao próximo passo, nunca ao body', () => {
  const f = mount(options([item('a', { owner: 'human', assignedUserId: 'u' })], { filters: filters({ filter: 'mine' }) }));
  f.doc.getElementById(rowId(item('a'))).focus();
  f.list.patch(options([], { filters: filters({ filter: 'mine' }) }));
  assert.equal(f.box().hidden, true);
  assert.notEqual(f.doc.activeElement, f.doc.body, 'o foco não cai no body');
  assert.equal(f.doc.activeElement.getAttribute('data-action'), 'inbox:lens-queue', 'Comigo vazio: o foco vai para "Ver a fila"');
  // Without an action in the empty state the focus goes to the active lens.
  const g = mount(options([item('b')], { filters: filters({ filter: 'agent' }) }));
  g.doc.getElementById(rowId(item('b'))).focus();
  g.list.patch(options([], { filters: filters({ filter: 'agent' }) }));
  assert.equal(g.doc.activeElement.getAttribute('data-filter'), 'agent');
});

test('Filtros abre a gaveta em desktop e celular, preserva seleções e devolve foco com Esc', async () => {
  const active = filters({ unread: true, kind: 'group', channel: JSON.stringify(['t1', 'ch1']) });
  const markup = String(inboxListMarkup(options([item('a')], { filters: active })));
  assert.match(markup, /<button type="button" class="pg-inbox__filters-toggle" data-action="inbox:filters" aria-controls="inbox-filters-panel" aria-expanded="false">[\s\S]*?<span>Filtros<\/span><span class="pg-inbox__filters-count" aria-hidden="true">3<\/span><span class="sr-only">3 filtros ativos<\/span><\/button>/);
  assert.match(markup, /<div class="pg-inbox__filters-panel" id="inbox-filters-panel" data-state="closed">[\s\S]*id="inbox-company-filter"[\s\S]*inbox:toggle-groups[\s\S]*id="sort-filter"[\s\S]*data-inbox-more/, 'filtros avançados mantêm os mesmos ids dentro da gaveta');
  assert.ok(markup.indexOf('pg-inbox__search') < markup.indexOf('pg-inbox__lenses') && markup.indexOf('pg-inbox__lenses') < markup.indexOf('pg-inbox__filters-toggle'), 'busca, lentes e o botão no fim da linha das lentes');
  assert.equal(inboxFilterCount(filters()), 0);
  assert.equal(inboxFilterCount(filters({ sort: 'oldest', status: 'all', assignedUser: 'u2', inboxCompany: 't1', department: 'unassigned' })), 5);
  assert.doesNotMatch(String(inboxListMarkup(options([item('a')]))), /pg-inbox__filters-count/, 'sem filtro ativo, sem contagem');
  const f = mount(options([item('a')], { filters: active }));
  const toggle = f.doc.querySelector('[data-action="inbox:filters"]'), panel = () => f.doc.getElementById('inbox-filters-panel');
  assert.equal(await dispatchAction('inbox:filters', toggle), true, 'ação registrada pelo módulo, sem app.js');
  assert.equal(panel().getAttribute('data-state'), 'open'); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  // A poll redraws the filter row: the drawer stays as the person left it.
  f.list.patch(options([item('a'), item('b')], { filters: active }));
  assert.equal(panel().getAttribute('data-state'), 'open'); assert.equal(f.doc.querySelector('[data-action="inbox:filters"]').getAttribute('aria-expanded'), 'true');
  const select = f.doc.getElementById('sort-filter'); select.focus();
  const event = new FakeEvent('keydown', { key: 'Escape', target: select });
  assert.equal(f.list.keydown(event), true);
  assert.equal(panel().getAttribute('data-state'), 'closed');
  assert.equal(f.doc.activeElement, f.doc.querySelector('[data-action="inbox:filters"]'), 'o foco volta ao botão Filtros');
  setInboxFiltersOpen(false, { doc: f.doc });
  // The advanced disclosure stays available on desktop too; channel and unread remain visible.
  const rules = cssRules(parseCss(readFileSync(new URL('../public/screen-inbox.css', import.meta.url), 'utf8')));
  const rule = (selector, media) => rules.find(entry => entry.selector === selector && (media ? entry.context.includes(media) : entry.context.length === 1));
  const value = (entry, property) => entry?.declarations.find(declaration => declaration.property === property)?.value;
  assert.equal(value(rule('.pg-inbox__filters-toggle'), 'display'), 'inline-flex'); assert.equal(value(rule('.pg-inbox__filters-panel'), 'display'), 'none');
  assert.equal(value(rule('.pg-inbox__filters-panel[data-state="open"]'), 'display'), 'grid');
  const narrow = '@media (max-width: 899.98px)';
  assert.equal(value(rule('.pg-inbox__filters-toggle', narrow), 'display'), 'inline-flex'); assert.equal(value(rule('.pg-inbox__filters-panel', narrow), 'display'), 'none');
  assert.equal(value(rule('.pg-inbox__filters-panel[data-state="open"]', narrow), 'display'), 'grid');
  assert.equal(value(rule('.pg-inbox__lenses', narrow), 'flex-wrap'), 'nowrap'); assert.equal(value(rule('.pg-inbox__lenses'), 'overflow-x'), 'auto');
  assert.equal(value(rule('.pg-inbox__filters-toggle', narrow), 'min-height'), 'var(--control-lg)', 'alvo de 44 px');
});

test('Canal e Não lidas ficam visíveis sem abrir filtros, únicos e estáveis durante os polls', () => {
  const selection = JSON.stringify(['t1', 'ch1']);
  const active = filters({ channel: selection, unread: true });
  const f = mount(options([item('a')], { filters: active }));
  const shortcuts = f.doc.querySelector('.pg-inbox__quick-filters');
  const panel = f.doc.getElementById('inbox-filters-panel');
  const channel = f.doc.getElementById('channel-filter');
  const unread = f.doc.querySelector('[data-action="inbox:toggle-unread"]');
  assert.equal(panel.getAttribute('data-state'), 'closed');
  assert.equal(panel.contains(channel), false); assert.equal(panel.contains(unread), false);
  assert.equal(shortcuts.contains(channel), true); assert.equal(shortcuts.contains(unread), true);
  assert.equal(f.doc.querySelectorAll('#channel-filter').length, 1);
  assert.equal(f.doc.querySelectorAll('[data-action="inbox:toggle-unread"]').length, 1);
  assert.equal(channel.querySelector('option[selected]').getAttribute('value'), selection); assert.equal(unread.getAttribute('aria-pressed'), 'true');
  assert.match(channel.textContent, /Loja Centro · WhatsApp Vendas/);
  channel.value = selection; // The DOM double does not derive a select's value from its options.
  channel.focus();
  f.list.patch(options([item('a', { unread: 0 })], { filters: { ...active, unread: false } }));
  assert.equal(f.doc.getElementById('channel-filter'), channel, 'select em uso não é recriado');
  assert.equal(f.doc.activeElement, channel); assert.equal(channel.value, selection);
  assert.equal(unread.getAttribute('aria-pressed'), 'false', 'atalho atualiza mesmo com foco no seletor');
  channel.blur();
  f.list.patch(options([item('a')], { filters: filters() }));
  assert.equal(f.doc.getElementById('channel-filter').querySelector('option[selected]').getAttribute('value'), 'all');
  assert.equal(f.doc.getElementById('inbox-filters-panel').getAttribute('data-state'), 'closed');
});

const channelButtons = doc => doc.querySelectorAll('[data-action="inbox:channel"]');
const channelButton = (doc,tenantId,id) => channelButtons(doc).find(node=>node.dataset.inboxChannel===JSON.stringify([tenantId,id]));
const authorizedChannels = [
  {tenantId:'t1',tenantName:'Loja Centro',id:'telegram',name:'Pessoal',kind:'telegram',state:'connected'},
  {tenantId:'t1',tenantName:'Loja Centro',id:'shared',name:'Loja Centro · Canal principal',kind:'whatsapp_qr',state:'connected'},
  {tenantId:'t2',tenantName:'Loja Norte',id:'shared',name:'Loja Norte · Suporte',kind:'whatsapp_cloud',state:'connected'},
  {tenantId:'t1',tenantName:'Loja Centro',id:'third',name:'Loja Centro · Outra linha',kind:'whatsapp_qr',state:'connected'}
];
const channelOptions = (active=filters(),channels=authorizedChannels) => options([item('a')],{filters:active,data:data([item('a')],{channels,tenants:[{id:'t1',name:'Loja Centro'},{id:'t2',name:'Loja Norte'}]}),tenants:[{id:'t1',name:'Loja Centro'},{id:'t2',name:'Loja Norte'}]});

test('os dois primeiros WhatsApps autorizados têm atalhos pelos nomes reais e demais canais ficam no seletor nativo',()=>{
  const doc=createDocument(String(inboxFiltersMarkup(channelOptions()))),buttons=channelButtons(doc),quick=doc.querySelector('.pg-inbox__quick-filters'),drawer=doc.getElementById('inbox-filters-panel'),select=doc.getElementById('channel-filter');
  assert.equal(buttons.length,2);assert.deepEqual(buttons.map(node=>JSON.parse(node.dataset.inboxChannel)),[['t1','shared'],['t2','shared']]);
  assert.match(buttons[0].textContent,/Canal principal/);assert.match(buttons[1].textContent,/Suporte/);assert.doesNotMatch(buttons.map(node=>node.textContent).join(' '),/Pessoal|Agência/,'sem inventar rótulos pelo nome, modelo ou responsável');
  const group=buttons[0].closest('[role="group"]');assert.ok(group);assert.ok(group.getAttribute('aria-label')?.trim(),'grupo de atalhos tem nome acessível');
  for(const node of [...buttons,select,doc.querySelector('[data-action="inbox:toggle-unread"]'),doc.querySelector('[data-action="inbox:toggle-pending"]')]){assert.ok(node);assert.equal(quick.contains(node),true);assert.equal(drawer.contains(node),false);}
  assert.equal(select.localName,'select');assert.deepEqual(select.querySelectorAll('option').map(node=>node.getAttribute('value')),['all',...authorizedChannels.map(channel=>JSON.stringify([channel.tenantId,channel.id]))]);
  assert.equal(doc.querySelectorAll('#channel-filter').length,1);assert.equal(buttons.every(node=>node.getAttribute('aria-pressed')==='false'),true);
});

test('atalhos escopam por empresa antes do limite e selecionam o par empresa/canal mesmo quando os ids coincidem',()=>{
  const selection=JSON.stringify(['t2','shared']),all=createDocument(String(inboxFiltersMarkup(channelOptions(filters({channel:selection})))));
  assert.equal(channelButton(all,'t1','shared').getAttribute('aria-pressed'),'false');assert.equal(channelButton(all,'t2','shared').getAttribute('aria-pressed'),'true');
  const scoped=createDocument(String(inboxFiltersMarkup(channelOptions(filters({inboxCompany:'t1',channel:JSON.stringify(['t1','third'])})))));
  assert.deepEqual(channelButtons(scoped).map(node=>JSON.parse(node.dataset.inboxChannel)),[['t1','shared'],['t1','third']]);assert.equal(channelButton(scoped,'t1','third').getAttribute('aria-pressed'),'true');
  assert.equal(channelButton(scoped,'t1','shared').textContent.includes('Loja Centro · '),false,'prefixo exato redundante é retirado');
  assert.equal(channelButtons(scoped).some(node=>JSON.parse(node.dataset.inboxChannel)[0]==='t2'),false);
  assert.deepEqual(scoped.getElementById('channel-filter').querySelectorAll('option').map(node=>node.getAttribute('value')),['all',JSON.stringify(['t1','telegram']),JSON.stringify(['t1','shared']),JSON.stringify(['t1','third'])]);
});

test('atalhos retiram só o prefixo exato da própria empresa e escapam nomes e referências maliciosas',()=>{
  for(const name of ['Loja Centro Norte · Linha real','loja centro · Linha real','Outra loja · Linha real','Loja Centro · ']){
    const doc=createDocument(String(inboxFiltersMarkup(channelOptions(filters({inboxCompany:'t1'}),[{...authorizedChannels[1],name}]))));
    assert.ok(channelButtons(doc)[0].textContent.includes(name),'nome semelhante ou prefixo vazio continua literal: '+name);
  }
  const unsafe={...authorizedChannels[1],tenantId:'t" onclick="bad',id:'ch" onfocus="bad',name:'Loja Centro · <img src=x onerror=bad><script>bad</script>'},doc=createDocument(String(inboxFiltersMarkup(channelOptions(filters(),[unsafe]))));
  const shortcut=channelButtons(doc)[0];assert.deepEqual(JSON.parse(shortcut.dataset.inboxChannel),[unsafe.tenantId,unsafe.id]);assert.ok(shortcut.textContent.includes('<img src=x onerror=bad><script>bad</script>'));
  assert.equal(doc.querySelector('img'),null);assert.equal(doc.querySelector('script'),null);assert.equal(doc.querySelector('[onclick]'),null);assert.equal(doc.querySelector('[onfocus]'),null);assert.equal(doc.querySelector('[onerror]'),null);
  const noWhatsApp=createDocument(String(inboxFiltersMarkup(channelOptions(filters(),[{...authorizedChannels[0],name:'WhatsApp Pessoal'}]))));assert.equal(channelButtons(noWhatsApp).length,0,'o nome não transforma outro tipo de canal em WhatsApp');assert.equal(noWhatsApp.getElementById('channel-filter').querySelectorAll('option').length,2);
});

test('atalhos de pendentes e não lidas representam os dois filtros independentes sem contar a página ou todos os status',()=>{
  for(const status of ['active','pending'])for(const unread of [false,true]){
    const configured=channelOptions(filters({status,unread}));configured.data.counts={closed:3,unread:987};configured.data.total=402;configured.data.items=[item('a',{unread:2,status:'pending'}),item('b',{unread:8,status:'closed'})];
    const doc=createDocument(String(inboxFiltersMarkup(configured))),pending=doc.querySelector('[data-action="inbox:toggle-pending"]'),unreadToggle=doc.querySelector('[data-action="inbox:toggle-unread"]');
    assert.equal(pending.getAttribute('aria-pressed'),String(status==='pending'));assert.equal(unreadToggle.getAttribute('aria-pressed'),String(unread));
    assert.match(pending.textContent,/Pendente/);assert.match(unreadToggle.textContent,/Não lidas/);assert.doesNotMatch(pending.textContent+unreadToggle.textContent,/987|402|\b10\b/,'sem contagem parcial ou de outros status');
    assert.equal(pending.querySelector('[data-inbox-count]'),null);assert.equal(unreadToggle.querySelector('[data-inbox-count]'),null);
  }
});

test('pendente lida, aberta não lida e pendente não lida mantêm sinalização operacional e leitura separadas',()=>{
  const readPending=item('pending-read',{status:'pending',unread:0}),unreadOpen=item('open-unread',{status:'open',unread:2}),unreadPending=item('pending-unread',{status:'pending',unread:3}),f=mount(options([readPending,unreadOpen,unreadPending]));
  const pending=f.doc.getElementById(rowId(readPending)),open=f.doc.getElementById(rowId(unreadOpen)),both=f.doc.getElementById(rowId(unreadPending));
  for(const node of [pending,both]){assert.equal(node.dataset.status,'pending');const chip=node.querySelector('.pg-inbox__chip--pending');assert.ok(chip);assert.match(chip.textContent,/Pendente/);assert.ok(chip.querySelector('[aria-hidden="true"]'),'ícone não depende apenas da cor');}
  assert.equal(pending.getAttribute('data-state'),null);assert.equal(pending.querySelector('.pg-inbox__row-unread'),null);assert.equal(open.querySelector('.pg-inbox__chip--pending'),null);assert.equal(open.dataset.state,'unread');assert.ok(open.querySelector('.pg-inbox__row-unread'));assert.ok(both.querySelector('.pg-inbox__row-unread'));
  const pendingNode=pending;pending.focus();f.list.patch(options([{...readPending,status:'open',unread:1},unreadOpen,unreadPending]));assert.equal(f.doc.getElementById(rowId(readPending)),pendingNode);assert.equal(f.doc.activeElement,pendingNode);assert.equal(pendingNode.querySelector('.pg-inbox__chip--pending'),null);assert.ok(pendingNode.querySelector('.pg-inbox__row-unread'));
  const rules=cssRules(parseCss(readFileSync(new URL('../public/screen-inbox.css',import.meta.url),'utf8'))),token=(selector,property)=>rules.find(rule=>rule.selector===selector)?.declarations.find(declaration=>declaration.property===property)?.value;
  assert.deepEqual([token('.pg-inbox__row-unread','background'),token('.pg-inbox__row-unread','color'),token('.pg-inbox__chip--pending','background'),token('.pg-inbox__chip--pending','color')],['var(--info-solid)','var(--on-solid)','var(--warning-bg)','var(--warning-text)'],'não lida usa azul informativo e pendente usa acompanhamento, independentes da marca');
});

test('patch atualiza os novos aria-pressed com foco dentro dos filtros sem trocar nós nem apagar o outro filtro',()=>{
  const f=mount(channelOptions()),first=channelButton(f.doc,'t1','shared'),second=channelButton(f.doc,'t2','shared'),pending=f.doc.querySelector('[data-action="inbox:toggle-pending"]'),unread=f.doc.querySelector('[data-action="inbox:toggle-unread"]'),select=f.doc.getElementById('channel-filter'),focused=unread.querySelector('.pg-inbox__toggle-dot');
  focused.focus();
  f.list.patch(channelOptions(filters({channel:JSON.stringify(['t2','shared']),status:'pending',unread:true})));
  assert.equal(f.doc.activeElement,focused);assert.equal(channelButton(f.doc,'t1','shared'),first);assert.equal(channelButton(f.doc,'t2','shared'),second);assert.equal(f.doc.getElementById('channel-filter'),select);assert.equal(f.doc.querySelector('[data-action="inbox:toggle-pending"]'),pending);assert.equal(f.doc.querySelector('[data-action="inbox:toggle-unread"]'),unread);
  assert.equal(first.getAttribute('aria-pressed'),'false');assert.equal(second.getAttribute('aria-pressed'),'true');assert.equal(pending.getAttribute('aria-pressed'),'true');assert.equal(unread.getAttribute('aria-pressed'),'true');
  assert.equal(select.value,JSON.stringify(['t2','shared']));assert.equal(f.doc.getElementById('conversation-status-filter').value,'pending');
  second.focus();f.list.patch(channelOptions(filters({channel:JSON.stringify(['t1','shared']),status:'active',unread:true})));
  assert.equal(f.doc.activeElement,second);assert.equal(channelButton(f.doc,'t2','shared'),second);assert.equal(first.getAttribute('aria-pressed'),'true');assert.equal(second.getAttribute('aria-pressed'),'false');assert.equal(pending.getAttribute('aria-pressed'),'false');assert.equal(unread.getAttribute('aria-pressed'),'true');
  assert.equal(select.value,JSON.stringify(['t1','shared']));assert.equal(f.doc.getElementById('conversation-status-filter').value,'active');
  pending.focus();f.list.patch(channelOptions(filters({channel:JSON.stringify(['t1','shared']),status:'pending',unread:false})));
  assert.equal(f.doc.activeElement,pending);assert.equal(f.doc.querySelector('[data-action="inbox:toggle-pending"]'),pending);assert.equal(pending.getAttribute('aria-pressed'),'true');assert.equal(unread.getAttribute('aria-pressed'),'false');
  select.focus();f.list.patch(channelOptions(filters({channel:JSON.stringify(['t2','shared']),status:'active',unread:false})));
  assert.equal(f.doc.activeElement,select);assert.equal(select.value,JSON.stringify(['t1','shared']),'seleção nativa em uso não é alterada por patch');
});

function inboxActionFixture(initial={}, {beforeRefresh=()=>{},onRegister=()=>{},listOnly=false}={}){
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('function changeInboxFilter('),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start);
  const state={workspaceId:'w',...filters({filter:'mine',kind:'group',...initial}),conversation:'own-chat',sendIntent:{id:'own-send'},model:'own-model'},f=mount(channelOptions(state)),requests=[],limits=[];let handlers;
  const replaced=[],routing=source.split('\n').filter(line=>line.startsWith('function currentRouteHash(')||line.startsWith('function syncInboxFilterHash(')).join('\n');
  state.view='inbox';if(listOnly){state.conversation=null;state.sendIntent=null;}
  runInNewContext(routing+'\n'+source.slice(start,end+2)+'\n'+excerpt('inbox-list-actions'),{state,inboxChoice,INBOX_PAGE:50,clearTimeout,hashForView,history:{state:null,replaceState:(_state,_title,hash)=>replaced.push(hash)},
    consolidatedInbox:{data:{channels:authorizedChannels},setLimit:value=>limits.push(value)},
    refreshInboxList:async()=>{requests.push({...state});await beforeRefresh();f.list.patch(channelOptions(state));},toast:()=>assert.fail('nenhuma falha de rede nesta fixture'),registerActions:value=>{handlers=value;onRegister(value);},showInboxEarlier(){}});
  return {...f,state,requests,limits,replaced,act:(name,element)=>handlers[name]({element})};
}

test('served list filter actions synchronize the real canonical hash without replacing a detail route',async()=>{
  const f=inboxActionFixture({}, {listOnly:true});
  await f.act('inbox:toggle-pending');await f.act('inbox:toggle-unread');
  await f.act('inbox:channel',{dataset:{inboxChannel:JSON.stringify(['t2','shared'])}});
  const query=parseHash(f.replaced.at(-1)).query;
  assert.equal(query.status,'pending');assert.equal(query.unread,'1');assert.equal(query.tenant,'t2');assert.equal(query.channel,'shared');
  assert.equal(f.replaced.length,3);
  const detail=inboxActionFixture();await detail.act('inbox:toggle-unread');assert.deepEqual(detail.replaced,[]);
});

test('ações servidas de Pendentes e Não lidas compõem os filtros sem mudar lente, conversa, envio ou modelo',async()=>{
  const f=inboxActionFixture(),pending=f.doc.querySelector('[data-action="inbox:toggle-pending"]'),unread=f.doc.querySelector('[data-action="inbox:toggle-unread"]'),send=f.state.sendIntent;
  await f.act('inbox:toggle-pending',pending);assert.equal(f.state.status,'pending');assert.equal(f.state.unread,false);
  await f.act('inbox:toggle-unread',unread);assert.equal(f.state.status,'pending');assert.equal(f.state.unread,true);
  await f.act('inbox:toggle-pending',pending);assert.equal(f.state.status,'active');assert.equal(f.state.unread,true);
  await f.act('inbox:toggle-unread',unread);assert.equal(f.state.status,'active');assert.equal(f.state.unread,false);
  assert.equal(f.requests.length,4);assert.equal(f.state.filter,'mine');assert.equal(f.state.kind,'group');assert.equal(f.state.conversation,'own-chat');assert.equal(f.state.sendIntent,send);assert.equal(f.state.model,'own-model');
});

test('ação servida de canal usa o par autorizado e recusa referência inválida ou revogada sem nova requisição',async()=>{
  const f=inboxActionFixture({status:'pending',unread:true}),first=channelButton(f.doc,'t1','shared'),second=channelButton(f.doc,'t2','shared');
  await f.act('inbox:channel',first);assert.equal(f.state.channel,JSON.stringify(['t1','shared']));assert.equal(f.state.inboxCompany,'t1');
  await f.act('inbox:channel',second);assert.equal(f.state.channel,JSON.stringify(['t2','shared']));assert.equal(f.state.inboxCompany,'t2');assert.equal(f.requests.length,2);
  assert.equal(f.state.status,'pending');assert.equal(f.state.unread,true);assert.equal(f.state.filter,'mine');
  const before={...f.state};for(const value of ['bad-json','null','[]',JSON.stringify(['t3','shared']),JSON.stringify(['t1','revoked'])]){
    const forged=f.doc.createElement('button');forged.dataset.inboxChannel=value;assert.equal(await f.act('inbox:channel',forged),false);assert.deepEqual(f.state,before);assert.equal(f.requests.length,2);
  }
});

function inboxClickFixture(t){
  const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
  const get=deferred(),mutation=deferred(),notices=[],mutations=[];let unregister;
  const f=inboxActionFixture({}, {beforeRefresh:()=>get.promise,onRegister:handlers=>{unregister=registerActions(handlers);}});t.after(()=>unregister?.());
  const app=f.doc.createElement('div');app.id='app';f.doc.body.append(app);app.append(f.doc.getElementById('inbox-list'));
  let click;app.addEventListener=(name,handler)=>{assert.equal(name,'click');click=handler;};
  runInNewContext(excerpt('app-click'),{state:f.state,document:f.doc,$:selector=>f.doc.querySelector(selector),mediaUI:{sending:false},platformUsersUI:{action:async()=>false},
    act:(name,id,element)=>{if(name==='conversation-close'){mutations.push(name);return mutation.promise;}return dispatchAction(name,element,null,id);},toast:(message,error)=>notices.push({message,error})});
  const watchDisabled=button=>{
    let disabled=button.disabled;const writes=[];
    // Browsers blur a focused button when it is disabled. Keep this browser effect local to the
    // wrapper regression instead of changing the shared RAM DOM used by unrelated UI tests.
    Object.defineProperty(button,'disabled',{configurable:true,get:()=>disabled,set:value=>{disabled=Boolean(value);writes.push(disabled);if(disabled&&f.doc.activeElement===button)f.doc.body.focus();}});
    return writes;
  };
  return {...f,notices,mutations,watchDisabled,click:button=>click(new FakeEvent('click',{target:button,bubbles:true,detail:0})),resolveGet:()=>get.resolve(),resolveMutation:()=>mutation.resolve(),rejectMutation:()=>mutation.reject(new Error('Own synthetic mutation failure'))};
}

for(const action of ['inbox:channel','inbox:toggle-unread','inbox:toggle-pending'])test('wrapper real preserva foco e nó do filtro '+action+' durante e após GET',async t=>{
  const f=inboxClickFixture(t),button=action==='inbox:channel'?channelButton(f.doc,'t1','shared'):f.doc.querySelector('[data-action="'+action+'"]'),writes=f.watchDisabled(button);button.focus();
  const pending=f.click(button);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.requests.length,1);assert.equal(button.disabled,false,'filtro GET continua utilizável enquanto a lista carrega');assert.equal(f.doc.activeElement,button);assert.equal(button.isConnected,true);assert.deepEqual(writes,[]);
  f.resolveGet();await pending;
  const current=action==='inbox:channel'?channelButton(f.doc,'t1','shared'):f.doc.querySelector('[data-action="'+action+'"]');
  assert.equal(current,button);assert.equal(f.doc.activeElement,button);assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-pressed'),'true');assert.deepEqual(writes,[]);assert.equal(f.mutations.length,0);
});

for(const outcome of ['success','failure'])test('wrapper real mantém atendimento mutante desabilitado durante await e restaura em '+outcome,async t=>{
  const f=inboxClickFixture(t),button=f.doc.createElement('button');button.dataset.action='conversation-close';f.doc.getElementById('app').append(button);const writes=f.watchDisabled(button);button.focus();
  const pending=f.click(button);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,true);assert.deepEqual(writes,[true]);assert.equal(f.requests.length,0);assert.deepEqual(f.mutations,['conversation-close']);
  if(outcome==='failure')f.rejectMutation();else f.resolveMutation();await pending;
  assert.equal(button.disabled,false);assert.deepEqual(writes,[true,false]);assert.equal(button.isConnected,true);
  assert.deepEqual(f.notices,outcome==='failure'?[{message:'Own synthetic mutation failure',error:true}]:[]);
});

test('#groups virou filtro da caixa (alias) e a lista funciona em EN', () => {
  assert.deepEqual({ section: parseHash('#groups').section, query: parseHash('#groups').query, alias: parseHash('#groups').alias }, { section: 'inbox', query: { kind: 'group' }, alias: 'groups' });
  locale('en');
  const markup = String(inboxListMarkup(options([item('a', { unread: 1 })])));
  assert.match(markup, />Inbox</); assert.match(markup, /Unread/); assert.match(markup, /1 unread message/); assert.match(markup, /Contato a/, 'nome do cliente nunca é traduzido');
  assert.match(markup, /Groups<\/button>/, 'the group filter label is translated too');
  assert.doesNotMatch(markup, />Grupos<\/button>/);
});

test('screen-inbox.css: on a phone, before taking the conversation, only the take-over banner stays in the composer', () => {
  // Every other composer control is disabled until "Assumir"; below 600 px it leaves the screen so the messages keep the space.
  const rules = cssRules(parseCss(readFileSync(new URL('../public/screen-inbox.css', import.meta.url), 'utf8')));
  const hidden = rules.find(entry => entry.context.includes('@media (max-width: 599.98px)') && entry.selector.startsWith('.pg-inbox__composer[data-mode="reply"]:has(> .pg-inbox__access:not(:empty))'));
  assert.ok(hidden, 'regra do celular antes de assumir');
  for (const part of ['.pg-inbox__composer-top', '.pg-inbox__origin', '.pg-inbox__form', '.pg-inbox__status']) assert.ok(hidden.selector.includes(part), part);
  assert.equal(hidden.declarations.find(declaration => declaration.property === 'display')?.value, 'none');
});
