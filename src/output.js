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

export function printTable(rows, cols) {
  if (!rows.length) {
    process.stderr.write('(no records)\n');
    return;
  }
  cols = cols?.length ? cols : Object.keys(rows[0]);
  const cells = rows.map((r) => cols.map((c) => clip(oneLine(fmtValue(r[c])), MAX_COL)));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(cols), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)];
  process.stdout.write(out.join('\n') + '\n');
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
