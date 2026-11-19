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
  request form). `short_description` there is only the task template name. Read `summary`/`details`
  (`--long` or `get` for full text) before reporting what a task is about.

Command map: `incident`/`inc` → incident, `change`/`chg` → change_request, `ritm` → sc_req_item,
`sctask`/`task` → sc_task. All have list (alias `ls`), get, update, comment; incident and change also have create.

## Write

Creating, updating, and commenting change shared records that other people see and that may notify
requesters. Before any write:

1. Confirm the context (`-c`) and the exact record with the user.
2. Show the fields you will send and get an explicit go-ahead.

```bash
snow -c prod inc create -t "Short description" --description "..." --group "Service Desk" --urgency 2 --impact 2
snow -c prod inc update <NUMBER> -s state=2 --assignee "Jane Doe"
snow -c prod task comment <NUMBER> "Customer-visible comment"
snow -c prod task comment <NUMBER> "Internal note" --work-note
snow -c prod table update <table> <sys_id> -d '{"field":"value"}'
```

- Reference fields take display names (`--group "Service Desk"`, `-s assigned_to="Jane Doe"`).
- Choice fields take stored values. Look them up instead of guessing:
  `snow -c prod table list sys_choice -q 'name=incident^element=state^inactive=false' -f value,label --raw`

## Errors

| Message | Meaning | Action |
|---|---|---|
| `not logged in to "<ctx>"` / `refresh token rejected` | No or expired session | Run the login flow above |
| `(0 visible of N matching; rows hidden by ACLs)` | Records exist, account lacks read roles | Check `-c`; otherwise the user needs a role, not a CLI fix |
| `HTTP 403: Insufficient rights to query records: Field(s) present in the query do not have permission` | Account cannot read a field used in the filter/sort (often on an instance where it has no roles) | Check `-c`; drop the field from `-q`/`--order` |
| `HTTP 400: Invalid table` | Wrong table name | Check the name with `snow table list sys_db_object -q 'nameLIKE<x>' -f name,label` |
| `token request failed` during login | Instance blocks the SDK OAuth client | Admin registers a public PKCE client; set `SNOW_OAUTH_CLIENT_ID` |
