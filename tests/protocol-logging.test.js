import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveProtocolDiagnostic } from '../src/protocol-logging.js';
test('diagnósticos do protocolo com sessões/chaves são omitidos sem esconder erros normais', () => {
  assert.equal(isSensitiveProtocolDiagnostic(['Closing session:', { currentRatchet: {} }]), true);
  assert.equal(isSensitiveProtocolDiagnostic(['Session already closed', {}]), true);
  assert.equal(isSensitiveProtocolDiagnostic(['outro texto', { privKey: Buffer.from('fixture') }]), true);
  assert.equal(isSensitiveProtocolDiagnostic(['Falha ao abrir conexão']), false);
});
