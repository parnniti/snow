import { test } from 'node:test';
import assert from 'node:assert/strict';

const { unappliedFields } = await import('../src/table.js');
const { fileNameFromDisposition } = await import('../src/attachments.js');
const { buildOrder, flattenVariables } = await import('../src/catalog.js');

test('writes that ServiceNow silently ignored are detected; choice numbers and journals are not flagged', () => {
  const sent = { state: 'No Such State', assigned_to: 'Jane Doe', urgency: '2', work_notes: 'hi', short_description: 'Disk full' };
  const result = { state: 'Work in Progress', assigned_to: 'Jane Doe', urgency: '2 - High', work_notes: '', short_description: 'Disk full' };
  assert.deepEqual(unappliedFields(sent, result), [{ field: 'state', sent: 'No Such State', now: 'Work in Progress' }]);
  assert.deepEqual(unappliedFields({ state: 'closed complete' }, { state: 'Closed Complete' }), []);
});

test('attachment names come from Content-Disposition, including RFC 5987 encoding', () => {
  assert.equal(fileNameFromDisposition('attachment; filename="evidence 1.png"'), 'evidence 1.png');
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(fileNameFromDisposition('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(fileNameFromDisposition(null), '');
});

const ITEM = {
  name: 'Test Item',
  variables: flattenVariables([
    { type: 19, name: 'scope', label: 'Scope', children: [
      { type: 6, name: 'summary', label: 'Summary', mandatory: true },
      { type: 5, name: 'duration', label: 'Duration', mandatory: true, choices: [{ value: '', label: '-- None --' }, { value: 'permanent', label: 'Permanent' }, { value: 'temporary', label: 'Temporary' }] },
      { type: 7, name: 'copy', label: 'Copy?' },
      { type: 8, name: 'owner', label: 'Owner', reference: 'cmdb_ci' },
    ] },
    { type: 12, name: 'formatter', label: 'formatter' },
  ]),
};

test('catalog variables flatten without layout pieces and keep their section', () => {
  assert.deepEqual(ITEM.variables.map((v) => [v.name, v.section]), [['summary', 'Scope'], ['duration', 'Scope'], ['copy', 'Scope'], ['owner', 'Scope']]);
});

test('order payload maps choice labels and checkboxes, and blocks on bad input and missing mandatory answers', async () => {
  const ok = await buildOrder(null, ITEM, { summary: 'Need access', duration: 'Temporary', copy: 'yes', owner: 'a'.repeat(32) });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.variables, { summary: 'Need access', duration: 'temporary', copy: 'true', owner: 'a'.repeat(32) });

  const bad = await buildOrder(null, ITEM, { duration: 'forever', nope: 'x', owner: 'my server' });
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems.join('\n'), /unknown variable "nope"/);
  assert.match(bad.problems.join('\n'), /duration: "forever" is not one of/);
  assert.match(bad.problems.join('\n'), /owner: needs a cmdb_ci sys_id/);
  assert.match(bad.problems.join('\n'), /mandatory on the form: summary \(Summary\)/);

  assert.deepEqual((await buildOrder(null, ITEM, { duration: 'permanent' }, { force: true })).problems, []);
});
