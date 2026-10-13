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
  function emphasizeCollocation(phrase, headword, esc) {
    const toks = String(phrase).split(' ');
    if (!toks.some((t) => isHeadwordToken(t, headword))) return esc(phrase);
    const out = []; let run = [];
    const flush = () => { if (run.length) { out.push(`<b>${esc(run.join(' '))}</b>`); run = []; } };
    for (const t of toks) { if (isHeadwordToken(t, headword)) { flush(); out.push(esc(t)); } else run.push(t); }
    flush();
    return out.join(' ');
  }
  g.UW_TEXT = { titleCase, sentenceCase, emphasizeCollocation };
})(typeof window !== 'undefined' ? window : globalThis);
