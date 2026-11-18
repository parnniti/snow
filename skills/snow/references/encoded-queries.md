# ServiceNow encoded queries (for `snow ... -q`)

Conditions are joined with `^` (AND). Field names are column names, not labels. Use `--raw` with
`table list` to see stored values when building a filter.

| Want | Encoded query |
|---|---|
| equals / not equals | `state=2` / `state!=7` |
| contains / starts with | `short_descriptionLIKEvpn` / `numberSTARTSWITHINC` |
| one of | `priorityIN1,2` |
| empty / not empty | `assigned_toISEMPTY` / `assigned_toISNOTEMPTY` |
| comparison | `priority<=2`, `sys_updated_on>=2026-01-01 00:00:00` |
| OR (same group) | `priority=1^ORpriority=2` |
| new OR group | `active=true^NQnumber=INC0010001` |
| dot-walk a reference | `assignment_group.name=Service Desk`, `caller_id.department.name=IT` |
| me | `assigned_to=javascript:gs.getUserID()` |
| my groups | `assignment_group=javascript:getMyGroups()` |
| today / last 7 days | `sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()` / `sys_created_on>=javascript:gs.daysAgoStart(7)` |
| sort | `ORDERBYnumber`, `ORDERBYDESCsys_updated_on` (or use `--order -sys_updated_on`) |

Notes:

- Record commands (`inc`, `chg`, `ritm`, `task`) already add `active=true` (unless `--all`) and sort by
  newest update (unless `--order`); `-q` is appended to that.
- Quote the whole query in single quotes so the shell leaves `^`, `<`, `>` and spaces alone.
- An easy way to get a correct query: build the filter in the ServiceNow list view, right-click the
  breadcrumb, choose "Copy query", and pass it to `-q`.
