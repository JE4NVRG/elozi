// Single allowlist of the panel's static files (FRONTEND-V2 §8.1).
//
// src/server.js serves exactly these paths and scripts/verify.mjs compares the served bytes of
// every asset with the source. tests/asset-graph.test.js requires every module reachable from
// app.js/login.js and every <link>/<script> of index.html/login.html to be listed here, because
// scripts/staging.mjs serves any file of public/ and would hide a production 404.
// Files stay flat in public/ (check.mjs, verify.mjs and the i18n coverage are not recursive).
// Frozen after P1: a file that P2–P8 did not pre-register only enters in P10. Commit 1f pre-registered
// every new module, catalog and stylesheet of P2–P8 (stubs with today's behaviour, §8.2).

/** HTML entry points: route → file. Served with no-store; not part of the asset SHA check. */
export const PANEL_PAGES = Object.freeze({
  '/': 'index.html',
  '/login': 'login.html',
  '/verify-email': 'login.html',
  '/accept-invite': 'login.html',
  '/reset-password': 'login.html'
});

/**
 * Brand of the address for the login page (P10): src/server.js writes it per host from the active
 * custom domain (brand-theme.js tokens), so it has no file in public/ and no fixed SHA to verify.
 */
export const BRAND_STYLESHEET_PATH = '/brand.css';
/** Routes that pages may link and that src/server.js generates instead of reading from public/. */
export const PANEL_DYNAMIC_ASSETS = Object.freeze([BRAND_STYLESHEET_PATH]);

/** Static assets served at '/' + file, byte-identical to public/<file>. */
export const PANEL_ASSETS = Object.freeze([
  // Application modules.
  'account-invitations-ui.js', 'account-security-ui.js', 'accounts-ui.js', 'agent-admin-proposals-ui.js',
  'agent-memory-ui.js', 'agent-pace.js', 'app-entry.js', 'app.js', 'attendance-read-ui.js', 'attendance-ui.js', 'automation-channels.js', 'automation-ui.js', 'avatar-ui.js',
  'billing-ui.js', 'brand-drafts.js', 'brand-theme.js', 'channel-capabilities.js', 'channel-connectors-ui.js', 'channel-journey.js', 'channel-validation-view.js',
  'chat-layout.js', 'commercial-usage-ui.js', 'connected-products-ui.js', 'consolidated-inbox-ui.js', 'contact-import-ui.js',
  'contact-links-ui.js', 'contact-refresh.js', 'conversation-tools.js', 'customer-context-ui.js',
  'flow-departments-ui.js', 'flow-workspace-ui.js', 'follow-ups-ui.js', 'forwarding.js', 'google-ui.js', 'group-history-import-ui.js',
  'groups-workspace-ui.js', 'guide-ui.js', 'i18n.js', 'icons.js', 'inbox-live.js', 'integrations-ui.js',
  'json-read.js', 'knowledge-ui.js', 'locale-ui.js', 'login.js', 'mcp-ui.js', 'media-ui.js', 'modal-route-lifecycle.js', 'nav-config.js',
  'operation-readiness.js', 'overview-ui.js', 'participants-ui.js', 'plans-ui.js', 'platform-users-ui.js', 'product-agent-connections.js', 'product-connect-ui.js',
  'replies-ui.js', 'router.js', 'inbox-route-filters.js', 'send-intent.js', 'send-unload-guard.js', 'service-handoffs-ui.js', 'service-principals-ui.js', 'shell-ui.js', 'support-assistant-ui.js',
  'support-ui.js', 'team-chat-ui.js', 'telegram-account-ui.js', 'telegram-groups-ui.js', 'theme-prefs.js', 'ui.js', 'units-ui.js',
  'voice-recorder.js', 'webchat-media.js', 'webchat-install-guide.js', 'webchat-install-guide.css', 'webchat-identity-sdk.js', 'widget.js', 'widget-saas.js', 'widget-designer.js', 'widget-designer.css', 'workspace-domains-ui.js', 'workspace-ui.js',
  // Seams and stubs of P1 commit 1f (FRONTEND-V2 §8.1–§8.2), each owned by the package in parentheses.
  'actions.js',
  'live.js', 'connection-status.js', 'session-guard.js', 'drafts-store.js', 'data-source.js', 'attention.js', // P2
  'notify.js', 'keyboard.js', 'command-palette.js', // P2
  'inbox-list-ui.js', 'composer-ui.js', 'dom-patch.js', // P3
  'agent-rail-ui.js', // P4
  'agents-hub-ui.js', 'agent-detail-ui.js', 'agent-usage-ui.js', // P5
  'agent-connect-wizard.js', 'pending-ui.js', 'mcp-catalog.js', // P6
  'channels-ui.js', 'channel-connect-flow.js', 'channel-visitor-test-ui.js', 'onboarding-ui.js', // P7
  'settings-ui.js', // P8
  'subscription-ui.js', // Elozi self-service subscription (Stripe Checkout/Portal), launch wave 03/11/2026
  'account-deletion-ui.js', // LGPD account deletion (owner settings and platform accounts)
  // Public site of Elozi's own host (src/public-site.js): hands panel links opened without a session over to sign-in.
  'site.js',
  // Translation catalogs (PT is the key; each catalog adds EN).
  'locales-agent-journey.js', 'locales-auth.js', 'locales-channel-journey.js', 'locales-customer-context.js',
  'locales-guided-setup.js', 'locales-management.js', 'locales-media.js', 'locales-operation-readiness.js', 'locales-operations.js', 'locales-webchat-install.js',
  'locales-platform-users.js', 'locales-product-review.js', 'locales-shell.js',
  'locales-agent-detail-recovery.js', 'locales-channel-recovery.js', 'locales-conversation-coverage.js',
  'locales-guide-journey.js', 'locales-inbox-route-recovery.js', 'locales-knowledge-recovery.js',
  'locales-palette-recovery.js', 'locales-send-recovery.js',
  'locales-follow-ups.js', 'locales-subscription.js', 'locales-account-deletion.js',
  // Born empty in commit 1f, one per package: P2, P3, P4, P5, P6, P7, P8.
  'locales-live.js', 'locales-inbox.js', 'locales-agent-rail.js', 'locales-agents-hub.js', 'locales-agent-connect.js',
  'locales-telegram-account.js', 'locales-home.js', 'locales-settings.js', 'locales-support-central.js',
  // Stylesheets. tokens.css (layer order and tokens) and base.css (reset layer) are the first links of
  // index.html; components.css holds the .ui-* components (layer components) and shell.css the .sh-*
  // shell (layer shell); the legacy sheets still in use stay wrapped in @layer legacy
  // (tests/css-layers.test.js). P10 removed the 15 sheets that P1, P3, P7 and P8 had emptied.
  'tokens.css', 'base.css', 'components.css', 'shell.css',
  // Born empty in commit 1f (layers shell/screens): P2, P3, P4, P5, P6, P7, P7, P8.
  'live.css', 'screen-inbox.css', 'agent-rail.css', 'screen-agents.css', 'agent-connect.css', 'screen-home.css',
  'screen-telegram-account.css', 'screen-channels.css', 'channel-visitor-test.css', 'screen-settings.css',
  'agent-memory.css', 'automation.css', 'frontend.css', 'knowledge.css', 'login.css', 'mcp.css', 'service-principals.css',
  'styles.css', 'follow-ups.css', 'team-chat.css', 'workspace-polish.css', 'workspace-shell.css',
  // Images, fonts and the web app manifest (P10: installable panel, icons drawn from mark.svg).
  'mark.svg', 'fonts/manrope-latin-wght-normal.woff2',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'social-pt.png', 'social-en.png'
]);

/** Route → file map consumed by src/server.js. */
export const PANEL_STATIC_FILES = Object.freeze({
  ...PANEL_PAGES,
  ...Object.fromEntries(PANEL_ASSETS.map(file => ['/' + file, file]))
});

/** Routes whose served bytes scripts/verify.mjs compares with the source SHA-256. */
export const VERIFIED_ASSET_PATHS = Object.freeze(PANEL_ASSETS.map(file => '/' + file));
