#!/usr/bin/env node
// Portfolio capture: the case-study clips and stills, recorded from a local server in headless Chrome.
//
//   node scripts/capture.mjs <out-dir>                    every clip and still
//   node scripts/capture.mjs <out-dir> --only hero,search
//   JUNE_ROOT=/path/to/june/public node scripts/capture.mjs <out-dir> --only landing,june-still
//       (June's build: git archive d9bb74f public | tar -x -C /some/dir; clip "landing" and still "june-still" need it)
//
// Frames come from the DevTools screencast at device pixels: Chrome runs with --force-device-scale-factor and the
// viewport is set with a metrics override that keeps that real scale (an emulated scale would cap frames at CSS
// size). Frames carry timestamps, so ffmpeg rebuilds real timing at a constant 60 fps. No browser chrome, no
// cursor, no keyboard. Needs playwright-core, Google Chrome and ffmpeg (libx264, libsvtav1). Brief: BRIEF-portfolio.md.

import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
if (!OUT) { console.error('usage: node scripts/capture.mjs <out-dir> [--only a,b]'); process.exit(2); }
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

const PHONE = { width: 390, height: 844, dpr: 3, mobile: true };
const DESKTOP = { width: 1200, height: 800, dpr: 2, mobile: false };
// The word of the day is picked from the local date (app.js pickWodId); 2026-10-17 gives "emissions".
const CLOCK = new Date(2026, 9, 17, 10, 0, 0).getTime();
const RETURNING = { uw_hint_dismissed_v1: 'true', uw_recent_v1: JSON.stringify(['mitigate', 'alleviate', 'workforce']) };
const HOLD_MS = 900;   // still frames at each end, so the loop seam falls on a rest
const FLASH_MS = 1500; // flashTarget's 1.4s highlight, plus a frame of margin

// --- Static server (any root, so June's build can be served too) ---
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function serve(root) {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, path.normalize(p));
      if (!file.startsWith(root)) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}/` };
}

// --- A page at a device size, with real device pixels ---
async function openPage(base, device, { scheme = 'light', storage = RETURNING, clock = CLOCK, hash = '' } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: [`--force-device-scale-factor=${device.dpr}`, `--window-size=${device.width + 200},${device.height + 200}`, '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({ viewport: null, hasTouch: device.mobile, colorScheme: scheme, reducedMotion: 'no-preference' });
  // Shift the clock (time keeps running, so the app's scroll lock and timers behave normally) and seed storage.
  await ctx.addInitScript(({ clock, storage }) => {
    if (clock) {
      const Real = Date; const off = clock - Real.now();
      class Shifted extends Real { constructor(...a) { super(...(a.length ? a : [Real.now() + off])); } static now() { return Real.now() + off; } }
      globalThis.Date = Shifted;
    }
    if (storage && !sessionStorage.getItem('__seeded')) {
      localStorage.clear();
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
      sessionStorage.setItem('__seeded', '1');
    }
  }, { clock, storage });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: device.width, height: device.height, deviceScaleFactor: 0, mobile: device.mobile });
  if (device.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
  // Warm load: fonts use font-display: optional, so only a cached second load is sure to paint Literata and Noto.
  await page.goto(base + hash);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.goto('about:blank');
  await page.goto(base + hash);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(hash ? 2000 : 1000); // a deep link flashes its target; let it fade
  const fonts = await page.evaluate(() => ['Literata', 'Atkinson Hyperlegible Next', 'Noto Sans TC'].map((f) => [f, document.fonts.check(`16px "${f}"`, f === 'Noto Sans TC' ? '詞' : 'a')]));
  const missing = fonts.filter(([, ok]) => !ok).map(([f]) => f);
  if (missing.length) console.warn(`  warning: font(s) not loaded: ${missing.join(', ')}`);
  return { browser, page, cdp };
}

// --- Recording ---
async function record(cdp, device, act) {
  const frames = [];
  const onFrame = async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1,
    maxWidth: device.width * device.dpr, maxHeight: device.height * device.dpr });
  const t0 = Date.now() / 1000;
  await new Promise((r) => setTimeout(r, HOLD_MS));
  await act();
  await new Promise((r) => setTimeout(r, HOLD_MS));
  const tEnd = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  if (!frames.length) throw new Error('no frames captured');
  return { frames, span: tEnd - t0, end: frames[0].t + (tEnd - t0) };
}

async function encode(name, rec) {
  const dir = path.join(OUT, '.frames', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const lines = ['ffconcat version 1.0'];
  let total = 0;
  for (let i = 0; i < rec.frames.length; i++) {
    const f = rec.frames[i];
    const file = `f${String(i).padStart(5, '0')}.jpg`;
    await writeFile(path.join(dir, file), Buffer.from(f.data, 'base64'));
    const next = i + 1 < rec.frames.length ? rec.frames[i + 1].t : Math.max(rec.end, f.t + 1 / 60);
    const d = Math.max(1 / 120, next - f.t);
    total += d;
    lines.push(`file ${file}`, `duration ${d.toFixed(5)}`);
  }
  lines.push(`file f${String(rec.frames.length - 1).padStart(5, '0')}.jpg`); // concat demuxer drops the last duration otherwise
  await writeFile(path.join(dir, 'list.ffconcat'), lines.join('\n') + '\n');
  const list = path.join(dir, 'list.ffconcat');
  const mp4 = path.join(OUT, `${name}.mp4`);
  const webm = path.join(OUT, `${name}.webm`);
  // -t: the concat demuxer pads after the trailing entry, so cut to the summed durations.
  const common = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=60,format=yuv420p', '-an', '-t', total.toFixed(3)];
  const quiet = { stdio: ['ignore', 'ignore', 'pipe'] }; // SVT-AV1 prints its config to stderr regardless of -loglevel
  execFileSync('ffmpeg', [...common, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'stillimage', '-movflags', '+faststart', mp4], quiet);
  execFileSync('ffmpeg', [...common, '-c:v', 'libsvtav1', '-crf', '30', '-preset', '6', webm], quiet);
  // First and last frames as stills, for checking the loop seam.
  await writeFile(path.join(dir, 'first.jpg'), Buffer.from(rec.frames[0].data, 'base64'));
  await writeFile(path.join(dir, 'last.jpg'), Buffer.from(rec.frames.at(-1).data, 'base64'));
  console.log(`  ${name}: ${rec.frames.length} frames over ${rec.span.toFixed(2)}s -> ${path.basename(mp4)}, ${path.basename(webm)}`);
}

// --- Helpers for acting like a person ---
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function tapEl(page, selector, { inViewport = true } = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const vw = await page.evaluate(() => innerWidth);
  // Tap the visible part (a chip can hang off the edge of its scrolling row).
  const left = Math.max(box.x, 0); const right = Math.min(box.x + box.width, inViewport ? vw : box.x + box.width);
  await page.touchscreen.tap((left + right) / 2, box.y + box.height / 2);
}
async function clickEl(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
}
async function settled(page, extra = 0) {
  // Rest: scrollY unchanged for 10 frames.
  await page.evaluate(() => new Promise((res) => {
    let last = -1; let still = 0;
    const tick = () => { const y = scrollY; still = y === last ? still + 1 : 0; last = y; if (still >= 10) res(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  if (extra) await wait(extra);
}

// --- Clips ---
const CLIPS = {
  // 1. Hero and homepage card: mitigate -> alleviate -> mitigate. The running head names the destination at the tap.
  hero: async (base) => {
    const { browser, page, cdp } = await openPage(base, PHONE, { scheme: 'light', hash: '#mitigate' });
    const rec = await record(cdp, PHONE, async () => {
      await wait(600);
      await tapEl(page, '#mitigate .see-chip[data-see="alleviate"]');
      await settled(page, FLASH_MS + 1200);
      await tapEl(page, '#alleviate .see-chip[data-see="mitigate"]');
      await settled(page, FLASH_MS);
    });
    await browser.close();
    return rec;
  },
  // 2. The docked Transitions row: in from Concepts, choose a move, back to Concepts.
  transitions: async (base) => {
    const { browser, page, cdp } = await openPage(base, PHONE, { scheme: 'dark', hash: '#concepts' });
    const rec = await record(cdp, PHONE, async () => {
      await tapEl(page, '.tab[data-target="transitions"]');
      await settled(page, 900);
      await tapEl(page, '#chips .chip[data-cat="opposition-limitation-contradiction"]');
      await settled(page, 2400);
      await tapEl(page, '.tab[data-target="concepts"]');
      await settled(page, 400);
    });
    await browser.close();
    return rec;
  },
  // 3. Search in the language you think in: 減輕, then "tackle", then Esc back to the front matter.
  search: async (base) => {
    const { browser, page, cdp } = await openPage(base, DESKTOP, { scheme: 'light' });
    const rec = await record(cdp, DESKTOP, async () => {
      await clickEl(page, '#search-input');
      await wait(450);
      await page.keyboard.insertText('減');
      await wait(320);
      await page.keyboard.insertText('輕');
      await wait(2600);
      await page.keyboard.press('ControlOrMeta+A');
      await wait(250);
      await page.keyboard.type('tackle', { delay: 110 });
      await wait(2600);
      await page.keyboard.press('Escape');
      await wait(400);
    });
    await browser.close();
    return rec;
  },
  // 4. Desktop: the running head follows a wheel scroll, then the sidebar jumps to a move and back.
  desktop: async (base) => {
    const { browser, page, cdp } = await openPage(base, DESKTOP, { scheme: 'dark', hash: '#environment' });
    await page.mouse.move(760, 420);
    const rec = await record(cdp, DESKTOP, async () => {
      for (let i = 0; i < 70; i++) { await page.mouse.wheel(0, 34); await wait(16); }
      await settled(page, 900);
      await clickEl(page, '.tab-subnav__link[data-cat="opposition-limitation-contradiction"]');
      await settled(page, 1800);
      await clickEl(page, '.tab[data-target="environment"]');
      await settled(page, 300);
      await page.mouse.move(760, 420);
    });
    await browser.close();
    return rec;
  },
  // 5. June and October, a first visit: Environment tab, then the see-also link to "ecosystem". Rendered side by side.
  landing: async (base) => {
    if (!process.env.JUNE_ROOT) throw new Error('set JUNE_ROOT to the June build (see the header)');
    const june = await serve(path.resolve(process.env.JUNE_ROOT));
    const recs = [];
    for (const b of [june.base, base]) {
      const { browser, page, cdp } = await openPage(b, PHONE, { scheme: 'light', storage: {}, clock: null });
      await page.evaluate(() => localStorage.clear()); // a true first visit, after the warm load
      await page.reload(); await page.evaluate(() => document.fonts.ready); await wait(1000);
      recs.push(await record(cdp, PHONE, async () => {
        await tapEl(page, '.tab[data-target="environment"]');
        await settled(page, 700);
        await tapEl(page, '#biodiversity .see-chip[data-see="ecosystem"]');
        await settled(page, FLASH_MS + 600);
      }));
      console.log(`  landing ${b === june.base ? 'june' : 'october'}: ecosystem top ${await page.evaluate(() => Math.round(document.getElementById('ecosystem').getBoundingClientRect().top))}px`);
      await browser.close();
    }
    june.srv.close();
    return recs;
  },
};

// --- Stills ---
const STILLS = {
  'still-front-matter': async (base) => {
    const { browser, page } = await openPage(base, PHONE, { scheme: 'light' });
    await page.screenshot({ path: path.join(OUT, 'still-front-matter-390-light.png'), scale: 'device' });
    await browser.close();
  },
  'still-entry': async (base) => {
    const { browser, page } = await openPage(base, PHONE, { scheme: 'dark', hash: '#mitigate' });
    const el = page.locator('#mitigate');
    const box = await el.boundingBox();
    await page.screenshot({ path: path.join(OUT, 'still-entry-mitigate-390-dark.png'), scale: 'device',
      clip: { x: 0, y: Math.max(0, box.y - 20), width: 390, height: box.height + 40 } });
    await browser.close();
  },
  'still-desktop': async (base) => {
    const { browser, page } = await openPage(base, DESKTOP, { scheme: 'light', hash: '#environment' });
    await page.screenshot({ path: path.join(OUT, 'still-desktop-environment-1200-light.png'), scale: 'device' });
    await browser.close();
  },
  'still-transitions': async (base) => {
    const { browser, page } = await openPage(base, PHONE, { scheme: 'light', hash: '#concepts' });
    await tapEl(page, '.tab[data-target="transitions"]'); await settled(page, 600);
    await tapEl(page, '#chips .chip[data-cat="opposition-limitation-contradiction"]'); await settled(page, FLASH_MS);
    await page.screenshot({ path: path.join(OUT, 'still-transitions-390-light.png'), scale: 'device' });
    await browser.close();
  },
  'still-environment': async (base) => {
    const { browser, page } = await openPage(base, PHONE, { scheme: 'light', hash: '#environment' });
    await page.screenshot({ path: path.join(OUT, 'still-environment-october-390-light.png'), scale: 'device' });
    await browser.close();
  },
  'june-still': async () => {
    if (!process.env.JUNE_ROOT) throw new Error('set JUNE_ROOT to the June build (see the header)');
    const june = await serve(path.resolve(process.env.JUNE_ROOT));
    const { browser, page } = await openPage(june.base, PHONE, { scheme: 'light', hash: '#environment', clock: null });
    await page.screenshot({ path: path.join(OUT, 'still-environment-june-390-light.png'), scale: 'device' });
    await browser.close(); june.srv.close();
  },
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const { srv, base } = await serve(ROOT);
  try {
    for (const [name, run] of Object.entries(CLIPS)) {
      if (ONLY && !ONLY.has(name)) continue;
      console.log(`clip ${name}`);
      const rec = await run(base);
      if (Array.isArray(rec)) {
        await encode(`${name}-june`, rec[0]);
        await encode(`${name}-october`, rec[1]);
        // Side by side, June left, October right, each at its own length (the shorter holds its last frame).
        const a = path.join(OUT, `${name}-june.mp4`); const b = path.join(OUT, `${name}-october.mp4`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-i', b, '-filter_complex',
          '[0:v]tpad=stop_mode=clone:stop_duration=3[l];[1:v]tpad=stop_mode=clone:stop_duration=3[r];[l][r]hstack=inputs=2:shortest=0,trim=duration=' +
          Math.max(rec[0].span, rec[1].span).toFixed(2) + ',format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
          '-movflags', '+faststart', path.join(OUT, `${name}-side-by-side.mp4`)]);
        console.log(`  ${name}-side-by-side.mp4`);
      } else {
        await encode(name, rec);
      }
    }
    for (const [name, run] of Object.entries(STILLS)) {
      if (ONLY && !ONLY.has(name)) continue;
      console.log(`still ${name}`);
      await run(base);
    }
  } finally {
    srv.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
