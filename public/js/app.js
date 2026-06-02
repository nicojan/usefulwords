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

  // --- Programmatic scroll lock -----------------------------------
  // Any in-page link (tab, topic card, see-also chip, recent chip,
  // WotD card) triggers a smooth document scroll. While that smooth
  // scroll is in flight, the scroll-spy must NOT fire its own
  // scrollIntoView calls or mutate document height (chips-visible
  // padding shift) — both of those compete with the user's smooth
  // scroll and cause it to land short of the target (e.g., clicking
  // "transitions" landing the page at "work-economy"). Callers set
  // the lock for ~PROG_SCROLL_MS, and any user-initiated input
  // (wheel, touch, keyboard scroll keys) clears it early.
  let programmaticUntil = 0;
  let progScrollTimeout = null;
  const PROG_SCROLL_MS = 900;
  function markProgrammaticScroll(ms = PROG_SCROLL_MS) {
    programmaticUntil = Date.now() + ms;

    // Wake every section up before the smooth scroll computes its
    // target offset. .section uses `content-visibility: auto` with
    // `contain-intrinsic-size: 0 4000px` — off-screen sections are
    // laid out at the 4000px placeholder. scrollIntoView then aims
    // at an inflated offsetTop; as the scroll passes through
    // intermediate sections they wake up to real (smaller) heights,
    // the document shrinks, and the scroll lands one or more
    // sections short of the target. Forcing content-visibility:
    // visible locks every section at its real height before the
    // scroll starts.
    //
    // We deliberately do NOT restore content-visibility:auto after
    // the scroll settles. Re-inflating off-screen sections back to
    // their 4000px placeholders triggers scroll-anchoring to
    // compensate for thousands of pixels of new layout above the
    // viewport, and in practice the anchor lands inconsistently —
    // the user sees the page "pause then jump" into the next
    // section or onto an arbitrary entry. The perf optimization is
    // intentionally forfeited for the rest of the session; layout
    // is cheap on this size of document.
    document.querySelectorAll(".section").forEach((s) => {
      s.style.contentVisibility = "visible";
    });
    void document.body.offsetHeight; // commit the layout

    // Fire one synthetic scroll event after the lock window closes
    // so the scroll-spy applies the landed-section state (the
    // navbar would otherwise stay on whatever was active before
    // the click if the user doesn't touch anything afterwards).
    if (progScrollTimeout) clearTimeout(progScrollTimeout);
    progScrollTimeout = setTimeout(() => {
      progScrollTimeout = null;
      if (Date.now() >= programmaticUntil) {
        window.dispatchEvent(new Event("scroll"));
      }
    }, ms + 50);
  }
  function isProgrammaticScrolling() {
    return Date.now() < programmaticUntil;
  }
  function clearProgrammaticScroll() { programmaticUntil = 0; }
  window.addEventListener("wheel", clearProgrammaticScroll, { passive: true });
  window.addEventListener("touchstart", clearProgrammaticScroll, { passive: true });
  window.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "PageDown" || k === "PageUp" || k === "ArrowDown" ||
        k === "ArrowUp" || k === "Home" || k === "End" || k === " ") {
      clearProgrammaticScroll();
    }
  });

  // Respect prefers-reduced-motion for every programmatic scroll.
  // Modern browsers generally do this for scrollIntoView already,
  // but being explicit guards older engines and keeps the intent
  // visible in code.
  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  function smoothBehavior() {
    return reducedMotion && reducedMotion.matches ? "auto" : "smooth";
  }

  // Trigger the .is-target flash AFTER the smooth scroll has actually
  // landed the target. Earlier code added the class synchronously
  // alongside scrollIntoView, so the 1.4s flash animation often ran
  // (and finished) before the page arrived. We listen for `scrollend`
  // when available, and fall back to the same window as the
  // programmatic-scroll lock for older engines.
  let flashTimer = null;
  let flashEndListener = null;
  function flashTarget(el) {
    if (!el) return;
    el.classList.remove("is-target");
    void el.offsetWidth;

    // Tear down any pending flash from a prior click so it doesn't
    // race the new one.
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    if (flashEndListener) {
      window.removeEventListener("scrollend", flashEndListener);
      flashEndListener = null;
    }
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (flashEndListener) {
        window.removeEventListener("scrollend", flashEndListener);
        flashEndListener = null;
      }
      el.classList.remove("is-target");
      void el.offsetWidth;
      el.classList.add("is-target");
    };
    flashEndListener = fire;
    window.addEventListener("scrollend", flashEndListener, { once: true });
    // Fallback timer in case scrollend never fires (no smooth scroll
    // needed, reduced-motion auto-jump, or browsers without scrollend).
    flashTimer = setTimeout(fire, reducedMotion && reducedMotion.matches ? 60 : PROG_SCROLL_MS);
  }

  // Center an active tab inside its (possibly overflowing) tabbar
  // WITHOUT using Element.scrollIntoView. Scrolling the tabbar via
  // its own .scrollTo keeps the scroll confined to that element and
  // avoids Chromium's quirk of also nudging the document scroll when
  // scrollIntoView walks ancestors — which previously made the in-
  // flight document smooth-scroll land at the wrong section.
  function ensureTabVisible(tab) {
    const bar = tab && tab.parentElement;
    if (!bar) return;
    if (bar.scrollWidth <= bar.clientWidth) return; // desktop sidebar fits all tabs
    const targetLeft = tab.offsetLeft + tab.offsetWidth / 2 - bar.clientWidth / 2;
    const max = bar.scrollWidth - bar.clientWidth;
    bar.scrollTo({
      left: Math.max(0, Math.min(max, targetLeft)),
      behavior: smoothBehavior(),
    });
  }

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
      alsoIn = `<p class="entry__also-in">also useful for ${joined}</p>`;
    }

    const ipa = entry.pronunciation
      ? `<span class="entry__ipa" aria-label="pronunciation">${esc(entry.pronunciation)}</span>`
      : "";

    const collocations =
      entry.collocations && entry.collocations.length
        ? `<p class="entry__collocations" aria-label="common collocations">
             <span class="entry__collocations-label">Collocations</span>
             ${entry.collocations.map((c) => esc(c)).join(" · ")}
           </p>`
        : "";

    return `
      <article class="entry" id="${escAttr(entry.id)}"
               data-word="${escAttr(entry.word.toLowerCase())}"
               data-def="${escAttr((entry.definition.en || "").toLowerCase())}"
               data-zh="${escAttr(entry.definition.zh || "")}"
               data-ex="${escAttr(allExampleText(entry).toLowerCase())}">
        <header class="entry__head">
          <${hTag} class="entry__word">${esc(entry.word)}</${hTag}>
          ${ipa}
          ${posLabel ? `<span class="entry__pos" aria-hidden="true">${esc(posLabel)}</span>` : ""}
        </header>
        <div class="entry__def">
          ${entry.definition.en ? `<p class="entry__def-en">${esc(entry.definition.en)}</p>` : ""}
          ${entry.definition.zh ? `<p class="entry__def-zh" lang="zh-Hant">${esc(entry.definition.zh)}</p>` : ""}
        </div>
        ${collocations}
        ${examples ? `<div class="entry__examples">${examples}</div>` : ""}
        ${
          seeAlso
            ? `<div class="entry__see">
                 <span class="entry__see-label">see also</span>
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
    const tintVar = SECTION_TINT_VAR[sectionId] || "var(--label-2)";
    return `
        <section class="category" id="cat-${escAttr(cat.id)}-${escAttr(sectionId)}" data-cat="${escAttr(cat.id)}" aria-labelledby="cat-h-${escAttr(cat.id)}-${escAttr(sectionId)}" style="--cat-tint: ${tintVar}">
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

    // "Also Tagged Here" — chips for entries living in OTHER topics
    // but tagged with this one. Hidden when there are fewer than 4
    // entries pointing here — a sparse surface reads as noise.
    const TAGGED_HERE_MIN = 4;
    const tagged = entriesTaggedFor(section.id);
    const moreHTML = tagged.length >= TAGGED_HERE_MIN
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

    // Inline section chip strip is gone — for the transitions topic
    // (the only section with 4+ categories) the JS-driven bubble
    // dropup is used instead, since it docks in the thumb zone.
    const sectionChipsHTML = "";

    const sectionTintVar = SECTION_TINT_VAR[section.id] || "var(--label)";
    return `
      <section class="section" id="${escAttr(section.id)}" data-section="${escAttr(section.id)}" aria-labelledby="sec-h-${escAttr(section.id)}" style="--section-tint: ${sectionTintVar}">
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
         aria-label="${esc(section.label.en)} — ${total} words"
         style="--tint: ${tintVar}">
        <span class="topic-card__text">
          <span class="topic-card__en">${esc(section.label.en)}</span>
          <span class="topic-card__zh" lang="zh-Hant">${esc(section.label.zh)}</span>
        </span>
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
        markProgrammaticScroll();
        el.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
        history.replaceState(null, "", `#${id}`);
      }
    });
  }

  function renderTransitionsSubnav() {
    // Desktop sidebar only: render the 7 transition sub-categories as a
    // nested list directly beneath the transitions tab so the sidebar
    // mirrors the dropup chips' affordance from mobile. CSS hides it
    // below the desktop breakpoint, where the dropup bubble takes over.
    const tabbar = document.getElementById("sections-nav");
    if (!tabbar) return;
    const transitionsTab = tabbar.querySelector('.tab[data-target="transitions"]');
    if (!transitionsTab) return;
    if (document.getElementById("transitions-subnav")) return;
    const section = DATA.sections.find((s) => s.id === "transitions");
    if (!section?.categories) return;
    const subnav = document.createElement("div");
    subnav.id = "transitions-subnav";
    subnav.className = "tab-subnav";
    subnav.setAttribute("aria-label", "Transition categories");
    subnav.innerHTML = section.categories
      .map(
        (c) =>
          `<a class="tab-subnav__link" href="#cat-${escAttr(c.id)}-transitions" data-cat="${escAttr(c.id)}" aria-current="false">${esc(c.label.en)}</a>`
      )
      .join("");
    transitionsTab.after(subnav);
  }

  function render() {
    indexEntries();
    root.innerHTML = DATA.sections.map(sectionHTML).join("");
    renderTopicGrid();
    renderTransitionsSubnav();
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

  // Dropup chips bubble — restored for the transitions section
  // because its 7 sub-categories benefit from a thumb-zone
  // jump-nav. Other topics (3 POS sub-cats each) are self-evident
  // from the rendered cards and don't get a dropup.
  const chipsEl = document.getElementById("chips");
  let chipsRenderedFor = null;

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

  function renderChipsForTransitions() {
    if (!chipsEl) return;
    if (chipsRenderedFor === "transitions") return;
    const section = DATA.sections.find((s) => s.id === "transitions");
    if (!section?.categories) return;
    chipsRenderedFor = "transitions";
    const items = section.categories
      .map(
        (c) =>
          `<a class="chip" href="#cat-${escAttr(c.id)}-transitions" data-cat="${escAttr(c.id)}">${esc(c.label.en)}</a>`
      )
      .join("");
    chipsEl.innerHTML = `<div class="chips__list">${items}</div>`;
  }

  function positionChipsAtTransitionsTab() {
    if (!chipsEl) return;
    const tab = document.querySelector('.tab[data-target="transitions"]');
    if (!tab) return;
    const tabRect = tab.getBoundingClientRect();
    const chipsRect = chipsEl.getBoundingClientRect();
    const chevronX = tabRect.left + tabRect.width / 2 - chipsRect.left;
    chipsEl.style.setProperty("--chevron-x", `${chevronX}px`);
  }

  function setupTabbar() {
    const sections = Array.from(document.querySelectorAll(".section"));
    if (!sections.length) return;

    // Gate the scroll-spy: re-run only when the active section actually
    // changes. Without this, every scroll-event RAF during a programmatic
    // smooth scroll re-fires activeTab.scrollIntoView({behavior:"smooth"}),
    // which competes with the document's own in-flight smooth scroll and
    // shows up as a stutter / premature stop on any in-page link click.
    let lastActivateKey = null;
    let lastActiveTab = null;
    function activate(id, onLanding) {
      const key = `${onLanding ? "1" : "0"}|${id}`;
      if (key === lastActivateKey) return;
      lastActivateKey = key;

      let activeTab = null;
      tabs.forEach((t) => {
        const matches = !onLanding && t.dataset.target === id;
        t.setAttribute("aria-current", matches ? "true" : "false");
        if (matches) activeTab = t;
      });
      applyTint(id);
      if (activeTab && activeTab !== lastActiveTab) {
        lastActiveTab = activeTab;
        ensureTabVisible(activeTab);
      }
      // Dropup chips: only for the transitions section.
      if (chipsEl) {
        if (!onLanding && id === "transitions") {
          if (chipsEl.hasAttribute("hidden")) chipsEl.removeAttribute("hidden");
          renderChipsForTransitions();
          positionChipsAtTransitionsTab();
          chipsEl.inert = false;
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
    }

    function sync() {
      // While the user's smooth scroll to a clicked target is in
      // flight, do not re-run scroll-spy work — its side effects
      // (chips show/hide, tabbar auto-center) interfere with the
      // browser's smooth scroll and cause it to land short.
      if (isProgrammaticScrolling()) return;
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
          markProgrammaticScroll();
          activate(id, false); // immediate UI feedback for clicked tab
          el.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
          history.replaceState(null, "", `#${id}`);
        }
      });
    });
  }

  // Dropup chips scroll-spy + click handler. Active when transitions
  // section is current; highlights the chip for the current category
  // and auto-scrolls it into the 2.5-pill visible window.
  function setupChips() {
    if (!chipsEl) return;

    const subnav = document.getElementById("transitions-subnav");

    function navigateToCategory(catId) {
      const el = document.getElementById(`cat-${catId}-transitions`);
      if (!el) return;
      markProgrammaticScroll();
      el.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
      history.replaceState(null, "", `#cat-${catId}-transitions`);
    }

    chipsEl.addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      e.preventDefault();
      navigateToCategory(c.dataset.cat);
    });
    if (subnav) {
      subnav.addEventListener("click", (e) => {
        const a = e.target.closest(".tab-subnav__link");
        if (!a) return;
        e.preventDefault();
        navigateToCategory(a.dataset.cat);
      });
    }

    let lastActive = null;
    function sync() {
      if (isProgrammaticScrolling()) return;
      const trans = document.getElementById("transitions");
      if (!trans) return;
      const cats = Array.from(trans.querySelectorAll(".category"));
      if (!cats.length) return;
      const probe = topbarHeight() + 140;
      let current = cats[0].dataset.cat;
      for (const c of cats) {
        if (c.hidden) continue;
        if (c.getBoundingClientRect().top <= probe) current = c.dataset.cat;
      }
      let activeChip = null;
      chipsEl.querySelectorAll(".chip").forEach((c) => {
        const matches = c.dataset.cat === current;
        c.setAttribute("aria-current", matches ? "true" : "false");
        // Only treat the mobile dropup chip as the auto-scroll target
        // when its bubble is actually visible — otherwise scrolling
        // a hidden, fixed element produces no UI feedback and risks
        // ancestor-scroll quirks.
        if (matches && chipsEl.classList.contains("is-visible")) activeChip = c;
      });
      if (subnav) {
        subnav.querySelectorAll(".tab-subnav__link").forEach((a) => {
          a.setAttribute("aria-current", a.dataset.cat === current ? "true" : "false");
        });
      }
      if (activeChip && current !== lastActive) {
        lastActive = current;
        activeChip.scrollIntoView({ behavior: smoothBehavior(), block: "nearest" });
      }
    }

    let raf = null;
    window.addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; sync(); });
    }, { passive: true });
    window.addEventListener("resize", () => {
      sync();
      positionChipsAtTransitionsTab();
    });
    requestAnimationFrame(sync);
  }

  // --- "See also" chips: scroll + flash target -------------------

  function setupSeeAlso() {
    root.addEventListener("click", (e) => {
      const link =
        e.target.closest(".see-chip") ||
        e.target.closest(".tagged-chip") ||
        e.target.closest(".entry__also-link");
      if (!link) return;
      let id;
      if (link.classList.contains("entry__also-link")) {
        id = link.dataset.topic;
      } else {
        id = link.dataset.see || link.dataset.recent;
      }
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      markProgrammaticScroll();
      target.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
      flashTarget(target);
      history.replaceState(null, "", `#${id}`);
      if (idIndex[id]) pushRecent(id);
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
      markProgrammaticScroll();
      target.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
      flashTarget(target);
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
    // Render the whole card as a single tappable link to the entry.
    // No more "Open in {topic}" footer — the topic name lives inline
    // as a subtle pill, and the card itself is the tap target.
    body.innerHTML = `
      <a class="wod__card" href="#${escAttr(entry.id)}" data-wod="${escAttr(entry.id)}">
        <div class="wod__word-row">
          <span class="wod__word">${esc(entry.word)}</span>
          ${pos ? `<span class="wod__pos" aria-hidden="true">${esc(pos)}</span>` : ""}
        </div>
        ${entry.definition.en ? `<p class="wod__def">${esc(entry.definition.en)}</p>` : ""}
        ${entry.definition.zh ? `<p class="wod__def-zh" lang="zh-Hant">${esc(entry.definition.zh)}</p>` : ""}
        <span class="wod__topic">in <span class="wod__topic-name">${esc(sectionData?.label.en || sectionId)}</span></span>
      </a>
    `;
    section.hidden = false;

    body.querySelector('[data-wod]')?.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.wod;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      markProgrammaticScroll();
      target.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
      flashTarget(target);
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

  // --- Random-entry shuffle button --------------------------------
  // Picks a uniformly random entry from idIndex and treats it as if
  // the user had followed a link to it: smooth-scroll, flash the
  // is-target highlight, and remember the visit in Recently Viewed.
  function setupRandomButton() {
    const btn = document.querySelector(".btn-random");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const ids = Object.keys(idIndex);
      if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      const target = document.getElementById(id);
      if (!target) return;
      if (document.activeElement === searchInput) searchInput.blur();
      markProgrammaticScroll();
      target.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
      flashTarget(target);
      history.replaceState(null, "", `#${id}`);
      pushRecent(id);
    });
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
      if (el) el.scrollIntoView({ behavior: smoothBehavior(), block: "start" });
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
    setupChips();
    setupSeeAlso();
    setupSwipeNav();
    renderRecent();
    renderWod();
    setupHint();
    setupRandomButton();
    handleInitialHash();
  });
})();
