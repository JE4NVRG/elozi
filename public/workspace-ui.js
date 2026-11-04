import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, h, raw, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { button as uiButton, badge as uiBadge, emptyState, avatar as uiAvatar } from './ui.js';
import { glyph } from './icons.js';
import { pageHeader } from './settings-ui.js';
export const permissionNames = i18nLabels({ 'inbox.read':'Ver atendimentos', 'inbox.reply':'Responder e assumir', 'inbox.transfer':'Transferir e organizar', 'contacts.read':'Ver contatos', 'contacts.write':'Editar contatos', 'metrics.read':'Ver indicadores', 'flows.read':'Ver e simular fluxos' });
export const presenceNames = i18nLabels({ available:'Disponível', busy:'Ocupado', away:'Ausente', offline:'Fora de atendimento' });
export function teamDirectory(users,{search='',status='all',role='all'}={}) {
  const normalize=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase(getLocale());
  const query=normalize(search).trim();
  return (users||[]).filter(user=>(status==='all'||(status==='inactive'?Boolean(user.disabled):!user.disabled))&&(role==='all'||(role==='admin'?user.role==='reseller':user.role==='operator'))&&normalize([user.name,user.email,user.username].filter(Boolean).join(' ')).includes(query));
}
export function contactPage(contacts, {search='',showArchived=false,page=0}={}) {
  const normalize=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase(getLocale());
  const query=normalize(search).trim(),phoneQuery=/^\+?[\d\s()-]+$/.test(query)&&/\d/.test(query)?query.replace(/\D/g,''):null;
  const phoneMatches=value=>{
    const phone=String(value??'').trim();
    if(!phoneQuery||!/^\+?[\d\s()-]+$/.test(phone))return normalize(phone).includes(query);
    const digits=phone.replace(/\D/g,''),canonical=!phone.startsWith('+')&&[10,11].includes(digits.length)?'55'+digits:digits;
    // Complete Brazilian numbers use the same country rule as Contacts.list.
    // An explicit country query is anchored, so another country's local digits
    // cannot masquerade as the requested Brazilian contact. Short suffixes
    // intentionally remain useful across countries.
    if(phoneQuery.startsWith('55')&&[12,13].includes(phoneQuery.length))return canonical===phoneQuery;
    if(query.startsWith('+'))return canonical.startsWith(phoneQuery);
    if([10,11].includes(phoneQuery.length))return canonical==='55'+phoneQuery;
    return canonical.includes(phoneQuery);
  };
  const filtered=(contacts||[]).filter(c=>(showArchived||!c.archivedAt)&&(normalize([c.name,...(!phoneQuery?[c.phone]:[]),c.email,...(c.tags||[])].filter(Boolean).join(' ')).includes(query)||phoneMatches(c.phone)));
  const total=filtered.length,pages=Math.max(1,Math.ceil(total/50)),current=Math.min(pages-1,Math.max(0,Number.isSafeInteger(page)?page:0)),offset=current*50;
  return {items:filtered.slice(offset,offset+50),total,page:current,pages,start:total?offset+1:0,end:Math.min(offset+50,total)};
}

const supportHandoffReasons = new Map([
  ['visitor_requested_human','Cliente pediu uma pessoa'], ['agent_requested_human','Assistente pediu uma pessoa'], ['knowledge_unavailable','Sem informação revisada para responder'],
  ['media_needs_human','Anexo precisa de análise humana'], ['preparation_failed','Assistente indisponível'],
  ['preparation_interrupted','Preparação interrompida'], ['draft_needs_human','Resposta precisa de revisão humana'],
  ['invalid_draft','Resposta precisa de revisão humana'], ['sender_unavailable','Envio automático indisponível']
]);
export function clientRecordMarkup(conversation, { contacts = [], canRead = false, canWrite = false, canTransfer = false, escape: e, icon }) {
  if (!canRead) return '';
  // The CRM response is already scoped by the server. Never infer a customer
  // from a name, phone-like channel identifier or another conversation.
  const c = conversation?.contactId && contacts.find(item => item.id === conversation.contactId);
  if (!c) return i18nHtml`<section class="context-client-record" aria-label="Cadastro do cliente"><div class="context-title">Cadastro do cliente</div><p class="client-empty">${conversation?.contactSyncStatus === 'capacity' ? i18nT('A agenda atingiu o limite de contatos. As mensagens continuam neste atendimento; o cadastro será tentado novamente na próxima entrada quando houver espaço.') : i18nT('Esta conversa ainda não tem um cadastro vinculado disponível.')}</p>${!conversation?.contactId&&conversation?.id&&canWrite&&canTransfer?i18nHtml`<button type="button" class="text-button" data-action="contact-associate" data-id="${e(conversation.id)}">Vincular cadastro</button>`:''}</section>`;
  const types = i18nLabels({ person: 'Pessoa', company: 'Empresa', group: 'Grupo' });
  const visitor = conversation?.webchatVisitor;
  const fields = [[i18nT('Nome'), c.name], [i18nT('Tipo'), types[c.type]], [i18nT('Telefone'), c.phone], [i18nT('E-mail'), visitor?.email || c.email],
    ...(visitor?.verified === true ? [[i18nT('Identidade verificada'),visitor.externalId],[i18nT('Empresa'),visitor.ctx?.teamName],[i18nT('Plano'),visitor.ctx?.plan],[i18nT('Caixas de e-mail'),visitor.ctx?.mailboxes?.toString()]] : []),
    ...(conversation.supportAssistantHandoff?.active ? [[i18nT(conversation.supportAssistantHandoff.pauseAutomation === false ? 'Motivo do chamado' : 'Motivo da transferência'), i18nT(conversation.supportAssistantHandoff.pauseAutomation === false ? 'Assistente continua atendendo' : supportHandoffReasons.get(conversation.supportAssistantHandoff.reason) || 'Requer continuação pela equipe')]] : []),
    ...(conversation.handoffEmail ? [[i18nT('Notificação por e-mail'), i18nT(({ pending:'Na fila', in_flight:'Enviando', confirmed:'Aceita pelo provedor', failed:'Falhou', unknown:'Confirmação indisponível' })[conversation.handoffEmail.state] || 'Confirmação indisponível')]] : []),
    ...(conversation.webchatFeedback ? [[i18nT('Avaliação do atendimento'),conversation.webchatFeedback.rating === 'useful' ? i18nT('Útil') : i18nT('Não útil')]] : [])].filter(([, value]) => value);
  return i18nHtml`<section class="context-client-record" aria-label="Cadastro do cliente"><div class="context-title">${icon('users')} Cadastro do cliente${c.archivedAt ? i18nMarkup('<span class="client-archived">Arquivado</span>') : ''}</div><dl class="client-fields">${fields.map(([label, value]) => i18nHtml`<div><dt>${label}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>${c.tags?.length ? i18nHtml`<div class="client-record-tags"><span>Etiquetas do cadastro</span><div>${c.tags.map(tag => i18nHtml`<span class="client-tag">${e(tag)}</span>`).join('')}</div></div>` : ''}${c.notes ? i18nHtml`<details class="client-notes"><summary>Notas do cadastro</summary><p>${e(c.notes)}</p></details>` : ''}<div class="client-record-actions"><button type="button" class="text-button" data-action="contact-history" data-id="${e(c.id)}">${icon('activity')} Histórico</button>${canWrite ? i18nHtml`<button type="button" class="text-button" data-action="edit-contact" data-id="${e(c.id)}">${icon('document')} Editar contato</button>` : ''}${canWrite&&canTransfer&&!c.archivedAt&&!c.mergedIntoId?i18nHtml`<button type="button" class="text-button" data-action="contact-merge" data-id="${e(c.id)}">Unir com outro cadastro</button>`:''}${canWrite&&canTransfer&&c.reversibleMergeId?i18nHtml`<button type="button" class="text-button" data-action="contact-undo-merge" data-id="${e(c.id)}">Desfazer união</button>`:''}</div></section>`;
}

export function contactOpenNotice(conversation,{userId,canReply=false,canAssume=false}={}) {
  if(conversation.status==='closed')return i18nT('Histórico aberto. Este atendimento está encerrado.');
  if(canReply)return conversation.assignedUserId===userId?i18nT('Atendimento aberto. Você já é responsável por esta conversa.'):i18nT('Atendimento aberto. Você pode colaborar nesta conversa.');
  if(conversation.assignedUserId&&conversation.assignedUserId!==userId)return i18nTxt`Atendimento aberto em observação. Responsável: ${conversation.assignedUserName||i18nT('outro atendente')}.`;
  return canAssume&&!conversation.assignedUserId?i18nT('Atendimento aberto. Assuma a conversa para responder.'):i18nT('Atendimento aberto em observação. Seu acesso atual não permite responder.');
}

export function createWorkspaceUI(ctx) {
  const {state,escape:e,icon,badge,button,avatarMarkup,contactAvatar,pageHeading,api,tenantApi,refresh,render,toast,navigate,hasPermission} = ctx;
  const admin=()=>state.boot.session.role==='reseller';
  const contact=id=>state.contacts.find(c=>c.id===id);
  const options=(items,value)=>items.map(([id,label])=>i18nHtml`<option value="${e(id)}" ${id===value?'selected':''}>${e(label)}</option>`).join('');
  // Transfer destinations, grouped so the choice is explicit: a person, a copilot agent or the department queue (no owner).
  // Nothing is preselected: submitting without choosing is refused by the form instead of silently keeping the queue.
  const transferAgents=()=>(state.tenant?.agents||[]).filter(agent=>agent?.configured===true&&agent.mode==='copilot'&&agent.id);
  const transferOptions=(roster,selected='')=>i18nHtml`<option value="" disabled ${selected?'':'selected'}>${i18nT('Escolha quem recebe')}</option>${roster.length?i18nHtml`<optgroup label="${i18nT('Pessoas')}">${options(roster.map(u=>[u.id,`${u.name} · ${presenceNames[u.presence]||''}`]),selected)}</optgroup>`:''}${transferAgents().length?i18nHtml`<optgroup label="${i18nT('Agentes')}">${options(transferAgents().map(agent=>['agent:'+agent.id,agent.name||i18nT('Agente')]),selected)}</optgroup>`:''}<optgroup label="${i18nT('Equipe')}">${options([['queue',i18nT('Fila do departamento (sem responsável)')]],selected)}</optgroup>`;
  const transferNotice=(destination,departmentName)=>{
    if(destination==='queue')return departmentName?i18nT('Atendimento enviado à fila de {department}, sem responsável.',{department:departmentName}):i18nT('Atendimento enviado à fila da equipe, sem responsável.');
    if(destination.startsWith('agent:'))return i18nT('Atendimento transferido para o agente {name}.',{name:transferAgents().find(agent=>'agent:'+agent.id===destination)?.name||i18nT('Agente')});
    return i18nT('Atendimento transferido para {name}.',{name:(state.transferRoster||[]).find(user=>user.id===destination)?.name||i18nT('a pessoa escolhida')});
  };
  const input=(label,name,value='',max=80,extra='')=>i18nHtml`<label>${label}<input name="${name}" value="${e(value)}" maxlength="${max}" ${extra}/></label>`;
  const check=(label,name,value,checked)=>i18nHtml`<label class="checkbox-label"><input type="checkbox" name="${e(name)}" value="${e(value)}" ${checked?'checked':''}/>${e(label)}</label>`;
  const duration=seconds=>seconds===null||seconds===undefined?'—':seconds<60?i18nTxt`${Math.round(seconds)} s`:seconds<3600?i18nTxt`${Math.round(seconds/60)} min`:i18nTxt`${(seconds/3600).toFixed(1)} h`;
  const departments=()=>state.tenant.departments||[];
  const actions=(id,items,largeTargets=false)=>i18nHtml`<div class="row-actions">${items.map(([action,label,danger])=>i18nHtml`<button class="text-button ${danger?'danger':''}" data-action="${action}" data-id="${e(id)}" ${largeTargets?'style="min-height:44px;min-width:44px"':''}>${label}</button>`).join('')}</div>`;
  let contactsScope='',contactsFilter='';
  let contactHistoryIntent=null,contactOpenIntent=null;
  function invalidateContactNavigation(){contactHistoryIntent=null;contactOpenIntent=null;}
  function formModal(...args){invalidateContactNavigation();return ctx.formModal(...args);}
  function openModal(...args){invalidateContactNavigation();return ctx.openModal(...args);}
  const contactModalSnapshot=()=>{const modal=document.querySelector('#modal');return {modal,modalContent:modal?.firstElementChild};};
  const contactModalCurrent=intent=>document.querySelector('#modal')===intent.modal&&intent.modal?.firstElementChild===intent.modalContent;
  let personEditorState=null;
  let invitationIntent=null,invitationBusy=false,invitationLink=null;
  const personEditorContext=()=>JSON.stringify([state.boot?.session.userId||'',state.workspaceId||'',state.boot?.session.role||'',state.boot?.csrfToken||state.boot?.session.csrfToken||'',(state.boot?.tenants||[]).map(t=>t.id).sort()]);
  const sameSelection=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const selection=values=>[...new Set(values)].sort();
  function personControls(user,definitions) {
    const rules=user?.scopeRules||{},tenantIds=user?.tenantIds||[state.tenant.id],permissions=user?.permissions??Object.keys(permissionNames);
    return {role:user?.role||'operator',tenantIds:selection(definitions.filter(t=>tenantIds.includes(t.id)).map(t=>t.id)),permissions:selection(Object.keys(permissionNames).filter(id=>permissions.includes(id))),
      scopes:Object.fromEntries(definitions.map(t=>[t.id,Object.fromEntries(['channelIds','departmentIds'].map(kind=>{
        const selected=rules[t.id]?.[kind],available=kind==='channelIds'?t.channels:[{id:'unassigned'},...(t.departments||[]).filter(d=>d.active!==false)];
        return [kind,selected==null?null:selection(available.filter(item=>selected.includes(item.id)).map(item=>item.id))];
      }))]))};
  }
  function submittedPersonControls(fd,definitions) {
    return {role:fd.get('role'),tenantIds:selection(fd.getAll('tenantIds')),permissions:selection(fd.getAll('permissions')),
      scopes:Object.fromEntries(definitions.map(t=>[t.id,Object.fromEntries(['channelIds','departmentIds'].map(kind=>[kind,fd.has(`scope-all-${kind}-${t.id}`)?null:selection(fd.getAll(`scope-${kind}-${t.id}`))]))]))};
  }
  function changedPersonAccess(controls,editor) {
    const baseline=editor.controls,payload={};
    if(controls.role!==baseline.role)payload.role=controls.role;
    if(controls.role!=='operator')return payload;
    if(!sameSelection(controls.tenantIds,baseline.tenantIds))payload.tenantIds=controls.tenantIds;
    if(!sameSelection(controls.permissions,baseline.permissions))payload.permissions=controls.permissions;
    // The all-access checkboxes are a display projection of null/missing rules.
    // Keep their stored representation until that particular control changes.
    const retained=Object.fromEntries(Object.entries(editor.scopeRules||{}).filter(([tenantId])=>controls.tenantIds.includes(tenantId)));
    let changedScopes=false;
    for(const tenantId of controls.tenantIds)for(const kind of ['channelIds','departmentIds']) {
      if(sameSelection(controls.scopes[tenantId]?.[kind],baseline.scopes[tenantId]?.[kind]))continue;
      changedScopes=true;retained[tenantId]={...(retained[tenantId]||{}),[kind]:controls.scopes[tenantId]?.[kind]};
    }
    if(changedScopes)payload.scopeRules=retained;
    return payload;
  }
  const contactScope=()=>JSON.stringify([state.boot?.session.userId||'',state.workspaceId||'',state.tenant?.id||'']);
  const contactNavigationContext=()=>JSON.stringify([contactScope(),state.supportGrantId||null,state.boot?.csrfToken||state.boot?.session.csrfToken,state.boot?.session.role,state.boot?.session.platformOwner,state.boot?.session.permissions,state.boot?.session.scopeRules,(state.boot?.tenants||[]).map(t=>t.id)]);
  function resetContacts(){state.contactPage=0;contactsScope='';contactsFilter='';invalidateContactNavigation();}
  function contactsPage(){
    const scope=contactScope(),filter=JSON.stringify([state.contactSearch||'',Boolean(state.showArchived)]);
    if(scope!==contactsScope||filter!==contactsFilter)state.contactPage=0;
    contactsScope=scope;contactsFilter=filter;
    const page=contactPage(state.contacts,{search:state.contactSearch,showArchived:state.showArchived,page:state.contactPage});state.contactPage=page.page;return page;
  }
  // Configurações › Equipe, Contatos and Indicadores › Atendimentos (FRONTEND-V2 §8.9, P8): pages on
  // the tokens of screen-settings.css. The editors keep the dialogs of formModal/openModal below.
  const swatch=value=>/^#[0-9a-f]{6}$/i.test(String(value||''))?`--swatch:${value}`:null;
  const inviteTone=value=>value==='accepted'?'success':value==='pending'?'info':'neutral';
  function team() {
    if(!admin())return String(h`<div class="pg-settings">${pageHeader({title:i18nT('Equipe')})}${emptyState({icon:'users',title:i18nT('A gestão da equipe pertence ao administrador deste workspace.'),body:i18nT('Peça à administração para ajustar seu acesso.')})}</div>`);
    const people=teamDirectory(state.users,{search:state.teamSearch,status:state.teamStatus,role:state.teamRole}),invitations=state.invitations||[],pending=invitations.filter(invite=>invite.state==='pending'),active=state.users.filter(u=>!u.disabled).length;
    const actions=h`${state.boot.session.platformOwner?uiButton({label:i18nT('Usuários da plataforma'),action:'platform-users',icon:'users'}):''}${uiButton({label:i18nT('Convidar pessoa'),action:'invite-user',variant:'primary',icon:'plus'})}`;
    const companies=u=>u.role==='reseller'?i18nT('Workspace atual'):(u.tenantIds||[]).map(id=>state.boot.tenants.find(t=>t.id===id)?.name||id).join(', ')||i18nT('Sem empresas');
    const personActions=u=>u.platformAdmin||u.id===state.boot.session.userId?h`<span class="pg-settings__muted">${i18nT('Perfil protegido')}</span>`:h`<div class="pg-settings__row-actions">${uiButton({label:i18nT('Editar acesso'),action:'edit-user',size:'sm',attrs:{'data-id':u.id,'aria-label':i18nT('{action}: {name}',{action:i18nT('Editar acesso'),name:u.name})}})}${uiButton({label:u.disabled?i18nT('Reativar'):i18nT('Desativar'),action:u.disabled?'reactivate-user':'confirm-disable-user',variant:u.disabled?'secondary':'danger',size:'sm',attrs:{'data-id':u.id,'aria-label':i18nT('{action}: {name}',{action:u.disabled?i18nT('Reativar'):i18nT('Desativar'),name:u.name})}})}</div>`;
    const peopleRows=people.map(u=>h`<tr><th scope="row"><div class="pg-settings__identity">${uiAvatar({kind:'person',name:u.name,src:u.avatar,size:32,presence:u.disabled?null:u.presence||'available'})}<div class="pg-settings__identity-text"><strong>${u.name}</strong><span class="pg-settings__sub">${u.email||u.username||''}</span></div></div></th><td data-label="${i18nT('Perfil e disponibilidade')}">${ctx.roleLabel(u)}<span class="pg-settings__sub">${presenceNames[u.presence]||presenceNames.available}</span></td><td data-label="${i18nT('Empresas')}">${companies(u)}</td><td data-label="${i18nT('Acesso')}">${uiBadge(u.disabled?i18nT('Desativado'):i18nT('Ativo'),u.disabled?'neutral':'success')}</td><td class="pg-settings__cell-actions">${personActions(u)}</td></tr>`);
    const inviteRows=invitations.map(invite=>h`<tr><th scope="row">${invite.name||i18nT('Pessoa convidada')}<span class="pg-settings__sub">${invite.email||i18nT('Compartilhamento por link')}</span></th><td data-label="${i18nT('Perfil e empresas')}">${invite.role==='reseller'?i18nT('Administrador do workspace'):i18nT('Atendente')}<span class="pg-settings__sub">${invite.role==='reseller'?i18nT('Workspace atual'):(invite.tenantIds||[]).map(id=>state.boot.tenants.find(t=>t.id===id)?.name||id).join(', ')}</span></td><td data-label="${i18nT('Validade')}">${new Date(invite.expiresAt).toLocaleString(getLocale())}</td><td data-label="${i18nT('Estado')}">${uiBadge({pending:i18nT('Pendente'),accepted:i18nT('Aceito'),expired:i18nT('Expirado'),revoked:i18nT('Revogado')}[invite.state]||i18nT('Indisponível'),inviteTone(invite.state))}</td><td class="pg-settings__cell-actions">${invite.canRevoke?uiButton({label:i18nT('Revogar convite'),action:'confirm-revoke-invitation',variant:'danger',size:'sm',attrs:{'data-id':invite.id}}):h`<span class="pg-settings__muted">—</span>`}</td></tr>`);
    const departmentCards=departments().map(d=>h`<li class="pg-settings__card"><div class="pg-settings__card-head"><span class="pg-settings__cluster"><span class="pg-settings__swatch"${raw(swatch(d.color)?` style="${swatch(d.color)}"`:'')} aria-hidden="true"></span><strong class="pg-settings__strong">${d.name}</strong></span>${uiBadge(d.active===false?i18nT('Desativado'):d.id===state.tenant.defaultDepartmentId?i18nT('Entrada padrão'):i18nT('Ativo'),d.active===false?'neutral':'accent')}</div><p class="pg-settings__muted">${d.description||i18nT('Equipe de atendimento desta empresa.')}</p><p class="pg-settings__muted">${i18nT('{count} membros',{count:d.memberIds?.length||0})} · ${d.distribution==='round_robin'?i18nT('Distribuição circular'):i18nT('Distribuição manual')}</p><div>${uiButton({label:i18nT('Editar departamento'),action:'edit-department',size:'sm',attrs:{'data-id':d.id}})}</div></li>`);
    const select=(id,label,name,items,value)=>h`<label class="pg-settings__field pg-settings__field--narrow" for="${id}">${label}<select class="pg-settings__input" id="${id}" name="${name}">${raw(options(items,value))}</select></label>`;
    return String(h`<div class="pg-settings pg-settings--team">
      ${pageHeader({title:i18nT('Equipe'),lead:i18nT('Contas individuais, acesso por empresa, canal e departamento, e uma senha escolhida por cada pessoa.'),actions})}
      <dl class="pg-settings__stats"><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Pessoas com acesso ativo')}</dt><dd class="pg-settings__stat-value">${active}</dd></div><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Convites pendentes')}</dt><dd class="pg-settings__stat-value">${pending.length}</dd></div><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Departamentos')}</dt><dd class="pg-settings__stat-value">${departments().length}</dd></div></dl>
      <section class="pg-settings__section pg-settings__section--flush" aria-labelledby="team-people-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="team-people-title">${i18nT('Pessoas')}</h2><p class="pg-settings__muted">${i18nT('Permissões por empresa, canal e departamento. Cada resposta tem um autor.')}</p></div></div>
        <form data-dialog-form="team-filter" class="pg-settings__toolbar" role="search"><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar pessoas')}</span><input class="pg-settings__input" name="search" placeholder="${i18nT('Buscar nome, usuário ou e-mail')}" value="${state.teamSearch||''}" autocomplete="off"/></label>${select('team-status',i18nT('Acesso'),'status',[['all',i18nT('Todos os acessos')],['active',i18nT('Ativos')],['inactive',i18nT('Desativados')]],state.teamStatus||'all')}${select('team-role',i18nT('Perfil'),'role',[['all',i18nT('Todos os perfis')],['admin',i18nT('Administradores')],['operator',i18nT('Atendentes')]],state.teamRole||'all')}${uiButton({label:i18nT('Filtrar'),type:'submit'})}<p class="pg-settings__total" role="status">${i18nT('{shown} de {total} pessoas',{shown:people.length,total:state.users.length})}</p></form>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">${i18nT('Pessoa')}</th><th scope="col">${i18nT('Perfil e disponibilidade')}</th><th scope="col">${i18nT('Empresas')}</th><th scope="col">${i18nT('Acesso')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${people.length?peopleRows:h`<tr><td colspan="5" class="pg-settings__empty-cell"><p class="pg-settings__muted">${i18nT('Nenhuma pessoa neste filtro. Convide quem vai trabalhar com você.')}</p></td></tr>`}</tbody></table></div>
        <div class="pg-settings__pager"><span>${i18nT('Precisa cadastrar uma conta diretamente?')}</span>${uiButton({label:i18nT('Criar acesso manual'),action:'new-user',size:'sm',icon:'users'})}</div>
      </section>
      <section class="pg-settings__section pg-settings__section--flush" aria-labelledby="team-invitations-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="team-invitations-title">${i18nT('Convites de acesso')}</h2><p class="pg-settings__muted">${i18nT('{count} pendentes · o link é de uso único e só aparece na criação.',{count:pending.length})}</p></div>${uiButton({label:i18nT('Atualizar convites'),action:'refresh-invitations',size:'sm',icon:'refresh'})}</div>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">${i18nT('Pessoa convidada')}</th><th scope="col">${i18nT('Perfil e empresas')}</th><th scope="col">${i18nT('Validade')}</th><th scope="col">${i18nT('Estado')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${invitations.length?inviteRows:h`<tr><td colspan="5" class="pg-settings__empty-cell"><p class="pg-settings__muted">${i18nT('Convide a primeira pessoa. Ela escolhe a própria senha ao aceitar.')}</p></td></tr>`}</tbody></table></div>
      </section>
      <section class="pg-settings__section" aria-labelledby="team-departments-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="team-departments-title">${i18nT('Departamentos e distribuição')}</h2><p class="pg-settings__muted">${i18nT('A fila pode distribuir novas entradas entre membros disponíveis.')}</p></div>${uiButton({label:i18nT('Novo departamento'),action:'new-department',size:'sm',icon:'plus'})}</div>
        ${departments().length?h`<ul class="pg-settings__cards">${departmentCards}</ul>`:emptyState({icon:'building',title:i18nT('Crie o primeiro departamento para organizar a equipe.'),body:i18nT('Departamentos separam filas e responsáveis dentro da empresa.'),level:3})}
      </section>
    </div>`);
  }
  function contactRow(c) {
    const write=hasPermission('contacts.write'),transfer=hasPermission('inbox.transfer');
    const items=[['contact-history',i18nT('Histórico')],...(write?[['edit-contact',i18nT('Editar')]]:[]),...(write&&transfer&&!c.archivedAt&&!c.mergedIntoId?[['contact-merge',i18nT('Unir contatos')]]:[]),...(write&&transfer&&c.reversibleMergeId?[['contact-undo-merge',i18nT('Desfazer união')]]:[]),...(!c.archivedAt&&c.type!=='group'&&c.phone&&hasPermission('inbox.reply')?[['contact-open',i18nT('Abrir atendimento')]]:[])];
    const labels=[...(c.identities||[]).map(i=>uiBadge(state.tenant.channels.find(ch=>ch.id===i.channelId)?.name||i.label,'info')),...(c.tags||[]).map(tag=>uiBadge(tag))];
    return h`<tr data-contact-row><th scope="row"><div class="pg-settings__identity">${raw(contactAvatar(c,c.type==='group'?'lavender':'mint'))}<div class="pg-settings__identity-text"><strong data-pii>${c.name}</strong><span class="pg-settings__sub">${{person:i18nT('Pessoa'),company:i18nT('Empresa'),group:i18nT('Grupo')}[c.type]||''}${c.archivedAt?i18nT(' · Arquivado'):''}</span></div></div></th><td data-label="${i18nT('Telefone / e-mail')}" data-pii>${c.phone||'—'}<span class="pg-settings__sub">${c.email||''}</span></td><td data-label="${i18nT('Canais e etiquetas')}"><div class="pg-settings__badges">${labels}</div></td><td class="pg-settings__cell-actions"><div class="pg-settings__row-actions">${items.map(([action,label],index)=>uiButton({label,action,size:'sm',variant:index?'ghost':'secondary',attrs:{'data-id':c.id,'aria-label':i18nT('{action}: {name}',{action:label,name:c.name})}}))}</div></td></tr>`;
  }
  function contacts() {
    const search=state.contactSearch||'',page=contactsPage(),filtered=page.items,format=value=>value.toLocaleString(getLocale());
    const actions=hasPermission('contacts.write')?h`${uiButton({label:i18nT('Importar contatos'),action:'contact-import',icon:'document'})}${uiButton({label:i18nT('Novo contato'),action:'new-contact',variant:'primary',icon:'plus'})}`:'';
    const range=i18nT('{start}–{end} de {total} contatos · Página {page} de {pages}',{start:format(page.start),end:format(page.end),total:format(page.total),page:page.page+1,pages:page.pages});
    const pager=[['previous',i18nT('Anterior'),page.page-1,page.page===0],['next',i18nT('Próxima'),page.page+1,page.page+1>=page.pages]].map(([direction,label,target,disabled])=>uiButton({label,action:'contacts-page',size:'sm',disabled,attrs:{'data-contact-direction':direction,'data-id':JSON.stringify([contactScope(),JSON.stringify([state.contactSearch||'',Boolean(state.showArchived)]),Math.max(0,target)])}}));
    const empty=h`<tr><td colspan="4" class="pg-settings__empty-cell">${emptyState({icon:'contacts',title:i18nT('Nenhum contato neste filtro.'),body:i18nT('Novas conversas conectadas criam contatos aqui. Você também pode cadastrar um contato ou vincular o histórico existente.'),level:3})}</td></tr>`;
    return String(h`<div class="pg-settings pg-settings--contacts">
      ${pageHeader({title:i18nT('Contatos'),lead:i18nT('Cadastro, histórico e atendimento no canal certo.'),actions})}
      <section class="pg-settings__section pg-settings__section--flush crm-panel" aria-label="${i18nT('Contatos desta empresa')}">
        <div class="pg-settings__toolbar"><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar contatos')}</span><input class="pg-settings__input" id="contact-search" placeholder="${i18nT('Buscar nome, telefone ou etiqueta')}" value="${search}" autocomplete="off"/></label><label class="pg-settings__check"><input id="contacts-archived" type="checkbox"${raw(state.showArchived?' checked':'')}/>${i18nT('Incluir arquivados')}</label>${admin()?uiButton({label:i18nT('Vincular conversas existentes'),action:'sync-contacts',icon:'refresh',size:'sm'}):''}</div>
        <p class="pg-settings__pager" data-contact-summary>${i18nT('{total} contatos neste filtro · exibindo {start}–{end}',{total:format(page.total),start:format(page.start),end:format(page.end)})}</p>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">${i18nT('Contato')}</th><th scope="col">${i18nT('Telefone / e-mail')}</th><th scope="col">${i18nT('Canais e etiquetas')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${filtered.length?filtered.map(contactRow):empty}</tbody></table></div>
        <nav class="pg-settings__pager" data-contact-pagination aria-label="${i18nT('Paginação de contatos')}"><span class="pg-settings__count" data-contact-count role="status" aria-live="polite">${range}</span><div class="pg-settings__cluster">${pager}</div></nav>
      </section>
    </div>`);
  }
  function metrics() {
    const m=state.metrics,header=pageHeader({title:i18nT('Indicadores'),lead:i18nT('Respostas, transferências e encerramentos da equipe no período escolhido.')});
    if(!m)return String(h`<div class="pg-settings pg-settings--metrics">${header}${emptyState({icon:'chart',title:i18nT('Os indicadores não estão disponíveis para este acesso.'),body:i18nT('Peça à administração a permissão Ver indicadores.')})}</div>`);
    const tiles=[[i18nT('Conversas recebidas'),m.totals.conversationsReceived,i18nT('Primeira entrada registrada')],[i18nT('Encerramentos'),m.totals.closed,i18nT('Eventos registrados no período')],[i18nT('Transferências'),m.totals.transfers,i18nT('Mudanças de responsável')],[i18nT('Primeira resposta'),duration(m.firstReply.averageSeconds),i18nT('{count} amostras no período',{count:m.firstReply.samples})]];
    const rows=m.attendants.map(a=>h`<tr><th scope="row">${a.name||state.users.find(u=>u.id===a.id)?.name||i18nT('Pessoa da equipe')}</th><td class="pg-settings__cell-num" data-label="${i18nT('Atribuições')}">${a.assigned}</td><td class="pg-settings__cell-num" data-label="${i18nT('Respostas')}">${a.humanMessages}</td><td class="pg-settings__cell-num" data-label="${i18nT('Transferências')}">${a.transferred}</td><td class="pg-settings__cell-num" data-label="${i18nT('Encerramentos')}">${a.closed}</td><td class="pg-settings__cell-num" data-label="${i18nT('Primeira resposta')}">${duration(a.averageFirstReplySeconds)}</td></tr>`);
    return String(h`<div class="pg-settings pg-settings--metrics">
      ${header}
      <form id="metrics-period-form" class="pg-settings__section pg-settings__period"><label class="pg-settings__field pg-settings__field--narrow">${i18nT('De')}<input class="pg-settings__input" type="date" name="from" value="${state.metricsFrom||m.period.from.slice(0,10)}" required/></label><label class="pg-settings__field pg-settings__field--narrow">${i18nT('Até')}<input class="pg-settings__input" type="date" name="to" value="${state.metricsTo||m.period.to.slice(0,10)}" required/></label>${uiButton({label:i18nT('Atualizar período'),type:'submit',variant:'primary'})}<p class="form-error pg-settings__error" role="alert"></p></form>
      <dl class="pg-settings__stats">${tiles.map(([label,value,hint])=>h`<div class="pg-settings__stat"><dt class="pg-settings__stat-label">${label}</dt><dd class="pg-settings__stat-value">${value}</dd><dd class="pg-settings__stat-hint">${hint}</dd></div>`)}</dl>
      <section class="pg-settings__section pg-settings__section--flush" aria-labelledby="metrics-people-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="metrics-people-title">${i18nT('Por pessoa')}</h2><p class="pg-settings__muted">${i18nT('Contagem a partir de atribuições e autores identificados.')}</p></div>${uiBadge(i18nT('Dados registrados'),'info')}</div>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">${i18nT('Pessoa')}</th><th scope="col">${i18nT('Atribuições')}</th><th scope="col">${i18nT('Respostas')}</th><th scope="col">${i18nT('Transferências')}</th><th scope="col">${i18nT('Encerramentos')}</th><th scope="col">${i18nT('Primeira resposta')}</th></tr></thead><tbody>${rows.length?rows:h`<tr><td colspan="6" class="pg-settings__empty-cell"><p class="pg-settings__muted">${i18nT('Ainda não há eventos identificados neste período.')}</p></td></tr>`}</tbody></table></div>
      </section>
      <p class="pg-settings__muted">${i18nT('Históricos antigos sem autor ou evento de encerramento não são atribuídos a pessoas. A primeira resposta usa os horários das mensagens registradas.')}</p>
    </div>`);
  }
  async function personEditor(user,mode='manual') {
    const editorContext=personEditorContext();
    if(!admin())throw new Error('Somente o administrador pode gerir acessos.');
    if(mode==='invitation'&&invitationIntent) { uncertainInvitation();return; }
    invitationLink=null;
    const definitions=await Promise.all(state.boot.tenants.map(t=>api(`/api/tenants/${encodeURIComponent(t.id)}`)));
    if(editorContext!==personEditorContext())throw new Error('O workspace mudou. Abra o editor desta pessoa novamente.');
    state.teamDefinitions=definitions;
    personEditorState={userId:user?.id||'',mode,key:editorContext,controls:personControls(user,definitions),scopeRules:structuredClone(user?.scopeRules??null)};
    const tenantIds=user?.tenantIds||[state.tenant.id],permissions=user?.permissions??Object.keys(permissionNames),rules=user?.scopeRules||{};
    const scopeMarkup=definitions.map(t=>{const rule=rules[t.id]||{},scopePicker=(kind,label,items)=>i18nHtml`<div class="scope-picker">${check(i18nTxt`Todos os ${label}`,`scope-all-${kind}-${t.id}`,'all',rule[kind]===undefined||rule[kind]===null)}<div class="scope-options">${items.map(i=>check(i.name,`scope-${kind}-${t.id}`,i.id,(rule[kind]||[]).includes(i.id))).join('')}</div></div>`;return i18nHtml`<details class="person-scope"><summary>${e(t.name)}</summary>${check(i18nT('Permitir esta empresa'),'tenantIds',t.id,tenantIds.includes(t.id))}${scopePicker('channelIds',i18nT('canais'),t.channels)}${scopePicker('departmentIds',i18nT('departamentos'),[{id:'unassigned',name:i18nT('Sem departamento')},...(t.departments||[]).filter(d=>d.active!==false)])}</details>`;}).join('');
    const invite=mode==='invitation';
    const identity=user?i18nHtml`<input type="hidden" name="userId" value="${e(user.id)}"/>`:invite?i18nHtml`${input(i18nT('E-mail (opcional)'),'email','',254,'type="email" autocomplete="email"')}<p class="muted">A pessoa escolhe o usuário e a própria senha ao aceitar. A validade aparece junto ao link criado.</p>${state.invitationEmailConfigured?check(i18nT('Enviar o convite por e-mail'),'sendEmail','yes',false):i18nMarkup('<p class="muted">O envio por e-mail ainda não está configurado. Você pode compartilhar o link diretamente.</p>')}`:i18nHtml`${input(i18nT('Usuário de acesso'),'username','',64,'required autocomplete="off" autocapitalize="none"')}${input(i18nT('E-mail (opcional)'),'email','',254,'type="email"')}<label>Senha inicial<input type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password" required/><small>Mínimo de 8 caracteres, uma maiúscula e um caractere especial. Compartilhe diretamente com a pessoa.</small></label>`;
    formModal(user?i18nT('Editar acesso'):invite?i18nT('Convidar para a equipe'):i18nT('Criar acesso manual'),user?i18nT('Alterar o acesso encerra sessões antigas e devolve atendimentos à fila. Salvar apenas o nome mantém a operação.'):invite?i18nT('Escolha o que a pessoa poderá acessar antes de compartilhar o convite.'):i18nT('Crie uma conta individual e defina seu acesso à operação.'),invite?'invitation':'person',i18nHtml`${input(invite?i18nT('Nome (opcional)'):i18nT('Nome'),'name',user?.name||'',80,invite?'':'required')}${identity}<label>Perfil<select name="role" id="person-role">${options([['operator',i18nT('Atendente')],['reseller',i18nT('Administrador do workspace')]],user?.role||'operator')}</select></label><fieldset id="person-access" ${user?.role==='reseller'?'hidden':''}><legend>Permissões do atendente</legend><div class="permission-grid">${Object.entries(permissionNames).map(([id,label])=>check(label,'permissions',id,permissions.includes(id))).join('')}</div><p class="muted">Para responder ou transferir, mantenha Ver atendimentos. Para editar contatos, mantenha Ver contatos.</p><h3>Empresas e escopos</h3>${scopeMarkup}</fieldset>`,user?i18nT('Salvar acesso'):invite?i18nT('Criar convite'):i18nT('Criar conta'));
  }
  function uncertainInvitation() {
    if(invitationIntent?.key!==personEditorContext()||!admin())throw new Error('Há uma criação de convite aguardando confirmação. Volte ao workspace e à sessão de origem para verificá-la.');
    openModal(i18nT('Verificar criação do convite'),i18nT('A resposta do servidor não confirmou a criação.'),i18nHtml`<div class="dialog-detail"><p>Vamos consultar a mesma solicitação, com o mesmo acesso e destinatário. Nenhum segundo convite será criado.</p><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" class="button" data-close-modal style="min-height:44px">Fechar</button><button type="button" class="button primary" data-action="retry-invitation" style="min-height:44px">Verificar convite</button></div></div>`);
  }
  function validInviteUrl(value) {
    try { const url=new URL(value,globalThis.location?.origin||'https://elozi.je4ndev.com');return url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)?url.href:null; } catch { return null; }
  }
  async function sendInvitation() {
    const intent=invitationIntent;if(!intent||intent.key!==personEditorContext()||!admin())throw new Error('O acesso mudou. Retome este convite na sessão e no workspace de origem.');
    if(invitationBusy)return;
    invitationBusy=true;
    try {
      const result=await api('/api/users/invitations',{method:'POST',headers:{'X-Elozi-Workspace':intent.workspaceId},body:JSON.stringify(intent.payload)});
      if(intent!==invitationIntent||intent.key!==personEditorContext()||!admin())return;
      const url=validInviteUrl(result.inviteUrl);
      if(!result.invitation?.id||!url)throw new Error('O servidor não confirmou um link válido. Verifique a mesma solicitação antes de continuar.');
      invitationIntent=null;personEditorState=null;invitationLink={key:intent.key,url,id:result.invitation.id};
      openModal(i18nT('Convite pronto'),i18nT('Compartilhe com a pessoa que terá este acesso.'),i18nHtml`<div class="dialog-detail"><p>${result.email?.queued?i18nT('O e-mail de convite foi colocado na fila de envio.'):i18nT('Copie o link e compartilhe diretamente com a pessoa.')}</p><label>Link de uso único<input readonly value="${e(url)}" aria-label="Link de convite" data-workspace-invitation-link autocomplete="off" style="min-height:44px;width:100%"/></label><p class="muted">Este link só é exibido agora. Válido até ${e(new Date(result.invitation.expiresAt).toLocaleString(getLocale()))}. Após fechar, você poderá revogar o convite e criar outro.</p><div class="modal-actions"><button type="button" class="button" data-action="copy-invitation" style="min-height:44px">${icon('copy')} Copiar link</button><button type="button" class="button primary" data-close-modal style="min-height:44px">Concluir</button></div></div>`);
      try { await refresh();if(intent.key===personEditorContext())render(); } catch { toast(i18nT('Convite criado. A lista será atualizada ao recarregar a equipe.'),true); }
    } catch(error) {
      if(intent.key!==personEditorContext()||intent!==invitationIntent)return;
      const definitive=[400,401,403,404,409,413,422,429].includes(error.status);
      if(definitive){invitationIntent=null;throw error;}
      uncertainInvitation();throw new Error('A criação ainda não foi confirmada. Use “Verificar convite” para repetir a mesma solicitação.');
    } finally { invitationBusy=false; }
  }
  function departmentEditor(d) {
    formModal(d?i18nT('Editar departamento'):i18nT('Novo departamento'),i18nT('Escolha membros, disponibilidade e a forma de distribuir novas entradas.'),'department',i18nHtml`${d?i18nHtml`<input type="hidden" name="departmentId" value="${e(d.id)}"/><input type="hidden" name="version" value="${d.version||1}"/>`:''}${input(i18nT('Nome'),'name',d?.name||'',80,'required')}${input(i18nT('Descrição'),'description',d?.description||'',180)}${input(i18nT('Cor'),'color',d?.color||'#3157d5',7,'type="color"')}<label>Distribuição<select name="distribution">${options([['manual',i18nT('Manual')],['round_robin',i18nT('Circular entre disponíveis')]],d?.distribution||'manual')}</select></label><fieldset class="permission-grid"><legend>Membros com acesso a esta empresa</legend>${state.assignees.map(u=>check(u.name,'memberIds',u.id,(d?.memberIds||[]).includes(u.id))).join('')||i18nMarkup('<p>Cadastre uma pessoa com permissão de responder.</p>')}</fieldset>${check(i18nT('Receber novas conversas neste departamento'),'isDefault','yes',d?.id===state.tenant.defaultDepartmentId)}${check(i18nT('Departamento ativo'),'active','yes',d?.active!==false)}`,d?i18nT('Salvar departamento'):i18nT('Criar departamento'));
  }
  function contactEditor(c) {
    formModal(c?i18nT('Editar contato'):i18nT('Novo contato'),i18nT('Mantenha os dados do relacionamento junto ao histórico de atendimento.'),'contact',i18nHtml`${c?i18nHtml`<input type="hidden" name="contactId" value="${e(c.id)}"/><input type="hidden" name="version" value="${c.version}"/>`:''}${input(i18nT('Nome'),'name',c?.name||'',80,'required')}<label>Tipo<select name="type">${options([['person',i18nT('Pessoa')],['company',i18nT('Empresa')],['group',i18nT('Grupo')]],c?.type||'person')}</select></label>${input(i18nT('Telefone com DDD'),'phone',c?.phone||'',25,'type="tel" inputmode="tel"')}${input(i18nT('E-mail'),'email',c?.email||'',254,'type="email"')}${input(i18nT('Etiquetas'),'tags',(c?.tags||[]).join(', '),500)}<label>Notas<textarea name="notes" maxlength="2000" rows="4">${e(c?.notes||'')}</textarea></label>${c?i18nHtml`<div class="contact-editor-status">${badge(c.mergedIntoId?i18nT('Unido a outro cadastro'):c.archivedAt?i18nT('Arquivado'):i18nT('Ativo'),c.archivedAt?'neutral':'green')}${c.mergedIntoId?i18nMarkup('<p>Este cadastro foi preservado pela união. Para separá-lo, use Desfazer união no cadastro principal enquanto não houver alterações posteriores.</p>'):i18nHtml`<button type="button" class="text-button ${c.archivedAt?'':'danger'}" data-action="${c.archivedAt?'reactivate-contact':'archive-contact'}" data-id="${e(c.id)}">${c.archivedAt?i18nT('Reativar contato'):i18nT('Arquivar contato')}</button>`}</div>`:''}`,c?i18nT('Salvar contato'):i18nT('Cadastrar contato'));
  }
  async function transferEditor() {
    const c=state.tenant.conversations.find(c=>c.id===state.conversation);
    const currentDepartmentId=c.departmentId||departments().find(d=>d.name===c.department)?.id||'unassigned';
    const roster=await api(tenantApi(`assignees?conversationId=${encodeURIComponent(c.id)}`));state.transferRoster=roster.assignees;
    formModal(i18nT('Transferir atendimento'),i18nT('O canal de origem permanece o mesmo. A transferência invalida rascunhos anteriores.'),'transfer',i18nHtml`<input type="hidden" name="initialDepartmentId" value="${e(currentDepartmentId)}"/><label>Destino<select name="destination" id="transfer-destination" required>${transferOptions(roster.assignees)}</select></label><label>Departamento<select name="departmentId" id="transfer-department">${options([['unassigned',i18nT('Sem departamento')],...departments().filter(d=>d.active!==false||d.id===currentDepartmentId).map(d=>[d.id,d.name+(d.active===false?i18nT(' · desativado'):'')])],currentDepartmentId)}</select></label>${input(i18nT('Motivo (opcional)'),'reason','',240)}<p class="muted">Somente pessoas com acesso ao canal e ao departamento podem receber o atendimento.</p>`,i18nT('Transferir'));
  }
  async function action(action,id) {
    if(action==='invite-user'){await personEditor(null,'invitation');return true;}
    if(action==='retry-invitation'){await sendInvitation();return true;}
    if(action==='copy-invitation'){
      if(invitationLink?.key!==personEditorContext()||!admin()||!document.querySelector('#modal')?.querySelector?.('[data-workspace-invitation-link]'))throw new Error('Abra um convite criado nesta sessão para copiar o link.');
      if(!globalThis.navigator?.clipboard?.writeText)throw new Error('Selecione o link exibido e copie manualmente.');
      try { await navigator.clipboard.writeText(invitationLink.url);toast(i18nT('Link copiado. Compartilhe somente com a pessoa convidada.')); } catch { throw new Error('Não foi possível copiar automaticamente. Selecione e copie o link exibido.'); }
      return true;
    }
    if(action==='refresh-invitations') {
      if(!admin())throw new Error('Somente o administrador pode gerir convites.');
      const key=personEditorContext(),result=await api('/api/users/invitations');if(key!==personEditorContext()||!admin())return true;
      state.invitations=result.invitations;state.invitationEmailConfigured=Boolean(result.emailConfigured);render();toast(i18nT('Convites atualizados.'));return true;
    }
    if(action==='confirm-revoke-invitation'){
      if(!admin())throw new Error('Somente o administrador pode revogar convites.');
      const invite=state.invitations?.find(item=>item.id===id&&item.canRevoke);if(!invite)throw new Error('Atualize os convites antes de revogar.');
      state.invitationRevoke={id,key:personEditorContext()};
      openModal(i18nT('Revogar convite'),invite.name||invite.email||i18nT('Convite por link'),i18nHtml`<div class="dialog-detail"><p>O link deixará de aceitar novos acessos. Contas que já aceitaram um convite permanecem preservadas.</p><div class="modal-actions"><button type="button" class="button" data-close-modal style="min-height:44px">Cancelar</button><button type="button" class="button primary" data-action="revoke-invitation" data-id="${e(id)}" style="min-height:44px">Revogar convite</button></div></div>`);return true;
    }
    if(action==='revoke-invitation') {
      if(!admin()||state.invitationRevoke?.id!==id||state.invitationRevoke.key!==personEditorContext())throw new Error('Abra a confirmação de revogação neste workspace novamente.');
      const key=personEditorContext();await api(`/api/users/invitations/${encodeURIComponent(id)}/revoke`,{method:'POST',body:'{}'});if(key!==personEditorContext()||!admin())return true;
      state.invitationRevoke=null;document.querySelector('#modal').close();await refresh();render();toast(i18nT('Convite revogado.'));return true;
    }
    if(action==='contacts-page'){
      if(state.view!=='contacts')return true;
      let choice;try{choice=JSON.parse(id);}catch{return true;}
      if(!Array.isArray(choice)||choice.length!==3||choice[0]!==contactScope()||choice[1]!==JSON.stringify([state.contactSearch||'',Boolean(state.showArchived)])||!Number.isSafeInteger(choice[2])||choice[2]<0)return true;
      contactsPage();state.contactPage=choice[2];contactsPage();ctx.updateContacts?.();return true;
    }
    if(action==='new-user'){await personEditor();return true;}
    if(action==='edit-user'){await personEditor(state.users.find(u=>u.id===id));return true;}
    if(action==='confirm-disable-user'){const u=state.users.find(u=>u.id===id);openModal(i18nT('Desativar acesso'),u.name,i18nHtml`<div class="dialog-detail"><p>A pessoa perderá acesso e seus atendimentos abertos voltarão à fila. O cadastro e o histórico serão preservados.</p><div class="modal-actions"><button class="button" data-close-modal>Cancelar</button><button class="button primary" data-action="disable-user" data-id="${e(id)}">Desativar acesso</button></div></div>`);return true;}
    if(['disable-user','reactivate-user'].includes(action)){await api(`/api/users/${encodeURIComponent(id)}/${action==='disable-user'?'disable':'reactivate'}`,{method:'POST',body:'{}'});document.querySelector('#modal').close();await refresh();render();toast(i18nT('Acesso atualizado.'));return true;}
    if(['new-department','edit-department'].includes(action)){departmentEditor(action==='edit-department'?departments().find(d=>d.id===id):null);return true;}
    if(['new-contact','edit-contact'].includes(action)){contactEditor(action==='edit-contact'?contact(id):null);return true;}
    if(['archive-contact','reactivate-contact'].includes(action)){const c=contact(id);await api(tenantApi(`contacts/${encodeURIComponent(id)}/${action==='archive-contact'?'archive':'reactivate'}`),{method:'POST',body:JSON.stringify({version:c.version})});document.querySelector('#modal').close();await refresh();render();toast(i18nT('Contato atualizado.'));return true;}
    if(action==='sync-contacts'){const result=await api(tenantApi('contacts/sync'),{method:'POST',body:'{}'});await refresh();render();toast(i18nTxt`${result.count} contatos vinculados ao CRM.`);return true;}
    if(action==='contact-history'){
      const c=contact(id);if(!c||!hasPermission('contacts.read'))throw new Error('Atualize o contato antes de abrir o histórico.');
      const key=contactNavigationContext(),tenantId=state.tenant.id,intent={key,tenantId,conversationIds:new Set(),...contactModalSnapshot()};contactHistoryIntent=intent;contactOpenIntent=null;
      const h=await api(tenantApi(`contacts/${encodeURIComponent(id)}/history`));
      if(intent!==contactHistoryIntent||key!==contactNavigationContext()||!contactModalCurrent(intent))return true;
      intent.conversationIds=new Set(h.conversations.map(v=>v.id));
      ctx.openModal(i18nT('Histórico do contato'),c.name,i18nHtml`<div class="dialog-detail"><p>${e(c.notes||i18nT('Nenhuma nota cadastrada.'))}</p><div class="contact-history">${h.conversations.map(v=>i18nHtml`<button class="contact-history-item" data-action="contact-conversation" data-id="${e(v.id)}"><span><strong>${e(state.tenant.channels.find(ch=>ch.id===v.channelId)?.name||i18nT('Canal'))}</strong><small>${e(new Date(v.updatedAt).toLocaleString(getLocale()))}</small></span>${badge({open:i18nT('Aberta'),pending:i18nT('Pendente'),closed:i18nT('Encerrada')}[v.status]||v.status)}${icon('arrow')}</button>`).join('')||i18nMarkup('<p class="empty">Nenhum atendimento vinculado disponível.</p>')}</div></div>`);Object.assign(intent,contactModalSnapshot());return true;
    }
    if(action==='contact-conversation'){
      const intent=contactHistoryIntent;if(!intent||intent.key!==contactNavigationContext()||!contactModalCurrent(intent)||!intent.conversationIds.has(id))throw new Error('Abra o histórico deste contato novamente.');
      const c=await ctx.openContactConversation(intent.tenantId,id,()=>intent===contactHistoryIntent&&intent.key===contactNavigationContext()&&contactModalCurrent(intent));
      if(c&&intent===contactHistoryIntent&&intent.key===contactNavigationContext()&&contactModalCurrent(intent))document.querySelector('#modal').close();return true;
    }
    if(action==='contact-open'){
      const c=contact(id);if(!c||!hasPermission('inbox.reply'))throw new Error('Atualize o contato antes de abrir o atendimento.');
      const channels=state.tenant.channels.filter(ch=>ch.transport==='baileys'&&ch.state==='connected');if(!channels.length)throw new Error('Conecte um número WhatsApp para abrir o atendimento.');
      contactHistoryIntent=null;
      contactOpenIntent={key:contactNavigationContext(),tenantId:state.tenant.id,contactId:c.id,contactVersion:c.version,channelIds:channels.map(ch=>ch.id)};
      ctx.formModal(i18nT('Abrir atendimento'),i18nTxt`${c.name} · ${c.phone}. Abrir a conversa não envia uma mensagem.`, 'contact-open',i18nHtml`<input type="hidden" name="contactId" value="${e(id)}"/><label>Número de origem<select name="channelId">${options(channels.map(ch=>[ch.id,ch.name]),channels[0].id)}</select></label>`,i18nT('Abrir conversa'));Object.assign(contactOpenIntent,contactModalSnapshot());return true;
    }
    if(action==='transfer-conversation'){await transferEditor();return true;}
    if(action==='release-conversation'){const c=state.tenant.conversations.find(c=>c.id===state.conversation);await api(tenantApi(`conversations/${c.id}/owner`),{method:'POST',body:JSON.stringify({owner:'queue',version:c.version})});await refresh();render();toast(i18nT('Atendimento devolvido à fila.'));return true;}
    return false;
  }
  async function submit(form) {
    const fd=new FormData(form),v=Object.fromEntries(fd),type=form.dataset.dialogForm;
    if(type==='team-filter'){state.teamSearch=v.search||'';state.teamStatus=v.status;state.teamRole=v.role;render();return true;}
    if(type==='invitation') {
      if(invitationIntent){await sendInvitation();return true;}
      if(!admin()||!personEditorState||personEditorState.mode!=='invitation'||personEditorState.key!==personEditorContext())throw new Error('Abra o convite neste workspace novamente antes de salvar.');
      const controls=submittedPersonControls(fd,state.teamDefinitions),email=String(v.email||'').trim(),name=String(v.name||'').trim(),sendEmail=fd.has('sendEmail');
      if(!['operator','reseller'].includes(controls.role))throw new Error('Escolha um perfil válido.');
      if(controls.role==='operator'&&!controls.tenantIds.length)throw new Error('Escolha pelo menos uma empresa para o atendente.');
      if(controls.role==='operator'&&(controls.permissions.includes('inbox.reply')||controls.permissions.includes('inbox.transfer'))&&!controls.permissions.includes('inbox.read'))throw new Error('Mantenha Ver atendimentos para responder ou transferir.');
      if(controls.role==='operator'&&controls.permissions.includes('contacts.write')&&!controls.permissions.includes('contacts.read'))throw new Error('Mantenha Ver contatos para editar contatos.');
      if(sendEmail&&(!email||!state.invitationEmailConfigured))throw new Error('Informe o e-mail e configure o provedor antes de solicitar o envio.');
      const payload={requestId:crypto.randomUUID(),role:controls.role,sendEmail,...(name?{name}:{}),...(email?{email}:{})};
      if(controls.role==='operator')Object.assign(payload,{tenantIds:controls.tenantIds,permissions:controls.permissions,scopeRules:Object.fromEntries(controls.tenantIds.map(id=>[id,controls.scopes[id]]))});
      invitationIntent={key:personEditorContext(),workspaceId:state.workspaceId,payload};await sendInvitation();return true;
    }
    if(form.id==='metrics-period-form'){const result=await api(tenantApi(`metrics?from=${encodeURIComponent(v.from+'T00:00:00-03:00')}&to=${encodeURIComponent(v.to+'T23:59:59.999-03:00')}`));state.metricsFrom=v.from;state.metricsTo=v.to;state.metrics=result;render();return true;}
    if(!['person','department','contact','contact-open','transfer'].includes(type))return false;
    if(type==='person'){
      if(!personEditorState||personEditorState.userId!==(v.userId||'')||personEditorState.key!==personEditorContext())throw new Error('Abra o editor desta pessoa novamente antes de salvar.');
      const controls=submittedPersonControls(fd,state.teamDefinitions),payload={name:v.name};
      if(v.userId)Object.assign(payload,changedPersonAccess(controls,personEditorState));
      else {
        payload.role=v.role;
        if(v.role==='operator'){payload.tenantIds=controls.tenantIds;payload.permissions=controls.permissions;payload.scopeRules=Object.fromEntries(controls.tenantIds.map(id=>[id,controls.scopes[id]]));}
        Object.assign(payload,{username:v.username,password:v.password});if(v.email.trim())payload.email=v.email;
      }
      await api(v.userId?`/api/users/${encodeURIComponent(v.userId)}`:'/api/users',{method:v.userId?'PATCH':'POST',body:JSON.stringify(payload)});personEditorState=null;form.reset();
    }
    if(type==='department'){const payload={name:v.name,description:v.description,color:v.color,distribution:v.distribution,memberIds:fd.getAll('memberIds'),active:fd.has('active'),isDefault:fd.has('isDefault')};if(v.departmentId)payload.version=Number(v.version);await api(tenantApi(v.departmentId?`departments/${v.departmentId}`:'departments'),{method:v.departmentId?'PATCH':'POST',body:JSON.stringify(payload)});}
    if(type==='contact'){const payload={name:v.name,type:v.type,phone:v.phone,email:v.email,notes:v.notes,tags:[...new Set(v.tags.split(',').map(t=>t.trim()).filter(Boolean))]};if(v.contactId)payload.version=Number(v.version);await api(tenantApi(v.contactId?`contacts/${v.contactId}`:'contacts'),{method:v.contactId?'PATCH':'POST',body:JSON.stringify(payload)});}
    if(type==='contact-open'){
      if(state.busy)throw new Error('Aguarde a operação atual antes de abrir este atendimento.');
      const intent=contactOpenIntent,cached=contact(v.contactId),channel=state.tenant.channels.find(ch=>ch.id===v.channelId);
      if(!intent||intent.key!==contactNavigationContext()||!contactModalCurrent(intent)||intent.contactId!==v.contactId||intent.contactVersion!==cached?.version||!intent.channelIds.includes(v.channelId)||channel?.transport!=='baileys'||channel.state!=='connected'||!hasPermission('inbox.reply'))throw new Error('Abra o atendimento deste contato novamente antes de continuar.');
      const opened=await api(`/api/tenants/${encodeURIComponent(intent.tenantId)}/contacts/${encodeURIComponent(intent.contactId)}/open`,{method:'POST',headers:{'X-Elozi-Workspace':state.workspaceId},body:JSON.stringify({channelId:v.channelId})});
      if(intent!==contactOpenIntent||intent.key!==contactNavigationContext()||!contactModalCurrent(intent)||form.isConnected===false)return true;
      if(!opened?.id||opened.channelId!==v.channelId||opened.contactId!==intent.contactId)throw new Error('O atendimento recebido não corresponde ao contato e número escolhidos. Atualize o histórico.');
      const selected=await ctx.openContactConversation(intent.tenantId,opened.id,()=>intent===contactOpenIntent&&intent.key===contactNavigationContext()&&contactModalCurrent(intent)&&form.isConnected!==false);
      if(!selected||intent!==contactOpenIntent||intent.key!==contactNavigationContext()||!contactModalCurrent(intent)||form.isConnected===false||state.conversation!==selected.id)return true;
      const c=state.tenant.conversations.find(item=>item.id===selected.id);if(!c)return true;
      document.querySelector('#modal').close();toast(contactOpenNotice(c,{userId:state.boot.session.userId,canReply:ctx.canReplyTo?.(c),canAssume:hasPermission('inbox.reply')}));return true;
    }
    if(type==='transfer'){
      const c=state.tenant.conversations.find(c=>c.id===state.conversation),destination=v.destination||'';
      if(!destination)throw Error(i18nT('Escolha quem recebe o atendimento.'));
      const agent=destination.startsWith('agent:'),notice=transferNotice(destination,departments().find(d=>d.id===v.departmentId)?.name||'');
      await api(tenantApi(`conversations/${c.id}/owner`),{method:'POST',body:JSON.stringify({version:c.version,owner:destination==='queue'?'queue':agent?'agent':'human',...(agent?{agentId:destination.slice(6)}:destination!=='queue'?{assignedUserId:destination}:{}),...(v.departmentId!==v.initialDepartmentId?{departmentId:v.departmentId}:{}),reason:v.reason})});
      document.querySelector('#modal').close();await refresh();render();toast(notice);return true;
    }
    document.querySelector('#modal').close();await refresh();render();toast(i18nT('Configuração salva.'));return true;
  }
  document.addEventListener('change',async event=>{
    if(event.target.name?.startsWith('scope-')&&!event.target.name.startsWith('scope-all-')){const picker=event.target.closest('.scope-picker');if(event.target.checked)picker.querySelector('input[name^="scope-all-"]').checked=false;}
    if(event.target.name==='active'&&event.target.form?.dataset.dialogForm==='department'){const checkbox=event.target.form.elements.namedItem('isDefault');if(!event.target.checked)checkbox.checked=false;checkbox.disabled=!event.target.checked;}
    if(event.target.id==='person-role')document.querySelector('#person-access').hidden=event.target.value==='reseller';
    if(event.target.id==='transfer-department'){const c=state.tenant.conversations.find(c=>c.id===state.conversation),id=event.target.value,select=document.querySelector('#transfer-destination'),submit=select.form.querySelector('[type="submit"]');const current=select.value;select.disabled=true;submit.disabled=true;event.target.disabled=true;try{const roster=await api(tenantApi(`assignees?conversationId=${encodeURIComponent(c.id)}&departmentId=${encodeURIComponent(id)}`));if(!select.isConnected||event.target.value!==id)return;state.transferRoster=roster.assignees;select.innerHTML=transferOptions(roster.assignees,current);if(![...select.options].some(o=>o.value===current&&!o.disabled))select.value='';select.form.querySelector('.form-error').textContent='';}catch(error){select.innerHTML=transferOptions([],current.startsWith('agent:')||current==='queue'?current:'');select.form.querySelector('.form-error').textContent=translateError(error.message);}finally{if(select.isConnected){select.disabled=false;submit.disabled=false;event.target.disabled=false;}}}
  });
  document.querySelector('#modal')?.addEventListener?.('close',()=>{invitationLink=null;invalidateContactNavigation();});
  function resetPeople(){personEditorState=null;invitationLink=null;state.invitationRevoke=null;state.teamSearch='';state.teamStatus='all';state.teamRole='all';}
  return {views:{team,contacts,metrics},action,submit,resetContacts,resetPeople};
}
