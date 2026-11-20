# Changelog

All notable changes to `@parnniti/snow`. Versions follow [semver](https://semver.org/); while the
version is 0.x, a minor bump may change output or defaults.

Upgrade with `snow update` (0.4.0 and later). From 0.1.0 or 0.2.0, which have no `update` command, run
`npm install -g @parnniti/snow@latest` once.

## 0.8.3 - 2026-11-20

### Changed
- `get` draws image attachments (PNG, JPEG, GIF, WebP) inline in the Attachments section, as the web
  form does. Before, they were only a link. Other files stay a link.
- Attachment links go on their own line and are URL-encoded, so names with spaces ("Screenshot … at
  10.25.07.png") stay clickable.
- Inline images reserve only their own height: only the limiting side (width or height) is sent, so no
  blank rows appear under wide screenshots.

## 0.8.2 - 2026-11-20

### Changed
- Inline images are bigger. They used to be capped at 72 columns × 18 rows; now they can use the window
  width less a 6-column margin (at most 120 columns) and up to 30 rows. Small images still keep their
  natural size.
- Request-form answers and descriptions keep pasted commands and JSON on one line too (0.8.1 only did this
  for comments).

## 0.8.1 - 2026-11-20

### Fixed
- Comment lines that look like commands, JSON or paths are no longer word-wrapped, so they paste
  correctly (for example `az rest … \` and `--body '{…}'`).
- The "Implement" state (changes) is coloured as in progress, not as finished.
- `sys_id` is labelled "Sys ID" (it was shown as "Sys").

## 0.8.0 - 2026-11-20

### Changed
- `get` is laid out for reading, like `gh issue view`:
  - a bold title (the summary) with the record number;
  - a status line: coloured state • requested by • opened/updated "3h ago" • number of updates;
  - the main fields with readable labels ("Assignment group", "Assigned to: unassigned").
- Long values wrap to the terminal (at most 120 columns) with a hanging indent, instead of running back to
  the left edge. Labels longer than 28 characters get their own line.
- Activity entries are separated by blank lines, each headed by a bold author, the entry type (comment in
  cyan, work note in yellow) and a dim "5m ago · time · via SR-…". ServiceNow's
  "SR-…'s comment :" prefix is dropped; "via" says where the comment came from.
- Inline comment images are drawn at their natural size, capped at 72 columns × 18 rows and never wider
  than the terminal. They used to fill the whole window. `SNOW_IMAGE_WIDTH` and `SNOW_IMAGE_HEIGHT`
  change the cap, and the `file://` link still opens the full-size image. This change was committed as
  0.7.4, which was never published.
- Colour only on a terminal; `NO_COLOR=1` turns it off (bold stays), `FORCE_COLOR=1` turns it on.

## 0.7.3 - 2026-11-20

### Changed
- Warp is detected (`TERM_PROGRAM=WarpTerminal`), so comment images in `get` are drawn inline there
  instead of only printed as `file://` links.

## 0.7.2 - 2026-11-20

### Changed
- Every table uses the 0.7.1 layout, not only record lists. That covers `approval ls` (the `what` column),
  `catalog ls` (item `name`, which you type into `catalog get`/`order`) and `table list`:
  `summary` / `short_description` / `what` / `name` stay wide, and `number`, `request_item`,
  `request`, `for` and `sys_id` are never cut.

## 0.7.1 - 2026-11-20

### Changed
- Lists that must shrink to fit the terminal now keep `summary` (or `short_description`) widest. Other
  columns give way first, down to 16 characters, and only then does the summary shrink. Summaries can
  run to 100 characters instead of 60.
- Record numbers (`number`, `request_item`, `request`) are never cut short.

## 0.7.0 - 2026-11-20

### Added
- Ticket work on every record type:
  - `assign` (to me, `--to NAME`, `--group NAME`) and `state NUM "<label>" [-m note]`.
  - `close` (`resolve` on incidents, with `--code` and `-m`; `--as` for another closed state).
  - `attach FILE...`, `attachments [--out DIR]`, `detach NAME --yes` and `delete --yes`.
- `snow approval ls | approve | reject`: approvals waiting on you (alias `approvals`).
- `snow catalog ls | get | order`: browse items, see their form, raise a request with variables
  (`--dry-run`, `--for USER`, `--force`).
- `table delete TABLE ID --yes`.
- `get` lists attachments (catalog tasks also show the request item's), and `-o json` adds the stored
  value of each form answer (`form[].raw`).

### Changed
- Writes check that ServiceNow applied what was sent, because it silently ignores labels and names it
  cannot map. `state`, `assign`, `close` and `approve` fail; `create` and `update` warn.
- `--order -field` works (it used to be read as an unknown flag), and argument errors print one line
  instead of a stack trace.

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
