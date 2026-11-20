import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ago, humanLabel, wrap } = await import('../src/style.js');

test('wrap keeps line breaks, wraps at word boundaries and never cuts a long URL', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
  const url = 'https://example.com/' + 'x'.repeat(40);
  assert.deepEqual(wrap(`see ${url} now`, 20), ['see', url, 'now']);
});

test('labels and relative times read like the UI', () => {
  assert.equal(humanLabel('assignment_group'), 'Assignment group');
  assert.equal(humanLabel('u_editable'), 'Editable');
  assert.equal(humanLabel('caller_id'), 'Caller');
  assert.equal(humanLabel('sys_id'), 'Sys ID');
  const now = new Date(2026, 10, 20, 15, 40, 0).getTime();
  assert.equal(ago('2026-11-20 15:37:18', now), '2m ago');
  assert.equal(ago('2026-11-19 16:32:22', now), '23h ago');
  assert.equal(ago('2026-11-01 09:00:00', now), '19d ago');
  assert.equal(ago('not a time', now), '');
});

test('commands and JSON are left whole; prose is wrapped', async () => {
  const { looksLikeCode } = await import('../src/style.js');
  assert.equal(looksLikeCode('az rest --method POST --url "https://graph.microsoft.com/v1.0/x" \\'), true);
  assert.equal(looksLikeCode(`--body '{"principalId":"f143","resourceId":"cc4f","appRoleId":"0000"}'`), true);
  assert.equal(looksLikeCode('I added user to the app registration, please try again.'), false);
  const { wrap } = await import('../src/style.js');
  const cmd = 'kubectl -n app rollout restart deploy/api --context aks-bkx-uat-sea-01 && kubectl get pods';
  assert.deepEqual(wrap(cmd, 30), [cmd]);
});

test('state colours: in-flight states (including Implement) differ from finished ones', async () => {
  process.env.FORCE_COLOR = '1';
  const { stateColor } = await import(`../src/style.js?force=${Date.now()}`);
  assert.match(stateColor('Implement'), /\x1b\[33m/); // yellow
  assert.match(stateColor('Closed Complete'), /\x1b\[35m/); // magenta
  assert.match(stateColor('Closed Incomplete'), /\x1b\[31m/); // red
});
