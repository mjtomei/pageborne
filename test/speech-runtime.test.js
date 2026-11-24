import test from 'node:test';
import assert from 'node:assert/strict';
import { speechRuntime, speechRuntimeLabel } from '../src/speech-runtime.js';

const env = { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: false };
test('speech diagnostics distinguish reported processors from actual WASM threads', () => {
  const one = speechRuntime({ state: 'ready', ready: { backend: 'wasm', threads: 1 } }, env);
  assert.equal(one.cpuThreads, 1); assert.equal(one.logicalProcessors, 4);
  assert.equal(one.parallelismLimit, 'shared-memory-unavailable'); assert.equal(one.gpu, false);
  assert.match(speechRuntimeLabel(one), /1 CPU thread · GPU not used/);
  const many = speechRuntime({ state: 'ready', ready: { backend: 'wasm', threads: 4 } }, { ...env, crossOriginIsolated: true, SharedArrayBuffer });
  assert.equal(many.parallelismLimit, null); assert.match(speechRuntimeLabel(many), /4 CPU threads/);
});
test('GPU diagnostics name the accelerated components and retain CPU decoding', () => {
  const runtime = speechRuntime({ state: 'ready', ready: { backend: 'webgpu', threads: 1, adapter: { vendor: 'apple' } } }, env);
  assert.deepEqual(runtime.gpuComponents, ['frontend', 'encoder']);
  assert.deepEqual(runtime.cpuComponents, ['decoder', 'joint']);
  assert.match(speechRuntimeLabel(runtime), /GPU frontend\/encoder \+ 1 CPU thread/);
  assert.equal(runtime.adapter.vendor, 'apple');
});
test('unloaded models do not report stale GPU or thread use; fallback is explicit', () => {
  const idle = speechRuntime({ state: 'idle', ready: { backend: 'webgpu', threads: 1 } }, env);
  assert.equal(idle.gpu, false); assert.equal(idle.cpuThreads, null); assert.equal(idle.resident, false);
  const failed = speechRuntime({ state: 'ready', ready: { backend: 'wasm', threads: 1, accelerationFallback: 'gpu-unavailable', accelerationFailure: { stage: 'preparation' } } }, env);
  assert.match(speechRuntimeLabel(failed), /GPU failed; using CPU fallback/);
  assert.deepEqual(failed.fallbackReason, { stage: 'preparation' });
});
