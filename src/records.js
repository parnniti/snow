// Task-table commands: incident, change, ritm, sctask. Thin layer over the Table API helpers.
import { joinQuery, orderClause, outputMode, parseSets, readData, splitFields } from './args.js';
import { create, get, list, update } from './table.js';
import { printJSON, printRecord, printTable, printTotalNote } from './output.js';
import { currentUser } from './user.js';
import { BIN, loadConfig, resolveContext } from './config.js';

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
    listFields: ['number', 'short_description', 'cat_item', 'stage', 'state', 'requested_for', 'assignment_group', 'assigned_to'],
    first: ['number', 'short_description', 'cat_item', 'stage', 'state', 'request', 'requested_for', 'opened_by', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
  },
  sctask: {
    table: 'sc_task',
    aliases: ['task'],
    listFields: ['number', 'short_description', 'state', 'request_item', 'assignment_group', 'assigned_to', 'sys_updated_on'],
    first: ['number', 'short_description', 'state', 'request_item', 'request', 'assignment_group', 'assigned_to', 'opened_at', 'sys_updated_on', 'description'],
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

function usage(name, k) {
  const createFlags = k.create ? Object.keys(k.create.flags).map((f) => `[--${f} V]`).join(' ') : '';
  return `Usage:
  ${BIN} ${name} list [--mine] [--opened-by-me] [--group NAME] [--all] [-q QUERY] [-f FIELDS] [-l N] [--offset N] [--order [-]FIELD] [--raw]
  ${BIN} ${name} get <NUMBER|sys_id> [-f FIELDS] [--all-fields] [--raw]
${k.create ? `  ${BIN} ${name} create -t TITLE [--description T] [--group NAME] [--assignee NAME] ${createFlags} [-s k=v]... [-d JSON]\n` : ''}  ${BIN} ${name} update <NUMBER|sys_id> [-t TITLE] [--description T] [--group NAME] [--assignee NAME] [-s k=v]... [-d JSON]
  ${BIN} ${name} comment <NUMBER|sys_id> <TEXT> [--work-note]

Table: ${k.table}. Lists show active records, newest update first, unless --all / --order.
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
          const { rows, total } = await list(ctx, kind.table, { query, fields, limit: opts.limit ?? 20, offset: opts.offset, displayValue });
          if (outputMode(opts, 'table') === 'json') return printJSON(rows);
          printTable(rows, fields);
          printTotalNote(rows.length, total);
          return;
        }
        case 'get': {
          if (!args[0]) throw new Error(`usage: ${BIN} ${name} get <NUMBER|sys_id>`);
          const rec = await get(ctx, kind.table, args[0], { fields: splitFields(opts.fields), displayValue });
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
