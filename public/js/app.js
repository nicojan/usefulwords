/* ------------------------------------------------------------
   Useful Words — render, search, navigate.
   Reads window.UW_DATA, builds the DOM, wires up interactions.
   ------------------------------------------------------------ */
(function () {
  "use strict";

  const DATA = window.UW_DATA;
  if (!DATA) {
    console.error("UW_DATA missing");
    return;
  }

  const root = document.getElementById("entries");
  const empty = document.getElementById("empty-state");
  const countEl = document.getElementById("entry-count");
  const searchInput = document.getElementById("search-input");
  const searchClear = document.querySelector(".search__clear");
  const tabs = Array.from(document.querySelectorAll(".tab"));

  // --- Utilities ---------------------------------------------------

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escAttr(s) {
    return esc(s);
  }

  function regexEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- Index for cross-lookup (seeAlso) ---------------------------

  const idIndex = Object.create(null); // id -> { sectionId, categoryId? }
  function indexEntries() {
    for (const sec of DATA.sections) {
      if (sec.entries) {
        for (const e of sec.entries) idIndex[e.id] = { section: sec.id };
      }
      if (sec.categories) {
        for (const cat of sec.categories) {
          for (const e of cat.entries) {
            idIndex[e.id] = { section: sec.id, category: cat.id };
          }
        }
      }
    }
  }

  // --- Render ------------------------------------------------------

  function entryHTML(entry, headingLevel) {
    const hTag = `h${headingLevel}`;
    const examples = entry.examples
      .map(
        (ex) => `
          <div class="entry__example">
            ${ex.en ? `<div class="entry__example-en">${esc(ex.en)}</div>` : ""}
            ${ex.zh ? `<div class="entry__example-zh" lang="zh-Hant">${esc(ex.zh)}</div>` : ""}
          </div>`
      )
      .join("");

    const seeAlso = (entry.seeAlso || [])
      .filter((id) => idIndex[id])
      .map(
        (id) =>
          `<a class="see-chip" href="#${escAttr(id)}" data-see="${escAttr(id)}">${esc(
            wordFor(id) || id
          )}</a>`
      )
      .join("");

    return `
      <article class="entry" id="${escAttr(entry.id)}"
               data-word="${escAttr(entry.word.toLowerCase())}"
               data-def="${escAttr((entry.definition.en || "").toLowerCase())}"
               data-zh="${escAttr(entry.definition.zh || "")}"
               data-ex="${escAttr(allExampleText(entry).toLowerCase())}">
        <header class="entry__head">
          <${hTag} class="entry__word">${esc(entry.word)}</${hTag}>
        </header>
        <div class="entry__def">
          ${entry.definition.en ? `<p class="entry__def-en">${esc(entry.definition.en)}</p>` : ""}
          ${entry.definition.zh ? `<p class="entry__def-zh" lang="zh-Hant">${esc(entry.definition.zh)}</p>` : ""}
        </div>
        ${examples ? `<div class="entry__examples">${examples}</div>` : ""}
        ${
          seeAlso
            ? `<div class="entry__see">
                 <span class="entry__see-label">See also</span>
                 ${seeAlso}
               </div>`
            : ""
        }
      </article>
    `;
  }

  function wordFor(id) {
    const loc = idIndex[id];
    if (!loc) return null;
    const section = DATA.sections.find((s) => s.id === loc.section);
    if (!section) return null;
    if (loc.category) {
      const cat = section.categories.find((c) => c.id === loc.category);
      if (!cat) return null;
      const e = cat.entries.find((x) => x.id === id);
      return e ? e.word : null;
    }
    const e = section.entries.find((x) => x.id === id);
    return e ? e.word : null;
  }

  function allExampleText(entry) {
    return entry.examples
      .map((ex) => `${ex.en || ""} ${ex.zh || ""}`)
      .join(" ");
  }

  function categoryHTML(cat) {
    const entries = cat.entries.map((e) => entryHTML(e, 4)).join("");
    return `
        <section class="category" id="cat-${escAttr(cat.id)}" data-cat="${escAttr(cat.id)}" aria-labelledby="cat-h-${escAttr(cat.id)}">
          <header class="category__header">
            <h3 class="category__name" id="cat-h-${escAttr(cat.id)}">${esc(cat.label.en)}</h3>
            <span class="category__name-zh" lang="zh-Hant">${esc(cat.label.zh)}</span>
            <span class="category__count">${cat.entries.length}</span>
          </header>
          ${entries || `<p style="color:var(--ink-2);font-style:italic;padding:8px 0;">No entries yet.</p>`}
        </section>
      `;
  }

  function sectionHTML(section) {
    let body = "";
    if (section.categories) {
      body = section.categories.map(categoryHTML).join("");
    } else {
      body = section.entries.map((e) => entryHTML(e, 3)).join("");
    }

    const total =
      section.entries?.length ??
      section.categories.reduce((s, c) => s + c.entries.length, 0);

    return `
      <section class="section" id="${escAttr(section.id)}" data-section="${escAttr(section.id)}" aria-labelledby="sec-h-${escAttr(section.id)}">
        <header class="section__header">
          <h2 class="section__title" id="sec-h-${escAttr(section.id)}">
            <span class="section__title-en">${esc(section.label.en)}</span>
            <span class="section__title-zh" lang="zh-Hant">${esc(section.label.zh)}</span>
          </h2>
          <span class="section__count" aria-label="${total} words">${total}&nbsp;words</span>
        </header>
        <div class="section__body">${body}</div>
      </section>
    `;
  }

  function render() {
    indexEntries();
    root.innerHTML = DATA.sections.map(sectionHTML).join("");
    const total = Object.keys(idIndex).length;
    if (countEl) countEl.textContent = total;
  }

  // --- Search ------------------------------------------------------

  let highlightSpan = null;

  function clearHighlights() {
    document.querySelectorAll("mark.hl").forEach((m) => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function highlightInEntry(entry, queryLower) {
    if (!queryLower) return;
    const re = new RegExp(regexEscape(queryLower), "gi");
    const selectors = [".entry__word", ".entry__def-en", ".entry__def-zh",
                       ".entry__example-en", ".entry__example-zh"];
    for (const sel of selectors) {
      const nodes = entry.querySelectorAll(sel);
      nodes.forEach((node) => highlightNode(node, re));
    }
  }

  function highlightNode(node, re) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    for (const tn of textNodes) {
      const text = tn.nodeValue;
      if (!re.test(text)) {
        re.lastIndex = 0;
        continue;
      }
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        }
        const m = document.createElement("mark");
        m.className = "hl";
        m.textContent = match[0];
        frag.appendChild(m);
        last = match.index + match[0].length;
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      tn.parentNode.replaceChild(frag, tn);
    }
  }

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    clearHighlights();

    const entries = root.querySelectorAll(".entry");
    let anyShown = false;

    entries.forEach((entry) => {
      if (!q) {
        entry.hidden = false;
        anyShown = true;
        return;
      }
      const hay = `${entry.dataset.word} ${entry.dataset.def} ${entry.dataset.zh} ${entry.dataset.ex}`;
      const hit = hay.toLowerCase().includes(q);
      entry.hidden = !hit;
      if (hit) {
        anyShown = true;
        highlightInEntry(entry, q);
      }
    });

    // Hide empty categories/sections
    root.querySelectorAll(".category").forEach((cat) => {
      const visible = cat.querySelectorAll(".entry:not([hidden])").length;
      cat.hidden = visible === 0 && q.length > 0;
    });
    root.querySelectorAll(".section").forEach((sec) => {
      const visibleEntries = sec.querySelectorAll(".entry:not([hidden])").length;
      sec.hidden = visibleEntries === 0 && q.length > 0;
    });

    if (empty) empty.hidden = !(q && !anyShown);
    if (searchClear) searchClear.hidden = q.length === 0;
  }

  function setupSearch() {
    if (!searchInput) return;
    let t = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => applyFilter(searchInput.value), 80);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        applyFilter("");
        searchInput.blur();
      }
    });
    if (searchClear) {
      searchClear.addEventListener("click", () => {
        searchInput.value = "";
        applyFilter("");
        searchInput.focus();
      });
    }
    // Cmd/Ctrl + K → focus search
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }

  // --- Scroll-spy (bottom tabs + transition chips) ----------------
  // Strategy: on each scroll, find the last section whose top has
  // crossed a probe line just below the topbar. That's "current".

  function topbarHeight() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--topbar-h");
    return parseInt(v, 10) || 60;
  }

  const chipsEl = document.getElementById("chips");
  let chipsRenderedFor = null; // section id whose categories are currently in chipsEl

  // Apple HIG section tints — each section has its own systemColor so
  // active states, the brand glyph, and chip highlights re-tint as the
  // user moves between sections. CSS holds the actual values.
  const SECTION_TINT_VAR = {
    nouns: "var(--tint-nouns)",
    adjectives: "var(--tint-adjectives)",
    verbs: "var(--tint-verbs)",
    transitions: "var(--tint-transitions)",
  };
  let lastTintSection = null;
  function applyTint(sectionId) {
    if (sectionId === lastTintSection) return;
    lastTintSection = sectionId;
    const v = SECTION_TINT_VAR[sectionId] || SECTION_TINT_VAR.transitions;
    document.body.style.setProperty("--tint", v);
  }

  function renderChips(section) {
    if (!chipsEl || chipsRenderedFor === section.id) return;
    chipsRenderedFor = section.id;
    const items = section.categories
      .map(
        (c) => `
        <a class="chip" href="#cat-${escAttr(c.id)}" data-chip="${escAttr(c.id)}">${esc(c.label.en)}</a>`
      )
      .join("");
    chipsEl.innerHTML = `<div class="chips__list">${items}</div>`;
  }

  function sizeChips() {
    if (!chipsEl) return;
    // Set width from the visual viewport (excludes scrollbar gutter).
    const vw = document.documentElement.clientWidth || window.innerWidth;
    // Wider viewports get a centered, capped column.
    if (vw >= 760) {
      const max = 720;
      const w = Math.min(max, vw - 48);
      chipsEl.style.width = `${w}px`;
      chipsEl.style.left = `${(vw - w) / 2}px`;
    } else {
      chipsEl.style.width = `${vw - 24}px`;
      chipsEl.style.left = "12px";
    }
  }

  function positionChips(sectionId) {
    if (!chipsEl) return;
    sizeChips();
    const tab = document.querySelector(`.tab[data-target="${sectionId}"]`);
    if (!tab) return;
    const tabRect = tab.getBoundingClientRect();
    const chipsRect = chipsEl.getBoundingClientRect();
    const chevronX = tabRect.left + tabRect.width / 2 - chipsRect.left;
    chipsEl.style.setProperty("--chevron-x", `${chevronX}px`);
  }

  function setupTabbar() {
    const sections = Array.from(document.querySelectorAll(".section"));
    if (!sections.length) return;

    function activate(id) {
      tabs.forEach((t) =>
        t.setAttribute("aria-current", t.dataset.target === id ? "true" : "false")
      );
      applyTint(id);
      if (!chipsEl) return;

      const section = DATA.sections.find((s) => s.id === id);
      const hasCats = !!(section && section.categories && section.categories.length);

      if (hasCats) {
        if (chipsEl.hasAttribute("hidden")) chipsEl.removeAttribute("hidden");
        renderChips(section);
        positionChips(id);
        chipsEl.inert = false;
        // Two-frame defer so layout settles before the show transition,
        // then dispatch a scroll event so the chips' scroll-spy picks
        // up the current category and highlights its chip.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            chipsEl.classList.add("is-visible");
            window.dispatchEvent(new Event("scroll"));
          });
        });
        document.body.classList.add("chips-visible");
      } else {
        chipsEl.classList.remove("is-visible");
        chipsEl.inert = true;
        document.body.classList.remove("chips-visible");
      }
    }

    function sync() {
      const probe = topbarHeight() + 140;
      let current = sections[0].id;
      for (const s of sections) {
        if (s.hidden) continue;
        if (s.getBoundingClientRect().top <= probe) current = s.id;
      }
      activate(current);
    }

    let raf = null;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        sync();
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => {
      sync();
      const activeTab = document.querySelector('.tab[aria-current="true"]');
      if (activeTab) positionChips(activeTab.dataset.target);
    });
    sync();

    tabs.forEach((t) => {
      t.addEventListener("click", (e) => {
        e.preventDefault();
        const id = t.dataset.target;
        const el = document.getElementById(id);
        if (el) {
          if (document.activeElement === searchInput) searchInput.blur();
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          history.replaceState(null, "", `#${id}`);
        }
      });
    });
  }

  function setupChips() {
    if (!chipsEl) return;

    // Event delegation — chips are re-rendered on section change.
    chipsEl.addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      e.preventDefault();
      const id = c.dataset.chip;
      const el = document.getElementById(`cat-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#cat-${id}`);
      }
    });

    let lastActive = null;
    function sync() {
      if (!chipsEl.classList.contains("is-visible")) return;
      const cats = Array.from(document.querySelectorAll(".category"));
      if (!cats.length) return;

      const probe = topbarHeight() + 140;
      let current = null;
      for (const c of cats) {
        if (c.hidden) continue;
        if (c.getBoundingClientRect().top <= probe) current = c.dataset.cat;
      }
      // If the section is current but no category header has crossed
      // the probe yet, default to the first category in that section.
      if (!current) {
        const section = cats[0].closest(".section");
        if (section && section.getBoundingClientRect().top <= probe) {
          current = cats[0].dataset.cat;
        }
      }
      if (!current) return;

      let activeChip = null;
      chipsEl.querySelectorAll(".chip").forEach((c) => {
        const matches = c.dataset.chip === current;
        c.setAttribute("aria-current", matches ? "true" : "false");
        if (matches) activeChip = c;
      });

      if (activeChip && current !== lastActive) {
        lastActive = current;
        // Vertical scroll inside the chips column to keep active chip in view.
        activeChip.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }

    let raf = null;
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        sync();
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", sync);
    // Sync after the tabbar's activate() runs (which calls renderChips).
    requestAnimationFrame(sync);
  }

  // --- "See also" chips: scroll + flash target -------------------

  function setupSeeAlso() {
    root.addEventListener("click", (e) => {
      const link = e.target.closest(".see-chip");
      if (!link) return;
      const id = link.dataset.see;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("is-target");
      // Force reflow so the animation restarts.
      void target.offsetWidth;
      target.classList.add("is-target");
      history.replaceState(null, "", `#${id}`);
    });
  }

  // --- Horizontal swipe → navigate sections -----------------------
  // The four-tab primary nav implies a pager mental model. A
  // confident horizontal swipe on the page background moves to the
  // previous / next section. Vertical-dominant gestures stay as
  // normal scroll. Interactive surfaces (chips, topbar, tabbar,
  // links, inputs) opt out so their own gestures aren't hijacked.

  const SWIPE_MIN_DX = 60;        // px: minimum horizontal travel
  const SWIPE_MAX_DY = 50;        // px: maximum vertical drift
  const SWIPE_MAX_TIME = 600;     // ms: maximum gesture duration

  function setupSwipeNav() {
    const sectionIds = DATA.sections.map((s) => s.id);
    let startX = 0,
      startY = 0,
      startT = 0,
      tracking = false;

    function onStart(e) {
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (e.target.closest(".chips, .topbar, .tabbar, a, button, input, textarea, select, [contenteditable]"))
        return;
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
      tracking = true;
    }

    function onEnd(e) {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      const dt = Date.now() - startT;
      if (
        Math.abs(dx) < SWIPE_MIN_DX ||
        Math.abs(dy) > SWIPE_MAX_DY ||
        Math.abs(dx) < Math.abs(dy) * 1.4 ||
        dt > SWIPE_MAX_TIME
      )
        return;

      const currentId = document.querySelector('.tab[aria-current="true"]')?.dataset.target;
      let idx = sectionIds.indexOf(currentId);
      if (idx === -1) idx = 0;
      const dir = dx < 0 ? +1 : -1; // swipe-left → next
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= sectionIds.length) return;

      const el = document.getElementById(sectionIds[nextIdx]);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
  }

  // --- Deep-link handling on load --------------------------------

  function handleInitialHash() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!hash) return;
    const target = document.getElementById(hash) || document.getElementById(`cat-${hash}`);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: "start" });
        if (target.classList.contains("entry")) {
          target.classList.add("is-target");
        }
      });
    }
  }

  // --- Init -------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    render();
    setupSearch();
    setupTabbar();
    setupChips();
    setupSeeAlso();
    setupSwipeNav();
    handleInitialHash();
  });
})();
