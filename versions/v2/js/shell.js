/*
 * TLB/Scope — application shell (Version 2)
 * ----------------------------------------------------------------------------
 * Runs first on every page, before the page content is parsed, so the chrome
 * never flashes. It provides:
 *   - the masthead with page tabs, the context bar (machine spec, timeline
 *     position, last outcome), the journey stepper and a mobile tab bar
 *   - shared dialogs (command palette, keyboard help) and the toast
 *   - "next step" hand-offs, guiding empty states and the page footer
 *   - page-to-page transitions: cross-document View Transitions where the
 *     browser supports them (direction-aware, shared-element morphs), and an
 *     equally smooth JS fade/slide fallback elsewhere (e.g. file://, Firefox)
 */
(() => {
  'use strict';
  const PAGES = [
    { id: 'home', href: 'index.html', label: 'Home', icon: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
    { id: 'machine', href: 'machine.html', label: 'Machine', step: 1, icon: 'M4 7h16M4 12h16M4 17h16M8 5v4M15 10v4M11 15v4', desc: 'Configure the hardware' },
    { id: 'translate', href: 'translate.html', label: 'Translate', step: 2, icon: 'M4 12h12M12 6l6 6-6 6', desc: 'Probe one address' },
    { id: 'timeline', href: 'timeline.html', label: 'Timeline', step: 3, icon: 'M3 12h4l2-5 3 10 2-5h7', desc: 'Run a workload' },
    { id: 'structures', href: 'structures.html', label: 'Structures', step: 4, icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', desc: 'Inspect TLB, page table, frames' },
    { id: 'analytics', href: 'analytics.html', label: 'Analytics', step: 5, icon: 'M4 19V9M10 19V5M16 19v-7M22 19H2', desc: 'Measure performance' },
    { id: 'lab', href: 'lab.html', label: 'Policy lab', step: 6, icon: 'M9 3v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3M8 3h8', desc: 'Compare policies' },
    { id: 'learn', href: 'learn.html', label: 'Learn', step: 7, icon: 'M2 6l10-3 10 3-10 3zM6 8v6c3 2 9 2 12 0V8', desc: 'Theory, viva, applications' },
    { id: 'verify', href: 'verify.html', label: 'Self-test', step: 8, icon: 'M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', desc: 'Prove correctness' },
    { id: 'report', href: 'report.html', label: 'Report', step: 9, icon: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6', desc: 'Print a PDF report' },
  ];
  const NEEDS_DATA = { structures: 1, analytics: 1, report: 1 };
  const body = document.body;
  const pageId = body.dataset.page || 'home';
  const cur = PAGES.find(p => p.id === pageId) || PAGES[0];
  const idx = PAGES.indexOf(cur);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const ico = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

  /* ------------------------------------------------- visited & last page */
  let visited = [];
  try { visited = JSON.parse(store.get('tlbscope-visited') || '[]'); } catch (e) { visited = []; }
  if (!visited.includes(pageId)) { visited.push(pageId); store.set('tlbscope-visited', JSON.stringify(visited)); }
  if (pageId !== 'home') store.set('tlbscope-last', pageId);

  /* ----------------------------------------------------- transition mode */
  const nativeVT = 'CSSViewTransitionRule' in window && location.protocol !== 'file:' && !reduce;
  document.documentElement.classList.add(nativeVT ? 'vt-native' : 'vt-fallback');
  const arriving = (() => { try { return sessionStorage.getItem('tlbscope-nav'); } catch (e) { return null; } })();
  if (arriving) {
    document.documentElement.classList.add('arriving', 'dir-' + (arriving.split(':')[1] || 'fwd'));
    try { sessionStorage.removeItem('tlbscope-nav'); } catch (e) { /* ignore */ }
  }

  function direction(fromId) {
    const a = PAGES.findIndex(p => p.id === fromId);
    return a > idx ? 'back' : 'fwd';
  }

  // Cross-document View Transitions: tag the direction so CSS can slide the right way.
  window.addEventListener('pagereveal', e => {
    if (!e.viewTransition) { if (!reduce) document.documentElement.classList.add('enter'); return; }
    let from = null;
    try {
      const u = navigation.activation && navigation.activation.from && navigation.activation.from.url;
      if (u) from = (PAGES.find(p => u.split('?')[0].split('#')[0].endsWith('/' + p.href) || (p.id === 'home' && /\/$/.test(u.split('?')[0]))) || {}).id;
    } catch (err) { /* Navigation API unavailable */ }
    if (!from) { try { from = sessionStorage.getItem('tlbscope-from'); } catch (err) { /* ignore */ } }
    try { e.viewTransition.types.add(direction(from)); } catch (err) { /* older engines */ }
    e.viewTransition.finished.catch(() => {});
    e.viewTransition.ready.catch(() => {});
  });
  window.addEventListener('pageswap', () => { try { sessionStorage.setItem('tlbscope-from', pageId); } catch (e) { /* ignore */ } });

  /** Navigate with the best available transition. */
  function go(href) {
    if (window.tlbscope && window.tlbscope.flush) window.tlbscope.flush();
    const target = PAGES.find(p => href.split('?')[0].split('#')[0] === p.href);
    const dir = target ? (PAGES.indexOf(target) < idx ? 'back' : 'fwd') : 'fwd';
    if (nativeVT || reduce) { location.href = href; return; }
    try { sessionStorage.setItem('tlbscope-nav', pageId + ':' + dir); } catch (e) { /* ignore */ }
    document.documentElement.classList.add('leaving', 'leave-' + dir);
    setTimeout(() => { location.href = href; }, 230);
  }
  window.addEventListener('pageshow', e => { if (e.persisted) document.documentElement.classList.remove('leaving', 'leave-fwd', 'leave-back'); });
  window.addEventListener('pagehide', () => { if (window.tlbscope && window.tlbscope.flush) window.tlbscope.flush(); });

  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === '_blank' || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!/^[\w-]+\.html([?#].*)?$/.test(href)) return; // only our own pages
    if (href.split('#')[0] === cur.href && href.includes('#') && !href.includes('?')) return; // in-page anchor
    if (window.tlbscope && window.tlbscope.flush) window.tlbscope.flush();
    if (nativeVT) return; // the browser runs the view transition
    e.preventDefault();
    go(href);
  });

  /* ------------------------------------------------------------- chrome */
  const tabs = PAGES.filter(p => p.id !== 'home').map(p =>
    `<a href="${p.href}" title="${p.label}" class="tab${p.id === pageId ? ' on' : ''}"${p.id === pageId ? ' aria-current="page"' : ''}>${ico(p.icon)}<span>${p.label}</span>${p.id === pageId ? '<i class="tab-ind"></i>' : ''}</a>`).join('');
  const steps = PAGES.filter(p => p.step).map(p =>
    `<a href="${p.href}" class="jstep${p.id === pageId ? ' cur' : ''}${visited.includes(p.id) ? ' seen' : ''}" title="${p.desc}"><b>${p.step}</b><span>${p.label}</span></a>`).join('<i class="jline"></i>');
  const mobile = ['machine', 'translate', 'timeline', 'structures', 'analytics'].map(id => PAGES.find(p => p.id === id)).map(p =>
    `<a href="${p.href}" class="${p.id === pageId ? 'on' : ''}"${p.id === pageId ? ' aria-current="page"' : ''}>${ico(p.icon)}<span>${p.label}</span></a>`).join('') +
    `<button type="button" id="mobileMore">${ico('M5 12h.01M12 12h.01M19 12h.01')}<span>More</span></button>`;

  body.insertAdjacentHTML('afterbegin', `
<a class="skip" href="#main">Skip to content</a>
<div class="ambient" aria-hidden="true"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i><i class="gridfx"></i><i class="grain"></i></div>
<header class="masthead" role="banner">
  <a class="mark" href="index.html" aria-label="TLB/Scope home">
    <svg viewBox="0 0 40 40" aria-hidden="true" class="chip-svg"><g class="pins"><path d="M12 2v5M20 2v5M28 2v5M12 33v5M20 33v5M28 33v5M2 12h5M2 20h5M2 28h5M33 12h5M33 20h5M33 28h5"/></g><rect x="7" y="7" width="26" height="26" rx="3" class="die"/><path d="M11 22h5l2.5-6 3 9 2.5-6h5" class="trace"/></svg>
    <span class="wordmark">TLB<i>/</i>Scope<small>MMU workbench · v2</small></span>
  </a>
  <nav class="tabbar" aria-label="Pages">${tabs}</nav>
  <div class="mast-actions">
    <div class="seg" role="group" aria-label="Number format"><button type="button" data-radix="dec" aria-pressed="true">DEC</button><button type="button" data-radix="hex" aria-pressed="false">HEX</button></div>
    <button type="button" class="kbar-btn" id="paletteBtn" title="Command palette (Ctrl K)"><span>Search</span><kbd>Ctrl K</kbd></button>
    <button type="button" class="icon-btn" id="shareBtn" aria-label="Copy share link" title="Copy a link to this exact session">⤴</button>
    <button type="button" class="icon-btn" id="helpBtn" aria-label="Keyboard shortcuts" title="Shortcuts (?)">?</button>
    <button type="button" class="icon-btn" id="themeBtn" aria-label="Toggle colour theme" title="Theme (T)"><span class="sun">☼</span><span class="moon">☾</span></button>
  </div>
</header>
<div class="ctxbar" aria-label="Session">
  <div class="spec-strip" id="specStrip" aria-label="Current machine"></div>
  <div class="ctx-live"><span class="ctx-t" title="Timeline position">t <b id="ctxT">0</b><small>/<span id="ctxN">0</span></small></span><a class="ctx-out" id="ctxOut" href="translate.html">no translation yet</a></div>
</div>
${pageId !== 'home' ? `<nav class="journey" aria-label="Journey">${steps}</nav>` : ''}
<nav class="mobile-tabs" aria-label="Pages">${mobile}</nav>
<dialog id="helpDialog" class="dialog" aria-labelledby="helpTitle">
  <h2 id="helpTitle">Keyboard</h2>
  <dl class="keys">
    <dt><kbd>Ctrl K</kbd></dt><dd>Command palette: pages, scenarios, actions, translate</dd>
    <dt><kbd>/</kbd></dt><dd>Focus the address probe (Translate page)</dd>
    <dt><kbd>Enter</kbd></dt><dd>Translate the probed address</dd>
    <dt><kbd>W</kbd> / <kbd>R</kbd></dt><dd>Write / read access</dd>
    <dt><kbd>←</kbd> <kbd>→</kbd> <kbd>Space</kbd></dt><dd>Step / play the timeline (Timeline page)</dd>
    <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next page in the journey</dd>
    <dt><kbd>X</kbd> · <kbd>T</kbd></dt><dd>DEC / HEX · theme</dd>
  </dl>
  <form method="dialog"><button class="btn primary">Close</button></form>
</dialog>
<dialog id="palette" class="palette" aria-label="Command palette">
  <div class="pal-search"><span aria-hidden="true">⌕</span><input id="palInput" placeholder="Go to a page, run a scenario, or type an address like 0x12C…" autocomplete="off" spellcheck="false" aria-controls="palList"><kbd>Esc</kbd></div>
  <ul id="palList" class="pal-list" role="listbox"></ul>
  <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span>Tip: type a number to translate it</span></div>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`);

  /* -------------------------------------------- after the page is parsed */
  function finishPage() {
    const main = document.getElementById('main');
    if (!main) return;
    // guiding empty state
    if (NEEDS_DATA[pageId]) {
      const hero = main.querySelector('.page-hero');
      const html = `<div class="empty-banner" id="emptyBanner" hidden>
        <span class="eb-ic" aria-hidden="true">${ico('M12 8v4M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18')}</span>
        <div><b>Nothing to show yet.</b> This page reads your session timeline, which is empty. Fill it in one click:</div>
        <div class="eb-actions"><a class="btn" href="machine.html#scenarios">Load a scenario</a><a class="btn primary" href="translate.html?addr=300">Translate 300 →</a></div>
      </div>`;
      if (hero) hero.insertAdjacentHTML('afterend', html); else main.insertAdjacentHTML('afterbegin', html);
      const app = window.tlbscope; // app.js has already booted by DOMContentLoaded
      document.getElementById('emptyBanner').hidden = !!(app && app.state.ops.length);
    }
    // next-step hand-off
    if (pageId !== 'home') {
      const prev = PAGES[idx - 1], next = PAGES[idx + 1];
      main.insertAdjacentHTML('beforeend', `<nav class="next-step" aria-label="Continue the journey">
        ${prev ? `<a class="ns prev" href="${prev.href}"><small>← Previous${prev.step ? ' · step ' + prev.step : ''}</small><b>${prev.label}</b><span>${prev.desc || 'Start page'}</span></a>` : '<span></span>'}
        ${next ? `<a class="ns next" href="${next.href}"><small>Next · step ${next.step} →</small><b>${next.label}</b><span>${next.desc}</span></a>` : `<a class="ns next" href="index.html"><small>Journey complete →</small><b>Back to start</b><span>Try another scenario</span></a>`}
      </nav>`);
    }
    main.insertAdjacentHTML('beforeend', `<footer class="foot"><span>TLB/Scope v2 · OS mini project #45 — TLB address translation simulator</span><span>Runs entirely in your browser · your session stays on this device</span></footer>`);

    // focus the page title after a navigation, for keyboard and screen-reader users
    if (arriving || (document.referrer && document.referrer.startsWith(location.origin))) {
      const h = main.querySelector('h1');
      if (h) h.focus({ preventScroll: true });
    }
    // In-page hash targets that exist only after rendering (e.g. #pte-4) are handled by app.js.
    const more = document.getElementById('mobileMore');
    if (more) more.addEventListener('click', () => document.getElementById('paletteBtn').click());
    // speculative prefetch of neighbouring pages for instant navigation
    if (location.protocol.startsWith('http') && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify({ prefetch: [{ source: 'document', where: { href_matches: '/*.html' }, eagerness: 'moderate' }] });
      document.head.appendChild(s);
    }
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || document.querySelector('dialog[open]')) return;
      if (e.key === ']' && PAGES[idx + 1]) go(PAGES[idx + 1].href);
      if (e.key === '[' && PAGES[idx - 1]) go(PAGES[idx - 1].href);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', finishPage); else finishPage();

  /* --------------------------------------------- live session indicators */
  document.addEventListener('tlb:render', () => {
    const app = window.tlbscope;
    if (!app) return;
    const S = app.state;
    const t = document.getElementById('ctxT'), n = document.getElementById('ctxN'), out = document.getElementById('ctxOut');
    if (t) t.textContent = S.cursor;
    if (n) n.textContent = S.ops.length;
    const rec = app.currentRecord && app.currentRecord();
    if (out) {
      if (rec) {
        out.className = 'ctx-out o-' + rec.outcome;
        out.textContent = `${rec.outcome} · ${rec.addr} → ${rec.pa === null || rec.pa === undefined ? '—' : rec.pa}`;
        out.href = `translate.html?addr=${rec.addr}${rec.pid ? '&pid=' + rec.pid : ''}`;
        out.title = 'Open this translation';
      } else { out.className = 'ctx-out'; out.textContent = 'no translation yet'; out.href = 'translate.html?addr=300'; }
    }
    const eb = document.getElementById('emptyBanner');
    if (eb) eb.hidden = S.ops.length > 0;
    if (pageId === 'home') renderHome(app);
  });

  /* ------------------------------------------------------- home page */
  function renderHome(app) {
    const S = app.state, box = document.getElementById('continueBody');
    if (!box) return;
    const spec = document.getElementById('specStrip');
    const cs = document.getElementById('contSpec');
    if (cs && spec) cs.textContent = [...spec.querySelectorAll('div')].slice(0, 4).map(d => d.innerText.replace(/\s+/g, ' ')).join(' · ');
    const lastId = store.get('tlbscope-last');
    const last = PAGES.find(p => p.id === lastId);
    const st = S.mmu ? S.mmu.stats : { accesses: 0, hits: 0 };
    const hr = st.accesses ? Math.round((st.hits / st.accesses) * 100) + '%' : '—';
    const seenSteps = PAGES.filter(p => p.step && visited.includes(p.id)).length;
    box.innerHTML = S.ops.length
      ? `<div class="cont-stats"><div><b>${S.ops.length}</b><span>operations on the timeline</span></div><div><b>${st.accesses}</b><span>translations</span></div><div><b>${hr}</b><span>TLB hit ratio</span></div><div><b>${seenSteps}/9</b><span>journey steps visited</span></div></div>
         <div class="cont-actions">${last ? `<a class="btn primary" href="${last.href}">Resume on ${last.label} →</a>` : ''}<a class="btn" href="analytics.html">See the analytics</a><a class="btn" href="report.html">Print a report</a></div>`
      : `<p class="muted">No session yet. Start with a one-click scenario, or translate your first address.</p>
         <div class="cont-actions"><a class="btn primary" href="machine.html#scenarios">Pick a scenario →</a><a class="btn" href="translate.html?addr=300&explain=1">Translate 300 and explain it</a></div>`;
    document.querySelectorAll('[data-visited]').forEach(el => { const on = visited.includes(el.dataset.visited); el.textContent = on ? 'visited ✓' : ''; el.classList.toggle('on', on); });
  }

  window.tlbshell = { pages: PAGES, page: pageId, go, nativeVT, visited };
})();
