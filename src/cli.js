import { parseArgs } from 'node:util';
import { GLOBAL_OPTIONS, orderClause, joinQuery, outputMode, parseSets, readData, splitFields } from './args.js';
import { BIN, loadConfig, normalizeInstance, resolveContext, saveConfig } from './config.js';
import { CLIENT_ID, LoginRequired, finishLogin, getSession, openBrowser, promptCode, startLogin } from './auth.js';
import { deleteTokens, loadTokens, storeName } from './tokenstore.js';
import { request } from './http.js';
import { create, get, list, update } from './table.js';
import { printJSON, printRecord, printTable, printTotalNote } from './output.js';
import { currentUser } from './user.js';
import { recordCommands } from './records.js';

const log = (msg) => process.stderr.write(`${msg}\n`);

const HELP = `${BIN} — ServiceNow CLI with browser/SSO login (OAuth 2.0 authorization code + PKCE)

Usage: ${BIN} [-c CONTEXT] [-o table|json] <command> [args]

Setup
  context add NAME INSTANCE                          e.g. ${BIN} context add prod acme
  login [--print-url] [--code CODE] [--no-browser]   sign in through the browser (SSO/MFA as configured)

Auth
  logout                                             revoke + forget the stored token
  whoami                                             signed-in user, instance, token expiry
  token [--header]                                   print a live access token (for curl)

Contexts
  context [list] | current | use NAME | add NAME INSTANCE | remove NAME

Records
  incident|inc   list | get | create | update | comment
  change|chg     list | get | create | update | comment
  ritm           list | get | update | comment
  sctask|task    list | get | update | comment

Generic
  table list|get|create|update TABLE ...             any table via the Table API
  api METHOD PATH [-q k=v]... [-d JSON|@file|-]      raw REST call, JSON out

Context precedence: -c flag > SNOW_CONTEXT > current context.
Run "${BIN} <command> -h" for command flags.`;

const ctxOf = (opts) => resolveContext(loadConfig(), opts.context);

const fmtExpiry = (ms) => {
  const s = Math.round((ms - Date.now()) / 1000);
  return s <= 0 ? 'expired (refreshes on next call)' : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const commands = {
  login: {
    usage: `Usage: ${BIN} login [-c CONTEXT] [--no-browser]
       ${BIN} login [-c CONTEXT] --print-url      step 1: print authorize URL only
       ${BIN} login [-c CONTEXT] --code CODE      step 2: finish with the code from the browser

Opens the instance's OAuth consent page. Sign in the way the instance requires (SSO, MFA, ...).
The page /sdk-oauth.do then shows a one-time code; paste it back (the "CODE&state=..." form is fine).
OAuth client: ${CLIENT_ID} (override with SNOW_OAUTH_CLIENT_ID).`,
    options: { code: { type: 'string' }, 'print-url': { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
    async run(_, opts) {
      const ctx = ctxOf(opts);
      let code = opts.code;
      if (!code) {
        const url = startLogin(ctx);
        if (opts['print-url']) {
          process.stdout.write(url + '\n');
          log(`Open the URL, sign in, then run: ${BIN} login -c ${ctx.name} --code <CODE>`);
          return;
        }
        log(`Signing in to ${ctx.name} (${ctx.instance})`);
        if (opts['no-browser'] || !openBrowser(url)) log(`Open this URL in your browser:\n${url}`);
        else log(`Browser opened. If nothing appeared, open:\n${url}`);
        code = await promptCode();
        if (!code) throw new Error('no code entered');
      }
      await finishLogin(ctx, code);
      const user = await currentUser(ctx, { refresh: true });
      log(`Logged in to ${ctx.name} (${ctx.instance}) as ${user.name} <${user.user_name}>`);
    },
  },

  logout: {
    usage: `Usage: ${BIN} logout [-c CONTEXT]`,
    options: {},
    async run(_, opts) {
      const ctx = ctxOf(opts);
      const rec = loadTokens(ctx.name);
      if (rec?.refresh_token || rec?.access_token) {
        // Best effort server-side revoke; local removal happens regardless.
        await fetch(`${ctx.instance}/oauth_revoke_token.do`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, token: rec.refresh_token || rec.access_token }),
        }).catch(() => {});
      }
      deleteTokens(ctx.name);
      log(`Logged out of ${ctx.name}`);
    },
  },

  whoami: {
    usage: `Usage: ${BIN} whoami [-c CONTEXT] [-o json]`,
    options: {},
    async run(_, opts) {
      const ctx = ctxOf(opts);
      const user = await currentUser(ctx, { refresh: true });
      const session = await getSession(ctx);
      const info = {
        context: ctx.name,
        instance: ctx.instance,
        user_name: user.user_name,
        name: user.name,
        email: user.email,
        sys_id: user.sys_id,
        access_token_expires: fmtExpiry(session.expires_at),
        logged_in_at: new Date(session.logged_in_at).toISOString(),
        token_store: storeName(),
      };
      return outputMode(opts, 'table') === 'json' ? printJSON(info) : printRecord(info, { first: Object.keys(info) });
    },
  },

  token: {
    usage: `Usage: ${BIN} token [-c CONTEXT] [--header]
Prints a live access token to stdout (refreshing it first if needed). Treat it as a secret.
  curl -H "$(${BIN} token --header)" https://<instance>.service-now.com/api/now/table/incident?sysparm_limit=1`,
    options: { header: { type: 'boolean' } },
    async run(_, opts) {
      const session = await getSession(ctxOf(opts));
      process.stdout.write(`${opts.header ? 'Authorization: Bearer ' : ''}${session.access_token}\n`);
    },
  },

  context: {
    usage: `Usage: ${BIN} context [list]
       ${BIN} context current
       ${BIN} context use NAME
       ${BIN} context add NAME INSTANCE      INSTANCE: "acme", "acme.service-now.com" or a URL
       ${BIN} context remove NAME
The first context added becomes the current one.`,
    options: {},
    async run(_, opts, [sub = 'list', name, instance]) {
      const cfg = loadConfig();
      switch (sub) {
        case 'list': {
          const rows = Object.entries(cfg.contexts).map(([n, c]) => {
            const tok = loadTokens(n);
            return {
              current: n === cfg.current_context ? '*' : '',
              name: n,
              instance: normalizeInstance(c.instance),
              user: tok?.user?.user_name ?? (tok ? '(logged in)' : ''),
            };
          });
          if (!rows.length && outputMode(opts, 'table') === 'table') {
            log(`no contexts; run: ${BIN} context add NAME INSTANCE`);
            return;
          }
          return outputMode(opts, 'table') === 'json' ? printJSON(rows) : printTable(rows, ['current', 'name', 'instance', 'user']);
        }
        case 'current':
          process.stdout.write(`${resolveContext(cfg, opts.context).name}\n`);
          return;
        case 'use':
          if (!cfg.contexts[name]) throw new Error(`unknown context "${name}"`);
          cfg.current_context = name;
          saveConfig(cfg);
          log(`Current context: ${name}`);
          return;
        case 'add':
          if (!name || !instance) throw new Error(`usage: ${BIN} context add NAME INSTANCE`);
          cfg.contexts[name] = { instance: normalizeInstance(instance) };
          if (!cfg.current_context) cfg.current_context = name;
          saveConfig(cfg);
          log(`Added ${name} → ${cfg.contexts[name].instance}${cfg.current_context === name ? ' (current)' : ''}`);
          return;
        case 'remove':
          if (!cfg.contexts[name]) throw new Error(`unknown context "${name}"`);
          delete cfg.contexts[name];
          if (cfg.current_context === name) cfg.current_context = Object.keys(cfg.contexts)[0] ?? null;
          saveConfig(cfg);
          deleteTokens(name);
          log(`Removed ${name}`);
          return;
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.context.usage}`);
      }
    },
  },

  api: {
    usage: `Usage: ${BIN} api METHOD PATH [-q key=value]... [-d JSON|@file|-]
  ${BIN} api GET /api/now/table/sys_user_group -q sysparm_query=name=Service\\ Desk -q sysparm_fields=sys_id,name
  ${BIN} api POST /api/now/table/incident -d '{"short_description":"test"}'`,
    options: { query: { type: 'string', short: 'q', multiple: true }, data: { type: 'string', short: 'd' } },
    async run(_, opts, [method, path]) {
      if (!method || !path) throw new Error(commands.api.usage);
      const res = await request(ctxOf(opts), method.toUpperCase(), path, { query: parseSets(opts.query), body: readData(opts.data) });
      if (typeof res.data === 'string') process.stdout.write(res.data.endsWith('\n') ? res.data : `${res.data}\n`);
      else printJSON(res.data);
    },
  },

  table: {
    usage: `Usage:
  ${BIN} table list TABLE [-q QUERY] [-f FIELDS] [-l N] [--offset N] [--order [-]FIELD] [--raw]
  ${BIN} table get TABLE <sys_id|NUMBER> [-f FIELDS] [--all-fields] [--raw]
  ${BIN} table create TABLE [-s k=v]... [-d JSON]
  ${BIN} table update TABLE <sys_id|NUMBER> [-s k=v]... [-d JSON]
--raw returns stored values (sys_ids, choice values) instead of display values.`,
    options: {
      query: { type: 'string', short: 'q' },
      fields: { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string' },
      order: { type: 'string' },
      raw: { type: 'boolean' },
      'all-fields': { type: 'boolean' },
      set: { type: 'string', short: 's', multiple: true },
      data: { type: 'string', short: 'd' },
    },
    async run(_, opts, [sub, table, id]) {
      if (!sub || !table) throw new Error(commands.table.usage);
      const ctx = ctxOf(opts);
      const displayValue = !opts.raw;
      const fields = splitFields(opts.fields);
      const body = () => {
        const b = { ...(readData(opts.data) || {}), ...parseSets(opts.set) };
        if (!Object.keys(b).length) throw new Error('no fields given (-s k=v or -d JSON)');
        return b;
      };
      const show = (rec) => (outputMode(opts, 'table') === 'json' ? printJSON(rec) : printRecord(rec, { first: ['number', 'sys_id'], all: opts['all-fields'] }));
      switch (sub) {
        case 'list': {
          const query = joinQuery(opts.query, orderClause(opts.order));
          const { rows, total } = await list(ctx, table, { query, fields, limit: opts.limit ?? 20, offset: opts.offset, displayValue });
          if (outputMode(opts, 'table') === 'json') return printJSON(rows);
          printTable(rows, fields);
          printTotalNote(rows.length, total);
          return;
        }
        case 'get':
          if (!id) throw new Error(`usage: ${BIN} table get TABLE <sys_id|NUMBER>`);
          return show(await get(ctx, table, id, { fields, displayValue }));
        case 'create':
          return show(await create(ctx, table, body()));
        case 'update':
          if (!id) throw new Error(`usage: ${BIN} table update TABLE <sys_id|NUMBER> -s k=v`);
          return show(await update(ctx, table, id, body()));
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.table.usage}`);
      }
    },
  },

  ...recordCommands(),
};

export async function main(argv) {
  // Pass 1: find the command word (global flags may precede it).
  const first = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, strict: false });
  const name = first.positionals[0];
  if (!name) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (name === 'help') {
    const target = commands[first.positionals[1]];
    process.stdout.write((target ? target.usage : HELP) + '\n');
    return;
  }
  const cmd = commands[name];
  if (!cmd) throw new Error(`unknown command "${name}"; run: ${BIN} help`);

  // Pass 2: strict parse with the command's own options.
  const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...cmd.options }, allowPositionals: true, strict: true });
  if (values.help) {
    process.stdout.write(cmd.usage + '\n');
    return;
  }
  positionals.splice(positionals.indexOf(name), 1);
  await cmd.run(null, values, positionals);
}

export function handleError(err) {
  // Programming errors keep their stack; everything else (API, auth, usage, network) prints the message only.
  const network = err instanceof TypeError && err.message === 'fetch failed';
  const expected = network || !(err instanceof TypeError || err instanceof ReferenceError);
  const text = network ? `network error: ${err.cause?.code || err.cause?.message || 'fetch failed'}` : err?.message;
  const msg = process.env.SNOW_DEBUG || !expected ? err?.stack || String(err) : text;
  process.stderr.write(`${BIN}: ${msg}\n`);
  process.exitCode = 1;
}
