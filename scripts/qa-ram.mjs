// Instância de QA sintética em RAM: banco ':memory:', transportes externos negados e dados fictícios.
// Não abre o SQLite de produção, não inicia gateway real e não usa credenciais existentes.
// Uso: node scripts/qa-ram.mjs  (QA_PORT=49560, QA_LIVE=1 simula mensagens de clientes a cada ~20 s)
// QA_PUBLIC_ORIGIN=https://elozi.localhost serve o site público (src/public-site.js) em http://elozi.localhost:<porta>;
// o painel continua em http://127.0.0.1:<porta>.
import { createApp } from '../src/server.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.env.QA_PORT || 49560);
const key = randomBytes(32), deny = async () => { throw Error('Transporte externo indisponível na QA sintética.'); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const lastCustomer = context => [...(context.messages || [])].reverse().find(message => message.role === 'user')?.content || '';
const providerCall = async context => {
  await wait(900 + Math.random() * 900);
  if (context.signal?.aborted) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
  const asked = String(lastCustomer(context)).split('\n').at(-1).slice(0, 160);
  return { text: `Olá! Obrigado pela mensagem. Sobre "${asked.replace(/\s+/g, ' ').trim()}": já verifiquei aqui e posso ajudar agora mesmo. Pode me confirmar o número do pedido ou o e-mail do cadastro?`, usage: { prompt_tokens: 812, completion_tokens: 64, total_tokens: 876 } };
};
const app = createApp({ databasePath: ':memory:', publicOrigin: process.env.QA_PUBLIC_ORIGIN || '', serviceKey: key, providerCall, gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, googleOptions: { clientId: '' }, emailOptions: { key, apiKey: '', from: '', fetchImpl: deny } });

const credential = name => ({ username: `qa.${name}`, password: randomBytes(18).toString('base64url') + 'A!9' });
const credentials = { owner: credential('owner') };
const { actor } = await app.auth.setup({ name: 'Jean · QA sintética', ...credentials.owner });
const companies = [
  { name: 'Loja Aurora', segment: 'Varejo e pós-venda' },
  { name: 'Clínica Vita', segment: 'Saúde e agendamentos' }
].map(input => app.store.createTenant(actor, input));
const team = [];
for (const [name, label] of [['bruna', 'Bruna Lima'], ['caio', 'Caio Souza']]) {
  credentials[name] = credential(name);
  team.push(await app.auth.createUser(actor, { name: label, ...credentials[name], role: 'operator', tenantIds: companies.map(company => company.id) }));
}

const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const scripts = [
  ['Marina Alves', 'Oi! Meu pedido #4821 ainda não chegou, consegue verificar?', [['human', 'Olá Marina! Vou conferir agora com a transportadora.'], ['customer', 'Obrigada, aguardo.']], 4, 'open', 'human', 0, 2],
  ['Rafael Costa', 'Vocês têm o tênis Run Pro no tamanho 42?', [], 9, 'open', 'queue', null, 1],
  ['Camila Rocha', 'Quero trocar uma peça que veio com defeito.', [['note', 'Cliente recorrente, priorizar troca expressa.']], 16, 'pending', 'human', 1, 0],
  ['Lucas Martins', 'Qual o prazo de entrega para Curitiba?', [['human', 'Para Curitiba são 3 dias úteis.'], ['customer', 'Perfeito, vou fechar o pedido!']], 42, 'open', 'human', 2, 0],
  ['Beatriz Nunes', 'Posso falar com uma pessoa da equipe?', [], 2, 'open', 'queue', null, 1],
  ['Diego Ferreira', 'Obrigado! Já consegui acessar minha conta.', [['human', 'Que ótimo, Diego! Qualquer coisa estamos aqui.']], 180, 'closed', 'human', 0, 0],
  ['Ana Paula', 'Bom dia, vocês aceitam PIX parcelado?', [], 1, 'open', 'queue', null, 3]
];
for (const [index, company] of companies.entries()) {
  app.store.mutate(actor, company.id, 'QA sintética: dados de demonstração', tenant => {
    tenant.channels = [
      { id: `qa-wa-${index}`, name: index ? 'WhatsApp Recepção' : 'WhatsApp Vendas', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', label: index ? '+55 41 9000-0001 · sintético' : '+55 11 9000-0001 · sintético' },
      { id: `qa-tg-${index}`, name: 'Telegram', kind: 'telegram', transport: 'telegram-bot', state: 'connected', label: '@qa_sintetico_bot' },
      { id: `qa-web-${index}`, name: 'Chat do site', kind: 'webchat', transport: 'elozi-webchat', state: 'configured', label: 'Widget do site' }
    ];
    tenant.departments = [
      { id: `qa-support-${index}`, name: 'Suporte', active: true, memberIds: [actor.userId, ...team.map(user => user.id)] },
      { id: `qa-sales-${index}`, name: 'Vendas', active: true, memberIds: [actor.userId, team[0].id] }
    ];
    tenant.agents = [{ id: `qa-agent-${index}`, name: 'Hermes · Atendimento', provider: 'hermes', mode: 'copilot', state: 'connected', configured: true, version: 1, description: 'Copiloto sintético: prepara rascunhos para revisão humana.', tools: ['conversation.read', 'reply.draft'] }];
    const owners = [actor, ...team];
    tenant.conversations = scripts.map(([contact, question, replies, minutes, status, owner, ownerIndex, unread], position) => {
      const channelId = tenant.channels[position % 3 === 2 ? 1 : 0].id, department = tenant.departments[position % 2];
      const responsible = ownerIndex === null ? null : owners[ownerIndex];
      const start = minutes + replies.length + 1;
      const messages = [{ id: randomUUID(), kind: 'customer', text: question, createdAt: minutesAgo(start) }, ...replies.map(([kind, text], step) => ({ id: randomUUID(), kind, text, createdAt: minutesAgo(start - step - 1), ...(kind === 'human' || kind === 'note' ? { authorUserId: responsible?.userId || actor.userId, authorName: responsible?.name || actor.name, transport: 'synthetic', delivery: 'read' } : {}) }))];
      return { id: `qa-conv-${index}-${position}`, channelId, contact: `${contact}${index ? ' · Vita' : ''}`, initials: contact.split(' ').map(part => part[0]).join('').slice(0, 2), owner, status, version: 1, unread, departmentId: department.id, department: department.name, ...(responsible ? { assignedUserId: responsible.userId || responsible.id, assignedUserName: responsible.name } : {}), tags: position % 2 ? ['Novo contato'] : ['Cliente'], updatedAt: messages.at(-1).createdAt, remoteJid: `55119${String(index)}${String(position).padStart(7, '0')}@s.whatsapp.net`, messages };
    });
  });
  app.gateway.entries.set(`qa-wa-${index}`, { tenantId: company.id, state: 'connected', matched: true });
  app.telegram.entries?.set?.(`qa-tg-${index}`, { tenantId: company.id, state: 'connected' });
}
// Own lines (own-lines.js): the two synthetic WhatsApp lines talk to each other, the agent on one side only.
const ownLines = ['5511990000001', '5541990000001'];
for (const [index, company] of companies.entries()) {
  app.store.db.prepare('INSERT OR IGNORE INTO wa_number_bindings VALUES (?,?,?)').run(ownLines[index], `qa-wa-${index}`, company.id);
  app.store.mutate(actor, company.id, 'QA sintética: conversa entre linhas próprias', tenant => {
    const other = `${ownLines[1 - index]}@s.whatsapp.net`, at = minutesAgo(3), department = tenant.departments[0];
    tenant.channels[0].expectedNumber = ownLines[index];
    tenant.conversations.push({ id: `qa-own-${index}`, channelId: `qa-wa-${index}`, contact: index ? 'Linha da Loja Aurora' : 'Linha da Clínica Vita', initials: 'LP',
      owner: index ? 'queue' : 'agent', ...(index ? {} : { agentId: 'qa-agent-0' }), status: 'open', version: 1, unread: 1, departmentId: department.id, department: department.name,
      tags: [], updatedAt: at, remoteJid: other, remoteAliases: [other], messages: [{ id: randomUUID(), kind: 'customer', text: 'Mensagem de outra linha da operação.', createdAt: at }] });
  });
}

const syntheticSend = async (current, id, cid, input, { reauthorize = () => {} } = {}) => {
  reauthorize();
  return app.store.mutate(current, id, 'QA sintética: resposta registrada', tenant => {
    const conversation = app.store.getConversation(tenant, cid, input.version);
    app.operations.canReply(current, id, conversation);
    conversation.messages.push({ id: randomUUID(), kind: 'human', text: input.text, authorUserId: current.userId, authorName: current.name, transport: 'synthetic', delivery: 'sent', createdAt: new Date().toISOString() });
    conversation.version++; conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
};
app.gateway.send = syntheticSend;
if (app.telegram) app.telegram.send = syntheticSend;

let live;
if (process.env.QA_LIVE === '1') {
  const incoming = ['Alguém pode me ajudar?', 'Acabei de fazer o pagamento.', 'Qual o horário de vocês amanhã?', 'Chegou! Muito obrigado 😊', 'Preciso remarcar minha consulta.'];
  live = setInterval(() => {
    const company = companies[Math.floor(Math.random() * companies.length)];
    app.store.mutate(actor, company.id, 'QA sintética: mensagem recebida', tenant => {
      const open = tenant.conversations.filter(conversation => conversation.status !== 'closed');
      const conversation = open[Math.floor(Math.random() * open.length)];
      if (!conversation) return;
      conversation.messages.push({ id: randomUUID(), kind: 'customer', text: incoming[Math.floor(Math.random() * incoming.length)], createdAt: new Date().toISOString() });
      conversation.version++; conversation.unread = (conversation.unread || 0) + 1; conversation.updatedAt = new Date().toISOString();
    });
  }, 20000);
}

await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
await writeFile(new URL('../.local/qa-ram-auth.json', import.meta.url), JSON.stringify({ origin: `http://127.0.0.1:${port}`, credentials, tenantIds: companies.map(company => company.id) }, null, 2), { mode: 0o600 });
app.server.listen(port, '127.0.0.1', () => console.log(`QA sintética em RAM: http://127.0.0.1:${port} · credenciais em .local/qa-ram-auth.json`));
const stop = async () => {
  clearInterval(live); app.gateway.entries.clear(); app.telegram.entries?.clear?.();
  await Promise.allSettled([app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
  app.server.closeAllConnections(); app.server.close(() => { app.store.close(); process.exit(0); });
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
