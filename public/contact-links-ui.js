import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

/** Contact operations keep a scoped intent; late responses never replace another modal. */
export function createContactLinksUI(ctx) {
  const { getContext, getConversation, request, formModal, getModal, escape: e, applyContacts, onApplied, onError } = ctx;
  let generation = 0, intent = null;
  const contactDTO = c => c && typeof c.id === 'string' && c.id && typeof c.name === 'string' && Number.isSafeInteger(c.version) && c.version > 0 && ['person','company','group'].includes(c.type);
  const revision = r => typeof r === 'string' && /^[a-f0-9]{64}$/.test(r);
  const linksDTO = links => Array.isArray(links) && links.every(link=>link&&typeof link.conversationId==='string'&&link.conversationId&&(link.contactId==null||typeof link.contactId==='string'&&link.contactId)&&Number.isSafeInteger(link.version)&&link.version>0&&(link.contactSyncStatus===undefined||['linked','capacity'].includes(link.contactSyncStatus))) && new Set(links.map(link=>link.conversationId)).size===links.length;
  const key = c => JSON.stringify([c.workspaceId,c.tenantId,c.userId,c.authorityKey,c.view,c.sequence,c.refreshSequence,c.view==='inbox'?getConversation()?.id:null]);
  const allowed = c => c.userId && c.workspaceId && c.tenantId && c.canRead && c.canWrite && c.canTransfer && ['contacts','inbox'].includes(c.view);
  const kind = c => c.type === 'group' ? 'group' : 'person';
  const path = (task, tail) => `/api/tenants/${encodeURIComponent(task.tenantId)}/${tail}`;
  const options = task => ({ headers: { 'X-Elozi-Workspace': task.workspaceId } });
  async function read(task, tail) {
    try { return await request(path(task,tail),options(task)); }
    catch(error) { if (!current(task)) return null; throw error; }
  }
  function reset() { generation++; intent = null; }
  function current(task) {
    const c = getContext(), modal = getModal();
    return intent === task && task.ticket === generation && task.key === key(c) && allowed(c) && modal === task.modal && Boolean(modal?.open)===task.modalOpen && modal?.firstElementChild === task.content && (!task.form || task.form.isConnected!==false && modal.querySelector?.('[data-dialog-form="contact-link-select"], [data-dialog-form="contact-link-confirm"]')===task.form);
  }
  function capture(task) {
    task.modal = getModal(); task.modalOpen = Boolean(task.modal?.open); task.content = task.modal?.firstElementChild;
    task.form = task.modal?.querySelector?.('[data-dialog-form="contact-link-select"], [data-dialog-form="contact-link-confirm"]');
  }
  function begin(operation, id) {
    const c = getContext();
    if (!allowed(c)) throw Error(i18nText('Seu acesso atual não permite organizar cadastros e atendimentos.'));
    const task = { operation, id, ticket: ++generation, key: key(c), tenantId: c.tenantId, workspaceId: c.workspaceId, pending: false, stale: false };
    intent = task; capture(task); return task;
  }
  function pickerOptions(task, query = '', selected = '') {
    const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
    const q = normalize(query).trim(), matches = task.candidates.filter(c => normalize([c.name,c.phone,c.email,...(c.tags || [])].join(' ')).includes(q));
    const visible = matches.slice(0,50);
    return { count: matches.length, markup: i18nMarkup('<option value="">Escolha um cadastro</option>') + visible.map(c => `<option value="${e(c.id)}" ${c.id===selected?'selected':''}>${e(c.name)}${c.phone?' · '+e(c.phone):c.email?' · '+e(c.email):''}</option>`).join('') };
  }
  function showPicker(task) {
    const choice = pickerOptions(task);
    formModal(task.operation==='associate'?i18nText('Vincular cadastro'):i18nText('Unir contatos'), task.operation==='associate'?i18nText('Escolha o cadastro que corresponde a este atendimento.'):i18nText('Escolha o cadastro principal. Você revisará os dados antes de confirmar.'), 'contact-link-select', i18nHtml`<label>Buscar cadastro<input name="query" aria-label="Buscar cadastro" maxlength="160" autocomplete="off"/></label><label>Cadastro principal<select name="targetId" required>${choice.markup}</select></label><p data-contact-link-count role="status">${choice.count} cadastros disponíveis · até 50 por busca</p>`, i18nText('Revisar escolha'));
    capture(task);
  }
  function summary(contact) {
    return i18nHtml`<dl class="client-fields"><div><dt>Nome</dt><dd data-pii>${e(contact.name)}</dd></div><div><dt>Telefone</dt><dd data-pii>${e(contact.phone || i18nText('Não informado'))}</dd></div><div><dt>E-mail</dt><dd data-pii>${e(contact.email || i18nText('Não informado'))}</dd></div></dl>`;
  }
  function showConfirmation(task) {
    const p = task.preview, undo = task.operation === 'undo', association = task.operation === 'associate';
    const title = association?i18nText('Vincular cadastro'):undo?i18nText('Desfazer união'):i18nText('Confirmar união de contatos');
    const description = association?i18nText('Confira o cliente e a conexão antes de vincular.'):undo?i18nText('Os cadastros e vínculos anteriores serão restaurados se não houve alterações posteriores.'):i18nText('O cadastro principal reúne os vínculos e o histórico. O cadastro de origem será arquivado e preservado.');
    const content = association ? i18nHtml`<h3>Cadastro escolhido</h3>${summary(p.contact)}<p>Atendimento: ${e(task.conversationName)} · conexão ${e(task.channelName || p.channelId)}</p>` : i18nHtml`<h3>${undo?i18nText('Cadastro que volta a ficar separado'):i18nText('Cadastro de origem')}</h3>${summary(p.sourceContact)}<h3>Cadastro principal</h3>${summary(p.targetContact)}<p>${p.conversationCount} atendimento(s) ${undo?i18nText('terão o vínculo anterior restaurado'):i18nText('serão vinculados ao cadastro principal')}.</p><p>${undo?i18nText('Edições posteriores impedem o desfazimento para preservar o trabalho da equipe.'):i18nText('Nome, telefone e e-mail do principal são preferidos; campos vazios recebem os dados da origem. Etiquetas e notas são reunidas. A união pode ser desfeita enquanto os cadastros e atendimentos não forem alterados.')}</p>`;
    formModal(title, description, 'contact-link-confirm', content + i18nMarkup('<label class="checkbox-label"><input type="checkbox" name="confirmed" required/>Conferi os cadastros e os vínculos desta operação.</label><button type="button" class="text-button" data-action="contact-link-refresh">Atualizar prévia</button>'), association?i18nText('Confirmar vínculo'):undo?i18nText('Desfazer união'):i18nText('Unir contatos'));
    task.stale = false; capture(task);
  }
  async function preview(task, targetId) {
    let p;
    if (task.operation === 'associate') p = await read(task,`conversations/${encodeURIComponent(task.id)}/contact-preview?contactId=${encodeURIComponent(targetId)}`);
    else if (task.operation === 'merge') p = await read(task,`contacts/${encodeURIComponent(task.id)}/merge-preview?targetId=${encodeURIComponent(targetId)}`);
    else p = await read(task,`contacts/${encodeURIComponent(task.id)}/merge-undo-preview?mergeId=${encodeURIComponent(task.mergeId)}`);
    if (!current(task)) return;
    if (task.operation === 'associate') {
      if (!contactDTO(p?.contact) || p.contact.id !== targetId || p.contact.archivedAt || p.contact.mergedIntoId || p.conversationId !== task.id || p.channelId !== task.channelId || !Number.isSafeInteger(p.version) || p.version < 1 || p.kind !== task.kind || kind(p.contact) !== task.kind) throw Error(i18nText('A prévia não corresponde ao cadastro e atendimento escolhidos.'));
    } else if (!contactDTO(p?.sourceContact) || !contactDTO(p?.targetContact) || p.sourceContact.id === p.targetContact.id || p.targetContact.id !== (task.operation==='merge'?targetId:task.id) || task.operation==='merge' && p.sourceContact.id !== task.id || !revision(p.revision) || !Number.isSafeInteger(p.conversationCount) || p.conversationCount < 0 || kind(p.sourceContact) !== kind(p.targetContact)) throw Error(i18nText('A prévia não corresponde aos cadastros escolhidos.'));
    task.targetId = targetId; task.preview = p; showConfirmation(task);
  }
  async function action(action, id) {
    if (!['contact-associate','contact-merge','contact-undo-merge','contact-link-refresh'].includes(action)) return false;
    if (action === 'contact-link-refresh') {
      const task = intent;
      if (!task || !current(task) || task.pending || !task.preview) throw Error(i18nText('Abra esta operação novamente para revisar.'));
      task.pending = true;
      try { await preview(task, task.targetId); } finally { if (intent===task) task.pending = false; }
      return true;
    }
    const operation = action==='contact-associate'?'associate':action==='contact-merge'?'merge':'undo', task = begin(operation,id);
    if (operation === 'associate') {
      const c = getConversation();
      if (getContext().view !== 'inbox' || c?.id !== id || c.contactId) { reset(); throw Error(i18nText('Escolha um atendimento sem cadastro vinculado.')); }
      Object.assign(task,{kind:c.conversationKind==='group'?'group':'person',channelId:c.channelId,conversationName:c.contact,channelName:c.channelName});
    }
    if (operation === 'undo') {
      const c = await read(task,`contacts/${encodeURIComponent(id)}`);
      if (!current(task)) return true;
      if (!contactDTO(c) || c.id!==id || typeof c.reversibleMergeId!=='string' || !c.reversibleMergeId) throw Error(i18nText('Esta união não está disponível para desfazer.'));
      task.mergeId=c.reversibleMergeId;await preview(task,id);return true;
    }
    const result = await read(task,'contacts?archived=false');
    if (!current(task)) return true;
    if (!Array.isArray(result?.contacts) || !result.contacts.every(contactDTO)) throw Error(i18nText('A agenda recebida é inválida. Atualize o workspace.'));
    if (operation==='merge') {
      const source = result.contacts.find(c=>c.id===id);
      if (!source || source.archivedAt || source.mergedIntoId) throw Error(i18nText('Escolha um contato ativo desta empresa.'));
      task.kind=kind(source);
    }
    task.candidates=result.contacts.filter(c=>(operation==='associate'||c.id!==id)&&!c.archivedAt&&!c.mergedIntoId&&kind(c)===task.kind);
    if (!task.candidates.length) throw Error(i18nText('Não há outro cadastro compatível disponível nesta empresa.'));
    showPicker(task);return true;
  }
  async function submit(form) {
    const type = form.dataset.dialogForm;
    if (!['contact-link-select','contact-link-confirm'].includes(type)) return false;
    const task = intent;
    if (!task || !current(task) || form!==task.form || form.isConnected===false) throw Error(i18nText('Abra esta operação novamente antes de continuar.'));
    if (task.pending) return true;
    if (type==='contact-link-select') {
      const targetId = form.elements.namedItem('targetId')?.value;
      if (!task.candidates.some(c=>c.id===targetId)) throw Error(i18nText('Escolha um cadastro da lista atual.'));
      task.pending=true;
      try { await preview(task,targetId); } finally { if(intent===task)task.pending=false; }
      return true;
    }
    if (!task.preview || task.stale) throw Error(i18nText('Atualize a prévia e confira os cadastros antes de confirmar novamente.'));
    if (!form.elements.namedItem('confirmed')?.checked) throw Error(i18nText('Confira os cadastros e confirme a operação.'));
    const p=task.preview, association=task.operation==='associate', undo=task.operation==='undo';
    const tail=association?`conversations/${encodeURIComponent(task.id)}/contact`:`contacts/${encodeURIComponent(task.id)}/${undo?'merge-undo':'merge'}`;
    const body=association?{contactId:p.contact.id,version:p.version,contactVersion:p.contact.version}:undo?{mergeId:task.mergeId,revision:p.revision}:{targetId:p.targetContact.id,sourceVersion:p.sourceContact.version,targetVersion:p.targetContact.version,revision:p.revision};
    task.pending=true;
    try {
      const result=await request(path(task,tail),{...options(task),method:'POST',body:JSON.stringify(body)});
      if (!current(task) || form.isConnected===false) return true;
      const contacts=association?[result?.contact]:[result?.sourceContact,result?.targetContact];
      if (!contacts.every(contactDTO) || association && (result.conversationId!==task.id||result.contact.id!==p.contact.id||!Number.isSafeInteger(result.version)||result.version<p.version) || !association && (!linksDTO(result.links)||result.sourceContact.id!==p.sourceContact.id||result.targetContact.id!==p.targetContact.id||result.sourceContact.version<=p.sourceContact.version||result.targetContact.version<=p.targetContact.version||!Number.isSafeInteger(result.conversationCount)||result.conversationCount!==p.conversationCount) || task.operation==='merge' && (typeof result.mergeId!=='string'||!result.mergeId||result.sourceContact.mergedIntoId!==result.targetContact.id||!result.sourceContact.archivedAt) || undo && result.sourceContact.mergedIntoId) throw Error(i18nText('O resultado não corresponde à operação. Atualize a agenda antes de tentar novamente.'));
      applyContacts(contacts);getModal().close();await onApplied({...result,operation:task.operation});
      return true;
    } catch (error) {
      if (!current(task) || form.isConnected===false) return true;
      // An uncertain mutation must be reconciled, never blindly replayed.
      task.stale=true;
      throw error;
    } finally { if(intent===task)task.pending=false; }
  }
  document.addEventListener('input',event=>{
    const task=intent,form=event.target.closest?.('[data-dialog-form="contact-link-select"]');
    if (!task || !current(task) || task.pending || !form || event.target.name!=='query') return;
    const select=form.elements.namedItem('targetId'),choice=pickerOptions(task,event.target.value,select.value);
    select.innerHTML=choice.markup;const count=form.querySelector('[data-contact-link-count]');if(count)count.textContent=i18nTemplate`${choice.count} cadastros disponíveis · até 50 por busca`;
  });
  getModal()?.addEventListener?.('close',()=>{if(intent?.modalOpen&&!getModal()?.open)reset();});
  return {action,submit,reset};
}
