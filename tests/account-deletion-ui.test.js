import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setLocale } from '../public/i18n.js';
import { createAccountDeletionUI, deletionEndpoint, namesMatch, deletionErrorMessage, countLines, ownerEligible, dialogMarkup, ownerSectionMarkup, afterSelfDeletionUrl, ACCOUNT_DELETION_MESSAGES } from '../public/account-deletion-ui.js';
import { SUBSCRIPTION_PLANS, EXTRA_NUMBER_CENTS, salesMailto, SALES_EMAIL } from '../public/subscription-ui.js';
import { ACCOUNT_DELETION_CODES } from '../src/commercial-account-deletion.js';

test('account deletion UI: endpoints, name confirmation, counts and every backend code localized in PT and EN', () => {
  setLocale('pt-BR', { persist: false, notify: false });
  assert.equal(deletionEndpoint('self'), '/api/account/delete');
  assert.equal(deletionEndpoint('platform', 'reseller_a/b'), '/api/platform/accounts/reseller_a%2Fb/delete');
  assert.throws(() => deletionEndpoint('platform', ''));
  assert.ok(namesMatch('  empresa   SINTÉTICA ', 'Empresa Sintética')); assert.ok(!namesMatch('Empresa', 'Empresa Sintética')); assert.ok(!namesMatch('', ''));
  assert.deepEqual(countLines({ tenants: 1, channels: 2, conversations: 0, unlinkedUsers: 1 }), ['1 empresas', '2 canais', '1 acessos de outras contas serão apenas desvinculados']);
  for (const code of ACCOUNT_DELETION_CODES) assert.ok(ACCOUNT_DELETION_MESSAGES[code], code);
  assert.equal(deletionErrorMessage({ code: 'account_delete_subscription_active', message: 'x' }), 'Cancele a assinatura em Configurações > Financeiro antes de excluir a conta.');
  setLocale('en', { persist: false, notify: false });
  for (const code of ACCOUNT_DELETION_CODES) assert.notEqual(deletionErrorMessage({ code }), ACCOUNT_DELETION_MESSAGES[code], 'EN copy for ' + code);
  assert.equal(deletionErrorMessage({ status: 429 }), 'Too many deletion attempts. Wait a minute.');
  const dialog = dialogMarkup({ mode: 'platform', name: 'Cliente <b>', counts: { tenants: 1 } });
  assert.match(dialog, /Your platform administrator password/); assert.match(dialog, /Cliente &lt;b&gt;/); assert.match(dialog, /data-account-deletion-confirm disabled/);
  assert.match(ownerSectionMarkup(), /data-action="account-deletion:open"/);
  assert.equal(afterSelfDeletionUrl('en'), '/login?deleted=1&lang=en'); assert.equal(afterSelfDeletionUrl('pt-BR'), '/login?deleted=1');
  setLocale('pt-BR', { persist: false, notify: false });
});

test('account deletion UI: only owners of directly billed companies see the self-service section', () => {
  const boot = (session, reseller) => ({ session: { role: 'reseller', ...session }, reseller: { accountKind: 'business', parentWorkspaceId: 'mep-demo', ...reseller } });
  assert.equal(ownerEligible(boot()), true);
  assert.equal(ownerEligible(boot({ role: 'operator' })), false);
  assert.equal(ownerEligible(boot({ platformOwner: true })), false);
  assert.equal(ownerEligible(boot({}, { accountKind: 'reseller' })), false);
  assert.equal(ownerEligible(boot({}, { parentWorkspaceId: 'reseller_partner' })), false);
  assert.equal(ownerEligible(boot(), { supportGrantId: 'grant' }), false);
});

test('panel wiring: app passes deletion codes through, mounts the section and the platform action; login sends the signup locale', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), accounts = await readFile(new URL('../public/accounts-ui.js', import.meta.url), 'utf8'), login = await readFile(new URL('../public/login.js', import.meta.url), 'utf8');
  assert.match(app, /\^\(\?:account_delete_\[a-z_\]\+\|/);
  assert.match(app, /accountDeletionEligible\(state\.boot/); assert.match(app, /onDelete:account=>accountDeletionUI\.open\(\{mode:'platform'/);
  assert.match(accounts, /delete:onDelete/); assert.match(accounts, /account\.accountKind !== 'platform' \? button\('delete'/);
  assert.match(login, /accountKind: \$\('#account-kind'\)\.value, locale: getLocale\(\)/); assert.match(login, /password,locale:getLocale\(\)/);
});

test('subscription terms stay exact and the sales mailto names the plan', () => {
  assert.deepEqual(SUBSCRIPTION_PLANS.map(plan => [plan.key, plan.cents, plan.numbers, plan.users]), [['conecta', 4900, 1, 2], ['equipe', 9900, 2, 5], ['operacao', 19900, 5, 15]]);
  assert.equal(EXTRA_NUMBER_CENTS, 2900); assert.equal(SALES_EMAIL, 'jean@je4ndev.com');
  assert.equal(salesMailto('Equipe'), 'mailto:jean@je4ndev.com?subject=Elozi%20-%20contratar%20plano%20Equipe');
  assert.equal(salesMailto(), 'mailto:jean@je4ndev.com?subject=Elozi%20-%20contratar%20plano');
});


test('account deletion UI: requests send JSON text bodies (the panel api() passes body to fetch as-is)', async () => {
  const calls = [];
  const request = async (path, options) => { calls.push({ path, options }); return { name: 'Empresa Sintética', counts: { tenants: 1 } }; };
  const ui = createAccountDeletionUI({ request, openModal: () => {}, getModal: () => null, toast: () => {} });
  await ui.open({ mode: 'platform', workspaceId: 'reseller_x', name: 'Empresa Sintética' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/platform/accounts/reseller_x/delete');
  assert.equal(typeof calls[0].options.body, 'string');
  assert.deepEqual(JSON.parse(calls[0].options.body), { dryRun: true });
  const source = await readFile(new URL('../public/account-deletion-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /body: \{/, 'every request body must be JSON.stringify(...)');
});
