// Record attachments. Instances often hide sys_attachment fields from REST callers (the Attachment API
// then returns only sys_ids, and its /file and DELETE endpoints fail), so this module sticks to what
// works for a normal agent account:
//   list      GET  /api/now/attachment?sysparm_query=table_sys_id=<record>   (sys_ids)
//   content   GET  /sys_attachment.do?sys_id=<id>                            (bytes; name in Content-Disposition)
//   upload    POST /api/now/attachment/file?table_name&table_sys_id&file_name
//   delete    DELETE /api/now/table/sys_attachment/<id>
// Downloads are cached by sys_id under ~/.cache/snow/attachments/<host>/<sys_id>/<file name>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from './http.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.sql': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

function cacheDir(ctx, sysId) {
  const root = process.env.SNOW_CACHE_DIR || path.join(os.homedir(), '.cache', 'snow');
  return path.join(root, 'attachments', new URL(ctx.instance).host, sysId);
}

/** "attachment; filename="a b.png"" / RFC 5987 filename*=UTF-8''a%20b.png → "a b.png" */
export function fileNameFromDisposition(header) {
  const h = header || '';
  const star = h.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  const plain = h.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i);
  return plain ? (plain[1] ?? plain[2]).trim() : '';
}

/** sys_ids of the attachments on one record, oldest first. */
export async function listAttachmentIds(ctx, recordSysId) {
  const res = await request(ctx, 'GET', '/api/now/attachment', {
    query: { sysparm_query: `table_sys_id=${recordSysId}^ORDERBYsys_created_on`, sysparm_limit: 500 },
  });
  return (res.data.result || []).map((a) => a.sys_id).filter(Boolean);
}

/** Download (or reuse) one attachment. Returns { sys_id, file_name, content_type, size_bytes, path }. */
export async function fetchAttachment(ctx, sysId) {
  const dir = cacheDir(ctx, sysId);
  const cached = fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f !== '.type')[0];
  if (cached) {
    const file = path.join(dir, cached);
    const type = fs.existsSync(path.join(dir, '.type')) ? fs.readFileSync(path.join(dir, '.type'), 'utf8') : mimeOf(cached);
    return { sys_id: sysId, file_name: cached, content_type: type, size_bytes: fs.statSync(file).size, path: file };
  }
  const res = await request(ctx, 'GET', '/sys_attachment.do', { query: { sys_id: sysId }, binary: true, headers: { Accept: '*/*' } });
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const name = path.basename(fileNameFromDisposition(res.headers.get('content-disposition')) || sysId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, res.data, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.type'), type);
  return { sys_id: sysId, file_name: name, content_type: type, size_bytes: res.data.length, path: file };
}

/** Attachments on a record with names and local copies. */
export async function listAttachments(ctx, recordSysId) {
  const ids = await listAttachmentIds(ctx, recordSysId);
  return Promise.all(ids.map((id) => fetchAttachment(ctx, id)));
}

export async function uploadAttachment(ctx, table, recordSysId, file, { name } = {}) {
  const fileName = name || path.basename(file);
  const res = await request(ctx, 'POST', '/api/now/attachment/file', {
    query: { table_name: table, table_sys_id: recordSysId, file_name: fileName },
    body: fs.readFileSync(file),
    headers: { 'Content-Type': mimeOf(fileName) },
  });
  const sysId = res.data.result?.sys_id;
  if (!sysId) throw new Error(`upload of ${fileName} returned no attachment id`);
  return { sys_id: sysId, file_name: fileName, content_type: mimeOf(fileName), size_bytes: fs.statSync(file).size };
}

export async function deleteAttachment(ctx, sysId) {
  await request(ctx, 'DELETE', `/api/now/table/sys_attachment/${sysId}`);
  fs.rmSync(cacheDir(ctx, sysId), { recursive: true, force: true });
}

/** Copy a cached attachment into `dir`, never overwriting. Returns the new path. */
export function copyOut(att, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(att.file_name);
  const stem = path.basename(att.file_name, ext);
  let file = path.join(dir, att.file_name);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
  fs.copyFileSync(att.path, file);
  return file;
}
