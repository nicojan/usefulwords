(function (g) {
  const SMALL = new Set(['a','an','and','as','at','but','by','for','in','of','on','or','the','to','vs','via']);
  function titleCase(s) {
    return String(s || '').split(' ').map((w, i, a) => {
      if (!w || w === '&' || w === '/') return w;
      if (i > 0 && i < a.length - 1 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }
  function sentenceCase(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function isHeadwordToken(tok, headword) {
    const h = headword.toLowerCase(); const n = Math.max(4, h.length - 2);
    return tok.toLowerCase().startsWith(h.slice(0, n));
  }
  // Function words and placeholders are not collocates. When a phrase has a
  // content word besides the headword, only content words are bold ("help to
  // mitigate" bolds "help"); when it has none, the preposition pattern is the
  // collocate ("biased against" bolds "against"). Articles, forms of "be" and
  // placeholders are never bold ("the concept of" bolds "of").
  const FUNCTION_WORDS = new Set(['of','to','in','on','at','for','with','by','from','as','into','onto','about','among','against','between','through','throughout','across','towards','toward','during','around','over','under','upon','within','without','and','or','but','it','its','than','up','out','off']);
  const NEVER_BOLD = new Set(['a','an','the','be','been','being','is','are','was','were',
    'my','your','his','her','our','their','yourself','yourselves','himself','herself','ourselves','themselves','itself',
    'someone','someone\'s','something','something\'s','sb','sth','one\'s','oneself']);
  function emphasizeCollocation(phrase, headword, esc) {
    const toks = String(phrase).split(' ');
    if (!toks.some((t) => isHeadwordToken(t, headword))) return esc(phrase);
    const kind = (t) => {
      const w = t.toLowerCase();
      if (isHeadwordToken(t, headword)) return 'head';
      if (NEVER_BOLD.has(w)) return 'plain';
      return FUNCTION_WORDS.has(w) ? 'function' : 'content';
    };
    const kinds = toks.map(kind);
    const boldKind = kinds.includes('content') ? 'content' : 'function';
    const out = []; let run = [];
    const flush = () => { if (run.length) { out.push(`<b>${esc(run.join(' '))}</b>`); run = []; } };
    toks.forEach((t, i) => { if (kinds[i] === boldKind) run.push(t); else { flush(); out.push(esc(t)); } });
    flush();
    return out.join(' ');
  }
  g.UW_TEXT = { titleCase, sentenceCase, emphasizeCollocation };
})(typeof window !== 'undefined' ? window : globalThis);
