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

/** Shrink the widest columns until the table fits `max` characters (2-space gaps). */
export function fitWidths(widths, headers, max) {
  const w = [...widths];
  const floor = headers.map((h) => Math.max(h.length, 6));
  const total = () => w.reduce((a, b) => a + b, 0) + 2 * (w.length - 1);
  while (total() > max) {
    let i = -1;
    for (let j = 0; j < w.length; j++) if (w[j] > floor[j] && (i < 0 || w[j] > w[i])) i = j;
    if (i < 0) break; // every column at its floor; let the terminal wrap
    w[i]--;
  }
  return w;
}

export function printTable(rows, cols) {
  if (!rows.length) {
    process.stderr.write('(no records)\n');
    return;
  }
  cols = cols?.length ? cols : Object.keys(rows[0]);
  let cells = rows.map((r) => cols.map((c) => clip(oneLine(fmtValue(r[c])), MAX_COL)));
  let widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  if (process.stdout.isTTY && process.stdout.columns) {
    widths = fitWidths(widths, cols, process.stdout.columns);
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

/** Vertical key: value view. `first` fields print first, in order; empty values hidden unless all. */
export function printRecord(rec, { first = [], all = false } = {}) {
  const keys = [...first.filter((k) => k in rec), ...Object.keys(rec).filter((k) => !first.includes(k)).sort()];
  const shown = keys.filter((k) => all || fmtValue(rec[k]) !== '');
  const w = Math.max(...shown.map((k) => k.length));
  const out = shown.map((k) => {
    const v = fmtValue(rec[k]);
    return `${k.padEnd(w)}  ${v.includes('\n') ? v.replace(/\n/g, `\n${' '.repeat(w + 2)}`) : v}`;
  });
  process.stdout.write(out.join('\n') + '\n');
}

/** X-Total-Count counts matches before row-level ACLs, so "0 shown, N total" means ACL-hidden rows. */
export function printTotalNote(shown, total) {
  if (total === undefined || total <= shown) return;
  process.stderr.write(shown === 0 ? `(0 visible of ${total} matching; rows hidden by ACLs)\n` : `(${shown} of ${total}; use -l / --offset)\n`);
}
