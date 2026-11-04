// Frozen copy of Operations#metrics before the incremental model (tests compare both on randomized data).
const scope = (tenantId, conversation, departmentId) => ({ tenantId, channelId: conversation.channelId, departmentId: departmentId || 'unassigned' });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function referenceMetrics(actor, tenantId, { from, to } = {}) {
  this.permission(actor, 'metrics.read', { tenantId, aggregate: true });
  this.permission(actor, 'inbox.read', { tenantId, aggregate: true });
  const end = to === undefined ? this.now() : Date.parse(to), start = from === undefined ? end - 7 * 86400000 : Date.parse(from);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail(400, 'Escolha um período válido para os indicadores.');
  const inPeriod = value => { const date = Date.parse(value); return Number.isFinite(date) && date >= start && date <= end; };
  const state = this.store.tenant(actor, tenantId), people = new Map(), samples = [];
  const totals = { conversationsReceived: 0, incomingMessages: 0, humanMessages: 0, assignments: 0, transfers: 0, closed: 0, reopened: 0, firstReplies: 0 };
  const person = (id, name) => { if (!id) return null; if (!people.has(id)) people.set(id, { id, name: name || '', assigned: 0, transferred: 0, closed: 0, humanMessages: 0, firstReplies: 0, replySeconds: [] }); const value = people.get(id); if (!value.name && name) value.name = name; return value; };
  const seenEvents = new Set(), seenMessages = new Set(); let recordedEvents = 0;
  for (const conversation of state.conversations) {
    const department = this.currentDepartment(state, conversation);
    if (!this.auth.can(actor, 'inbox.read', scope(tenantId, conversation, department?.id))) continue;
    const messages = (conversation.messages || []).filter(message => { if (message.id && seenMessages.has(message.id)) return false; if (message.id) seenMessages.add(message.id); return true; }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const message of messages) {
      if (!inPeriod(message.createdAt)) continue;
      if (message.kind === 'customer') totals.incomingMessages++;
      if (message.kind === 'human' && !['failed', 'pending', 'unknown', 'unconfirmed'].includes(message.delivery)) {
        totals.humanMessages++; const attendant = person(message.authorUserId, message.authorName); if (attendant) attendant.humanMessages++;
      }
    }
    const customer = messages.find(message => message.kind === 'customer' && Number.isFinite(Date.parse(message.createdAt)));
    if (customer && inPeriod(customer.createdAt)) totals.conversationsReceived++;
    const reply = customer && messages.find(message => message.kind === 'human' && !['failed', 'pending', 'unknown', 'unconfirmed'].includes(message.delivery) && Date.parse(message.createdAt) >= Date.parse(customer.createdAt));
    if (reply && inPeriod(reply.createdAt)) {
      const seconds = (Date.parse(reply.createdAt) - Date.parse(customer.createdAt)) / 1000;
      totals.firstReplies++; samples.push(seconds); const attendant = person(reply.authorUserId, reply.authorName); if (attendant) { attendant.firstReplies++; attendant.replySeconds.push(seconds); }
    }
    for (const event of conversation.attendantEvents || []) {
      if (!event.id || seenEvents.has(event.id)) continue;
      seenEvents.add(event.id); recordedEvents++;
      if (!inPeriod(event.createdAt)) continue;
      if (event.type === 'assignment') {
        totals.assignments++;
        const assigned = person(event.to?.assignedUserId, event.to?.assignedUserName);
        if (assigned) assigned.assigned++;
        if (event.from?.assignedUserId && event.from.assignedUserId !== event.to?.assignedUserId) { totals.transfers++; const attendant = person(event.actorId, event.actorName); if (attendant) attendant.transferred++; }
      }
      if (event.type === 'closed' && ['open', 'pending'].includes(event.from?.status) && event.to?.status === 'closed') { totals.closed++; const attendant = person(event.actorId, event.actorName); if (attendant) attendant.closed++; }
      if (event.type === 'reopened' && event.from?.status === 'closed' && ['open', 'pending'].includes(event.to?.status)) totals.reopened++;
    }
  }
  const average = values => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  return { period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() }, totals, firstReply: { samples: samples.length, averageSeconds: average(samples) }, attendants: [...people.values()].map(({ replySeconds, ...attendant }) => ({ ...attendant, averageFirstReplySeconds: average(replySeconds) })), coverage: { recordedEvents, closureHistory: 'recorded-events-only', humanAttribution: 'recorded-author-only' } };
}
