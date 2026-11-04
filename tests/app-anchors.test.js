// Contract of the explicit excerpts of public/app.js (FRONTEND-V2 §8.1, seam 4). Owned by the
// package that owns app.js in the current wave (P1 → P3 → P8 → P10). Moving anchored code is
// fine as long as its /*@anchor:<name>*/ … /*@end:<name>*/ markers move with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ANCHOR_SOURCES, anchorMarkers, excerpt, publicSource } from './helpers/app-source.js';

const ANCHORS = [
  'act', 'act-new-agent', 'act-test-agent', 'api', 'app-click', 'app-submit',
  'app-submit-listener', 'attendance-access', 'attendance-action', 'attendance-context', 'change-workspace',
  'channel-groups', 'channel-helpers', 'composer-status', 'connection-timer', 'contact-link-result',
  'contact-link-result-refresh', 'contact-refresh', 'contacts-page', 'current-conversation',
  'current-conversation-participants', 'delegated-screens', 'drop-inbox-detail', 'field-helpers', 'flow-draft-guard', 'follow-ups-ui', 'forwarding',
  'generated-channel-labels', 'groups-workspace-ui', 'inbox-contact-authority', 'inbox-polling',
  'inbox-selection-state', 'inbox-read-receipts', 'inbox-list-actions', 'live-tasks', 'media-ui', 'message-date', 'modal-click', 'modal-submit', 'navigate',
  'navigation-heading', 'navigation-render', 'open-modal', 'pending-send-unload', 'permissions', 'permissions-attendance', 'poll-inbox',
  'provider-names', 'refresh', 'refresh-inbox-list', 'render-agent-bindings', 'reply-access', 'reply-action', 'route-sync',
  'scoped-runs', 'scoped-runs-context', 'select-inbox-conversation', 'service-handoffs', 'shell-actions', 'start',
  'support-factories', 'view-panels', 'voice-controls', 'whatsapp-groups-ui',
  'workspace-selection-reset'
];

const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const testsDirectory = new URL('./', import.meta.url);
const publicDirectory = new URL('../public/', import.meta.url);

test('cada âncora esperada existe exatamente uma vez, abre antes de fechar e não está vazia', () => {
  assert.equal(new Set(ANCHORS).size, ANCHORS.length, 'nomes de âncora repetidos na lista');
  const markers = anchorMarkers();
  for (const name of ANCHORS) {
    const begins = markers.filter(marker => marker.name === name && marker.kind === 'anchor');
    const ends = markers.filter(marker => marker.name === name && marker.kind === 'end');
    assert.equal(begins.length, 1, `/*@anchor:${name}*/ deve aparecer exatamente uma vez em ${ANCHOR_SOURCES.join(', ')}`);
    assert.equal(ends.length, 1, `/*@end:${name}*/ deve aparecer exatamente uma vez em ${ANCHOR_SOURCES.join(', ')}`);
    assert.equal(begins[0].file, ends[0].file, `${name} abre e fecha no mesmo arquivo`);
    assert.ok(begins[0].end < ends[0].start, `${name} abre antes de fechar`);
    assert.ok(excerpt(name).trim().length > 0, `${name} não pode ficar vazia`);
  }
  const unknown = [...new Set(markers.map(marker => marker.name))].filter(name => !ANCHORS.includes(name));
  assert.deepEqual(unknown, [], 'âncora fora da lista: registre-a aqui ou remova o marcador');
});

test('os marcadores são comentários reais em linha própria, nunca texto dentro de string ou template', () => {
  for (const file of ANCHOR_SOURCES) {
    const source = publicSource(file), comments = [];
    acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module', onComment: (block, text, start) => { if (block && /^@(?:anchor|end):/.test(text)) comments.push(start); } });
    const markers = anchorMarkers([file]);
    assert.deepEqual(comments, markers.map(marker => marker.start), `${file}: todo marcador precisa ser um comentário de bloco`);
    for (const marker of markers) {
      const lineStart = source.lastIndexOf('\n', marker.start - 1) + 1, lineEnd = source.indexOf('\n', marker.end);
      assert.equal(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(), source.slice(marker.start, marker.end), `${file}: /*@${marker.kind}:${marker.name}*/ fica sozinho na linha`);
    }
  }
});

test('marcadores só existem nas fontes listadas em tests/helpers/app-source.js', () => {
  const stray = readdirSync(publicDirectory).filter(file => /\.js$/.test(file) && !ANCHOR_SOURCES.includes(file))
    .filter(file => /\/\*@(?:anchor|end):/.test(readFileSync(new URL(file, publicDirectory), 'utf8')));
  assert.deepEqual(stray, [], 'mova a âncora junto com o código e liste o módulo em ANCHOR_SOURCES');
});

test('os testes pedem só âncoras registradas e toda âncora registrada é usada', () => {
  const used = new Set();
  for (const file of readdirSync(testsDirectory).filter(name => name.endsWith('.test.js'))) {
    for (const match of readFileSync(new URL(file, testsDirectory), 'utf8').matchAll(/\bexcerpt\(\s*'([^']+)'\s*\)/g)) {
      assert.ok(ANCHORS.includes(match[1]), `${file} pede a âncora não registrada ${match[1]}`);
      used.add(match[1]);
    }
  }
  assert.deepEqual(ANCHORS.filter(name => !used.has(name)), [], 'âncora sem teste: remova o marcador e o nome da lista');
});
