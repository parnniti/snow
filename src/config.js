import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BIN = 'snow';

export function configDir() {
  return process.env.SNOW_CONFIG_DIR || path.join(os.homedir(), '.config', 'snow');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

export function writePrivateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { current_context: null, contexts: {} };
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.contexts ??= {};
  return cfg;
}

export function saveConfig(cfg) {
  writePrivateFile(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** Accepts "acme", "acme.service-now.com" or a full URL; returns "https://host". */
export function normalizeInstance(value) {
  let v = String(value).trim().replace(/\/+$/, '');
  if (!v.includes('.') && !v.includes('://')) v = `${v}.service-now.com`;
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  const u = new URL(v);
  return `${u.protocol}//${u.host}`;
}

/** Context precedence: --context flag > SNOW_CONTEXT env > current_context. */
export function resolveContext(cfg, flag) {
  const name = flag || process.env.SNOW_CONTEXT || cfg.current_context;
  if (!name) {
    throw new Error(
      Object.keys(cfg.contexts).length
        ? `no context selected; run: ${BIN} context use <name>`
        : `no instance configured; run: ${BIN} context add <name> <instance>`,
    );
  }
  const ctx = cfg.contexts[name];
  if (!ctx) {
    const known = Object.keys(cfg.contexts).join(', ') || 'none';
    throw new Error(`unknown context "${name}" (known: ${known})`);
  }
  return { name, instance: normalizeInstance(ctx.instance) };
}
