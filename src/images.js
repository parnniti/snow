// Images pasted into comments / work notes. The journal HTML holds <img src="/<sys_id>.iix">; that URL
// serves the image to an authenticated session (the attachment REST API does not). Images are cached
// by instance + sys_id, so repeated `get`s download nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from './http.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };

function cacheDir(ctx) {
  const root = process.env.SNOW_CACHE_DIR || path.join(os.homedir(), '.cache', 'snow');
  return path.join(root, 'images', new URL(ctx.instance).host);
}

/** Download (or reuse) one image. Returns { src, path, type } or { src, error }. */
export async function fetchImage(ctx, src) {
  const id = src.match(/([0-9a-f]{32})/)?.[1] ?? Buffer.from(src).toString('base64url').slice(0, 40);
  const dir = cacheDir(ctx);
  const hit = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`));
  if (hit) return { src, path: path.join(dir, hit), type: hit.split('.').pop() };
  try {
    const res = await request(ctx, 'GET', src, { binary: true, headers: { Accept: 'image/*' } });
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!mime.startsWith('image/')) return { src, error: `not an image (${mime || 'no content type'})` };
    const ext = EXT[mime] ?? mime.split('/')[1];
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(file, res.data, { mode: 0o600 });
    return { src, path: file, type: ext };
  } catch (e) {
    return { src, error: e.message };
  }
}

/**
 * Inline image protocol for this terminal: "iterm" (iTerm2, WezTerm, VS Code), "kitty" (kitty, Ghostty),
 * or "none". SNOW_IMAGES=iterm|kitty|none overrides detection.
 */
export function inlineProtocol() {
  const forced = process.env.SNOW_IMAGES;
  if (forced) return ['iterm', 'kitty'].includes(forced) ? forced : 'none';
  if (!process.stdout.isTTY) return 'none';
  const tp = process.env.TERM_PROGRAM || '';
  if (tp === 'iTerm.app' || tp === 'WezTerm' || process.env.LC_TERMINAL === 'iTerm2') return 'iterm';
  if (process.env.TERM === 'xterm-kitty' || tp === 'ghostty' || process.env.KITTY_WINDOW_ID) return 'kitty';
  return 'none';
}

/** Escape sequence that draws the image inline, or '' when the protocol cannot show this file. */
export function inlineImage(file, type, protocol) {
  const data = fs.readFileSync(file);
  if (protocol === 'iterm') {
    return `\x1b]1337;File=inline=1;size=${data.length};preserveAspectRatio=1:${data.toString('base64')}\x07\n`;
  }
  if (protocol === 'kitty' && type === 'png') {
    const b64 = data.toString('base64');
    let out = '';
    for (let i = 0; i < b64.length; i += 4096) {
      const more = i + 4096 < b64.length ? 1 : 0;
      out += `\x1b_G${i === 0 ? 'f=100,a=T,' : ''}m=${more};${b64.slice(i, i + 4096)}\x1b\\`;
    }
    return `${out}\n`;
  }
  return '';
}
