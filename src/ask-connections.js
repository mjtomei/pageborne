import { endpointUrl, askFetch } from './ask-client.js';
import { createProvider } from '../ai/providers.js';

export const connectionMode = config => config.mode || (config.endpoint ? 'bridge' : 'provider');
export function terminalHeaders(endpoint, accept = 'application/json') {
  const url = new URL(endpoint);
  // ngrok's documented API opt-out of the free-tier HTML interstitial.
  // Scope it to ngrok so unrelated servers need no extra CORS header.
  const ngrok = url.protocol === 'https:' && /\.(ngrok-free\.(app|dev)|ngrok\.(app|dev|io))$/.test(url.hostname);
  return { Accept: accept, ...(ngrok ? { 'ngrok-skip-browser-warning': '1' } : {}) };
}
export function tailscaleHost(hostname) {
  // HTTP is usable over the tailnet's encrypted transport. Still require the
  // exact origin in the installed app's whitelist; this does not detect VPN
  // connectivity or make arbitrary private/LAN HTTP destinations acceptable.
  const octets = hostname.split('.').map(Number);
  return (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 && octets.every(n => n >= 0 && n <= 255))
    || /^\[fd7a:115c:a1e0:[0-9a-f:]+\]$/i.test(hostname)
    || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/i.test(hostname);
}
export function allowedEndpoint(value, { evenHost = false, origins = [] } = {}) {
  const endpoint = endpointUrl(value);
  if (evenHost && !origins.includes(new URL(endpoint).origin)) throw new Error('This address is not enabled in this app build. Add its origin when packaging Pageborne.');
  const hostname = new URL(endpoint).hostname;
  if (evenHost && !endpoint.startsWith('https:') && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !tailscaleHost(hostname)) throw new Error('Use HTTPS or an enabled Tailscale address for the installed app.');
  return endpoint;
}
export function checkWorkingDirectory(value) {
  const cwd = (value || '').trim();
  if (cwd && (cwd.length > 2000 || /[\x00-\x1f]/.test(cwd) || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd))) throw new Error('Use the full absolute path to an existing desktop directory. Leave empty for the Even Terminal default; ~/ is not expanded by its API.');
  return cwd;
}
export function checkConnection(config, options) {
  const mode = connectionMode(config);
  if (mode === 'bridge') return { ...config, mode, endpoint: allowedEndpoint(config.endpoint, options) };
  if (!['provider', 'terminal'].includes(mode)) throw new Error('Choose a connection type.');
  const next = { ...config, mode };
  if (mode === 'provider') {
    next.baseUrl = allowedEndpoint(config.baseUrl, options);
    if (!['openai-compatible', 'anthropic'].includes(config.provider)) throw new Error('Choose an API format.');
    if (!config.model?.trim()) throw new Error('Enter the provider model name.');
    next.model = config.model.trim(); next.apiKey = (config.apiKey || '').trim();
  } else {
    next.endpoint = allowedEndpoint(config.endpoint, options).replace(/\/api$/, '');
    if (!config.token?.trim()) throw new Error('Enter the Even Terminal pairing token.');
    if (!['claude', 'codex'].includes(config.agent)) throw new Error('Choose Claude or Codex.');
    next.token = config.token.trim(); next.cwd = checkWorkingDirectory(config.cwd);
    next.paperDirectories = config.paperDirectories === true;
    next.baseDir = (config.baseDir || '').trim();
    if (next.paperDirectories && next.baseDir && !/^(\/|~\/|[A-Za-z]:[\\/])/.test(next.baseDir)) throw new Error('Use an absolute folder base or ~/ on the desktop.');
  }
  return next;
}
export function paperConnectionKey(config, paperId) {
  if (!paperId) throw new Error('Open a document first.');
  const mode = connectionMode(config);
  return JSON.stringify([paperId, mode, mode === 'provider' ? config.baseUrl || '' : mode === 'terminal' ? config.chatScope || config.endpoint || '' : config.endpoint || '', mode === 'terminal' ? config.agent : config.provider || '', mode === 'provider' ? config.model : '']);
}
async function rejectedTerminalPrompt(response) {
  // These native connector errors are thrown before client.send is called.
  // A generic 409 (or a lost response) does not prove non-delivery. Keep the
  // allowlist exact, bounded, and private: never display arbitrary server text.
  if (response.status !== 409 || !response.headers.get('content-type')?.includes('application/json')) return null;
  const reader = response.body?.getReader(); if (!reader) return null;
  let body = '', bytes = 0; const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 2048) return null;
      body += decoder.decode(value, { stream: true });
    }
    const message = JSON.parse(body + decoder.decode()).error;
    if (message === 'Claude Remote Control is disconnected. Reconnect the normal Claude session before sending.') {
      return 'The desktop Claude session is disconnected. Reconnect it on the desktop, then try again. Your question was not sent.';
    }
    if (['Claude changed or closed this conversation. Select its current Remote Control session again.',
      'This conversation has no active native Remote Control connection. Enable /remote-control in its normal Claude terminal.',
      'The native Claude Remote Control session is no longer active.',
      'The native Claude session is no longer active.'].includes(message)) {
      return 'The desktop Claude session needs to be reconnected. Your question was not sent. Reconnect or select its current session, then try again.';
    }
  } catch { /* Unknown failures retain the delivery guard. */ }
  finally { await reader.cancel().catch(() => {}); }
  return null;
}
export async function connectionRequest(url, { token, headers = {}, body, signal, fetcher = fetch, timeoutMs = 120000, terminalPrompt = false } = {}) {
  const controller = new AbortController(); const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const rejection = terminalPrompt && body !== undefined ? await rejectedTerminalPrompt(response) : null;
      if (rejection) throw Object.assign(new Error(rejection), { status: response.status, submissionRejected: true });
      if (!response.body?.locked) await response.body?.cancel();
      throw Object.assign(new Error(({ 400: 'The session manager rejected the request. Your Claude connector may require an existing desktop session.', 401: 'The access token or API key was rejected.', 403: 'The connection does not permit this request.', 404: 'The endpoint or session was not found.', 429: 'The provider is busy or its usage limit was reached.' })[response.status] || `Request failed (HTTP ${response.status}). Check the provider or desktop session.`), { status: response.status });
    }
    try { return await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw Object.assign(new Error('The endpoint returned a web page or invalid JSON instead of an API response. Check the tunnel and server address.'), { connectionFailure: 'invalid-response' });
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error(signal?.aborted ? 'Question cancelled.' : 'The request timed out. Check the desktop before retrying.'), { connectionFailure: signal?.aborted ? 'cancelled' : 'timeout' });
    if (error instanceof TypeError) throw Object.assign(new Error('Could not connect. Check the address, HTTPS and server CORS settings.'), { connectionFailure: 'network' });
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function providerAnswer(config, input, signal, options = {}) {
  const checked = checkConnection(config, options);
  const controller = new AbortController(); const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 120000); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  try {
    return { answer: await createProvider({ ...checked, browser: true }, options).answer(input, controller.signal) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'Question cancelled.' : 'The provider timed out.');
    if (error instanceof TypeError) throw new Error('Could not reach the provider. Check its address, HTTPS and CORS configuration.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function testConnection(config, options) {
  config = checkConnection(config, options);
  if (config.mode === 'bridge') return askFetch(config, 'status', options);
  if (config.mode === 'terminal') {
    const info = await connectionRequest(`${config.endpoint}/api/info?provider=${config.agent}`, { token: config.token, headers: terminalHeaders(config.endpoint) });
    if (info.error) throw new Error('Even Terminal could not load that provider. Check the desktop.');
    if (config.paperDirectories && info.pageborne?.workspaces !== 1) throw new Error('This server does not offer automatic session folders. Turn that option off to use stock Even Terminal.');
    return { provider: `Even Terminal · ${config.agent}`, ready: true, folders: info.pageborne?.workspaces === 1, voice: !!config.transcription?.model };
  }
  await connectionRequest(`${config.baseUrl}/models`, { token: config.provider === 'anthropic' ? undefined : config.apiKey,
    headers: config.provider === 'anthropic' ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : {} });
  return { provider: config.model, ready: true, voice: !!config.transcription?.model };
}
export function checkTranscription(config, options) {
  if (connectionMode(config) === 'bridge') return;
  if (!config.transcription?.model || !config.transcription?.baseUrl) throw new Error('Add a speech-to-text endpoint in Ask settings, or type your question on the phone.');
  allowedEndpoint(config.transcription.baseUrl, options);
}
export async function transcribeQuestion(config, audio, signal, options) {
  if (connectionMode(config) === 'bridge') return askFetch(config, 'transcribe', { ...options, body: audio, signal });
  checkTranscription(config, options);
  const controller = new AbortController(); const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 120000); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  try { return { text: await createProvider(config).transcribe(audio, controller.signal) }; }
  catch (error) { throw new Error(controller.signal.aborted ? 'Transcription cancelled or timed out.' : error instanceof TypeError ? 'Could not reach the speech endpoint. Check HTTPS and CORS.' : 'Speech transcription failed. Check its model and API key.'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
