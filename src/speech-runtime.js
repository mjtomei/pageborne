// Report configured inference parallelism, not sampled CPU utilization. Browsers
// do not expose the number of physical cores executing a model at an instant.
export function speechRuntime(entry, env = globalThis) {
  const resident = entry.state === 'ready' && !!entry.ready && !entry.client?.closed;
  const ready = resident ? entry.ready : null;
  const threads = Number.isSafeInteger(ready?.threads) && ready.threads > 0 ? ready.threads : null;
  const reported = env.navigator?.hardwareConcurrency;
  const logicalProcessors = Number.isSafeInteger(reported) && reported > 0 ? reported : null;
  const sharedMemory = env.crossOriginIsolated === true && typeof env.SharedArrayBuffer === 'function';
  return { resident, backend: ready?.backend || null, cpuThreads: threads, logicalProcessors,
    sharedMemory, gpu: ready?.backend === 'webgpu',
    gpuComponents: ready?.backend === 'webgpu' ? ['frontend', 'encoder'] : [],
    cpuComponents: ready?.backend === 'webgpu' ? ['decoder', 'joint'] : ready?.backend === 'wasm' ? ['frontend', 'encoder', 'decoder', 'joint'] : [],
    parallelismLimit: ready?.backend === 'wasm' && threads === 1 && !sharedMemory ? 'shared-memory-unavailable' : null,
    adapter: ready?.adapter || null, fallback: ready?.accelerationFallback || null,
    fallbackReason: ready?.accelerationFailure || null };
}

export function speechRuntimeLabel(runtime) {
  if (!runtime.resident) return 'Speech model is not loaded yet.';
  const cpu = runtime.cpuThreads ? `${runtime.cpuThreads} CPU thread${runtime.cpuThreads === 1 ? '' : 's'}` : 'CPU thread count unavailable';
  const backend = runtime.gpu ? `GPU frontend/encoder + ${cpu} for decoding` : `${cpu} · GPU not used`;
  const capacity = runtime.logicalProcessors ? ` Device reports ${runtime.logicalProcessors} logical processors.` : '';
  const limit = runtime.parallelismLimit ? ' Parallel CPU inference is unavailable in this app host.' : '';
  const fallback = runtime.fallback ? ' GPU failed; using CPU fallback.' : '';
  return `${backend}.${capacity}${limit}${fallback}`;
}
