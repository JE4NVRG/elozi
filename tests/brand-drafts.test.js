import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrandDrafts } from '../public/brand-drafts.js';

test('brand drafts preserve separate edits and prepared logos while switching scopes', () => {
  const drafts = createBrandDrafts(), ctx = { workspaceId: 'w1', tenantId: 't1' };
  const company = drafts.get({ ...ctx, scope: 'tenant', brand: { name: 'Company', accent: '#3157d5' } });
  Object.assign(company, { name: 'Draft company', initials: 'DC', domain: 'chat.example.test', accent: '#112233', logo: 'prepared image', logoChanged: true });
  const platform = drafts.get({ ...ctx, scope: 'reseller', brand: { name: 'Platform' } });
  platform.name = 'Draft platform';
  assert.equal(drafts.get({ ...ctx, scope: 'tenant', brand: { name: 'Server refresh' } }), company);
  assert.equal(company.logoChanged, true);
  assert.equal(company.domain, 'chat.example.test');
  assert.equal(company.accent, '#112233');
  assert.equal(drafts.get({ ...ctx, scope: 'reseller' }).name, 'Draft platform');
  drafts.invalidate('tenant');
  assert.equal(drafts.get({ ...ctx, scope: 'tenant', brand: { name: 'Saved company' } }).name, 'Saved company');
  assert.equal(drafts.get({ ...ctx, scope: 'reseller' }), platform);
});

test('brand drafts cannot cross company, workspace or reset boundaries', () => {
  const drafts = createBrandDrafts();
  const load = (workspaceId, tenantId) => drafts.get({ workspaceId, tenantId, scope: 'tenant', brand: { name: 'Saved' } });
  const old = load('w1', 't1'); old.name = 'Private draft';
  assert.equal(load('w1', 't2').name, 'Saved');
  assert.equal(load('w1', 't1').name, 'Saved');
  load('w1', 't1').name = 'Other draft';
  assert.equal(load('w2', 't1').name, 'Saved');
  const current = load('w2', 't1'); drafts.reset();
  assert.notEqual(load('w2', 't1'), current);
});
