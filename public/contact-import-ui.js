import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
import './locales-operations.js';

const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 100;
const whatsapp = channel => ['whatsapp_qr', 'whatsapp_cloud'].includes(channel?.kind);
const contextKey = context => JSON.stringify([context?.userId, context?.workspaceId, context?.tenantId]);
const bytes = content => new TextEncoder().encode(content).byteLength;
const field = (form, name) => form?.elements?.namedItem?.(name) || form?.querySelector?.(`[name="${name}"]`);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const statusNames = i18nLabels({ valid: 'Novo', review: 'Revisar telefone', duplicate: 'Duplicado', conflict: 'Conflito', invalid: 'Inválido' });
const ready = counts => number(counts?.valid) + number(counts?.review);

/** Private, short-lived import UI. No contact body is stored outside this module's RAM. */
export function createContactImportUI({ getContext, request, openModal, escape: e, icon = () => '', refresh = async () => {}, toast = () => {} }) {
  if (![getContext, request, openModal, e].every(value => typeof value === 'function')) throw new TypeError(i18nText('Importação exige contexto, API e modal.'));
  let session = null, generation = 0, sequence = 0, closeBinding = null;
  const allowed = (context, channelId) => typeof context?.canWrite === 'function' ? context.canWrite(channelId) === true : context?.canWrite === true;
  const channels = context => (Array.isArray(context?.channels) ? context.channels : []).filter(channel => whatsapp(channel) && typeof channel.id === 'string' && allowed(context, channel.id));
  const host = () => typeof document === 'undefined' ? null : document.querySelector('[data-contact-import-host]');
  const validContext = context => typeof context?.workspaceId === 'string' && Boolean(context.workspaceId) && typeof context?.tenantId === 'string' && Boolean(context.tenantId);

  function reset() {
    generation++; sequence++; session = null;
    if (closeBinding) { closeBinding.dialog.removeEventListener?.('close', closeBinding.listener); closeBinding = null; }
    const target = host();
    if (target) target.innerHTML = i18nMarkup('<p role="status">A importação foi fechada. Abra novamente na empresa desejada.</p>');
  }
  function current(operation) {
    const context = getContext();
    return Boolean(session && operation.generation === generation && operation.sequence === sequence && session.key === contextKey(context) && validContext(context) && session.channelId === operation.channelId && channels(context).some(channel => channel.id === operation.channelId));
  }
  function stale(operation) {
    if (current(operation)) return false;
    if (session && operation.generation === generation && operation.sequence === sequence) reset();
    return true;
  }
  const formatted = value => number(value).toLocaleString(getLocale());
  function totals(counts, complete = false) {
    const items = complete ? [[counts.imported, i18nText('importados (total)')], [counts.reviewImported, i18nText('deles para revisão')], [counts.duplicate, i18nText('duplicados preservados')], [counts.conflict, i18nText('conflitos preservados')], [counts.invalid, i18nText('inválidos ignorados')]] : [[counts.valid, i18nText('novos com telefone')], [counts.review, i18nText('para revisão')], [counts.duplicate, i18nText('duplicados')], [counts.conflict, i18nText('conflitos')], [counts.invalid, i18nText('inválidos')]];
    return `<dl class="pg-settings__summary-list" data-contact-import-counts>${items.map(([value, label]) => `<div><dt>${label}</dt><dd>${formatted(value)}</dd></div>`).join('')}</dl>`;
  }
  function resultMarkup() {
    if (!session) return '';
    if (session.receipt) return i18nHtml`<section class="pg-settings__stack" aria-label="Resultado da importação"><h3 class="pg-settings__h3">Importação concluída</h3>${totals(session.receipt, true)}<p class="pg-settings__text">Os cadastros anteriores foram preservados. Nenhuma mensagem foi enviada e nenhum atendimento foi aberto.</p><div class="pg-settings__dialog-actions"><button type="button" class="ui-btn ui-btn--primary ui-btn--md" data-close-modal>Concluir ${icon('check')}</button></div></section>`;
    const preview = session.preview;
    if (!preview) return i18nMarkup('<p class="pg-settings__muted">A prévia confere os dados antes de criar os contatos.</p>');
    const rows = preview.rows.slice(0, PREVIEW_ROWS);
    const reviewNotice = preview.counts.review ? i18nHtml`<div class="pg-settings__note" role="note">${icon('shield')}<span>${formatted(preview.counts.review)} contatos serão preservados para revisão, sem telefone válido e sem identidade de canal. O telefone original ficará nas notas, com a etiqueta Revisar telefone.</span></div>` : '';
    return i18nHtml`<section class="pg-settings__stack" aria-label="Prévia dos contatos"><h3 class="pg-settings__h3">Confira antes de importar</h3>${totals(preview.counts)}${reviewNotice}<p class="pg-settings__muted">${formatted(preview.counts.total)} registros analisados${preview.truncated || preview.counts.total > rows.length ? i18nTemplate` · exibindo os primeiros ${formatted(rows.length)}` : ''}.</p><div class="pg-settings__table-wrap pg-settings__import-preview" tabindex="0" role="region" aria-label="Registros da prévia"><table class="pg-settings__table"><thead><tr><th scope="col">Situação</th><th scope="col">Contato</th><th scope="col">Telefone</th><th scope="col">Detalhe</th></tr></thead><tbody>${rows.map(row => `<tr><td><span class="ui-badge ui-badge--${row.status === 'valid' ? 'success' : ['review', 'invalid', 'conflict'].includes(row.status) ? 'warning' : 'neutral'}">${e(statusNames[row.status] || i18nText('Inválido'))}</span></td><td><strong>${e(row.name || i18nText('Sem nome'))}</strong>${row.email ? `<small class="pg-settings__sub">${e(row.email)}</small>` : ''}${Array.isArray(row.tags) && row.tags.length ? `<small class="pg-settings__sub">${e(row.tags.join(' · '))}</small>` : ''}</td><td>${e(row.phone || (row.status === 'review' ? i18nText('Sem telefone válido') : '—'))}${row.status === 'review' ? i18nHtml`<small class="pg-settings__sub">Original: ${e(row.originalPhone || '(vazio)')}</small>` : ''}</td><td>${e(row.reason || i18nText('Pronto para cadastrar.'))}${row.status === 'review' ? i18nHtml`<details class="pg-settings__details"><summary>Notas preservadas</summary><p class="pg-settings__muted pg-settings__pre">${e(row.notes || '')}</p></details>` : ''}</td></tr>`).join('') || i18nMarkup('<tr><td colspan="4">Nenhum registro nesta prévia.</td></tr>')}</tbody></table></div><p class="pg-settings__hint">Duplicados, conflitos e os demais inválidos são ignorados. Os contatos atuais continuam preservados.</p><form data-contact-import-form="apply" data-contact-import-session="${generation}" aria-busy="${session.busy}"><div class="pg-settings__dialog-actions"><button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal ${session.busy ? 'disabled' : ''}><span class="ui-btn__label">Cancelar</span></button><button type="submit" class="ui-btn ui-btn--primary ui-btn--md" ${session.busy || !ready(preview.counts) ? 'disabled' : ''}><span class="ui-btn__label">${session.busy ? i18nText('Importando…') : i18nTemplate`Confirmar importação de ${formatted(ready(preview.counts))}`}</span> ${icon('check')}</button></div></form></section>`;
  }
  function markup() {
    const context = getContext(), eligible = channels(context), disabled = session.busy ? 'disabled' : '';
    return i18nHtml`<div class="pg-settings__dialog" data-contact-import-host data-contact-import-session="${generation}"><div class="pg-settings__note">${icon('users')}<span>Importe separadamente cada canal de origem da agenda. O canal abaixo será o destino destes contatos.</span></div><p class="form-error pg-settings__error" data-contact-import-error role="alert">${e(translateError(session.error))}</p><p class="pg-settings__status" data-contact-import-status role="status" aria-live="polite">${e(translateCopy(session.status))}</p>${session.receipt ? '' : i18nHtml`<form class="pg-settings__form" data-contact-import-form="preview" data-contact-import-session="${generation}" aria-busy="${session.busy}"><label class="pg-settings__field">Canal de destino nesta empresa<select class="pg-settings__input" name="channelId" required ${disabled}><option value="">Selecione o canal correspondente à origem</option>${eligible.map(channel => `<option value="${e(channel.id)}" ${session.channelId === channel.id ? 'selected' : ''}>${e(channel.name || channel.id)}</option>`).join('')}</select></label><label class="pg-settings__field">Arquivo CSV ou JSON<input class="pg-settings__input" name="file" type="file" accept=".csv,.json,text/csv,application/json" ${disabled}/><small class="pg-settings__hint" data-contact-import-file>${e(session.file?.name || i18nText('Até 5 MiB e 10.000 registros por arquivo.'))}</small></label><p class="pg-settings__hint">CSV com nome e telefone/número. E-mail, notas e etiquetas são opcionais.</p><details class="pg-settings__details" ${session.content ? 'open' : ''}><summary>Ou colar uma lista JSON</summary><label class="pg-settings__field">Contatos em JSON<textarea class="pg-settings__input" name="content" rows="5" maxlength="${MAX_BYTES}" spellcheck="false" placeholder='[{"name":"Nome","phone":"DDD e telefone"}]' ${disabled}>${e(session.content)}</textarea><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm pg-settings__agenda" data-action="contact-import-agenda" ${disabled}>Usar a agenda do WhatsApp deste canal</button></label></details><label class="pg-settings__check"><input type="checkbox" name="preserveInvalid" ${session.preserveInvalid ? 'checked' : ''} ${disabled}/>Preservar telefones inválidos como contatos para revisão</label><p class="pg-settings__hint">Exige referência estável da origem (sourceRef) no arquivo e acesso completo aos contatos da empresa.</p><div class="pg-settings__dialog-actions"><button type="submit" class="ui-btn ui-btn--${session.preview ? 'secondary' : 'primary'} ui-btn--md" ${disabled}><span class="ui-btn__label">${session.busy ? i18nText('Analisando…') : session.preview ? i18nText('Gerar nova prévia') : i18nText('Gerar prévia')}</span> ${icon('search')}</button></div></form>`}<div data-contact-import-result>${resultMarkup()}</div></div>`;
  }
  function paint() {
    if (!session) return;
    const target = host();
    if (target && target.dataset?.contactImportSession === String(generation)) {
      const dialog = target.closest?.('dialog');
      if (dialog && !dialog.open) return;
      // Replace only this module's owned contents, retaining the shared dialog heading.
      const html = markup();
      target.outerHTML = html;
    } else openModal(i18nText('Importar contatos'), i18nText('Revise a agenda e confirme o canal de destino.'), markup());
  }
  // The saved contacts of the chosen WhatsApp channel (Canais › Agenda) become the JSON list; the preview reviews them as usual.
  async function useAgenda() {
    if (!session || session.busy || session.receipt) return;
    const context = getContext(), channelId = session.channelId || String(field(host()?.querySelector('[data-contact-import-form]'), 'channelId')?.value || '');
    if (!channelId) { session.error = i18nText('Escolha o canal WhatsApp de destino antes de usar a agenda.'); paint(); return; }
    session.channelId = channelId;
    const operation = { generation, sequence: ++sequence, channelId, workspaceId: context?.workspaceId, tenantId: context?.tenantId };
    if (stale(operation)) return;
    session.busy = true; session.error = ''; session.status = i18nText('Lendo a agenda do WhatsApp…'); paint();
    try {
      const book = await request(`/api/tenants/${encodeURIComponent(operation.tenantId)}/channels/${encodeURIComponent(channelId)}/address-book`, { headers: { 'X-Elozi-Workspace': operation.workspaceId } });
      if (stale(operation)) return;
      const rows = Array.isArray(book?.rows) ? book.rows.filter(row => row && typeof row.name === 'string' && typeof row.phone === 'string') : [];
      if (!rows.length) throw Error(i18nText('A agenda deste WhatsApp ainda está vazia. Use Canais › Agenda para sincronizar e tente de novo.'));
      session.content = JSON.stringify(rows); session.file = null;
      session.status = i18nTemplate`${formatted(rows.length)} contatos da agenda prontos. Gere a prévia para revisar antes de importar.`;
    } catch (error) {
      if (stale(operation)) return;
      session.error = translateError(error?.message || ''); session.status = '';
    } finally {
      if (current(operation)) { session.busy = false; paint(); }
    }
  }
  function changed() {
    sequence++; session.preview = null; session.error = ''; session.status = ''; session.receipt = null;
    const target = host();
    if (!target) return;
    const result = target.querySelector('[data-contact-import-result]'); if (result) result.innerHTML = resultMarkup();
    const error = target.querySelector('[data-contact-import-error]'); if (error) error.textContent = '';
    const status = target.querySelector('[data-contact-import-status]'); if (status) status.textContent = '';
    const label = target.querySelector('[data-contact-import-file]'); if (label) label.textContent = session.file?.name || i18nText('Até 5 MiB e 10.000 registros por arquivo.');
  }
  function open() {
    reset();
    const context = getContext();
    if (!validContext(context) || !channels(context).length) { toast(i18nText('Seu acesso não possui canal WhatsApp disponível para importar contatos.'), true); return false; }
    session = { key: contextKey(context), channelId: '', file: null, content: '', preserveInvalid: false, preview: null, receipt: null, busy: false, error: '', status: '' };
    paint();
    const dialog = host()?.closest?.('dialog');
    if (dialog?.addEventListener) {
      const listener = () => reset(); dialog.addEventListener('close', listener); closeBinding = { dialog, listener };
    }
    return true;
  }
  function owns(form) { return Boolean(form?.dataset?.contactImportForm && ['preview', 'apply'].includes(form.dataset.contactImportForm)); }
  function sameForm(form) { return session && form.dataset.contactImportSession === String(generation) && form.isConnected !== false; }
  function fileValid(file) {
    if (!file || typeof file.text !== 'function' || !/\.(csv|json)$/i.test(file.name || '')) throw Error(i18nText('Escolha um arquivo CSV ou JSON.'));
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) throw Error(i18nText('O arquivo deve ter até 5 MiB.'));
  }
  function handleChange(event) {
    const target = event?.target, form = target?.form || target?.closest?.('[data-contact-import-form]');
    if (!owns(form) || !['channelId', 'file', 'content', 'preserveInvalid'].includes(target?.name)) return false;
    if (!sameForm(form) || session.busy) return true;
    if (session.key !== contextKey(getContext())) { reset(); return true; }
    if (target.name === 'channelId') session.channelId = String(target.value || '');
    if (target.name === 'preserveInvalid') session.preserveInvalid = target.checked === true;
    if (target.name === 'content') {
      session.content = String(target.value || '');
      if (session.content) { session.file = null; const input = field(form, 'file'); if (input) input.value = ''; }
    }
    if (target.name === 'file') {
      session.file = target.files?.[0] || null;
      if (session.file) { session.content = ''; const input = field(form, 'content'); if (input) input.value = ''; }
    }
    changed();
    if (session.file) try { fileValid(session.file); } catch (error) { session.error = translateError(error.message); const node = host()?.querySelector('[data-contact-import-error]'); if (node) node.textContent = translateError(error.message); }
    return true;
  }
  async function submit(form) {
    if (!owns(form)) return false;
    if (!sameForm(form)) { toast(i18nText('Abra novamente a importação nesta empresa.'), true); return true; }
    if (session.busy || session.receipt) return true;
    const applying = form.dataset.contactImportForm === 'apply';
    if (!applying) {
      session.channelId = String(field(form, 'channelId')?.value || session.channelId || '');
      session.content = String(field(form, 'content')?.value ?? session.content);
      session.file = field(form, 'file')?.files?.[0] || session.file;
      session.preserveInvalid = field(form, 'preserveInvalid') ? field(form, 'preserveInvalid').checked === true : session.preserveInvalid;
      session.preview = null;
    }
    const operation = { generation, sequence: ++sequence, channelId: session.channelId, preserveInvalid: session.preserveInvalid, workspaceId: getContext()?.workspaceId, tenantId: getContext()?.tenantId };
    if (stale(operation)) { toast(i18nText('Confira seu acesso e abra novamente a importação no canal desejado.'), true); return true; }
    session.busy = true; session.error = ''; session.status = applying ? i18nText('Importando os novos contatos…') : i18nText('Lendo e conferindo os contatos…');
    paint();
    try {
      const options = { method: 'POST', headers: { 'X-Elozi-Workspace': operation.workspaceId } };
      const path = `/api/tenants/${encodeURIComponent(operation.tenantId)}/contacts/import/`;
      if (applying) {
        const preview = session.preview;
        if (!ready(preview?.counts)) throw Error(i18nText('Gere uma prévia com contatos válidos ou para revisão antes de confirmar.'));
        const receipt = await request(path + 'apply', { ...options, body: JSON.stringify({ previewId: preview.previewId, hash: preview.hash, version: preview.version }) });
        if (stale(operation)) return true;
        session.receipt = { imported: number(receipt.imported), reviewImported: number(receipt.reviewImported), duplicate: number(receipt.duplicate), conflict: number(receipt.conflict), invalid: number(receipt.invalid) };
        session.file = null; session.content = ''; session.preview = null; session.status = i18nText('Cadastros importados. A lista de contatos será atualizada.');
        paint();
        await refresh(operation.tenantId);
        if (stale(operation)) return true;
        session.status = i18nText('Lista de contatos atualizada.');
        toast(i18nTemplate`${formatted(session.receipt.imported)} contatos importados${session.receipt.reviewImported ? i18nTemplate`, ${formatted(session.receipt.reviewImported)} para revisão` : ''}.`);
      } else {
        let content = session.content, format = 'json';
        if (!content.trim()) {
          fileValid(session.file);
          format = session.file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
          content = await session.file.text();
          if (stale(operation)) return true;
        }
        if (typeof content !== 'string' || !content.trim()) throw Error(i18nText('O arquivo ou a lista JSON está vazio.'));
        if (bytes(content) > MAX_BYTES) throw Error(i18nText('O conteúdo deve ter até 5 MiB.'));
        const response = await request(path + 'preview', { ...options, body: JSON.stringify({ channelId: operation.channelId, format, content, preserveInvalid: operation.preserveInvalid }) });
        if (stale(operation)) return true;
        if (!response || response.channelId !== operation.channelId || !response.previewId || !response.hash || !response.version || !response.counts || !Array.isArray(response.rows)) throw Error(i18nText('A prévia não corresponde ao canal escolhido. Gere outra prévia.'));
        const counts = Object.fromEntries(['total', 'valid', 'review', 'duplicate', 'conflict', 'invalid'].map(key => [key, number(response.counts[key])]));
        if (counts.total > 10000 || counts.total !== counts.valid + counts.review + counts.duplicate + counts.conflict + counts.invalid) throw Error(i18nText('A prévia retornou contagens inconsistentes. Gere outra prévia.'));
        if (counts.review && !operation.preserveInvalid) throw Error(i18nText('Gere outra prévia e escolha explicitamente preservar telefones inválidos para revisão.'));
        session.preview = { previewId: response.previewId, hash: response.hash, version: response.version, counts, rows: response.rows.slice(0, PREVIEW_ROWS), truncated: response.truncated === true, expiresAt: response.expiresAt };
        session.status = i18nText('Prévia pronta. Confira as contagens e confirme somente os novos contatos.');
      }
    } catch (error) {
      if (stale(operation)) return true;
      if (error.status === 409 || error.status === 403) session.preview = null;
      if (error.status === 403) { session.file = null; session.content = ''; }
      session.error = session.receipt ? i18nTemplate`Os contatos foram importados. Atualize a lista: ${translateError(error.message) || i18nText('não foi possível atualizar agora.')}` : translateError(error.message) || i18nText('Não foi possível concluir. Tente novamente.');
      session.status = '';
    } finally {
      if (current(operation)) { session.busy = false; paint(); }
    }
    return true;
  }
  return { open, submit, handleChange, reset, useAgenda, get busy() { return Boolean(session?.busy); } };
}
