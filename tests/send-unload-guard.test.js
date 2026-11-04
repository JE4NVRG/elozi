import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installPendingSendUnloadGuard } from '../public/send-unload-guard.js';
import { excerpt } from './helpers/app-source.js';

function browserEvent() {
  const event = new Event('beforeunload', { cancelable: true });
  // Browser BeforeUnloadEvent has a writable legacy returnValue, unlike Node Event.
  Object.defineProperty(event, 'returnValue', { value: null, writable: true });
  return event;
}
function fire(target) { const event = browserEvent(); target.dispatchEvent(event); return event; }

test('ordinary saved draft does not trigger a native exit warning', () => {
  const target = new EventTarget(), remove = installPendingSendUnloadGuard({ target });
  const event = fire(target);
  assert.equal(event.defaultPrevented, false); assert.equal(event.returnValue, null); remove();
});
test('pending command asks the browser to warn without performing network or retry', () => {
  const target = new EventTarget(), remove = installPendingSendUnloadGuard({ target, pending: () => true });
  const event = fire(target);
  assert.equal(event.defaultPrevented, true); assert.equal(event.returnValue, ''); remove();
});
test('guard reads current pending state, not a captured initial value', () => {
  const target = new EventTarget(); let pending = false;
  const remove = installPendingSendUnloadGuard({ target, pending: () => pending });
  assert.equal(fire(target).defaultPrevented, false);
  pending = true; assert.equal(fire(target).defaultPrevented, true);
  pending = false; assert.equal(fire(target).defaultPrevented, false); remove();
});
test('cleanup removes only the owned handler and is idempotent', () => {
  const target = new EventTarget(); let other = 0;
  target.addEventListener('beforeunload', () => other++);
  const remove = installPendingSendUnloadGuard({ target, pending: () => true });
  remove(); remove(); assert.equal(fire(target).defaultPrevented, false); assert.equal(other, 1);
});
test('non-browser import can install and dispose without globals or storage', () => {
  assert.doesNotThrow(() => installPendingSendUnloadGuard({ target: {} })());
});
test('real app hook guards upload and lost-response intent, but not ordinary refresh busy', () => {
  const target = new EventTarget(), state = { sendIntent: null, busy: true }, mediaUI = { sending: false }, noteDrafts = {count:0,persistent:true};
  let dispose;
  vm.runInNewContext(excerpt('pending-send-unload'), { state, mediaUI, noteDrafts,
    installPendingSendUnloadGuard: options => { dispose = installPendingSendUnloadGuard({ ...options, target }); } });
  assert.equal(fire(target).defaultPrevented, false);
  mediaUI.sending = true; assert.equal(fire(target).defaultPrevented, true);
  mediaUI.sending = false; state.sendIntent = Object.freeze({ idempotencyKey: 'synthetic-command-0001', version: 3 });
  const same = state.sendIntent;
  assert.equal(fire(target).defaultPrevented, true); assert.equal(state.sendIntent, same);
  state.sendIntent = null; assert.equal(fire(target).defaultPrevented, false);
  noteDrafts.count=1;noteDrafts.persistent=false;assert.equal(fire(target).defaultPrevented,true);
  noteDrafts.persistent=true;assert.equal(fire(target).defaultPrevented,false);dispose();
});
