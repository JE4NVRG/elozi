import { boundConversationContact } from './contacts.js';

export const SUPPORT_TICKET_LIMITS = Object.freeze({ label: 160, question: 1200, message: 600, transcript: 3600, messages: 8, subject: 240 });
const reject = () => { throw Object.assign(new Error('Contexto do atendimento não pertence à transferência autorizada.'), { status: 409 }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const html = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clip = (value, max) => value.length > max ? value.slice(0, max - 1).toWellFormed() + '…' : value;

// Never serialize operational JSON. Also redact common credentials pasted into public messages.
function display(value, max, multiline = false) {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, max * 8).toWellFormed()
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;<>]+/gi, '[credencial omitida]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[link omitido]')
    .replace(/\b(?:ms_|sk_)[A-Za-z0-9_-]{12,}/g, '[credencial omitida]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credencial omitida]')
    .replace(/\b(?:identityToken|mep_session|password|passwd|senha|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|client[_ -]?secret|private[_ -]?key|service[_ -]?key|secret|segredo|authorization|cookie|challenge)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi, '[credencial omitida]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[valor sensível omitido]')
    .replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => multiline && character === '\n' ? '\n' : ' ');
  return clip((multiline ? text.replace(/[^\S\n]+/g, ' ') : text.replace(/\s+/g, ' ')).trim(), max);
}

export function supportReplyAddress(value) {
  // Do not repair controls, whitespace or malformed source addresses into a valid Reply-To.
  if (typeof value !== 'string' || value.length > 254 || /[\s\p{Cc}\p{Cf}<>]/u.test(value)) return null;
  const email = value.toLowerCase(), parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.') || email.includes('..')) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) && parts[1].split('.').every(label => label.length <= 63) ? email : null;
}

function timestamp(value) {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function authorizedOrigin(value, channel) {
  // The current gateway persists a validated origin, not a page URL. Never infer a page from widget/visitor JSON.
  if (typeof value !== 'string' || value.length > 240 || /[\p{Cc}\p{Cf}\s]/u.test(value) || !channel.webchat?.origins?.includes(value)) return null;
  try {
    const url = new URL(value), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.origin === value && !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && local) ? value : null;
  } catch { return null; }
}

const REASONS = Object.freeze({
  agent_requested_human: ['O assistente solicitou revisão de um ponto pela equipe de suporte.', 'The assistant requested review of a point by the support team.'],
  visitor_requested_human: ['O visitante solicitou atendimento humano.', 'The visitor requested human support.'],
  human_in_charge: ['O atendimento já está sob responsabilidade da equipe humana.', 'The human team is already in charge.'],
  knowledge_unavailable: ['Não há informação autorizada suficiente para responder com segurança.', 'There is not enough authorized information to answer safely.'],
  media_needs_human: ['O conteúdo enviado precisa de análise da equipe humana.', 'The submitted content needs human review.'],
  draft_needs_human: ['A resposta preparada precisa de revisão humana.', 'The prepared reply needs human review.'],
  invalid_draft: ['A resposta preparada não passou pela validação de segurança.', 'The prepared reply did not pass safety validation.'],
  preparation_failed: ['Não foi possível preparar uma resposta automática; a equipe precisa continuar.', 'An automatic reply could not be prepared; the team needs to continue.'],
  sender_unavailable: ['O envio automático está indisponível; a equipe precisa continuar.', 'Automatic sending is unavailable; the team needs to continue.'],
  limit_reached: ['O limite de preparação automática foi atingido; o atendimento foi preservado.', 'The automatic preparation limit was reached; the conversation was preserved.'],
  context_changed: ['O contexto do atendimento mudou e exige revisão humana.', 'The conversation context changed and needs human review.'],
  interrupted: ['A preparação automática foi interrompida.', 'Automatic preparation was interrupted.'],
  preparation_timeout: ['A preparação automática excedeu o prazo.', 'Automatic preparation timed out.'],
  quiet_hours: ['O envio automático está pausado pelo horário de atendimento.', 'Automatic sending is paused outside support hours.'],
  timeout: ['A preparação automática excedeu o prazo.', 'Automatic preparation timed out.'],
  send_failed: ['O envio da resposta automática não foi confirmado.', 'The automatic reply was not confirmed.'],
  send_unknown: ['Não foi possível confirmar o envio da resposta automática.', 'The automatic reply could not be confirmed.']
});

/** Synchronous, whitelist-only snapshot of fresh authorized records. identityVerified is an internal gateway proof, never visitor input. */
export function buildSupportTicketContext({ tenantId, channelId, conversationId, jobId, reason, records, now = new Date().toISOString(), locale = 'pt-BR' } = {}) {
  const { tenant, channel, conversation, identityVerified = false, sourceOrigin } = records || {};
  if (![tenantId, channelId, conversationId, jobId, reason].every(identifier) || tenant?.id !== tenantId || channel?.id !== channelId || conversation?.id !== conversationId
    || conversation.channelId !== channelId || !Array.isArray(tenant.channels) || !Array.isArray(tenant.conversations)
    || tenant.channels.find(item => item.id === channelId) !== channel || tenant.conversations.find(item => item.id === conversationId) !== conversation) reject();
  let contact = null;
  try { contact = boundConversationContact(tenant, conversation); } catch { /* An ambiguous/stale CRM link is not authority to disclose that contact. */ }
  const visitor = conversation.webchatVisitor, visitorEmail = supportReplyAddress(visitor?.email), replyEmail = visitorEmail || supportReplyAddress(contact?.email);
  const emailStatus = !replyEmail ? 'unavailable' : visitorEmail && visitor?.verified === true && identityVerified === true ? 'verified' : 'provided';
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [], recent = [];
  let lastCustomerQuestion = '', truncated = false, total = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!['customer', 'human', 'agent'].includes(message?.kind)) continue;
    // Do not export an operator/agent draft that was never made visible to the visitor.
    if (message.kind !== 'customer' && message.delivery && !['sent', 'confirmed'].includes(message.delivery)) continue;
    if (!lastCustomerQuestion && message.kind === 'customer') lastCustomerQuestion = display(message.text, SUPPORT_TICKET_LIMITS.question, true) || (locale === 'en' ? '[Message without text]' : '[Mensagem sem texto]');
    if (recent.length >= SUPPORT_TICKET_LIMITS.messages) { truncated = true; if (lastCustomerQuestion) break; continue; }
    const text = display(message.text, SUPPORT_TICKET_LIMITS.message, true) || (locale === 'en' ? '[Message without text]' : '[Mensagem sem texto]');
    const remaining = SUPPORT_TICKET_LIMITS.transcript - total;
    if (remaining <= 0) { truncated = true; if (lastCustomerQuestion) break; continue; }
    const excerpt = clip(text, remaining);
    truncated ||= excerpt !== text || typeof message.text === 'string' && message.text.length > text.length;
    recent.push({ kind: message.kind, text: excerpt, createdAt: timestamp(message.createdAt) }); total += excerpt.length;
  }
  const english = locale === 'en';
  return Object.freeze({ tenantId, channelId, conversationId, jobId, locale: english ? 'en' : 'pt-BR',
    companyName: display(tenant.name, SUPPORT_TICKET_LIMITS.label) || (english ? 'Company not provided' : 'Empresa não informada'),
    channelName: display(channel.name, SUPPORT_TICKET_LIMITS.label) || display(channel.webchat?.widget?.displayName, SUPPORT_TICKET_LIMITS.label) || (english ? 'Channel not provided' : 'Canal não informado'),
    visitorName: display(visitor?.name, SUPPORT_TICKET_LIMITS.label) || display(contact?.name, SUPPORT_TICKET_LIMITS.label) || display(conversation.contact, SUPPORT_TICKET_LIMITS.label) || (english ? 'Not provided' : 'Não informado'),
    contactId: identifier(contact?.id) ? contact.id : null, replyEmail, emailStatus, sourceOrigin: authorizedOrigin(sourceOrigin, channel),
    reasonCode: reason, reasonText: REASONS[reason]?.[english ? 1 : 0] || (english ? 'The conversation needs human review.' : 'O atendimento precisa de análise da equipe humana.'),
    automationState: conversation.supportAssistantHandoff?.pauseAutomation === false ? 'continue' : 'pause',
    requestedAt: timestamp(conversation.supportAssistantHandoff?.requestedAt) || timestamp(now), lastCustomerQuestion,
    transcript: Object.freeze(recent.reverse().map(Object.freeze)), transcriptTruncated: truncated });
}

export function renderSupportTicketEmail(context, { from, email, link }) {
  const english = context.locale === 'en', missing = english ? 'Not available' : 'Não disponível';
  const caption = english ? 'A conversation needs your attention' : 'Um atendimento precisa de você';
  const labels = english
    ? { ticket: 'Ticket / conversation', company: 'Company', channel: 'Channel', visitor: 'Visitor / contact', contact: 'Contact ID', reply: 'Reply email', origin: 'Authorized source origin', time: 'Requested at (UTC)', reason: 'Reason', automation: 'Automation', question: 'Latest customer message', transcript: 'Recent conversation', action: 'Open conversation', cut: 'Bounded excerpt; open the conversation for the full history.' }
    : { ticket: 'Ticket / conversa', company: 'Empresa', channel: 'Canal', visitor: 'Visitante / contato', contact: 'ID do contato', reply: 'E-mail para resposta', origin: 'Origem autorizada', time: 'Solicitado em (UTC)', reason: 'Motivo', automation: 'Automação', question: 'Última mensagem do cliente', transcript: 'Conversa recente', action: 'Abrir atendimento', cut: 'Trecho limitado; abra o atendimento para consultar o histórico completo.' };
  const status = english ? { verified: 'Verified identity', provided: 'Provided (not verified)', unavailable: 'Not available' } : { verified: 'Identidade verificada', provided: 'Informado (não verificado)', unavailable: 'Não disponível' };
  const rows = [[labels.ticket, context.conversationId], [labels.company, `${context.companyName} (${context.tenantId})`], [labels.channel, `${context.channelName} (${context.channelId})`],
    [labels.visitor, context.visitorName], ...(context.contactId ? [[labels.contact, context.contactId]] : []), [labels.reply, `${context.replyEmail || missing} — ${status[context.emailStatus]}`],
    ...(context.sourceOrigin ? [[labels.origin, context.sourceOrigin]] : []), [labels.time, context.requestedAt || missing], [labels.reason, `${context.reasonText} (${context.reasonCode})`],
    [labels.automation, context.automationState === 'continue' ? english ? 'Continues answering until the human team takes over' : 'Continua respondendo até a equipe humana assumir' : english ? 'Paused for human support' : 'Pausada para atendimento humano']];
  const speakers = english ? { customer: 'Customer', human: 'Human team', agent: 'Assistant' } : { customer: 'Cliente', human: 'Equipe humana', agent: 'Assistente' };
  const transcript = context.transcript.map(message => `${message.createdAt ? `[${message.createdAt}] ` : ''}${speakers[message.kind]}: ${message.text}`);
  const question = context.lastCustomerQuestion || missing, recent = transcript.length ? transcript.join('\n\n') : missing;
  const subject = clip(`${english ? 'Support' : 'Suporte'} ${context.companyName} · ${context.channelName} — ${context.conversationId}`, SUPPORT_TICKET_LIMITS.subject);
  return { from, to: [email], ...(supportReplyAddress(context.replyEmail) ? { reply_to: context.replyEmail } : {}), subject,
    text: `${caption}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${labels.question}:\n${question}\n\n${labels.transcript}:\n${recent}\n${context.transcriptTruncated ? `\n${labels.cut}\n` : ''}\n${labels.action}: ${link}`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h1>${html(caption)}</h1>${rows.map(([label, value]) => `<p><strong>${html(label)}:</strong> ${html(value)}</p>`).join('')}<h2>${html(labels.question)}</h2><p style="white-space:pre-wrap">${html(question)}</p><h2>${html(labels.transcript)}</h2><div style="white-space:pre-wrap">${html(recent)}</div>${context.transcriptTruncated ? `<p>${html(labels.cut)}</p>` : ''}<p><a href="${html(link)}">${html(labels.action)}</a></p></div>` };
}
