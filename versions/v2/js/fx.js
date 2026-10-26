/*
 * TLB/Scope — effects layer
 * ----------------------------------------------------------------------------
 * Purely presentational: boot splash, scroll reveals, pointer spotlight,
 * sliding nav pill, the live hero MMU animation and the command palette.
 * Everything degrades gracefully and respects prefers-reduced-motion.
 */
(() => {
  'use strict';
  const E = window.TLBEngine;
  const app = window.tlbscope;
  const $ = id => document.getElementById(id);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ============================================================ splash */
  function splash() {
    const el = $('splash');
    if (!el) return;
    let seen = false;
    try { seen = sessionStorage.getItem('tlbscope-booted') === '1'; sessionStorage.setItem('tlbscope-booted', '1'); } catch (e) { /* ignore */ }
    if (seen || reduce) { el.remove(); return; }
    const lines = ['initialising MMU…', 'sizing TLB · 4 entries…', 'walking page tables…', 'self-test armed · ready'];
    lines.forEach((l, i) => setTimeout(() => { const t = $('splashLine'); if (t) t.textContent = l; }, i * 280));
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 700); }, 1250);
  }

  /* ============================================================ reveal */
  function reveal() {
    const targets = [...document.querySelectorAll('.page > .card, .page > .section-head, .page > .duo > .card, .kpis > .kpi, .notes-grid > .note, .apps-grid > .app-card, .journey-grid > .jcard, .machine-layout > .card, .page > .next-step')];
    if (reduce || !('IntersectionObserver' in window)) return;
    const fold = innerHeight * 0.92;
    targets.splice(0, targets.length, ...targets.filter(el => el.getBoundingClientRect().top > fold));
    const counts = new Map();
    targets.forEach(el => {
      const p = el.parentElement;
      const i = counts.get(p) || 0;
      counts.set(p, i + 1);
      if (p.classList.contains('kpis') || p.classList.contains('notes-grid') || p.classList.contains('apps-grid') || p.classList.contains('duo')) el.style.setProperty('--rd', (i % 4) * 0.08 + 's');
      el.classList.add('reveal');
    });
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: 0.06, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(el => io.observe(el));
    // Safety: never leave content hidden (e.g. print, very tall elements)
    setTimeout(() => targets.forEach(el => { const r = el.getBoundingClientRect(); if (r.top < innerHeight) el.classList.add('in'); }), 1600);
    window.addEventListener('beforeprint', () => targets.forEach(el => el.classList.add('in')));
    window.addEventListener('beforeprint', () => { const m = document.getElementById('printMeta'); if (m) m.textContent = new Date().toLocaleString() + ' · ' + document.getElementById('specStrip').innerText.replace(/\s+/g, ' ').trim(); });
  }

  /* ========================================================= spotlight */
  function spotlight() {
    if (reduce) return;
    let raf = 0, ev = null;
    document.addEventListener('pointermove', e => {
      ev = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const t = ev.target.closest && ev.target.closest('.card, .scenario');
        if (!t) return;
        const r = t.getBoundingClientRect();
        t.style.setProperty('--mx', ev.clientX - r.left + 'px');
        t.style.setProperty('--my', ev.clientY - r.top + 'px');
      });
    }, { passive: true });
  }

  /* ======================================================= masthead/nav */
  function chrome() {
    const mast = document.querySelector('.masthead');
    const onScroll = () => mast.classList.toggle('scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    const nav = document.querySelector('.jump');
    if (!nav) return;
    const pill = document.createElement('span');
    pill.className = 'pill-ind';
    pill.style.opacity = '0';
    nav.prepend(pill);
    const moveTo = a => {
      if (!a) { pill.style.opacity = '0'; return; }
      pill.style.opacity = '1';
      pill.style.left = a.offsetLeft + 'px';
      pill.style.width = a.offsetWidth + 'px';
    };
    nav.addEventListener('pointerover', e => { const a = e.target.closest('a'); if (a) moveTo(a); });
    nav.addEventListener('pointerleave', () => moveTo(nav.querySelector('a.on')));
    new MutationObserver(() => { if (!nav.matches(':hover')) moveTo(nav.querySelector('a.on')); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function heroFacts() {
    document.querySelectorAll('.hero-facts dt[data-count]').forEach((dt, i) => {
      const to = +dt.dataset.count;
      if (reduce) return;
      const t0 = performance.now() + 700 + i * 90;
      dt.textContent = '0';
      const step = now => {
        const k = Math.max(0, Math.min(1, (now - t0) / 1100)), e = 1 - Math.pow(1 - k, 4);
        dt.textContent = Math.round(to * e);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* ========================================================== hero MMU */
  function heroMMU() {
    const svg = $('heroSvg');
    if (!svg || !E) return;
    const cfg = { vaBits: 12, paBits: 9, pageSize: 64, tlbEntries: 4, tlbPolicy: 'LRU', mapping: 'empty', faultMode: 'demand', framePolicy: 'CLOCK', seed: 7 };
    let mmu = new E.MMU(cfg);
    let seed = 11, queue = [];
    const nextOp = () => {
      if (!queue.length) {
        // Working set drifts every batch so faults keep happening, but locality dominates.
        const base = (seed * 5) % 56;
        queue = E.generate('locality', cfg, 40, seed++).map(o => ({ addr: ((Math.floor(o.addr / 64) + base) % 64) * 64 + (o.addr % 64) }));
      }
      return queue.shift();
    };

    const el = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.appendChild(n); return n; };
    svg.innerHTML = `<defs>
      <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
    const node = (id, x, y, w, h, title, sub) => {
      const g = el('g', { class: 'hnode', id: 'hn-' + id });
      el('rect', { x, y, width: w, height: h, rx: 14 }, g);
      el('text', { x: x + 14, y: y + 22 }, g).textContent = title;
      el('text', { x: x + 14, y: y + 37, class: 'sub' }, g).textContent = sub;
      return g;
    };
    const P = {
      cpuTlb: 'M116 180 C 150 180, 150 92, 188 92',
      tlbRam: 'M342 92 C 392 92, 392 168, 428 168',
      tlbPt: 'M265 146 L 265 232',
      ptRam: 'M342 262 C 392 262, 392 194, 428 194',
      ptDisk: 'M342 282 C 392 282, 392 312, 428 312',
      diskRam: 'M486 282 L 486 222',
    };
    const FLOW = { cpuTlb: 'var(--ctx)', tlbRam: 'var(--hit)', tlbPt: 'var(--miss)', ptRam: 'var(--miss)', ptDisk: 'var(--fault)', diskRam: 'var(--fault)' };
    const paths = {};
    for (const k in P) {
      el('path', { d: P[k], class: 'wire' });
      el('path', { d: P[k], class: 'flow', stroke: FLOW[k] });
      paths[k] = el('path', { d: P[k], fill: 'none', stroke: 'none' });
    }
    node('cpu', 20, 150, 96, 62, 'CPU', 'VIRTUAL ADDR');
    node('tlb', 188, 38, 154, 108, 'TLB', '4-ENTRY · LRU');
    node('pt', 188, 232, 154, 72, 'Page table', 'WALK ON MISS');
    node('ram', 428, 140, 116, 82, 'RAM', 'FRAME + OFFSET');
    node('disk', 428, 282, 116, 60, 'Disk', 'PAGE-IN ON FAULT');
    el('text', { x: 360, y: 80, class: 'lbl' }).textContent = 'HIT';
    el('text', { x: 272, y: 196, class: 'lbl' }).textContent = 'MISS';
    el('text', { x: 360, y: 306, class: 'lbl' }).textContent = 'FAULT';
    const slots = [], slotT = [];
    for (let i = 0; i < 4; i++) {
      slots.push(el('rect', { x: 202 + i * 34, y: 106, width: 30, height: 28, rx: 7, class: 'tlbslot' }));
      const t = el('text', { x: 217 + i * 34, y: 124, class: 'slot-t', 'text-anchor': 'middle' });
      t.textContent = '—';
      slotT.push(t);
    }
    const trail = [];
    for (let i = 5; i >= 0; i--) trail.push(el('circle', { r: 2 + (5 - i) * 0.9, cx: -50, cy: -50, opacity: 0.12 + (5 - i) * 0.14, class: 'packet' }));
    const head = trail[trail.length - 1];
    head.setAttribute('r', 6);

    const hits = $('hvHit'), misses = $('hvMiss'), faults = $('hvFault'), ratio = $('hvRatio'), addr = $('hvAddr');
    let visible = true, busy = false;
    const ping = (id, color) => {
      const g = $('hn-' + id);
      g.style.setProperty('--c', color);
      g.classList.add('ping');
      setTimeout(() => g.classList.remove('ping'), 420);
    };
    const drawSlots = rec => {
      const entries = mmu.tlbEntries();
      for (let i = 0; i < 4; i++) {
        const e = entries.find(x => x.way === i);
        slotT[i].textContent = e ? e.vpn : '—';
        slots[i].classList.toggle('on', !!(rec && rec.tlbSlot && rec.tlbSlot.way === i));
      }
    };
    const travel = (keys, color, done) => {
      const segs = keys.map(k => ({ p: paths[k], len: paths[k].getTotalLength(), k }));
      const total = segs.reduce((a, s) => a + s.len, 0);
      const speed = 0.36; // px per ms
      const dur = total / speed;
      trail.forEach(c => c.setAttribute('fill', color));
      const at = d => {
        d = Math.max(0, Math.min(total, d));
        for (const s of segs) { if (d <= s.len) return s.p.getPointAtLength(d); d -= s.len; }
        const last = segs[segs.length - 1]; return last.p.getPointAtLength(last.len);
      };
      const ends = [];
      segs.reduce((a, s) => { ends.push([a + s.len, s.k]); return a + s.len; }, 0);
      let fired = 0;
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const d = e * total;
        trail.forEach((c, i) => { const pt = at(d - (trail.length - 1 - i) * 7); c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); });
        while (fired < ends.length && d >= ends[fired][0] - 0.5) {
          const target = { cpuTlb: 'tlb', tlbRam: 'ram', tlbPt: 'pt', ptRam: 'ram', ptDisk: 'disk', diskRam: 'ram' }[ends[fired][1]];
          ping(target, target === 'ram' ? color : FLOW[ends[fired][1]]);
          fired++;
        }
        if (k < 1) requestAnimationFrame(step);
        else { trail.forEach(c => { c.setAttribute('cx', -50); c.setAttribute('cy', -50); }); done(); }
      };
      ping('cpu', 'var(--ctx)');
      requestAnimationFrame(step);
    };
    const loop = () => {
      if (!visible || document.hidden) { busy = false; return; }
      busy = true;
      if (mmu.stats.accesses > 600) mmu = new E.MMU(cfg);
      const op = nextOp();
      const rec = mmu.access(op);
      addr.textContent = `VA ${E.toHex(rec.addr, 12)} → ${rec.pa === null ? '—' : 'PA ' + E.toHex(rec.pa, 9)}`;
      const keys = rec.outcome === 'HIT' ? ['cpuTlb', 'tlbRam'] : rec.outcome === 'MISS' ? ['cpuTlb', 'tlbPt', 'ptRam'] : ['cpuTlb', 'tlbPt', 'ptDisk', 'diskRam'];
      const color = rec.outcome === 'HIT' ? 'var(--hit)' : rec.outcome === 'MISS' ? 'var(--miss)' : 'var(--fault)';
      travel(keys, color, () => {
        drawSlots(rec);
        const s = mmu.stats;
        hits.textContent = s.hits; misses.textContent = s.misses - s.pageFaults; faults.textContent = s.pageFaults;
        ratio.textContent = Math.round(mmu.metrics().hitRatio * 100) + '%';
        setTimeout(loop, 260);
      });
    };
    drawSlots(null);
    if (reduce) { for (let i = 0; i < 30; i++) mmu.access(nextOp()); drawSlots(null); ratio.textContent = Math.round(mmu.metrics().hitRatio * 100) + '%'; return; }
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !busy) loop(); });
    io.observe(svg);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && !busy) loop(); });
  }

  /* =================================================== command palette */
  function palette() {
    const dlg = $('palette'), input = $('palInput'), list = $('palList');
    if (!dlg || !app) return;
    const shell = window.tlbshell;
    const page = shell ? shell.page : '';
    const go = href => (shell ? shell.go(href) : (location.href = href));
    const here = id => document.getElementById(id);
    const base = [
      ...(shell ? shell.pages : []).map(pg => ({ grp: 'Pages', icon: pg.step ? String(pg.step) : '⌂', label: pg.label, hint: pg.desc || 'Start page', run: () => go(pg.href) })),
      ...app.scenarios.map(s => ({ grp: 'Scenarios', icon: '◆', color: s.color, label: s.name, hint: s.sub, run: () => { app.loadScenario(s.id); if (['home', 'learn', 'verify', 'lab', 'report'].includes(page)) setTimeout(() => go('translate.html?explain=1'), 250); } })),
      { grp: 'Actions', icon: '▶', label: 'Play timeline from the start', run: () => (here('scope') ? (app.rewind(), app.play()) : go('timeline.html?play=1')) },
      { grp: 'Actions', icon: '∑', label: 'Explain the last translation', run: () => (here('showHow') ? here('showHow').click() : go('translate.html?explain=1')) },
      { grp: 'Actions', icon: '✓', label: 'Run built-in self-test', run: () => (here('bistOut') ? app.runBist() : go('verify.html')) },
      { grp: 'Actions', icon: '⫶', label: 'Run policy lab experiment', run: () => (here('labOut') ? app.runLab() : go('lab.html?run=1')) },
      { grp: 'Actions', icon: '⎙', label: 'Open printable report', run: () => go('report.html') },
      { grp: 'Actions', icon: '◐', label: 'Toggle light / dark theme', run: app.toggleTheme },
      { grp: 'Actions', icon: '#', label: 'Show numbers in HEX', run: () => app.setRadix('hex') },
      { grp: 'Actions', icon: '#', label: 'Show numbers in DEC', run: () => app.setRadix('dec') },
      { grp: 'Actions', icon: '⤴', label: 'Copy share link', run: app.shareLink },
      { grp: 'Actions', icon: '↓', label: 'Export log as CSV', run: app.exportCSV },
      { grp: 'Actions', icon: '↓', label: 'Export session JSON', run: app.exportJSON },
      { grp: 'Actions', icon: '⌫', label: 'Clear run', run: app.clear },
      ...['LRU', 'FIFO', 'LFU', 'CLOCK', 'RANDOM'].map(p => ({ grp: 'TLB policy', icon: '⟳', label: `Switch TLB policy to ${p}`, hint: 'replays timeline', run: () => app.setPolicy(p) })),
    ];
    let items = [], sel = 0;
    const build = () => {
      const q = input.value.trim();
      const out = [];
      const m = /^(w(?:rite)?\s+|r(?:ead)?\s+)?(.+)$/i.exec(q);
      if (q && m) {
        const a = E.parseAddress(m[2]);
        if (a.ok) {
          const w = !!(m[1] && /^w/i.test(m[1]));
          out.push({ grp: 'Translate', icon: '→', label: `${w ? 'Write' : 'Read'} address ${a.value} (${E.toHex(a.value, 16)})`, hint: 'Enter', run: () => (here('addr') ? app.translate(String(a.value), w) : go(`translate.html?addr=${a.value}${w ? '&w=1' : ''}`)) });
          if (!w) out.push({ grp: 'Translate', icon: '✎', label: `Write address ${a.value}`, run: () => (here('addr') ? app.translate(String(a.value), true) : go(`translate.html?addr=${a.value}&w=1`)) });
        }
      }
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      base.forEach(it => { const hay = (it.label + ' ' + (it.hint || '') + ' ' + it.grp).toLowerCase(); if (words.every(w => hay.includes(w))) out.push(it); });
      items = out; sel = 0; draw();
    };
    const draw = () => {
      if (!items.length) { list.innerHTML = '<li class="none">No matches. Try a scenario name, “policy”, or an address like 0x12C.</li>'; return; }
      let grp = '', html = '';
      items.forEach((it, i) => {
        if (it.grp !== grp) { grp = it.grp; html += `<li class="grp" role="presentation">${esc(grp)}</li>`; }
        html += `<li role="option" data-i="${i}" aria-selected="${i === sel}"><i style="${it.color ? `color:${it.color}` : ''}">${it.icon}</i>${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</li>`;
      });
      list.innerHTML = html;
      const cur = list.querySelector('[aria-selected="true"]');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    };
    const open = () => { if (dlg.open) return; input.value = ''; build(); dlg.showModal(); input.focus(); };
    const runSel = () => { const it = items[sel]; if (!it) return; dlg.close(); setTimeout(it.run, 40); };
    input.addEventListener('input', build);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
    });
    list.addEventListener('pointermove', e => { const li = e.target.closest('[data-i]'); if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; draw(); } });
    list.addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) { sel = +li.dataset.i; runSel(); } });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); dlg.open ? dlg.close() : open(); } });
    ['paletteBtn', 'heroPalette'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', open); });
    if (/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelectorAll('kbd').forEach(k => { k.textContent = k.textContent.replace('Ctrl K', '⌘K'); });
  }

  splash();
  reveal();
  spotlight();
  chrome();
  heroFacts();
  heroMMU();
  palette();
})();
