import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
function fetch(url, { headers = {} } = {}) { return new Promise((resolve, reject) => { http.get(url, { headers }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }); }); }).on('error', reject); }); }
import { createWebApp } from '../server/web-app.js';
async function listen(t, app) { const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
test('private web bootstrap and API reject other identities and keep the upstream token on the server', async t => {
  const upstreamApp = express(); let authorization;
  upstreamApp.get('/api/info', (req, res) => { authorization = req.get('Authorization'); res.json({ ok: true }); });
  const upstream = await listen(t, upstreamApp);
  const url = await listen(t, createWebApp({ upstream, upstreamToken: 'server-secret', allowedLogin: 'owner', hostname: 'device.test', distDir: '/nonexistent', agent: 'codex' }));
  const headers = { Host: 'device.test', 'Tailscale-User-Login': 'owner' };
  for (const bad of [{}, { ...headers, 'Tailscale-User-Login': 'other' }, { ...headers, Host: 'localhost' }, { ...headers, Origin: 'https://evil.test' }]) {
    assert.equal((await fetch(url + '/web/config', { headers: bad })).status, 403);
  }
  const config = await (await fetch(url + '/web/config', { headers })).json();
  assert.equal(config.endpoint, 'https://device.test'); assert.ok(!JSON.stringify(config).includes('server-secret'));
  assert.equal(config.agent, 'codex');
  assert.equal((await fetch(url + '/api/info', { headers })).status, 401);
  const response = await fetch(url + '/api/info', { headers: { ...headers, Authorization: `Bearer ${config.token}` } });
  assert.deepEqual(await response.json(), { ok: true }); assert.equal(authorization, 'Bearer server-secret');
});

test('local testing accepts loopback hosts and rejects forwarded or remote identities', async t => {
  const url = await listen(t, createWebApp({ upstream: 'http://unused', upstreamToken: 'secret', distDir: '/nonexistent', allowLocal: true }));
  assert.equal((await fetch(url + '/web/config')).status, 200);
  for (const headers of [{ Host: 'remote.example' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-Proto': 'https' }, { 'Tailscale-User-Login': 'owner' }, { Origin: 'http://other.test' }]) {
    assert.equal((await fetch(url + '/web/config', { headers })).status, 403);
  }
});

test('hashed web assets use compressed private caching without caching credentials or weakening access checks', async t => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'pageborne-web-assets-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  await mkdir(path.join(distDir, 'assets'));
  const source = 'export const ready = true;\n'.repeat(100);
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Reader</title>');
  await writeFile(path.join(distDir, 'assets/main-test123.js'), source);
  await writeFile(path.join(distDir, 'assets/main-test123.js.gz'), gzipSync(source));
  const url = await listen(t, createWebApp({ distDir, upstream: 'http://unused', upstreamToken: 'secret', allowedLogin: 'owner', hostname: 'device.test' }));
  const headers = { Host: 'device.test', 'Tailscale-User-Login': 'owner', 'Accept-Encoding': 'gzip' };
  const compressed = await fetch(url + '/assets/main-test123.js', { headers });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers['content-type'], /javascript/);
  assert.equal(gunzipSync(compressed.body).toString(), source);
  assert.ok(compressed.body.length < source.length / 2);
  assert.equal(compressed.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.match(compressed.headers.vary, /Accept-Encoding/);
  const plain = await fetch(url + '/assets/main-test123.js', { headers: { ...headers, 'Accept-Encoding': 'gzip;q=0, identity' } });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), source);
  for (const route of ['/', '/web/config']) {
    const response = await fetch(url + route, { headers });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
  }
  assert.equal((await fetch(url + '/assets/main-test123.js', { headers: { ...headers, 'Tailscale-User-Login': 'other' } })).status, 403);
  assert.equal((await fetch(url + '/assets/missing.js', { headers })).status, 404);
});
