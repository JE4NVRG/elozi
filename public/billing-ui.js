import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, h, raw, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { button as uiButton, badge as uiBadge, emptyState } from './ui.js';
import { pageHeader } from './settings-ui.js';

// Financeiro (FRONTEND-V2 §8.9, P8). The same contracts, invoices and manual settlements in three hubs:
// - Plataforma › Cobrança (view platform-billing): the platform's contracts with its accounts;
// - Clientes › Financeiro (view accounts, #accounts/billing): a reseller's contracts with its clients;
// - Configurações › Financeiro (view billing): the account's own invoices (Minhas faturas) and the
//   contracts of the companies of this workspace.
// Every write goes through an intent with requestId and is confirmed by the server (commit/pending).
export const billingLabels=i18nLabels({subscription:'Mensalidade',connections:'Conexões',users:'Usuários',agent_service:'Serviço de agente',email:'E-mail'});
const statuses=i18nLabels({active:'Ativo',scheduled:'Agendado',expired:'Vigência encerrada',suspended:'Suspenso',ended:'Encerrado',draft:'Rascunho',issued:'Emitida',partial:'Baixa parcial',grace:'Em carência',overdue:'Vencida',settled:'Liquidada',cancelled:'Cancelada'});
export function parseBillingCents(value) {
  const text=String(value??'').trim();if(!/^\d+(?:[.,]\d{1,2})?$/.test(text))throw new Error('Informe um valor em reais com até duas casas decimais.');
  const [whole,fraction='']=text.replace(',','.').split('.'),cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(cents>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('O valor excede o limite em centavos.');return Number(cents);
}
const brlFormatters = new Map();
const brlFormatter = () => {
  const locale = getLocale();
  if (!brlFormatters.has(locale)) brlFormatters.set(locale, new Intl.NumberFormat(locale, { style: 'currency', currency: 'BRL' }));
  return brlFormatters.get(locale);
};
export function formatBillingMoney(cents) {
  if(!Number.isSafeInteger(cents)||cents<0)return i18nT('Valor exige revisão');
  const value=BigInt(cents),fraction=String(value%100n).padStart(2,'0');
  return brlFormatter().formatToParts(value/100n).map(part=>part.type==='fraction'?fraction:part.value).join('');
}
/** The financial views a hub offers: [] when the hub has none for this kind of account. Configurações ›
 * Financeiro opens what a direct account or a reseller pays (payable) and keeps its companies' contracts
 * next to it; Clientes › Financeiro is the reseller's client billing; Plataforma › Cobrança the platform's. */
export function billingViews(host,kind) {
  if(host==='platform-billing')return ['platform'];
  if(host==='accounts')return kind==='reseller'?['reseller']:[];
  return kind==='business'||kind==='reseller'?['payable','workspace']:['workspace','payable'];
}
export function createBillingUI(ctx) {
  const {state,escape:e,icon,api,openModal,render,toast}=ctx;
  let modal=null,intent=null,busy=false,lineSequence=0,modalSequence=0,loadSequence=0,selectedView=null,query={},detailSequence=0,detailController=null,observedDialog=null,ensuring=null;
  const kind=()=>state.boot?.reseller?.accountKind||state.boot?.reseller?.kind||null;
  const views=()=>billingViews(state.view,kind());
  const view=()=>{const allowed=views();return allowed.includes(selectedView)?selectedView:allowed[0]||'workspace';};
  const key=()=>JSON.stringify([state.boot?.session?.userId||state.account?.user?.id||'',state.workspaceId||'',state.boot?.session?.role||'',Boolean(state.boot?.session?.platformOwner),state.boot?.csrfToken||state.boot?.session?.csrfToken||'',kind(),view(),state.view,state.supportGrantId||state.boot?.session?.supportGrantId||null,state.boot?.session?.permissions,state.boot?.session?.scopeRules]);
  const current=token=>token===key();
  const data=()=>state.billingScope===key()?state.billing:null;
  const money=formatBillingMoney;
  const price=cents=>`${BigInt(cents)/100n},${String(BigInt(cents)%100n).padStart(2,'0')}`;
  const today=()=>new Date().toISOString().slice(0,10);
  const button=(text,action,id='',primary=false)=>i18nHtml`<button type="button" class="ui-btn ui-btn--${primary?'primary':'secondary'} ui-btn--md" data-action="${action}" ${id?`data-id="${e(id)}"`:''}><span class="ui-btn__label">${text}</span></button>`;
  const statusTone=status=>['active','settled'].includes(status)?'success':['overdue','suspended'].includes(status)?'warning':'neutral';
  const tag=status=>i18nHtml`<span class="ui-badge ui-badge--${statusTone(status)}">${e(statuses[status]||status)}</span>`;
  const statusBadge=status=>uiBadge(statuses[status]||status,statusTone(status));
  const input=(text,name,value='',extra='')=>i18nHtml`<label class="pg-settings__field">${text}<input class="pg-settings__input" name="${name}" value="${e(value)}" ${extra}/></label>`;
  const options=(entries,chosen)=>entries.map(([id,name])=>i18nHtml`<option value="${e(id)}" ${id===chosen?'selected':''}>${e(name)}</option>`).join('');
  const contract=id=>data()?.contracts.find(item=>item.id===id);
  const invoice=id=>data()?.invoices.find(item=>item.id===id);
  const controls=form=>new FormData(form);
  const history=info=>info?i18nHtml`<p class="pg-settings__muted">Exibindo ${info.shown} de ${info.total} registros · limite desta consulta: ${info.limit}.</p>`:'';
  const pagination=(page,type)=>page?i18nHtml`<div class="pg-settings__pager"><span>${page.total?`${page.offset+1}–${Math.min(page.offset+page.limit,page.total)}`:'0'} de ${page.total}</span><div class="pg-settings__cluster">${page.offset?button(i18nT('Anterior'),`billing-${type}-page`,String(Math.max(0,page.offset-page.limit))):''}${page.hasMore?button(i18nT('Próxima'),`billing-${type}-page`,String(page.offset+page.limit)):''}</div></div>`:'';
  const modeNames=()=>({payable:i18nT('Minhas faturas'),workspace:i18nT('Empresas deste workspace'),reseller:i18nT('Clientes da revenda'),platform:i18nT('Contas da plataforma')});
  const formMarkup=(type,body,submit)=>i18nHtml`<form class="pg-settings__form" data-billing-form="${type}" data-billing-token="${modal.token}">${body}<p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions">${button(i18nT('Cancelar'),'billing-close')}<button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">${submit}</span></button></div></form>`;
  function cancelDetails(){detailSequence++;detailController?.abort();detailController=null;}
  function dialogClosed(){cancelDetails();modal=null;}
  function observeDialog(){
    const dialog=ctx.getModal?.()||globalThis.document?.querySelector('#modal');
    if(dialog!==observedDialog){observedDialog?.removeEventListener?.('close',dialogClosed);observedDialog=dialog;dialog?.addEventListener?.('close',dialogClosed);}
    return dialog;
  }
  async function readDetail(path){
    cancelDetails();const token=key(),sequence=detailSequence,controller=new AbortController(),dialog=observeDialog();
    const html=dialog?.innerHTML,open=dialog?.open;
    const active=()=>current(token)&&sequence===detailSequence&&!controller.signal.aborted&&dialog?.innerHTML===html&&dialog?.open===open;
    detailController=controller;
    try{const result=await api(path,{signal:controller.signal});return active()?result:null;}
    catch(error){if(!active())return null;throw error;}
    finally{if(detailController===controller)detailController=null;}
  }
  function header(mode) {
    const titles={platform:i18nT('Cobrança da plataforma'),reseller:i18nT('Financeiro dos clientes'),workspace:i18nT('Financeiro'),payable:i18nT('Financeiro')};
    const leads={platform:i18nT('Contratos das contas da plataforma, faturas e baixas registradas.'),reseller:i18nT('Preços acordados com seus clientes, vigência e recebimentos registrados.'),workspace:i18nT('Contratos das empresas deste workspace, faturas e baixas registradas.'),payable:i18nT('Contratos e cobranças recebidos pela sua conta.')};
    const plans=mode==='platform'&&typeof ctx.openPlans==='function'?uiButton({label:i18nT('Planos e adicionais'),action:'billing-plans',icon:'document'}):mode==='reseller'?h`<a class="ui-btn ui-btn--secondary ui-btn--md" href="#accounts/plans"><span class="ui-btn__label">${i18nT('Planos e adicionais')}</span></a>`:'';
    const actions=h`${uiButton({label:i18nT('Atualizar'),action:'billing-refresh',icon:'refresh'})}${plans}${mode!=='payable'?uiButton({label:i18nT('Novo contrato'),action:'billing-new-contract',variant:'primary',icon:'plus'}):''}`;
    return pageHeader({title:titles[mode],lead:leads[mode],actions});
  }
  function switcher(mode) {
    const modes=views();if(modes.length<2)return '';
    return h`<div class="pg-settings__cluster" role="group" aria-label="${i18nT('Visões do financeiro')}">${modes.map(id=>uiButton({label:modeNames()[id],action:'billing-view',size:'sm',variant:id===mode?'primary':'secondary',attrs:{'data-id':id,'aria-pressed':id===mode?'true':'false'}}))}</div>`;
  }
  function renderPage() {
    const mode=view();
    if(!views().length)return String(h`<div class="pg-settings pg-settings--billing">${pageHeader({title:i18nT('Financeiro dos clientes')})}${emptyState({icon:'document',title:i18nT('Esta conta não tem clientes de revenda.'),body:state.boot?.session?.platformOwner?i18nT('Os contratos da plataforma ficam em Plataforma › Cobrança.'):i18nT('As faturas desta conta ficam em Configurações › Financeiro.'),secondary:state.boot?.session?.platformOwner?{label:i18nT('Abrir Cobrança'),href:'#platform/billing'}:{label:i18nT('Abrir Financeiro'),href:'#settings/billing'}})}</div>`);
    const snapshot=data();
    if(!snapshot)return String(h`<div class="pg-settings pg-settings--billing">${header(mode)}${switcher(mode)}${emptyState({icon:'document',title:i18nT('Consulte os contratos e faturas deste acesso.'),body:i18nT('Os valores vêm do servidor a cada consulta.'),action:{label:i18nT('Carregar financeiro'),action:'billing-refresh'}})}</div>`);
    const filter=state.billingFilter||'all',rows=snapshot.invoices.filter(item=>filter==='all'||item.status===filter),managed=snapshot.contracts.filter(item=>item.canManage),received=snapshot.contracts.filter(item=>!item.canManage);
    const contractCount=snapshot.contractPage?.total??snapshot.contracts.length,invoiceCount=snapshot.invoicePage?.total??snapshot.invoices.length;
    const select=(label,name,entries,value,id)=>h`<label class="pg-settings__field pg-settings__field--narrow">${label}<select class="pg-settings__input" name="${name}"${raw(id?` id="${id}"`:'')}>${raw(options(entries,value))}</select></label>`;
    const managedTitle={platform:i18nT('Contas contratantes'),reseller:i18nT('Contratos dos clientes'),workspace:i18nT('Contratos das empresas')}[mode];
    const invoiceRows=rows.map(item=>h`<tr><th scope="row">${item.contractName}<span class="pg-settings__sub">${item.target?.name||''} · ${item.periodStart} – ${item.periodEnd}</span></th><td data-label="${i18nT('Vencimento')}">${item.dueDate}</td><td class="pg-settings__cell-num" data-label="${i18nT('Valor')}">${money(item.totalCents)}</td><td class="pg-settings__cell-num" data-label="${i18nT('Saldo')}">${money(item.outstandingCents)}</td><td data-label="${i18nT('Estado')}">${statusBadge(item.status)}</td><td class="pg-settings__cell-actions">${uiButton({label:i18nT('Ver fatura'),action:'billing-invoice-detail',size:'sm',attrs:{'data-id':item.id}})}</td></tr>`);
    return String(h`<div class="pg-settings pg-settings--billing">
      ${header(mode)}
      ${switcher(mode)}
      <dl class="pg-settings__stats"><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Contratos')}</dt><dd class="pg-settings__stat-value">${contractCount}</dd></div><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Faturas no filtro')}</dt><dd class="pg-settings__stat-value">${invoiceCount}</dd></div></dl>
      <p class="pg-settings__muted">${i18nT('{contracts} contratos · {invoices} faturas no filtro. Baixas são registros manuais de recebimentos. Nenhum pagamento é executado por esta tela.',{contracts:contractCount,invoices:invoiceCount})}</p>
      <section class="pg-settings__section pg-settings__section--flush" aria-label="${i18nT('Filtros do financeiro')}"><form data-billing-form="filter" class="pg-settings__toolbar" role="search">${raw(input(i18nT('Buscar contrato ou cliente'),'q',query.q||'','maxlength="160"'))}${select(i18nT('Cliente'),'targetId',[['',i18nT('Todos')],...snapshot.targets.map(item=>[item.id,item.name])],query.targetId||'')}${select(i18nT('Estado da fatura'),'status',[['all',i18nT('Todas')],...Object.entries(statuses).filter(([id])=>['draft','issued','partial','grace','overdue','settled','cancelled'].includes(id))],filter,'billing-status')}${uiButton({label:i18nT('Filtrar'),type:'submit'})}</form></section>
      ${received.length?h`<section class="pg-settings__section" aria-labelledby="billing-received-title"><h2 class="pg-settings__section-title" id="billing-received-title">${mode==='payable'?i18nT('Contratos recebidos'):i18nT('Plano da sua revenda')}</h2><ul class="pg-settings__cards">${received.map(contractCard)}</ul></section>`:''}
      ${mode!=='payable'?h`<section class="pg-settings__section" aria-labelledby="billing-managed-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="billing-managed-title">${managedTitle}</h2><p class="pg-settings__muted">${i18nT('O uso atual sinaliza limites; a cobrança usa os registros manuais conferidos.')}</p></div></div>${managed.length?h`<ul class="pg-settings__cards">${managed.map(contractCard)}</ul>`:h`<p class="pg-settings__muted">${i18nT('Nenhum contrato neste filtro. Cadastre os valores acordados para começar.')}</p>`}${raw(pagination(snapshot.contractPage,'contract'))}</section>`:received.length?'':h`<section class="pg-settings__section"><p class="pg-settings__muted">${i18nT('Nenhum contrato recebido neste filtro.')}</p></section>`}
      <section class="pg-settings__section pg-settings__section--flush" aria-labelledby="billing-invoices-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="billing-invoices-title">${i18nT('Faturas')}</h2><p class="pg-settings__muted">${i18nT('Rascunhos, vencimentos e baixas conciliadas.')}</p></div></div>
        <div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">${i18nT('Contrato / competência')}</th><th scope="col">${i18nT('Vencimento')}</th><th scope="col">${i18nT('Valor')}</th><th scope="col">${i18nT('Saldo')}</th><th scope="col">${i18nT('Estado')}</th><th scope="col"><span class="sr-only">${i18nT('Ações')}</span></th></tr></thead><tbody>${rows.length?invoiceRows:h`<tr><td colspan="6" class="pg-settings__empty-cell"><p class="pg-settings__muted">${i18nT('Nenhuma fatura neste filtro.')}</p></td></tr>`}</tbody></table></div>
        ${raw(pagination(snapshot.invoicePage,'invoice'))}
      </section>
    </div>`);
  }
  function contractCard(item) {
    const fixed=item.items.filter(line=>!line.metered).reduce((sum,line)=>sum+line.unitCents*line.units,0);
    const target=item.target?.name||data()?.targets.find(target=>target.id===(item.targetKind==='reseller'||item.scope==='platform'?item.targetWorkspaceId:item.tenantId))?.name||item.targetWorkspaceId;
    const cycle=i18nT('{months} {unit} · {fixed} fixos por ciclo',{months:item.periodMonths,unit:item.periodMonths===1?i18nT('mês'):i18nT('meses'),fixed:money(fixed)})+(item.items.some(line=>line.metered)?i18nT(' + uso registrado'):'');
    const validity=i18nT('Vigência {start} {end} · carência de {days} dias',{start:item.startsAt,end:item.endsAt?i18nT('a {date}',{date:item.endsAt}):i18nT('sem data final'),days:item.graceDays});
    const usage=(item.liveUsage||[]).filter(entry=>entry.metric!=='subscription').map(entry=>uiBadge(`${billingLabels[entry.metric]}: ${entry.quantity===null?i18nT('indisponível'):entry.quantity}${entry.limit!==null?` / ${entry.limit}`:''}`,entry.exceeded?'warning':'neutral'));
    const actions=[uiButton({label:i18nT('Detalhes'),action:'billing-contract-detail',size:'sm',attrs:{'data-id':item.id}}),...(item.canManage?[uiButton({label:i18nT('Editar contrato'),action:'billing-edit-contract',size:'sm',variant:'ghost',attrs:{'data-id':item.id}}),uiButton({label:i18nT('Registrar uso'),action:'billing-usage',size:'sm',variant:'ghost',attrs:{'data-id':item.id}}),uiButton({label:i18nT('Criar fatura'),action:'billing-new-invoice',size:'sm',variant:'ghost',attrs:{'data-id':item.id}})]:[])];
    return h`<li class="pg-settings__card"><div class="pg-settings__card-head"><strong class="pg-settings__strong">${item.name}</strong>${statusBadge(item.status)}</div><p class="pg-settings__text">${item.targetKind==='tenant'||item.tenantId?i18nT('Empresa'):i18nT('Conta')}: ${target}</p><p class="pg-settings__muted">${cycle}</p><p class="pg-settings__muted">${validity}</p>${usage.length?h`<div class="pg-settings__badges">${usage}</div>`:''}<p class="pg-settings__hint">${i18nT('Contagens atuais e limites são sinais de uso; não representam consumo faturado.')}</p><div class="pg-settings__cluster">${actions}</div></li>`;
  }
  async function load({renderAfter=true}={}) {
    if(state.billingTargetId){if(query.targetId!==state.billingTargetId){selectedView=null;query={targetId:state.billingTargetId};state.billingFilter='all';}query.targetId=state.billingTargetId;}
    const token=key(),sequence=++loadSequence,params=new URLSearchParams({view:view(),...query}),result=await api(`/api/billing?${params}`);if(!current(token)||sequence!==loadSequence)return false;
    if(!Array.isArray(result.contracts)||!Array.isArray(result.invoices)||!Array.isArray(result.targets))throw new Error('O servidor não confirmou os dados financeiros.');state.billing=result;state.billingScope=token;if(renderAfter)render();return true;
  }
  /** Loads once for the open hub (Clientes › Financeiro opens without the panel loader of app.js). */
  function ensure(){
    if(!views().length||data())return Promise.resolve(false);
    const token=key();if(ensuring?.token===token)return ensuring.promise;
    const promise=load().finally(()=>{if(ensuring?.promise===promise)ensuring=null;});ensuring={token,promise};return promise;
  }
  function pending() {
    if(!intent)return false;if(!current(intent.key))throw new Error('Retome a operação financeira no workspace e acesso de origem.');
    openModal(i18nT('Verificar operação financeira'),i18nT('A resposta não confirmou se a alteração foi salva.'),i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__text">Vamos repetir a mesma solicitação e conferir o resultado, sem duplicar a operação.</p><div class="pg-settings__dialog-actions">${button(i18nT('Fechar'),'billing-close')}${button(i18nT('Verificar operação'),'billing-verify-write','',true)}</div></div>`);return true;
  }
  function open(type,title,description,body,submit,record=null) {if(pending())return false;observeDialog();modal={key:key(),type,record,token:String(++modalSequence)};openModal(title,description,formMarkup(type,body,submit));return true;}
  function itemRow(item={},index=++lineSequence) {
    return i18nHtml`<fieldset data-billing-item="${index}" class="pg-settings__fieldset"><legend>Item do contrato</legend><label class="pg-settings__field">Tipo<select class="pg-settings__input" name="itemKind-${index}">${options(Object.entries(billingLabels),item.kind||'subscription')}</select></label>${input(i18nT('Descrição'),`itemLabel-${index}`,item.label||'','required maxlength="160"')}${input(i18nT('Preço unitário em R$'),`itemPrice-${index}`,item.unitCents===undefined?'':price(item.unitCents),'required inputmode="decimal" autocomplete="off" placeholder="0,00"')}${input(i18nT('Quantidade fixa'),`itemUnits-${index}`,item.units??'','required type="number" min="0" max="1000000" step="1"')}<label class="pg-settings__check"><input type="checkbox" name="itemMetered-${index}" value="yes" ${item.metered?'checked':''}/>Faturar quantidade registrada na competência</label><p class="pg-settings__hint">Para uso medido, a quantidade da fatura vem dos registros auditados do período.</p>${button(i18nT('Remover item'),'billing-remove-item',String(index))}</fieldset>`;
  }
  function editor(record=null,preset=null) {
    const snapshot=data();if(!snapshot)throw new Error('Carregue o financeiro antes de criar um contrato.');
    if(view()==='payable')throw new Error('Minhas faturas permite somente consultar.');
    if(record&&!record.canManage)throw new Error('Este plano pertence à gestão da plataforma.');
    const draft=preset?.draft;
    if(draft&&(!['platform','reseller'].includes(view())||draft.targetKind!=='reseller'||!snapshot.targets.some(item=>item.id===draft.targetWorkspaceId)))throw new Error('Este catálogo não corresponde à gestão financeira atual.');
    const type='contract',target=record?'':i18nHtml`<label class="pg-settings__field">${view()==='platform'?i18nT('Conta contratante'):view()==='reseller'?i18nT('Cliente da revenda'):i18nT('Empresa')}<select class="pg-settings__input" name="targetId" required>${options([['',i18nT('Selecione')],...snapshot.targets.map(item=>[item.id,item.name])],draft?.targetWorkspaceId||'')}</select></label>`;
    const terms=record||draft;
    const lines=(terms?.items||[{}]).map(item=>itemRow(item)).join('');
    const opened=open(type,record?i18nT('Editar contrato'):i18nT('Novo contrato'),i18nT('Configure os valores acordados. Alterações valem para novas faturas; as anteriores mantêm seus preços.'),i18nHtml`${target}${input(i18nT('Nome do contrato'),'name',terms?.name||'','required maxlength="160"')}<div data-billing-items class="pg-settings__stack">${lines}</div>${button(i18nT('Adicionar item'),'billing-add-item')}<label class="pg-settings__field">Periodicidade<select class="pg-settings__input" name="periodMonths">${options(Array.from({length:12},(_,i)=>i+1).map(n=>[String(n),`${n} ${n===1?i18nT('mês'):i18nT('meses')}`]),String(terms?.periodMonths||1))}</select></label>${input(i18nT('Início da vigência'),'startsAt',terms?.startsAt||today(),'required type="date"')}${input(i18nT('Fim da vigência (opcional)'),'endsAt',terms?.endsAt||'','type="date"')}${input(i18nT('Carência em dias'),'graceDays',terms?.graceDays??0,'required type="number" min="0" max="90" step="1"')}<label class="pg-settings__field">Estado<select class="pg-settings__input" name="state">${options([['active',i18nT('Ativo')],['suspended',i18nT('Suspenso')],['ended',i18nT('Encerrado')]],terms?.state||'active')}</select></label><fieldset class="pg-settings__fieldset"><legend>Limites de uso</legend><p class="pg-settings__muted">Deixe em branco quando não houver limite acordado. Os limites sinalizam excesso de uso.</p>${Object.entries(billingLabels).filter(([kind])=>kind!=='subscription').map(([kind,name])=>input(name,`quota-${kind}`,terms?.quotas[kind]??'','type="number" min="0" max="1000000000" step="1"')).join('')}</fieldset>${input(i18nT('Motivo / acordo registrado'),'reason','','required maxlength="500"')}`,record?i18nT('Salvar revisão'):i18nT('Criar contrato'),record);
    if(opened)modal.initialQuotas={...(terms?.quotas||{})};
  }
  function periodFields(record) {
    const anchor=new Date(`${record.startsAt}T00:00:00Z`),months=record.periodMonths,now=new Date(`${today()}T00:00:00Z`);
    if(!Number.isFinite(anchor.getTime())||!Number.isInteger(months)||months<1||months>12)throw new Error('Atualize a vigência e periodicidade do contrato.');
    const boundary=index=>{const date=new Date(anchor),day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+index*months);const last=new Date(date);last.setUTCMonth(last.getUTCMonth()+1,0);date.setUTCDate(Math.min(day,last.getUTCDate()));return date;};
    let index=Math.max(0,Math.floor(((now.getUTCFullYear()-anchor.getUTCFullYear())*12+now.getUTCMonth()-anchor.getUTCMonth())/months));if(index&&boundary(index)>now)index--;
    const start=boundary(index).toISOString().slice(0,10),last=boundary(index+1);last.setUTCDate(last.getUTCDate()-1);const end=last.toISOString().slice(0,10);
    return input(i18nT('Início da competência'),'periodStart',start,'required type="date"')+input(i18nT('Fim da competência'),'periodEnd',end,'required type="date"')+i18nHtml`<p class="pg-settings__muted">Ciclos completos de ${months} ${months===1?i18nT('mês'):i18nT('meses')}, ancorados em ${e(record.startsAt)}. Sem proração automática.${record.endsAt&&end>record.endsAt?i18nT(' Este ciclo ultrapassa a vigência; escolha um ciclo anterior completo ou revise o acordo.'):''}</p>`;
  }
  function usageReview(item,confirm=false) {
    const metered=item.snapshot.items.filter(line=>line.metered);if(!metered.length)return '';
    const review=item.snapshot.usageReview,missing=review?.missingMetrics||[];
    return i18nHtml`<fieldset class="pg-settings__fieldset"><legend>Consumo manual congelado</legend><p class="pg-settings__text">Estas quantidades vêm dos registros manuais desta competência. As contagens atuais não são faturadas automaticamente.</p>${metered.map(line=>i18nHtml`<p class="pg-settings__text">${e(line.label)}: <strong>${line.units}</strong>${missing.includes(line.kind)?i18nT(' · sem registro manual neste período'):''}</p>`).join('')}<p class="pg-settings__hint">${review?i18nTxt`${review.entries} registros manuais no rascunho.`:i18nT('Rascunho anterior: confira a origem e todas as quantidades, inclusive zero.')}</p>${confirm?i18nMarkup('<label class="pg-settings__check"><input name="usageReviewed" type="checkbox" value="yes" required/>Conferi o consumo manual desta competência, inclusive quantidades zero.</label>'):''}</fieldset>`;
  }
  const table=(head,rows)=>`<div class="pg-settings__table-wrap"><table class="pg-settings__table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  async function contractDetail(id) {
    const result=await readDetail(`/api/billing/contracts/${encodeURIComponent(id)}`);if(!result)return;const item=result.contract;if(item?.id!==id)throw new Error('O servidor não confirmou o contrato solicitado.');
    openModal(i18nT('Detalhes do contrato'),item.name,i18nHtml`<div class="pg-settings__dialog">${tag(item.status)}<p class="pg-settings__muted">Revisão ${item.version} · ${item.currency} · ${item.periodMonths} meses</p>${table(i18nMarkup('<th scope="col">Item</th><th scope="col">Preço unitário</th><th scope="col">Quantidade</th>'),item.items.map(line=>i18nHtml`<tr><td>${e(line.label)}</td><td>${money(line.unitCents)}</td><td>${line.metered?i18nT('Uso registrado'):line.units}</td></tr>`).join(''))}<h3 class="pg-settings__h3">Uso registrado por competência</h3>${history(result.historyLimits?.usage)}${(result.usage||[]).map(usage=>i18nHtml`<p class="pg-settings__text">${e(billingLabels[usage.metric])} · ${usage.quantity} · ${e(usage.periodStart)} a ${e(usage.periodEnd)}</p>`).join('')||i18nMarkup('<p class="pg-settings__muted">Nenhum uso registrado.</p>')}<h3 class="pg-settings__h3">Histórico de alterações</h3>${history(result.historyLimits?.audit)}${(result.audit||[]).map(event=>i18nHtml`<p class="pg-settings__text">${e(event.createdAt)} · ${e(event.action)}<span class="pg-settings__sub">${e(event.reason)}</span></p>`).join('')||i18nMarkup('<p class="pg-settings__muted">Sem alterações disponíveis neste acesso.</p>')}<h3 class="pg-settings__h3">Faturas do contrato</h3>${history(result.historyLimits?.invoices)}${(result.invoices||[]).map(item=>i18nHtml`<div class="pg-settings__item"><span class="pg-settings__item-main">${e(item.periodStart)} a ${e(item.periodEnd)} · ${money(item.totalCents)}</span>${button(i18nT('Ver fatura'),'billing-invoice-detail',item.id)}</div>`).join('')||i18nMarkup('<p class="pg-settings__muted">Nenhuma fatura.</p>')}</div>`);
  }
  async function invoiceDetail(id,offset) {
    const params=offset===undefined?'':`?${new URLSearchParams({settlementsOffset:String(offset),settlementsLimit:'200'})}`;
    const result=await readDetail(`/api/billing/invoices/${encodeURIComponent(id)}${params}`);if(!result)return;const item=result.invoice;if(item?.id!==id)throw new Error('O servidor não confirmou a fatura solicitada.');const canManage=item.canManage&&view()!=='payable',page=result.settlementPage;
    const pages=canManage&&page?pagination(page,'settlement').replaceAll('data-id="','data-id="'+e(id)+'|'):'';
    openModal(i18nT('Fatura'),item.contractName,i18nHtml`<div class="pg-settings__dialog">${tag(item.status)}<p class="pg-settings__muted">Competência ${e(item.periodStart)} a ${e(item.periodEnd)} · Vencimento ${e(item.dueDate)}</p>${table(i18nMarkup('<th scope="col">Item</th><th scope="col">Quantidade</th><th scope="col">Total</th>'),item.snapshot.items.map(line=>i18nHtml`<tr><td>${e(line.label)}</td><td>${line.units}</td><td>${money(line.totalCents)}</td></tr>`).join(''))}${usageReview(item)}<p class="pg-settings__text"><strong>Total ${money(item.totalCents)} · Recebido ${money(item.paidCents)} · Saldo ${money(item.outstandingCents)}</strong></p><p class="pg-settings__muted">${result.reconciliation.balanced?i18nT('Registros conciliados.'):i18nT('Divergência nos registros: revise antes de continuar.')} Recebimentos registrados manualmente.</p>${result.reconciliation.reversedCents?i18nHtml`<p class="pg-settings__muted">Baixas brutas ${money(result.reconciliation.grossLedgerCents)} · Correções ${money(result.reconciliation.reversedCents)} · Líquido ${money(result.reconciliation.ledgerPaidCents)}</p>`:''}${history(result.settlementsLimit)}${pages}${result.settlements.map(receipt=>i18nHtml`<article class="pg-settings__card"><p class="pg-settings__text">${e(receipt.settledAt)} · ${money(receipt.amountCents)} · ${e(receipt.reference)}<span class="pg-settings__sub">${e(receipt.reason)}</span></p>${receipt.reversedAt?i18nHtml`<p class="pg-settings__muted">Baixa corrigida em ${e(receipt.reversedAt)} · ${e(receipt.reversalReason)}</p>`:canManage&&receipt.canReverse?button(i18nT('Corrigir baixa'),'billing-reverse',`${id}|${receipt.id}`):''}</article>`).join('')}<div class="pg-settings__dialog-actions">${canManage&&item.state==='draft'?button(i18nT('Emitir fatura'),'billing-issue',id,true):''}${canManage&&item.state==='issued'?button(i18nT('Registrar recebimento'),'billing-settle',id,true):''}${canManage&&['draft','issued'].includes(item.state)&&item.paidCents===0?button(i18nT('Cancelar fatura'),'billing-cancel',id):''}</div></div>`);
  }
  async function action(name,id) {
    if(!name?.startsWith('billing-'))return false;cancelDetails();
    if(name==='billing-close'){modal=null;observeDialog()?.close();return true;}
    if(name==='billing-refresh'){await load();return true;}
    if(name==='billing-view'){if(!views().includes(id))throw new Error('Visão financeira indisponível.');selectedView=id;query={};state.billingTargetId=null;state.billingFilter='all';await load();return true;}
    if(name==='billing-contract-page'||name==='billing-invoice-page'){if(!/^\d+$/.test(String(id)))throw new Error('Página inválida.');query[name==='billing-contract-page'?'contractOffset':'invoiceOffset']=String(id);await load();return true;}
    if(name==='billing-verify-write'){await commit();return true;}
    if(name==='billing-contract-detail'){await contractDetail(id);return true;}
    if(name==='billing-invoice-detail'){await invoiceDetail(id);return true;}
    if(name==='billing-settlement-page'){const parts=String(id).split('|');if(parts.length!==2||!parts[0]||!/^\d+$/.test(parts[1])||Number(parts[1])>1000000)throw new Error('Página de baixas inválida.');await invoiceDetail(parts[0],Number(parts[1]));return true;}
    if(name==='billing-new-contract'){editor();return true;}
    if(name==='billing-plans'){if(typeof ctx.openPlans!=='function')throw new Error('Catálogo indisponível.');await ctx.openPlans();return true;}
    if(name==='billing-add-item'||name==='billing-remove-item') {
      if(!modal||modal.type!=='contract'||!current(modal.key))throw new Error('Abra o editor do contrato novamente.');
      const target=document.querySelector('[data-billing-items]'),rows=target?.querySelectorAll('[data-billing-item]');if(!target)throw new Error('Abra o editor novamente.');
      if(name==='billing-add-item'){if(rows.length>=20)throw new Error('Use até 20 itens por contrato.');target.insertAdjacentHTML('beforeend',itemRow());}
      else {if(rows.length<=1)throw new Error('Mantenha pelo menos um item.');[...rows].find(row=>row.dataset.billingItem===id)?.remove();}return true;
    }
    if(pending())return true;
    if(view()==='payable')throw new Error('Minhas faturas permite somente consultar.');
    if(name==='billing-edit-contract'){const record=contract(id);if(!record)throw new Error('Atualize o contrato antes de editar.');editor(record);return true;}
    if(name==='billing-new-invoice'||name==='billing-usage') {
      const record=contract(id);if(!record?.canManage)throw new Error('Atualize os contratos autorizados antes de continuar.');
      if(name==='billing-new-invoice')open('invoice',i18nT('Criar rascunho de fatura'),record.name,i18nHtml`${periodFields(record)}${input(i18nT('Vencimento'),'dueDate','','required type="date"')}${input(i18nT('Motivo da cobrança'),'reason','','required maxlength="500"')}<p class="pg-settings__muted">Os itens e o uso deste período serão congelados na fatura. A emissão é uma etapa separada.</p>`,i18nT('Criar rascunho'),record);
      else open('usage',i18nT('Registrar uso da competência'),record.name,i18nHtml`${periodFields(record)}<label class="pg-settings__field">Métrica<select class="pg-settings__input" name="metric">${options(Object.entries(billingLabels).filter(([kind])=>kind!=='subscription'),'connections')}</select></label>${input(i18nT('Quantidade a adicionar'),'quantity','','required type="number" min="0" max="1000000000" step="1"')}${input(i18nT('Origem / motivo da medição'),'reason','','required maxlength="500"')}<p class="pg-settings__muted">A quantidade será adicionada ao uso registrado, sem alterar contagens atuais ou faturas já criadas.</p>`,i18nT('Registrar uso'),record);return true;
    }
    if(['billing-issue','billing-settle','billing-cancel','billing-reverse'].includes(name)) {
      let settlementId;if(name==='billing-reverse'){const parts=String(id).split('|');if(parts.length!==2||parts.some(value=>!value))throw new Error('Selecione a baixa na fatura.');[id,settlementId]=parts;}
      const params=settlementId?`?${new URLSearchParams({settlementId})}`:'';const result=await readDetail(`/api/billing/invoices/${encodeURIComponent(id)}${params}`);if(!result)return true;const record=result.invoice;if(record?.id!==id)throw new Error('O servidor não confirmou a fatura solicitada.');if(!record.canManage)throw new Error('Este acesso permite somente consultar a fatura.');
      const operation=name.slice(8),settle=operation==='settle',reverse=operation==='reverse',receipt=reverse?result.settlements.find(item=>item.id===settlementId):null;if(reverse&&!receipt?.canReverse)throw new Error('Esta baixa já foi corrigida ou não está disponível.');
      open('event',settle?i18nT('Registrar recebimento'):reverse?i18nT('Corrigir baixa'):operation==='issue'?i18nT('Emitir fatura'):i18nT('Cancelar fatura'),record.contractName,i18nHtml`<p class="pg-settings__text">Total ${money(record.totalCents)} · Saldo ${money(record.outstandingCents)}</p>${settle?i18nHtml`${input(i18nT('Valor recebido em R$'),'amount',price(record.outstandingCents),'required inputmode="decimal"')}${input(i18nT('Referência do recebimento'),'reference','','required maxlength="120"')}${input(i18nT('Data do recebimento'),'settledAt',today(),'required type="date"')}<p class="pg-settings__muted">Registre somente um recebimento já conferido. O painel não executa este pagamento.</p>`:reverse?i18nHtml`<p class="pg-settings__text">Corrigir integralmente a baixa de ${money(receipt.amountCents)} · ${e(receipt.reference)}.</p><p class="pg-settings__muted">A correção é apenas contábil, sem devolução de dinheiro. A baixa original permanece no histórico e o saldo será reaberto.</p>`:operation==='issue'?usageReview(record,true):''}${input(i18nT('Motivo da ação'),'reason','','required maxlength="500"')}`,settle?i18nT('Confirmar baixa manual'):reverse?i18nT('Confirmar correção contábil'):operation==='issue'?i18nT('Confirmar emissão'):i18nT('Confirmar cancelamento'),{...record,operation,settlementId});return true;
    }
    return false;
  }
  async function commit() {
    if(!intent||!current(intent.key))throw new Error('Retome a operação no acesso e workspace de origem.');if(busy)return;
    const candidate=intent;busy=true;
    try {const result=await api(candidate.path,{method:candidate.method,headers:{'X-Elozi-Workspace':candidate.workspaceId},body:JSON.stringify(candidate.payload)});if(intent!==candidate||!current(candidate.key))return;if(!result?.id)throw new Error('O servidor não confirmou a operação financeira.');intent=null;modal=null;document.querySelector('#modal')?.close();toast(i18nT('Operação financeira registrada.'));try{await load();}catch{toast(i18nT('Alteração salva. Atualize o financeiro para consultar.'),true);}}
    catch(error){if(intent!==candidate||!current(candidate.key))return;if([400,401,403,404,409,413,422,429].includes(error.status)){intent=null;throw error;}pending();throw new Error('A resposta ficou incerta. Use Verificar operação para confirmar sem duplicar.');}
    finally{busy=false;}
  }
  async function submit(form) {
    const type=form?.dataset?.billingForm;if(!type)return false;cancelDetails();const fd=controls(form),body=Object.fromEntries(fd);
    if(type==='filter'){state.billingFilter=body.status||'all';state.billingTargetId=body.targetId||null;query={q:body.q||'',targetId:body.targetId||'',invoiceStatus:state.billingFilter};await load();return true;}
    if(intent){pending();throw new Error('Use Verificar operação para confirmar a solicitação preservada.');}
    if(!modal||modal.type!==type||!current(modal.key)||form.dataset.billingToken!==modal.token)throw new Error('Abra esta operação financeira novamente antes de salvar.');
    if(form.isConnected===false||observeDialog()?.open===false)throw new Error('Abra esta operação financeira novamente antes de salvar.');
    const requestId=crypto.randomUUID(),record=modal.record;let payload,path,method='POST';
    if(type==='contract') {
      const indexes=[...fd].filter(([name])=>name.startsWith('itemKind-')).map(([name])=>name.slice(9)),items=indexes.map(index=>({kind:body[`itemKind-${index}`],label:body[`itemLabel-${index}`],unitCents:parseBillingCents(body[`itemPrice-${index}`]),units:Number(body[`itemUnits-${index}`]),metered:fd.has(`itemMetered-${index}`)}));
      if(!items.length||items.some(item=>!item.label?.trim()||!Number.isSafeInteger(item.units)||item.units<0||String(body[`itemUnits-${indexes[items.indexOf(item)]}`]).trim()===''))throw new Error('Preencha descrição, preço e quantidade de cada item.');
      const quotas={...(modal.record?.quotas||modal.initialQuotas||{}),...Object.fromEntries(Object.keys(billingLabels).filter(kind=>kind!=='subscription').map(kind=>[kind,body[`quota-${kind}`]?.trim()?Number(body[`quota-${kind}`]):null]))};
      payload={requestId,name:body.name,currency:'BRL',items,quotas,periodMonths:Number(body.periodMonths),startsAt:body.startsAt,endsAt:body.endsAt||null,graceDays:Number(body.graceDays),state:body.state,reason:body.reason};
      if(record){path=`/api/billing/contracts/${encodeURIComponent(record.id)}`;method='PATCH';payload.version=record.version;}
      else {path='/api/billing/contracts';payload.scope=view()==='platform'?'platform':'workspace';if(['platform','reseller'].includes(view())){payload.targetKind='reseller';payload.targetWorkspaceId=body.targetId;}else {payload.targetKind='tenant';payload.tenantId=body.targetId;}}
    }
    if(type==='invoice'||type==='usage'){payload={requestId,version:record.version,periodStart:body.periodStart,periodEnd:body.periodEnd,reason:body.reason};if(type==='invoice')payload.dueDate=body.dueDate;else {if(!body.quantity?.trim())throw new Error('Informe a quantidade medida.');Object.assign(payload,{metric:body.metric,quantity:Number(body.quantity)});}path=`/api/billing/contracts/${encodeURIComponent(record.id)}/${type==='invoice'?'invoices':'usage'}`;}
    if(type==='event'){payload={requestId,version:record.version,action:record.operation,reason:body.reason};if(record.operation==='settle')Object.assign(payload,{amountCents:parseBillingCents(body.amount),reference:body.reference,settledAt:body.settledAt});if(record.operation==='reverse')payload.settlementId=record.settlementId;if(record.operation==='issue'&&record.snapshot.items.some(item=>item.metered)){if(!fd.has('usageReviewed'))throw new Error('Confirme a revisão do consumo manual, inclusive quantidades zero.');payload.usageReviewed=true;}path=`/api/billing/invoices/${encodeURIComponent(record.id)}/events`;}
    if(!path)return false;if(!payload.reason?.trim())throw new Error('Registre o motivo desta operação.');intent={key:modal.key,workspaceId:state.workspaceId,path,method,payload};await commit();return true;
  }
  async function openForAccount(account){cancelDetails();if(!account?.id)throw new Error('Selecione a conta comercial.');const platform=Boolean(state.boot?.session?.platformOwner);state.view=platform?'platform-billing':kind()==='reseller'?'accounts':'billing';selectedView=null;query={targetId:account.id};state.billingTargetId=account.id;state.billingFilter='all';await load();}
  async function openFromPlan(preset){cancelDetails();const origin=key(),sequence=detailSequence;if(preset?.requiresReview!==true||!preset.draft)throw new Error('Revise um plano válido.');if(intent)throw new Error('Verifique primeiro a operação financeira pendente.');await load({renderAfter:false});if(!current(origin)||sequence!==detailSequence)return false;editor(null,preset);return true;}
  function reset(){cancelDetails();modal=null;loadSequence++;ensuring=null;selectedView=null;query={};state.billingTargetId=null;state.billing=null;state.billingScope=null;state.billingFilter='all';}
  return {render:renderPage,markup:renderPage,load,ensure,action,submit,reset,openForAccount,openFromPlan};
}
