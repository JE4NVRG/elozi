import { t as i18nT, html as i18nHtml, h, getLocale } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { button, banner, badge, companyMark } from './ui.js';
import { glyph } from './icons.js';
import { pageHeader } from './settings-ui.js';

// Configurações › Empresas e filiais (FRONTEND-V2 §8.9, P8). The list is local (boot.tenants): search,
// 30 rows per page and the actions of each unit (open the operation, edit, add a branch). Creating
// and editing keep the dialog of app.js (formModal 'tenant' and 'tenant-identity'). The demo company (tenant.demo) has
// its own create/remove dialogs here: fictitious data, no channels, outside billing, one per workspace.
export function unitRows(tenants,query='') {
  const normalize=value=>String(value||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
  const names=new Map(tenants.map(unit=>[unit.id,unit.name]));
  return tenants.filter(unit=>normalize([unit.name,unit.segment,names.get(unit.parentTenantId)].join(' ')).includes(normalize(query)))
    .sort((a,b)=>String(names.get(a.parentTenantId)||a.name).localeCompare(String(names.get(b.parentTenantId)||b.name),getLocale())||Number(Boolean(a.parentTenantId))-Number(Boolean(b.parentTenantId))||a.name.localeCompare(b.name,getLocale()));
}
export function createUnitsUI({state,escape:e,api,formModal,refresh,render,toast,getModal,changeTenant}) {
  let query='',offset=0;const limit=30;
  const context=()=>JSON.stringify([state.workspaceId,state.boot?.session.userId,state.supportGrantId]);
  const count=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value).toLocaleString(getLocale()):'0';
  let previous;
  const admin=()=>state.boot?.session.role==='reseller'&&!state.supportGrantId;
  const openDemo=async id=>{if(await changeTenant(id))location.hash=`#inbox?tenant=${encodeURIComponent(id)}`;};
  function markup(){
    const current=context();if(previous!==current){query='';offset=0;previous=current;}
    const tenants=state.boot.tenants,rows=unitRows(tenants,query),names=new Map(tenants.map(t=>[t.id,t.name]));
    offset=Math.min(offset,Math.max(0,Math.ceil(rows.length/limit)-1)*limit);
    const page=rows.slice(offset,offset+limit);
    const rowActions=unit=>unit.demo
      ? h`${button({label:i18nT('Abrir operação'),action:'open-demo-tenant',size:'sm',attrs:{'data-id':unit.id}})}${button({label:i18nT('Editar'),action:'edit-tenant',variant:'ghost',size:'sm',attrs:{'data-id':unit.id}})}${admin()?button({label:i18nT('Remover demonstração'),action:'remove-demo-tenant',variant:'danger',size:'sm',attrs:{'data-id':unit.id}}):''}`
      : h`${button({label:i18nT('Abrir operação'),action:'switch-tenant',size:'sm',attrs:{'data-id':unit.id}})}${button({label:i18nT('Editar'),action:'edit-tenant',variant:'ghost',size:'sm',attrs:{'data-id':unit.id}})}${button({label:i18nT('Nova filial'),action:'new-tenant',variant:'ghost',size:'sm',icon:'plus',attrs:{'data-id':unit.parentTenantId||unit.id}})}`;
    const body=page.map(unit=>h`<tr><th scope="row">${companyMark(unit)}${unit.demo?badge(i18nT('Demonstração'),'info'):''}<span class="pg-settings__sub">${unit.segment||''}</span></th><td data-label="${i18nT('Estrutura')}">${unit.parentTenantId?h`${i18nT('Filial')}<span class="pg-settings__sub">${names.get(unit.parentTenantId)||i18nT('Matriz autorizada')}</span>`:i18nT('Empresa / matriz')}</td><td class="pg-settings__cell-num" data-label="${i18nT('Canais')}">${count(unit.channels)}</td><td class="pg-settings__cell-num" data-label="${i18nT('Atendimentos')}">${i18nT('{count} abertos',{count:count(unit.conversations)})}</td><td class="pg-settings__cell-actions"><div class="pg-settings__row-actions">${rowActions(unit)}</div></td></tr>`);
    const empty=h`<tr><td colspan="5" class="pg-settings__empty-cell"><p class="pg-settings__muted">${query?i18nT('Nenhuma unidade encontrada nesta busca.'):i18nT('Nenhuma unidade cadastrada. Adicione sua primeira empresa.')}</p></td></tr>`;
    return String(h`<div class="pg-settings pg-settings--companies">
      ${pageHeader({title:i18nT('Empresas e filiais'),lead:i18nT('Organize cada unidade, seus canais e sua equipe. Uma pessoa pode atender todas as unidades permitidas.'),actions:h`${admin()&&!tenants.some(unit=>unit.demo)?button({label:i18nT('Criar empresa de demonstração'),action:'new-demo-tenant'}):''}${button({label:i18nT('Adicionar empresa ou filial'),action:'new-tenant',variant:'primary',icon:'plus'})}`})}
      ${banner({tone:'info',title:i18nT('Gestão central. Acessos por unidade.'),body:i18nT('O vínculo com a matriz organiza o painel; ele não amplia as permissões de pessoas, agentes ou suporte. Clientes de revenda são cadastrados em Clientes.')})}
      <section class="pg-settings__section pg-settings__section--flush" aria-label="${i18nT('Unidades desta conta')}">
        <form data-units-filter class="pg-settings__toolbar" role="search"><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar empresa ou filial')}</span><input class="pg-settings__input" name="q" placeholder="${i18nT('Nome, matriz ou segmento')}" value="${query}" maxlength="120" autocomplete="off"/></label>${button({label:i18nT('Buscar'),type:'submit'})}<p class="pg-settings__total" role="status">${i18nT('{count} unidades',{count:count(rows.length)})}</p></form>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${i18nT('Empresas e filiais')}</caption><thead><tr><th scope="col">${i18nT('Empresa ou unidade')}</th><th scope="col">${i18nT('Estrutura')}</th><th scope="col">${i18nT('Canais')}</th><th scope="col">${i18nT('Atendimentos')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${page.length?body:empty}</tbody></table></div>
        <nav class="pg-settings__pager" aria-label="${i18nT('Páginas de unidades')}"><span>${i18nT('{start}–{end} de {total}',{start:count(rows.length?offset+1:0),end:count(Math.min(offset+limit,rows.length)),total:count(rows.length)})}</span><div class="pg-settings__cluster">${button({label:i18nT('Anterior'),action:'units-previous',size:'sm',disabled:offset===0})}${button({label:i18nT('Próxima'),action:'units-next',size:'sm',disabled:offset+limit>=rows.length})}</div></nav>
      </section>
    </div>`);
  }
  function edit(id,parentId){
    const unit=state.boot.tenants.find(t=>t.id===id),parent=state.boot.tenants.find(t=>t.id===parentId&&!t.parentTenantId&&!t.demo);
    const values=unit?.demo?[]:state.boot.tenants.filter(t=>!t.parentTenantId&&t.id!==id&&!t.demo);
    formModal(unit?i18nT('Editar unidade'):parent?i18nT('Adicionar filial'):i18nT('Adicionar empresa ou filial'),i18nT('Cada unidade tem canais, contatos e atendimento próprios. Defina os acessos em Equipe.'),unit?'tenant-identity':'tenant',i18nHtml`${unit?i18nHtml`<input type="hidden" name="id" value="${e(unit.id)}"><input type="hidden" name="version" value="${e(unit.identityVersion||1)}">`:''}<label>Nome da empresa ou filial<input name="name" required maxlength="48" value="${e(unit?.name||'')}"></label><label>Segmento<input name="segment" required maxlength="80" value="${e(unit?.segment||parent?.segment||'Atendimento')}"></label><label${unit?.demo?' hidden':''}>Estrutura<select name="parentTenantId"><option value="">Empresa / matriz independente</option>${values.map(t=>i18nHtml`<option value="${e(t.id)}" ${(unit?.parentTenantId||parent?.id)===t.id?'selected':''}>Filial de ${e(t.name)}</option>`).join('')}</select></label>`,i18nT('Salvar unidade'));
  }
  async function action(action,id){
    if(action==='new-tenant'){edit(null,id);return true;}if(action==='edit-tenant'){edit(id);return true;}
    if(action==='new-demo-tenant'){formModal(i18nT('Criar empresa de demonstração'),i18nT('Cria uma empresa com clientes, conversas e agentes fictícios para apresentar o atendimento. Nenhum canal é conectado, nada é enviado a clientes e ela não conta no plano nem nas métricas. Remova quando terminar.'),'demo-tenant','',i18nT('Criar empresa de demonstração'));return true;}
    if(action==='remove-demo-tenant'){const unit=state.boot.tenants.find(t=>t.id===id&&t.demo);if(!unit)throw Error(i18nT('Empresa de demonstração indisponível. Atualize a página.'));formModal(i18nT('Remover demonstração'),i18nT('Apaga a empresa de demonstração e todos os dados fictícios dela. Suas empresas reais não mudam.'),'demo-tenant-remove',h`<input type="hidden" name="id" value="${unit.id}">`,i18nT('Remover demonstração'));return true;}
    if(action==='open-demo-tenant'){await openDemo(id);return true;}
    if(action==='units-next'||action==='units-previous'){offset=Math.max(0,offset+(action==='units-next'?limit:-limit));render();return true;}return false;
  }
  function filter(form){query=String(new FormData(form).get('q')||'').slice(0,120);offset=0;render();}
  async function submit(form){
    const type=form.dataset.dialogForm;if(!['demo-tenant','demo-tenant-remove'].includes(type))return false;
    if(type==='demo-tenant'){
      const created=await api('/api/tenants/demo',{method:'POST',body:'{}'});
      getModal().close();await refresh(created.id);toast(i18nT('Empresa de demonstração criada.'));await openDemo(created.id);return true;
    }
    const id=String(new FormData(form).get('id')||'');
    await api(`/api/tenants/${encodeURIComponent(id)}`,{method:'DELETE'});
    getModal().close();await refresh();render();toast(i18nT('Empresa de demonstração removida.'));return true;
  }
  return {markup,action,filter,submit,reset(){query='';offset=0;previous=null;}};
}
