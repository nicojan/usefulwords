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
  assert.equal(emphasizeCollocation('loss of biodiversity','biodiversity',esc), '<b>loss</b> of biodiversity');
  assert.equal(emphasizeCollocation('serious implications','implication',esc), '<b>serious</b> implications');
  assert.equal(emphasizeCollocation('analyse data','analyze',esc), 'analyse <b>data</b>');
  assert.equal(emphasizeCollocation('invest in renewables','renewable',esc), '<b>invest</b> in renewables');
  // Function words stay regular beside a content word; adjacent content words share one run
  assert.equal(emphasizeCollocation('help to mitigate','mitigate',esc), '<b>help</b> to mitigate');
  assert.equal(emphasizeCollocation('enter the workforce','workforce',esc), '<b>enter</b> the workforce');
  assert.equal(emphasizeCollocation('mitigate the effects','mitigate',esc), 'mitigate the <b>effects</b>');
  assert.equal(emphasizeCollocation('at the top of the hierarchy','hierarchy',esc), 'at the <b>top</b> of the hierarchy');
  assert.equal(emphasizeCollocation('greenhouse gas emissions','emissions',esc), '<b>greenhouse gas</b> emissions');
  // A placeholder is never the collocate
  assert.equal(emphasizeCollocation("invade someone's privacy",'privacy',esc), "<b>invade</b> someone's privacy");
  // With no content word, the preposition pattern is the collocate
  assert.equal(emphasizeCollocation('biased against','biased',esc), 'biased <b>against</b>');
  assert.equal(emphasizeCollocation('equip someone for','equip',esc), 'equip someone <b>for</b>');
  assert.equal(emphasizeCollocation('be displaced by','displace',esc), 'be displaced <b>by</b>');
  assert.equal(emphasizeCollocation('the concept of','concept',esc), 'the concept <b>of</b>');
  assert.equal(emphasizeCollocation('broaden your outlook','outlook',esc), '<b>broaden</b> your outlook');
  assert.equal(emphasizeCollocation('educate yourself about','educate',esc), 'educate yourself <b>about</b>');
  assert.equal(emphasizeCollocation('well-educated workforce','educate',esc), 'well-educated workforce');
  assert.equal(emphasizeCollocation('a <b>','test',esc), 'a &lt;b>');
});

// Every collocation in the data: no function word, article, possessive, reflexive or placeholder is bold beside a
// content word, and a phrase with a headword match always has some bold.
test('emphasizeCollocation over data.js', () => {
  const dctx = {}; dctx.window = dctx;
  vm.runInNewContext(readFileSync(new URL('../public/js/data.js', import.meta.url), 'utf8'), dctx);
  const PLAIN = new Set(['a','an','the','be','been','being','is','are','was','were','my','your','his','her','our','their',
    'yourself','yourselves','himself','herself','ourselves','themselves','itself','someone',"someone's",'something',"one's",'oneself']);
  const FUNCTION = new Set(['of','to','in','on','at','for','with','by','from','as','into','onto','about','among','against','between',
    'through','throughout','across','towards','toward','during','around','over','under','upon','within','without','and','or','but','it','its','than','up','out','off']);
  const problems = [];
  for (const sec of dctx.UW_DATA.sections) for (const cat of sec.categories || []) for (const e of cat.entries) for (const c of e.collocations || []) {
    const html = emphasizeCollocation(c, e.word, esc);
    const bold = [...html.matchAll(/<b>(.*?)<\/b>/g)].flatMap((m) => m[1].split(' ').map((w) => w.toLowerCase()));
    const hasContentBold = bold.some((w) => !FUNCTION.has(w) && !PLAIN.has(w));
    for (const w of bold) {
      if (PLAIN.has(w)) problems.push(`${e.word}: "${c}" bolds "${w}"`);
      else if (FUNCTION.has(w) && hasContentBold) problems.push(`${e.word}: "${c}" bolds function word "${w}" beside a content word`);
    }
  }
  assert.deepEqual(problems, []);
});
