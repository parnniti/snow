# snow

A small ServiceNow CLI that logs in through your browser, so it works with SSO (SAML/OIDC) and MFA.
You don't need a password, an admin-created OAuth app, or a client secret. It has no dependencies and needs Node ≥ 20.18.

```bash
npm install -g @parnniti/snow   # installs the `snow` command
snow context add prod acme      # → https://acme.service-now.com
snow login
snow inc list --mine
```

## How login works

`snow login` uses OAuth 2.0 authorization code + PKCE with the public OAuth client that ServiceNow ships
on instances for the [ServiceNow SDK](https://servicenow.github.io/sdk/). It is the same client and redirect
that `now-sdk auth --type oauth` uses: `client_id 543e5655f77746a28228c6009a599dfb`, redirect `/sdk-oauth.do`.

1. Your browser opens the instance's consent page. Sign in the way the instance normally asks: SSO, MFA or a local login.
2. The `/sdk-oauth.do` page shows a one-time code. Paste it into the terminal. You can paste the bare code,
   the `CODE&state=…` string the page shows, or the full URL.
3. The tokens are stored and the access token refreshes automatically. When the refresh token
   expires, run `snow login` again.

For scripts or agents that can't type into a prompt: run `snow login --print-url`, open the URL, then run
`snow login --code '<pasted>'` within 10 minutes.

**If login fails with an OAuth error,** the instance may have disabled or restricted the SDK client. Ask an
admin to register a public OAuth client (Application Registry → "Create an OAuth API endpoint for external
clients", PKCE, no secret). Then point `snow` at it:

```bash
export SNOW_OAUTH_CLIENT_ID=<client_id>
export SNOW_OAUTH_REDIRECT_URI=<redirect registered on the client>   # default /sdk-oauth.do
```

To check whether an instance accepts the SDK client, run the command below. A 302 means the client is
registered; a 401 means it is not.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://acme.service-now.com/oauth_auth.do?response_type=code&client_id=543e5655f77746a28228c6009a599dfb&redirect_uri=%2Fsdk-oauth.do'
```

### Where tokens live

- **macOS:** the login keychain, service `snow-cli`, with the context name as the account. The secret is passed
  to `security` on stdin, never on the command line.
- **Elsewhere, or with `SNOW_TOKEN_STORE=file`:** `~/.config/snow/tokens/<context>.json`, file mode 0600.

`snow logout` revokes the token on the instance (best effort) and deletes it locally.

## Contexts

```bash
snow context add dev acmedev     # the first context added becomes current
snow context add prod acme
snow context                     # list; * = current, user = logged-in account
snow context use prod
snow -c dev inc list             # per-command override (or SNOW_CONTEXT=dev)
```

The instance can be given as `acme`, `acme.service-now.com`, or a full URL for custom domains.
The config file is `~/.config/snow/config.json`; set `SNOW_CONFIG_DIR` to use another directory.

## Records

| command | table | subcommands |
|---|---|---|
| `incident` / `inc` | `incident` | list, get, create, update, comment |
| `change` / `chg` | `change_request` | list, get, create, update, comment |
| `ritm` | `sc_req_item` | list, get, update, comment |
| `sctask` / `task` | `sc_task` | list, get, update, comment |

```bash
snow inc list                                # active records, newest update first, 20 rows
snow inc list --mine                         # assigned to me
snow inc list --opened-by-me --all           # include inactive records
snow inc list --group "Service Desk" -q 'priority<=2' -l 50
snow inc get INC0010001                      # main fields + comments/work notes (--all-fields for everything)
snow task get SCTASK0010385                  # + the request form (requester, every answered question) and activity
snow inc create -t "VPN down for site B" --description "..." --group "Network" --urgency 2 --impact 2
snow inc update INC0010001 -s state=2 --assignee "Jane Doe"
snow inc comment INC0010001 "Mitigated; monitoring"          # customer-visible comment
snow inc comment INC0010001 "Root cause: ..." --work-note    # internal work note
snow chg create -t "Patch DB cluster" --type normal --start "2026-12-01 22:00:00" --end "2026-12-01 23:00:00"
snow task ls                                 # `ls` works wherever `list` does
snow task list --long                        # one block per task, summary and details in full
```

- **`ritm` and `sctask`** show `summary` and `details` columns taken from the request's catalog variables,
  because `short_description` on catalog tasks is usually just the template name ("Cloud access task").
  - `summary`: the `summary` variable, else `short_description`. Use other names with
    `SNOW_SUMMARY_VARIABLES` (comma-separated, first non-empty wins).
  - `details`: every non-empty multi-line text answer on the request form, in form order and labelled
    by question when there is more than one. Each catalog item names its fields differently, so `snow`
    picks them by type. This costs one extra API call per page.
- Tables shrink their widest columns to fit the terminal; use `--long` or `get` to read long text in full.
- **`get`** shows the main fields, then for `ritm`/`sctask` the **request form** as the portal shows it
  (every answered question, references shown by name), then **Activity**: comments and work notes of the
  record and its request item, newest first, rich text turned into plain text. `-o json` adds `form` and
  `activity` arrays.
- **Images** pasted into comments are downloaded once to `~/.cache/snow/images/` (`SNOW_CACHE_DIR` moves it)
  and listed as `file://` paths. iTerm2, WezTerm, Warp, kitty and Ghostty also draw them inline. For other
  terminals that support the iTerm2 or kitty image protocol, set `SNOW_IMAGES=iterm` or `kitty`.
  `--no-images` skips the download.
- **Reads** return display values. Add `--raw` to get stored values (sys_ids, choice numbers) instead.
- **Writes** send `sysparm_input_display_value=true`, so reference fields take names:
  `--group "Service Desk"`, `-s assigned_to="Jane Doe"`. Choice fields take their stored value, e.g. `-s state=2`.
- **Lookup** takes a record number in any numbering format, or a 32-character sys_id.
- Add `-o json` to any command for machine-readable output.

## Working tickets

```bash
snow task assign SCTASK0010368                          # to me; --to "Jane Doe" / --group "Service Desk"
snow task state SCTASK0010368 "Work in Progress" -m "Started"
snow task close SCTASK0010368 -m "Done"                 # Closed Complete; --as "Closed Incomplete"
snow inc resolve INC0010001 --code "Solved (Permanently)" -m "Restarted the pod"
snow chg close CHG0030001 --code "Successful" -m "Implemented as planned"
snow task attach SCTASK0010368 evidence.png logs.txt    # upload files
snow task attachments SCTASK0010368 --out ./evidence    # list, download
snow task detach SCTASK0010368 logs.txt --yes
snow inc delete INC0010001 --yes
```

- **Labels work:** `state`, `close`, `assign` and `-s field=value` take what the form shows ("Work in
  Progress", "Jane Doe"). ServiceNow silently ignores a value it cannot map, so `snow` compares the
  result with what it sent. `state`/`assign`/`close` fail with "did not apply"; `create`/`update` warn.
- **People and groups** are looked up first and must match exactly one active record, so a write never
  lands on the wrong "John Smith".
- **`delete`, `detach` and `table delete`** refuse to run without `--yes`.
- **Attachments:** downloads are cached in `~/.cache/snow/attachments/`. `get` lists a record's
  attachments (for catalog tasks, also the request item's).

## Approvals

```bash
snow approval ls                                  # waiting on you (--all for every state)
snow approval approve SR-20261119-024 -m "OK"
snow approval reject CHG0030001 -m "Missing backout plan"
```

## Service Catalog

```bash
snow catalog ls cloud                             # find items
snow catalog get "Cloud Access"                   # the form: variables, types, mandatory, choices
snow catalog order "Cloud Access" -s summary="Read access to X" -s duration=Permanent ... --dry-run
snow catalog order "Cloud Access" ... [--for "jane.doe@example.com"]
```

- **Checks before ordering:** `order` checks mandatory variables and choice values first, because the
  catalog API accepts incomplete orders. `--force` orders anyway, for fields that are only mandatory in
  some cases. `--dry-run` prints the payload without ordering.
- **Values:** select boxes take a value or a label. User and group references take a name or email.
  Other references and list collectors need sys_ids. Copy them from an earlier request with
  `snow ritm get SR-... -o json` (`form[].raw`).

## Generic access

```bash
snow table list sys_user_group -q 'nameLIKEnetwork' -f name,manager
snow table get sys_user <sys_id> --all-fields
snow table update u_custom_table <sys_id> -d @patch.json
snow api GET /api/now/table/sys_user_group -q sysparm_fields=sys_id,name -q sysparm_limit=5
snow api POST /api/now/table/incident -d '{"short_description":"test"}'
curl -H "$(snow token --header)" 'https://acme.service-now.com/api/now/table/incident?sysparm_limit=1'
```

`snow api` and `snow table` refuse to send the token to any host other than the context's instance.

## Agent skills

`snow` ships an agent skill, so coding agents know how to use it: the agent login flow, picking the
context, queries, rules for writes, and what the errors mean.

```bash
snow skills                          # bundled skills and where they are installed
snow skills install                  # → ~/.agents/skills/snow (Codex, Cursor, Gemini, Copilot, ...)
snow skills install --agent claude   # also link ~/.claude/skills/snow (Claude Code)
snow skills install --local          # this project only: ./.agents/skills, ./.claude/skills
snow skills get snow                 # print it without installing
snow skills uninstall
```

`snow update` refreshes the installed copy for you. After a manual upgrade, re-run `snow skills install`. A directory with the same name
that `snow` did not install is left untouched unless you pass `--force`.

The skill also lives in the repo at `skills/snow/`, so `npx skills add parnniti/snow` works too.

## Updating

```bash
snow update           # install the latest @parnniti/snow from npm, then refresh installed agent skills
snow update --check   # only report whether a newer version exists
snow version
```

`snow update` only works for global npm installs. For a git checkout or `npm link`, run `git pull` instead.
From 0.1.0 or 0.2.0, which have no `update` command, run `npm install -g @parnniti/snow@latest` once.
[CHANGELOG.md](CHANGELOG.md) lists what changed in each version. `snow changelog` prints it (`snow changelog 0.4.0`
for one release, `--since VERSION` for everything newer), and `snow update` prints the new entries after upgrading.

## Notes

- Results follow your ServiceNow roles and ACLs. `(0 visible of N matching; rows hidden by ACLs)` means
  the records exist but your account can't read them.
- `SNOW_DEBUG=1` prints stack traces.
- Run `npm test` to execute the unit tests (Node's built-in test runner).

## License

MIT
