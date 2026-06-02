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

  function entryHTML(entry, headingLevel, posLabel) {
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

    // Soft cross-reference. `tags` is an optional array of topic ids
    // where this word is also relevant. The entry still lives in one
    // canonical topic; this is a hint, not a duplicate placement.
    const tags = (entry.tags || [])
      .map((tid) => DATA.sections.find((s) => s.id === tid))
      .filter(Boolean);
    let alsoIn = "";
    if (tags.length) {
      const chips = tags.map(
        (s) =>
          `<a class="entry__also-link" href="#${escAttr(s.id)}" data-topic="${escAttr(s.id)}" style="--also-tint: ${SECTION_TINT_VAR[s.id]}">${esc(s.label.en)}</a>`
      );
      let joined;
      if (chips.length === 1) joined = chips[0];
      else if (chips.length === 2) joined = `${chips[0]} and ${chips[1]}`;
      else joined = `${chips.slice(0, -1).join(", ")}, and ${chips[chips.length - 1]}`;
      alsoIn = `<p class="entry__also-in">Also useful for ${joined}.</p>`;
    }

    return `
      <article class="entry" id="${escAttr(entry.id)}"
               data-word="${escAttr(entry.word.toLowerCase())}"
               data-def="${escAttr((entry.definition.en || "").toLowerCase())}"
               data-zh="${escAttr(entry.definition.zh || "")}"
               data-ex="${escAttr(allExampleText(entry).toLowerCase())}">
        <header class="entry__head">
          <${hTag} class="entry__word">${esc(entry.word)}</${hTag}>
          ${posLabel ? `<span class="entry__pos" aria-hidden="true">${esc(posLabel)}</span>` : ""}
        </header>
        <div class="entry__def">
          ${entry.definition.en ? `<p class="entry__def-en">${esc(entry.definition.en)}</p>` : ""}
          ${entry.definition.zh ? `<p class="entry__def-zh" lang="zh-Hant">${esc(entry.definition.zh)}</p>` : ""}
        </div>
        ${examples ? `<div class="entry__examples">${examples}</div>` : ""}
        ${
          seeAlso
            ? `<div class="entry__see">
                 <span class="entry__see-label">See Also</span>
                 ${seeAlso}
               </div>`
            : ""
        }
        ${alsoIn}
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

  function categoryHTML(cat, sectionId) {
    // POS marker only applies when this category's id is a part-of-speech
    // (nouns/adjectives/verbs) — i.e. the section is a topic, not the
    // transitions section.
    const posLabel = sectionId !== "transitions" ? POS_LABEL_FOR_CATEGORY[cat.id] : null;
    const entries = cat.entries.map((e) => entryHTML(e, 4, posLabel)).join("");
    return `
        <section class="category" id="cat-${escAttr(cat.id)}-${escAttr(sectionId)}" data-cat="${escAttr(cat.id)}" aria-labelledby="cat-h-${escAttr(cat.id)}-${escAttr(sectionId)}">
          <header class="category__header">
            <h3 class="category__name" id="cat-h-${escAttr(cat.id)}-${escAttr(sectionId)}">${esc(cat.label.en)}</h3>
            <span class="category__name-zh" lang="zh-Hant">${esc(cat.label.zh)}</span>
            <span class="category__count">${cat.entries.length}</span>
          </header>
          ${entries || `<p style="color:var(--label-2);font-style:italic;padding:14px 16px;">No entries yet.</p>`}
        </section>
      `;
  }

  // Cross-tagged entries pointing IN to a topic — flat list, used by
  // the "More words tagged here" surface at the bottom of each topic.
  function entriesTaggedFor(topicId) {
    const out = [];
    for (const s of DATA.sections) {
      if (s.id === topicId) continue;
      const all = s.entries
        ? s.entries
        : s.categories.flatMap((c) => c.entries.map((e) => ({ ...e, _cat: c.id })));
      for (const e of all) {
        if (e.tags && e.tags.includes(topicId)) out.push({ entry: e, sectionId: s.id });
      }
    }
    return out;
  }

  function sectionHTML(section) {
    let body = "";
    if (section.categories) {
      body = section.categories.map((c) => categoryHTML(c, section.id)).join("");
    } else {
      body = section.entries.map((e) => entryHTML(e, 3, null)).join("");
    }

    // "More words tagged here" — chips for entries living in OTHER
    // topics but tagged with this one. Discoverable cross-references
    // without duplicating the entries.
    const tagged = entriesTaggedFor(section.id);
    const moreHTML = tagged.length
      ? `<aside class="tagged-here" aria-label="More words tagged for ${esc(section.label.en)}">
           <h3 class="tagged-here__heading">Also Tagged Here <span class="tagged-here__zh" lang="zh-Hant">相關詞彙</span></h3>
           <div class="tagged-here__list">
             ${tagged
               .map(
                 ({ entry, sectionId }) =>
                   `<a class="tagged-chip" href="#${escAttr(entry.id)}" data-recent="${escAttr(entry.id)}" style="--also-tint: ${SECTION_TINT_VAR[sectionId]}">
                      ${esc(entry.word)}
                    </a>`
               )
               .join("")}
           </div>
         </aside>`
      : "";

    const total =
      section.entries?.length ??
      section.categories.reduce((s, c) => s + c.entries.length, 0);

    const introHTML = section.intro
      ? `<p class="section__intro">${esc(section.intro.en)}</p>
         <p class="section__intro section__intro--zh" lang="zh-Hant">${esc(section.intro.zh)}</p>`
      : "";

    // Inline category jump-nav — only render for sections with 4+
    // categories (currently just transitions). For 3-POS topics, the
    // category cards in the body are self-evident enough.
    const sectionChipsHTML =
      section.categories && section.categories.length >= 4
        ? `<nav class="section-chips" aria-label="${esc(section.label.en)} categories">
             ${section.categories
               .map(
                 (c) =>
                   `<a class="section-chip" href="#cat-${escAttr(c.id)}-${escAttr(section.id)}" data-cat="${escAttr(c.id)}">${esc(c.label.en)}</a>`
               )
               .join("")}
           </nav>`
        : "";

    return `
      <section class="section" id="${escAttr(section.id)}" data-section="${escAttr(section.id)}" aria-labelledby="sec-h-${escAttr(section.id)}">
        <header class="section__header">
          <h2 class="section__title" id="sec-h-${escAttr(section.id)}">
            <span class="section__title-en">${esc(section.label.en)}</span>
            <span class="section__title-zh" lang="zh-Hant">${esc(section.label.zh)}</span>
          </h2>
          <span class="section__count" aria-label="${total} words">${total}&nbsp;words</span>
        </header>
        ${introHTML}
        ${sectionChipsHTML}
        <div class="section__body">${body}</div>
        ${moreHTML}
      </section>
    `;
  }

  function topicCardHTML(section) {
    const total = section.categories
      ? section.categories.reduce((a, c) => a + c.entries.length, 0)
      : section.entries.length;
    const tintVar = SECTION_TINT_VAR[section.id] || SECTION_TINT_VAR["society-culture"];
    return `
      <a class="topic-card" data-target="${escAttr(section.id)}" href="#${escAttr(section.id)}"
         style="--tint: ${tintVar}">
        <span class="topic-card__dot" aria-hidden="true"></span>
        <span class="topic-card__text">
          <span class="topic-card__en">${esc(section.label.en)}</span>
          <span class="topic-card__zh" lang="zh-Hant">${esc(section.label.zh)}</span>
        </span>
        <span class="topic-card__count" aria-label="${total} words">${total}</span>
      </a>
    `;
  }

  function renderTopicGrid() {
    const grid = document.getElementById("topics-grid");
    if (!grid) return;
    grid.innerHTML = DATA.sections.map(topicCardHTML).join("");

    grid.addEventListener("click", (e) => {
      const card = e.target.closest(".topic-card");
      if (!card) return;
      e.preventDefault();
      const id = card.dataset.target;
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${id}`);
      }
    });
  }

  function render() {
    indexEntries();
    root.innerHTML = DATA.sections.map(sectionHTML).join("");
    renderTopicGrid();
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
    let totalShown = 0;

    entries.forEach((entry) => {
      if (!q) {
        entry.hidden = false;
        totalShown++;
        return;
      }
      const hay = `${entry.dataset.word} ${entry.dataset.def} ${entry.dataset.zh} ${entry.dataset.ex}`;
      const hit = hay.toLowerCase().includes(q);
      entry.hidden = !hit;
      if (hit) {
        totalShown++;
        highlightInEntry(entry, q);
      }
    });

    // Hide empty categories/sections; count topics with matches
    root.querySelectorAll(".category").forEach((cat) => {
      const visible = cat.querySelectorAll(".entry:not([hidden])").length;
      cat.hidden = visible === 0 && q.length > 0;
    });
    let topicsWithMatches = 0;
    root.querySelectorAll(".section").forEach((sec) => {
      const visibleEntries = sec.querySelectorAll(".entry:not([hidden])").length;
      sec.hidden = visibleEntries === 0 && q.length > 0;
      if (q && visibleEntries > 0) topicsWithMatches++;
    });

    if (empty) empty.hidden = !(q && totalShown === 0);
    if (searchClear) searchClear.hidden = q.length === 0;

    // Landing surfaces (recent + WOD + topic grid) get out of the way
    // when a query is active.
    const recentSec = document.getElementById("recent-section");
    const topicsSec = document.querySelector(".topics");
    const wodSec = document.getElementById("wod-section");
    if (recentSec) recentSec.hidden = !!q || getRecent().length === 0;
    if (topicsSec) topicsSec.hidden = !!q;
    if (wodSec && wodSec.dataset.available === "true") wodSec.hidden = !!q;

    // Summary line — total matches and how many topics they span.
    const summary = document.getElementById("search-summary");
    if (summary) {
      if (!q) {
        summary.hidden = true;
        summary.innerHTML = "";
      } else {
        summary.hidden = false;
        const plural = topicsWithMatches === 1 ? "topic" : "topics";
        summary.innerHTML = totalShown
          ? `<strong>${totalShown}</strong> match${totalShown === 1 ? "" : "es"} across <strong>${topicsWithMatches}</strong> ${plural}`
          : `No matches for <strong>${esc(query.trim())}</strong>`;
      }
    }
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
    // Keyboard shortcuts: Cmd/Ctrl+K and "/" both focus the search
    // input (the latter mirrors the IDE-style shortcut some users
    // expect). Don't hijack "/" when the user is already typing into
    // a field — let them type the character.
    document.addEventListener("keydown", (e) => {
      const isEditableTarget =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target?.isContentEditable;
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !isEditableTarget && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (cmdK || slash) {
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

  // The dropup chips overlay was removed in favour of an inline chip
  // strip rendered inside any section that has 4+ categories (currently
  // only the transitions section). For 3-POS topic sections, the three
  // category cards in the content area are already self-evident, so a
  // jump-nav adds clutter without value.

  // Apple HIG topic tints — each topic has its own systemColor so
  // active states, the brand glyph, and chip highlights re-tint as the
  // user moves between topics. CSS holds the actual values.
  const SECTION_TINT_VAR = {
    "society-culture":     "var(--tint-society-culture)",
    "education-learning":  "var(--tint-education-learning)",
    "environment":         "var(--tint-environment)",
    "technology-media":    "var(--tint-technology-media)",
    "health-lifestyle":    "var(--tint-health-lifestyle)",
    "work-economy":        "var(--tint-work-economy)",
    "concepts":            "var(--tint-concepts)",
    "transitions":         "var(--tint-transitions)",
  };
  let lastTintSection = null;
  function applyTint(sectionId) {
    if (sectionId === lastTintSection) return;
    lastTintSection = sectionId;
    const v = SECTION_TINT_VAR[sectionId] || SECTION_TINT_VAR["society-culture"];
    document.body.style.setProperty("--tint", v);
  }

  // POS marker shown next to each entry's headword. Only meaningful
  // when the entry sits inside a parts-of-speech category. For the
  // transitions topic the categories are linking-word types, not POS,
  // so no marker is rendered.
  const POS_LABEL_FOR_CATEGORY = {
    nouns:      "n.",
    adjectives: "adj.",
    verbs:      "v.",
  };

  // --- localStorage helpers (safe for private browsing) -----------
  const LS_RECENT = "uw_recent_v1";
  const LS_HINT = "uw_hint_dismissed_v1";
  function lsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  // For looking up an entry by id (used by recent rendering).
  function findEntry(id) {
    for (const s of DATA.sections) {
      if (s.entries) {
        const e = s.entries.find((x) => x.id === id);
        if (e) return { entry: e, sectionId: s.id, categoryId: null };
      }
      if (s.categories) {
        for (const c of s.categories) {
          const e = c.entries.find((x) => x.id === id);
          if (e) return { entry: e, sectionId: s.id, categoryId: c.id };
        }
      }
    }
    return null;
  }

  function setupTabbar() {
    const sections = Array.from(document.querySelectorAll(".section"));
    if (!sections.length) return;

    function activate(id, onLanding) {
      let activeTab = null;
      tabs.forEach((t) => {
        const matches = !onLanding && t.dataset.target === id;
        t.setAttribute("aria-current", matches ? "true" : "false");
        if (matches) activeTab = t;
      });
      applyTint(id);
      // Keep the active tab visible in the scrollable tabbar.
      if (activeTab) {
        activeTab.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    }

    function sync() {
      const probe = topbarHeight() + 140;
      let current = null;
      for (const s of sections) {
        if (s.hidden) continue;
        if (s.getBoundingClientRect().top <= probe) current = s.id;
      }
      const onLanding = current === null;
      if (!current) current = sections[0].id;
      activate(current, onLanding);
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

  // Inline category chips — rendered inside any section with 4+
  // categories (the transitions section). Sticky just below the
  // section header so the jump-nav stays accessible while scrolling
  // through long category lists. Scroll-spy highlights the current
  // category's chip.
  function setupSectionChips() {
    const navs = Array.from(document.querySelectorAll(".section-chips"));
    if (!navs.length) return;

    // Click → smooth-scroll to that category.
    document.addEventListener("click", (e) => {
      const chip = e.target.closest(".section-chip");
      if (!chip) return;
      e.preventDefault();
      const targetId = chip.getAttribute("href")?.slice(1);
      if (!targetId) return;
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${targetId}`);
      }
    });

    // Scroll-spy: for each nav, mark the chip whose category last
    // crossed the probe.
    function syncOne(nav) {
      const sectionEl = nav.closest(".section");
      if (!sectionEl) return;
      const cats = Array.from(sectionEl.querySelectorAll(".category"));
      if (!cats.length) return;
      const probe = topbarHeight() + 140;
      let current = cats[0].dataset.cat;
      for (const c of cats) {
        if (c.hidden) continue;
        if (c.getBoundingClientRect().top <= probe) current = c.dataset.cat;
      }
      let activeChip = null;
      nav.querySelectorAll(".section-chip").forEach((c) => {
        const matches = c.dataset.cat === current;
        c.setAttribute("aria-current", matches ? "true" : "false");
        if (matches) activeChip = c;
      });
      // Keep the active chip visible inside the horizontal scroller.
      if (activeChip && nav.dataset.lastActive !== current) {
        nav.dataset.lastActive = current;
        activeChip.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    }
    function sync() { navs.forEach(syncOne); }
    let raf = null;
    window.addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; sync(); });
    }, { passive: true });
    window.addEventListener("resize", sync);
    sync();
  }

  // --- "See also" chips: scroll + flash target -------------------

  function setupSeeAlso() {
    root.addEventListener("click", (e) => {
      const link =
        e.target.closest(".see-chip") || e.target.closest(".tagged-chip");
      if (!link) return;
      const id = link.dataset.see || link.dataset.recent;
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("is-target");
      void target.offsetWidth;
      target.classList.add("is-target");
      history.replaceState(null, "", `#${id}`);
      pushRecent(id);
    });
    // Recent chips also count as a "visit" — bump them to the top
    // of the recent list so they stay accessible.
    document.getElementById("recent-list")?.addEventListener("click", (e) => {
      const link = e.target.closest(".recent-chip");
      if (!link) return;
      const id = link.dataset.recent;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("is-target");
      void target.offsetWidth;
      target.classList.add("is-target");
      history.replaceState(null, "", `#${id}`);
      pushRecent(id);
    });
  }

  // --- Word of the Day --------------------------------------------
  // Deterministic by date: every visitor sees the same word all day,
  // and the choice changes at local midnight. Seeded from YYYY-MM-DD
  // so the index is stable across reloads. Skips the transitions
  // section since transitions aren't really "words" you'd reflect on.

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function seedFromDate(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }
  function pickWodId() {
    // Eligible: every entry whose section is not transitions.
    const eligible = [];
    for (const s of DATA.sections) {
      if (s.id === "transitions") continue;
      const list = s.entries
        ? s.entries
        : s.categories.flatMap((c) => c.entries);
      for (const e of list) eligible.push({ id: e.id, sectionId: s.id });
    }
    if (!eligible.length) return null;
    const seed = seedFromDate(todayKey());
    return eligible[seed % eligible.length];
  }

  function renderWod() {
    const section = document.getElementById("wod-section");
    const body = document.getElementById("wod-body");
    if (!section || !body) return;
    const pick = pickWodId();
    if (!pick) {
      section.hidden = true;
      return;
    }
    const found = findEntry(pick.id);
    if (!found) {
      section.hidden = true;
      return;
    }
    const { entry, sectionId, categoryId } = found;
    const sectionData = DATA.sections.find((s) => s.id === sectionId);
    const pos = POS_LABEL_FOR_CATEGORY[categoryId];

    section.dataset.available = "true";
    section.style.setProperty("--wod-tint", SECTION_TINT_VAR[sectionId] || SECTION_TINT_VAR["society-culture"]);
    body.innerHTML = `
      <div class="wod__word-row">
        <a class="wod__word" href="#${escAttr(entry.id)}" data-wod="${escAttr(entry.id)}">${esc(entry.word)}</a>
        ${pos ? `<span class="wod__pos" aria-hidden="true">${esc(pos)}</span>` : ""}
      </div>
      ${entry.definition.en ? `<p class="wod__def">${esc(entry.definition.en)}</p>` : ""}
      ${entry.definition.zh ? `<p class="wod__def-zh" lang="zh-Hant">${esc(entry.definition.zh)}</p>` : ""}
      <a class="wod__link" href="#${escAttr(sectionId)}">
        Open in ${esc(sectionData?.label.en || sectionId)}
      </a>
    `;
    section.hidden = false;

    // Tapping the word jumps to its full entry and marks it as recent.
    body.querySelector('[data-wod]')?.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.wod;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.remove("is-target");
      void target.offsetWidth;
      target.classList.add("is-target");
      history.replaceState(null, "", `#${id}`);
      pushRecent(id);
    });
  }

  // --- Recently viewed entries (top of landing) -------------------
  const RECENT_MAX = 5;
  function getRecent() {
    const arr = lsGet(LS_RECENT, []);
    return Array.isArray(arr) ? arr.filter((id) => idIndex[id]) : [];
  }
  function pushRecent(id) {
    if (!id || !idIndex[id]) return;
    let r = getRecent();
    r = [id, ...r.filter((x) => x !== id)].slice(0, RECENT_MAX);
    lsSet(LS_RECENT, r);
    renderRecent();
  }
  function renderRecent() {
    const sec = document.getElementById("recent-section");
    const list = document.getElementById("recent-list");
    if (!sec || !list) return;
    const recent = getRecent();
    if (!recent.length) {
      sec.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.innerHTML = recent
      .map((id) => {
        const found = findEntry(id);
        if (!found) return "";
        const pos = POS_LABEL_FOR_CATEGORY[found.categoryId];
        return `
          <a class="recent-chip" href="#${escAttr(id)}" data-recent="${escAttr(id)}">
            ${esc(found.entry.word)}
            ${pos ? `<span class="recent-chip__pos" aria-hidden="true">${esc(pos)}</span>` : ""}
          </a>`;
      })
      .join("");
    sec.hidden = false;
  }

  // --- Onboarding hint --------------------------------------------
  function setupHint() {
    const hint = document.getElementById("hint");
    if (!hint) return;
    if (lsGet(LS_HINT, false)) {
      hint.classList.add("hint--dismissed");
      hint.hidden = true;
      return;
    }
    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      hint.classList.add("hint--dismissed");
      lsSet(LS_HINT, true);
      // Once the transition finishes, remove from layout entirely.
      setTimeout(() => { hint.hidden = true; }, 400);
    }
    document.getElementById("topics-grid")?.addEventListener("click", dismiss, { once: true });
    searchInput?.addEventListener("focus", dismiss, { once: true });
    window.addEventListener("scroll", () => {
      if (window.scrollY > 240) dismiss();
    }, { passive: true });
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
      // If the deep link points at a specific entry, remember it.
      if (idIndex[hash]) pushRecent(hash);
    }
  }

  // --- Init -------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    render();
    setupSearch();
    setupTabbar();
    setupSectionChips();
    setupSeeAlso();
    setupSwipeNav();
    renderRecent();
    renderWod();
    setupHint();
    handleInitialHash();
  });
})();
