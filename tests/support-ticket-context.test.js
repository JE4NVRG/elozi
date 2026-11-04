import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSupportTicketContext, renderSupportTicketEmail, supportReplyAddress, SUPPORT_TICKET_LIMITS } from '../src/support-ticket-context.js';

function fixture() {
  const channel = { id: 'site-alpha', kind: 'webchat', name: 'Portal Alfa', webchat: { origins: ['https://alpha.example.test'], widget: { displayName: 'Marca Alfa', handoffNotificationEmail: 'operators@example.test', assistantInstructions: 'DO-NOT-EXPORT-INSTRUCTIONS' } } };
  const conversation = { id: 'conversation-alpha', channelId: channel.id, contact: 'Visitante Alfa', webchatVisitor: { name: 'Marina Alfa', email: 'Return@Example.test', verified: false, ctx: { plan: 'DO-NOT-EXPORT-BILLING' }, token: 'DO-NOT-EXPORT-TOKEN', pageUrl: 'https://untrusted.example.test/?token=PRIVATE' },
    supportAssistantHandoff: { active: true, requestedAt: '2026-10-12T14:10:00.000Z' }, messages: [
      { id: 'm1', kind: 'customer', text: 'O IP de envio é dedicado ou compartilhado?', createdAt: '2026-10-12T14:00:00Z' },
      { id: 'm2', kind: 'agent', text: 'A equipe pode revisar esta questão.', createdAt: '2026-10-12T14:01:00Z', token: 'DO-NOT-EXPORT-MESSAGE-TOKEN' },
      { id: 'm3', kind: 'customer', text: 'Quero falar com uma pessoa.', createdAt: '2026-10-12T14:10:00Z' },
      { id: 'internal', kind: 'system', text: 'DO-NOT-EXPORT-PRIVATE-NOTE' }
    ] };
  const tenant = { id: 'company-alpha', name: 'Clínica Alfa', channels: [channel], conversations: [conversation], contacts: [], secret: 'DO-NOT-EXPORT-TENANT' };
  const input = { tenantId: tenant.id, channelId: channel.id, conversationId: conversation.id, jobId: 'job-alpha', reason: 'visitor_requested_human', records: { tenant, channel, conversation, sourceOrigin: 'https://alpha.example.test' } };
  return { input, tenant, channel, conversation, build: (extra = {}) => buildSupportTicketContext({ ...input, ...extra }), render: context => renderSupportTicketEmail(context, { from: 'Configured <notify@example.test>', email: 'operators@example.test', link: 'https://elozi.example.test/#inbox/company-alpha/conversation-alpha' }) };
}

test('contexto explícito PT-BR inclui identidade, ticket, pergunta, transcript e origem sem JSON operacional', () => {
  const f = fixture(), context = f.build(), payload = f.render(context), snapshot = JSON.stringify(context);
  assert.equal(context.companyName, 'Clínica Alfa'); assert.equal(context.channelName, 'Portal Alfa'); assert.equal(context.visitorName, 'Marina Alfa');
  assert.equal(context.replyEmail, 'return@example.test'); assert.equal(context.emailStatus, 'provided'); assert.equal(payload.reply_to, 'return@example.test');
  assert.equal(context.lastCustomerQuestion, 'Quero falar com uma pessoa.'); assert.deepEqual(context.transcript.map(item => item.kind), ['customer', 'agent', 'customer']);
  assert.match(payload.text, /Ticket \/ conversa: conversation-alpha/); assert.match(payload.text, /O IP de envio é dedicado ou compartilhado/); assert.match(payload.text, /O visitante solicitou atendimento humano/);
  assert.match(payload.text, /Solicitado em \(UTC\): 2026-10-12T14:10:00.000Z/); assert.match(payload.text, /Origem autorizada: https:\/\/alpha.example.test/);
  assert.match(payload.subject, /Clínica Alfa.*Portal Alfa/); assert.equal(payload.subject.includes('MepMail'), false);
  assert.deepEqual(payload.to, ['operators@example.test']); assert.equal(payload.from, 'Configured <notify@example.test>');
  for (const privateValue of ['DO-NOT-EXPORT', 'untrusted.example.test', 'PRIVATE']) { assert.equal(snapshot.includes(privateValue), false); assert.equal(JSON.stringify(payload).includes(privateValue), false); }
  assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.transcript)); assert.ok(Object.isFrozen(context.transcript[0]));
  assert.deepEqual(Object.keys(context).sort(), ['tenantId','channelId','conversationId','jobId','locale','companyName','channelName','visitorName','contactId','replyEmail','emailStatus','sourceOrigin','reasonCode','reasonText','automationState','requestedAt','lastCustomerQuestion','transcript','transcriptTruncated'].sort());
});

test('rascunhos e respostas com envio incerto não vazam no transcript do chamado', () => {
  const f = fixture();
  for (const kind of ['human', 'agent']) for (const delivery of ['draft', 'pending', 'failed', 'unknown', 'in_flight']) f.conversation.messages.push({ kind, delivery, text: 'PRIVATE-UNSENT-'+delivery });
  f.conversation.messages.push({ kind: 'human', delivery: 'sent', text: 'Confirmado publicamente para o visitante.' });
  const context = f.build({reason:'agent_requested_human'}), payload = f.render(context);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE-UNSENT/);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE-UNSENT/);
  assert.match(payload.text, /Confirmado publicamente para o visitante/);
  assert.match(context.reasonText, /assistente solicitou revisão/);
});

test('verified só é verdadeiro com prova atual do gateway e não com flag do visitante/CRM', () => {
  const f = fixture(); f.conversation.webchatVisitor.verified = true;
  assert.equal(f.build().emailStatus, 'provided');
  f.input.records.identityVerified = true; assert.equal(f.build().emailStatus, 'verified'); assert.match(f.render(f.build()).text, /Identidade verificada/);
  f.conversation.webchatVisitor.verified = false; assert.equal(f.build().emailStatus, 'provided');
  f.conversation.webchatVisitor.email = 'bad\r\nBcc: victim@example.test';
  const context = f.build(); assert.equal(context.emailStatus, 'unavailable'); assert.equal(context.replyEmail, null); assert.equal('reply_to' in f.render(context), false);
});

test('endereços inválidos são omitidos, jamais reparados em Reply-To', () => {
  for (const value of [undefined,null,{},'','bad-address','visitor@example.test\n',' visitor@example.test','visitor@example.test\u202e','.visitor@example.test','visitor.@example.test','visitor..name@example.test','visitor@example..test','a'.repeat(65)+'@example.test','visitor@'+'a'.repeat(64)+'.test','<visitor@example.test>']) assert.equal(supportReplyAddress(value), null, String(value));
  assert.equal(supportReplyAddress('Visitor+tag@Example.test'), 'visitor+tag@example.test');
});

test('contato só contribui com nome/e-mail quando vínculo de identidade é exato e ativo', () => {
  const f = fixture(); f.conversation.webchatVisitor = {}; f.conversation.contactId = 'contact-alpha';
  const contact = { id: 'contact-alpha', name: 'Pessoa CRM', type: 'person', email: 'crm@example.test', identities: [{ channelId: f.channel.id, kind: 'person', externalId: 'conversation:'+f.conversation.id }], notes: 'DO-NOT-EXPORT-NOTES', phone: 'DO-NOT-EXPORT-PHONE', verified: true };
  f.tenant.contacts = [contact];
  assert.equal(f.build().contactId, contact.id); assert.equal(f.build().visitorName, 'Pessoa CRM'); assert.equal(f.build().replyEmail, contact.email); assert.equal(f.build().emailStatus, 'provided');
  assert.equal(JSON.stringify(f.build()).includes('DO-NOT-EXPORT'), false);
  contact.identities[0].channelId = 'another-channel'; assert.equal(f.build().contactId, null); assert.equal(f.build().replyEmail, null);
  contact.identities[0].channelId = f.channel.id; contact.archivedAt = '2026-10-12'; assert.equal(f.build().contactId, null);
  delete contact.archivedAt; contact.mergedIntoId = 'another-contact'; assert.equal(f.build().contactId, null);
});

test('tenant/canal/conversa diferentes ou clones não autorizados são rejeitados', () => {
  const f = fixture();
  for (const extra of [{tenantId:'company-beta'}, {channelId:'site-beta'}, {conversationId:'conversation-beta'}, {jobId:'bad\njob'}, {reason:'bad\nreason'}, {records:{...f.input.records,tenant:{...f.tenant,channels:[]}}}, {records:{...f.input.records,channel:{...f.channel}}}, {records:{...f.input.records,conversation:{...f.conversation}}}]) assert.throws(() => f.build(extra), error => error.status === 409);
  f.conversation.channelId = 'site-beta'; assert.throws(() => f.build(), error => error.status === 409);
});

test('origem só aparece com metadata de sessão e allowlist exata; página/query nunca são inferidas', () => {
  const f = fixture(); delete f.input.records.sourceOrigin;
  assert.equal(f.build().sourceOrigin, null);
  for (const sourceOrigin of ['https://beta.example.test','https://alpha.example.test/?token=PRIVATE','https://alpha.example.test/page','javascript:alert(1)','https://user:pass@alpha.example.test','https://alpha.example.test\n']) assert.equal(f.build({records:{...f.input.records,sourceOrigin}}).sourceOrigin, null);
  assert.equal(f.render(f.build()).text.includes('Origem autorizada:'), false);
});

test('HTML, controles e cabeçalhos são escapados e credenciais comuns não entram no snapshot', () => {
  const f = fixture(); f.tenant.name = '<svg onload="bad"> & Alfa\r\nBcc: injected@example.test\u202e'; f.channel.name = '<img src=x onerror="bad">'; f.conversation.webchatVisitor.name = '<script>alert(1)</script>\x00';
  const secrets = ['ms_'+'a'.repeat(32), 'sk_'+'b'.repeat(32), 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InhAeS50ZXN0In0.signature', 'f'.repeat(43), 'private-password', 'private-cookie', 'private-query', 'private JSON secret with spaces'];
  f.conversation.messages.push({ kind:'customer', text:`<img src=x onerror="bad"> & test\r\nBearer ${secrets[0]} token=${secrets[1]} ${secrets[2]} ${secrets[3]} senha=${secrets[4]} cookie=${secrets[5]} https://host.test/path?token=${secrets[6]} {"client_secret":"${secrets[7]}"}\x00\u202e`, createdAt:'malformed' });
  const context = f.build(), payload = f.render(context);
  for (const secret of secrets) { assert.equal(JSON.stringify(context).includes(secret), false, secret); assert.equal(JSON.stringify(payload).includes(secret), false, secret); }
  assert.doesNotMatch(payload.subject, /[\p{Cc}\p{Cf}]/u); assert.doesNotMatch(payload.text, /[\x00\r\u202e]/);
  assert.equal(payload.html.includes('<svg'), false); assert.equal(payload.html.includes('<img'), false); assert.equal(payload.html.includes('<script'), false);
  assert.match(payload.html, /&lt;svg/); assert.match(payload.html, /&lt;img/); assert.match(payload.html, /&amp;/);
});

test('limites conservam últimas mensagens e pergunta com tamanho total finito após escaping', () => {
  const f = fixture(); f.tenant.name = ('A<> & ').repeat(10000); f.channel.name = ('B<> & ').repeat(10000); f.conversation.webchatVisitor.name = ('C<> & ').repeat(10000);
  f.conversation.messages = Array.from({length:50}, (_,index) => ({kind:index===49?'customer':'agent',text:`message-${index}: ${'<> & '.repeat(10000)}`,createdAt:'2026-10-12T14:00:00Z'}));
  const context = f.build(), payload = f.render(context);
  assert.ok(context.transcript.length <= SUPPORT_TICKET_LIMITS.messages); assert.ok(context.transcript.reduce((n,item)=>n+item.text.length,0) <= SUPPORT_TICKET_LIMITS.transcript);
  assert.ok(context.transcript.every(item=>item.text.length<=SUPPORT_TICKET_LIMITS.message)); assert.ok(context.lastCustomerQuestion.length<=SUPPORT_TICKET_LIMITS.question);
  assert.match(context.lastCustomerQuestion,/message-49/); assert.match(context.transcript.at(-1).text,/message-49/); assert.equal(context.transcript.some(item=>item.text.includes('message-0:')),false);
  assert.ok(payload.subject.length<=SUPPORT_TICKET_LIMITS.subject); assert.ok(Buffer.byteLength(payload.html)<45000); assert.ok(Buffer.byteLength(payload.text)<12000); assert.equal(context.transcriptTruncated,true); assert.match(payload.text,/Trecho limitado/);
});

test('razões EN e PT genéricas e automação continuam/pausam sem declarar envio', () => {
  const f = fixture(); f.conversation.supportAssistantHandoff.pauseAutomation = false;
  assert.equal(f.build().automationState,'continue'); assert.match(f.render(f.build()).text,/Continua respondendo/);
  const english = f.build({locale:'en',reason:'knowledge_unavailable'}); assert.match(f.render(english).text,/not enough authorized information/); assert.match(f.render(english).text,/Provided \(not verified\)/);
  f.conversation.supportAssistantHandoff.pauseAutomation = true; assert.match(f.render(f.build()).text,/Pausada para atendimento humano/);
  const unknown = f.build({reason:'future_reason'}); assert.match(unknown.reasonText,/análise da equipe humana/);
  for (const value of [f.render(f.build()).text,f.render(english).text]) assert.doesNotMatch(value,/e-mail enviado|email sent|delivered/i);
});
