---
name: snow
description: Use for ServiceNow work through the `snow` CLI - incidents, changes, requests (RITM), catalog tasks (SCTASK), any table or REST call - plus SSO login, instance contexts, and "rows hidden by ACLs" or 403 permission errors.
metadata:
  short-description: ServiceNow CLI with browser/SSO login
  compatibility: claude-code, codex-cli, any .agents/skills-compatible agent
---

# ServiceNow via `snow`

`snow` talks to ServiceNow's REST Table API with an OAuth token obtained through the browser
(works with SSO and MFA). Run `snow <command> -h` for exact flags. If `snow` is missing:
`npm install -g @parnniti/snow`.

## Pick the instance first

- `snow context` lists configured instances (`*` = current, `user` = logged-in account).
- Pass `-c <context>` on every command unless the user named the current one. A wrong context is the
  most common cause of empty lists and 403s: the same account usually has roles on production but
  not on dev or test instances.
- No contexts yet: `snow context add <name> <instance>` (instance = `acme`, `acme.service-now.com`, or URL).

## Log in (agent-driven)

You cannot type into the interactive prompt, so use the two-step flow:

1. `url=$(snow -c <ctx> login --print-url 2>/dev/null) && open "$url"` (use `xdg-open` on Linux, or
   show the URL to the user).
2. Ask the user to sign in and paste the code that the `/sdk-oauth.do` page shows. The page shows
   `CODE&state=STATE`; the whole string is fine.
3. Within 10 minutes: `snow -c <ctx> login --code '<pasted>'`.
4. Confirm with `snow -c <ctx> whoami`. Tokens refresh automatically afterwards.

Never print, log, or store the output of `snow token`; it is a live bearer token.

## Read

To understand a ticket, start with `snow -c prod task get <NUMBER>` (or `ritm get`). It prints the
header (summary, state, requester), the main fields starting with **Short description** and
**Description**, the full request form (requester, department, every answer), attachments, and all
comments and work notes, including the parent request's. Images in comments and image attachments are
saved locally and printed as `file:///...png`. Open those files to see screenshots; they often hold the
error or evidence.

Read all of it before acting or reporting. On a catalog task the **Short description** and
**Description** are often written by whoever created the task, and they say what this particular task
must do, e.g. "Create key vault on env dev,sit,uat…" with a table of vaults and keys. That can be
narrower than, or different from, the request's summary ("Request to deploy ekyc service").

```bash
snow -c prod inc list                          # active, newest update first, 20 rows
snow -c prod inc list --mine                   # assigned to me
snow -c prod inc list --opened-by-me --all     # include closed
snow -c prod task list -q 'assignment_group=javascript:getMyGroups()'   # "assigned to my groups"
snow -c prod task list --long                  # full summary + details per task
snow -c prod chg list --group "Network" -l 50
snow -c prod ritm get <NUMBER>                 # any numbering scheme, or a 32-char sys_id
snow -c prod table list <table> -q '<encoded query>' -f field1,field2
snow -c prod api GET /api/now/<path> -q sysparm_limit=5
```

- Add `-o json` whenever you will parse the result.
- Reads return display values; `--raw` returns stored values (sys_ids, choice numbers).
- Filters use ServiceNow encoded queries. See [references/encoded-queries.md](references/encoded-queries.md).
- `ritm`/`sctask` lists show `summary` (the `summary` variable) and `details` (all multi-line answers on the
  request form). `short_description` is sometimes only the task template name ("Cloud access task") but
  often holds task-specific instructions, so always open the task with `get` before working on it.

Command map: `incident`/`inc` → incident, `change`/`chg` → change_request, `ritm` → sc_req_item,
`sctask`/`task` → sc_task. All have list (alias `ls`), get, update, comment, assign, state, attach,
attachments, detach, delete; incident and change also have create; all but incident have close
(incident: `resolve`).

## Write

Creating, updating, commenting, assigning, closing, approving and ordering change shared records
that other people see and that may notify requesters. Before any write:

1. Confirm the context (`-c`) and the exact record with the user.
2. Show the command and fields you will send and get an explicit go-ahead. For `catalog order`, run it
   with `--dry-run` first and show the payload.
3. `delete`, `detach` and `table delete` need `--yes`. Pass it only after the user confirmed that record.

```bash
snow -c prod task assign <NUMBER>                          # to me (or --to "Jane Doe", --group "Service Desk")
snow -c prod task state <NUMBER> "Work in Progress" -m "Started"
snow -c prod task close <NUMBER> -m "Done: <what was done>"  # Closed Complete (--as "Closed Incomplete")
snow -c prod inc resolve <NUMBER> --code "<close code label>" -m "<resolution notes>"
snow -c prod task comment <NUMBER> "Customer-visible comment"
snow -c prod task comment <NUMBER> "Internal note" --work-note
snow -c prod task attach <NUMBER> evidence.png report.pdf
snow -c prod task attachments <NUMBER> [--out DIR]
snow -c prod approval ls                                   # waiting on me
snow -c prod approval approve <NUMBER> -m "OK"            # reject needs -m REASON
snow -c prod catalog ls "<search>"; snow -c prod catalog get "<item name>"
snow -c prod catalog order "<item name>" -s var=value ... --dry-run
snow -c prod inc create -t "Short description" --description "..." --group "Service Desk" --urgency 2 --impact 2
snow -c prod table update <table> <sys_id> -d '{"field":"value"}'
```

- Reference and choice fields take display values (`--group "Service Desk"`, `-s state="Closed Complete"`).
  ServiceNow silently ignores values it cannot map. `state`, `assign`, `close` and `approve` then
  fail with "did not apply"; `create`/`update` print a warning. Fix the value to the exact label the form shows.
- `catalog order` checks mandatory variables and choice values first; the API itself does not. Reference
  variables take a name/email for users and groups, other tables need sys_ids. Copy them from an earlier
  request: `snow ritm get <SR> -o json` → `form[].raw`.

## Errors

| Message | Meaning | Action |
|---|---|---|
| `not logged in to "<ctx>"` / `refresh token rejected` | No or expired session | Run the login flow above |
| `(0 visible of N matching; rows hidden by ACLs)` | Records exist, account lacks read roles | Check `-c`; otherwise the user needs a role, not a CLI fix |
| `HTTP 403: Insufficient rights to query records: Field(s) present in the query do not have permission` | Account cannot read a field used in the filter/sort (often on an instance where it has no roles) | Check `-c`; drop the field from `-q`/`--order` |
| `HTTP 400: Invalid table` | Wrong table name | Check the name with `snow table list sys_db_object -q 'nameLIKE<x>' -f name,label` |
| `token request failed` during login | Instance blocks the SDK OAuth client | Admin registers a public PKCE client; set `SNOW_OAUTH_CLIENT_ID` |
