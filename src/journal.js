// Journal fields (comments, work notes) as the Table API returns them with sysparm_display_value=true:
//   "2026-11-19 11:18:10 - Jane Doe (Comments)\n<text>\n\n2026-11-18 ... (Work notes)\n<text>\n\n"
// Rich-text entries arrive wrapped as [code]<html>[/code]; htmlToText turns them into readable plain text.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(s) {
  let t = String(s).replace(/\[code\]([\s\S]*?)\[\/code\]/g, '$1');
  if (!/<[a-z!/][^>]*>/i.test(t)) return decode(t).trim();
  const inline = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  t = t
    .replace(/\r\n?/g, '\n')
    .replace(/<(script|style|colgroup)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = inline(text);
      return !label || label === href ? href : `${label} (${href})`;
    })
    // One table row per line: cells (whatever markup they hold) joined with " | ".
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => inline(m[1]));
      return `\n${cells.join(' | ')}\n`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tbody|thead)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(t)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - (.+) \(([^()]+)\)$/;
const IMG = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/gi;

/**
 * Split a journal display value into entries { at, by, type, text, images, source }.
 * Each <img> becomes "[image N]" in the text; images[N-1] is its src (instance-relative URL).
 */
export function parseJournal(value, source) {
  const entries = [];
  let cur;
  for (const line of String(value || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(HEADER);
    if (m) {
      cur = { at: m[1], by: m[2], type: m[3], text: [], source };
      entries.push(cur);
    } else if (cur) cur.text.push(line);
  }
  return entries.map((e) => {
    const images = [];
    const raw = e.text.join('\n').replace(IMG, (_, src) => {
      images.push(decode(src));
      return ` [image ${images.length}] `;
    });
    return { ...e, text: htmlToText(raw), images };
  });
}

/**
 * Merge entries from several records, newest first. Drops duplicates (same time, author, text),
 * including the copies ServiceNow posts on the parent request ("SCTASK0010385's comment : ...");
 * the entry from the earlier list (the record itself) wins.
 */
export function mergeJournal(...lists) {
  const seen = new Set();
  const out = [];
  for (const e of lists.flat()) {
    const key = `${e.at}\0${e.by}\0${e.text.replace(/^\S+'s comment : /, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
