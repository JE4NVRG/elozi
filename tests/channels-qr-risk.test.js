import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelsUI } from '../public/channels-ui.js';
import { setLocale } from '../public/i18n.js';

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

const ui = channels => createChannelsUI({ state: { workspaceId: 'w-1', boot: { session: { role: 'reseller', permissions: null, userId: 'u-1' } }, tenant: { id: 't-1', name: 'Empresa QA', channels, conversations: [] } } });
const risk = markup => /<div class="pg-channels__state pg-channels__risk" data-tone="warning" data-whatsapp-qr-risk role="note">([\s\S]*?)<\/div>/.exec(markup)?.[1] || '';
const disconnected = { id: 'wa-1', name: 'Vendas', kind: 'whatsapp_qr', transport: 'baileys', state: 'disconnected', label: 'Número de teste · final 4321' };

test('aviso de risco do WhatsApp QR aparece antes do QR, sem botão de dispensar, em PT e EN', () => {
  const pt = risk(ui([]).view({ section: 'channels', params: { kind: 'whatsapp_qr' } }));
  for (const fact of [/sessão não oficial do WhatsApp Web \(Baileys\)/, /não a API oficial da Meta\/WhatsApp Business/, /limitar, suspender ou banir o número conectado/, /sem envio em massa nem spam/, /número dedicado/, /não garante a disponibilidade/, /não consegue recuperar um número banido/, /href="\/termos#whatsapp-qr"/]) assert.match(pt, fact);
  assert.doesNotMatch(pt, /<button|data-action|dismiss|Fechar/i);
  assert.equal(risk(ui([]).view({ section: 'channels', params: { kind: 'telegram' } })), '');
  setLocale('en', { persist: false, notify: false });
  const en = risk(ui([]).view({ section: 'channels', params: { kind: 'whatsapp_qr' } }));
  for (const fact of [/Unofficial connection: your number may be blocked/, /unofficial WhatsApp Web session \(Baileys\)/, /not the official Meta\/WhatsApp Business API/, /limit, suspend, or ban the connected number at its discretion/, /no bulk messaging or spam/, /dedicated number/, /cannot recover a banned number/, /href="\/en\/terms#whatsapp-qr"/, /See Terms of Use/]) assert.match(en, fact);
  assert.doesNotMatch(en, /não|número|Conexão/);
});

test('passo Conectar do WhatsApp QR mostra o aviso antes da área do QR e do botão Gerar QR', () => {
  const markup = ui([disconnected]).view({ section: 'channels', params: { channelId: 'wa-1', step: 'connect' } });
  const notice = markup.indexOf('data-whatsapp-qr-risk'), pair = markup.indexOf('pg-channels__pair'), start = markup.indexOf('data-action="channels:start"');
  assert.ok(notice > -1, 'risk notice rendered on connect step');
  assert.ok(pair > -1 && notice < pair, 'notice precedes the QR area');
  assert.ok(start === -1 || notice < start, 'notice precedes the Gerar QR action');
});
