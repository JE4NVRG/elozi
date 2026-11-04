import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, t as connectT, markup as connectMarkup} from './i18n.js';
import './locales-operations.js';
// Copy added by P6 (Conectar meu agente, Pendências) lives in its own catalog and goes through connectT/connectMarkup.
import './locales-agent-connect.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function renderAgentAdminProposals(state) {
  if (state.boot?.session?.role !== 'reseller' || state.supportGrantId) return '';
  return i18nHtml`<section class="support-central panel" data-agent-admin-proposals-root><div class="support-central-heading"><div><span class="eyebrow">AGENTES COMO EQUIPE</span><h2>Propostas para a operação</h2><p>Seu agente pode desenhar um fluxo ou sugerir outro agente. Você confere e decide antes de criar.</p></div><span class="badge">Aprovação humana</span></div><div data-agent-proposals-content aria-live="polite"><p class="muted">Carregando propostas…</p></div></section>`;
}
export function agentProposalsMarkup(items) {
  if (!items.length) return connectMarkup('<p class="muted">As propostas recebidas pelo MCP aparecerão aqui. Em Conectar meu agente, a tarefa “Ajudar na gestão” autoriza ler a empresa e propor fluxos e agentes.</p>');
  return `<div class="support-central-grid">${items.slice(0, 40).map(item => i18nHtml`<article class="support-central-connection"><div class="support-central-title"><h3>${escape(item.name)}</h3><span class="badge">${escape({ pending: i18nText('Aguardando decisão'), approved: i18nText('Aprovada'), rejected: i18nText('Recusada'), invalidated: i18nText('Acesso alterado') }[item.state] || i18nText('Indisponível'))}</span></div><p>${escape(item.description || '')}</p><p class="muted">${item.type === 'flow' ? i18nText('Novo fluxograma em rascunho') : i18nText('Novo agente via MCP')} · ${escape(item.serviceName || i18nText('Agente conectado'))}</p><details><summary>Conferir proposta</summary><pre>${escape(JSON.stringify(item.graph || { name: item.name, description: item.description, provider: 'mcp', mode: 'copilot' }, null, 2))}</pre></details>${item.state === 'pending' ? i18nHtml`<div class="modal-actions"><button type="button" class="button primary" data-proposal-id="${escape(item.id)}" data-proposal-version="${Number.isSafeInteger(item.version) ? item.version : 0}" data-proposal-action="approve" ${item.canApprove === true ? '' : 'disabled'}>Aprovar e criar</button><button type="button" class="button" data-proposal-id="${escape(item.id)}" data-proposal-version="${Number.isSafeInteger(item.version) ? item.version : 0}" data-proposal-action="reject">Recusar</button></div>` : ''}<p role="alert" data-proposal-error tabindex="-1" hidden></p></article>`).join('')}</div>`;
}
// Pending proposals as items of Pendências (FRONTEND-V2 §5.3.4, P6): what waits for the administrator,
// newest first as the server lists them, without the graph. Only well-formed pending proposals pass.
export function pendingProposalItems(items) {
  return (Array.isArray(items) ? items : []).filter(item => item && item.state === 'pending' && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(item.id)).slice(0, 40).map(item => ({
    id: item.id, type: item.type === 'flow' ? 'flow' : 'agent', serviceName: String(item.serviceName || '').slice(0, 120),
    title: item.type === 'flow' ? connectT('Novo fluxo “{name}”', { name: String(item.name || '').slice(0, 120) }) : connectT('Novo agente “{name}”', { name: String(item.name || '').slice(0, 120) })
  }));
}
export function bindAgentAdminProposals({ root, tenantId, api, refresh, toast, admin }) {
  const panel = root?.querySelector('[data-agent-admin-proposals-root]'), target = panel?.querySelector('[data-agent-proposals-content]');
  if (admin !== true || !panel || !target || typeof tenantId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(tenantId)) return;
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/agent-admin-proposals`, current = () => panel.isConnected && root.contains(panel);
  api(base).then(result => {
    if (!current()) return; target.innerHTML = agentProposalsMarkup(result.proposals || []);
    for (const button of target.querySelectorAll('[data-proposal-action]')) button.addEventListener('click', async () => {
      if (!current() || button.disabled) return;
      const card = button.closest('article'), buttons = card.querySelectorAll('button'), error = card.querySelector('[data-proposal-error]');
      const previous = Array.from(buttons, item => [item, item.disabled]);
      for (const item of buttons) item.disabled = true; error.hidden = true;
      try {
        const saved = await api(`${base}/${encodeURIComponent(button.dataset.proposalId)}/decide`, { method: 'POST', body: JSON.stringify({ version: Number(button.dataset.proposalVersion), action: button.dataset.proposalAction }) });
        if (saved?.humanApprovalRequired !== true || saved.proposal?.id !== button.dataset.proposalId || saved.proposal.version !== Number(button.dataset.proposalVersion) + 1 || saved.proposal.state !== (button.dataset.proposalAction === 'approve' ? 'approved' : 'rejected') || button.dataset.proposalAction === 'approve' && (!saved.entity?.id || saved.proposal.entityId !== saved.entity.id)) throw Error(i18nText('Não foi possível confirmar a decisão. Atualize antes de tentar novamente.'));
        if (!current()) return; toast(button.dataset.proposalAction === 'approve' ? i18nText('Proposta aprovada. Confira o cadastro criado.') : i18nText('Proposta recusada.')); await refresh();
      } catch (failure) { if (current()) { error.textContent = translateError(failure.message) || i18nText('Não foi possível decidir. Atualize a proposta.'); error.hidden = false; error.focus(); } }
      finally { if (current()) for (const [item, disabled] of previous) item.disabled = disabled; }
    });
  }).catch(error => { if (current()) { target.textContent = translateError(error.message) || i18nText('Não foi possível carregar as propostas.'); target.setAttribute('role', 'alert'); } });
}
