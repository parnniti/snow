// Task-table commands: incident, change, ritm, sctask. Thin layer over the Table API helpers.
import { joinQuery, orderClause, outputMode, parseSets, readData, splitFields } from './args.js';
import { SYS_ID_RE, create, get, list, update } from './table.js';
import { printBlocks, printJSON, printRecord, printTable, printTotalNote } from './output.js';
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
  },
  change: {
    table: 'change_request',
    aliases: ['chg'],
    listFields: ['number', 'short_description', 'type', 'state', 'risk', 'start_date', 'end_date', 'assignment_group'],
    first: ['number', 'short_description', 'type', 'state', 'risk', 'impact', 'start_date', 'end_date', 'requested_by', 'assignment_group', 'assigned_to', 'sys_updated_on', 'description', 'justification', 'implementation_plan', 'backout_plan', 'test_plan'],
    create: {
      flags: { type: 'type', start: 'start_date', end: 'end_date', risk: 'risk', impact: 'impact' },
    },
  },
  ritm: {
    table: 'sc_req_item',
    aliases: [],
    listFields: ['number', 'summary', 'details', 'stage', 'state', 'requested_for', 'assigned_to'],
    first: ['number', 'summary', 'details', 'short_description', 'cat_item', 'stage', 'state', 'request', 'requested_for', 'opened_by', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
    varPath: 'variables',
    ritmId: 'sys_id',
  },
  sctask: {
    table: 'sc_task',
    aliases: ['task'],
    listFields: ['number', 'summary', 'details', 'state', 'request_item', 'assigned_to'],
    first: ['number', 'summary', 'details', 'short_description', 'state', 'request_item', 'request', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
    varPath: 'request_item.variables',
    ritmId: 'request_item.sys_id',
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
 * Expand the virtual columns into the fields the API needs. `fill` folds summary back into one value;
 * `details` (when asked) is filled afterwards by attachDetails, keyed by the request item sys_id.
 */
function virtualRequest(kind, fields) {
  const wantSummary = Boolean(kind.varPath && SUMMARY_VARS.length && fields.includes('summary'));
  const wantDetails = Boolean(kind.varPath && fields.includes('details'));
  if (!wantSummary && !wantDetails) return { apiFields: fields, fill: (r) => r, wantDetails };
  const summarySrc = SUMMARY_VARS.map((v) => `${kind.varPath}.${v}`);
  const apiFields = [];
  for (const f of fields) {
    if (f === 'summary' && wantSummary) apiFields.push(...summarySrc, 'short_description');
    else if (f === 'details' && wantDetails) apiFields.push(kind.ritmId);
    else apiFields.push(f);
  }
  const extra = [...new Set(apiFields)].filter((f) => !fields.includes(f) && f !== kind.ritmId);
  const fill = (r) => {
    const out = { ...r };
    if (wantSummary) out.summary = summarySrc.map((s) => r[s]).find(Boolean) || r.short_description || '';
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

function usage(name, k) {
  const createFlags = k.create ? Object.keys(k.create.flags).map((f) => `[--${f} V]`).join(' ') : '';
  return `Usage:
  ${BIN} ${name} list [--mine] [--opened-by-me] [--group NAME] [--all] [-q QUERY] [-f FIELDS] [-l N] [--offset N] [--order [-]FIELD] [--long] [--raw]
  ${BIN} ${name} get <NUMBER|sys_id> [-f FIELDS] [--all-fields] [--raw]
${k.create ? `  ${BIN} ${name} create -t TITLE [--description T] [--group NAME] [--assignee NAME] ${createFlags} [-s k=v]... [-d JSON]\n` : ''}  ${BIN} ${name} update <NUMBER|sys_id> [-t TITLE] [--description T] [--group NAME] [--assignee NAME] [-s k=v]... [-d JSON]
  ${BIN} ${name} comment <NUMBER|sys_id> <TEXT> [--work-note]

Table: ${k.table}. Lists show active records, newest update first, unless --all / --order.
${k.varPath ? `Columns "summary" (the summary variable) and "details" (multi-line answers on the request form) come from catalog variables.\n` : ''}--long prints each record as a block with long text (summary, details, description) in full.
Writes take display values for reference fields (e.g. --group "DevOps", --assignee "Jane Doe").
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
            if (kind.varPath && rec.sys_id) {
              const { apiFields, fill } = virtualRequest(kind, ['summary', 'details']);
              const extra = fill(await get(ctx, kind.table, rec.sys_id, { fields: apiFields, displayValue }));
              await attachDetails(ctx, kind, [extra]);
              if (extra.summary && extra.summary !== rec.short_description) rec.summary = extra.summary;
              if (extra.details) rec.details = extra.details;
            }
          }
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: kind.first, all: opts['all-fields'] });
        }
        case 'create': {
          if (!kind.create) throw new Error(`${BIN} ${name} create is not supported; ${kind.table} records come from their parent flow`);
          const fields = writeFields(opts, kind, true);
          if (!fields.short_description) throw new Error('create needs -t/--title (short_description)');
          const rec = await create(ctx, kind.table, fields);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: kind.first });
        }
        case 'update': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} update <NUMBER|sys_id> -s k=v`);
          const fields = writeFields(opts, kind, false);
          if (!Object.keys(fields).length) throw new Error('update needs at least one field (-s k=v, -t, --group, ...)');
          const rec = await update(ctx, kind.table, args[0], fields);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: kind.first });
        }
        case 'comment': {
          const [id, ...words] = args;
          const text = words.join(' ');
          if (!id || !text) throw new Error(`usage: ${BIN} ${name} comment <NUMBER|sys_id> <TEXT> [--work-note]`);
          const rec = await update(ctx, kind.table, id, { [opts['work-note'] ? 'work_notes' : 'comments']: text });
          process.stderr.write(`${opts['work-note'] ? 'work note' : 'comment'} added to ${rec.number}\n`);
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
