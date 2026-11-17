import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalPairing } from '../src/terminal-pairing.js';
import { askManifest, askOrigins } from '../ai/build.js';

test('imports stock Terminal QR URLs without keeping credentials in the server address', () => {
  for (const agent of ['claude', 'codex']) {
    const url = new URL('https://terminal.example/');
    url.search = new URLSearchParams({ token: 'secret+with/slash=and&equals', defaultProvider: agent, name: 'My desktop & laptop' });
    assert.deepEqual(terminalPairing(`  ${url}\n`), { endpoint: 'https://terminal.example', token: 'secret+with/slash=and&equals', agent });
  }
  assert.deepEqual(terminalPairing('http://[::1]:3456/terminal/api/?token=test&defaultProvider=codex'), {
    endpoint: 'http://[::1]:3456/terminal', token: 'test', agent: 'codex',
  });
});

test('bare addresses clear old tokens and unspecified agents leave the choice to the UI', () => {
  assert.deepEqual(terminalPairing('https://terminal.example/base/'), { endpoint: 'https://terminal.example/base', token: '', agent: undefined });
  assert.deepEqual(terminalPairing('https://terminal.example?token=new&defaultProvider=unknown&name=ignored'), { endpoint: 'https://terminal.example', token: 'new', agent: undefined });
});

test('invalid or ambiguous QR data cannot be imported and errors never repeat credentials', () => {
  const secret = 'keep-this-secret';
  for (const value of ['', secret, `javascript:${secret}`, `file:///${secret}`, `https://user:${secret}@example.com`,
    `https://example.com?token=${secret}#fragment`, `https://example.com?token=${secret}&token=other`,
    `https://example.com?token=${secret}&defaultProvider=claude&defaultProvider=codex`,
    `https://example.com?token=${secret}%0Aheader`, `https://example.com?token=${secret} with space`,
    `https://example.com?token=${secret}${'x'.repeat(9000)}`]) {
    assert.throws(() => terminalPairing(value), error => !error.message.includes(secret));
  }
});

test('a host-free build drops a previous network whitelist and preserves QR permissions', () => {
  const manifest = askManifest({ permissions: [{ name: 'network', whitelist: ['https://old-terminal.example'] }, { name: 'camera' }, { name: 'album' }] }, askOrigins(''));
  assert.deepEqual(manifest.permissions.map(p => p.name), ['camera', 'album', 'g2-microphone', 'phone-microphone']);
  assert.deepEqual(askManifest(manifest, []).permissions, manifest.permissions, 'repacking must not duplicate microphone permissions');
});
