// Agent skills bundled with the package (skills/<name>/SKILL.md) and their installer.
// Canonical destination: ~/.agents/skills/<name> (read by Codex, Cursor, Gemini, Copilot and other
// .agents-compatible harnesses). Claude Code reads ~/.claude/skills, so `--agent claude` adds a symlink
// there pointing at the canonical copy. Installed copies carry a marker file; directories without it are
// someone else's and are never overwritten or removed without --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const MARKER = '.snow-skill.json';
export const AGENTS = ['claude'];

function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  return pkg.version;
}

export function bundledSkills(bundleDir = BUNDLE_DIR) {
  return fs
    .readdirSync(bundleDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(bundleDir, e.name, 'SKILL.md')))
    .map((e) => {
      const md = fs.readFileSync(path.join(bundleDir, e.name, 'SKILL.md'), 'utf8');
      return { name: e.name, dir: path.join(bundleDir, e.name), description: md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return listFiles(p, base);
      return e.name === MARKER ? [] : [path.relative(base, p)];
    })
    .sort();
}

/** Content hash of a skill directory (relative paths + bytes), ignoring the marker. */
export function hashDir(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(dir)) h.update(rel).update('\0').update(fs.readFileSync(path.join(dir, rel))).update('\0');
  return h.digest('hex');
}

/** Destination roots for a scope: canonical .agents/skills plus per-agent link dirs. */
export function destinations({ local = false, dir } = {}) {
  const home = os.homedir();
  const root = dir ? path.resolve(dir) : local ? path.resolve('.agents') : path.join(home, '.agents');
  return {
    canonical: path.join(root, 'skills'),
    agents: { claude: local ? path.resolve('.claude', 'skills') : path.join(home, '.claude', 'skills') },
  };
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** absent | managed | foreign, for a canonical skill directory. */
function inspect(dst) {
  const st = lstat(dst);
  if (!st) return { state: 'absent' };
  if (st.isSymbolicLink() || !st.isDirectory()) return { state: 'foreign' };
  const markerPath = path.join(dst, MARKER);
  if (!fs.existsSync(markerPath)) return { state: 'foreign' };
  return { state: 'managed', marker: JSON.parse(fs.readFileSync(markerPath, 'utf8')) };
}

/** Per-skill install state across destinations, for `snow skills list`. */
export function skillStatus(skill, dests) {
  const dst = path.join(dests.canonical, skill.name);
  const info = inspect(dst);
  let canonical = info.state;
  if (info.state === 'managed') canonical = hashDir(dst) === hashDir(skill.dir) ? 'installed' : 'outdated';
  const agents = {};
  for (const [agent, linkDir] of Object.entries(dests.agents)) {
    const link = path.join(linkDir, skill.name);
    const st = lstat(link);
    agents[agent] = !st ? 'absent' : st.isSymbolicLink() && path.resolve(linkDir, fs.readlinkSync(link)) === dst ? 'linked' : 'foreign';
  }
  return { canonical, agents };
}

/**
 * Install skills. Returns [{ skill, path, action }]; action is one of
 * installed | updated | unchanged | linked | link-ok | skipped-foreign (would-* in dry run).
 */
export function installSkills(skills, { dests, agents = [], force = false, dryRun = false }) {
  const results = [];
  const WOULD = { installed: 'would-install', updated: 'would-update', linked: 'would-link' };
  const record = (skill, p, action) => results.push({ skill, path: p, action: (dryRun && WOULD[action]) || action });
  const version = packageVersion();
  for (const skill of skills) {
    const dst = path.join(dests.canonical, skill.name);
    const info = inspect(dst);
    const srcHash = hashDir(skill.dir);
    if (info.state === 'foreign' && !force) {
      record(skill.name, dst, 'skipped-foreign');
      continue;
    }
    if (info.state === 'managed' && hashDir(dst) === srcHash) {
      record(skill.name, dst, 'unchanged');
    } else {
      if (!dryRun) {
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(skill.dir, dst, { recursive: true });
        fs.writeFileSync(
          path.join(dst, MARKER),
          JSON.stringify({ name: skill.name, package: 'snow-ctl', version, hash: srcHash, installedAt: new Date().toISOString() }, null, 2) + '\n',
        );
      }
      record(skill.name, dst, info.state === 'absent' ? 'installed' : 'updated');
    }
    for (const agent of agents) {
      const linkDir = dests.agents[agent];
      const link = path.join(linkDir, skill.name);
      const st = lstat(link);
      if (st?.isSymbolicLink() && path.resolve(linkDir, fs.readlinkSync(link)) === dst) {
        record(skill.name, link, 'link-ok');
        continue;
      }
      if (st && !force) {
        record(skill.name, link, 'skipped-foreign');
        continue;
      }
      if (!dryRun) {
        fs.rmSync(link, { recursive: true, force: true });
        fs.mkdirSync(linkDir, { recursive: true });
        fs.symlinkSync(dst, link, 'dir');
      }
      record(skill.name, link, 'linked');
    }
  }
  return results;
}

/** Remove snow-managed copies and the agent links that point at them. Foreign entries are left alone. */
export function uninstallSkills(skills, { dests, dryRun = false }) {
  const results = [];
  for (const skill of skills) {
    const dst = path.join(dests.canonical, skill.name);
    for (const linkDir of Object.values(dests.agents)) {
      const link = path.join(linkDir, skill.name);
      const st = lstat(link);
      if (st?.isSymbolicLink() && path.resolve(linkDir, fs.readlinkSync(link)) === dst) {
        if (!dryRun) fs.unlinkSync(link);
        results.push({ skill: skill.name, path: link, action: dryRun ? 'would-unlink' : 'unlinked' });
      }
    }
    const info = inspect(dst);
    if (info.state === 'managed') {
      if (!dryRun) fs.rmSync(dst, { recursive: true, force: true });
      results.push({ skill: skill.name, path: dst, action: dryRun ? 'would-remove' : 'removed' });
    } else if (info.state === 'foreign') {
      results.push({ skill: skill.name, path: dst, action: 'skipped-foreign' });
    }
  }
  return results;
}
