import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { SRC, source } from './paths.mjs';

const processing = readFileSync(source('./processing/js/main.js'), 'utf8');
const raphael = readFileSync(source('./raphael/js/main.js'), 'utf8');
const idle = readFileSync(source('./idle/js/animate.js'), 'utf8');
const explorer = readFileSync(source('./explorer/js/animate.js'), 'utf8');
function metrics(source, clock = () => 0, logger) {
  const lines = [], events = {};
  const sandbox = { performance: { now: clock }, console: { info: logger || (s => lines.push(s)) },
    window: { addEventListener: (name, fn) => { events[name] = fn; } } };
  vm.createContext(sandbox);
  const helper = source.slice(source.indexOf('function createCadence'), source.indexOf('\nconst cadence') > 0
    ? source.indexOf('\nconst cadence') : source.indexOf('\nvar cadence'));
  vm.runInContext(helper + '\nvar observed = createCadence("probe");', sandbox);
  return { api: sandbox.observed, lines, events };
}
for (const [name, source] of [['processing', processing], ['raphael', raphael], ['idle', idle], ['explorer', explorer]]) {
  test(`${name}: fixed histograms, independent work clock and completed intervals`, () => {
    let clock = 100;
    const { api, lines } = metrics(source, () => clock);
    api.entry(200); // Startup baseline, not performance.now().
    let timestamp = 200;
    for (const gap of [8, 17, 34, 50, 100, 250, 251]) {
      api.complete(timestamp);
      timestamp += gap;
      const start = api.begin(); clock += gap; api.end(start);
    }
    api.complete(timestamp); api.entry(10200); api.end(NaN);
    assert.match(lines[0], /elapsed_ms=10000 raf=2 eligible=7 draw=8 err=0 dt=\[1,1,1,1,1,1,1\] work=\[1,1,1,1,1,1,1\] work_n=7 maxgap_ms=251$/);
    assert.ok(Buffer.byteLength(lines[0]) < 512);
  });
  test(`${name}: invalid clocks, hitches, cap and final deduplication`, () => {
    const { api, lines, events } = metrics(source, () => NaN);
    api.entry(0); api.complete(0);
    for (let i = 1; i <= 20; i++) {
      api.entry(i * 100000); api.error(); api.end(api.begin());
    }
    api.entry(Infinity); api.complete(NaN); api.end(NaN);
    events.pagehide(); events.beforeunload(); api.entry(3000000); api.end(NaN);
    assert.equal(lines.length, 13);
    assert.match(lines.at(-1), /kind=final .*draw=2 err=20 .*work_n=0/);
    assert.ok(lines.every(line => Buffer.byteLength(line) < 512 && !/NaN|Infinity/.test(line)));
    const huge = metrics(source); huge.api.entry(0); huge.api.entry(1e308);
    for (let i = 0; i < 30; i++) huge.api.end(NaN);
    assert.equal(huge.lines.length, 1);
    const broken = metrics(source, () => { throw Error('clock'); }, () => { throw Error('log'); });
    broken.api.entry(0); broken.api.entry(10000);
    assert.doesNotThrow(() => broken.api.end(broken.api.begin()));
    assert.doesNotThrow(() => broken.api.finish());
    assert.doesNotMatch(source, /(?:dt|work)\.push/);
  });
}
test('processing: transparent RAF native and callback receivers, arguments, IDs and exceptions', () => {
  let captured, receiver, args;
  const window = { requestAnimationFrame: function (...values) {
    receiver = this; args = values; captured = values[0]; return 73;
  }, addEventListener() {} };
  const sandbox = { window, createRenderStageReporter: () => () => {}, console: {},
    initializeNebulaRenderer() {}, scheduleFrame() {} };
  vm.createContext(sandbox); vm.runInContext(processing, sandbox);
  const nativeReceiver = {}, callbackReceiver = {}, token = {};
  let actualReceiver, actualArgs;
  const callback = function (...values) { actualReceiver = this; actualArgs = values; return token; };
  callback.apply = () => { throw Error('shadowed apply'); };
  assert.equal(window.requestAnimationFrame.call(nativeReceiver, callback, token), 73);
  assert.equal(receiver, nativeReceiver); assert.equal(args[1], token);
  assert.equal(captured.call(callbackReceiver, 12, token), token);
  assert.equal(actualReceiver, callbackReceiver); assert.deepEqual(actualArgs, [12, token]);
  const error = Error('callback');
  window.requestAnimationFrame(() => { throw error; });
  assert.throws(() => captured(13), e => e === error);
  assert.equal(window.requestAnimationFrame.call(nativeReceiver, null, token), 73);
  assert.equal(args[0], null); assert.equal(args[1], token);
  const nativeError = Error('native');
  sandbox.nativeRequestAnimationFrame = () => { throw nativeError; };
  assert.throws(() => window.requestAnimationFrame(callback), e => e === nativeError);
});
