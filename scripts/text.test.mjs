import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs'; import vm from 'node:vm';
const ctx = {}; ctx.window = ctx; vm.runInNewContext(readFileSync(new URL('../public/js/text.js', import.meta.url), 'utf8'), ctx);
const { titleCase, sentenceCase, emphasizeCollocation } = ctx.UW_TEXT;
const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
test('titleCase', () => {
  assert.equal(titleCase('society & culture'), 'Society & Culture');
  assert.equal(titleCase('agreement / addition / similarity'), 'Agreement / Addition / Similarity');
  assert.equal(titleCase('time / chronology / sequence'), 'Time / Chronology / Sequence');
  assert.equal(titleCase('work'), 'Work');
  assert.equal(titleCase('cause of the problem'), 'Cause of the Problem');
});
test('sentenceCase', () => {
  assert.equal(sentenceCase('terms for ecological systems'), 'Terms for ecological systems');
  assert.equal(sentenceCase(''), '');
});
test('emphasizeCollocation', () => {
  assert.equal(emphasizeCollocation('protect biodiversity','biodiversity',esc), '<b>protect</b> biodiversity');
  assert.equal(emphasizeCollocation('loss of biodiversity','biodiversity',esc), '<b>loss of</b> biodiversity');
  assert.equal(emphasizeCollocation('serious implications','implication',esc), '<b>serious</b> implications');
  assert.equal(emphasizeCollocation('analyse data','analyze',esc), 'analyse <b>data</b>');
  assert.equal(emphasizeCollocation('invest in renewables','renewable',esc), '<b>invest in</b> renewables');
  assert.equal(emphasizeCollocation('well-educated workforce','educate',esc), 'well-educated workforce');
  assert.equal(emphasizeCollocation('a <b>','test',esc), 'a &lt;b>');
});
