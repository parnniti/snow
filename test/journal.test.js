import { test } from 'node:test';
import assert from 'node:assert/strict';

const { htmlToText, mergeJournal, parseJournal } = await import('../src/journal.js');

const JOURNAL = [
  '2026-11-19 16:58:36 - Jane Doe (Comments)',
  '[code]<p>Deploy <b>completed</b>.</p><p><img src="/94b7949b4568971049977959aa11e3ba.iix"></p>[/code]',
  '',
  '2026-11-18 08:16:32 - John Roe (Work notes)',
  'plain text note',
  'second line',
  '',
].join('\n');

test('journal display value splits into entries with images pulled out as markers', () => {
  const [a, b] = parseJournal(JOURNAL, 'SCTASK1');
  assert.deepEqual({ at: a.at, by: a.by, type: a.type, source: a.source }, { at: '2026-11-19 16:58:36', by: 'Jane Doe', type: 'Comments', source: 'SCTASK1' });
  assert.equal(a.text, 'Deploy completed.\n[image 1]');
  assert.deepEqual(a.images, ['/94b7949b4568971049977959aa11e3ba.iix']);
  assert.equal(b.text, 'plain text note\nsecond line');
  assert.deepEqual(b.images, []);
});

test('rich text: table rows stay on one line, links keep their URL, entities decode', () => {
  const html = '<table><tr><td><p>Env</p></td><td><p>BNI</p></td></tr><tr><td>E1</td><td>&#x2705;</td></tr></table><p><a href="https://x.test/pr/1">PR 1</a> &amp; more</p>';
  assert.equal(htmlToText(html), 'Env | BNI\n\nE1 | ✅\n\nPR 1 (https://x.test/pr/1) & more');
});

test('merge drops the copy ServiceNow posts on the parent request and sorts newest first', () => {
  const own = parseJournal('2026-11-19 10:00:00 - Jane (Comments)\nDone\n', 'SCTASK1');
  const parent = parseJournal("2026-11-19 10:00:00 - Jane (Comments)\nSCTASK1's comment : Done\n\n2026-11-19 11:00:00 - Bob (Comments)\nThanks\n", 'SR-1');
  const merged = mergeJournal(own, parent);
  assert.deepEqual(merged.map((e) => [e.by, e.source]), [['Bob', 'SR-1'], ['Jane', 'SCTASK1']]);
});

test('inline images keep natural size when small and fit a capped box when large', async () => {
  const { imageBox, imageSize } = await import('../src/images.js');
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1568, 16);
  png.writeUInt32BE(770, 20);
  assert.deepEqual(imageSize(png), { w: 1568, h: 770 });
  assert.deepEqual(imageBox({ w: 1568, h: 770 }, 160), { w: 72, h: 18 }); // big screenshot → capped
  assert.deepEqual(imageBox({ w: 300, h: 90 }, 160), { w: 34, h: 5 }); // small → natural, not upscaled
  assert.deepEqual(imageBox({ w: 1568, h: 770 }, 60), { w: 54, h: 18 }); // never wider than the terminal
  const gif = Buffer.from('GIF89a\x40\x01\xc8\x00rest', 'latin1');
  assert.deepEqual(imageSize(gif), { w: 320, h: 200 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
});
