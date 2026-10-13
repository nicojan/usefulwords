#!/usr/bin/env node
// End-to-end verification harness for the usefulwords dictionary redesign.
//
//   node scripts/verify.mjs                 run every check (starts/stops serve.mjs itself for a local BASE_URL)
//   node scripts/verify.mjs --only jumps,console
//   BASE_URL=https://usefulwords.forhuman.ca node scripts/verify.mjs
//
// Prints one line per check and viewport/scheme combination (PASS / FAIL / SKIP), exits 1 on any FAIL.
// Needs playwright-core (`npm install --no-save playwright-core@1.49.1`) and Google Chrome.
// Spec: _meta/plans/2026-10-13-usefulwords-dictionary-redesign.md ("Hard constraint: JS hooks",
// "Colour", "Running head", "Verification").

import { chromium } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, '.superpowers', 'shots');
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

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

// Ban-list patterns that are allowed to appear, as { 'pattern name': 'reason' }. Empty on purpose:
// every exception has to be argued for here.
const GREP_ALLOWLIST = {};

const GREP_FILES = ['public/css/styles.css', 'public/js/app.js', 'public/index.html'];
const GREP_PATTERNS = [
  ['text-transform: uppercase', /text-transform\s*:\s*uppercase/i],
  ['letter-spacing', /letter-spacing/i],
  ['box-shadow', /box-shadow/i],
  ['drop-shadow', /drop-shadow/i],
  ['backdrop-filter', /backdrop-filter/i],
  ['outline: none', /outline\s*:\s*none/i],
  ['border-radius: 999', /border-radius\s*:\s*999/i],
  ['--tint', /--tint/],
  ['SECTION_TINT_VAR', /SECTION_TINT_VAR/],
  ['applyTint', /applyTint/],
  ['tab__dot', /tab__dot/],
  ['dice emoji', /\u{1F3B2}/u],
  ['Fraunces', /Fraunces/],
  ['IBM Plex', /IBM Plex/],
];
// 'border-left on example blocks' is handled separately (it needs the selector, not just the line).

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
const FLASH_CLASS = 'is-target'; // what flashTarget() in app.js adds
// localStorage names used by app.js; the hint one being set means the onboarding hint is gone (a returning visitor)
const STORE = { recent: 'uw_recent_v1', hint: 'uw_hint_dismissed_v1' };
const MIN_CHIPS_CONTENT_PX = 380;

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
  const rgb = (c) => 'rgb(' + [c.r, c.g, c.b].map((v) => Math.round(v)).join(',') + ')';
  window.__v = { parseColor, over, ratio, backgroundOf, opacityOf, describe, rgb };
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
const comboLabel = (c) => `${c.w} ${c.scheme}`;

// ---------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------

function isBaseline(url, text) {
  return BASELINE_ERRORS.some((b) => b.url.test(url) && b.text.test(text));
}

// A fresh browser context per page keeps localStorage (recently viewed) from leaking between checks.
async function openPage(browser, combo, { path: p = '/', recent, returning = false, settleMs = 400, errors } = {}) {
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

// Waits the spec's 1200ms, then until scroll position and document height have been still for 500ms. Chrome's smooth scroll takes longer
// for long jumps (a random word 40,000px away is still moving at 1200ms), so measuring at a fixed time
// would report a scroll in flight as a bad landing.
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
}

// ---------------------------------------------------------------------------
// Landing measurement (shared by jumps, deep link, swipe)
// ---------------------------------------------------------------------------

async function measureLanding(page, id) {
  return page.evaluate((targetId) => {
    const target = document.getElementById(targetId);
    if (!target) return { missing: true };
    const rh = document.querySelector('.rh');
    const rhBottom = rh ? rh.getBoundingClientRect().bottom : 0;
    const r = target.getBoundingClientRect();
    const section = target.closest('.section');
    const category = target.closest('.category');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return {
      top: r.top,
      bottom: r.bottom,
      rhBottom,
      vh: innerHeight,
      vw: innerWidth,
      left: r.left,
      hasRh: !!rh,
      rhTopic: rh ? norm(rh.querySelector('.rh__topic')?.textContent) : '',
      rhCat: rh ? norm(rh.querySelector('.rh__cat')?.textContent) : '',
      sectionTitle: norm(section?.querySelector('.section__title-en')?.textContent),
      categoryName: norm(category?.querySelector('.category__name')?.textContent),
      targetIsSection: target.classList.contains('section'),
    };
  }, id);
}

function landingProblems(m, id) {
  if (m.missing) return [`target #${id} not found`];
  const problems = [];
  if (m.top < m.rhBottom - 1) problems.push(`#${id} top ${m.top.toFixed(1)} is under the running head (bottom ${m.rhBottom.toFixed(1)})`);
  if (m.top >= m.vh || m.bottom <= 0 || m.left >= m.vw) problems.push(`#${id} is outside the viewport (top ${m.top.toFixed(1)}, vh ${m.vh})`);
  if (m.hasRh) {
    if (m.sectionTitle && !m.rhTopic.includes(m.sectionTitle)) problems.push(`running head topic "${m.rhTopic}" lacks "${m.sectionTitle}"`);
    if (m.categoryName && !m.rhCat.includes(m.categoryName)) problems.push(`running head category "${m.rhCat}" lacks "${m.categoryName}"`);
  }
  return problems;
}

const landingSummary = (m) => `top ${m.top.toFixed(0)}px, running head bottom ${m.rhBottom.toFixed(0)}px${m.hasRh ? '' : ' (no .rh yet, using viewport top)'}`;

// ---------------------------------------------------------------------------
// Checks that do not need a browser
// ---------------------------------------------------------------------------

function cssRules(source) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const line = source.slice(0, m.index + m[1].length - m[1].trimStart().length).split('\n').length;
    rules.push({ selector: m[1].trim(), body: m[2], line });
  }
  return rules;
}

async function checkGrep() {
  const hits = [];
  for (const rel of GREP_FILES) {
    const text = await readFile(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const [name, re] of GREP_PATTERNS) {
        if (re.test(line)) hits.push({ name, file: rel, line: i + 1, text: line.trim() });
      }
      if (!rel.endsWith('.css') && /border-left/i.test(line) && /example/i.test(line)) {
        hits.push({ name: 'border-left on example blocks', file: rel, line: i + 1, text: line.trim() });
      }
    });
    if (rel.endsWith('.css')) {
      for (const r of cssRules(text)) {
        if (/example/i.test(r.selector) && /border-(left|inline-start)/i.test(r.body)) {
          hits.push({ name: 'border-left on example blocks', file: rel, line: r.line, text: `${r.selector} { border-left ... }` });
        }
      }
    }
  }
  const live = hits.filter((h) => !(h.name in GREP_ALLOWLIST));
  const allowed = hits.length - live.length;
  const counts = {};
  for (const h of live) counts[h.name] = (counts[h.name] || 0) + 1;
  const summary = Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(', ');
  const samples = Object.keys(counts).map((n) => {
    const h = live.find((x) => x.name === n);
    return `${n}: ${h.file}:${h.line}  ${h.text.slice(0, 70)}`;
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

// Measures every visible text element, plus the .rh rule and heading rules, in the current page state.
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
    items.push({ kind: 'text', sel: v.describe(el), text: text.slice(0, 28), fg: v.rgb(v.over(fg, bg.color)), bg: v.rgb(bg.color), ratio: v.ratio(v.over(fg, bg.color), bg.color), req: 4.5, image: bg.image });
  }
  const input = document.querySelector('input[placeholder]');
  if (input && input.getAttribute('placeholder').trim() && input.checkVisibility()) {
    const bg = v.backgroundOf(input);
    const fg = v.parseColor(getComputedStyle(input, '::placeholder').color);
    items.push({ kind: 'text', sel: 'input::placeholder', text: input.getAttribute('placeholder'), fg: v.rgb(v.over(fg, bg.color)), bg: v.rgb(bg.color), ratio: v.ratio(v.over(fg, bg.color), bg.color), req: 4.5, image: bg.image });
  }
  const ruleEls = new Set([...document.querySelectorAll('.rh')]);
  for (const h of document.querySelectorAll('main h2')) { ruleEls.add(h); if (h.closest('header')) ruleEls.add(h.closest('header')); }
  for (const el of ruleEls) {
    if (!el.checkVisibility({ checkVisibilityCSS: true })) continue;
    const cs = getComputedStyle(el);
    const bg = v.backgroundOf(el.parentElement || el);
    for (const side of ['Top', 'Bottom']) {
      if (parseFloat(cs[`border${side}Width`]) <= 0 || cs[`border${side}Style`] === 'none') continue;
      const line = v.over(v.parseColor(cs[`border${side}Color`]), bg.color);
      items.push({ kind: 'rule', sel: `${v.describe(el)} border-${side.toLowerCase()}`, text: `${cs[`border${side}Width`]} rule`, fg: v.rgb(line), bg: v.rgb(bg.color), ratio: v.ratio(line, bg.color), req: 3, image: false });
    }
  }
  return items;
}

async function checkContrast(browser, combo) {
  const all = new Map();
  const collect = async (page) => {
    for (const it of await page.evaluate(measureContrastInPage)) all.set(`${it.kind}|${it.sel}|${it.text}`, it);
  };
  await withPage(browser, combo, {}, async (page) => {
    await collect(page); // home
    await page.click('.tab[data-target="transitions"]');
    await page.waitForTimeout(1500);
    await collect(page); // Transitions: chips and sub-nav visible
    await page.fill('#search-input', 'biodiversity');
    await page.waitForTimeout(500);
    await collect(page); // search results with highlight marks
  });
  const items = [...all.values()];
  const failing = items.filter((i) => i.ratio < i.req);
  const worst = [...items].sort((a, b) => a.ratio / a.req - b.ratio / b.req).slice(0, 5);
  const rules = items.filter((i) => i.kind === 'rule').length;
  const lines = worst.map((i) => `${i.ratio.toFixed(2)}:1 (needs ${i.req}) ${i.sel} "${i.text}" ${i.fg} on ${i.bg}`);
  const images = items.filter((i) => i.image).length;
  const note = images ? ` ${images} sit over a background image (measured against the colour layers only).` : '';
  const head = `${items.length - rules} text elements and ${rules} rules measured, ${failing.length} below threshold.${note} Worst five:`;
  record(failing.length ? 'FAIL' : 'PASS', 'contrast', comboLabel(combo), `${head}\n${lines.join('\n')}`);
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

async function runClickJump(browser, combo, name, errors, returning) {
  return withPage(browser, combo, { ...JUMP_PAGE_OPTS[name], returning, errors }, async (page) => {
    const { loc, attr, wrap } = await JUMP_TARGETS[name](page);
    if (!(await loc.count())) return { status: 'FAIL', detail: 'nothing to click: selector matched no element' };
    if (!(await loc.isVisible())) {
      const why = name === 'chip' ? 'chips are hidden at this width (sub-nav is used)' : name === 'sub-nav' ? 'sub-nav is hidden at this width (chips are used)' : 'element is not visible';
      return { status: name === 'chip' || name === 'sub-nav' ? 'SKIP' : 'FAIL', detail: why };
    }
    const raw = await loc.getAttribute(attr);
    const id = wrap ? wrap(raw) : raw;
    await loc.click({ timeout: 5000 });
    await settle(page);
    const m = await measureLanding(page, id);
    const problems = landingProblems(m, id);
    return problems.length ? { status: 'FAIL', detail: problems.join('; ') } : { status: 'PASS', detail: `#${id}: ${landingSummary(m)}` };
  });
}

async function runRandomJumps(browser, combo, errors, returning) {
  return withPage(browser, combo, { returning, errors }, async (page) => {
    const notes = [];
    const problems = [];
    for (let i = 0; i < 5; i++) {
      await page.click('.btn-random');
      await settle(page);
      const id = await page.evaluate(() => decodeURIComponent(location.hash.slice(1)));
      const m = await measureLanding(page, id);
      const p = landingProblems(m, id);
      if (p.length) problems.push(...p); else notes.push(`#${id} top ${m.top.toFixed(0)}`);
    }
    return problems.length ? { status: 'FAIL', detail: problems.join('; ') } : { status: 'PASS', detail: `5 random words landed: ${notes.join(', ')}` };
  });
}

async function runSwipeJump(browser, combo, errors, returning) {
  if (!combo.phone) return { status: 'SKIP', detail: 'touch gesture, checked on the 390px phone layout only' };
  return withPage(browser, combo, { path: '/#society-culture', settleMs: 1500, returning, errors }, async (page, context) => {
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
    await settle(page);
    if ((await page.evaluate(() => window.__touches)) === 0) {
      return { status: 'SKIP', detail: 'CDP Input.dispatchTouchEvent did not deliver a touchstart to the page' };
    }
    const m = await measureLanding(page, next);
    const problems = landingProblems(m, next);
    return problems.length ? { status: 'FAIL', detail: problems.join('; ') } : { status: 'PASS', detail: `swipe left from #${plan.current} to #${next}: ${landingSummary(m)}` };
  });
}

// Each jump runs for a first-time visitor (the "Tap a topic to explore" hint is showing, and collapses on the
// first scroll past 240px, shifting the page up under a smooth scroll already in flight) and for a returning
// visitor (hint already dismissed, localStorage). They are separate states a student can be in.
async function checkJumps(browser, combo, errors) {
  const names = [...Object.keys(JUMP_TARGETS), 'random', 'swipe'];
  const visitors = [['first visit', false], ['returning', true]];
  const outcomes = [];
  for (const [visitor, returning] of visitors) {
    for (const name of names) {
      let out;
      try {
        out = name === 'random' ? await runRandomJumps(browser, combo, errors, returning)
          : name === 'swipe' ? await runSwipeJump(browser, combo, errors, returning)
            : await runClickJump(browser, combo, name, errors, returning);
      } catch (e) {
        out = { status: 'FAIL', detail: `threw: ${e.message.split('\n')[0]}` };
      }
      outcomes.push({ name: `${name} (${visitor})`, ...out });
    }
  }
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
  await withPage(browser, combo, { errors }, async (page) => {
    await page.fill('#search-input', 'loss of biodiversity');
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const e = document.getElementById('biodiversity');
      const box = e?.getBoundingClientRect();
      return { exists: !!e, visible: !!e && !e.hidden && e.checkVisibility() && box.width > 0 && box.height > 0, marks: e ? e.querySelectorAll('.hl').length : 0, shown: document.querySelectorAll('.entry:not([hidden])').length };
    });
    const problems = [];
    if (!r.exists) problems.push('#biodiversity not in the page');
    else if (!r.visible) problems.push(`#biodiversity is hidden (${r.shown} entries shown for the query)`);
    if (r.exists && r.visible && r.marks === 0) problems.push('#biodiversity is visible but has no .hl mark');
    if (problems.length) record('FAIL', 'search collocation', comboLabel(combo), problems.join('; '));
    else record('PASS', 'search collocation', comboLabel(combo), `#biodiversity visible with ${r.marks} .hl mark(s), ${r.shown} entries shown`);
  });
}

async function checkTransitions(browser, combo, errors) {
  if (!combo.phone) {
    record('SKIP', 'transitions', comboLabel(combo), 'the docked chips row is a phone layout; checked at 390 only');
    return;
  }
  await withPage(browser, combo, { errors }, async (page) => {
    await page.click('.tab[data-target="transitions"]');
    await settle(page);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const chips = document.getElementById('chips');
      const tabbar = document.querySelector('.tabbar');
      const rh = document.querySelector('.rh');
      const c = chips.getBoundingClientRect();
      return {
        visible: !chips.hidden && chips.checkVisibility({ checkVisibilityCSS: true }) && c.width > 0 && c.height > 0,
        chipsBottom: c.bottom, chipsTop: c.top, tabTop: tabbar.getBoundingClientRect().top,
        rhBottom: rh ? rh.getBoundingClientRect().bottom : 0,
      };
    });
    const problems = [];
    if (!r.visible) problems.push('#chips is not visible in Transitions');
    const gap = r.chipsBottom - r.tabTop;
    if (Math.abs(gap) > 1) problems.push(`#chips bottom ${r.chipsBottom.toFixed(1)} is ${gap.toFixed(1)}px off the tab bar top ${r.tabTop.toFixed(1)}`);
    const content = r.chipsTop - r.rhBottom;
    if (content < MIN_CHIPS_CONTENT_PX) problems.push(`only ${content.toFixed(0)}px of content between the running head and the chips (want >= ${MIN_CHIPS_CONTENT_PX})`);
    if (problems.length) record('FAIL', 'transitions', comboLabel(combo), problems.join('; '));
    else record('PASS', 'transitions', comboLabel(combo), `chips dock on the tab bar, ${content.toFixed(0)}px of content above them`);
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
  if (problems.length) record('FAIL', 'screens', comboLabel(combo), problems.join('; '));
  else record('PASS', 'screens', comboLabel(combo), `${saved.length} screenshots in .superpowers/shots/`);
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

async function startLocalServer() {
  const url = new URL(BASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return null;
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') { console.log(`(port ${url.port} already serving, using it)`); resolve(null); } else reject(err);
    });
    server.listen(Number(url.port || 80), url.hostname, () => resolve(server));
  });
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  const wanted = (name) => !only || only.has(norm(name));
  const known = new Set(['grep', ...BROWSER_CHECKS.map(([n]) => norm(n))]);
  for (const o of only || []) if (!known.has(o)) throw new Error(`unknown check "${o}". Known: ${[...known].join(', ')}`);

  console.log(`verify: ${BASE_URL}${only ? `  only=${[...only].join(',')}` : ''}`);
  const server = await startLocalServer();
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
      for (const combo of COMBOS) console.log((buffers.get(comboLabel(combo)) || []).join('\n'));
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
