import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceRecorder } from '../public/voice-recorder.js';
import { getLocale, setLocale } from '../public/i18n.js';

function setup(t, options = {}) {
  const descriptors = new Map(['navigator', 'MediaRecorder'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const files = [], states = [], errors = [], instances = [], streams = [], requests = [], constructors = [];
  const stream = () => {
    const tracks = [{ stops: 0, stop() { this.stops++; } }, { stops: 0, stop() { this.stops++; } }];
    const value = { tracks, getTracks: () => tracks }; streams.push(value); return value;
  };
  class Recorder {
    static isTypeSupported(mime) { return (options.supportedMimes || ['audio/webm;codecs=opus']).includes(mime); }
    constructor(input, config) {
      constructors.push({ input, config });
      if (options.rejectMime && config?.mimeType) throw new Error('Unsupported MIME');
      if (options.constructorError) throw options.constructorError;
      this.stream = input; this.mimeType = options.outputMime ?? config?.mimeType ?? 'audio/webm';
      this.state = 'inactive'; this.stops = 0; instances.push(this);
    }
    start(timeslice) {
      if (options.startError) throw options.startError;
      this.timeslice = timeslice; this.state = 'recording';
    }
    stop() {
      this.stops++; this.state = 'inactive';
      if (options.stopError) throw options.stopError;
    }
    data(data) { this.ondataavailable?.({ data }); }
    complete() { this.onstop?.(); }
    error(error) { this.onerror?.({ error }); }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: options.unsupported ? {} : { mediaDevices: { getUserMedia: constraints => { requests.push(constraints); return options.permission ? options.permission(stream) : Promise.resolve(stream()); } } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: options.unsupported ? undefined : Recorder });
  const ui = createVoiceRecorder({ onFile: file => { files.push(file); return options.onFile?.(file); }, onState: value => { states.push(value); options.onState?.(value); }, onError: message => errors.push(message) });
  t.after(() => {
    ui.reset();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { ui, files, states, errors, instances, streams, requests, constructors, stream, recorder: () => instances.at(-1) };
}

test('voice recorder requests the microphone only through an explicit start action', async t => {
  const { ui, requests, recorder, states } = setup(t);
  assert.equal(ui.state, 'idle'); assert.equal(ui.busy, false); assert.equal(ui.supported, true);
  assert.match(ui.markup(), /data-voice-action="start"/);
  ui.syncContext('company:conversation'); ui.syncContext('company:conversation');
  ui.handleAction('unknown'); ui.reset();
  assert.equal(requests.length, 0);
  const pending = ui.handleAction('start');
  assert.equal(ui.state, 'requesting'); assert.equal(ui.busy, true);
  assert.match(ui.markup(), /Aguardando permissão/);
  await ui.handleAction('start');
  await pending;
  assert.deepEqual(requests, [{ audio: true }]);
  assert.equal(recorder().timeslice, 1000); assert.equal(ui.state, 'recording');
  assert.deepEqual(states.at(-1), { state: 'recording', elapsedSeconds: 0, maxSeconds: 300 });
  assert.match(ui.markup(), /00:00 \/ 05:00/);
});

test('compact idle microphone keeps its PT/EN action name and does not request permission', t => {
  const { ui, requests } = setup(t), previous = getLocale();
  t.after(() => setLocale(previous));
  for (const [locale, label] of [['pt-BR', 'Gravar áudio'], ['en', 'Record audio']]) {
    setLocale(locale);
    const markup = ui.markup();
    assert.match(markup, new RegExp(`aria-label="${label}" title="${label}"`));
    assert.match(markup, new RegExp(`<span class="pg-inbox__tool-label">${label}</span>`));
    assert.match(markup, /<rect x="9" y="2" width="6" height="12" rx="3"\/>/);
    assert.match(markup, /aria-describedby="voice-recorder-status"/);
    assert.match(ui.markup(true), /data-voice-action="start" disabled/);
  }
  assert.equal(ui.state, 'idle');
  assert.equal(requests.length, 0);
});

test('voice stop releases every track and returns one audio File for review', async t => {
  const { ui, recorder, streams, files, constructors } = setup(t);
  await ui.handleAction('start');
  assert.equal(constructors[0].config.mimeType, 'audio/webm;codecs=opus');
  recorder().data(new Blob(['first'], { type: recorder().mimeType }));
  ui.handleAction('stop');
  assert.equal(ui.state, 'stopping'); assert.equal(ui.busy, true);
  assert.match(ui.markup(), /Preparando áudio para revisão/);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  recorder().data(new Blob(['second'], { type: recorder().mimeType }));
  recorder().complete(); recorder().complete();
  assert.equal(ui.state, 'idle'); assert.equal(ui.busy, false);
  assert.equal(files.length, 1); assert.ok(files[0] instanceof File);
  assert.match(files[0].name, /^Áudio-.*\.webm$/);
  assert.equal(files[0].type, 'audio/webm;codecs=opus');
  assert.equal(await files[0].text(), 'firstsecond');
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
});

test('denied microphone permission returns to idle without exposing browser error content', async t => {
  const { ui, errors, files } = setup(t, { permission: () => Promise.reject(Object.assign(new Error('<private details>'), { name: 'NotAllowedError' })) });
  await ui.handleAction('start');
  assert.equal(ui.state, 'idle'); assert.equal(ui.busy, false); assert.equal(files.length, 0);
  assert.match(errors[0], /acesso ao microfone foi negado/);
  assert.ok(!ui.markup().includes('private details'));
  assert.match(ui.markup(), /role="alert"/);
});

test('cancelled permission resolves later only to release its tracks', async t => {
  let resolvePermission;
  const { ui, stream, instances, files, errors } = setup(t, { permission: () => new Promise(resolve => { resolvePermission = resolve; }) });
  const pending = ui.handleAction('start');
  ui.handleAction('cancel'); assert.equal(ui.state, 'idle');
  const lateStream = stream(); resolvePermission(lateStream); await pending;
  assert.deepEqual(lateStream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(instances.length, 0); assert.equal(files.length, 0); assert.equal(errors.length, 0);
});

test('late permission denial from a cancelled request leaves the new recording intact', async t => {
  let rejectFirst, calls = 0;
  const { ui, recorder, errors } = setup(t, { permission: stream => ++calls === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(stream()) });
  const first = ui.handleAction('start'); ui.handleAction('cancel');
  await ui.handleAction('start');
  rejectFirst(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await first;
  assert.equal(ui.state, 'recording'); assert.equal(recorder().state, 'recording'); assert.equal(errors.length, 0);
});

test('late permission success cannot attach its stream to a newer recording', async t => {
  let resolveFirst, calls = 0;
  const { ui, stream, streams, recorder, instances } = setup(t, { permission: createStream => ++calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(createStream()) });
  const first = ui.handleAction('start'); ui.handleAction('cancel'); await ui.handleAction('start');
  const current = recorder(), oldStream = stream(); resolveFirst(oldStream); await first;
  assert.equal(instances.length, 1); assert.equal(recorder(), current); assert.equal(ui.state, 'recording');
  assert.deepEqual(oldStream.tracks.map(track => track.stops), [1, 1]);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [0, 0]);
});

test('changing conversation discards recording and stale stop callbacks', async t => {
  const { ui, recorder, streams, files } = setup(t);
  ui.syncContext('company:one'); await ui.handleAction('start');
  recorder().data(new Blob(['private draft']));
  const lateStop = recorder().onstop, lateData = recorder().ondataavailable;
  ui.syncContext('company:one'); assert.equal(ui.state, 'recording');
  ui.syncContext('company:two'); lateData({ data: new Blob(['late data']) }); lateStop();
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 0); assert.equal(recorder().stops, 1);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  assert.equal(recorder().onstop, null); assert.equal(recorder().ondataavailable, null);
});

test('context change while waiting for permission releases the late stream', async t => {
  let resolvePermission;
  const { ui, stream, instances } = setup(t, { permission: () => new Promise(resolve => { resolvePermission = resolve; }) });
  ui.syncContext('one'); const pending = ui.handleAction('start'); ui.syncContext('two');
  const value = stream(); resolvePermission(value); await pending;
  assert.equal(instances.length, 0); assert.equal(ui.state, 'idle');
  assert.deepEqual(value.tracks.map(track => track.stops), [1, 1]);
});

test('a state render that changes context before the permission request cancels start', async t => {
  let ui;
  const fixture = setup(t, { onState: snapshot => { if (snapshot.state === 'requesting') ui.syncContext('changed'); } });
  ui = fixture.ui; ui.syncContext('original'); await ui.handleAction('start');
  assert.equal(ui.state, 'idle'); assert.equal(fixture.requests.length, 0);
});

test('a state render that changes context after completion suppresses the old file', async t => {
  let ui, changeOnIdle = false;
  const fixture = setup(t, { onState: snapshot => {
    if (snapshot.state === 'idle' && changeOnIdle) { changeOnIdle = false; ui.syncContext('changed'); }
  } });
  ui = fixture.ui; ui.syncContext('original'); await ui.handleAction('start');
  fixture.recorder().data(new Blob(['previous conversation'])); ui.handleAction('stop');
  changeOnIdle = true; fixture.recorder().complete();
  assert.equal(ui.state, 'idle'); assert.equal(fixture.files.length, 0);
});

test('a state render that cancels stopping leaves no timeout or repeated stop', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  let ui;
  const fixture = setup(t, { onState: snapshot => { if (snapshot.state === 'stopping') ui.reset(); } });
  ui = fixture.ui; await ui.handleAction('start'); fixture.recorder().data(new Blob(['draft']));
  ui.handleAction('stop'); t.mock.timers.tick(400000);
  assert.equal(ui.state, 'idle'); assert.equal(fixture.recorder().stops, 1);
  assert.equal(fixture.errors.length, 0); assert.equal(fixture.files.length, 0);
});

test('discard during stop suppresses the completed file', async t => {
  const { ui, recorder, files, streams } = setup(t);
  await ui.handleAction('start'); recorder().data(new Blob(['draft'])); ui.handleAction('stop');
  const lateStop = recorder().onstop; ui.handleAction('discard'); lateStop();
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 0);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
});

test('five-minute timer stops recording and cleans timers before delivery', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const { ui, recorder, files, streams, states } = setup(t);
  await ui.handleAction('start'); recorder().data(new Blob(['five minute recording']));
  t.mock.timers.tick(1000);
  assert.equal(states.at(-1).elapsedSeconds, 1); assert.match(ui.markup(), /00:01/);
  t.mock.timers.tick(299000);
  assert.equal(ui.state, 'stopping'); assert.equal(recorder().stops, 1);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  recorder().complete(); const stateCount = states.length;
  t.mock.timers.tick(600000);
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 1); assert.equal(states.length, stateCount);
});

test('discard cleans recording timers without auto-stopping a later session', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const { ui, recorder, files } = setup(t);
  await ui.handleAction('start'); t.mock.timers.tick(100000); ui.reset();
  await ui.handleAction('start'); const current = recorder(); t.mock.timers.tick(200000);
  assert.equal(ui.state, 'recording'); assert.equal(current.stops, 0); assert.equal(files.length, 0);
});

test('recordings over 16 MiB are discarded immediately with all tracks closed', async t => {
  const { ui, recorder, streams, files, errors } = setup(t);
  await ui.handleAction('start');
  recorder().data({ size: 16 * 1024 * 1024 + 1, type: 'audio/webm' }); recorder().complete();
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 0); assert.match(errors[0], /limite de 16 MB/);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
});

test('the final recorder chunk is also subject to the total byte limit', async t => {
  const { ui, recorder, files, errors } = setup(t);
  await ui.handleAction('start'); recorder().data({ size: 16 * 1024 * 1024, type: 'audio/webm' });
  ui.handleAction('stop'); recorder().data(new Blob(['extra'])); recorder().complete();
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 0); assert.match(errors[0], /limite de 16 MB/);
});

test('empty recordings show a useful error instead of creating an attachment', async t => {
  const { ui, recorder, files, errors } = setup(t);
  await ui.handleAction('start'); recorder().data(new Blob([])); ui.handleAction('stop'); recorder().complete();
  assert.equal(files.length, 0); assert.equal(ui.state, 'idle'); assert.match(errors[0], /gravação ficou vazia/);
});

test('supported MIME preference chooses Ogg before MP4', async t => {
  const { ui, recorder, constructors, files } = setup(t, { supportedMimes: ['audio/ogg;codecs=opus', 'audio/mp4'] });
  await ui.handleAction('start'); assert.equal(constructors[0].config.mimeType, 'audio/ogg;codecs=opus');
  recorder().data(new Blob(['ogg'])); ui.handleAction('stop'); recorder().complete();
  assert.equal(files[0].type, 'audio/ogg;codecs=opus'); assert.match(files[0].name, /\.ogg$/);
});

test('MP4 browsers create an m4a file with the recorder actual MIME', async t => {
  const { ui, recorder, files } = setup(t, { supportedMimes: ['audio/mp4'], outputMime: 'audio/mp4;codecs=mp4a.40.2' });
  await ui.handleAction('start'); recorder().data(new Blob(['aac'])); ui.handleAction('stop'); recorder().complete();
  assert.equal(files[0].type, 'audio/mp4;codecs=mp4a.40.2'); assert.match(files[0].name, /\.m4a$/);
});

test('a rejected preferred MIME falls back to the browser default constructor', async t => {
  const { ui, recorder, constructors, requests } = setup(t, { rejectMime: true, outputMime: 'audio/mp4' });
  await ui.handleAction('start');
  assert.equal(constructors.length, 2); assert.equal(constructors[1].config, undefined);
  assert.equal(requests.length, 1); assert.equal(recorder().mimeType, 'audio/mp4'); assert.equal(ui.state, 'recording');
});

test('unknown preferred MIME support uses the default recorder without options', async t => {
  const { ui, constructors } = setup(t, { supportedMimes: [] });
  await ui.handleAction('start'); assert.equal(constructors[0].config, undefined); assert.equal(ui.state, 'recording');
});

test('recorder start and runtime errors always release the microphone', async t => {
  await t.test('start failure', async t => {
    const { ui, streams, errors } = setup(t, { startError: new Error('failed') });
    await ui.handleAction('start'); assert.equal(ui.state, 'idle'); assert.equal(errors.length, 1);
    assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  });
  await t.test('runtime error', async t => {
    const { ui, recorder, streams, errors, files } = setup(t);
    await ui.handleAction('start'); recorder().error(new Error('failed')); recorder().complete();
    assert.equal(ui.state, 'idle'); assert.equal(errors.length, 1); assert.equal(files.length, 0);
    assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  });
});

test('missing stop events time out after releasing the microphone', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  const { ui, recorder, streams, errors, files } = setup(t);
  await ui.handleAction('start'); recorder().data(new Blob(['draft'])); ui.handleAction('stop');
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
  t.mock.timers.tick(10000);
  assert.equal(ui.state, 'idle'); assert.equal(files.length, 0); assert.match(errors[0], /não concluiu a gravação/);
});

test('a throwing stop still cleans tracks and does not create a file', async t => {
  const { ui, streams, errors, files } = setup(t, { stopError: new Error('stop failed') });
  await ui.handleAction('start'); ui.handleAction('stop');
  assert.equal(ui.state, 'idle'); assert.equal(errors.length, 1); assert.equal(files.length, 0);
  assert.deepEqual(streams[0].tracks.map(track => track.stops), [1, 1]);
});

test('unsupported browser displays an alternative and never calls microphone APIs', async t => {
  const { ui, requests, errors } = setup(t, { unsupported: true });
  assert.equal(ui.supported, false); assert.match(ui.markup(), /data-voice-action="start" disabled/);
  assert.match(ui.markup(), /Anexe um arquivo de áudio/);
  await ui.handleAction('start'); assert.equal(requests.length, 0); assert.equal(ui.state, 'idle'); assert.equal(errors.length, 1);
});
