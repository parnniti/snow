import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GLOBAL_OPTIONS, orderClause, joinQuery, outputMode, parseSets, readData, splitFields } from './args.js';
import { BIN, loadConfig, normalizeInstance, resolveContext, saveConfig } from './config.js';
import { CLIENT_ID, LoginRequired, finishLogin, getSession, openBrowser, promptCode, startLogin } from './auth.js';
import { deleteTokens, loadTokens, storeName } from './tokenstore.js';
import { request } from './http.js';
import { create, get, list, remove, unappliedFields, update } from './table.js';
import { decide, findApproval, listApprovals } from './approvals.js';
import { buildOrder, getItem, orderNow, searchItems } from './catalog.js';
import { findOne } from './records.js';
import { printJSON, printRecord, printTable, printTotalNote } from './output.js';
import { currentUser } from './user.js';
import { recordCommands } from './records.js';
import { AGENTS, bundledSkills, destinations, installSkills, skillStatus, uninstallSkills } from './skills.js';
import { PKG, changelogSections, compareVersions, installKind, latestVersion, npmInstallGlobal } from './update.js';
import { spawnSync } from 'node:child_process';

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

Records (every type: list | get | update | comment | assign | state | attach | attachments | detach | delete)
  incident|inc   + create, resolve/close
  change|chg     + create, close
  ritm           + close
  sctask|task    + close

Approvals and catalog
  approval ls | approve NUM [-m TEXT] | reject NUM -m TEXT   approvals waiting on you (alias: approvals)
  catalog ls [SEARCH] | get ITEM | order ITEM -s var=value   browse items, raise a request

Generic
  table list|get|create|update|delete TABLE ...      any table via the Table API
  api METHOD PATH [-q k=v]... [-d JSON|@file|-]      raw REST call, JSON out

Agents
  skills [list] | get NAME | install [NAME...] | uninstall [NAME...]
                                                     install the bundled agent skill (~/.agents/skills)
  update [--check]                                   upgrade ${BIN} from npm and refresh installed skills (alias: upgrade)
  version                                            print the installed version
  changelog [VERSION] [--since VERSION]              what changed in each release

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
  ${BIN} table delete TABLE <sys_id|NUMBER> --yes
--raw returns stored values (sys_ids, choice values) instead of display values.
Writes take display values for reference and choice fields and warn when ServiceNow ignored one.`,
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
      yes: { type: 'boolean', short: 'y' },
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
        case 'create': {
          const sent = body();
          const rec = await create(ctx, table, sent);
          for (const u of unappliedFields(sent, rec)) log(`warning: ${u.field} is "${u.now}" after the write (sent "${u.sent}"); ServiceNow did not apply it`);
          return show(rec);
        }
        case 'update': {
          if (!id) throw new Error(`usage: ${BIN} table update TABLE <sys_id|NUMBER> -s k=v`);
          const sent = body();
          const rec = await update(ctx, table, id, sent);
          for (const u of unappliedFields(sent, rec)) log(`warning: ${u.field} is "${u.now}" after the write (sent "${u.sent}"); ServiceNow did not apply it`);
          return show(rec);
        }
        case 'delete':
          if (!id) throw new Error(`usage: ${BIN} table delete TABLE <sys_id|NUMBER> --yes`);
          if (!opts.yes) throw new Error(`this permanently deletes ${id} from ${table}; re-run with --yes`);
          log(`deleted ${id} from ${table} (${await remove(ctx, table, id)})`);
          return;
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.table.usage}`);
      }
    },
  },

  update: {
    usage: `Usage: ${BIN} update [--check]
Checks npm for a newer ${PKG.name}, runs "npm install -g ${PKG.name}@<latest>", then re-runs
"${BIN} skills install" for skills you already installed (same agents), so they match the new version.
--check only reports whether an update exists (exit 0 either way).
Copies installed with npm link or from a git checkout are not touched: update those with git pull.`,
    options: { check: { type: 'boolean' } },
    async run(_, opts) {
      const current = PKG.version;
      const latest = await latestVersion();
      if (compareVersions(latest, current) <= 0) {
        log(`${BIN} ${current} is up to date.`);
        return;
      }
      log(`${BIN} ${current} → ${latest} available.`);
      if (opts.check) return;
      const where = installKind();
      if (where.kind !== 'global') {
        throw new Error(
          `this copy is not a global npm install (${where.kind}: ${where.root}); ` +
            (where.kind === 'git' ? 'run git pull there' : `run: npm install -g ${PKG.name}@latest`),
        );
      }
      // Remember which skills (and agent links) were installed before the files change under us.
      const dests = destinations();
      const installed = bundledSkills()
        .map((s) => ({ name: s.name, st: skillStatus(s, dests) }))
        .filter((x) => x.st.canonical === 'installed' || x.st.canonical === 'outdated');
      npmInstallGlobal(latest);
      if (installed.length) {
        const agents = [...new Set(installed.flatMap((x) => Object.entries(x.st.agents).filter(([, v]) => v === 'linked').map(([a]) => a)))];
        // Run the NEW code: same bin path, now pointing at the upgraded package.
        const args = [process.argv[1], 'skills', 'install', ...installed.map((x) => x.name), ...agents.flatMap((a) => ['--agent', a])];
        const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
        if (r.status !== 0) log(`skills refresh failed; run: ${BIN} skills install`);
      }
      log(`Updated ${BIN} to ${latest}. What changed:\n`);
      // The NEW package's changelog, limited to versions after the one we came from.
      spawnSync(process.execPath, [process.argv[1], 'changelog', '--since', current], { stdio: 'inherit' });
    },
  },

  version: {
    usage: `Usage: ${BIN} version`,
    options: {},
    async run() {
      process.stdout.write(`${PKG.version}\n`);
    },
  },

  changelog: {
    usage: `Usage: ${BIN} changelog                  every release, newest first
       ${BIN} changelog VERSION          one release, e.g. ${BIN} changelog 0.4.0
       ${BIN} changelog --since VERSION  releases newer than VERSION (what ${BIN} update prints)
Reads the CHANGELOG.md shipped with the installed ${BIN}.`,
    options: { since: { type: 'string' } },
    async run(_, opts, [version]) {
      let sections = changelogSections();
      if (version) {
        sections = sections.filter((s) => s.version === version.replace(/^v/, ''));
        if (!sections.length) throw new Error(`no changelog entry for ${version} (have: ${changelogSections().map((s) => s.version).join(', ')})`);
      }
      if (opts.since) sections = sections.filter((s) => compareVersions(s.version, opts.since.replace(/^v/, '')) > 0);
      if (outputMode(opts, 'table') === 'json') return printJSON(sections);
      if (!sections.length) {
        log(`no changes after ${opts.since}`);
        return;
      }
      process.stdout.write(sections.map((s) => `${s.title}\n\n${s.body}`).join('\n\n') + '\n');
    },
  },

  skills: {
    usage: `Usage: ${BIN} skills [list]                       bundled skills and where they are installed
       ${BIN} skills get NAME [FILE]              print a skill (or one of its files) without installing
       ${BIN} skills install [NAME...] [--agent claude] [--all-agents] [--local] [--dir DIR] [--force] [--dry-run]
       ${BIN} skills uninstall [NAME...] [--local] [--dir DIR] [--dry-run]

install copies skills to ~/.agents/skills/<name> (Codex, Cursor, Gemini, Copilot and other
.agents-compatible agents). --agent claude also links ~/.claude/skills/<name> (Claude Code).
--local uses ./.agents/skills and ./.claude/skills in the current project; --dir sets the .agents root.
Re-run install after upgrading ${BIN} to refresh the copies. Directories ${BIN} did not install are
left alone unless --force. No NAME means every bundled skill.`,
    options: {
      agent: { type: 'string', multiple: true },
      'all-agents': { type: 'boolean' },
      local: { type: 'boolean' },
      dir: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    async run(_, opts, [sub = 'list', ...names]) {
      const all = bundledSkills();
      const dests = destinations({ local: opts.local, dir: opts.dir });
      const pick = (list) => {
        if (!list.length) return all;
        return list.map((n) => {
          const s = all.find((x) => x.name === n);
          if (!s) throw new Error(`no bundled skill "${n}" (have: ${all.map((x) => x.name).join(', ')})`);
          return s;
        });
      };
      const report = (results) => {
        if (outputMode(opts, 'table') === 'json') return printJSON(results);
        printTable(results, ['action', 'skill', 'path']);
        if (results.some((r) => r.action === 'skipped-foreign')) {
          log(`Some paths exist but were not installed by ${BIN}; left untouched. Use --force to replace them.`);
          process.exitCode = 1;
        }
      };
      switch (sub) {
        case 'list': {
          const rows = all.map((s) => {
            const st = skillStatus(s, dests);
            return { name: s.name, canonical: st.canonical, ...st.agents, path: path.join(dests.canonical, s.name), description: s.description };
          });
          return outputMode(opts, 'table') === 'json' ? printJSON(rows) : printTable(rows, ['name', 'canonical', ...AGENTS, 'path']);
        }
        case 'get': {
          if (!names[0]) throw new Error(`usage: ${BIN} skills get NAME [FILE]`);
          const [skill] = pick(names.slice(0, 1));
          const file = path.resolve(skill.dir, names[1] ?? 'SKILL.md');
          if (!file.startsWith(skill.dir + path.sep)) throw new Error('FILE must be inside the skill directory');
          process.stdout.write(fs.readFileSync(file, 'utf8'));
          return;
        }
        case 'install': {
          const agents = opts['all-agents'] ? AGENTS : [...new Set(opts.agent ?? [])];
          const bad = agents.filter((a) => !AGENTS.includes(a));
          if (bad.length) throw new Error(`unsupported --agent ${bad.join(', ')} (supported: ${AGENTS.join(', ')}; ~/.agents/skills covers the rest)`);
          return report(installSkills(pick(names), { dests, agents, force: opts.force, dryRun: opts['dry-run'] }));
        }
        case 'uninstall':
          return report(uninstallSkills(pick(names), { dests, dryRun: opts['dry-run'] }));
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.skills.usage}`);
      }
    },
  },

  approval: {
    usage: `Usage: ${BIN} approval ls [--all] [-l N]              approvals waiting on you (--all: every state)
       ${BIN} approval approve <NUMBER|approval sys_id> [-m COMMENT]
       ${BIN} approval reject  <NUMBER|approval sys_id> -m REASON
NUMBER is the record being approved (SR-..., CHG..., REQ...). Alias: approvals.`,
    options: { all: { type: 'boolean' }, limit: { type: 'string', short: 'l' }, message: { type: 'string', short: 'm' } },
    async run(_, opts, [sub = 'list', ref]) {
      const ctx = ctxOf(opts);
      const me = await currentUser(ctx);
      switch (sub) {
        case 'list': {
          const rows = await listApprovals(ctx, me, { all: opts.all, limit: opts.limit ?? 50 });
          if (outputMode(opts, 'table') === 'json') return printJSON(rows);
          if (!rows.length) return log(opts.all ? 'no approvals' : 'nothing waiting on you');
          return printTable(rows, ['for', 'what', 'state', 'requested', 'due']);
        }
        case 'approve':
        case 'reject': {
          if (!ref) throw new Error(commands.approval.usage);
          if (sub === 'reject' && !opts.message) throw new Error('reject needs -m REASON');
          const approval = await findApproval(ctx, me, ref);
          const rec = await decide(ctx, approval, sub === 'approve' ? 'approved' : 'rejected', opts.message);
          log(`${approval.sysapproval}: ${rec.state}`);
          return outputMode(opts, 'table') === 'json' ? printJSON(rec) : undefined;
        }
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.approval.usage}`);
      }
    },
  },

  catalog: {
    usage: `Usage: ${BIN} catalog ls [SEARCH] [-l N]                   find catalog items
       ${BIN} catalog get ITEM                            the item's form: variables, types, mandatory, choices
       ${BIN} catalog order ITEM [-s var=value]... [-d JSON] [--for USER] [--dry-run] [--force]
ITEM is the item name (exact) or sys_id. Values: select boxes take the value or the label; user and
group references take a name/email (other references need a sys_id); list collectors take a comma list.
order checks mandatory variables first (the API does not); --force orders anyway. --dry-run prints the
payload without ordering. --for orders on behalf of USER (name, user name or email).`,
    options: {
      limit: { type: 'string', short: 'l' },
      set: { type: 'string', short: 's', multiple: true },
      data: { type: 'string', short: 'd' },
      for: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
    },
    async run(_, opts, [sub = 'list', ...rest]) {
      const ctx = ctxOf(opts);
      const ref = rest.join(' ');
      switch (sub) {
        case 'list': {
          const rows = await searchItems(ctx, ref, opts.limit ?? 20);
          return outputMode(opts, 'table') === 'json' ? printJSON(rows) : printTable(rows, ['name', 'category', 'short_description', 'sys_id']);
        }
        case 'get': {
          if (!ref) throw new Error(`usage: ${BIN} catalog get ITEM`);
          const item = await getItem(ctx, ref);
          if (outputMode(opts, 'table') === 'json') return printJSON(item);
          process.stdout.write(`${item.name}  (${item.category}, ${item.sys_id})\n${item.short_description || ''}\n\n`);
          const rows = item.variables.map((v) => ({
            name: v.name,
            label: v.label,
            type: v.reference ? `${v.type} → ${v.reference}` : v.type,
            req: v.mandatory ? 'yes' : '',
            choices: v.choices.map((c) => (c.value === c.label ? c.value : `${c.value}=${c.label}`)).join(', '),
          }));
          return printTable(rows, ['name', 'label', 'type', 'req', 'choices']);
        }
        case 'order': {
          if (!ref) throw new Error(`usage: ${BIN} catalog order ITEM -s var=value ...`);
          const item = await getItem(ctx, ref);
          const input = { ...(readData(opts.data) || {}), ...parseSets(opts.set) };
          const { variables, problems } = await buildOrder(ctx, item, input, { force: opts.force });
          if (problems.length) throw new Error(`not ordered:\n  - ${problems.join('\n  - ')}`);
          const requestedFor = opts.for ? (await findOne(ctx, 'sys_user', opts.for, ['name', 'user_name', 'email'])).sys_id : undefined;
          if (opts['dry-run']) return printJSON({ item: item.name, item_sys_id: item.sys_id, requested_for: requestedFor, variables });
          const res = await orderNow(ctx, item, variables, { requestedFor });
          if (outputMode(opts, 'table') === 'json') return printJSON(res);
          log(`ordered ${item.name}: ${res.request_number}${res.items.length ? ` → ${res.items.map((i) => i.number).join(', ')}` : ''}`);
          return;
        }
        default:
          throw new Error(`unknown subcommand "${sub}"\n\n${commands.catalog.usage}`);
      }
    },
  },

  ...recordCommands(),
};
commands.upgrade = commands.update;
commands.approvals = commands.approval;

export async function main(argv) {
  // `--order -sys_updated_on` would be read as a flag; glue a dash-leading value to its option.
  argv = argv.flatMap((a, i) => (a === '--order' && /^-[a-z]/i.test(argv[i + 1] ?? '') ? [] : i > 0 && argv[i - 1] === '--order' && /^-[a-z]/i.test(a) ? [`--order=${a}`] : [a]));
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
  if (name !== 'api' && positionals[0] === 'ls') positionals[0] = 'list'; // `snow inc ls`, `snow context ls`, ...
  await cmd.run(null, values, positionals);
}

export function handleError(err) {
  // Programming errors keep their stack; everything else (API, auth, usage, network) prints the message only.
  const network = err instanceof TypeError && err.message === 'fetch failed';
  const usage = String(err?.code ?? '').startsWith('ERR_PARSE_ARGS');
  const expected = network || usage || !(err instanceof TypeError || err instanceof ReferenceError);
  const text = network ? `network error: ${err.cause?.code || err.cause?.message || 'fetch failed'}` : err?.message;
  const msg = process.env.SNOW_DEBUG || !expected ? err?.stack || String(err) : text;
  process.stderr.write(`${BIN}: ${msg}\n`);
  process.exitCode = 1;
}
