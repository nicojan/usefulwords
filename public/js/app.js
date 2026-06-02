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

    let chips = "";
    if (section.categories) {
      chips = `
        <nav class="chips" aria-label="${esc(section.label.en)} categories">
          ${section.categories
            .map(
              (c) => `
              <a class="chip" href="#cat-${escAttr(c.id)}" data-chip="${escAttr(c.id)}">
                ${esc(c.label.en)}
              </a>`
            )
            .join("")}
        </nav>`;

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
        ${chips}
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

  function setupTabbar() {
    const sections = Array.from(document.querySelectorAll(".section"));
    if (!sections.length) return;

    const chipsBar = document.querySelector(".chips");

    function activate(id) {
      tabs.forEach((t) =>
        t.setAttribute("aria-current", t.dataset.target === id ? "true" : "false")
      );
      // Show the sub-nav chips only when transitions is the active
      // section (i.e. dominant in the viewport). The CSS rule for
      // narrow viewports also adds matching bottom padding to the
      // body so the last entry clears the floating chip bar.
      const isTrans = id === "transitions";
      if (chipsBar) chipsBar.classList.toggle("is-visible", isTrans);
      document.body.classList.toggle("chips-visible", isTrans);
    }

    function sync() {
      // Probe deep enough to clear section padding/margins.
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

  function setupChips() {
    const chips = Array.from(document.querySelectorAll(".chip"));
    if (!chips.length) return;
    const cats = Array.from(document.querySelectorAll(".category"));

    function activate(id) {
      chips.forEach((c) =>
        c.setAttribute("aria-current", c.dataset.chip === id ? "true" : "false")
      );
    }

    let lastActive = null;
    function sync() {
      const probe = topbarHeight() + 140;
      let current = null;
      for (const c of cats) {
        if (c.hidden) continue;
        if (c.getBoundingClientRect().top <= probe) current = c.dataset.cat;
      }
      // If we're inside the transitions section but no category top
      // has crossed the probe yet, default to the first category.
      if (!current) {
        const trans = document.getElementById("transitions");
        if (trans && !trans.hidden && trans.getBoundingClientRect().top <= probe && cats.length) {
          current = cats[0].dataset.cat;
        }
      }
      if (!current) return;
      activate(current);
      if (current !== lastActive) {
        lastActive = current;
        const activeChip = document.querySelector(`.chip[data-chip="${current}"]`);
        if (activeChip) {
          activeChip.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "center",
          });
        }
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
    sync();

    chips.forEach((c) => {
      c.addEventListener("click", (e) => {
        e.preventDefault();
        const id = c.dataset.chip;
        const el = document.getElementById(`cat-${id}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          history.replaceState(null, "", `#cat-${id}`);
        }
      });
    });
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
    handleInitialHash();
  });
})();
