import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SNOW_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-test-'));
process.env.SNOW_TOKEN_STORE = 'file';

const { parsePastedCode, pkcePair, startLogin, finishLogin } = await import('../src/auth.js');
const { normalizeInstance, resolveContext } = await import('../src/config.js');
const { parseSets } = await import('../src/args.js');

test('pasted code: bare, with state, full URL, query string', () => {
  assert.deepEqual(parsePastedCode('  abc_DEF-123 \n'), { code: 'abc_DEF-123' });
  assert.deepEqual(parsePastedCode('abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parsePastedCode('https://acme.service-now.com/sdk-oauth.do?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parsePastedCode('code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
});

test('PKCE challenge is base64url(sha256(verifier))', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
});

test('finishLogin rejects a code from another login attempt before any network call', async () => {
  const ctx = { name: 't', instance: 'https://acme.service-now.com' };
  const url = new URL(startLogin(ctx));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(finishLogin(ctx, 'abc&state=not-the-state'), /state mismatch/);
});

test('instance names normalize to https origins', () => {
  assert.equal(normalizeInstance('acme'), 'https://acme.service-now.com');
  assert.equal(normalizeInstance('acme.service-now.com/'), 'https://acme.service-now.com');
  assert.equal(normalizeInstance('https://sn.example.com/nav_to.do?x=1'), 'https://sn.example.com');
});

test('context resolution: flag beats env beats current; empty config explains setup', () => {
  const cfg = { current_context: 'a', contexts: { a: { instance: 'a' }, b: { instance: 'b' } } };
  assert.equal(resolveContext(cfg).name, 'a');
  assert.equal(resolveContext(cfg, 'b').name, 'b');
  assert.throws(() => resolveContext({ current_context: null, contexts: {} }), /context add/);
  assert.throws(() => resolveContext(cfg, 'zzz'), /unknown context/);
});

test('-s key=value splits on the first "=" only', () => {
  assert.deepEqual(parseSets(['q=a=b', 'empty=']), { q: 'a=b', empty: '' });
  assert.throws(() => parseSets(['novalue']), /key=value/);
});

test('tables fit the terminal by shrinking the widest columns, never below the header', async () => {
  const { fitWidths } = await import('../src/output.js');
  const w = fitWidths([13, 60, 60, 16], ['number', 'summary', 'details', 'state'], 80);
  assert.equal(w.reduce((a, b) => a + b, 0) + 2 * 3, 80);
  assert.deepEqual([w[0], w[3]], [13, 16]); // narrow columns untouched
  assert.ok(Math.abs(w[1] - w[2]) <= 1); // the wide ones shrink evenly
  assert.deepEqual(fitWidths([10, 10], ['number', 'state'], 5), [6, 6]); // floor = max(header, 6)
});
