import { t, h, translateError } from './i18n.js';
import './locales-account-deletion.js';

// LGPD account deletion. Two steps: a dry run (POST .../delete {dryRun:true}) lists what will be removed, then the
// administrator types the account name and the current password. The server re-checks every guard; the browser only
// mirrors the name confirmation to keep the destructive button disabled until it matches.

export const ACCOUNT_DELETION_MESSAGES = Object.freeze({
  account_delete_forbidden: 'Somente o administrador da própria conta pode excluí-la.',
  account_delete_not_owner: 'Somente o responsável que criou a conta pode excluí-la.',
  account_delete_checkout_open: 'Há um pagamento em andamento para esta conta. Aguarde o link de pagamento expirar ou conclua o pagamento e cancele a assinatura antes de excluir.',
  account_delete_invalid_id: 'Identificador de conta inválido.',
  account_delete_platform: 'A conta da plataforma e seus produtos não podem ser excluídos.',
  account_delete_has_children: 'Esta conta tem contas de clientes vinculadas. Remova ou transfira essas contas antes de excluir.',
  account_delete_subscription_active: 'Cancele a assinatura em Configurações > Financeiro antes de excluir a conta.',
  account_delete_contract_active: 'Esta conta tem um contrato comercial ativo. Encerre o contrato com o comercial antes de excluir.',
  account_delete_shared_user: 'Há usuários desta conta com acesso a outros workspaces. Retire esses acessos antes de excluir.',
  account_delete_name_mismatch: 'O nome digitado não corresponde ao nome da conta.',
  account_delete_password_invalid: 'Senha atual incorreta.',
  account_delete_password_unavailable: 'Sua conta entra com Google e não tem senha. Use "Esqueci minha senha" para criar uma e tente novamente.',
  account_delete_integrity: 'A exclusão foi cancelada para preservar a integridade dos dados.',
  account_delete_reconnect_required: 'A exclusão não foi concluída. Os canais desta conta já foram desconectados e precisam ser reconectados.'
});

/** Honest backup statement: existing backups are not erased at once (rotation, see src/backup.js) and are never restored for deleted accounts. */
export const ACCOUNT_DELETION_BACKUP_NOTICE = 'Cópias de segurança já feitas não são apagadas na hora: ficam guardadas por tempo limitado, até serem substituídas ou descartadas, e não são restauradas para contas excluídas.';
export function deletionEndpoint(mode, workspaceId) {
  if (mode === 'platform') {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new TypeError('Conta inválida.');
    return `/api/platform/accounts/${encodeURIComponent(workspaceId)}/delete`;
  }
  return '/api/account/delete';
}
const normalize = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR') : '';
/** Same comparison as the server: trimmed, collapsed spaces, case-insensitive. */
export function namesMatch(typed, name) { return Boolean(normalize(name)) && normalize(typed) === normalize(name); }
export function deletionErrorMessage(error) {
  if (error?.status === 429) return t('Muitas tentativas de exclusão. Aguarde um minuto.');
  // A failure after the channels were stopped arrives as account_delete_reconnect_required (error code, not text).
  const known = ACCOUNT_DELETION_MESSAGES[error?.code];
  if (known) return t(known);
  return error?.message ? translateError(error.message) : t('Não foi possível excluir a conta. Tente novamente.');
}
/** Localized lines for the dry-run counts; zero counts are omitted except companies. */
export function countLines(counts = {}) {
  const lines = [['tenants', '{count} empresas'], ['channels', '{count} canais'], ['conversations', '{count} conversas'], ['contacts', '{count} contatos'],
    ['users', '{count} usuários'], ['sessions', '{count} sessões abertas'], ['invitations', '{count} convites'], ['servicePrincipals', '{count} identidades de serviço']]
    .filter(([key]) => key === 'tenants' || Number(counts[key]) > 0).map(([key, copy]) => t(copy, { count: Number(counts[key]) || 0 }));
  if (Number(counts.unlinkedUsers) > 0) lines.push(t('{count} acessos de outras contas serão apenas desvinculados', { count: Number(counts.unlinkedUsers) }));
  return lines;
}
/** Owner-only eligibility: account admin of a directly billed company, outside support/platform sessions. */
export function ownerEligible(boot, { supportGrantId = null, platformWorkspaceId = 'mep-demo' } = {}) {
  const session = boot?.session || {}, reseller = boot?.reseller || {};
  return session.role === 'reseller' && !supportGrantId && !session.platformOwner && reseller.accountKind === 'business' && reseller.parentWorkspaceId === platformWorkspaceId;
}
export function ownerSectionMarkup() {
  return String(h`<section class="pg-settings__section" aria-labelledby="account-deletion-title" data-account-deletion><h2 class="pg-settings__section-title" id="account-deletion-title">${t('Excluir conta')}</h2>
    <p class="pg-settings__muted">${t('Remove definitivamente a conta, as empresas, canais, conversas, contatos e usuários exclusivos dela. Não pode ser desfeito.')}</p>
    <p class="pg-settings__muted" data-account-deletion-backups>${t(ACCOUNT_DELETION_BACKUP_NOTICE)}</p>
    <div class="pg-settings__cluster"><button type="button" class="ui-btn ui-btn--danger ui-btn--md" data-action="account-deletion:open" data-account-deletion-open>${t('Excluir esta conta')}</button></div></section>`);
}
export function dialogMarkup({ mode = 'self', name = '', counts = {} } = {}) {
  return String(h`<form class="pg-settings__form" data-account-deletion-form novalidate>
    <h3 class="pg-settings__h3">${t('Será excluído')}</h3><ul class="pg-settings__list" data-account-deletion-counts>${countLines(counts).map(line => h`<li class="pg-settings__sub">${line}</li>`)}</ul>
    <p class="pg-settings__hint">${t('Os canais de WhatsApp e Telegram serão desconectados. Esta ação não pode ser desfeita.')}</p>
    <p class="pg-settings__hint" data-account-deletion-backups>${t(ACCOUNT_DELETION_BACKUP_NOTICE)}</p>
    <label class="pg-settings__field">${t('Digite o nome da conta para confirmar')} <strong>${name}</strong><input class="pg-settings__input" name="confirmName" autocomplete="off" required data-account-deletion-name></label>
    <label class="pg-settings__field">${mode === 'platform' ? t('Sua senha de administrador da plataforma') : t('Senha atual')}<input class="pg-settings__input" name="password" type="password" autocomplete="current-password" required></label>
    <p class="form-error" role="alert" data-account-deletion-error></p>
    <div class="pg-settings__cluster"><button type="submit" class="ui-btn ui-btn--danger ui-btn--md" data-account-deletion-confirm disabled>${t('Excluir definitivamente')}</button></div></form>`);
}

/** Wires the dialog. request(path, {method, body}) is the panel API helper (throws with status/code). */
export function createAccountDeletionUI({ request, openModal, getModal = () => globalThis.document?.querySelector('#modal'), toast = () => {}, onDeleted = () => {} } = {}) {
  let busy = false;
  async function open({ mode = 'self', workspaceId = null, name = '' } = {}) {
    if (busy) return;
    const path = deletionEndpoint(mode, workspaceId);
    let preview;
    try { preview = await request(path, { method: 'POST', body: JSON.stringify({ dryRun: true }) }); }
    catch (error) { toast(deletionErrorMessage(error), true); return; }
    const accountName = preview?.name || name;
    openModal(t('Excluir conta'), accountName, dialogMarkup({ mode, name: accountName, counts: preview?.counts }));
    const form = getModal()?.querySelector?.('[data-account-deletion-form]');
    if (!form) return;
    const confirm = form.querySelector('[data-account-deletion-confirm]'), error = form.querySelector('[data-account-deletion-error]');
    form.addEventListener('input', () => { confirm.disabled = busy || !namesMatch(form.elements.confirmName.value, accountName) || !form.elements.password.value; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !namesMatch(form.elements.confirmName.value, accountName)) return;
      busy = true; confirm.disabled = true; confirm.textContent = t('Excluindo…'); error.textContent = '';
      try {
        const result = await request(path, { method: 'POST', body: JSON.stringify({ confirmName: form.elements.confirmName.value, password: form.elements.password.value }) });
        form.elements.password.value = '';
        toast(t('Conta excluída.'));
        await onDeleted({ mode, workspaceId: result?.workspaceId || workspaceId, result });
      } catch (failure) {
        error.textContent = deletionErrorMessage(failure); confirm.textContent = t('Excluir definitivamente');
        confirm.disabled = !namesMatch(form.elements.confirmName.value, accountName);
      } finally { busy = false; }
    });
  }
  return { open, ownerSectionMarkup };
}
/** Where the browser goes after deleting its own account; keeps the English locale. */
export function afterSelfDeletionUrl(locale) { return locale === 'en' ? '/login?deleted=1&lang=en' : '/login?deleted=1'; }
