import fs from 'node:fs';

export const GLOBAL_OPTIONS = {
  context: { type: 'string', short: 'c' },
  output: { type: 'string', short: 'o' },
  help: { type: 'boolean', short: 'h' },
};

export function outputMode(opts, fallback) {
  const mode = opts.output || fallback;
  if (!['table', 'json'].includes(mode)) throw new Error(`--output must be table or json, got "${mode}"`);
  return mode;
}

/** -s key=value (repeatable) → object. Splits on the first "=" only. */
export function parseSets(sets = []) {
  const out = {};
  for (const s of sets) {
    const i = s.indexOf('=');
    if (i <= 0) throw new Error(`--set expects key=value, got "${s}"`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** -d '<json>' | -d @file.json | -d - (stdin) → parsed object. */
export function readData(arg) {
  if (arg === undefined) return undefined;
  const text = arg === '-' ? fs.readFileSync(0, 'utf8') : arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`--data is not valid JSON: ${e.message}`);
  }
}

export function splitFields(f) {
  return f ? f.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

/** "-field" → ORDERBYDESCfield, "field" → ORDERBYfield */
export function orderClause(order) {
  if (!order) return undefined;
  return order.startsWith('-') ? `ORDERBYDESC${order.slice(1)}` : `ORDERBY${order}`;
}

export function joinQuery(...parts) {
  return parts.filter(Boolean).join('^') || undefined;
}
