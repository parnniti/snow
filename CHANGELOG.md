# Changelog

All notable changes to `@parnniti/snow`. Versions follow [semver](https://semver.org/); while the
version is 0.x, a minor bump may change output or defaults.

Upgrade with `snow update` (0.4.0 and later). From 0.1.0 or 0.2.0, which have no `update` command, run
`npm install -g @parnniti/snow@latest` once.

## 0.6.0 - 2026-11-20

### Added
- `snow changelog` prints this changelog. `snow changelog 0.4.0` prints one release, and
  `--since VERSION` prints the releases after VERSION. `-o json` gives the sections as data.
- After upgrading, `snow update` prints what changed since the version you had.

## 0.5.0 - 2026-11-20

### Added
- `sctask` lists show a `requester` column (the request item's Requested for). `task get` shows it in the
  main fields too. Pick it with `-f requester` like any other column.
- This changelog, shipped in the package.

## 0.4.0 - 2026-11-20

### Added
- `ritm get` / `sctask get` show the **request form** as the portal does: every answered question in form
  order, with references shown by name (requester, email, department, line manager, ...).
- `get` shows **Activity** for every record type: comments and work notes, newest first, from the record
  and, for catalog tasks, its request item. Rich text becomes plain text: table rows stay on one line and
  links keep their URL. ServiceNow's copies of task comments on the parent request are dropped.
- **Images in comments** are downloaded once to `~/.cache/snow/images/` (`SNOW_CACHE_DIR` moves the cache)
  and printed as `[image N] file://...` where they appear. iTerm2, WezTerm, kitty and Ghostty draw them
  inline; `SNOW_IMAGES=iterm|kitty|none` forces a protocol and `--no-images` skips the download.
- `-o json` on `get` adds `form` and `activity` arrays. Each image entry carries its local `path`.

### Changed
- The default `get` view shows the main fields only. `--all-fields` brings back every field (`sys_*` and the rest).

## 0.3.0 - never published

The npm publish failed after the browser approval expired. Its changes shipped in 0.4.0:
- `snow update` (alias `upgrade`) installs the latest version from npm and re-installs the agent skills you
  already have, with the same agent links. `--check` only reports. Git checkouts and `npm link` copies are
  refused with a `git pull` hint.
- `snow version`.

## 0.2.0 - 2026-11-20

### Added
- `ritm` and `sctask` lists show `summary` (the form's Summary field, falling back to `short_description`)
  and `details` (every multi-line answer on the request form, whatever the catalog item calls it).
  `SNOW_SUMMARY_VARIABLES` picks other summary field names.
- `--long` on lists prints one block per record, with summary, details and description in full.
- `ls` works wherever `list` does (`snow task ls`, `snow context ls`, ...).

### Changed
- Tables shrink their widest columns to fit the terminal instead of wrapping.

## 0.1.0 - 2026-11-18

First release.
- Browser/SSO login (OAuth 2.0 authorization code + PKCE) through the public ServiceNow SDK client, so no
  admin setup or client secret is needed. `SNOW_OAUTH_CLIENT_ID` points it at your own client.
  Tokens live in the macOS keychain (or a 0600 file), refresh automatically, and `logout` revokes them.
- Named contexts for several instances.
- `incident`, `change`, `ritm` and `sctask` commands: list, get, create (incident and change only), update
  and comment.
- `table` and `api` for generic access, with table or JSON output.
- A bundled agent skill, managed with `snow skills list|get|install|uninstall` (`--agent claude` links it
  into Claude Code).
