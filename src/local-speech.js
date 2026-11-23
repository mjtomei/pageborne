// Speech engine is maintained in the standalone browser-stt project.
export * from '@pageborne/browser-stt/local-speech';

// Stored provider preference; local execution selects CPU SIMD or WebGPU.
export const speechBackend = value => value === 'remote' ? 'remote' : 'wasm';
export const speechLabel = value => value === 'webgpu' ? 'WebGPU' : value === 'remote' ? 'Speech provider' : 'WebAssembly SIMD';
