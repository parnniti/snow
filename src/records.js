// Task-table commands: incident, change, ritm, sctask. Thin layer over the Table API helpers.
import fs from 'node:fs';
import { joinQuery, orderClause, outputMode, parseSets, readData, splitFields } from './args.js';
import { request } from './http.js';
import { mergeJournal, parseJournal } from './journal.js';
import { SYS_ID_RE, create, get, list, remove, resolveSysId, unappliedFields, update } from './table.js';
import { copyOut, deleteAttachment, listAttachments, uploadAttachment } from './attachments.js';
import { printBlocks, printHeading, printJSON, printPairs, printRecord, printTable, printTotalNote } from './output.js';
import { fetchImage, inlineImage, inlineProtocol } from './images.js';
import { currentUser } from './user.js';
import { BIN, loadConfig, resolveContext } from './config.js';

// Catalog forms keep what the request is about in variables, not in short_description (which holds the
// catalog task template name, e.g. "Cloud access task"). On ritm/sctask two virtual columns read them:
//   summary  the first non-empty of SNOW_SUMMARY_VARIABLES (default "summary"), else short_description
//   details  every non-empty Multi Line Text answer on the request, in form order. Each catalog item names
//            its fields differently (additional_detail, dbr_request_details, ad_deployment_note, ...),
//            so details go by variable type, not name. One extra call per page.
const SUMMARY_VARS = (process.env.SNOW_SUMMARY_VARIABLES ?? 'summary').split(',').map((s) => s.trim()).filter(Boolean);
const MULTI_LINE_TEXT = '2'; // item_option_new.type
// Fields that --long prints in full under each record instead of as one-line columns.
const LONG_FIELDS = ['summary', 'details', 'short_description', 'description'];

const KINDS = {
  incident: {
    table: 'incident',
    aliases: ['inc'],
    listFields: ['number', 'short_description', 'state', 'priority', 'assignment_group', 'assigned_to', 'sys_updated_on'],
    first: ['number', 'short_description', 'state', 'priority', 'impact', 'urgency', 'caller_id', 'category', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
    create: {
      flags: { caller: 'caller_id', urgency: 'urgency', impact: 'impact', category: 'category' },
    },
    // `close` / `resolve`: target state label, where -m goes, and whether a close code is required.
    close: { state: 'Resolved', notes: 'close_notes', code: 'close_code', needsCode: true },
  },
  change: {
    table: 'change_request',
    aliases: ['chg'],
    listFields: ['number', 'short_description', 'type', 'state', 'risk', 'start_date', 'end_date', 'assignment_group'],
    first: ['number', 'short_description', 'type', 'state', 'risk', 'impact', 'start_date', 'end_date', 'requested_by', 'assignment_group', 'assigned_to', 'sys_updated_on', 'description', 'justification', 'implementation_plan', 'backout_plan', 'test_plan'],
    create: {
      flags: { type: 'type', start: 'start_date', end: 'end_date', risk: 'risk', impact: 'impact' },
    },
    close: { state: 'Closed', notes: 'close_notes', code: 'close_code', needsCode: true },
  },
  ritm: {
    table: 'sc_req_item',
    aliases: [],
    listFields: ['number', 'summary', 'details', 'stage', 'state', 'requested_for', 'assigned_to'],
    first: ['number', 'summary', 'details', 'short_description', 'cat_item', 'stage', 'state', 'request', 'requested_for', 'opened_by', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
    varPath: 'variables',
    ritmId: 'sys_id',
    close: { state: 'Closed Complete', notes: 'work_notes' },
  },
  sctask: {
    table: 'sc_task',
    aliases: ['task'],
    listFields: ['number', 'summary', 'details', 'requester', 'state', 'request_item', 'assigned_to'],
    first: ['number', 'summary', 'details', 'short_description', 'requester', 'state', 'request_item', 'request', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
    varPath: 'request_item.variables',
    ritmId: 'request_item.sys_id',
    // Short column names for dot-walked fields.
    columns: { requester: 'request_item.requested_for' },
    close: { state: 'Closed Complete', notes: 'work_notes' },
  },
};

const COMMON_WRITE = {
  title: { type: 'string', short: 't' },
  description: { type: 'string' },
  group: { type: 'string' },
  assignee: { type: 'string' },
  set: { type: 'string', short: 's', multiple: true },
  data: { type: 'string', short: 'd' },
};

/**
 * Expand the virtual columns into the fields the API needs. `fill` folds summary and column aliases
 * (kind.columns) back into one value each; `details` (when asked) is filled afterwards by
 * attachDetails, keyed by the request item sys_id.
 */
function virtualRequest(kind, fields) {
  const wantSummary = Boolean(kind.varPath && SUMMARY_VARS.length && fields.includes('summary'));
  const wantDetails = Boolean(kind.varPath && fields.includes('details'));
  const aliases = fields.filter((f) => kind.columns?.[f]);
  if (!wantSummary && !wantDetails && !aliases.length) return { apiFields: fields, fill: (r) => r, wantDetails };
  const summarySrc = SUMMARY_VARS.map((v) => `${kind.varPath}.${v}`);
  const apiFields = [];
  for (const f of fields) {
    if (f === 'summary' && wantSummary) apiFields.push(...summarySrc, 'short_description');
    else if (f === 'details' && wantDetails) apiFields.push(kind.ritmId);
    else if (aliases.includes(f)) apiFields.push(kind.columns[f]);
    else apiFields.push(f);
  }
  const extra = [...new Set(apiFields)].filter((f) => !fields.includes(f) && f !== kind.ritmId);
  const fill = (r) => {
    const out = { ...r };
    if (wantSummary) out.summary = summarySrc.map((s) => r[s]).find(Boolean) || r.short_description || '';
    for (const f of aliases) out[f] = r[kind.columns[f]] ?? '';
    for (const s of extra) delete out[s];
    return out;
  };
  return { apiFields: [...new Set(apiFields)], fill, wantDetails };
}

/** Set row.details from the requests' Multi Line Text answers (one sc_item_option_mtom query for all rows). */
async function attachDetails(ctx, kind, rows) {
  const ids = [...new Set(rows.map((r) => r[kind.ritmId]).filter((id) => SYS_ID_RE.test(id || '')))];
  const byRitm = new Map();
  if (ids.length) {
    let answers = [];
    try {
      ({ rows: answers } = await list(ctx, 'sc_item_option_mtom', {
        query: `request_itemIN${ids.join(',')}^sc_item_option.item_option_new.type=${MULTI_LINE_TEXT}^sc_item_option.valueISNOTEMPTY^ORDERBYsc_item_option.item_option_new.order`,
        fields: ['request_item', 'sc_item_option.item_option_new.question_text', 'sc_item_option.value'],
        limit: Math.max(100, ids.length * 20),
        displayValue: false,
      }));
    } catch (e) {
      if (!(e.name === 'ApiError' && e.status === 403)) throw e; // no read access to variables: leave details empty
    }
    for (const a of answers) {
      const v = (a['sc_item_option.value'] || '').replace(/\r\n?/g, '\n').trim();
      const seen = byRitm.get(a.request_item) ?? [];
      if (v && !seen.some((x) => x.value === v)) seen.push({ question: a['sc_item_option.item_option_new.question_text'], value: v });
      byRitm.set(a.request_item, seen);
    }
  }
  for (const r of rows) {
    const answers = byRitm.get(r[kind.ritmId]) ?? [];
    r.details = answers.length === 1 ? answers[0].value : answers.map((x) => `${x.question}:\n${x.value}`).join('\n\n');
    delete r[kind.ritmId];
  }
}

function writeImage(ctx, img, n, protocol) {
  const url = String(new URL(img.src, ctx.instance));
  const where = img.path ? `file://${img.path}` : img.error ? `${url} (${img.error})` : url;
  process.stdout.write(`    [image ${n}] ${where}\n`);
  if (img.path && protocol !== 'none') process.stdout.write(inlineImage(img.path, img.type, protocol));
}

// Form layout pieces that carry no answer: labels, breaks, container start/end, macros, UI pages.
const LAYOUT_TYPES = new Set(['11', '12', '14', '15', '17', '19', '20', '24']);
const CHECKBOX = '7';

/**
 * The request form as the portal shows it: answered questions in form order, values as display text
 * (reference variables resolve to names). Two calls: variable metadata, then the values by dot-walk.
 * Returns [] when the account cannot read the variables.
 */
async function loadForm(ctx, ritmSysId) {
  let meta;
  try {
    ({ rows: meta } = await list(ctx, 'sc_item_option_mtom', {
      query: `request_item=${ritmSysId}^ORDERBYsc_item_option.order`,
      fields: ['sc_item_option.item_option_new.name', 'sc_item_option.item_option_new.question_text', 'sc_item_option.item_option_new.type', 'sc_item_option.value'],
      limit: 500,
      displayValue: false,
    }));
  } catch (e) {
    if (e.name === 'ApiError' && e.status === 403) return [];
    throw e;
  }
  const seen = new Set();
  const vars = [];
  for (const m of meta) {
    const name = m['sc_item_option.item_option_new.name'];
    const type = m['sc_item_option.item_option_new.type'];
    const raw = (m['sc_item_option.value'] || '').trim();
    if (!name || seen.has(name) || LAYOUT_TYPES.has(type) || !raw || (type === CHECKBOX && raw === 'false')) continue;
    seen.add(name);
    vars.push({ name, question: m['sc_item_option.item_option_new.question_text'] || name, type, raw });
  }
  if (!vars.length) return [];
  const res = await request(ctx, 'GET', `/api/now/table/sc_req_item/${ritmSysId}`, {
    query: { sysparm_fields: vars.map((v) => `variables.${v.name}`).join(','), sysparm_display_value: 'true' },
  });
  const shown = res.data.result || {};
  // `raw` is the stored value (sys_ids for references/list collectors): reuse it in `catalog order -s`.
  return vars.map((v) => ({ name: v.name, question: v.question, value: String(shown[`variables.${v.name}`] || v.raw).replace(/\r\n?/g, '\n').trim(), raw: v.raw }));
}

/** Comments and work notes of a record (display text of its journal fields), as parsed entries. */
async function loadJournal(ctx, table, sysId, source) {
  const rec = await get(ctx, table, sysId, { fields: ['comments_and_work_notes'], displayValue: true });
  return parseJournal(rec.comments_and_work_notes, source);
}

function usage(name, k) {
  const createFlags = k.create ? Object.keys(k.create.flags).map((f) => `[--${f} V]`).join(' ') : '';
  return `Usage:
  ${BIN} ${name} list [--mine] [--opened-by-me] [--group NAME] [--all] [-q QUERY] [-f FIELDS] [-l N] [--offset N] [--order [-]FIELD] [--long] [--raw]
  ${BIN} ${name} get <NUMBER|sys_id> [-f FIELDS] [--all-fields] [--raw]
      shows the main fields${k.varPath ? ', the request form (every answered question)' : ''} and comments + work notes;
      images in comments are downloaded to ~/.cache/snow and drawn inline on iTerm2/WezTerm/Warp/kitty/Ghostty
      (force with SNOW_IMAGES=iterm|kitty, disable with --no-images);
      --all-fields adds every other field, -f FIELDS prints just those fields
${k.create ? `  ${BIN} ${name} create -t TITLE [--description T] [--group NAME] [--assignee NAME] ${createFlags} [-s k=v]... [-d JSON]\n` : ''}  ${BIN} ${name} update <NUMBER|sys_id> [-t TITLE] [--description T] [--group NAME] [--assignee NAME] [-s k=v]... [-d JSON]
  ${BIN} ${name} comment <NUMBER|sys_id> <TEXT> [--work-note]
  ${BIN} ${name} assign <NUMBER|sys_id> [--to me|NAME] [--group NAME]       (no flags: assign to me)
  ${BIN} ${name} state <NUMBER|sys_id> <STATE LABEL> [-m WORK NOTE]         e.g. state SCTASK0010368 "Work in Progress"
${k.close ? `  ${BIN} ${name} close <NUMBER|sys_id> [-m NOTES]${k.close.needsCode ? ' --code CLOSE_CODE' : ''} [--as STATE LABEL]   sets "${k.close.state}"${name === 'incident' ? ' (alias: resolve)' : ''}\n` : ''}  ${BIN} ${name} attach <NUMBER|sys_id> FILE... [--name NAME]
  ${BIN} ${name} attachments <NUMBER|sys_id> [--out DIR]                     list (downloads to the cache; --out copies)
  ${BIN} ${name} detach <NUMBER|sys_id> <FILE NAME|attachment sys_id> --yes
  ${BIN} ${name} delete <NUMBER|sys_id> --yes

Table: ${k.table}. Lists show active records, newest update first, unless --all / --order.
${k.varPath ? `Columns "summary" (the summary variable) and "details" (multi-line answers on the request form) come from catalog variables.\n` : ''}--long prints each record as a block with long text (summary, details, description) in full.
Writes take display values for reference and choice fields (e.g. --group "DevOps", --assignee "Jane Doe",
-s state="Work in Progress"). ServiceNow silently ignores values it cannot map, so writes check the
result and fail (state/assign/close) or warn (create/update) when a field did not take.
Global: -c CONTEXT, -o table|json`;
}

function writeFields(opts, kind, isCreate) {
  const fields = { ...(readData(opts.data) || {}) };
  if (opts.title !== undefined) fields.short_description = opts.title;
  if (opts.description !== undefined) fields.description = opts.description;
  if (opts.group !== undefined) fields.assignment_group = opts.group;
  if (opts.assignee !== undefined) fields.assigned_to = opts.assignee;
  if (isCreate) for (const [flag, field] of Object.entries(kind.create.flags)) if (opts[flag] !== undefined) fields[field] = opts[flag];
  Object.assign(fields, parseSets(opts.set));
  return fields;
}

const log = (msg) => process.stderr.write(`${msg}\n`);

function showWritten(opts, kind, rec) {
  return outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: kind.first, only: true });
}

function warnUnapplied(sent, rec) {
  for (const u of unappliedFields(sent, rec)) log(`warning: ${u.field} is "${u.now}" after the write (sent "${u.sent}"); ServiceNow did not apply it`);
}

function mustApply(sent, rec, hint = '') {
  const bad = unappliedFields(sent, rec);
  if (bad.length) {
    throw new Error(`${rec.number || 'record'}: ServiceNow did not apply ${bad.map((u) => `${u.field}="${u.sent}" (still "${u.now}")`).join(', ')}.${hint}`);
  }
}

/**
 * One active record matching VALUE on any of `keys` (or a sys_id). Ambiguous or missing matches fail,
 * so writes never pick an arbitrary "John Smith".
 */
export async function findOne(ctx, table, value, keys) {
  if (SYS_ID_RE.test(value)) return get(ctx, table, value, { fields: ['sys_id', ...keys] });
  const query = `active=true^${keys.map((k, i) => `${i ? 'OR' : ''}${k}=${value}`).join('^')}`;
  const { rows } = await list(ctx, table, { query, fields: ['sys_id', ...keys], limit: 5 });
  if (!rows.length) throw new Error(`no active ${table} matching "${value}" (by ${keys.join('/')})`);
  if (rows.length > 1) throw new Error(`"${value}" matches ${rows.length} ${table} records (${rows.map((r) => r[keys[0]]).join(', ')}); be more specific`);
  return rows[0];
}

function makeCommand(name, kind) {
  const createOpts = kind.create ? Object.fromEntries(Object.keys(kind.create.flags).map((f) => [f, { type: 'string' }])) : {};
  return {
    usage: usage(name, kind),
    options: {
      mine: { type: 'boolean' },
      'opened-by-me': { type: 'boolean' },
      all: { type: 'boolean' },
      query: { type: 'string', short: 'q' },
      fields: { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string' },
      order: { type: 'string' },
      raw: { type: 'boolean' },
      'all-fields': { type: 'boolean' },
      'work-note': { type: 'boolean' },
      long: { type: 'boolean' },
      'no-images': { type: 'boolean' },
      to: { type: 'string' },
      message: { type: 'string', short: 'm' },
      code: { type: 'string' },
      as: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      ...COMMON_WRITE,
      ...createOpts,
    },
    async run(_, opts, [sub, ...args]) {
      const ctx = resolveContext(loadConfig(), opts.context);
      const displayValue = !opts.raw;
      switch (sub) {
        case 'list': {
          let me;
          if (opts.mine || opts['opened-by-me']) me = await currentUser(ctx);
          const query = joinQuery(
            opts.all ? '' : 'active=true',
            opts.mine ? `assigned_to=${me.sys_id}` : '',
            opts['opened-by-me'] ? `opened_by=${me.sys_id}` : '',
            opts.group ? `assignment_group.name=${opts.group}` : '',
            opts.query,
            orderClause(opts.order || '-sys_updated_on'),
          );
          const fields = splitFields(opts.fields) || kind.listFields;
          const { apiFields, fill, wantDetails } = virtualRequest(kind, fields);
          const { rows: raw, total } = await list(ctx, kind.table, { query, fields: apiFields, limit: opts.limit ?? 20, offset: opts.offset, displayValue });
          const rows = raw.map(fill);
          if (wantDetails) await attachDetails(ctx, kind, rows);
          if (outputMode(opts, 'table') === 'json') return printJSON(rows);
          if (opts.long) printBlocks(rows, fields, LONG_FIELDS);
          // printTable keeps summary/short_description wide and never cuts record numbers.
          else printTable(rows, fields);
          printTotalNote(rows.length, total);
          return;
        }
        case 'get': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} get <NUMBER|sys_id>`);
          const asked = splitFields(opts.fields);
          let rec;
          if (asked) {
            const { apiFields, fill, wantDetails } = virtualRequest(kind, asked);
            rec = fill(await get(ctx, kind.table, args[0], { fields: apiFields, displayValue }));
            if (wantDetails) await attachDetails(ctx, kind, [rec]);
          } else {
            rec = await get(ctx, kind.table, args[0], { displayValue });
          }
          if (asked || !rec.sys_id) {
            return outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: asked, all: opts['all-fields'] });
          }
          // Full view: curated fields, the request form (ritm/sctask), and comments + work notes.
          let form = [];
          let ritm;
          const journals = [loadJournal(ctx, kind.table, rec.sys_id, rec.number)];
          if (kind.varPath) {
            const columns = Object.keys(kind.columns ?? {});
            const { apiFields, fill } = virtualRequest(kind, ['summary', ...columns]);
            const extra = await get(ctx, kind.table, rec.sys_id, { fields: [...apiFields, kind.ritmId], displayValue });
            const filled = fill(extra);
            if (filled.summary && filled.summary !== rec.short_description) rec.summary = filled.summary;
            for (const c of columns) if (filled[c]) rec[c] = filled[c];
            ritm = { sysId: extra[kind.ritmId], number: kind.table === 'sc_req_item' ? rec.number : rec.request_item };
            if (SYS_ID_RE.test(ritm.sysId || '')) {
              if (kind.table !== 'sc_req_item') journals.push(loadJournal(ctx, 'sc_req_item', ritm.sysId, ritm.number));
              form = await loadForm(ctx, ritm.sysId);
            }
          }
          const activity = mergeJournal(...(await Promise.all(journals)));
          // Files attached to the record (and, for a catalog task, to its request item).
          const owners = [[rec.number, rec.sys_id], ...(ritm && SYS_ID_RE.test(ritm.sysId || '') && ritm.sysId !== rec.sys_id ? [[ritm.number, ritm.sysId]] : [])];
          const attachments = (
            await Promise.all(owners.map(async ([num, id]) => (await listAttachments(ctx, id)).map((a) => ({ ...a, on: num }))))
          ).flat();
          // Images pasted into comments: download once (cached), keep the local path for display / agents.
          if (!opts['no-images']) {
            await Promise.all(activity.map(async (e) => (e.images = await Promise.all(e.images.map((src) => fetchImage(ctx, src))))));
          } else {
            for (const e of activity) e.images = e.images.map((src) => ({ src }));
          }
          if (outputMode(opts, 'table') === 'json') return printJSON({ ...rec, form, attachments, activity });
          printRecord(rec, { first: kind.first, all: opts['all-fields'], only: true });
          if (form.length) {
            printHeading(`Request form (${ritm.number})`);
            printPairs(form.map((f) => [f.question, f.value]), '  ');
          }
          if (attachments.length) {
            printHeading(`Attachments (${attachments.length})`);
            for (const a of attachments) {
              process.stdout.write(`  ${a.file_name}  (${a.size_bytes} bytes${a.on !== rec.number ? `, on ${a.on}` : ''})  file://${a.path}\n`);
            }
          }
          printHeading(activity.length ? `Activity (${activity.length}, newest first)` : 'Activity: no comments or work notes');
          const protocol = inlineProtocol();
          for (const e of activity) {
            const from = e.source && e.source !== rec.number ? `  ·  ${e.source}` : '';
            process.stdout.write(`  ${e.at}  ${e.by}  ·  ${e.type}${from}\n`);
            // A marker on its own line becomes the image (path + inline picture); inline markers stay in the text.
            const shown = new Set();
            for (const line of e.text.split('\n')) {
              const n = Number(line.match(/^\[image (\d+)\]$/)?.[1]);
              if (n && e.images[n - 1]) {
                writeImage(ctx, e.images[n - 1], n, protocol);
                shown.add(n);
              } else process.stdout.write(`    ${line}\n`);
            }
            e.images.forEach((img, i) => shown.has(i + 1) || writeImage(ctx, img, i + 1, protocol));
          }
          return;
        }
        case 'create': {
          if (!kind.create) throw new Error(`${BIN} ${name} create is not supported; ${kind.table} records come from their parent flow`);
          const fields = writeFields(opts, kind, true);
          if (!fields.short_description) throw new Error('create needs -t/--title (short_description)');
          const rec = await create(ctx, kind.table, fields);
          warnUnapplied(fields, rec);
          return showWritten(opts, kind, rec);
        }
        case 'update': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} update <NUMBER|sys_id> -s k=v`);
          const fields = writeFields(opts, kind, false);
          if (!Object.keys(fields).length) throw new Error('update needs at least one field (-s k=v, -t, --group, ...)');
          const rec = await update(ctx, kind.table, args[0], fields);
          warnUnapplied(fields, rec);
          return showWritten(opts, kind, rec);
        }
        case 'comment': {
          const [id, ...words] = args;
          const text = words.join(' ') || opts.message;
          if (!id || !text) throw new Error(`usage: ${BIN} ${name} comment <NUMBER|sys_id> <TEXT> [--work-note]`);
          const rec = await update(ctx, kind.table, id, { [opts['work-note'] ? 'work_notes' : 'comments']: text });
          log(`${opts['work-note'] ? 'work note' : 'comment'} added to ${rec.number}`);
          return;
        }
        case 'assign': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} assign <NUMBER|sys_id> [--to me|NAME] [--group NAME]`);
          const fields = {};
          if (opts.group) fields.assignment_group = (await findOne(ctx, 'sys_user_group', opts.group, ['name'])).name;
          if (opts.to || !opts.group) {
            const who = !opts.to || opts.to === 'me' ? await currentUser(ctx) : await findOne(ctx, 'sys_user', opts.to, ['name', 'user_name', 'email']);
            fields.assigned_to = who.name;
          }
          const rec = await update(ctx, kind.table, args[0], fields);
          mustApply(fields, rec);
          log(`${rec.number}: ${[fields.assignment_group && `group ${rec.assignment_group}`, fields.assigned_to && `assigned to ${rec.assigned_to}`].filter(Boolean).join(', ')}`);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : undefined;
        }
        case 'state': {
          const [id, ...words] = args;
          const label = words.join(' ');
          if (!id || !label) throw new Error(`usage: ${BIN} ${name} state <NUMBER|sys_id> <STATE LABEL> [-m WORK NOTE]`);
          const fields = { state: label, ...(opts.message ? { work_notes: opts.message } : {}) };
          const rec = await update(ctx, kind.table, id, fields);
          mustApply(fields, rec, ' Use the state label exactly as the form shows it.');
          log(`${rec.number}: state ${rec.state}`);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : undefined;
        }
        case 'resolve':
        case 'close': {
          if (!kind.close) throw new Error(`${BIN} ${name} close is not supported; use: ${BIN} ${name} state <NUMBER> <STATE LABEL>`);
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} close <NUMBER|sys_id> [-m NOTES]${kind.close.needsCode ? ' --code CLOSE_CODE' : ''}`);
          const c = kind.close;
          if (c.needsCode && !opts.code) throw new Error(`${name} close needs --code (the form's close/resolution code) and -m NOTES`);
          if (c.needsCode && !opts.message) throw new Error(`${name} close needs -m NOTES (close notes are mandatory)`);
          const fields = { state: opts.as || c.state };
          if (opts.code) fields[c.code] = opts.code;
          if (opts.message) fields[c.notes] = opts.message;
          const rec = await update(ctx, kind.table, args[0], fields);
          mustApply(fields, rec, c.needsCode ? ' Check the close code label on the form.' : '');
          log(`${rec.number}: ${rec.state}`);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : undefined;
        }
        case 'attach': {
          const [id, ...files] = args;
          if (!id || !files.length) throw new Error(`usage: ${BIN} ${name} attach <NUMBER|sys_id> FILE... [--name NAME]`);
          if (opts.name && files.length > 1) throw new Error('--name works with a single FILE');
          const missing = files.filter((f) => !fs.existsSync(f) || !fs.statSync(f).isFile());
          if (missing.length) throw new Error(`not a file: ${missing.join(', ')}`);
          const sysId = await resolveSysId(ctx, kind.table, id);
          const done = [];
          for (const f of files) done.push(await uploadAttachment(ctx, kind.table, sysId, f, { name: opts.name }));
          return outputMode(opts, 'table') === 'json' ? printJSON(done) : printTable(done, ['file_name', 'size_bytes', 'content_type', 'sys_id']);
        }
        case 'attachments': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} attachments <NUMBER|sys_id> [--out DIR]`);
          const atts = await listAttachments(ctx, await resolveSysId(ctx, kind.table, args[0]));
          if (opts.out) for (const a of atts) a.path = copyOut(a, opts.out);
          return outputMode(opts, 'table') === 'json' ? printJSON(atts) : printTable(atts, ['file_name', 'size_bytes', 'content_type', 'path']);
        }
        case 'detach': {
          const [id, which] = args;
          if (!id || !which) throw new Error(`usage: ${BIN} ${name} detach <NUMBER|sys_id> <FILE NAME|attachment sys_id> --yes`);
          const atts = await listAttachments(ctx, await resolveSysId(ctx, kind.table, id));
          const hits = atts.filter((a) => a.sys_id === which || a.file_name === which);
          if (!hits.length) throw new Error(`no attachment "${which}" on ${id} (have: ${atts.map((a) => a.file_name).join(', ') || 'none'})`);
          if (hits.length > 1) throw new Error(`"${which}" matches ${hits.length} attachments; use the sys_id (${hits.map((a) => a.sys_id).join(', ')})`);
          if (!opts.yes) throw new Error(`this deletes ${hits[0].file_name} from ${id}; re-run with --yes`);
          await deleteAttachment(ctx, hits[0].sys_id);
          log(`deleted ${hits[0].file_name} from ${id}`);
          return;
        }
        case 'delete': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} delete <NUMBER|sys_id> --yes`);
          if (!opts.yes) throw new Error(`this permanently deletes ${args[0]} (${kind.table}); re-run with --yes`);
          const sysId = await remove(ctx, kind.table, args[0]);
          log(`deleted ${args[0]} (${kind.table} ${sysId})`);
          return;
        }
        default:
          throw new Error(`unknown subcommand "${sub ?? ''}"\n\n${usage(name, kind)}`);
      }
    },
  };
}

export function recordCommands() {
  const out = {};
  for (const [name, kind] of Object.entries(KINDS)) {
    const cmd = makeCommand(name, kind);
    out[name] = cmd;
    for (const a of kind.aliases) out[a] = cmd;
  }
  return out;
}
