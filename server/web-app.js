import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function createWebApp({ distDir, upstream, upstreamToken, allowedLogin, hostname, allowLocal = false, agent = 'claude' }) {
  const app = express(); app.disable('x-powered-by');
  const webToken = randomBytes(32).toString('hex');
  const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const isLocal = req => allowLocal && !req.get('Tailscale-User-Login') && !req.get('X-Forwarded-For')
    && !req.get('X-Forwarded-Proto') && ['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname);
  app.use((req, res, next) => {
    const local = isLocal(req);
    // This listener binds only to loopback. Serve removes client-supplied identity
    // headers and supplies the authenticated tailnet user's identity.
    if (!local && (req.hostname !== hostname || !allowedLogin || req.get('Tailscale-User-Login') !== allowedLogin)) return res.status(403).send('Open this reader through your own Tailscale account.');
    if (req.get('Origin') && req.get('Origin') !== `${local ? req.protocol : 'https'}://${req.get('host')}`) return res.sendStatus(403);
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'Permissions-Policy': 'microphone=(self), camera=(self)', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    next();
  });
  app.get('/web/config', (req, res) => {
    const local = isLocal(req);
    res.json({ mode: 'terminal', endpoint: `${local ? req.protocol : 'https'}://${req.get('host')}`, token: webToken, agent });
  });
  app.use('/api', (req, res) => {
    if (!equal(req.get('Authorization'), `Bearer ${webToken}`)) return res.sendStatus(401);
    const url = new URL(req.originalUrl, upstream);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: req.method, headers: { Authorization: `Bearer ${upstreamToken}`,
        ...(req.get('content-type') ? { 'Content-Type': req.get('content-type') } : {}),
        Accept: req.get('accept') || 'application/json' },
    }, response => {
      res.status(response.statusCode);
      for (const name of ['content-type', 'cache-control']) if (response.headers[name]) res.setHeader(name, response.headers[name]);
      response.pipe(res);
    });
    request.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'The desktop connection is unavailable.' }); else res.end(); });
    res.on('close', () => request.destroy());
    req.pipe(request);
  });
  // Hash-named code contains no credentials. Keep successful downloads across
  // reloads and send the precompressed build over slower mobile connections.
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !/^\/assets\/[\w.-]+\.(js|css)$/.test(req.path)) return next();
    res.vary('Accept-Encoding');
    if (!req.get('Accept-Encoding') || !req.acceptsEncodings('gzip')) return next();
    const file = `${req.path.slice(1)}.gz`;
    if (!existsSync(path.join(distDir, file))) return next();
    res.type(path.extname(req.path));
    res.set({ 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.sendFile(file, { root: path.resolve(distDir), cacheControl: false });
  });
  app.use(express.static(distDir, { dotfiles: 'deny', etag: true, cacheControl: false,
    setHeaders(res, file) {
      if (file.startsWith(path.join(path.resolve(distDir), 'assets') + path.sep)) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    },
  }));
  app.use((_req, res) => res.sendStatus(404));
  return app;
}
