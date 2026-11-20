// Terminal styling for human output: colour only on a TTY, NO_COLOR turns colour off (bold stays, per
// no-color.org), FORCE_COLOR turns it on. Text wrapping with a hanging indent, fuzzy "2h ago" times.

const env = process.env;
const tty = Boolean(process.stdout.isTTY) && env.TERM !== 'dumb';
const force = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
export const styled = force || tty;
export const colored = force || (tty && !env.NO_COLOR);

const sgr = (open, close, on) => (s) => (on && s ? `\x1b[${open}m${s}\x1b[${close}m` : String(s ?? ''));
export const bold = sgr(1, 22, styled);
export const dim = sgr(2, 22, styled);
export const italic = sgr(3, 23, styled);
export const red = sgr(31, 39, colored);
export const green = sgr(32, 39, colored);
export const yellow = sgr(33, 39, colored);
export const blue = sgr(34, 39, colored);
export const magenta = sgr(35, 39, colored);
export const cyan = sgr(36, 39, colored);

/** Printable width of a string without ANSI sequences. */
export const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

/** Readable line width: the terminal, capped at 120 so long text stays easy to scan. */
export function lineWidth() {
  const cols = Number(env.COLUMNS) || process.stdout.columns || 100;
  return Math.max(40, Math.min(cols, 120));
}

/**
 * Word-wrap plain text to `width`, keeping existing line breaks. A word longer than the width (a URL,
 * a path) stays whole rather than being cut, so it remains clickable. Lines that look like commands or
 * JSON (looksLikeCode) are left whole so they can be copied; the terminal soft-wraps them.
 */
export function wrap(text, width) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.length <= width || looksLikeCode(line)) {
      out.push(line);
      continue;
    }
    const lead = line.match(/^\s*/)[0];
    let cur = '';
    for (const word of line.trim().split(/\s+/)) {
      if (!cur) cur = lead + word;
      else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
      else {
        out.push(cur);
        cur = lead + word;
      }
    }
    out.push(cur);
  }
  return out;
}

/** "assignment_group" → "Assignment group", "caller_id" → "Caller", "sys_id" → "Sys ID". */
export const humanLabel = (field) => {
  if (field === 'sys_id') return 'Sys ID';
  const s = String(field).replace(/^u_/, '').replace(/_id$/, '').replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Colour a state label by meaning: open → green, in flight → yellow, done → magenta, failed → red. */
export function stateColor(state) {
  const s = String(state ?? '').toLowerCase();
  if (!s) return '';
  if (/incomplete|reject|fail|cancel|skipped/.test(s)) return red(state);
  if (/closed|resolved|complete|approved|done/.test(s)) return magenta(state);
  if (/progress|pending|hold|wait|review|scheduled|assess|authori|implement/.test(s)) return yellow(state);
  return green(state);
}

/**
 * Lines that look like commands, JSON or paths are left whole (the terminal soft-wraps them), so they
 * can still be copied and pasted. Prose lines get word-wrapped.
 */
export function looksLikeCode(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^(\$ |--?[a-z]|[{[]|az |kubectl |curl |helm |terraform |git |ssh |psql |mysql |npm |snow |sudo |docker )/i.test(t)) return true;
  if (/\\$/.test(t)) return true; // shell line continuation
  const symbols = (t.match(/[{}[\]"=:/\\|<>;]/g) || []).length;
  return symbols / t.length > 0.12;
}

/**
 * "2026-11-20 15:37:18" (ServiceNow display time, taken as local time) → "3h ago".
 * Returns '' for values that do not parse.
 */
export function ago(value, now = Date.now()) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return '';
  const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'in the future';
  if (s < 60) return 'just now';
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
}
