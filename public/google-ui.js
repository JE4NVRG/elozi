const sdkURL = 'https://accounts.google.com/gsi/client';
let sdkPromise = null, activeMount = null;

function loadGoogleSDK() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${sdkURL}"]`), owned = false, settled = false;
    if (!script) { script = document.createElement('script'); script.src = sdkURL; script.async = true; script.defer = true; script.dataset.eloziGoogleSdk = 'true'; owned = true; }
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      script.removeEventListener('load', loaded); script.removeEventListener('error', failed);
      if (error) { if (owned) script.remove(); reject(error); }
      else resolve(window.google.accounts.id);
    };
    const loaded = () => finish(window.google?.accounts?.id ? null : new Error('O Google não disponibilizou o acesso.'));
    const failed = () => finish(new Error('Não foi possível carregar o acesso com Google.'));
    const timer = setTimeout(failed, 15000);
    script.addEventListener('load', loaded, { once: true }); script.addEventListener('error', failed, { once: true });
    if (owned) document.head.append(script);
  }).catch(error => { sdkPromise = null; throw error; });
  return sdkPromise;
}

/** One active, server-issued challenge per page. Callback receives only the ID token. */
export async function mountGoogleButton(element, config, callback, { text = 'signin_with' } = {}) {
  if (!element || typeof element.replaceChildren !== 'function') throw new Error('Informe o espaço do botão Google.');
  if (typeof callback !== 'function') throw new Error('Informe o retorno do acesso Google.');
  activeMount?.destroy(); element.replaceChildren();
  if (!config?.enabled) { element.hidden = true; return null; }
  if (typeof config.clientId !== 'string' || !/^[A-Za-z0-9._-]{8,180}\.apps\.googleusercontent\.com$/.test(config.clientId)
    || typeof config.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(config.nonce)) throw new Error('O acesso Google precisa de uma configuração válida.');
  if (!['signin_with', 'signup_with', 'continue_with'].includes(text)) throw new Error('Texto do botão Google inválido.');
  const mount = { destroyed: false, observer: null, destroy() { this.destroyed = true; this.observer?.disconnect(); if (activeMount === this) { element.replaceChildren(); activeMount = null; } } };
  activeMount = mount;
  const sdk = await loadGoogleSDK();
  if (mount.destroyed || activeMount !== mount || !element.isConnected) return mount;
  element.hidden = false;
  sdk.initialize({ client_id: config.clientId, nonce: config.nonce, auto_select: false, ux_mode: 'popup', callback: response => {
    if (mount.destroyed || activeMount !== mount || !element.isConnected || typeof response?.credential !== 'string' || !response.credential) return;
    callback(response.credential);
  } });
  let renderedWidth = null, renderedLocale = null;
  const render = () => {
    if (mount.destroyed || activeMount !== mount || !element.isConnected) return;
    const available = Math.floor(element.getBoundingClientRect().width);
    if (available <= 0) return;
    const width = Math.min(400, Math.max(200, available));
    const locale = getLocale();
    if (width === renderedWidth && locale === renderedLocale) return;
    element.replaceChildren();
    sdk.renderButton(element, { type: 'standard', theme: 'outline', size: 'large', text, shape: 'rectangular', logo_alignment: 'left', locale, width: String(width) });
    renderedWidth = width; renderedLocale = locale;
  };
  render();
  mount.renderLocale = render;
  if (typeof window.ResizeObserver === 'function') {
    mount.observer = new window.ResizeObserver(render);
    mount.observer.observe(element);
  }
  return mount;
}
import { getLocale } from './i18n.js';
import './locales-auth.js';
