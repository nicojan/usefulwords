#!/usr/bin/env node
// End-to-end verification harness for the usefulwords dictionary redesign.
//
//   node scripts/verify.mjs                 run every check (starts its own server on a free port)
//   node scripts/verify.mjs --only jumps,console
//   BASE_URL=https://usefulwords.forhuman.ca node scripts/verify.mjs
//   BASE_URL=http://127.0.0.1:8787 node scripts/verify.mjs   (serves public/ there; if the port is taken, the
//                                                             served index.html must equal the one on disk)
//
// Prints one line per check and viewport/scheme combination (PASS / FAIL / SKIP), exits 1 on any FAIL.
// Needs playwright-core and Google Chrome. Install (run from usefulwords/, writes no package.json and no
// lockfile; a bare `npm install` would resolve to a parent directory's node_modules):
//   npm install --no-save --no-package-lock --prefix "$PWD" playwright-core@1.49.1
// Spec: _meta/plans/2026-10-13-usefulwords-dictionary-redesign.md ("Hard constraint: JS hooks",
// "Colour", "Running head", "Verification"); bans: .superpowers/sdd/.../global-constraints.md.

import { chromium } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, '.superpowers', 'shots');
// Set in main(): the URL under test, and whether the served index.html contains an element with class `rh`
// (which makes the running head mandatory). Gated on markup, not CSS: a `.rh` selector in a print rule or a
// future stylesheet does not mean the element exists.
let BASE_URL = '';
let RH_REQUIRED = false;
const RH_MARKUP_RE = /class="[^"]*\brh\b[^"]*"/;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Console errors the live site already logs, so they are not mistaken for regressions.
// Each entry matches on the failing resource URL and the message, never on the whole text alone.
const BASELINE_ERRORS = [
  {
    // Cloudflare Web Analytics. Cloudflare's edge injects
    //   <script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/...">
    // into the HTML it serves to browsers (it is NOT in public/index.html and not served to curl), so it
    // only exists on the live site. On the machine this was measured on, connections to
    // static.cloudflareinsights.com are refused at the network layer, which Chrome reports as
    // "Failed to load resource: net::ERR_INVALID_HANDLE". The matcher keys on URL, so the same beacon
    // blocked by an extension (ERR_BLOCKED_BY_CLIENT) is covered too.
    url: /^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\b/,
    text: /^Failed to load resource/,
  },
];

// Ban-list hits that are allowed to stay. Each entry is { pattern, file, lineText, reason }: `pattern` is the
// name printed by the grep check, `file` the repo-relative path, `lineText` a substring of the hit text (for CSS
// hits the text is "<selector> :: <line>", so a selector can be named), and `reason` must say why it is fine.
// Empty on purpose: every exception has to be argued for here.
const GREP_ALLOWLIST = [];

const GREP_FILES = ['public/css/styles.css', 'public/js/app.js', 'public/index.html'];
const GREP_PATTERNS = [
  ['text-transform: uppercase', /text-transform\s*:\s*uppercase/i],
  ['letter-spacing', /letter-spacing/i],
  ['box-shadow', /box-shadow/i],
  ['drop-shadow', /drop-shadow/i],
  ['backdrop-filter', /backdrop-filter/i],
  ['outline: none', /outline\s*:\s*none/i],
  ['border-radius: 999', /border-radius\s*:\s*999/i],
  // 50% is a circle: allowed only on dots and icons, so every use has to be allowlisted with its selector.
  ['border-radius: 50%', /border-radius\s*:\s*50%/i],
  ['--tint', /--tint/],
  ['SECTION_TINT_VAR', /SECTION_TINT_VAR/],
  ['applyTint', /applyTint/],
  ['tab__dot', /tab__dot/],
  ['dice emoji', /\u{1F3B2}/u],
  ['Fraunces', /Fraunces/],
  ['IBM Plex', /IBM Plex/],
];
// Also checked, in checkGrep(): border-left on example blocks, font weights, em dashes, font-display.
const ALLOWED_WEIGHTS = new Set(['400', '500', '600', '700']);
const EM_DASH_RE = /—|&mdash;|&#8212;|&#x2014;|\\u2014|\\u\{2014\}/i;

// The complete colour token set from the spec ("Colour: the complete token set"), light and dark.
// Alpha colours are written as rgba(); values are compared numerically, not as strings.
const TOKENS = {
  '--bg': { light: '#ffffff', dark: '#161412' },
  '--ink': { light: '#1d1d1f', dark: '#ece8e3' },
  '--ink-2': { light: '#3a3a3c', dark: '#c9c4be' },
  '--muted': { light: '#6e6e73', dark: '#9a948d' },
  '--rule-strong': { light: '#1d1d1f', dark: 'rgba(236,232,227,0.6)' },
  '--rule': { light: '#e5e5ea', dark: '#2e2a27' },
  '--accent': { light: '#A0603F', dark: '#D08B62' },
  '--hl': { light: 'rgba(255,204,0,0.42)', dark: 'rgba(255,204,0,0.28)' },
  '--flash': { light: 'rgba(160,96,63,0.12)', dark: 'rgba(208,139,98,0.18)' },
};

const COMBOS = [
  { w: 390, h: 844, scheme: 'light', phone: true },
  { w: 390, h: 844, scheme: 'dark', phone: true },
  { w: 1440, h: 900, scheme: 'light', phone: false },
  { w: 1440, h: 900, scheme: 'dark', phone: false },
];

const JUMP_WAIT_MS = 1200;
const FIRST_VISIT_TRIALS = 3;
const REFERENCE_TOLERANCE_PX = 2;
const FLASH_CLASS = 'is-target'; // what flashTarget() in app.js adds
// localStorage names used by app.js; the hint one being set means the onboarding hint is gone (a returning visitor)
const STORE = { recent: 'uw_recent_v1', hint: 'uw_hint_dismissed_v1' };
const MIN_CHIPS_CONTENT_PX = 380;
// Under a search the first match must start within this distance of the top (it started ~500px down under the masthead).
const MAX_FIRST_MATCH_TOP_PX = 320;
// A jump lands its target scroll-margin-top (running head + 16px) from the top. Any target that can scroll that far
// must end up at most this far below the running head; more means something shifted the page under the jump (the
// first recently-viewed reveal once landed ~100px short). Skipped when the page is scrolled to its end.
const MAX_LANDING_GAP_PX = 24;
// The returning-visitor reference already has recently-viewed entries, so the first-visit trials (empty storage,
// where the first jump reveals the list above the entries) differ from it exactly where it matters.
const RETURNING_RECENT = ['literacy', 'automate', 'nuance'];
// Simulated WebKit: Safari has no scroll anchoring, so a layout change above the viewport moves the page there.
// Injected for extra first-visit trials on phones; the same landing bound applies.
const NO_ANCHOR_CSS = 'html, body { overflow-anchor: none !important; }';
const NO_ANCHOR_TRIALS = 2;

// ---------------------------------------------------------------------------
// In-page helpers (injected once per page as window.__v)
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  function alphaOf(v) { return v === undefined ? 1 : v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); }
  function parseColor(str) {
    let m = /^rgba?\\(\\s*([\\d.]+)[ ,]+([\\d.]+)[ ,]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)$/.exec(str);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alphaOf(m[4]) };
    m = /^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\s*\\)$/.exec(str);
    if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: alphaOf(m[4]) };
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = str;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }
  function over(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const canvasColor = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  function backgroundOf(el) {
    const layers = [];
    let image = false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') image = true;
      const c = parseColor(cs.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = canvasColor;
    if (layers.length && layers[layers.length - 1].a >= 1) base = layers.pop();
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return { color: base, image };
  }
  function opacityOf(el) {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  }
  function describe(el) {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  }
  // Unique element path (tag:index chain), so two measurements of the same element share a key.
  function pathOf(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) i++;
      parts.push(e.tagName.toLowerCase() + ':' + i);
    }
    return parts.reverse().join('>');
  }
  const rgb = (c) => 'rgb(' + [c.r, c.g, c.b].map((v) => Math.round(v)).join(',') + ')';
  window.__v = { parseColor, over, ratio, backgroundOf, opacityOf, describe, pathOf, rgb };
})();`;

// ---------------------------------------------------------------------------
// Result bookkeeping
// ---------------------------------------------------------------------------

const results = [];
// Per-combination output is buffered so the four combinations can run concurrently and still print grouped.
const buffers = new Map();
function record(status, name, ctx, detail) {
  results.push({ status, name, ctx, detail });
  const where = ctx ? ` [${ctx}]` : '';
  const [first, ...rest] = String(detail).split('\n');
  const lines = [`${status} ${name}${where}: ${first}`, ...rest.map((l) => `    ${l}`)];
  if (!ctx) { console.log(lines.join('\n')); return; }
  buffers.set(ctx, [...(buffers.get(ctx) || []), ...lines]);
}
// Narrow phones: only the `screens` check runs on these (a light scheme is enough), to keep the run short.
const SCREEN_ONLY_COMBOS = [
  { w: 375, h: 812, scheme: 'light', phone: true },
  { w: 360, h: 740, scheme: 'light', phone: true },
];
const comboLabel = (c) => `${c.w} ${c.scheme}`;

// ---------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------

function isBaseline(url, text) {
  return BASELINE_ERRORS.some((b) => b.url.test(url) && b.text.test(text));
}

// A fresh browser context per page keeps localStorage (recently viewed) from leaking between checks.
async function openPage(browser, combo, { path: p = '/', recent: seeded, returning = false, noAnchor = false, settleMs = 400, errors } = {}) {
  const recent = seeded ?? (returning ? RETURNING_RECENT : undefined);
  const context = await browser.newContext({
    viewport: { width: combo.w, height: combo.h },
    colorScheme: combo.scheme,
    ...(combo.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const seed = {
    ...(recent ? { [STORE.recent]: JSON.stringify(recent) } : {}),
    ...(returning ? { [STORE.hint]: 'true' } : {}),
  };
  if (Object.keys(seed).length) {
    await context.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) if (!localStorage.getItem(k)) localStorage.setItem(k, v);
    }, seed);
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => errors?.push({ kind: 'pageerror', text: e.message, url: '' }));
  page.on('console', (m) => {
    if (m.type() === 'error') errors?.push({ kind: 'console', text: m.text(), url: m.location().url || '' });
  });
  await page.addInitScript(PAGE_HELPERS);
  await page.goto(BASE_URL + p, { waitUntil: 'load' });
  if (noAnchor) {
    await page.addStyleTag({ content: NO_ANCHOR_CSS });
    const off = await page.evaluate(() => [document.documentElement, document.body].every((e) => getComputedStyle(e).overflowAnchor === 'none'));
    if (!off) throw new Error('could not turn scroll anchoring off (overflow-anchor is not none on html and body)');
  }
  await page.waitForSelector('.entry', { state: 'attached', timeout: 10000 });
  await page.waitForTimeout(settleMs);
  return { page, context };
}

async function withPage(browser, combo, opts, fn) {
  const { page, context } = await openPage(browser, combo, opts);
  try {
    return await fn(page, context);
  } finally {
    await context.close();
  }
}

// Waits the spec's 1200ms, then until scroll position and document height have been still for 500ms. Chrome's
// smooth scroll takes longer for long jumps (a random word 40,000px away is still moving at 1200ms), so
// measuring at a fixed time would report a scroll in flight as a bad landing. Returns false if the page never
// came to rest within about 11 seconds, so callers can fail instead of measuring a moving page.
async function settle(page) {
  await page.waitForTimeout(JUMP_WAIT_MS);
  const sample = () => page.evaluate(() => `${Math.round(scrollY)}/${document.documentElement.scrollHeight}`);
  let last = await sample();
  let stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    await page.waitForTimeout(250);
    const now = await sample();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return stable >= 2;
}

const NOT_SETTLED = { status: 'FAIL', detail: 'did not settle: the page was still scrolling or reflowing after about 11 seconds' };

// ---------------------------------------------------------------------------
// Landing measurement (shared by jumps, deep link, swipe)
// ---------------------------------------------------------------------------

async function measureLanding(page, id) {
  return page.evaluate((targetId) => {
    const target = document.getElementById(targetId);
    if (!target) return { missing: true };
    const rh = document.querySelector('.rh');
    const rhBottom = rh ? rh.getBoundingClientRect().bottom : 0;
    const rhCs = rh ? getComputedStyle(rh) : null;
    const r = target.getBoundingClientRect();
    const section = target.closest('.section');
    const category = target.closest('.category');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return {
      top: r.top,
      bottom: r.bottom,
      rhBottom,
      margin: parseFloat(getComputedStyle(target).scrollMarginTop) || 0,
      vh: innerHeight,
      vw: innerWidth,
      atEnd: scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
      left: r.left,
      hasRh: !!rh,
      rhPosition: rhCs ? rhCs.position : '',
      rhShown: !!rh && rhCs.visibility === 'visible' && parseFloat(rhCs.opacity) > 0 && rhCs.display !== 'none',
      rhTopic: rh ? norm(rh.querySelector('.rh__topic')?.textContent) : '',
      rhCat: rh ? norm(rh.querySelector('.rh__cat')?.textContent) : '',
      rhCatOverflow: !!rh && (() => { const c = rh.querySelector('.rh__cat'); return !!c && c.scrollWidth > c.clientWidth; })(),
      inSection: !!section,
      inCategory: !!category,
      sectionTitle: norm(section?.querySelector('.section__title-en')?.textContent),
      categoryName: norm(category?.querySelector('.category__name')?.textContent),
    };
  }, id);
}

function rhCategoryFits(shown, full) {
  const want = full.trim().split(/\s*\/\s*/);
  const got = shown.trim().split(/\s*\/\s*/);
  return got.length >= 1 && got[0] !== '' && got.length <= want.length && got.every((t, i) => t === want[i]);
}

function landingProblems(m, id) {
  if (m.missing) return [`target #${id} not found`];
  const problems = [];
  if (RH_REQUIRED && !m.hasRh) problems.push('the served index.html contains a .rh element but the rendered page has none');
  if (m.hasRh && !['fixed', 'sticky'].includes(m.rhPosition)) problems.push(`.rh position is "${m.rhPosition}", want fixed or sticky`);
  if (m.hasRh && !m.rhShown) problems.push('.rh is hidden after the jump');
  if (m.top < m.rhBottom - 1) problems.push(`#${id} top ${m.top.toFixed(1)} is under the running head (bottom ${m.rhBottom.toFixed(1)})`);
  else if (m.top < m.margin - 2) problems.push(`#${id} top ${m.top.toFixed(1)} overshot: above its scroll-margin-top ${m.margin.toFixed(0)}px`);
  if (m.top >= m.vh || m.bottom <= 0 || m.left >= m.vw) problems.push(`#${id} is outside the viewport (top ${m.top.toFixed(1)}, vh ${m.vh})`);
  if (m.inSection && !m.sectionTitle) problems.push(`#${id} is in a .section whose .section__title-en is empty or missing`);
  if (m.inCategory && !m.categoryName) problems.push(`#${id} is in a .category whose .category__name is empty or missing`);
  if (m.hasRh) {
    if (m.sectionTitle && !m.rhTopic.includes(m.sectionTitle)) problems.push(`running head topic "${m.rhTopic}" lacks "${m.sectionTitle}"`);
    // A long name may be fitted to its leading terms ("Opposition / Limitation"), never cut mid-term or emptied.
    if (m.rhCatOverflow) problems.push(`running head category "${m.rhCat}" overflows its line (cut with an ellipsis)`);
    if (m.categoryName && !rhCategoryFits(m.rhCat, m.categoryName)) problems.push(`running head category "${m.rhCat}" is not "${m.categoryName}" or its leading terms`);
  }
  return problems;
}

const landingSummary = (m) => `top ${m.top.toFixed(0)}px, running head bottom ${m.rhBottom.toFixed(0)}px${m.hasRh ? '' : ' (no .rh yet, using viewport top)'}`;

// ---------------------------------------------------------------------------
// Checks that do not need a browser: grep
// ---------------------------------------------------------------------------

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}
const lineAt = (starts, index) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
};

// Innermost-brace rules only ("selector { declarations }"); at-rules wrapping them are not returned.
function cssRules(original) {
  // Comments are blanked (newlines kept, so line numbers survive): otherwise a comment above a rule becomes part
  // of its "selector" and `@font-face` no longer matches, and braces inside comments split rules wrongly.
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const starts = lineStarts(source);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const lead = m[1].length - m[1].trimStart().length;
    rules.push({
      selector: m[1].trim(),
      body: m[2],
      line: lineAt(starts, m.index + lead),
      bodyStartLine: lineAt(starts, m.index + m[1].length),
      endLine: lineAt(starts, m.index + m[0].length - 1),
    });
  }
  return rules;
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Weights found in a declaration value or a `font` shorthand; returns the ones outside 400/500/600/700.
function badWeights(value) {
  const bad = [];
  for (const token of value.replace(/!important/i, '').trim().split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+(\.\d+)?$/.test(token)) { if (!ALLOWED_WEIGHTS.has(String(Number(token)))) bad.push(token); }
    else if (/^(bolder|lighter)$/i.test(token)) bad.push(token);
  }
  return bad;
}

function weightHitsInLine(line) {
  const out = [];
  for (const m of line.matchAll(/font-weight\s*:\s*([^;}]*)/gi)) {
    const bad = badWeights(m[1]);
    if (bad.length) out.push(`font-weight ${bad.join(' ')}`);
  }
  for (const m of line.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]*)/gi)) {
    const bad = (m[1].match(/(?<![\d./#-])[1-9]00(?![\d%.\w-])/g) || []).filter((w) => !ALLOWED_WEIGHTS.has(w));
    if (bad.length) out.push(`font shorthand weight ${bad.join(' ')}`);
  }
  for (const m of line.matchAll(/font-variation-settings\s*:[^;}]*/gi)) {
    for (const w of m[0].matchAll(/["']wght["']\s*([\d.]+)/gi)) {
      if (!ALLOWED_WEIGHTS.has(String(Number(w[1])))) out.push(`font-variation-settings wght ${w[1]}`);
    }
  }
  return out;
}

// String and template literals of a JS file with comments skipped (regex literals are skipped too). The scan is a
// small tokenizer, not a parser: it tracks quotes, template ${} nesting, // and /* */ comments and regex literals.
function jsLiterals(src) {
  const out = [];
  const stack = [];
  let line = 1;
  let i = 0;
  let prev = '';
  const n = src.length;
  const push = (text, atLine) => { if (text) out.push({ text, line: atLine }); };
  const readTemplate = () => {
    let chunk = '';
    let start = line;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { chunk += c + (src[i + 1] || ''); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { push(chunk, start); i++; prev = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { push(chunk, start); i += 2; stack.push(0); prev = '{'; return; }
      if (c === '\n') line++;
      chunk += c;
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let chunk = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { chunk += src[i] + (src[i + 1] || ''); i += 2; continue; }
        chunk += src[i++];
      }
      i++;
      push(chunk, start);
      prev = c;
      continue;
    }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '{' && stack.length) { stack[stack.length - 1]++; i++; prev = '{'; continue; }
    if (c === '}' && stack.length) {
      if (stack[stack.length - 1] === 0) { stack.pop(); i++; readTemplate(); continue; }
      stack[stack.length - 1]--;
      i++;
      prev = '}';
      continue;
    }
    if (c === '/') {
      const word = /\b(return|typeof|case|in|of|delete|void|throw)\s*$/.test(src.slice(Math.max(0, i - 8), i));
      if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || word) {
        i++;
        let inClass = false;
        while (i < n && src[i] !== '\n' && (inClass || src[i] !== '/')) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        prev = ')';
        continue;
      }
    }
    prev = c;
    i++;
  }
  return out;
}

// Em dashes in what a student can read in index.html: text content, plus the placeholder, aria-label, title and
// content attributes. Comments, script and style bodies, and every other attribute are ignored.
function htmlEmDashes(html) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a, b, c) => a + blank(b) + c)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, a, b, c) => a + blank(b) + c);
  const hits = [];
  const starts = lineStarts(html);
  for (const m of cleaned.matchAll(/<[^>]*>|[^<]+/g)) {
    if (m[0].startsWith('<')) {
      for (const a of m[0].matchAll(/\b(placeholder|aria-label|title|content)\s*=\s*("[^"]*"|'[^']*')/gi)) {
        if (EM_DASH_RE.test(a[2])) hits.push({ line: lineAt(starts, m.index), text: `${a[1]}=${squash(a[2])}` });
      }
    } else if (EM_DASH_RE.test(m[0])) {
      const at = m.index + Math.max(0, m[0].search(EM_DASH_RE));
      hits.push({ line: lineAt(starts, at), text: squash(m[0]) });
    }
  }
  return hits;
}

function assertAllowlistValid() {
  for (const e of GREP_ALLOWLIST) {
    if (![e.pattern, e.file, e.lineText].every((x) => typeof x === 'string' && x.trim()) || typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error(`GREP_ALLOWLIST entry needs non-empty pattern, file, lineText and reason: ${JSON.stringify(e)}`);
    }
  }
}
const isAllowed = (h) => GREP_ALLOWLIST.some((e) => e.pattern === h.name && e.file === h.file && h.text.includes(e.lineText));

function grepFile(rel, text) {
  const hits = [];
  const add = (name, line, body) => hits.push({ name, file: rel, line, text: squash(body) });
  const isCss = rel.endsWith('.css');
  const rules = isCss ? cssRules(text) : [];
  const selectorAt = (lineNo) => rules.find((r) => r.bodyStartLine <= lineNo && lineNo <= r.endLine)?.selector;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const no = i + 1;
    const ctx = isCss ? `${selectorAt(no) || '(top level)'} :: ${line}` : line;
    for (const [name, re] of GREP_PATTERNS) if (re.test(line)) add(name, no, ctx);
    for (const w of weightHitsInLine(line)) add('font weight outside 400/500/600/700', no, `${w} in ${ctx}`);
    if (isCss && /\bcontent\s*:[^;}]*(—|\\2014)/i.test(line)) add('em dash in student-facing string', no, ctx);
    if (!isCss && /border-left/i.test(line) && /example/i.test(line)) add('border-left on example blocks', no, line);
    for (const m of line.matchAll(/fonts\.googleapis\.com\/[^"'\s)<>]*/g)) {
      if (!/[?&](amp;)?display=optional\b/.test(m[0].replace(/&amp;/g, '&'))) add('googleapis URL without display=optional', no, m[0]);
    }
  });
  if (isCss) {
    for (const r of rules) {
      if (/example/i.test(r.selector) && /border-(left|inline-start)/i.test(r.body)) add('border-left on example blocks', r.line, `${r.selector} :: border-left`);
      if (/^@font-face\b/i.test(r.selector) && !/font-display\s*:\s*optional\b/i.test(r.body)) {
        add('@font-face without font-display: optional', r.line, `@font-face ${(/font-family\s*:\s*([^;]+)/i.exec(r.body) || [])[1] || ''}`);
      }
    }
  }
  if (rel.endsWith('.html')) for (const h of htmlEmDashes(text)) add('em dash in student-facing string', h.line, h.text);
  if (rel.endsWith('.js')) {
    for (const lit of jsLiterals(text)) {
      const at = lit.text.search(EM_DASH_RE);
      if (at >= 0) add('em dash in student-facing string', lit.line + (lit.text.slice(0, at).match(/\n/g) || []).length, lit.text);
    }
  }
  return hits;
}

async function checkGrep() {
  assertAllowlistValid();
  const hits = [];
  for (const rel of GREP_FILES) hits.push(...grepFile(rel, await readFile(path.join(ROOT, rel), 'utf8')));
  const live = hits.filter((h) => !isAllowed(h));
  const allowed = hits.length - live.length;
  const counts = {};
  for (const h of live) counts[h.name] = (counts[h.name] || 0) + 1;
  const summary = Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(', ');
  const samples = Object.keys(counts).map((n) => {
    const h = live.find((x) => x.name === n);
    return `${n}: ${h.file}:${h.line}  ${h.text.slice(0, 80)}`;
  });
  const note = allowed ? ` (${allowed} allowlisted)` : '';
  if (!live.length) record('PASS', 'grep', '', `no ban-list hits in ${GREP_FILES.length} files${note}`);
  else record('FAIL', 'grep', '', `${live.length} ban-list hits${note}: ${summary}\nfirst hit of each:\n${samples.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Browser checks
// ---------------------------------------------------------------------------

async function checkTokens(browser, combo) {
  await withPage(browser, combo, {}, async (page) => {
    const found = await page.evaluate((expected) => {
      const names = new Set();
      const visit = (rules) => {
        for (const rule of rules) {
          if (rule.cssRules && !rule.selectorText) visit(rule.cssRules);
          if (rule.selectorText && /(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) {
            for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop);
          }
          if (rule.selectorText && rule.cssRules) visit(rule.cssRules); // nested rules
        }
      };
      for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules); } catch { /* cross-origin sheet (Google Fonts): no custom properties */ }
      }
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('i');
      document.body.appendChild(probe);
      const colours = {};
      for (const name of [...names, ...Object.keys(expected)]) {
        const value = root.getPropertyValue(name).trim();
        if (!value || !CSS.supports('color', value)) continue;
        probe.style.color = '';
        probe.style.color = value;
        colours[name] = window.__v.parseColor(getComputedStyle(probe).color);
      }
      probe.remove();
      return colours;
    }, TOKENS);

    const expected = Object.keys(TOKENS);
    const actual = Object.keys(found);
    const missing = expected.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !expected.includes(n));
    const wrong = [];
    for (const name of expected.filter((n) => found[n])) {
      const want = parseExpected(TOKENS[name][combo.scheme]);
      const got = found[name];
      const close = Math.abs(want.r - got.r) <= 1.5 && Math.abs(want.g - got.g) <= 1.5 && Math.abs(want.b - got.b) <= 1.5 && Math.abs(want.a - got.a) <= 0.012;
      if (!close) wrong.push(`${name} is rgba(${[got.r, got.g, got.b].map(Math.round)},${got.a.toFixed(2)}), want ${TOKENS[name][combo.scheme]}`);
    }
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(' ')}`);
    if (extra.length) parts.push(`${extra.length} extra colour tokens: ${extra.slice(0, 14).join(' ')}${extra.length > 14 ? ' ...' : ''}`);
    if (wrong.length) parts.push(`wrong value: ${wrong.join('; ')}`);
    if (!parts.length) record('PASS', 'tokens', comboLabel(combo), `exactly the ${expected.length} spec colour tokens, values match`);
    else record('FAIL', 'tokens', comboLabel(combo), parts.join('\n'));
  });
}

function parseExpected(str) {
  let m = /^#([0-9a-f]{6})$/i.exec(str);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = /^rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)$/.exec(str);
  return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
}

// Measures every visible text element, plus the rules (borders) on the running head and on heading containers,
// in the current page state. Items carry a unique element path so the same element can be merged across states.
function measureContrastInPage() {
  const v = window.__v;
  const items = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|TITLE)$/.test(el.tagName)) continue;
    seen.add(el);
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) continue;
    const cs = getComputedStyle(el);
    const bg = v.backgroundOf(el);
    const fg = v.parseColor(cs.color);
    fg.a *= v.opacityOf(el);
    const flat = v.over(fg, bg.color);
    items.push({ kind: 'text', key: `text|${v.pathOf(el)}`, sel: v.describe(el), text: text.slice(0, 28), fg: v.rgb(flat), bg: v.rgb(bg.color), ratio: v.ratio(flat, bg.color), req: 4.5, image: bg.image });
  }
  const input = document.querySelector('input[placeholder]');
  if (input && input.getAttribute('placeholder').trim() && input.checkVisibility()) {
    const bg = v.backgroundOf(input);
    const fg = v.parseColor(getComputedStyle(input, '::placeholder').color);
    const flat = v.over(fg, bg.color);
    items.push({ kind: 'text', key: `text|${v.pathOf(input)}::placeholder`, sel: 'input::placeholder', text: input.getAttribute('placeholder'), fg: v.rgb(flat), bg: v.rgb(bg.color), ratio: v.ratio(flat, bg.color), req: 4.5, image: bg.image });
  }

  // Rules: borders (and pseudo-element borders) on the running head, section/category/topics/WOD/recent headers
  // and every h2 in <main> plus its enclosing header. `.category__header` hairlines are decorative (--rule), so
  // they are measured and reported but not held to 3:1.
  const selectors = '.rh, .section__header, .category__header, .topics__header, .wod__header, .wod__heading, .recent__header, .recent__heading, #wod-section > header, #recent-section > header';
  const els = new Set(document.querySelectorAll(selectors));
  for (const h of document.querySelectorAll('main h2')) { els.add(h); const hd = h.closest('header'); if (hd) els.add(hd); }
  const headings = [];
  for (const el of els) {
    const isRh = el.matches('.rh');
    if (!isRh && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
    const decorative = !!el.closest('.category__header');
    const bg = v.backgroundOf(el);
    const path = v.pathOf(el);
    let count = 0;
    for (const pseudo of [null, '::before', '::after']) {
      const cs = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
      if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue;
      for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
        const w = parseFloat(cs[`border${side}Width`]);
        if (!(w > 0) || /^(none|hidden)$/.test(cs[`border${side}Style`])) continue;
        const line = v.over(v.parseColor(cs[`border${side}Color`]), bg.color);
        items.push({ kind: 'rule', key: `rule|${path}|${pseudo || ''}|${side}`, sel: `${v.describe(el)}${pseudo || ''} border-${side.toLowerCase()}`, text: `${w}px rule${decorative ? ' (decorative)' : ''}`, fg: v.rgb(line), bg: v.rgb(bg.color), ratio: v.ratio(line, bg.color), req: decorative ? 0 : 3, image: false });
        count++;
      }
    }
    headings.push({ path, sel: v.describe(el), count, isRh, sectionHeader: el.closest('.section__header') ? v.pathOf(el.closest('.section__header')) : null });
  }
  return { items, headings, hasRh: !!document.querySelector('.rh') };
}

// Waits until no CSS transition or animation is running (the chips row and the running head fade in), so a colour
// is never sampled mid-fade at a fraction of its opacity. Throws after ANIMATION_SETTLE_MS, which fails the check.
const ANIMATION_SETTLE_MS = 5000;
async function animationsSettled(page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' && !a.pending), null, { timeout: ANIMATION_SETTLE_MS });
}

async function checkContrast(browser, combo) {
  const all = new Map(); // element key -> the item with the LOWEST ratio seen across states
  const headings = new Map(); // element path -> highest rule count seen across states
  let hasRh = false;
  const collect = async (page) => {
    await animationsSettled(page);
    const got = await page.evaluate(measureContrastInPage);
    hasRh = hasRh || got.hasRh;
    for (const it of got.items) {
      const prior = all.get(it.key);
      if (!prior || it.ratio < prior.ratio) all.set(it.key, it);
    }
    for (const h of got.headings) {
      const prior = headings.get(h.path);
      headings.set(h.path, { ...h, count: Math.max(h.count, prior?.count || 0) });
    }
  };
  await withPage(browser, combo, {}, async (page) => {
    await collect(page); // home
    await page.click('.tab[data-target="transitions"]');
    await page.waitForTimeout(1500);
    await collect(page); // Transitions: chips, sub-nav and the running head visible
    await page.fill('#search-input', 'biodiversity');
    await page.waitForTimeout(500);
    await collect(page); // search results with highlight marks
  });
  const items = [...all.values()];
  const texts = items.filter((i) => i.kind === 'text');
  const rules = items.filter((i) => i.kind === 'rule');
  const failing = items.filter((i) => i.req > 0 && i.ratio < i.req);

  const missingRules = [];
  if (RH_REQUIRED && !hasRh) missingRules.push('the served index.html contains a .rh element but the rendered page has none');
  if (hasRh) {
    const all2 = [...headings.values()];
    for (const h of all2.filter((x) => x.isRh && x.count === 0)) missingRules.push(`no rule measured on ${h.sel}`);
    const perHeader = new Map();
    for (const h of all2.filter((x) => x.sectionHeader)) perHeader.set(h.sectionHeader, (perHeader.get(h.sectionHeader) || 0) + h.count);
    const bare = [...perHeader.entries()].filter(([, c]) => c === 0);
    if (bare.length) missingRules.push(`${bare.length} of ${perHeader.size} section headings have no measurable rule`);
    if (!all2.some((x) => x.isRh)) missingRules.push('.rh exists but was never measured');
  }

  const worst = [...items].filter((i) => i.req > 0).sort((a, b) => a.ratio / a.req - b.ratio / b.req).slice(0, 5);
  const lines = worst.map((i) => `${i.ratio.toFixed(2)}:1 (needs ${i.req}) ${i.sel} "${i.text}" ${i.fg} on ${i.bg}`);
  const images = items.filter((i) => i.image).length;
  const note = images ? ` ${images} sit over a background image (measured against the colour layers only).` : '';
  const head = `${texts.length} unique text elements and ${rules.length} rules measured over 3 page states (lowest ratio per element kept), ${failing.length} below threshold.${note} Worst five:`;
  const extra = missingRules.map((m) => `RULES: ${m}`);
  record(failing.length || missingRules.length ? 'FAIL' : 'PASS', 'contrast', comboLabel(combo), `${head}\n${[...lines, ...extra].join('\n')}`);
}

const JUMP_TARGETS = {
  'see-also': async (p) => ({ loc: p.locator('#environment .see-chip[data-see]').first(), attr: 'data-see' }),
  tagged: async (p) => ({ loc: p.locator('.tagged-chip[data-recent]').first(), attr: 'data-recent' }),
  'also-in': async (p) => ({ loc: p.locator('.entry__also-link[data-topic]').first(), attr: 'data-topic' }),
  'word of the day': async (p) => ({ loc: p.locator('[data-wod]').first(), attr: 'data-wod' }),
  recent: async (p) => ({ loc: p.locator('.recent-chip[data-recent]').first(), attr: 'data-recent' }),
  'Contents row': async (p) => ({ loc: p.locator('.topic-card[data-target="health-lifestyle"]').first(), attr: 'data-target' }),
  tab: async (p) => ({ loc: p.locator('.tab[data-target="technology-media"]').first(), attr: 'data-target' }),
  chip: async (p) => ({ loc: p.locator('.chip[data-cat]').nth(1), attr: 'data-cat', wrap: (c) => `cat-${c}-transitions` }),
  'sub-nav': async (p) => ({ loc: p.locator('.tab-subnav__link[data-cat]').nth(1), attr: 'data-cat', wrap: (c) => `cat-${c}-transitions` }),
};
const JUMP_PAGE_OPTS = {
  recent: { recent: ['biodiversity', 'diversity'] },
  chip: { path: '/#transitions', settleMs: 1500 },
  'sub-nav': { path: '/#transitions', settleMs: 1500 },
};
// Where each of these controls is expected to be on screen: chips are the phone control, the sub-nav the
// desktop one. Missing where expected is a FAIL; hidden where not expected is a SKIP.
const expectedVisible = (name, combo) => (name === 'chip' ? combo.phone : name === 'sub-nav' ? !combo.phone : true);

const landed = (m, id) => {
  const problems = landingProblems(m, id);
  const gap = m.missing ? null : m.top - m.rhBottom;
  if (gap !== null && !m.atEnd && gap > MAX_LANDING_GAP_PX) {
    problems.push(`#${id} landed ${gap.toFixed(1)}px below the running head, want <= ${MAX_LANDING_GAP_PX} (the page shifted under the jump)`);
  }
  return problems.length ? { status: 'FAIL', detail: problems.join('; '), gap } : { status: 'PASS', detail: `#${id}: ${landingSummary(m)}`, gap };
};

async function runClickJump(browser, combo, name, errors, returning, noAnchor) {
  return withPage(browser, combo, { ...JUMP_PAGE_OPTS[name], returning, noAnchor, errors }, async (page) => {
    const { loc, attr, wrap } = await JUMP_TARGETS[name](page);
    const expected = expectedVisible(name, combo);
    if (!(await loc.count()) || !(await loc.isVisible())) {
      const missing = !(await loc.count());
      if (expected) return { status: 'FAIL', detail: `${name} is ${missing ? 'missing' : 'not visible'} but is expected at ${combo.w}px` };
      return { status: 'SKIP', detail: `${name} is not shown at ${combo.w}px (${name === 'chip' ? 'the sub-nav is' : 'the chips are'} used there)` };
    }
    const raw = await loc.getAttribute(attr);
    const id = wrap ? wrap(raw) : raw;
    await loc.click({ timeout: 5000 });
    if (!(await settle(page))) return NOT_SETTLED;
    return landed(await measureLanding(page, id), id);
  });
}

async function runRandomJumps(browser, combo, errors, returning, clicks, noAnchor) {
  return withPage(browser, combo, { returning, noAnchor, errors }, async (page) => {
    const notes = [];
    const problems = [];
    let lastGap = null;
    for (let i = 0; i < clicks; i++) {
      await page.click('.btn-random');
      if (!(await settle(page))) return NOT_SETTLED;
      const id = await page.evaluate(() => decodeURIComponent(location.hash.slice(1)));
      const out = landed(await measureLanding(page, id), id);
      lastGap = out.gap;
      if (out.status === 'FAIL') problems.push(out.detail); else notes.push(`${out.detail.split(':')[0]} gap ${out.gap.toFixed(0)}`);
    }
    return problems.length ? { status: 'FAIL', detail: [...new Set(problems)].join('; ') } : { status: 'PASS', detail: `${clicks} random word(s) landed: ${notes.join(', ')}`, gap: lastGap };
  });
}

async function runSwipeJump(browser, combo, errors, returning, noAnchor) {
  if (!combo.phone) return { status: 'SKIP', detail: 'touch gesture, checked on the 390px phone layout only' };
  return withPage(browser, combo, { path: '/#society-culture', settleMs: 1500, returning, noAnchor, errors }, async (page, context) => {
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => { window.__touches = 0; document.addEventListener('touchstart', () => { window.__touches++; }, { capture: true, passive: true }); });
    const plan = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('.tab')].map((t) => t.dataset.target);
      const current = document.querySelector('.tab[aria-current="true"]')?.dataset.target;
      const blocked = '.chips, .topbar, .tabbar, a, button, input, textarea, select, [contenteditable]';
      for (let y = 100; y < innerHeight - 160; y += 24) {
        for (let x = 40; x < innerWidth - 20; x += 24) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest(blocked)) return { ids, current, x, y };
        }
      }
      return { ids, current, x: null, y: null };
    });
    if (plan.x === null) return { status: 'FAIL', detail: 'no touch point on the page background outside links and bars' };
    const next = plan.ids[plan.ids.indexOf(plan.current) + 1];
    if (!next) return { status: 'FAIL', detail: `no next section after "${plan.current}"` };
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: plan.y }] });
    const startX = Math.min(plan.x + 160, 370);
    await touch('touchStart', startX);
    for (const dx of [20, 50, 90, 130]) await touch('touchMove', startX - dx);
    await touch('touchEnd', startX - 130);
    if (!(await settle(page))) return NOT_SETTLED;
    // CDP touch delivery was proven to work at 390, so a gesture that never reaches the page is a failure.
    if ((await page.evaluate(() => window.__touches)) === 0) return { status: 'FAIL', detail: 'the swipe never reached the page (no touchstart seen); CDP delivery works, so this is a regression' };
    const out = landed(await measureLanding(page, next), next);
    return out.status === 'PASS' ? { ...out, detail: `swipe left from #${plan.current} to #${next}: ${out.detail.split(': ').slice(1).join(': ')}` } : out;
  });
}

const safely = async (fn) => {
  try { return await fn(); } catch (e) { return { status: 'FAIL', detail: `threw: ${e.message.split('\n')[0]}` }; }
};

// One jump type, run as a returning visitor (the reference landing, with recently-viewed entries already stored)
// and then as a first-time visitor three times (empty storage, so the first jump reveals the recently-viewed list
// above the entries). On phones, NO_ANCHOR_TRIALS more first-visit trials run with scroll anchoring off (WebKit).
// The "Tap a topic to explore" hint and the recent reveal both change layout above an in-flight jump, so a
// first-time landing must also match the reference within 2px, and ANY failing trial fails the jump.
async function runJumpType(browser, combo, name, errors) {
  const attempt = (returning, clicks, noAnchor = false) => safely(() => (name === 'random' ? runRandomJumps(browser, combo, errors, returning, clicks, noAnchor)
    : name === 'swipe' ? runSwipeJump(browser, combo, errors, returning, noAnchor)
      : runClickJump(browser, combo, name, errors, returning, noAnchor)));
  const ref = await attempt(true, 5);
  const rows = [{ name: `${name} (returning)`, ...ref }];
  const variants = [
    { label: 'first visit', trials: FIRST_VISIT_TRIALS, noAnchor: false },
    ...(combo.phone ? [{ label: 'first visit, no scroll anchoring', trials: NO_ANCHOR_TRIALS, noAnchor: true }] : []),
  ];
  for (const v of variants) {
    if (ref.status === 'SKIP') { rows.push({ name: `${name} (${v.label})`, status: 'SKIP', detail: ref.detail }); continue; }
    const trials = [];
    for (let i = 0; i < v.trials; i++) trials.push(await attempt(false, 1, v.noAnchor));
    rows.push(compareTrials(name, v, ref, trials));
  }
  return rows;
}

function compareTrials(name, v, ref, trials) {
  const comparable = name !== 'random' && ref.status === 'PASS' && typeof ref.gap === 'number';
  const problems = [];
  trials.forEach((t, i) => {
    if (t.status !== 'PASS') problems.push(`trial ${i + 1}: ${t.detail}`);
    else if (comparable && typeof t.gap === 'number' && Math.abs(t.gap - ref.gap) > REFERENCE_TOLERANCE_PX) {
      problems.push(`trial ${i + 1}: landed ${t.gap.toFixed(1)}px below the running head, the returning visitor lands at ${ref.gap.toFixed(1)}px`);
    }
  });
  const gaps = trials.map((t) => (typeof t.gap === 'number' ? t.gap.toFixed(0) : '?')).join('/');
  return problems.length
    ? { name: `${name} (${v.label})`, status: 'FAIL', detail: `${problems.length} of ${v.trials} trials failed. ${problems.join('; ')}` }
    : { name: `${name} (${v.label})`, status: 'PASS', detail: `${v.trials} trials ok (gaps ${gaps}px${comparable ? `, reference ${ref.gap.toFixed(0)}px` : ''})` };
}

async function checkJumps(browser, combo, errors) {
  const names = [...Object.keys(JUMP_TARGETS), 'random', 'swipe'];
  const outcomes = [];
  for (const name of names) outcomes.push(...(await runJumpType(browser, combo, name, errors)));
  const count = (s) => outcomes.filter((o) => o.status === s).length;
  const lines = outcomes.map((o) => `${o.status.padEnd(4)} ${o.name}: ${o.detail}`);
  record(count('FAIL') ? 'FAIL' : 'PASS', 'jumps', comboLabel(combo), `${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped\n${lines.join('\n')}`);
}

// Installs a MutationObserver that remembers every element that received the flash class.
const WATCH_FLASH = (cls) => {
  window.__flashed = new Set();
  new MutationObserver((records) => {
    for (const r of records) if (r.target.classList.contains(cls)) window.__flashed.add(r.target.id);
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
};

async function checkHandlers(browser, combo, errors) {
  const cases = [
    { name: 'see-also', sel: '#environment .see-chip[data-see]', attr: 'data-see', recent: true },
    { name: 'tagged', sel: '.tagged-chip[data-recent]', attr: 'data-recent', recent: true },
    { name: 'word of the day', sel: '[data-wod]', attr: 'data-wod', recent: true },
    { name: 'also-in', sel: '.entry__also-link[data-topic]', attr: 'data-topic', recent: false },
    { name: 'random', sel: '.btn-random', attr: null, recent: true },
  ];
  const lines = [];
  let failed = 0;
  for (const c of cases) {
    try {
      await withPage(browser, combo, { errors }, async (page) => {
        await page.evaluate(WATCH_FLASH, FLASH_CLASS);
        const loc = page.locator(c.sel).first();
        const id = c.attr ? await loc.getAttribute(c.attr) : null;
        await loc.click({ timeout: 5000 });
        await page.waitForTimeout(JUMP_WAIT_MS + 1300); // flash fires after the ~900ms scroll gate
        const targetId = id || (await page.evaluate(() => decodeURIComponent(location.hash.slice(1))));
        const got = await page.evaluate((t) => ({
          chip: [...document.querySelectorAll('.recent-chip')].some((e) => e.dataset.recent === t),
          flashed: window.__flashed.has(t),
        }), targetId);
        const problems = [];
        if (!got.flashed) problems.push(`#${targetId} never received .${FLASH_CLASS}`);
        if (c.recent && !got.chip) problems.push(`no .recent-chip for #${targetId}`);
        if (problems.length) failed++;
        lines.push(`${problems.length ? 'FAIL' : 'PASS'} ${c.name}: ${problems.length ? problems.join('; ') : `#${targetId} flashed${c.recent ? ' and is a recent chip' : ' (section target, no recent entry expected)'}`}`);
      });
    } catch (e) {
      failed++;
      lines.push(`FAIL ${c.name}: threw: ${e.message.split('\n')[0]}`);
    }
  }
  record(failed ? 'FAIL' : 'PASS', 'handlers', comboLabel(combo), `${cases.length - failed}/${cases.length} click paths went through the JS handler\n${lines.join('\n')}`);
}

async function checkDeepLink(browser, combo, errors) {
  await withPage(browser, combo, { path: '/#biodiversity', settleMs: 1500, errors }, async (page) => {
    const m = await measureLanding(page, 'biodiversity');
    const problems = landingProblems(m, 'biodiversity');
    const gap = m.top - m.rhBottom;
    if (!m.missing && (gap < -1 || gap > 40)) problems.push(`top is ${gap.toFixed(1)}px from the running head, want 0 to 40`);
    if (problems.length) record('FAIL', 'deep link', comboLabel(combo), problems.join('; '));
    else record('PASS', 'deep link', comboLabel(combo), `/#biodiversity cold: ${gap.toFixed(0)}px below ${m.hasRh ? 'the running head' : 'the viewport top'}`);
  });
}

async function checkSearch(browser, combo, errors) {
  const phrase = 'loss of biodiversity';
  await withPage(browser, combo, { errors }, async (page) => {
    const colHTML = () => page.evaluate(() => document.querySelector('#biodiversity .entry__collocations')?.innerHTML ?? null);
    const before = await colHTML();
    await page.fill('#search-input', phrase);
    await page.waitForTimeout(500);
    const r = await page.evaluate((needle) => {
      const e = document.getElementById('biodiversity');
      const box = e?.getBoundingClientRect();
      // Adjacent .hl marks inside one parent are joined, so a phrase highlighted word by word still counts.
      const covered = e ? [...new Set([...e.querySelectorAll('.hl')].map((m) => m.parentElement))].some((p) => {
        const joined = [...p.querySelectorAll(':scope > .hl')].map((m) => m.textContent).join(' ').replace(/\s+/g, ' ').toLowerCase();
        return joined.includes(needle) || [...p.querySelectorAll(':scope > .hl')].some((m) => m.textContent.toLowerCase().includes(needle));
      }) : false;
      return {
        exists: !!e,
        visible: !!e && !e.hidden && e.checkVisibility() && box.width > 0 && box.height > 0,
        marks: e ? e.querySelectorAll('.hl').length : 0,
        covered,
        shown: document.querySelectorAll('.entry:not([hidden])').length,
        total: document.querySelectorAll('.entry').length,
        mastheadShown: (document.querySelector('.masthead')?.getBoundingClientRect().height ?? 0) > 1,
        h1: !!document.querySelector('h1')?.textContent.trim() && getComputedStyle(document.querySelector('h1')).display !== 'none',
        browseShown: [...document.querySelectorAll('.section:not([hidden]) .section__intro, .section:not([hidden]) .tagged-here')].filter((el) => el.checkVisibility()).length,
        firstTop: document.querySelector('.entry:not([hidden])')?.getBoundingClientRect().top ?? null,
      };
    }, phrase);
    const problems = [];
    // Under a query the front matter, masthead included, gives way so the first match sits near the top.
    if (r.mastheadShown) problems.push('the masthead is still showing under an active search');
    if (!r.h1) problems.push('the page lost its <h1> under an active search (the masthead should be visually hidden, not removed)');
    if (r.browseShown) problems.push(`${r.browseShown} topic intro(s) or Also Tagged Here block(s) still showing under an active search`);
    if (r.firstTop !== null && r.firstTop > MAX_FIRST_MATCH_TOP_PX) problems.push(`the first match starts ${Math.round(r.firstTop)}px down (want <= ${MAX_FIRST_MATCH_TOP_PX})`);
    if (!r.exists) problems.push('#biodiversity not in the page');
    else if (!r.visible) problems.push(`#biodiversity is hidden (${r.shown} entries shown for the query)`);
    if (r.exists && r.visible && r.marks === 0) problems.push('#biodiversity is visible but has no .hl mark');
    else if (r.exists && r.visible && !r.covered) problems.push(`#biodiversity has ${r.marks} .hl mark(s) but none covers the whole phrase "${phrase}"`);
    // Restore pin: clearing a search must give back the exact original collocation markup (the <b> emphasis).
    for (const q of ['ss', 'y · r']) {
      await page.fill('#search-input', q);
      await page.waitForTimeout(300);
      await page.fill('#search-input', '');
      await page.waitForTimeout(300);
      const after = await colHTML();
      const marks = await page.evaluate(() => document.querySelectorAll('mark.hl').length);
      if (after !== before) problems.push(`after searching "${q}" and clearing, #biodiversity collocations markup differs from the original`);
      if (marks) problems.push(`after searching "${q}" and clearing, ${marks} mark.hl remain`);
      if (!(await page.evaluate(() => (document.querySelector('.masthead')?.getBoundingClientRect().height ?? 0) > 100))) problems.push(`after searching "${q}" and clearing, the masthead is not back`);
    }
    if (r.shown >= r.total) problems.push(`the query did not filter anything (${r.shown} of ${r.total} entries shown)`);
    if (problems.length) record('FAIL', 'search collocation', comboLabel(combo), problems.join('; '));
    else record('PASS', 'search collocation', comboLabel(combo), `#biodiversity visible, .hl covers "${phrase}", ${r.shown} of ${r.total} entries shown`);
  });
}

// Scrolls through Transitions in small steps with the running head's pin released (a wheel event first), and
// returns, per stop, the category the nav marks current (the docked chip on phones, the sidebar sub-nav link at
// >=760px) and the one the running head names.
async function stepThroughTransitions(page, phone) {
  return page.evaluate(async (phone) => {
    const sec = document.getElementById('transitions');
    const start = sec.getBoundingClientRect().top + scrollY - 300;
    const end = sec.getBoundingClientRect().bottom + scrollY - innerHeight;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    scrollTo(0, start);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 })); // releases the pin and the scroll lock
    await frame();
    const sel = phone ? '#chips .chip[aria-current="true"]' : '.tab-subnav__link[aria-current="true"]';
    const out = [];
    for (let y = start; y <= end; y += 23) {
      scrollTo(0, y);
      await frame();
      const c = document.querySelector('.rh__cat');
      out.push({ y: Math.round(y), nav: norm(document.querySelector(sel)?.textContent), head: norm(c?.textContent),
        inTransitions: norm(document.querySelector('.rh__topic')?.textContent).startsWith('transitions'),
        overflow: !!c && c.scrollWidth > c.clientWidth });
    }
    return out;
  }, phone);
}

async function checkTransitions(browser, combo, errors) {
  const navName = combo.phone ? 'chip' : 'sub-nav link';
  await withPage(browser, combo, { errors }, async (page) => {
    const problems = [];
    let content = null;
    await page.click('.tab[data-target="transitions"]');
    if (!(await settle(page))) { record('FAIL', 'transitions', comboLabel(combo), NOT_SETTLED.detail); return; }
    await page.waitForTimeout(400);
    if (combo.phone) {
      const r = await page.evaluate(() => {
        const chips = document.getElementById('chips');
        const tabbar = document.querySelector('.tabbar');
        const rh = document.querySelector('.rh');
        const c = chips.getBoundingClientRect();
        return {
          visible: !chips.hidden && chips.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && c.width > 0 && c.height > 0,
          chipsBottom: c.bottom, chipsTop: c.top, tabTop: tabbar.getBoundingClientRect().top,
          rhBottom: rh ? rh.getBoundingClientRect().bottom : 0,
        };
      });
      if (!r.visible) problems.push('#chips is not visible in Transitions');
      const gap = r.chipsBottom - r.tabTop;
      if (Math.abs(gap) > 1) problems.push(`#chips bottom ${r.chipsBottom.toFixed(1)} is ${gap.toFixed(1)}px off the tab bar top ${r.tabTop.toFixed(1)}`);
      content = r.chipsTop - r.rhBottom;
      if (content < MIN_CHIPS_CONTENT_PX) problems.push(`only ${content.toFixed(0)}px of content between the running head and the chips (want >= ${MIN_CHIPS_CONTENT_PX})`);
    }
    // At every stop the nav and the running head name the same category, or both none (the section's heading and
    // intro). Every category must be reached, and at least one unpinned "none" stop, or the check proves nothing.
    const steps = await stepThroughTransitions(page, combo.phone);
    const cats = await page.$$eval('#transitions .category .category__name', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim().toLowerCase()));
    // Above the section the running head names Concepts' category; there the nav must mark nothing.
    const mismatch = steps.filter((st) => (!st.inTransitions ? st.nav !== '' : st.nav ? !rhCategoryFits(st.head, st.nav) : st.head !== ''));
    if (mismatch.length) problems.push(`${mismatch.length} of ${steps.length} scroll stops disagree, first at y ${mismatch[0].y}: ${navName} "${mismatch[0].nav}", running head "${mismatch[0].head}"`);
    const seen = new Set(steps.map((st) => st.nav).filter(Boolean));
    const unseen = cats.filter((c) => !seen.has(c));
    if (unseen.length) problems.push(`never current while stepping: ${unseen.join(', ')}`);
    if (!steps.some((st) => st.inTransitions && !st.nav && !st.head)) problems.push('no stop on the section heading with neither marked (the unpinned "none" branch was never reached)');
    // The running head's category is fitted, never cut: no overflow, and the full name wherever it fits.
    const over = steps.filter((st) => st.overflow);
    if (over.length) problems.push(`.rh__cat overflows at ${over.length} stop(s), first "${over[0].head}"`);
    if (!combo.phone) {
      const cut = steps.filter((st) => st.nav && st.head !== st.nav);
      if (cut.length) problems.push(`at ${combo.w}px the running head shortens "${cut[0].nav}" to "${cut[0].head}"`);
    } else {
      // Re-fit on resize: 390 -> 1440 shows the full name, back to 390 shortens it again.
      await page.click('#chips .chip[data-cat="opposition-limitation-contradiction"]');
      await settle(page);
      const head = () => page.evaluate(() => document.querySelector('.rh__cat').textContent.trim().toLowerCase());
      const narrow = await head();
      await page.setViewportSize({ width: 1440, height: combo.h });
      await page.waitForTimeout(300);
      const wide = await head();
      await page.setViewportSize({ width: combo.w, height: combo.h });
      await page.waitForTimeout(300);
      const back = await head();
      if (wide !== 'opposition / limitation / contradiction') problems.push(`after widening to 1440 the running head reads "${wide}", not the full name`);
      if (back !== narrow) problems.push(`after narrowing back the running head reads "${back}", was "${narrow}"`);
      if (narrow === wide) problems.push(`at ${combo.w}px the running head was not shortened ("${narrow}")`);
    }
    const summary = `${navName} and running head agree at all ${steps.length} scroll stops, all ${cats.length} categories reached, no overflow`;
    if (problems.length) record('FAIL', 'transitions', comboLabel(combo), problems.join('; '));
    else record('PASS', 'transitions', comboLabel(combo), combo.phone ? `chips dock on the tab bar, ${content.toFixed(0)}px of content above them; ${summary}` : summary);
  });
}

async function checkScreens(browser, combo, errors) {
  const saved = [];
  const shot = (page, name, opts = {}) => {
    const file = path.join(SHOTS, `${name}-${combo.w}-${combo.scheme}.png`);
    saved.push(path.relative(ROOT, file));
    return page.screenshot({ path: file, ...opts });
  };
  const states = [
    ['home', {}, async () => {}],
    ['environment', { path: '/#environment', settleMs: 1500 }, async () => {}],
    ['transitions', { path: '/#transitions', settleMs: 1500 }, async () => {}],
    ['society', { path: '/#society-culture', settleMs: 1500 }, async () => {}],
    // A returning visitor: three recently viewed words and the onboarding hint gone, so Recently Viewed shows
    ['home-returning', { returning: true }, async (p) => {
      if (!(await p.locator('#recent-section').isVisible())) throw new Error('#recent-section is not visible for a returning visitor');
    }],
    // The Also Tagged Here block scrolled to the middle of the viewport
    ['tagged-here', { path: '/#environment', settleMs: 1500 }, async (p) => {
      const block = p.locator('.tagged-here').first();
      if (!(await block.count())) throw new Error('no .tagged-here block rendered');
      await block.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await p.waitForTimeout(400);
    }],
    ['technology', { path: '/#technology-media', settleMs: 1500 }, async () => {}],
    ['search', {}, async (p) => { await p.fill('#search-input', 'biodiversity'); await p.waitForTimeout(500); }],
    ['empty', {}, async (p) => { await p.fill('#search-input', 'zzzzqq'); await p.waitForTimeout(500); }],
  ];
  await mkdir(SHOTS, { recursive: true });
  const problems = [];
  for (const [name, opts, act] of states) {
    try {
      await withPage(browser, combo, { ...opts, errors }, async (page) => { await act(page); await shot(page, name); });
    } catch (e) { problems.push(`${name}: ${e.message.split('\n')[0]}`); }
  }
  try {
    await withPage(browser, combo, { errors }, async (page) => {
      const wod = page.locator('#wod-section');
      if (!(await wod.isVisible())) throw new Error('#wod-section is not visible');
      await page.evaluate(() => scrollTo(0, 0));
      await shot(page, 'wod', { clip: await wod.boundingBox() });
    });
  } catch (e) { problems.push(`wod: ${e.message.split('\n')[0]}`); }
  if (combo.phone) {
    try {
      await withPage(browser, combo, { errors }, async (page) => {
        const r = await page.evaluate(() => ({
          brandLeft: document.querySelector('.topbar__brand').getBoundingClientRect().left,
          dieRight: document.querySelector('.btn-random').getBoundingClientRect().right,
          w: innerWidth,
        }));
        if (r.brandLeft < 16) throw new Error(`bottom bar: wordmark left ${r.brandLeft.toFixed(1)} < 16 (topbar padding dropped?)`);
        if (r.dieRight > r.w - 8) throw new Error(`bottom bar: random button right ${r.dieRight.toFixed(1)} > ${r.w - 8}`);
      });
    } catch (e) { problems.push(e.message.split('\n')[0]); }
  }
  if (problems.length) record('FAIL', 'screens', comboLabel(combo), problems.join('; '));
  else record('PASS', 'screens', comboLabel(combo), `${saved.length} screenshots written to .superpowers/shots/ (not a visual check: nothing asserts on their content)`);
}

// Runs last in each combination: reports everything logged by the pages above, plus its own tour of page states.
async function checkConsole(browser, combo, errors) {
  const tour = [
    { path: '/' }, { path: '/#environment' }, { path: '/#transitions' }, { path: '/#biodiversity' },
  ];
  for (const t of tour) await withPage(browser, combo, { ...t, settleMs: 1200, errors }, async () => {});
  await withPage(browser, combo, { errors }, async (page) => {
    await page.fill('#search-input', 'biodiversity'); await page.waitForTimeout(400);
    await page.fill('#search-input', 'zzzzqq'); await page.waitForTimeout(400);
    await page.fill('#search-input', ''); await page.waitForTimeout(300);
    await page.click('.btn-random'); await page.waitForTimeout(JUMP_WAIT_MS);
    await page.click('.tab[data-target="transitions"]'); await page.waitForTimeout(JUMP_WAIT_MS);
  });
  const fresh = errors.filter((e) => !isBaseline(e.url, e.text));
  const ignored = errors.length - fresh.length;
  const unique = [...new Map(fresh.map((e) => [`${e.kind}|${e.text}`, e])).values()];
  const note = ignored ? ` (${ignored} baseline error(s) ignored)` : '';
  if (!unique.length) record('PASS', 'console', comboLabel(combo), `no page errors or console errors${note}`);
  else record('FAIL', 'console', comboLabel(combo), `${fresh.length} unexpected error(s)${note}\n${unique.slice(0, 8).map((e) => `${e.kind}: ${e.text.slice(0, 140)}${e.url ? ` (${e.url})` : ''}`).join('\n')}`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, '-');
const BROWSER_CHECKS = [
  ['tokens', checkTokens],
  ['contrast', checkContrast],
  ['jumps', checkJumps],
  ['handlers', checkHandlers],
  ['deep link', checkDeepLink],
  ['search collocation', checkSearch],
  ['transitions', checkTransitions],
  ['screens', checkScreens],
  ['console', checkConsole], // last: it reports errors collected by the checks before it
];

function parseOnly(argv) {
  const i = argv.indexOf('--only');
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--only='))?.slice(7);
  if (i >= 0 && !raw) throw new Error('--only needs a comma-separated list of check names');
  return raw ? new Set(raw.split(',').map(norm)) : null;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

// With no BASE_URL: serve public/ on a free port. With a local BASE_URL: serve it there, and if the port is
// already taken make sure whatever answers is really this checkout's index.html (a stale server would make every
// result meaningless). A remote BASE_URL is used as is.
async function startServer() {
  const requested = process.env.BASE_URL?.replace(/\/$/, '');
  if (!requested) {
    const server = createServer();
    const port = await listen(server, 0, '127.0.0.1');
    return { server, url: `http://127.0.0.1:${port}` };
  }
  const url = new URL(requested);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return { server: null, url: requested };
  const server = createServer();
  try {
    await listen(server, Number(url.port || 80), url.hostname);
    return { server, url: requested };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
  }
  const served = await fetch(`${requested}/index.html`).then((r) => r.text()).catch((e) => `fetch failed: ${e.message}`);
  const disk = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
  if (served !== disk) throw new Error(`port ${url.port} is already in use by a server whose /index.html differs from public/index.html; stop it or use another BASE_URL`);
  console.log(`(port ${url.port} already serving, and its index.html equals public/index.html)`);
  return { server: null, url: requested };
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  const wanted = (name) => !only || only.has(norm(name));
  const known = new Set(['grep', ...BROWSER_CHECKS.map(([n]) => norm(n))]);
  for (const o of only || []) if (!known.has(o)) throw new Error(`unknown check "${o}". Known: ${[...known].join(', ')}`);

  const { server, url } = await startServer();
  BASE_URL = url;
  const served = await fetch(`${BASE_URL}/`).then((r) => r.text());
  RH_REQUIRED = RH_MARKUP_RE.test(served);
  console.log(`verify: ${BASE_URL}${only ? `  only=${[...only].join(',')}` : ''}  (.rh ${RH_REQUIRED ? 'REQUIRED: index.html has an element with class rh' : 'not required yet: no element with class rh in index.html'})`);
  let browser;
  try {
    if (wanted('grep')) await checkGrep();
    const browserChecks = BROWSER_CHECKS.filter(([n]) => wanted(n));
    if (browserChecks.length) {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      // The four combinations are independent (own browser contexts), so they run concurrently.
      await Promise.all(COMBOS.map(async (combo) => {
        const errors = [];
        for (const [name, fn] of browserChecks) {
          try {
            await fn(browser, combo, errors);
          } catch (e) {
            record('FAIL', name, comboLabel(combo), `threw: ${e.message.split('\n')[0]}`);
          }
        }
      }));
      const screensCheck = browserChecks.filter(([n]) => norm(n) === 'screens');
      await Promise.all(SCREEN_ONLY_COMBOS.filter(() => screensCheck.length).map(async (combo) => {
        try { await screensCheck[0][1](browser, combo, []); }
        catch (e) { record('FAIL', 'screens', comboLabel(combo), `threw: ${e.message.split('\n')[0]}`); }
      }));
      for (const combo of [...COMBOS, ...SCREEN_ONLY_COMBOS]) console.log((buffers.get(comboLabel(combo)) || []).join('\n'));
    }
  } finally {
    await browser?.close();
    await new Promise((r) => (server ? server.close(r) : r()));
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  process.exitCode = count('FAIL') ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
