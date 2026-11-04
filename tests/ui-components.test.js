// Base components (FRONTEND-V2 §4, §8.2 commit 1c): h``/raw/SafeHTML in i18n.js escape by default,
// every ui.js component escapes what it interpolates, and the toast stack follows §4.1 (status 4 s
// with pause, persistent alert, at most 3, never HTML from the message).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { h, html, raw, SafeHTML, escapeHTML, setLocale, registerTranslations } from '../public/i18n.js';
import * as ui from '../public/ui.js';
import { glyph, icon, paths, ICON_NAMES } from '../public/icons.js';
import { deriveBrandTokens, INK } from '../public/brand-theme.js';

const HOSTILE = `"><img src=x onerror=alert(1)>&'`;
const ESCAPED = '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;';
const render = value => String(value);
const assertInert = (markup, where) => {
  assert.ok(!markup.includes('<img src=x'), `${where}: tag injetada`);
  assert.ok(!markup.includes('"><img'), `${where}: atributo fechado pelo valor`);
  assert.ok(markup.includes(ESCAPED) || markup.includes('&lt;img src=x onerror=alert(1)&gt;'), `${where}: valor escapado presente`);
};

test('h escapa interpolações por padrão e devolve SafeHTML; raw e arrays de SafeHTML passam inteiros', () => {
  const markup = h`<p title="${HOSTILE}">${HOSTILE}</p>`;
  assert.ok(markup instanceof SafeHTML);
  assert.equal(String(markup), `<p title="${ESCAPED}">${ESCAPED}</p>`);
  assert.equal(String(h`<b>${raw('<i>ok</i>')}</b>`), '<b><i>ok</i></b>');
  assert.equal(String(h`<ul>${['<a>', 'b'].map(item => h`<li>${item}</li>`)}</ul>`), '<ul><li>&lt;a&gt;</li><li>b</li></ul>');
  assert.equal(String(h`<ul>${['<a>', raw('<li>b</li>')]}</ul>`), '<ul>&lt;a&gt;<li>b</li></ul>', 'array misto: só os SafeHTML passam');
  assert.equal(String(h`<p>${null}${undefined}${false}${0}${''}</p>`), '<p>0</p>');
  assert.equal(raw(markup), markup, 'raw não embrulha SafeHTML de novo');
  assert.equal(String(raw(null)), '');
  assert.equal(JSON.stringify({ markup: h`<b>${'x'}</b>` }), '{"markup":"<b>x</b>"}');
  assert.equal(escapeHTML(HOSTILE), ESCAPED);
  assert.equal(html`<div>${h`<b>${'<x>'}</b>`}</div>`, '<div><b>&lt;x&gt;</b></div>', 'SafeHTML entra no html legado como texto pronto');
});

test('h traduz os literais como html e nunca traduz valores, inclusive depois de trocar idioma ou catálogo', () => {
  const view = (label, value) => h`<button aria-label="Copiar">Copiar</button><span title="${label}">${value}</span>`;
  try {
    setLocale('pt-BR', { persist: false, notify: false });
    assert.equal(String(view('Copiar', 'Copiar')), '<button aria-label="Copiar">Copiar</button><span title="Copiar">Copiar</span>');
    setLocale('en', { persist: false, notify: false });
    assert.equal(String(view('Copiar', 'Copiar')), '<button aria-label="Copy">Copy</button><span title="Copiar">Copiar</span>');
    const late = () => h`<p>Frase registrada depois do primeiro uso de h</p>`;
    assert.equal(String(late()), '<p>Frase registrada depois do primeiro uso de h</p>');
    registerTranslations({ 'Frase registrada depois do primeiro uso de h': 'Sentence registered after the first use of h' });
    assert.equal(String(late()), '<p>Sentence registered after the first use of h</p>', 'cache de template invalida com catálogo novo');
    assert.equal(String(h`<p>Olá ${HOSTILE}</p>`), `<p>Olá ${ESCAPED}</p>`);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

test('cada componente escapa nomes, rótulos, valores e atributos vindos de dados', () => {
  const cases = {
    button: ui.button({ label: HOSTILE, action: HOSTILE, attrs: { 'data-id': HOSTILE }, disabledReason: HOSTILE }),
    iconButton: ui.iconButton({ label: HOSTILE, icon: 'close', action: HOSTILE }),
    badge: ui.badge(HOSTILE, HOSTILE),
    chip: ui.chip({ label: HOSTILE, count: HOSTILE, action: HOSTILE, value: HOSTILE }),
    removableChip: ui.chip({ label: HOSTILE, removable: true, value: HOSTILE }),
    avatar: ui.avatar({ name: HOSTILE, label: true, presence: 'available' }),
    groupAvatar: ui.avatar({ kind: 'group', name: 'x', members: [HOSTILE, HOSTILE] }),
    companyMark: ui.companyMark({ name: HOSTILE, brand: { accent: HOSTILE, initials: HOSTILE } }),
    tabs: ui.tabs({ id: 'safe', label: HOSTILE, items: [{ id: HOSTILE, label: HOSTILE, count: HOSTILE }] }),
    tabPanel: ui.tabPanel({ tabsId: 'safe', id: HOSTILE, content: HOSTILE }),
    segmented: ui.segmented({ name: HOSTILE, label: HOSTILE, items: [{ value: HOSTILE, label: HOSTILE }], value: HOSTILE }),
    emptyState: ui.emptyState({ title: HOSTILE, body: HOSTILE, action: { label: HOSTILE, action: HOSTILE }, secondary: { label: HOSTILE, href: HOSTILE } }),
    banner: ui.banner({ title: HOSTILE, body: HOSTILE, action: { label: HOSTILE, action: 'x' } }),
    skeleton: ui.skeleton({ label: HOSTILE }),
    progress: ui.progress({ value: 3, label: HOSTILE, valueText: HOSTILE }),
    kbd: ui.kbd(HOSTILE),
    codeBlock: ui.codeBlock({ code: HOSTILE, language: HOSTILE, copyLabel: HOSTILE })
  };
  for (const [name, markup] of Object.entries(cases)) {
    assert.ok(markup instanceof SafeHTML, `${name} devolve SafeHTML`);
    if (name === 'kbd') assert.ok(!render(markup).includes('<img'), 'kbd escapado');
    else if (name === 'groupAvatar') assert.ok(render(markup).includes('<span class="ui-avatar__stack">&quot;</span>'), 'iniciais escapadas');
    else assertInert(render(markup), name);
  }
  assert.ok(!render(cases.companyMark).includes(HOSTILE.slice(0, 5)), 'acento inválido nunca chega ao style');
  assert.match(render(cases.companyMark), /style="--company-bg:#3157d5;--company-fg:#ffffff;--company-edge:transparent"/);
  assert.match(render(cases.emptyState), /href="#"/, 'href perigoso vira #');
});

test('atributos extras rejeitam manipuladores de evento e nomes inválidos; imagens só de origens permitidas', () => {
  assert.throws(() => ui.button({ label: 'x', attrs: { onclick: 'alert(1)' } }), TypeError);
  assert.throws(() => ui.button({ label: 'x', attrs: { 'a b': '1' } }), TypeError);
  assert.equal(render(ui.attributes({ hidden: true, 'data-a': 0, 'data-b': null, 'data-c': false })), ' hidden data-a="0"');
  for (const src of ['javascript:alert(1)', 'http://x/a.png', '//evil/a.png', 'data:text/html;base64,PGI+', 'https://x/a.png']) {
    assert.ok(!render(ui.avatar({ name: 'Ana', src })).includes('<img'), `src ${src} descartado`);
  }
  assert.match(render(ui.avatar({ name: 'Ana', src: 'data:image/png;base64,iVBORw0KGgo=' })), /<img class="ui-avatar__img" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(render(ui.avatar({ name: 'Ana', src: '/api/avatar/1' })), /src="\/api\/avatar\/1"/);
  assert.equal(ui.safeHref('#agents/tools'), '#agents/tools'); assert.equal(ui.safeHref('/help'), '/help');
  assert.equal(ui.safeHref('javascript:alert(1)'), '#'); assert.equal(ui.safeHref('//evil'), '#'); assert.equal(ui.safeHref(' JAVASCRIPT:x'), '#');
});

test('botão: variantes, tamanhos, ocupado com rótulo mantido e desabilitado explicado', () => {
  const primary = render(ui.button({ label: 'Salvar', action: 'agents:save', variant: 'primary', size: 'lg', icon: 'check', kbd: 'Mod+S' }));
  assert.match(primary, /^<button type="button" class="ui-btn ui-btn--primary ui-btn--lg" data-action="agents:save">/);
  assert.match(primary, /<span class="ui-btn__label">Salvar<\/span><kbd class="ui-kbd">/);
  assert.match(render(ui.button({ label: 'x', variant: 'weird', size: 'xl' })), /class="ui-btn ui-btn--secondary ui-btn--md"/);
  const busy = render(ui.button({ label: 'Enviando', busy: true, disabled: true }));
  assert.match(busy, /aria-busy="true" aria-disabled="true"/); assert.ok(!/\sdisabled[\s>]/.test(busy), 'ocupado continua focável');
  assert.match(busy, /ui-spinner ui-btn__spinner--overlay/); assert.match(busy, /<span class="ui-btn__label">Enviando<\/span>/);
  assert.match(render(ui.button({ label: 'x', icon: 'send', busy: true })), /ui-spinner ui-btn__icon/);
  assert.match(render(ui.button({ label: 'x', disabled: true })), /<button type="button" class="ui-btn ui-btn--secondary ui-btn--md" disabled>/);
  assert.match(render(ui.button({ label: 'x', disabledReason: 'Sem permissão' })), /aria-disabled="true" title="Sem permissão"/);
  assert.match(render(ui.button({ label: 'x', type: 'submit', className: 'extra' })), /type="submit" class="ui-btn ui-btn--secondary ui-btn--md extra"/);
});

test('icon button exige rótulo e expõe aria-pressed, atalho e tooltip', () => {
  assert.throws(() => ui.iconButton({ icon: 'close' }), TypeError);
  const toggle = render(ui.iconButton({ label: 'Fixar', icon: 'grid', pressed: false, kbd: 'Mod+K' }));
  assert.match(toggle, /aria-label="Fixar"/); assert.match(toggle, /aria-pressed="false"/); assert.match(toggle, /aria-keyshortcuts="(?:Control|Meta)\+K"/);
  assert.match(toggle, /title="Fixar \((?:Ctrl K|⌘K)\)"/);
  assert.ok(!render(ui.iconButton({ label: 'x', icon: 'close' })).includes('aria-pressed'));
});

test('abas, painel e segmentado seguem os papéis ARIA e o índice do indicador', () => {
  const list = render(ui.tabs({ id: 'agents', label: 'Seções', active: 'tools', items: [{ id: 'overview', label: 'Visão' }, { id: 'tools', label: 'Ferramentas', count: 4 }, { id: 'x', label: 'Link', href: 'javascript:1' }] }));
  assert.match(list, /role="tablist" id="agents" aria-label="Seções"/);
  assert.match(list, /id="agents-tab-overview" aria-selected="false" aria-controls="agents-panel-overview" tabindex="-1"/);
  assert.match(list, /id="agents-tab-tools" aria-selected="true" aria-controls="agents-panel-tools" tabindex="0"/);
  assert.match(list, /<span class="ui-tabs__count">4<\/span>/); assert.match(list, /<a class="ui-tabs__tab" role="tab"[^>]*href="#"/);
  assert.throws(() => ui.tabs({ items: [] }), TypeError);
  assert.match(render(ui.tabPanel({ tabsId: 'agents', id: 'tools', active: true, content: raw('<p>x</p>') })), /^<div class="ui-tabpanel" role="tabpanel" id="agents-panel-tools" aria-labelledby="agents-tab-tools" tabindex="0"><p>x<\/p><\/div>$/);
  assert.match(render(ui.tabPanel({ tabsId: 'agents', id: 'usage' })), / hidden>/);
  const seg = render(ui.segmented({ name: 'mode', label: 'Modo', value: 'note', items: [{ value: 'reply', label: 'Responder' }, { value: 'note', label: 'Nota' }] }));
  assert.match(seg, /role="radiogroup" aria-label="Modo" style="--seg-count:2;--seg-index:1"/);
  assert.match(seg, /name="mode" value="note" checked/); assert.ok(!/value="reply" checked/.test(seg));
  assert.match(render(ui.segmented({ name: 'm', items: [{ value: 'a', label: 'A' }], value: 'z' })), /data-state="empty"/);
});

test('avatar de pessoa, agente, empresa e grupo; monograma usa o sólido derivado da empresa', () => {
  const person = render(ui.avatar({ name: 'ana maria souza', presence: 'away', channel: 'telegram', size: 40 }));
  assert.match(person, /class="ui-avatar ui-avatar--person ui-avatar--40" aria-hidden="true" data-presence="away" data-channel="telegram"/);
  assert.match(person, /<span class="ui-avatar__initials">AM<\/span>/); assert.match(person, /ui-avatar__channel/);
  const agent = render(ui.avatar({ kind: 'agent', name: 'Hermes', presence: 'busy' }));
  assert.match(agent, /ui-avatar--agent/); assert.match(agent, /✦/); assert.ok(!agent.includes('data-presence'), 'agente não tem presença');
  assert.match(render(ui.avatar({ kind: 'agent', name: 'Hermes', src: '/a.png' })), /ui-avatar__img[^>]*\/><span class="ui-avatar__mark">✦<\/span>/);
  assert.match(render(ui.avatar({ name: 'Ana', label: true, presence: 'busy' })), /role="img" aria-label="Ana · Ocupado"/);
  assert.match(render(ui.avatar({ size: 99 })), /ui-avatar--32/);
  assert.equal((render(ui.avatar({ kind: 'group', members: ['Ana', 'Bia', 'Caio'] })).match(/ui-avatar__stack/g) || []).length, 2);
  const yellow = deriveBrandTokens('#f2a900').light;
  const mark = render(ui.companyMark({ name: 'Padaria Sol', brand: { accent: '#f2a900' } }));
  assert.match(mark, new RegExp(`style="--company-bg:${yellow.accent};--company-fg:${INK};--company-edge:${yellow.edge}"`));
  assert.match(mark, />P<\/span><span class="ui-company__name">Padaria Sol<\/span>/);
  assert.ok(!render(ui.companyMark({ name: 'X' }, { showName: false })).includes('ui-company__name'));
  assert.equal(ui.initials(''), '?'); assert.equal(ui.initials('  élio   ramos '), 'ÉR'); assert.equal(ui.initials('😀 smile'), '😀S');
});

test('estado vazio, banner, skeleton, progresso, kbd e bloco de código', () => {
  const empty = render(ui.emptyState({ icon: 'agent', title: 'Nenhum agente', body: 'Conecte o primeiro.', action: { label: 'Conectar', action: 'agents:connect', variant: 'ghost' }, secondary: { label: 'Saiba mais', href: '#help' }, level: 3 }));
  assert.match(empty, /<h3 class="ui-empty__title">Nenhum agente<\/h3>/); assert.match(empty, /ui-btn--primary/, 'ação do vazio é sempre primária');
  assert.match(empty, /<a class="ui-btn ui-btn--link ui-btn--md" href="#help">/);
  assert.match(render(ui.emptyState({ title: 't', level: 9 })), /<h2 /);
  const critical = render(ui.banner({ tone: 'danger', title: 'Canal caiu', dismissible: true, live: 'assertive' }));
  assert.match(critical, /class="ui-banner ui-banner--danger" role="alert"/); assert.ok(!critical.includes('data-ui-dismiss'), 'crítico não é dispensável');
  assert.match(render(ui.banner({ tone: 'warning', title: 'Cota', dismissible: true })), /data-ui-dismiss="banner"/);
  assert.ok(!render(ui.banner({ title: 'x' })).includes('role='), 'banner estático não é região viva');
  assert.equal((render(ui.skeleton({ lines: 50 })).match(/ui-skeleton__line/g) || []).length, 8);
  assert.equal((render(ui.skeleton({ lines: 0 })).match(/ui-skeleton__line/g) || []).length, 1);
  assert.match(render(ui.skeleton()), /role="status"><span class="sr-only">Carregando…<\/span>/);
  assert.match(render(ui.progress({ value: 150, max: 120, label: 'Cota' })), /aria-valuemax="120" aria-valuenow="120"[^>]*style="--ui-progress:100%"/);
  assert.match(render(ui.progress({ value: -5 })), /aria-valuenow="0"/);
  const indeterminate = render(ui.progress({ label: 'Enviando' }));
  assert.match(indeterminate, /data-state="indeterminate"/); assert.ok(!indeterminate.includes('aria-valuenow'));
  assert.equal(ui.keyText('Mod+K', true), '⌘K'); assert.equal(ui.keyText('Mod+K', false), 'Ctrl K'); assert.equal(ui.keyText(['Shift', 'Mod', 'p'], false), 'Shift Ctrl P');
  const code = render(ui.codeBlock({ code: '{"a":"<b>"}', language: 'json' }));
  assert.match(code, /<pre class="ui-code__pre" tabindex="0" data-language="json" aria-label="Trecho de código"><code>\{&quot;a&quot;:&quot;&lt;b&gt;&quot;\}<\/code><\/pre>/);
  assert.match(code, /class="ui-btn ui-btn--ghost ui-btn--sm ui-code__copy" data-ui-copy="code"/);
});

test('relatório da marca vira frases PT/EN sem arredondar uma reprovação para 4,5', () => {
  const lines = report => ui.brandReportLines(deriveBrandTokens(report).report);
  try {
    setLocale('pt-BR', { persist: false, notify: false });
    assert.deepEqual(lines('#3157d5'), ['Texto branco sobre sua cor: 6,1:1 ✓']);
    assert.deepEqual(lines('#f2a900'), ['Texto branco sobre sua cor: 2,0:1, abaixo do mínimo de leitura', 'Usaremos texto escuro nos botões', 'Os botões ganham um contorno para continuar visíveis no fundo claro']);
    assert.deepEqual(lines('#777777'), ['Texto branco sobre sua cor: 4,4:1, abaixo do mínimo de leitura', 'Ajustamos o tom do botão para manter a leitura']);
    assert.ok(lines('#8a2be2').includes('Os agentes usam verde-azulado para não se confundir com a sua cor'));
    setLocale('en', { persist: false, notify: false });
    assert.deepEqual(lines('#3157d5'), ['White text on your color: 6.1:1 ✓']);
    assert.deepEqual(lines('#58c8aa').slice(1, 2), ['We will use dark text on buttons']);
  } finally { setLocale('pt-BR', { persist: false, notify: false }); }
  assert.deepEqual(ui.brandReportLines(null), []);
});

test('icons.js preserva os glifos do app.js e glyph devolve o mesmo SVG como SafeHTML', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/const paths = \{/.test(app) && !/const icon = /.test(app), 'app.js não redefine glifos');
  assert.match(app, /import \{ icon \} from '\.\/icons\.js';/);
  for (const name of ['maximize', 'grid', 'chat', 'agent', 'search', 'send', 'check', 'close', 'refresh']) assert.ok(ICON_NAMES.includes(name), name);
  assert.equal(icon('check', 'x'), '<svg class="icon x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>');
  assert.equal(typeof icon('check'), 'string', 'contrato legado: string');
  assert.equal(icon('missing'), icon('chat')); assert.equal(icon('constructor'), icon('chat'), 'sem nomes do protótipo');
  assert.ok(glyph('check') instanceof SafeHTML); assert.ok(render(glyph('check')).includes(paths.check));
  assert.ok(Object.isFrozen(paths));
});

// Minimal DOM for the toast stack: elements with children, listeners, dataset and attributes.
function fakeDocument() {
  const make = tag => {
    const element = {
      tagName: tag.toUpperCase(), children: [], parent: null, listeners: {}, dataset: {}, attributes: {}, className: '', textContent: '', type: '', html: '',
      append(child) { child.parent = this; this.children.push(child); },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      insertAdjacentHTML(_position, markup) { this.html += markup; },
      addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
      dispatch(name) { for (const listener of this.listeners[name] || []) listener({ target: this }); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      contains(other) { return other === this || this.children.some(child => child.contains?.(other)); },
      matches() { return false; },
      find(predicate) { return predicate(this) ? this : this.children.map(child => child.find(predicate)).find(Boolean); }
    };
    return element;
  };
  const regions = { toast: make('div'), 'toast-alert': make('div') };
  return { regions, activeElement: null, createElement: make, getElementById: id => regions[id] || null };
}

function fakeTimers() {
  let now = 0, sequence = 0; const pending = new Map();
  return {
    setTimeout(fn, ms = 0) { const id = ++sequence; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    now: () => now,
    advance(ms) { now += ms; for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && pending.has(id)) { pending.delete(id); timer.fn(); } },
    get size() { return pending.size; }
  };
}

test('toasts: status some em 4 s e pausa com ponteiro; erro fica em role=alert até dispensar; mensagem nunca vira HTML', () => {
  const doc = fakeDocument(), timers = fakeTimers(), stack = ui.createToasts({ document: doc, timers });
  const status = doc.regions.toast, alert = doc.regions['toast-alert'];
  const id = stack.show({ message: '<img src=x onerror=alert(1)> salvo', tone: 'success' });
  assert.equal(status.children.length, 1); assert.equal(alert.children.length, 0);
  const element = status.children[0], message = element.find(node => node.className === 'ui-toast__message');
  assert.equal(element.className, 'ui-toast ui-toast--success'); assert.equal(message.textContent, '<img src=x onerror=alert(1)> salvo'); assert.equal(message.html, '');
  element.dispatch('pointerenter'); timers.advance(10_000);
  assert.equal(status.children.length, 1, 'pausado com hover');
  element.dispatch('pointerleave'); timers.advance(3_999);
  assert.equal(stack.items.length, 1);
  timers.advance(2); assert.equal(stack.items.length, 0, 'retoma e sai'); assert.equal(element.dataset.state, 'leaving');
  timers.advance(200); assert.equal(status.children.length, 0);
  assert.equal(stack.dismiss(id), false);

  const error = stack.show({ message: 'Falha ao enviar', tone: 'error' });
  assert.equal(alert.children.length, 1); assert.match(alert.children[0].html, /ui-toast__icon/);
  timers.advance(60_000); assert.equal(alert.children.length, 1, 'erro persiste');
  const close = alert.children[0].find(node => node.className?.includes('ui-toast__close'));
  assert.equal(close.attributes['aria-label'], 'Dispensar notificação');
  close.dispatch('click'); timers.advance(200);
  assert.equal(alert.children.length, 0); assert.equal(stack.dismiss(error), false);
  assert.equal(stack.show({ message: '   ' }), null, 'mensagem vazia não cria toast');
  assert.equal(ui.createToasts({ document: { getElementById: () => null } }).show({ message: 'x' }), null, 'sem regiões não falha');
});

test('toasts: no máximo 3, sai primeiro o status mais antigo; duplicado substitui; ação chama o callback e fecha', () => {
  const doc = fakeDocument(), timers = fakeTimers(), stack = ui.createToasts({ document: doc, timers });
  stack.show({ message: 'erro A', tone: 'error' }); stack.show({ message: 'info B' }); stack.show({ message: 'erro C', tone: 'error' });
  stack.show({ message: 'erro D', tone: 'error' });
  assert.deepEqual(stack.items.map(item => item.text), ['erro A', 'erro C', 'erro D'], 'o status sai antes dos erros');
  stack.show({ message: 'erro E', tone: 'error' });
  assert.deepEqual(stack.items.map(item => item.text), ['erro C', 'erro D', 'erro E']);
  assert.equal(doc.regions['toast-alert'].children.length, 3);
  stack.show({ message: 'erro D', tone: 'error' });
  assert.deepEqual(stack.items.map(item => item.text), ['erro C', 'erro E', 'erro D'], 'duplicado é reanunciado no fim, sem empilhar');
  stack.clear(); assert.equal(stack.items.length, 0); assert.equal(doc.regions['toast-alert'].children.length, 0);
  let reopened = 0;
  stack.show({ message: 'Conversa encerrada', tone: 'success', action: { label: 'Reabrir', onSelect: () => reopened++ } });
  const action = doc.regions.toast.children[0].find(node => node.className?.includes('ui-toast__action'));
  assert.equal(action.textContent, 'Reabrir'); action.dispatch('click');
  assert.equal(reopened, 1); assert.equal(stack.items.length, 0);
});

test('installUI delega setas das abas, índice do segmentado, cópia e dispensa, uma vez por documento', async () => {
  const listeners = {}, doc = { addEventListener(name, listener) { (listeners[name] ||= []).push(listener); } };
  assert.equal(ui.installUI(doc, { toasts: { show() {} } }), true); assert.equal(ui.installUI(doc), false);
  assert.deepEqual(Object.keys(listeners).sort(), ['change', 'click', 'keydown']);
  const focused = [], tabs = ['a', 'b', 'c'].map(id => ({ id, focus() { focused.push(id); } }));
  const list = { querySelectorAll: () => tabs };
  for (const tab of tabs) tab.closest = selector => selector === '.ui-tabs' ? list : tab;
  let prevented = 0; const key = (target, name) => listeners.keydown[0]({ target, key: name, preventDefault() { prevented++; } });
  key(tabs[2], 'ArrowRight'); key(tabs[0], 'ArrowLeft'); key(tabs[1], 'Home'); key(tabs[0], 'End'); key(tabs[0], 'Enter');
  assert.deepEqual(focused, ['a', 'c', 'a', 'c']); assert.equal(prevented, 4, 'Enter ativa o botão nativo (ativação manual)');
  const style = new Map(), group = { style: { setProperty: (name, value) => style.set(name, value) }, removeAttribute: name => style.set('removed', name) };
  const inputs = [0, 1, 2].map(() => ({ classList: { contains: name => name === 'ui-seg__input' }, closest: () => group }));
  group.querySelectorAll = () => inputs;
  listeners.change[0]({ target: inputs[2] });
  assert.equal(style.get('--seg-index'), '2'); assert.equal(style.get('removed'), 'data-state');
  let removed = false; const bannerElement = { remove() { removed = true; } };
  const dismiss = { closest: selector => selector === '[data-ui-dismiss="banner"]' ? dismiss : selector === '.ui-banner' ? bannerElement : null };
  listeners.click[0]({ target: dismiss, preventDefault() {} });
  assert.equal(removed, true);
  const shown = [], copyDoc = { addEventListener(name, listener) { (listeners[`copy-${name}`] ||= []).push(listener); } };
  ui.installUI(copyDoc, { toasts: { show: options => shown.push(options) } });
  const pre = { textContent: 'npx elozi' }, copy = { closest: selector => selector === '[data-ui-copy]' ? copy : selector === '.ui-code' ? { querySelector: () => pre } : null };
  const clipboard = []; const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { clipboard.push(text); } } } });
  try {
    listeners['copy-click'][0]({ target: copy, preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(clipboard, ['npx elozi']); assert.deepEqual(shown, [{ message: 'Copiado.', tone: 'success' }]);
  } finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; }
});

test('avatar: o selo do canal mostra o logo da marca conhecida; webchat e e-mail ficam com o ícone da plataforma', () => {
  const whatsapp = String(ui.avatar({ name: 'Ana', channel: 'whatsapp_qr' })), telegram = String(ui.avatar({ name: 'Ana', channel: 'telegram' }));
  assert.match(whatsapp, /<span class="ui-avatar__channel" data-brand="whatsapp"><svg class="channel-mark " data-brand="whatsapp"/);
  assert.match(telegram, /data-brand="telegram" viewBox="3\.5 4\.3 16 16"/, 'Telegram: só o avião sobre o azul');
  for (const kind of ['webchat', 'email']) { const html = String(ui.avatar({ name: 'Ana', channel: kind })); assert.doesNotMatch(html, /data-brand=/); assert.match(html, /<span class="ui-avatar__channel"><svg class="icon /); }
  assert.doesNotMatch(String(ui.avatar({ name: 'Ana' })), /ui-avatar__channel/);
});
