// Keep application deep links and installed-app entry going through sign-in.
// Fixed public IDs, scoped to their actual SSR page; tests bind every entry to rendered source.
const sections = {
  '/': ['como-funciona', 'planos', 'conteudo', 'recursos', 'canais', 'agentes', 'faq'],
  '/precos': ['conteudo', 'planos', 'canais', 'faq'],
  '/contato': ['conteudo', 'fale-conosco', 'contratacao', 'ajuda', 'dados-pessoais'],
  '/termos': ['conteudo', 'servico', 'conta', 'condicoes-comerciais', 'canais-e-ia', 'whatsapp-qr', 'limites', 'encerramento'],
  '/privacidade': ['conteudo', 'informacoes', 'finalidades', 'acesso-e-integracoes', 'cookies', 'retencao', 'seus-direitos']
};
for (const [pt, en] of [['/', '/en/'], ['/precos', '/en/pricing'], ['/contato', '/en/contact'], ['/termos', '/en/terms'], ['/privacidade', '/en/privacy']]) sections[en] = sections[pt];
const english = location.pathname === '/en/' || location.pathname?.startsWith('/en/');
const publicSection = sections[location.pathname || '/']?.includes(location.hash.slice(1));
if ((location.hash.length > 1 && !publicSection) || window.matchMedia?.('(display-mode: standalone)').matches) {
  location.replace((english ? '/login?lang=en' : '/login') + location.hash);
}

// Native details remains usable without JS; this only provides dismissal, never a modal/focus trap.
function initSiteMenu() {
  const menu = document.querySelector('[data-site-menu]');
  if (!menu) return;
  const summary = menu.querySelector('summary');
  const close = (restoreFocus = false) => {
    if (!menu.open) return;
    menu.open = false;
    if (restoreFocus) summary.focus();
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      event.preventDefault();
      close(menu.contains(document.activeElement));
    }
  });
  document.addEventListener('click', event => {
    if (!menu.open) return;
    if (!menu.contains(event.target)) close();
    else if (event.target.closest('a[href]')) close(true);
  });
  document.addEventListener('focusin', event => {
    if (!menu.contains(event.target)) close();
  });
}
// Plain links work without JS/storage. Only an explicit language click writes a preference.
function initSiteLocale() {
  for (const anchor of document.querySelectorAll?.('[data-site-locale]') || []) {
    const base = anchor.getAttribute('href');
    const update = () => {
      const id = location.hash.slice(1);
      anchor.setAttribute('href', base + (id && sections[base]?.includes(id) && document.getElementById(id) ? location.hash : ''));
    };
    update();
    window.addEventListener?.('hashchange', update);
    anchor.addEventListener('click', () => {
      update();
      try { window.localStorage.setItem('elozi:locale', anchor.getAttribute('data-site-locale')); } catch { /* Storage is optional. */ }
    });
  }
}
function initSite() { initSiteMenu(); initSiteLocale(); }
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSite, { once: true });
  else initSite();
}
