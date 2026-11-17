// Token persistence. macOS: login keychain via `security`; elsewhere (or SNOW_TOKEN_STORE=file): 0600 file.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, writePrivateFile } from './config.js';

const SERVICE = 'snow-cli';

function useKeychain() {
  const mode = process.env.SNOW_TOKEN_STORE;
  if (mode === 'file') return false;
  if (mode === 'keychain') return true;
  return process.platform === 'darwin';
}

function filePath(ctx) {
  return path.join(configDir(), 'tokens', `${ctx}.json`);
}

export function storeName() {
  return useKeychain() ? `macOS keychain (service "${SERVICE}")` : `file ${path.join(configDir(), 'tokens')}`;
}

export function loadTokens(ctx) {
  if (!useKeychain()) {
    const f = filePath(ctx);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ctx, '-w'], { encoding: 'utf8' });
  if (r.status === 44) return null; // item not found
  if (r.status !== 0) throw new Error(`keychain read failed: ${r.stderr.trim()}`);
  let out = r.stdout.trim();
  // `security -w` prints hex when it considers the data non-printable.
  if (/^([0-9a-f]{2})+$/i.test(out) && !out.startsWith('{')) out = Buffer.from(out, 'hex').toString('utf8');
  return JSON.parse(out);
}

export function saveTokens(ctx, data) {
  const json = JSON.stringify(data);
  if (!useKeychain()) {
    writePrivateFile(filePath(ctx), json + '\n');
    return;
  }
  // Feed the command through `security -i` stdin so the secret never appears in argv / ps.
  const hex = Buffer.from(json, 'utf8').toString('hex');
  const r = spawnSync('security', ['-i'], {
    input: `add-generic-password -U -s ${SERVICE} -a ${ctx} -l "${SERVICE} ${ctx}" -X ${hex}\n`,
    encoding: 'utf8',
  });
  if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`keychain write failed: ${r.stderr.trim()}`);
}

export function deleteTokens(ctx) {
  if (!useKeychain()) {
    fs.rmSync(filePath(ctx), { force: true });
    return;
  }
  const r = spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ctx], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 44) throw new Error(`keychain delete failed: ${r.stderr.trim()}`);
}
