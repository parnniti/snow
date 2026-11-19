// Self-update for global npm installs: compare with the registry's "latest", reinstall, refresh skills.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

/** -1 / 0 / 1 for plain x.y.z versions (pre-release tags compare as older than the release). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function latestVersion() {
  const url = `https://registry.npmjs.org/${PKG.name.replace('/', '%2f')}/latest`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry lookup failed: HTTP ${res.status} for ${PKG.name}`);
  return (await res.json()).version;
}

/**
 * How this copy was installed. "global" = inside `npm root -g` (safe to self-update);
 * anything else (npm link, git checkout, npx cache) gets a hint instead.
 */
export function installKind() {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (r.status !== 0) return { kind: 'unknown', root: PKG_ROOT };
  const globalRoot = fs.realpathSync(r.stdout.trim());
  const here = fs.realpathSync(PKG_ROOT);
  if (here.startsWith(globalRoot + path.sep)) return { kind: 'global', root: here };
  if (fs.existsSync(path.join(here, '.git'))) return { kind: 'git', root: here };
  return { kind: 'other', root: here };
}

export function npmInstallGlobal(version) {
  const r = spawnSync('npm', ['install', '-g', `${PKG.name}@${version}`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`npm install -g ${PKG.name}@${version} failed (exit ${r.status})`);
}
