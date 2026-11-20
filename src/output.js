import { bold, dim, lineWidth, wrap } from './style.js';

const MAX_COL = 60;

export function fmtValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'display_value' in v) return fmtValue(v.display_value);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function printJSON(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

const SOFT_FLOOR = 16;
const KEEP_FLOOR = 30;

/**
 * Shrink columns until the table fits `max` characters (2-space gaps).
 * `fixed` columns (record numbers) never shrink: a cut-off identifier is useless.
 * `keep` columns (what the record is about) give up width late:
 *   1. other columns shrink, widest first, down to 16 (or their header);
 *   2. kept columns shrink down to 30;
 *   3. other columns shrink down to their header (min 6);
 *   4. kept columns shrink down to their header.
 */
export function fitWidths(widths, headers, max, keep = [], fixed = []) {
  const w = [...widths];
  const hard = headers.map((h) => Math.max(h.length, 6));
  const kind = headers.map((h) => (fixed.includes(h) ? 'fixed' : keep.includes(h) ? 'keep' : 'other'));
  const total = () => w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1);
  const phases = [
    (j) => kind[j] === 'other' && Math.max(hard[j], SOFT_FLOOR),
    (j) => kind[j] === 'keep' && Math.max(hard[j], KEEP_FLOOR),
    (j) => kind[j] === 'other' && hard[j],
    (j) => kind[j] === 'keep' && hard[j],
  ];
  for (const floorOf of phases) {
    while (total() > max) {
      let i = -1;
      for (let j = 0; j < w.length; j++) {
        const f = floorOf(j);
        if (f !== false && w[j] > f && (i < 0 || w[j] > w[i])) i = j;
      }
      if (i < 0) break; // this phase has nothing left to give
      w[i]--;
    }
  }
  return w; // still too wide: every column is at its floor, let the terminal wrap
}

// Defaults for every table: the column that says what a row is about stays wide; identifiers never shrink.
const DEFAULT_KEEP = ['summary', 'short_description', 'what', 'name'];
const DEFAULT_FIXED = ['number', 'request_item', 'request', 'for', 'sys_id'];

/**
 * `keep`: columns to keep wide when the table must shrink to the terminal; `fixed`: never shrink
 * (see fitWidths). Both default to the well-known column names above.
 */
export function printTable(rows, cols, { keep = DEFAULT_KEEP, fixed = DEFAULT_FIXED } = {}) {
  if (!rows.length) {
    process.stderr.write('(no records)\n');
    return;
  }
  cols = cols?.length ? cols : Object.keys(rows[0]);
  // Kept columns may run longer than the usual cap, since they hold the text people scan for.
  let cells = rows.map((r) => cols.map((c) => clip(oneLine(fmtValue(r[c])), keep.includes(c) ? 100 : MAX_COL)));
  let widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  if (process.stdout.isTTY && process.stdout.columns) {
    widths = fitWidths(widths, cols, process.stdout.columns, keep, fixed);
    cells = cells.map((row) => row.map((v, i) => clip(v, widths[i])));
  }
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)];
  process.stdout.write(out.join('\n') + '\n');
}

/**
 * One block per record: the short fields on a header line, then each long field labelled and in full
 * (multi-line kept), indented. Empty long fields are skipped.
 */
export function printBlocks(rows, cols, longFields) {
  if (!rows.length) {
    process.stderr.write('(no records)\n');
    return;
  }
  const head = cols.filter((c) => !longFields.includes(c));
  const body = cols.filter((c) => longFields.includes(c));
  const width = Math.max(...body.map((c) => c.length), 0);
  const out = rows.map((r) => {
    const lines = [head.map((c) => oneLine(fmtValue(r[c]))).filter(Boolean).join('  ·  ')];
    for (const c of body) {
      const v = fmtValue(r[c]).replace(/\r\n?/g, '\n').trim();
      if (!v) continue;
      const [first, ...rest] = v.split('\n');
      lines.push(`  ${c.padEnd(width)}  ${first}`, ...rest.map((l) => `  ${' '.repeat(width)}  ${l}`));
    }
    return lines.join('\n');
  });
  process.stdout.write(out.join('\n\n') + '\n');
}

/**
 * Vertical key: value view. `first` fields print first, in order; empty values hidden unless all.
 * `only` limits the view to the `first` fields (the curated set) unless `all`.
 */
export function printRecord(rec, { first = [], all = false, only = false } = {}) {
  const rest = only && !all ? [] : Object.keys(rec).filter((k) => !first.includes(k)).sort();
  const keys = [...first.filter((k) => k in rec), ...rest];
  printPairs(keys.filter((k) => all || fmtValue(rec[k]) !== '').map((k) => [k, fmtValue(rec[k])]));
}

const LABEL_MAX = 28;

/**
 * Aligned "label  value" lines. Values wrap to the terminal with a hanging indent, so long answers stay
 * in their column instead of running back to the left edge. A label longer than 28 characters gets its
 * own line, with the value starting under the value column on the next line.
 */
export function printPairs(pairs, indent = '') {
  if (!pairs.length) return;
  const w = Math.min(LABEL_MAX, Math.max(...pairs.map(([k]) => k.length)));
  const pad = `${indent}${' '.repeat(w + 2)}`;
  const room = Math.max(20, lineWidth() - pad.length);
  const out = [];
  for (const [k, v] of pairs) {
    const lines = wrap(String(v), room);
    if (k.length > w) out.push(`${indent}${dim(k)}`, ...lines.map((l) => pad + l));
    else out.push(`${indent}${dim(k.padEnd(w))}  ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => pad + l));
  }
  process.stdout.write(out.join('\n') + '\n');
}

/** Blank line + bold heading (with an optional dim note), separating sections in `get`. */
export function printHeading(title, note = '') {
  process.stdout.write(`\n${bold(title)}${note ? `  ${dim(note)}` : ''}\n`);
}

/** X-Total-Count counts matches before row-level ACLs, so "0 shown, N total" means ACL-hidden rows. */
export function printTotalNote(shown, total) {
  if (total === undefined || total <= shown) return;
  process.stderr.write(shown === 0 ? `(0 visible of ${total} matching; rows hidden by ACLs)\n` : `(${shown} of ${total}; use -l / --offset)\n`);
}
