import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import {messageTextMarkup} from '../public/ui.js';
import { channelCapabilities, conversationCapabilities } from '../public/channel-capabilities.js';
import { attendanceReplyAccess, attendanceParticipantRole } from '../public/participants-ui.js';
import { excerpt } from './helpers/app-source.js';

const executable = [
  excerpt('channel-helpers'),
  excerpt('permissions-attendance'),
  excerpt('message-date')
].join('\n') + '\n({conversationMessage,capabilitiesFor,canCoordinate,supportsMedia,supportsVoice,supportsAvatar})';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function fixture({ transport = 'elozi-webchat', mediaSettings = {}, conversation: changes = {}, selecting = false, permissions = ['inbox.reply'] } = {}) {
  const channel = { id: 'channel-synthetic', kind: { baileys: 'whatsapp_qr', 'telegram-bot': 'telegram', 'elozi-webchat': 'webchat', 'meta-instagram': 'instagram', 'meta-messenger': 'messenger' }[transport] || 'unknown', transport, state: 'connected' };
  channel.capabilities = channelCapabilities(channel, mediaSettings);
  const conversation = { id: 'conversation-synthetic', channelId: channel.id, owner: 'human', assignedUserId: 'operator-synthetic', status: 'open', version: 1, contact: 'Contato sintético', messages: [], ...changes };
  const state = { boot: { session: { userId: 'operator-synthetic', role: 'employee', permissions } }, tenant: { id: 'tenant-synthetic', channels: [channel], conversations: [conversation] }, conversation: conversation.id, inboxSelecting: selecting };
  const loaded = runInNewContext(executable, {
    ...i18n, state, messageTextMarkup, channelCapabilities, conversationCapabilities, attendanceReplyAccess, attendanceParticipantRole,
    escape, time: () => '12:00', icon: glyph => '<span aria-hidden="true">' + escape(glyph) + '</span>',
    repliesUI: { messageQuote: () => '', messageReplyButton: () => '' },
    mediaUI: { messageAttachments: message => (message.attachments || []).map(attachment => '<span class="synthetic-attachment">' + escape(attachment.name) + '</span>').join('') }
  });
  return { ...loaded, state, channel, conversation, render: message => loaded.conversationMessage(message, null, 0) };
}

const message = changes => ({ id: 'message-synthetic', kind: 'customer', text: 'Texto próprio sintético', createdAt: '2026-10-03T12:00:00.000Z', ...changes });
const photo = { id: 'attachment-synthetic', kind: 'image', mime: 'image/png', name: 'Foto própria.png', size: 32, status: 'ready', preview: true };

test('mensagens de agente ficam do lado da equipe com autoria, sem ganhar encaminhamento humano', () => {
  const f = fixture();
  f.state.tenant.agents = [{ id: 'agent-synthetic', name: 'Assistente <teste>' }];
  const agent = f.render(message({ kind: 'agent', agentId: 'agent-synthetic' }));
  assert.match(agent, /class="message outgoing agent-message"/);
  assert.match(agent, /Agente · Assistente &lt;teste&gt;/);
  const formatted=f.render(message({kind:'agent',agentId:'agent-synthetic',text:'*Passos*\n\n• Abra a conta\n• <img src=x onerror=alert(1)>'}));
  assert.match(formatted, /<div class="message-text"><p><strong>Passos<\/strong><\/p><ul>/);
  assert.match(formatted, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(formatted, /<img/);
  assert.doesNotMatch(agent, /data-action="forward-message"/);
  assert.match(f.render(message()), /class="message incoming"/);
  assert.match(f.render(message({ kind: 'human', authorName: 'Operadora' })), /class="message outgoing"/);
  assert.match(f.render(message({ kind: 'internal' })), /class="message internal-note"/);
  assert.match(f.render(message({ kind: 'system' })), /class="system-message"/);
});

const forwardButtons = markup => [...markup.matchAll(/<button\b[^>]*\bdata-action="forward-message"[^>]*>/g)].map(match => match[0]);
function assertForward(f, input, expected, label) {
  const rendered = f.render(input), buttons = forwardButtons(rendered);
  assert.equal(buttons.length, expected ? 1 : 0, label);
  if (expected) {
    assert.match(buttons[0], /data-id="message-synthetic"/);
    assert.match(buttons[0], /aria-label="Encaminhar mensagem"/);
    assert.doesNotMatch(buttons[0], /\b(?:hidden|disabled)\b/);
  }
  return rendered;
}

test('Webchat assumido oferece Encaminhar no texto mesmo sem uploadKinds na origem', () => {
  const f = fixture();
  assert.equal(f.canCoordinate(f.conversation), true);
  assert.deepEqual(f.capabilitiesFor(f.conversation).uploadKinds, []);
  assert.equal(f.supportsMedia(f.conversation), false);
  for (const kind of ['customer', 'human']) assertForward(f, message({ kind }), true, kind);
});

test('Webchat assumido oferece Encaminhar na foto pronta mesmo sem uploadKinds na origem', () => {
  const f = fixture();
  assert.equal(f.canCoordinate(f.conversation), true);
  assert.deepEqual(f.capabilitiesFor(f.conversation).uploadKinds, []);
  const rendered = assertForward(f, message({ text: '', attachments: [photo] }), true);
  assert.match(rendered, /Foto própria\.png/);
});

test('fila, observador, colaborador e autoridade negada não oferecem encaminhamento', () => {
  for (const transport of ['elozi-webchat', 'baileys']) {
    for (const options of [
      { conversation: { owner: 'queue', assignedUserId: null } },
      { conversation: { assignedUserId: 'another-operator', attendanceAccess: { canReply: false } } },
      { conversation: { assignedUserId: 'another-operator', attendanceAccess: { canReply: true } } },
      { conversation: { attendanceAccess: { canReply: false } } },
      { conversation: { status: 'closed' } },
      { selecting: true },
      { permissions: [] }
    ]) {
      const f = fixture({ transport, ...options });
      assert.equal(f.canCoordinate(f.conversation), false, transport);
      for (const input of [message(), message({ text: '', attachments: [photo] })]) assertForward(f, input, false, transport);
    }
  }
});

test('notas internas e mensagens de sistema nunca oferecem Encaminhar', () => {
  for (const transport of ['elozi-webchat', 'baileys', 'telegram-bot']) {
    const f = fixture({ transport });
    assert.equal(f.canCoordinate(f.conversation), true);
    for (const kind of ['internal', 'system']) assertForward(f, message({ kind, attachments: [photo] }), false, transport + '/' + kind);
  }
});

test('Meta continua sem Encaminhar mesmo quando Messenger permite upload', () => {
  for (const transport of ['meta-instagram', 'meta-messenger']) {
    const f = fixture({ transport, mediaSettings: { mediaSupported: true, mediaKinds: ['image'], mediaMimes: ['image/png'], mediaMaxBytes: 128 } });
    assert.equal(f.canCoordinate(f.conversation), true);
    assert.equal(f.capabilitiesFor(f.conversation).forward, false);
    if (transport === 'meta-messenger') assert.deepEqual(f.capabilitiesFor(f.conversation).uploadKinds, ['image']);
    for (const input of [message(), message({ text: '', attachments: [photo] })]) assertForward(f, input, false, transport);
  }
});

test('transporte desconhecido continua sem Encaminhar mesmo com configuração de mídia', () => {
  const f = fixture({ transport: 'unknown', mediaSettings: { mediaSupported: true, mediaKinds: ['image', 'audio'], voiceSupported: true } });
  assert.equal(f.canCoordinate(f.conversation), true);
  assert.equal(f.capabilitiesFor(f.conversation).forward, false);
  for (const input of [message(), message({ text: '', attachments: [photo] })]) assertForward(f, input, false);
});

test('encaminhamento Webchat não habilita upload, voz ou avatar por consequência', () => {
  for (const mediaSettings of [{}, { mediaSupported: false, mediaKinds: ['image', 'audio'], voiceSupported: true }]) {
    const f = fixture({ mediaSettings }), caps = f.capabilitiesFor(f.conversation);
    assert.deepEqual(caps.uploadKinds, []);
    assert.equal(caps.maxMediaBytes, 0);
    assert.equal(f.supportsMedia(f.conversation), false);
    assert.equal(f.supportsVoice(f.conversation), false);
    assert.equal(f.supportsAvatar(f.conversation), false);
  }
});

test('QR e Telegram assumidos preservam Encaminhar para texto e foto pronta', () => {
  for (const transport of ['baileys', 'telegram-bot']) {
    const f = fixture({ transport });
    assert.equal(f.canCoordinate(f.conversation), true);
    assert.equal(f.capabilitiesFor(f.conversation).forward, true);
    for (const input of [message(), message({ kind: 'human', text: '', attachments: [photo], delivery: 'read' })]) assertForward(f, input, true, transport);
  }
});
