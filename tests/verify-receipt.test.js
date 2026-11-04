import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeVerificationReceipt } from '../scripts/verify.mjs';

const release = () => ({
  version: '0.20.0', state: 'PRODUCTION-COMMERCIAL-PILOT',
  origin: 'https://elozi.example', verifiedAt: '2026-10-03T06:34:03.368Z',
  sourceSHA256: 'published-source-sha', sourceRevision: 'published-revision',
  health: { status: 'ok', version: '0.20.0' },
  manifest: [{ path: 'public/app.js', sha256: 'published-asset-sha' }],
  served: [{ path: '/app.js', sha256: 'published-asset-sha', verified: true }],
  runtime: { imageId: 'sha256:production', previousImage: 'sha256:rollback', recoveryImage: 'elozi:recovery' },
  artifact: { transportSHA256: 'archive-sha', localRecoveryArchivePreserved: true },
  cleanup: { remoteTransportRemoved: true, noGlobalPrune: true },
  validation: { node: { pass: 1294, fail: 0 } },
  backups: { pre: { id: 'pre', pinned: true }, post: { id: 'post', pinned: true } },
  previousReleases: [{ sourceRevision: 'older-revision' }],
  journeys: [{ transport: 'whatsapp_qr', accepted: true }],
  customReleaseEvidence: { retained: true }
});
const proof = (overrides = {}) => ({
  version: '0.21.0', origin: 'http://127.0.0.1:49554',
  verifiedAt: '2026-10-03T10:00:00.000Z', sourceSHA256: 'new-source-sha',
  health: { status: 'ok', version: '0.21.0' },
  manifest: [{ path: 'public/app.js', sha256: 'new-asset-sha' }],
  served: [{ path: '/app.js', sha256: 'new-asset-sha', verified: true }],
  ...overrides
});

test('nova fonte conserva release, rollback, transporte e aceite como evidência anterior', () => {
  const previous = release(), verification = proof();
  const originalRelease = structuredClone(previous), originalProof = structuredClone(verification);
  const result = mergeVerificationReceipt(previous, verification);
  const { latestVerification, ...recordedRelease } = result;
  assert.deepEqual(recordedRelease, originalRelease);
  assert.equal(latestVerification.sourceSHA256, 'new-source-sha');
  assert.equal(latestVerification.health.version, '0.21.0');
  assert.equal(latestVerification.matchesRecordedSource, false);
  assert.equal(latestVerification.matchesRecordedOrigin, false);
  assert.equal(Object.hasOwn(latestVerification, 'runtime'), false);
  assert.equal(Object.hasOwn(latestVerification, 'validation'), false);
  assert.deepEqual(previous, originalRelease);
  assert.deepEqual(verification, originalProof);
});

test('preview da mesma fonte não renova aceite ou origem da produção', () => {
  const previous = release();
  const result = mergeVerificationReceipt(previous, proof({ version: previous.version, sourceSHA256: previous.sourceSHA256 }));
  assert.equal(result.state, previous.state);
  assert.equal(result.origin, previous.origin);
  assert.equal(result.verifiedAt, previous.verifiedAt);
  assert.equal(result.latestVerification.matchesRecordedSource, true);
  assert.equal(result.latestVerification.matchesRecordedOrigin, false);
});

test('mesma fonte e origem registram conferência HTTP sem renovar gates de release', () => {
  const previous = release();
  const result = mergeVerificationReceipt(previous, proof({ version: previous.version, sourceSHA256: previous.sourceSHA256, origin: previous.origin }));
  assert.equal(result.latestVerification.matchesRecordedSource, true);
  assert.equal(result.latestVerification.matchesRecordedOrigin, true);
  assert.deepEqual(result.validation, previous.validation);
  assert.equal(result.verifiedAt, previous.verifiedAt);
});

test('verificações sucessivas substituem apenas a prova HTTP mais recente', () => {
  const previous = release(), firstProof = proof();
  const first = mergeVerificationReceipt(previous, firstProof);
  const second = mergeVerificationReceipt(first, proof({ sourceSHA256: 'next-source-sha' }));
  assert.equal(second.latestVerification.sourceSHA256, 'next-source-sha');
  assert.equal(Object.hasOwn(second.latestVerification, 'latestVerification'), false);
  assert.equal(JSON.stringify(second).includes('new-source-sha'), false);
  const { latestVerification, ...recordedRelease } = second;
  assert.deepEqual(recordedRelease, previous);
});

test('jornada legada continua referenciada sem perder recibo original', () => {
  const previous = release();
  delete previous.journeys;
  previous.whatsappTextJourney = { accepted: true, messageSHA256: 'message-sha' };
  const result = mergeVerificationReceipt(previous, proof());
  assert.deepEqual(result.journeys, [{ transport: 'whatsapp_qr', ...previous.whatsappTextJourney }]);
  assert.deepEqual(result.whatsappTextJourney, previous.whatsappTextJourney);
  assert.deepEqual(result.backups, previous.backups);
});

test('sem recibo anterior produz a primeira prova sem inventar imagem ou publicação', () => {
  const verification = proof();
  const result = mergeVerificationReceipt(null, verification);
  assert.deepEqual(result, { ...verification, state: 'PREVIEW', journeys: [] });
  assert.equal(Object.hasOwn(result, 'runtime'), false);
  assert.equal(Object.hasOwn(result, 'sourceRevision'), false);
});

test('recibo anterior inesperado bloqueia substituição das referências', () => {
  for (const previous of [[], 'unexpected', 1, true, undefined]) {
    assert.throws(() => mergeVerificationReceipt(previous, proof()), /Recibo anterior inválido/);
  }
});
