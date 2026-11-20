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
 * Inline image protocol for this terminal: "iterm" (iTerm2, WezTerm, Warp), "kitty" (kitty, Ghostty),
 * or "none". SNOW_IMAGES=iterm|kitty|none overrides detection.
 */
export function inlineProtocol() {
  const forced = process.env.SNOW_IMAGES;
  if (forced) return ['iterm', 'kitty'].includes(forced) ? forced : 'none';
  if (!process.stdout.isTTY) return 'none';
  const tp = process.env.TERM_PROGRAM || '';
  // Warp renders the iTerm2 protocol (and kitty); iTerm2's also handles JPEG/GIF, so prefer it.
  if (tp === 'iTerm.app' || tp === 'WezTerm' || tp === 'WarpTerminal' || process.env.LC_TERMINAL === 'iTerm2') return 'iterm';
  if (process.env.TERM === 'xterm-kitty' || tp === 'ghostty' || process.env.KITTY_WINDOW_ID) return 'kitty';
  return 'none';
}

/** Pixel size from a PNG, GIF or JPEG header; null for other formats. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

// Typical terminal cell in pixels, to turn image pixels into columns/rows without upscaling small images.
const CELL_W = 9;
const CELL_H = 18;

/**
 * Box (in terminal cells) an image is drawn into: its natural size, capped at SNOW_IMAGE_WIDTH columns
 * (default 72, never wider than the terminal) and SNOW_IMAGE_HEIGHT rows (default 18). Aspect ratio is kept.
 */
export function imageBox(size, columns = process.stdout.columns || 100) {
  const capW = Math.max(10, Math.min(Number(process.env.SNOW_IMAGE_WIDTH) || 72, columns - 6));
  const capH = Math.max(4, Number(process.env.SNOW_IMAGE_HEIGHT) || 18);
  if (!size) return { w: capW, h: capH };
  return { w: Math.min(capW, Math.ceil(size.w / CELL_W)), h: Math.min(capH, Math.ceil(size.h / CELL_H)) };
}

/** Escape sequence that draws the image inline, or '' when the protocol cannot show this file. */
export function inlineImage(file, type, protocol) {
  const data = fs.readFileSync(file);
  const box = imageBox(imageSize(data));
  if (protocol === 'iterm') {
    // width/height in cells with preserveAspectRatio: the image fits inside the box.
    return `    \x1b]1337;File=inline=1;size=${data.length};width=${box.w};height=${box.h};preserveAspectRatio=1:${data.toString('base64')}\x07\n`;
  }
  if (protocol === 'kitty' && type === 'png') {
    // kitty stretches when given both c and r, so pick the one that keeps the aspect ratio inside the box.
    const size = imageSize(data);
    const byWidth = size ? (box.w * CELL_W * size.h) / size.w / CELL_H <= box.h : true;
    const fit = byWidth ? `c=${box.w}` : `r=${box.h}`;
    const b64 = data.toString('base64');
    let out = '';
    for (let i = 0; i < b64.length; i += 4096) {
      const more = i + 4096 < b64.length ? 1 : 0;
      out += `\x1b_G${i === 0 ? `f=100,a=T,${fit},` : ''}m=${more};${b64.slice(i, i + 4096)}\x1b\\`;
    }
    return `    ${out}\n`;
  }
  return '';
}
