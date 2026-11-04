import { mountGoogleButton } from './google-ui.js';
import { t, getLocale, setLocale, translateError, translateStatic } from './i18n.js';
import { parseHash, formatHash } from './router.js';
function readLoginLocale() {
  try {
    const requested = new URL(window.location.href).searchParams.get('lang');
    return requested === 'en' || requested === 'pt-BR' ? requested : null;
  } catch { return null; }
}
const requestedLocale = readLoginLocale();
setLocale(requestedLocale ?? getLocale(), { persist: requestedLocale !== null, notify: false });
import './locales-auth.js';

const $ = selector => document.querySelector(selector);
const state = { mode: 'login', status: null, busy: false, loading: false, googleGeneration: 0, googleMount: null, linkToken: '', invitation: null, linkInvalid: false, localeChanged: false, completed: false, success: null, notice: null, verification: null, errors: new Map() };
const usernamePattern = '[A-Za-z0-9][A-Za-z0-9._-]{2,63}';
// Re-authentication of an open panel (FRONTEND-V2 §7.2): /login?return=close was opened by the panel
// in a new window. After the login it tells the panel (opener and BroadcastChannel 'elozi-auth',
// only to this origin) and closes, so the panel resumes with the text and the attachments in place.
const returnClose = (() => { try { return new URL(window.location.href).searchParams.get('return') === 'close'; } catch { return false; } })();
const workspaceReturn = (() => {
  try {
    // Without ?next, a fragment brought by the server's redirect from / (a deep link opened without a session) is the return.
    const next = new URL(window.location.href).searchParams.get('next') ?? (window.location.hash ? '/' + window.location.hash : null);
    if (typeof next !== 'string' || !next.startsWith('/#')) return '/';
    const route = parseHash(next.slice(1));
    return route ? '/' + formatHash({ ...route, query: {} }) : '/';
  } catch { return '/'; }
})();
function announceLogin(userId) {
  const message = { type: 'elozi:reauth-ok', userId: typeof userId === 'string' ? userId : '' };
  try { window.opener?.postMessage?.(message, window.location.origin); } catch { /* the panel may be gone */ }
  try { if (typeof BroadcastChannel === 'function') { const channel = new BroadcastChannel('elozi-auth'); channel.postMessage(message); channel.close(); } } catch { /* older browsers */ }
}

async function api(path, payload, { method } = {}) {
  let response, result;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method: method || (payload === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30000)
    });
    result = await response.json();
  } catch { throw Object.assign(new Error('Não foi possível confirmar a conexão. Tente novamente.'), { uncertain: true }); }
  if (!response.ok) throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'Não foi possível concluir seu acesso.'), { status: response.status });
  return result;
}

function errorAt(selector, message = '') {
  state.errors.set(selector, message);
  const text = typeof message === 'function' ? message() : message;
  const element = $(selector); element.textContent = text ? typeof message === 'function' ? text : translateError(text) : ''; element.hidden = !text;
}
function applyProductBrand(status) {
  const name=typeof status?.productName==='string'&&status.productName.trim()?status.productName.slice(0,48):'Elozi';
  document.title=name+t(' · Acessar');
  $('#product-name').textContent=name;$('#product-signature').textContent=status.brand?name:'Elozi · JE4NDEV';
  const wordmark=$('#product-name').closest?.('a');wordmark?.setAttribute('aria-label',name);
  // The colors of the address's brand come from GET /brand.css (tokens derived on the server for both themes, P10),
  // so the page never writes a color taken from a response.
  const logo=status?.brand?.logo;if(typeof logo==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)){$('.wordmark-symbol img').src=logo;$('.wordmark-symbol img').alt='';}
}
function field(labelId, inputId, visible, required = visible) {
  $(`#${labelId}`).hidden = !visible;
  const input = $(`#${inputId}`); input.disabled = !visible; input.required = visible && required;
}
const publicTrial = () => state.status?.publicTrial?.days === 7 && state.status.publicTrial.documentRequired === true;
function registrationDocument({ focus = true } = {}) {
  if (state.mode !== 'register' || !publicTrial()) return {};
  const value = $('#fiscal-document').value.trim();
  const compact = value.toUpperCase().replace(/[.\/-\s]/g, '');
  if (!/^[A-Za-z0-9.\/\-\s]+$/.test(value) || !/^(?:\d{11}|[A-Z0-9]{12}\d{2})$/.test(compact)) {
    const message = 'Informe o CPF ou CNPJ completo. O CNPJ pode conter letras.';
    errorAt('#fiscal-document-error', message); $('#fiscal-document').setAttribute('aria-invalid', 'true'); if (focus) $('#fiscal-document').focus();
    throw new Error(message);
  }
  errorAt('#fiscal-document-error'); $('#fiscal-document').removeAttribute('aria-invalid');
  return { fiscalDocument: value };
}
function submitLabel(working = false) {
  return state.mode === 'setup' ? (working ? t('Criando seu acesso… ') : t('Criar meu acesso '))
    : state.mode === 'register' ? (working ? t('Criando sua conta… ') : publicTrial() ? t('Criar conta e iniciar teste ') : t('Criar minha conta '))
      : state.mode === 'invite' ? (working ? t('Confirmando seu acesso… ') : t('Aceitar convite e entrar '))
        : state.mode === 'reset' ? (working ? t('Salvando sua senha… ') : t('Salvar nova senha '))
          : state.mode === 'forgot' ? (working ? t('Solicitando recuperação… ') : t('Enviar link de recuperação '))
      : (working ? t('Entrando… ') : t('Entrar '));
}
function setBusy(value) {
  state.busy = value;
  $('#submit-button').disabled = value; $('#submit-button').firstChild.textContent = submitLabel(value);
  $('#registration-toggle').disabled = value;
  $('#forgot-password').disabled = value;
  $('#access-form').setAttribute('aria-busy', String(value));
  $('#google-login').inert = value;
}

function renderMode({ focus = true } = {}) {
  const setup = state.mode === 'setup', registration = state.mode === 'register', invite = state.mode === 'invite', reset = state.mode === 'reset', forgot = state.mode === 'forgot', creating = setup || registration || invite || reset;
  $('#form-eyebrow').textContent = invite ? t('SUA EQUIPE CONVIDOU VOCÊ') : reset || forgot ? t('RECUPERAR ACESSO') : setup ? t('BEM-VINDO À ELOZI') : registration ? t('SUA OPERAÇÃO COMEÇA AQUI') : t('SEU WORKSPACE');
  $('#form-heading').textContent = invite ? t('Você já tem um lugar na equipe.') : reset ? t('Escolha sua nova senha.') : forgot ? t('Vamos recuperar seu acesso.') : setup ? t('Crie seu primeiro acesso.') : registration ? t('Um espaço para o seu negócio.') : t('Que bom ter você por aqui.');
  $('#form-intro').textContent = setup ? t('Você será o administrador da plataforma. Escolha seus dados para começar.')
    : registration ? t('Crie sua conta de gestão e organize o atendimento com a sua marca.')
      : invite ? t('Confirme seus dados para entrar nas empresas autorizadas pela sua equipe.')
        : reset ? t('Depois de salvar, entre novamente com sua conta e a nova senha.')
          : forgot ? t('Informe o e-mail cadastrado na sua conta. Se ela estiver habilitada, enviaremos um link de recuperação.')
            : t('Entre com seu usuário ou e-mail para continuar o atendimento.');
  field('name-field', 'name', setup || registration || invite);
  field('company-field', 'company', registration);
  field('account-kind-field','account-kind',registration);
  $('#registration-context').hidden = !(registration && publicTrial());
  field('fiscal-document-field', 'fiscal-document', registration && publicTrial());
  const invitationEmail = invite && state.invitation?.email;
  field('email-field', 'email', setup || registration || forgot || invite, registration || forgot);
  $('#email').readOnly = Boolean(invitationEmail);
  $('#email-field').firstChild.textContent = setup || invite && !invitationEmail ? t('E-mail (opcional)') : t('E-mail');
  field('username-field', 'username', setup || invite || state.mode === 'login');
  $('#username-field').firstChild.textContent = setup || invite ? t('Usuário') : t('Usuário ou e-mail');
  $('#username').maxLength = setup || invite ? 64 : 254;
  $('#username').inputMode = 'text';
  if (setup || invite) $('#username').setAttribute('pattern', usernamePattern); else $('#username').removeAttribute('pattern');
  $('#username-help').hidden = !(setup || invite);
  $('#password-label').hidden = forgot;
  $('#password-label').firstChild.textContent = reset ? t('Nova senha') : t('Senha');
  $('#password').disabled = forgot; $('#password').required = !forgot;
  field('confirmation-field', 'password-confirmation', creating);
  $('#password-confirmation').minLength = creating ? 8 : 0;
  $('#password').autocomplete = creating ? 'new-password' : 'current-password';
  $('#password').minLength = creating ? 8 : 1;
  $('#password-help').hidden = !creating;
  $('#password-help').textContent = t('Use de 8 a 128 caracteres, uma letra maiúscula e um caractere especial.');
  $('#submit-button').firstChild.textContent = submitLabel(state.busy);
  $('#registration-toggle').hidden = !['login', 'register'].includes(state.mode) || !state.status?.registrationEnabled;
  $('#forgot-password').hidden = state.mode !== 'login';
  $('#return-login').hidden = !['invite', 'reset', 'forgot'].includes(state.mode);
  $('#invitation-context').hidden = !invite || !state.invitation;
  $('#registration-toggle').firstChild.textContent = registration ? t('Já tenho uma conta. Entrar ') : publicTrial() ? t('Criar conta e testar por 7 dias ') : t('Criar minha conta ');
  $('#access-note').textContent = setup ? t('Depois de entrar, você poderá organizar as empresas e os acessos da sua equipe.')
    : registration ? publicTrial() ? t('Depois de entrar, o painel mostra o prazo e os passos para preparar sua operação.') : t('Sua conta terá um painel próprio. Organize sua empresa e filiais ou cadastre clientes da sua revenda.')
      : invite ? t('O convite define seu acesso. Você não precisa criar outra empresa.')
        : reset ? t('Ao trocar a senha, os acessos anteriores à sua conta serão encerrados.')
          : forgot ? t('Sem acesso ao e-mail? Peça ajuda ao administrador da sua equipe.')
            : t('Seu acesso acompanha as empresas e os canais autorizados para você.');
  $('#access-form').hidden = state.linkInvalid;
  if (focus && !state.linkInvalid) (forgot ? $('#email') : reset ? $('#password') : creating ? $('#name') : $('#username')).focus();
}

async function renderGoogle() {
  const generation = ++state.googleGeneration;
  state.googleMount?.destroy(); state.googleMount = null;
  $('#google-login').replaceChildren(); $('#google-login').hidden = true;
  $('#google-divider').hidden = true;
  $('#google-access').hidden = !['login', 'register'].includes(state.mode);
  if (!['login', 'register'].includes(state.mode)) return;
  const config = state.status?.google;
  if (!config?.enabled) { errorAt('#google-status', 'O acesso com Google está em configuração.'); return; }
  errorAt('#google-status', 'Preparando o acesso com Google…');
  $('#google-login').hidden = false;
  try {
    const mounted = await mountGoogleButton($('#google-login'), config, submitGoogle, { text: state.mode === 'register' ? 'signup_with' : 'signin_with' });
    if (generation !== state.googleGeneration) { mounted?.destroy(); return; }
    state.googleMount = mounted;
    $('#google-divider').hidden = !mounted;
    errorAt('#google-status');
  } catch {
    if (generation !== state.googleGeneration) return;
    $('#google-login').hidden = true;
    errorAt('#google-status', 'O acesso com Google não carregou. Você pode entrar com seu usuário ou e-mail.');
  }
}

async function loadStatus({ focus = true, resetMode = false } = {}) {
  if (state.loading || state.busy) return;
  if (state.mode === 'invite' || state.mode === 'reset') return loadLink({ focus });
  state.loading = true; $('#retry-status').hidden = true; errorAt('#status-error');
  try {
    state.status = await api('status');
    state.notice = null;
    applyProductBrand(state.status);
    if (state.status.setupRequired && state.mode !== 'forgot') state.mode = 'setup';
    else if (resetMode || state.mode === 'setup' || (state.mode === 'register' && !state.status.registrationEnabled)) state.mode = 'login';
    renderMode({ focus });
    state.loading = false;
    renderGoogle();
  } catch (error) {
    if (!state.status) { state.notice = { heading: 'Vamos retomar a conexão.', intro: 'Seu acesso estará aqui assim que a conexão voltar.' }; $('#form-heading').textContent = t(state.notice.heading); $('#form-intro').textContent = t(state.notice.intro); }
    errorAt('#status-error', error.message); $('#retry-status').hidden = false;
  } finally { state.loading = false; }
}

async function submitGoogle(credential) {
  if (state.busy || state.loading || !['login', 'register'].includes(state.mode)) return;
  const mode = state.mode;
  errorAt('#form-error');
  let document;
  try { document = registrationDocument(); } catch (error) { errorAt('#form-error', error.message); return; }
  const payload = { credential, ...(mode === 'register' ? { accountKind: $('#account-kind').value, locale: getLocale(), ...document } : {}) };
  setBusy(true);
  try { await api('google', payload); await openWorkspace(mode); }
  catch (error) {
    errorAt('#form-error', error.message);
    if (mode === 'register' && publicTrial() && /CPF|CNPJ|documento fiscal/i.test(error.message)) {
      errorAt('#fiscal-document-error', error.message); $('#fiscal-document').setAttribute('aria-invalid', 'true');
    }
    setBusy(false);
    await loadStatus({ focus: false });
  } finally { credential = ''; payload.credential = ''; if ('fiscalDocument' in payload) payload.fiscalDocument = ''; setBusy(false); }
}

$('#fiscal-document').addEventListener('blur', () => {
  if (state.mode === 'register' && publicTrial() && $('#fiscal-document').value.trim()) {
    try { registrationDocument({ focus: false }); } catch { /* The field displays the correction. */ }
  }
});

$('#retry-status').addEventListener('click', () => loadStatus());
$('#forgot-password').addEventListener('click', () => {
  if (state.busy || state.loading || state.mode !== 'login') return;
  if ($('#username').value.includes('@')) $('#email').value = $('#username').value.trim();
  state.mode = 'forgot'; errorAt('#form-error'); renderMode(); renderGoogle();
});
$('#registration-toggle').addEventListener('click', () => {
  if (state.busy || state.loading || state.mode === 'setup' || !state.status?.registrationEnabled) return;
  if (state.mode === 'login') {
    if ($('#username').value.includes('@') && !$('#email').value) $('#email').value = $('#username').value.trim();
    state.mode = 'register';
  } else { if ($('#email').value) $('#username').value = $('#email').value.trim(); state.mode = 'login'; }
  $('#password').value = ''; $('#password-confirmation').value = ''; errorAt('#form-error'); errorAt('#fiscal-document-error'); $('#fiscal-document').removeAttribute('aria-invalid'); renderMode(); renderGoogle();
});
$('#password-visibility').addEventListener('click', () => {
  const show = $('#password').type === 'password';
  $('#password').type = show ? 'text' : 'password'; $('#password-confirmation').type = show ? 'text' : 'password';
  $('#password-visibility').textContent = show ? t('Ocultar') : t('Mostrar'); $('#password-visibility').setAttribute('aria-label', show ? t('Ocultar senha') : t('Mostrar senha')); $('#password-visibility').setAttribute('aria-pressed', String(show));
});
async function openWorkspace(mode = 'login') {
  let confirmed;
  try { confirmed = await api('me'); }
  catch {
    if (mode === 'register' || mode === 'setup' || mode === 'invite') {
      if (mode === 'register') $('#username').value = $('#email').value.trim();
      state.mode = 'login'; state.linkToken = ''; state.invitation = null; renderMode({ focus: false }); renderGoogle();
      throw new Error('Sua conta foi criada, mas não foi possível confirmar a sessão neste navegador. Entre com os mesmos dados para continuar.');
    }
    throw new Error('Não foi possível confirmar sua sessão neste navegador. Tente entrar novamente ou confira se os cookies estão permitidos.');
  }
  if (state.localeChanged) {
    try { if (confirmed.user?.locale !== getLocale()) await api('me', { locale: getLocale() }, { method: 'PATCH' }); }
    catch {
      showSuccess('Seu acesso está pronto.', 'Seu acesso foi confirmado, mas o idioma não pôde ser salvo. Você pode ajustá-lo no perfil.');
      state.success.link = 'Abrir meu workspace';
      $('#workspace-link').setAttribute('href', workspaceReturn); $('#workspace-link').firstChild.textContent = t('Abrir meu workspace');
      return;
    }
  } else if (['pt-BR', 'en'].includes(confirmed.user?.locale)) setLocale(confirmed.user.locale);
  state.completed = true;
  $('#password').value = ''; $('#password-confirmation').value = '';
  $('#access-form').hidden = true; $('#registration-toggle').hidden = true;
  $('#forgot-password').hidden = true; $('#return-login').hidden = true; $('#invitation-context').hidden = true;
  $('#google-access').hidden = true; $('#registration-context').hidden = true; $('#access-success').hidden = false;
  state.success = { heading: 'Seu acesso está pronto.', message: mode === 'register' || mode === 'setup' || mode === 'invite'
    ? 'Conta criada e acesso confirmado. Se o painel não abrir automaticamente, use o botão abaixo.'
    : 'Acesso confirmado. Se o painel não abrir automaticamente, use o botão abaixo.', link: 'Abrir meu workspace' };
  $('#success-message').textContent = t(state.success.message);
  announceLogin(confirmed.user?.id);
  if (returnClose) {
    state.success = { heading: 'Seu acesso está pronto.', message: 'Sessão renovada. Volte ao painel: seu texto continua lá. Esta janela pode ser fechada.', link: 'Voltar ao painel' };
    $('#success-message').textContent = t(state.success.message);
    $('#workspace-link').firstChild.textContent = t('Voltar ao painel');
    try { window.close(); } catch { /* not opened by a script: the message stays */ }
    return;
  }
  window.location.replace(workspaceReturn);
}
$('#access-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy || state.loading || !state.status || state.linkInvalid) return; errorAt('#form-error');
  if (!$('#access-form').reportValidity()) return;
  if (state.mode === 'forgot') {
    setBusy(true);
    try {
      const result = await api('password/forgot', { email: $('#email').value.trim() });
      if (!result.configured) {
        errorAt('#form-error', 'A recuperação por e-mail ainda não está disponível. Peça ao administrador da sua equipe para ajudar com seu acesso.');
      } else showSuccess('Confira seu e-mail.', 'Se houver uma conta habilitada com este e-mail, enviaremos as instruções. Confira também a caixa de spam.');
    } catch (error) { errorAt('#form-error', error.message); }
    finally { setBusy(false); }
    return;
  }
  const creating = state.mode !== 'login', password = $('#password').value;
  if (state.mode === 'invite' && !new RegExp(`^${usernamePattern}$`).test($('#username').value.trim())) {
    errorAt('#form-error', 'Escolha um usuário de 3 a 64 letras, números, pontos, traços ou sublinhados.'); $('#username').focus(); return;
  }
  if (creating && (password.length < 8 || password.length > 128 || !/\p{Lu}/u.test(password) || !/[^\p{L}\p{N}\s]/u.test(password))) {
    errorAt('#form-error', 'Use de 8 a 128 caracteres, uma letra maiúscula e um caractere especial.'); $('#password').focus(); return;
  }
  if (creating && password !== $('#password-confirmation').value) { errorAt('#form-error', 'As senhas precisam ser iguais. Confira a confirmação.'); $('#password-confirmation').focus(); return; }
  const mode = state.mode;
  let document;
  try { document = registrationDocument(); } catch (error) { errorAt('#form-error', error.message); return; }
  const invitationEmail = mode === 'invite' && !state.invitation?.email ? $('#email').value.trim() : '';
  const payload = mode === 'invite' ? { token: state.linkToken, name: $('#name').value.trim(), username: $('#username').value.trim(), password, ...(invitationEmail ? { email: invitationEmail } : {}) }
    : mode === 'reset' ? { token: state.linkToken, password }
      : mode === 'register' ? { name: $('#name').value.trim(), email: $('#email').value.trim(), company: $('#company').value.trim(), accountKind:$('#account-kind').value,password,locale:getLocale(),...document }
    : { username: $('#username').value.trim(), password, ...(mode === 'setup' ? { name: $('#name').value.trim(), email: $('#email').value.trim() || undefined } : {}) };
  setBusy(true);
  try {
    await api(mode === 'invite' ? 'invitations/accept' : mode === 'reset' ? 'password/reset' : mode === 'register' ? 'register' : mode === 'setup' ? 'setup' : 'login', payload);
    if (mode === 'reset') {
      state.linkToken = ''; $('#password').value = ''; $('#password-confirmation').value = '';
      showSuccess('Senha atualizada.', 'As sessões anteriores foram encerradas. Entre novamente usando sua nova senha.');
    } else { if (mode === 'invite') state.linkToken = ''; await openWorkspace(mode); }
  }
  catch (error) {
    errorAt('#form-error', error.uncertain && mode === 'invite'
      ? 'Não foi possível confirmar o aceite. Seu acesso pode ter sido criado. Tente entrar com o usuário e a senha escolhidos; se ainda não tiver acesso, volte a este convite.'
      : error.uncertain && mode === 'reset'
        ? 'Não foi possível confirmar a troca de senha. Tente entrar com a nova senha; se ela não funcionar, solicite um novo link de recuperação.'
        : error.message);
    if (mode === 'register' && publicTrial() && /CPF|CNPJ|documento fiscal/i.test(error.message)) {
      errorAt('#fiscal-document-error', error.message); $('#fiscal-document').setAttribute('aria-invalid', 'true');
    }
    const invalidToken400 = error.status === 400 && (mode === 'invite' && /^Convite inválido(?:[.,]| ou )/.test(error.message)
      || mode === 'reset' && /^Recuperação inválida ou expirada\./.test(error.message));
    const terminalLink = ['invite', 'reset'].includes(mode) && ([401, 403, 404, 410].includes(error.status) || invalidToken400);
    if (terminalLink) {
      state.linkInvalid = true; state.linkToken = ''; $('#access-form').hidden = true; $('#return-login').hidden = false;
      $('#retry-status').hidden = true;
      errorAt('#status-error', () => t('{message} Peça um novo link para continuar.', { message: translateError(error.message) }));
    }
    if (mode === 'setup' && error.status === 409) { setBusy(false); await loadStatus({ resetMode: true }); }
    else (terminalLink ? $('#return-login') : $('#password')).focus();
  } finally { payload.password = ''; if ('token' in payload) payload.token = ''; if ('fiscalDocument' in payload) payload.fiscalDocument = ''; setBusy(false); }
});

function showSuccess(heading, message) {
  state.completed = true; state.success = { heading, message, link: 'Voltar para entrar ' };
  $('#access-form').hidden = true; $('#registration-toggle').hidden = true; $('#forgot-password').hidden = true;
  $('#google-access').hidden = true; $('#google-divider').hidden = true; $('#access-success').hidden = false;
  $('#success-heading').textContent = t(heading); $('#success-message').textContent = t(message);
  $('#workspace-link').setAttribute('href', '/login'); $('#workspace-link').firstChild.textContent = t('Voltar para entrar ');
  $('#return-login').hidden = true;
}

async function loadLink({ focus = true } = {}) {
  if (state.loading || state.busy) return;
  state.loading = true; state.status = {}; $('#retry-status').hidden = true; errorAt('#status-error');
  $('#access-form').hidden = true; $('#return-login').hidden = false; renderGoogle();
  try {
    if (!state.linkToken) throw Object.assign(new Error('Este link está incompleto. Peça um novo convite ou solicite a recuperação novamente.'), { status: 400 });
    if (state.mode === 'invite') {
      state.notice = { heading: 'Conferindo seu convite…', intro: 'Vamos confirmar a equipe e os acessos que esperam por você.' };
      $('#form-heading').textContent = t(state.notice.heading); $('#form-intro').textContent = t(state.notice.intro);
      const preview = await api('invitations/preview', { token: state.linkToken });
      if(preview.productBrand)applyProductBrand({brand:preview.productBrand,productName:preview.productBrand.name});
      state.invitation = preview;
      $('#name').value = preview.name || ''; $('#email').value = preview.email || '';
      $('#invitation-workspace').textContent = preview.workspaceName || preview.workspace?.name || t('Sua equipe');
      $('#invitation-email').textContent = preview.email || t('Não informado no convite');
      $('#invitation-role').textContent = preview.role === 'reseller' ? t('Administrador do workspace') : preview.role === 'operator' ? t('Atendente') : t('Acesso definido pela equipe');
      $('#invitation-tenants').textContent = (preview.tenantNames || preview.tenants?.map(item => item.name) || []).join(', ') || t('Empresas autorizadas pelo administrador');
      const expires = new Date(preview.expiresAt);
      $('#invitation-expiry').textContent = Number.isNaN(expires.getTime()) ? t('Confira com sua equipe') : expires.toLocaleString(getLocale() === 'en' ? 'en-US' : 'pt-BR');
    }
    state.notice = null; state.linkInvalid = false; renderMode({ focus });
  } catch (error) {
    state.linkInvalid = true;
    state.notice = { heading: 'Vamos retomar seu acesso.', intro: 'Não foi possível confirmar este link.' };
    $('#form-heading').textContent = t(state.notice.heading); $('#form-intro').textContent = t(state.notice.intro);
    errorAt('#status-error', error.message);
    $('#retry-status').hidden = [400, 401, 403, 404, 410].includes(error.status);
    if ($('#retry-status').hidden) state.linkToken = '';
  } finally { state.loading = false; }
}

async function verifyEmailLink() {
  if (window.location.pathname !== '/verify-email') return;
  const url = new URL(window.location.href), token = url.searchParams.get('token');
  const feedback = document.createElement('p'); feedback.id = 'verification-status'; feedback.className = 'provider-status'; feedback.setAttribute('role', 'status');
  $('#form-intro').insertAdjacentElement('afterend', feedback);
  state.verification = { element: feedback, message: 'Confirmando seu e-mail…', error: false };
  feedback.textContent = t(state.verification.message);
  try {
    if (!token) throw new Error('Este link de confirmação está incompleto. Solicite outro na sua conta.');
    await api('verify-email', { token }); state.verification.message = 'E-mail confirmado. Você já pode continuar com sua conta.'; feedback.textContent = t(state.verification.message);
  } catch (error) { state.verification.message = error.message; state.verification.error = true; feedback.className = 'form-error'; feedback.setAttribute('role', 'alert'); feedback.textContent = translateError(error.message); }
  finally { url.searchParams.delete('token'); window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); }
}

function renderLocale() {
  const active = document.activeElement;
  translateStatic(document);
  $('#login-locale').value = getLocale();
  if (state.status) applyProductBrand(state.status);
  if (state.status && !state.completed && !state.notice) renderMode({ focus: false });
  if (state.notice) { $('#form-heading').textContent = t(state.notice.heading); $('#form-intro').textContent = t(state.notice.intro); }
  if (state.success) { $('#success-heading').textContent = t(state.success.heading); $('#success-message').textContent = t(state.success.message); $('#workspace-link').firstChild.textContent = t(state.success.link); }
  if (state.verification) state.verification.element.textContent = state.verification.error ? translateError(state.verification.message) : t(state.verification.message);
  for (const [selector, message] of state.errors) errorAt(selector, message);
  const shown = $('#password').type === 'text';
  $('#password-visibility').textContent = t(shown ? 'Ocultar' : 'Mostrar');
  $('#password-visibility').setAttribute('aria-label', t(shown ? 'Ocultar senha' : 'Mostrar senha'));
  if (state.invitation) {
    const preview = state.invitation;
    if (!preview.workspaceName && !preview.workspace?.name) $('#invitation-workspace').textContent = t('Sua equipe');
    if (!(preview.tenantNames || preview.tenants?.map(item => item.name) || []).join(', ')) $('#invitation-tenants').textContent = t('Empresas autorizadas pelo administrador');
    $('#invitation-role').textContent = t(preview.role === 'reseller' ? 'Administrador do workspace' : preview.role === 'operator' ? 'Atendente' : 'Acesso definido pela equipe');
    if (!preview.email) $('#invitation-email').textContent = t('Não informado no convite');
    const expires = new Date(preview.expiresAt);
    $('#invitation-expiry').textContent = Number.isNaN(expires.getTime()) ? t('Confira com sua equipe') : expires.toLocaleString(getLocale() === 'en' ? 'en-US' : 'pt-BR');
  }
  state.googleMount?.renderLocale?.();
  if (active && document.activeElement !== active) active.focus?.();
}
$('#login-locale').addEventListener('change', event => {
  const locale = event.target?.value ?? $('#login-locale').value;
  if (!['pt-BR', 'en'].includes(locale)) return;
  state.localeChanged = true; setLocale(locale); renderLocale();
});
window.addEventListener?.('elozi:localechange', renderLocale);
renderLocale();

const accessUrl = new URL(window.location.href);
if (['/accept-invite', '/reset-password'].includes(accessUrl.pathname)) {
  state.mode = accessUrl.pathname === '/accept-invite' ? 'invite' : 'reset';
  const fragment = new URLSearchParams(accessUrl.hash.slice(1)), tokens = fragment.getAll('token');
  if (tokens.length === 1 && tokens[0] && tokens[0].length <= 512) state.linkToken = tokens[0];
  fragment.delete('token'); accessUrl.searchParams.delete('token'); accessUrl.hash = fragment.toString();
  window.history.replaceState(null, '', `${accessUrl.pathname}${accessUrl.search}${accessUrl.hash}`);
}
if (accessUrl.searchParams.get('reason') === 'session-expired') {
  errorAt('#form-error', 'Sua sessão não foi confirmada ou expirou. Entre novamente para continuar.');
  accessUrl.searchParams.delete('reason');
  window.history.replaceState(null, '', `${accessUrl.pathname}${accessUrl.search}${accessUrl.hash}`);
}
// "Criar conta" on the public site (src/public-site.js) opens sign-up; loadStatus falls back to sign-in where registration is closed.
if (accessUrl.pathname === '/login' && accessUrl.searchParams.get('cadastro') === '1') {
  state.mode = 'register';
  accessUrl.searchParams.delete('cadastro');
  window.history.replaceState(null, '', `${accessUrl.pathname}${accessUrl.search}${accessUrl.hash}`);
}
await verifyEmailLink();
loadStatus();
