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
  const now = new Date(2026, 10, 20, 15, 40, 0).getTime();
  assert.equal(ago('2026-11-20 15:37:18', now), '2m ago');
  assert.equal(ago('2026-11-19 16:32:22', now), '23h ago');
  assert.equal(ago('2026-11-01 09:00:00', now), '19d ago');
  assert.equal(ago('not a time', now), '');
});
