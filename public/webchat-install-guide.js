import { t } from './i18n.js';
import './locales-webchat-install.js';

export const WEBCHAT_INSTALL_STEPS = Object.freeze(['authorize', 'appearance', 'install', 'validate']);
export const WEBCHAT_INSTALL_PLATFORMS = Object.freeze(['html', 'saas', 'wordpress', 'other']);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const labels = Object.freeze({ authorize: 'Autorizar site', appearance: 'Personalizar', install: 'Instalar', validate: 'Validar' });
const titles = Object.freeze({ authorize: 'Onde seu chat vai aparecer?', appearance: 'Um chat com a sua marca', install: 'Leve o chat para o seu site', validate: 'Confira a conversa de ponta a ponta' });
const hints = Object.freeze({
  authorize: 'Tenha acesso para publicar scripts no site e confira o endereço HTTPS exato. Cadastre a origem, sem caminhos, antes de instalar.',
  appearance: 'Ajuste a aparência e o atendimento deste canal. A prévia é local; salve quando estiver pronto.',
  install: 'Use o código deste canal em um site autorizado. Você precisa de acesso à área de scripts ou ao código do site.',
  validate: 'Depois de publicar o código, abra o site autorizado como visitante e faça um teste com a equipe.'
});
const actionButton = (token, action, label, { primary = false, disabled = false, attributes = '' } = {}) => `<button type="button" class="button${primary ? ' primary' : ''}" data-connector-action="${action}" data-connector-token="${escapeHTML(token)}" ${disabled ? 'disabled' : ''} ${attributes}>${label}</button>`;

/** Only confirmed server configuration grants installation readiness. No client completion flags. */
export function webchatInstallReadiness(status) {
  return Boolean(status?.enabled === true && Array.isArray(status.origins) && status.origins.length && typeof status.install?.embedSnippet === 'string' && status.install.embedSnippet);
}

/** Presentation shell around the existing configuration/designer forms, never another modal. */
export function renderWebchatInstallGuide({ step = 'authorize', status, token = '', content = '', text = t, escape = escapeHTML, hasDraft = false } = {}) {
  const current = WEBCHAT_INSTALL_STEPS.includes(step) ? step : 'authorize', index = WEBCHAT_INSTALL_STEPS.indexOf(current), label = source => escape(text(source));
  const authorized = status?.enabled === true && Array.isArray(status.origins) && status.origins.length > 0;
  const steps = WEBCHAT_INSTALL_STEPS.map((name, position) => `<li data-webchat-step-state="${name === current ? 'current' : 'available'}">${actionButton(token, `webchat-step-${name}`, `<span class="webchat-install__number" aria-hidden="true">${position + 1}</span><span>${label(labels[name])}</span>`, { attributes: name === current ? 'aria-current="step"' : '' })}</li>`).join('');
  const previous = index ? actionButton(token, `webchat-step-${WEBCHAT_INSTALL_STEPS[index - 1]}`, label('Voltar')) : '';
  const next = index < WEBCHAT_INSTALL_STEPS.length - 1 ? actionButton(token, `webchat-step-${WEBCHAT_INSTALL_STEPS[index + 1]}`, label(current === 'appearance' ? 'Continuar para instalação' : current === 'install' ? 'Continuar para validação' : 'Usar aparência salva'), { primary: current !== 'authorize' }) : '';
  return `<section class="webchat-install" data-webchat-install-guide data-webchat-install-step="${current}"><nav class="webchat-install__progress" aria-label="${label('Etapas de instalação do webchat')}"><ol>${steps}</ol></nav><header class="webchat-install__heading"><div><p class="webchat-install__eyebrow">${label('Webchat no seu site')} <span aria-hidden="true">·</span> ${index + 1}/4</p><h3 tabindex="-1" data-webchat-guide-heading>${label(titles[current])}</h3><p>${label(hints[current])}</p></div><span class="webchat-install__server-status" data-ready="${authorized}">${label(authorized ? 'Origem habilitada no servidor' : 'Autorize e habilite o site')}</span></header>${hasDraft ? `<p class="webchat-install__draft" role="status">${label('Seu rascunho está preservado neste painel. Instalação e teste usam a configuração salva no servidor.')}</p>` : ''}<div class="webchat-install__content">${content}</div>${previous || next ? `<footer class="webchat-install__navigation">${previous}<span class="webchat-install__navigation-next">${next}</span></footer>` : ''}</section>`;
}

export function renderWebchatInstallation({ status, token = '', platform = 'html', text = t, escape = escapeHTML, notice = '' } = {}) {
  const current = WEBCHAT_INSTALL_PLATFORMS.includes(platform) ? platform : 'html', label = source => escape(text(source)), ready = webchatInstallReadiness(status);
  const platformLabels = { html: 'Site HTML ou SaaS', saas: 'SaaS com usuário logado', wordpress: 'WordPress', other: 'Outra plataforma' };
  const instructions = {
    html: ['No projeto do site, abra o layout compartilhado das páginas onde o chat deve aparecer.', 'Cole o código antes de </body>, uma única vez. Em um SaaS, use o layout da área de suporte desejada.', 'Publique o site e confira a página pelo endereço autorizado.'],
    saas: ['No backend do SaaS, confirme o login e o acesso à conta atual antes de assinar o JWT v2.', 'Use accountId para a conta e sub para o usuário. O segredo de assinatura fica somente no backend.', 'Instale o módulo no código da área de suporte. Ao trocar de conta ou sair, atualize a sessão do chat.'],
    wordpress: ['No painel do seu site, procure o recurso autorizado de scripts globais ou código personalizado.', 'Se o recurso permitir JavaScript, cole o código no rodapé das páginas desejadas e publique. Preserve o script completo.', 'Se o site não oferecer esse recurso, peça à pessoa responsável pelo site para instalar o código.'],
    other: ['Abra a área de scripts globais, código personalizado ou incorporações da plataforma.', 'Cole o código completo no rodapé das páginas desejadas, uma única vez, e publique.', 'Se a plataforma bloquear scripts, peça à pessoa responsável pelo site para conferir a opção disponível.']
  };
  const choices = WEBCHAT_INSTALL_PLATFORMS.map(name => actionButton(token, `webchat-platform-${name}`, label(platformLabels[name]), { attributes: `aria-pressed="${current === name}"` })).join('');
  const code = current==='saas'?status?.install?.authenticatedSnippet:status?.install?.embedSnippet;
  let signer='';try{const script=new URL(status.install.scriptUrl);if(script.pathname==='/widget.js'&&(script.protocol==='https:'||script.protocol==='http:'&&['127.0.0.1','localhost'].includes(script.hostname))&&!script.username&&!script.password)signer=script.origin+'/webchat-identity-sdk.js';}catch{}
  const backend=signer&&code&&current==='saas'?`<p><a class="button" href="${escape(signer)}" download="webchat-identity.mjs">${label('Baixar assinador Node.js para o backend')}</a></p>`:'';
  const snippet = ready && typeof code==='string' && code ? `<div class="webchat-install__code"><div class="webchat-install__code-heading"><strong>${label('Código deste canal')}</strong>${actionButton(token, 'copy-webchat-code', label('Copiar código'), { primary: true })}</div><label><span class="sr-only">${label('Código de instalação do webchat')}</span><textarea readonly rows="${current==='saas'?12:4}" data-webchat-snippet aria-label="${label('Código de instalação do webchat')}" spellcheck="false">${escape(code)}</textarea></label><p data-webchat-copy-status role="status" aria-live="polite"></p></div>` : ready ? `<p>${label('Atualize o servidor da Elozi para obter o exemplo autenticado deste canal.')}</p>` : `<p class="webchat-install__prerequisite">${label('Salve uma origem autorizada e habilite o canal para liberar o código de instalação.')}</p>${actionButton(token, 'webchat-step-authorize', label('Autorizar site'), { primary: true })}`;
  const authenticated = current==='saas'?`<aside class="webchat-install__instructions"><h4>${label('Identidade e troca de conta')}</h4><p>${label('Substitua CONTA_ATUAL e USUARIO_ATUAL pelos identificadores da sessão do SaaS. O endpoint confere os dois no servidor; parâmetros do navegador não concedem acesso.')}</p><p>${label('Configure a identidade verificada deste canal e publique o endpoint antes de ativar conta e usuário. Falha de identificação bloqueia o atendimento autenticado.')}</p>${actionButton(token,'identity-settings',label('Identidade verificada'))}<details><summary>${label('CSP e validação do SaaS')}</summary><p>${label('Autorize os módulos da Elozi em script-src e a API em connect-src. Para estilos restritos, passe o nonce da página. Confira também as origens das imagens e blob: para mídia.')}</p><p>${label('Teste duas contas do mesmo usuário, troca de conta, logout, resposta da equipe e pedido humano. O teste do canal comprova transporte; identidade e isolamento precisam desses cenários.')}</p></details></aside>`:`<p>${label('Este código atende visitantes. Para identificar contas e usuários, escolha SaaS com usuário logado.')}</p>`;
  return `<div class="webchat-install__installation"><div class="webchat-install__platforms" role="group" aria-label="${label('Plataforma do seu site')}">${choices}</div><div class="webchat-install__instructions"><h4>${label(platformLabels[current])}</h4><ol>${instructions[current].map(instruction => `<li>${label(instruction)}</li>`).join('')}</ol>${current === 'wordpress' ? `<p>${label('A disponibilidade desse recurso depende da hospedagem, do plano e das permissões do seu site.')}</p>` : ''}</div>${snippet}${backend}${authenticated}<p class="webchat-install__note">${label('Copiar o código não confirma a instalação. A validação acontece no site publicado, com uma conversa real.')}</p><p class="form-error" role="alert">${escape(notice)}</p></div>`;
}

export function renderWebchatValidation({ status, token = '', text = t, escape = escapeHTML, notice = '' } = {}) {
  const label = source => escape(text(source)), ready = webchatInstallReadiness(status);
  return `<div class="webchat-install__validation"><div class="webchat-install__instructions"><ol>${['Abra uma página com o widget no endereço autorizado.', 'Inicie uma conversa de teste e confira se ela chega ao Atendimento neste canal.', 'Responda com a equipe e confira a resposta no site. Se houver agente conectado, confira também a transferência para uma pessoa.'].map(instruction => `<li>${label(instruction)}</li>`).join('')}</ol></div><p class="webchat-install__note">${label('O teste consulta a jornada deste canal. Ele não marca o site como instalado nem envia mensagem por você.')}</p>${ready ? actionButton(token, 'test-journey', label('Abrir teste deste canal'), { primary: true }) : `${actionButton(token, 'webchat-step-authorize', label('Autorizar site'), { primary: true })}<p>${label('Habilite a origem antes de testar a recepção do webchat.')}</p>`}<p class="form-error" role="alert">${escape(notice)}</p></div>`;
}

export function renderWebchatServiceChoices({ token = '', text = t, escape = escapeHTML } = {}) {
  const label = source => escape(text(source));
  return `<aside class="webchat-install__service"><div><h4>${label('Escolha quem atende')}</h4><p>${label('Confira a equipe e as conexões autorizadas antes de receber visitantes.')}</p></div><div class="webchat-install__service-links"><a class="button" href="#settings/team" data-connector-action="webchat-open-team" data-connector-token="${escape(token)}">${label('Equipe humana')}</a><a class="button" href="#agents" data-connector-action="webchat-open-agents" data-connector-token="${escape(token)}">${label('Perfil e conhecimento')}</a><a class="button" href="#agents/connect" data-connector-action="webchat-open-connect" data-connector-token="${escape(token)}">${label('Conectar meu agente')}</a></div><small>${label('Abrir essas páginas não cria acessos nem escolhe um modelo.')}</small></aside>`;
}

/** Clipboard accepts only the DTO's canonical snippet, and guards both sides of the await. */
export async function copyWebchatInstallCode({ snippet, clipboard = globalThis.navigator?.clipboard, guard = () => false, onSuccess = () => {}, onFailure = () => {} } = {}) {
  const current = () => { try { return guard() === true; } catch { return false; } };
  if (!current() || typeof snippet !== 'string' || !snippet) return false;
  try {
    if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
    await clipboard.writeText(snippet);
    if (!current()) return false;
    onSuccess(); return true;
  } catch {
    if (current()) onFailure();
    return false;
  }
}
