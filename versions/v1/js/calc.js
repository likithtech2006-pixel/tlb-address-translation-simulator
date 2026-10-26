/*
 * TLB/Scope — Calculation player
 * ----------------------------------------------------------------------------
 * Replays one translation as an animated derivation:
 *   - a computation graph whose edges draw and nodes fill in as values are computed
 *   - a worksheet whose formulas morph from symbols → substituted numbers → result
 *   - a time ledger whose nanosecond segments grow as each hardware stage costs time
 * All numbers come from the engine's record of the access plus the machine state
 * immediately before it, so the worksheet is the real computation, not a script.
 */
(() => {
  'use strict';
  const app = window.tlbscope;
  const E = window.TLBEngine;
  if (!app || !E) return;
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ------------------------------------------------------------ graph */
  const NODES = {
    va: { x: 20, y: 120, w: 92, label: 'VIRTUAL ADDR' },
    vpn: { x: 150, y: 55, w: 92, label: 'VPN' },
    off: { x: 150, y: 190, w: 92, label: 'OFFSET' },
    tlb: { x: 285, y: 55, w: 92, label: 'TLB' },
    pt: { x: 285, y: 140, w: 92, label: 'PAGE TABLE' },
    os: { x: 420, y: 190, w: 92, label: 'OS · FAULT' },
    pfn: { x: 420, y: 55, w: 92, label: 'PFN' },
    pa: { x: 548, y: 120, w: 84, label: 'PHYS ADDR' },
  };
  const H = 50;
  const EDGES = {
    'va-vpn': 'M112 138 C 131 138, 131 80, 150 80',
    'va-off': 'M112 152 C 131 152, 131 215, 150 215',
    'vpn-tlb': 'M242 80 L 285 80',
    'tlb-pfn': 'M377 80 L 420 80',
    'tlb-pt': 'M331 105 L 331 140',
    'pt-pfn': 'M377 158 C 399 158, 399 86, 420 86',
    'pt-os': 'M377 176 C 399 176, 399 215, 420 215',
    'os-pfn': 'M466 190 L 466 105',
    'pfn-pa': 'M512 80 C 532 80, 530 136, 548 136',
    'off-pa': 'M242 222 C 330 268, 520 268, 590 170',
  };
  const G = {};
  function buildGraph() {
    const svg = $('cGraph');
    svg.innerHTML = `<defs>
      <linearGradient id="cg-edge" x1="0" x2="1"><stop offset="0" stop-color="var(--accent-b)"/><stop offset="1" stop-color="var(--accent-a)"/></linearGradient>
      <filter id="cg-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
    const mk = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.appendChild(n); return n; };
    G.edges = {};
    for (const k in EDGES) {
      mk('path', { d: EDGES[k], class: 'cg-wire' });
      const p = mk('path', { d: EDGES[k], class: 'cg-edge', 'data-e': k });
      const len = p.getTotalLength ? p.getTotalLength() : 200;
      p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
      G.edges[k] = { el: p, len };
    }
    G.nodes = {};
    for (const k in NODES) {
      const n = NODES[k];
      const g = mk('g', { class: 'cg-node', 'data-n': k });
      mk('rect', { x: n.x, y: n.y, width: n.w, height: H, rx: 12 }, g);
      mk('text', { x: n.x + 10, y: n.y + 16, class: 'cg-l' }, g).textContent = n.label;
      const v = mk('text', { x: n.x + 10, y: n.y + 38, class: 'cg-v' }, g);
      v.textContent = '—';
      G.nodes[k] = { g, v };
    }
    G.token = mk('circle', { r: 5, class: 'cg-token', cx: -20, cy: -20, filter: 'url(#cg-glow)' });
  }

  /* ---------------------------------------------------- step builder */
  const fmtB = (n, bits) => E.toBin(n, bits).replace(/(.{4})(?=.)/g, '$1 ');
  const hx = n => '0x' + n.toString(16).toUpperCase();
  const morph = (seq, cls = '') => `<span class="morph ${cls}" data-seq="${esc(JSON.stringify(seq))}">${esc(seq[0])}</span>`;
  const OC = { HIT: 'hit', MISS: 'miss', FAULT: 'fault', PROT: 'prot' };

  function build(rec) {
    const st = app.state, c = st.cfg, g = E.geometry(c);
    const before = app.stateBefore(rec);
    const S = c.pageSize, n = g.offsetBits;
    const steps = [];
    const color = OC[rec.outcome];
    // 1 — the address
    steps.push({
      key: 'VA', title: 'Read the virtual address', nodes: { va: rec.addr }, edges: [], tone: 'ctx',
      html: `<p>The CPU issues a <b>${rec.write ? 'write' : 'read'}</b>${c.processes > 1 ? ` from <b>P${rec.pid}</b>` : ''}.</p>
        <div class="eq"><span class="k">VA</span> = <b>${rec.addr}</b> = ${hx(rec.addr)} = <span class="bin">${fmtB(rec.addr, c.vaBits)}</span>₂</div>`,
    });
    // 2 — split
    steps.push({
      key: 'SPLIT', title: 'Split into page number and offset', nodes: { vpn: rec.vpn, off: rec.offset }, edges: ['va-vpn', 'va-off'], tone: 'ctx',
      html: `<div class="eq"><span class="k">offset bits</span> = log₂ S = log₂ ${S} = <b>${n}</b> · <span class="k">VPN bits</span> = ${c.vaBits} − ${n} = <b>${g.vpnBits}</b></div>
        <div class="eq"><span class="k">VPN</span> = ${morph(['⌊VA ÷ S⌋', `⌊${rec.addr} ÷ ${S}⌋`, `⌊${(rec.addr / S).toFixed(3).replace(/\.?0+$/, '')}⌋`, String(rec.vpn)], 'res')}</div>
        <div class="eq"><span class="k">offset</span> = ${morph(['VA mod S', `${rec.addr} mod ${S}`, `${rec.addr} − ${rec.vpn} × ${S}`, String(rec.offset)], 'res')}</div>
        <div class="bits-split"><span class="bs vpn">${fmtB(rec.vpn, g.vpnBits)}</span><span class="bs off">${fmtB(rec.offset, n)}</span></div>`,
    });
    // 3 — TLB search
    const set = rec.set;
    const row = before ? before.tlb[set] : [];
    const filled = row.map((e, w) => ({ e, w })).filter(x => x.e);
    const shown = filled.slice(0, 8);
    const cmp = shown.map(({ e, w }) => {
      const ok = e.vpn === rec.vpn && e.asid === rec.pid;
      return `<li class="${ok ? 'ok' : 'no'}"><span>way ${w}</span><code>(P${e.asid}, ${e.vpn})</code> ≟ <code>(P${rec.pid}, ${rec.vpn})</code><b>${ok ? '✓ match' : '✗'}</b></li>`;
    }).join('');
    const empties = row.length - filled.length;
    steps.push({
      key: 'TLB', title: rec.hit ? 'Search the TLB — hit' : 'Search the TLB — miss', nodes: { tlb: rec.hit ? 'HIT' : 'MISS' }, edges: ['vpn-tlb'], tone: rec.hit ? 'hit' : 'miss', cost: ['t', c.t],
      html: `${g.fullyAssociative ? '<p>Fully associative: every entry is compared <b>in parallel</b>.</p>' : `<div class="eq"><span class="k">set</span> = VPN mod sets = ${rec.vpn} mod ${g.sets} = <b>${set}</b> · <span class="k">tag</span> = ⌊${rec.vpn} ÷ ${g.sets}⌋ = <b>${rec.tag}</b></div>`}
        <ul class="cmp">${cmp || '<li class="no"><span>—</span>TLB set is empty<b>✗</b></li>'}</ul>
        ${filled.length > shown.length ? `<p class="muted">… and ${filled.length - shown.length} more entries compared in parallel.</p>` : ''}${empties ? `<p class="muted">${empties} invalid way${empties > 1 ? 's' : ''} skipped.</p>` : ''}
        <p>${rec.hit ? `<b class="t-hit">TLB hit</b> → PFN <b>${rec.pfn}</b> in one lookup (${c.t} ns). The page table is not touched.` : `<b class="t-miss">TLB miss</b> → the hardware must walk the page table.`}</p>`,
    });
    if (!rec.hit) {
      // 4 — page walk
      let shift = g.vpnBits;
      const lv = g.levelBits.map((bits, i) => {
        shift -= bits;
        return `<div class="eq"><span class="k">L${i + 1} index</span> = ${morph([`⌊VPN ÷ 2^${shift}⌋ mod 2^${bits}`, `⌊${rec.vpn} ÷ ${2 ** shift}⌋ mod ${2 ** bits}`, String(rec.levels[i])], 'res')}</div>`;
      }).join('');
      const pte = before ? before.pte(rec.pid, rec.vpn) : null;
      steps.push({
        key: 'WALK', title: `Walk the ${c.ptLevels}-level page table`, nodes: { pt: rec.pageFault ? 'P = 0' : `→ ${rec.pfn}` }, edges: ['tlb-pt'], tone: rec.pageFault ? 'fault' : 'miss', cost: ['walk', c.ptLevels * c.m],
        html: `${c.ptLevels > 1 ? lv : `<div class="eq"><span class="k">PTE address</span> = PTBR + VPN × size = PTBR + ${rec.vpn} × PTE</div>`}
          <div class="pte-card ${rec.pageFault ? 'bad' : ''}"><span>PTE[P${rec.pid}:${rec.vpn}]</span><b>present = ${pte && pte.present ? 1 : 0}</b><b>PFN = ${pte && pte.present ? pte.pfn : '—'}</b><b>W = ${pte ? +pte.writable : '—'}</b><b>D = ${pte ? +pte.dirty : '—'}</b></div>
          <div class="eq"><span class="k">cost</span> = k · m = ${c.ptLevels} × ${c.m} = <b>${c.ptLevels * c.m} ns</b></div>`,
      });
      if (rec.pageFault) {
        // 5 — fault
        const f = rec.fault;
        steps.push({
          key: 'FAULT', title: rec.serviced ? 'Page fault — OS pages it in' : 'Page fault — trap raised', nodes: { os: rec.serviced ? `F${f.pfn}` : 'TRAP' }, edges: ['pt-os'], tone: 'fault', cost: rec.serviced ? ['fault', c.faultTime] : null,
          html: rec.serviced
            ? `<p>The present bit is 0, so the CPU traps to the OS.</p>
               <div class="eq"><span class="k">frame</span> = ${f.usedFreeFrame ? `first free frame = <b>${f.pfn}</b>` : `${c.framePolicy} victim = <b>${f.pfn}</b> (held P${f.evicted.pid}:${f.evicted.vpn})`}</div>
               ${f.evicted ? `<p>${f.evicted.dirty ? '<b class="t-fault">Dirty</b> → written back to disk first.' : 'Clean → simply dropped.'}${f.evicted.shotDown ? ' Its stale TLB entry is shot down.' : ''}</p>` : ''}
               <div class="eq"><span class="k">service time</span> S = <b>${c.faultTime} ns</b></div>`
            : `<p>The present bit is 0. In <b>report-only</b> mode the trap is recorded and nothing is loaded, so <b class="t-fault">no frame and no physical address</b> exist.</p>`,
        });
        if (rec.serviced) steps[steps.length - 1].edges.push('os-pfn'), steps[steps.length - 1].nodes.pfn = rec.pfn;
      } else {
        steps[steps.length - 1].edges.push('pt-pfn');
        steps[steps.length - 1].nodes.pfn = rec.pfn;
      }
      if (rec.tlbSlot) {
        const ev = rec.tlbEvicted;
        steps.push({
          key: 'FILL', title: 'Refill the TLB', nodes: { tlb: 'FILLED' }, edges: [], tone: 'miss',
          html: `<div class="eq"><span class="k">insert</span> (P${rec.pid}, VPN ${rec.vpn}) → PFN ${rec.pfn} into set ${rec.tlbSlot.set}, way ${rec.tlbSlot.way}</div>
            <p>${ev ? `The set was full, so <b>${c.tlbPolicy}</b> evicts <code>(P${ev.asid}, ${ev.vpn}) → ${ev.pfn}</code> (inserted t${ev.insertedAt}, last used t${ev.lastUse}).` : 'A free way was available, so nothing is evicted.'}</p>`,
        });
      }
    } else {
      steps[steps.length - 1].edges.push('tlb-pfn');
      steps[steps.length - 1].nodes.pfn = rec.pfn;
    }
    if (rec.outcome === 'PROT') {
      steps.push({
        key: 'PROT', title: 'Permission check fails', nodes: { pa: 'BLOCKED' }, edges: [], tone: 'prot',
        html: `<div class="eq"><span class="k">write</span> ∧ <span class="k">W bit</span> = 1 ∧ 0 = <b class="t-prot">fault</b></div><p>The page is read-only, so the MMU raises a <b class="t-prot">protection fault</b>. Memory is not accessed and no PA is produced.</p>`,
      });
    }
    if (rec.pa !== null && rec.pa !== undefined) {
      steps.push({
        key: 'PA', title: 'Compute the physical address', nodes: { pa: rec.pa }, edges: ['pfn-pa', 'off-pa'], tone: color, cost: ['data', c.m],
        html: `<div class="eq big"><span class="k">PA</span> = ${morph(['PFN × S + offset', `${rec.pfn} × ${S} + ${rec.offset}`, `${rec.pfn * S} + ${rec.offset}`, String(rec.pa)], 'res big')}</div>
          <div class="bits-split pa"><span class="bs pfn">${fmtB(rec.pfn, g.pfnBits)}</span><span class="bs off">${fmtB(rec.offset, n)}</span><em>= ${hx(rec.pa)}</em></div>
          <p>The offset bits pass through unchanged; only the page number is replaced by the frame number.</p>`,
      });
    }
    // final — total cost
    const parts = [['t', c.t]];
    if (!rec.hit) parts.push([`${c.ptLevels}·m`, c.ptLevels * c.m]);
    if (rec.serviced) parts.push(['S', c.faultTime]);
    if (rec.pa !== null && rec.pa !== undefined) parts.push(['m', c.m]);
    steps.push({
      key: 'COST', title: 'Total access time', nodes: {}, edges: [], tone: color,
      html: `<div class="eq big"><span class="k">time</span> = ${morph([parts.map(p => p[0]).join(' + '), parts.map(p => p[1]).join(' + '), `${rec.cost} ns`], 'res big')}</div>
        <p class="muted">Compare: a TLB hit costs t + m = ${c.t + c.m} ns; a clean miss costs t + ${c.ptLevels + 1}m = ${c.t + (c.ptLevels + 1) * c.m} ns.</p>`,
    });
    return { rec, steps, cfg: c };
  }

  /* --------------------------------------------------------- player */
  const P = { calc: null, i: -1, playing: false, timer: null, speed: 1, morphTimers: [], key: null, tokenRaf: 0, open: false, always: false };
  try { P.always = localStorage.getItem('tlbscope-explain') === '1'; } catch (e) { /* storage unavailable */ }
  const DUR = 1700;

  function stepDuration(step) {
    const m = (step.html.match(/class="morph/g) || []).length;
    return (DUR + m * 380) / P.speed;
  }

  function renderRail() {
    const rail = $('cRail');
    if (!P.calc) { rail.innerHTML = ''; return; }
    rail.innerHTML = P.calc.steps.map((s, i) => `<button type="button" role="tab" class="rd t-${s.tone}${i < P.i ? ' done' : ''}${i === P.i ? ' cur' : ''}" data-i="${i}" aria-selected="${i === P.i}" title="${esc(s.title)}"><i>${i + 1}</i><span>${esc(s.key)}</span></button>`).join('<b class="rl"></b>');
  }

  function resetGraph() {
    for (const k in G.edges) { const e = G.edges[k]; e.el.style.transition = 'none'; e.el.style.strokeDashoffset = e.len; e.el.setAttribute('class', 'cg-edge'); }
    for (const k in G.nodes) { G.nodes[k].g.setAttribute('class', 'cg-node'); G.nodes[k].v.textContent = '—'; }
    G.token.setAttribute('cx', -20); G.token.setAttribute('cy', -20);
  }

  function applyStepGraph(step, animate) {
    for (const k in step.nodes) {
      const nd = G.nodes[k];
      nd.v.textContent = String(step.nodes[k]);
      nd.g.setAttribute('class', `cg-node on t-${step.tone}${animate ? ' pop' : ''}`);
    }
    step.edges.forEach(k => {
      const e = G.edges[k];
      e.el.setAttribute('class', `cg-edge on t-${step.tone}`);
      e.el.style.transition = animate ? `stroke-dashoffset ${Math.round(700 / P.speed)}ms cubic-bezier(.6,0,.2,1)` : 'none';
      e.el.style.strokeDashoffset = 0;
    });
    if (animate && step.edges.length && !reduce) runToken(step.edges.map(k => G.edges[k].el), step.tone);
  }

  function runToken(paths, tone) {
    cancelAnimationFrame(P.tokenRaf);
    const t0 = performance.now(), dur = 700 / P.speed;
    G.token.setAttribute('class', `cg-token t-${tone}`);
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p = paths[0], pt = p.getPointAtLength(p.getTotalLength() * e);
      G.token.setAttribute('cx', pt.x); G.token.setAttribute('cy', pt.y);
      if (k < 1) P.tokenRaf = requestAnimationFrame(step);
      else { G.token.setAttribute('cx', -20); G.token.setAttribute('cy', -20); if (paths.length > 1) runToken(paths.slice(1), tone); }
    };
    P.tokenRaf = requestAnimationFrame(step);
  }

  function runMorphs(li, animate) {
    li.querySelectorAll('.morph').forEach((m, j) => {
      const seq = JSON.parse(m.dataset.seq);
      if (!animate || reduce) { m.textContent = seq[seq.length - 1]; m.classList.add('final'); return; }
      m.textContent = seq[0];
      seq.slice(1).forEach((txt, k) => {
        P.morphTimers.push(setTimeout(() => {
          m.classList.add('swap');
          P.morphTimers.push(setTimeout(() => {
            m.textContent = txt;
            m.classList.remove('swap');
            if (k === seq.length - 2) m.classList.add('final');
          }, 160));
        }, (j * 260 + (k + 1) * 430) / P.speed));
      });
    });
  }

  function renderSheet(animateIdx) {
    const sheet = $('cSheet');
    P.morphTimers.forEach(clearTimeout); P.morphTimers = [];
    sheet.innerHTML = P.calc.steps.slice(0, P.i + 1).map((s, i) => `<li class="ws t-${s.tone}${i === P.i ? ' cur' : ''}${i === animateIdx ? ' enter' : ''}"><header><i>${i + 1}</i>${esc(s.title)}${s.cost ? `<em>+${s.cost[1]} ns</em>` : ''}</header>${s.html}</li>`).join('');
    [...sheet.children].forEach((li, i) => runMorphs(li, i === animateIdx));
    const cur = sheet.lastElementChild;
    if (cur) sheet.scrollTo({ top: cur.offsetTop - 8, behavior: reduce ? 'auto' : 'smooth' });
  }

  function renderLedger() {
    const box = $('cLedger');
    if (!P.calc) { box.innerHTML = ''; return; }
    const c = P.calc.cfg, rec = P.calc.rec;
    const segs = [];
    P.calc.steps.slice(0, P.i + 1).forEach(s => { if (s.cost) segs.push(s.cost); });
    const shown = segs.reduce((a, s) => a + s[1], 0);
    const hitPath = c.t + c.m, missPath = c.t + (c.ptLevels + 1) * c.m;
    const met = app.state.mmu.metrics();
    const eat = app.state.mmu.stats.accesses ? met.measuredEAT : null;
    const scale = Math.max(rec.cost, missPath, eat || 0, 1);
    const LBL = { t: 'TLB t', walk: 'walk k·m', fault: 'fault S', data: 'data m' };
    const bar = segs.map(([k, v]) => `<span class="lg-seg s-${k}" style="--g:${v}" title="${LBL[k]} = ${v} ns"><b>${LBL[k]}</b><small>${v}</small></span>`).join('');
    const row = (label, v, cls) => `<div class="lg-row ${cls}"><span>${label}</span><div class="lg-track"><i style="--w:${(v / scale) * 100}%"></i></div><b>${Math.round(v * 100) / 100} ns</b></div>`;
    box.innerHTML = `<div class="lg-head"><span>Time ledger · this access</span><b class="lg-total">${shown} <small>/ ${rec.cost} ns</small></b></div>
      <div class="lg-bar">${bar || '<span class="lg-empty">costs appear as the stages run…</span>'}</div>
      <div class="lg-compare">${row('TLB hit path · t + m', hitPath, 'c-hit')}${row(`miss path · t + ${c.ptLevels + 1}m`, missPath, 'c-miss')}${eat !== null ? row('measured EAT · this run', eat, 'c-eat') : ''}</div>`;
  }

  function show(i, animate) {
    if (!P.calc) return;
    i = Math.max(0, Math.min(P.calc.steps.length - 1, i));
    const forward = i === P.i + 1;
    resetGraph();
    for (let j = 0; j <= i; j++) applyStepGraph(P.calc.steps[j], animate && forward && j === i);
    P.i = i;
    renderSheet(animate && forward ? i : -1);
    renderRail();
    renderLedger();
    $('cPrev').disabled = i <= 0;
    $('cNext').disabled = i >= P.calc.steps.length - 1;
  }

  function play() {
    if (!P.calc) return;
    if (P.i >= P.calc.steps.length - 1) { P.i = -1; resetGraph(); }
    P.playing = true; setPlayBtn();
    const tick = () => {
      if (!P.playing) return;
      if (P.i >= P.calc.steps.length - 1) { pause(); return; }
      show(P.i + 1, true);
      P.timer = setTimeout(tick, stepDuration(P.calc.steps[P.i]));
    };
    tick();
  }
  function pause() { P.playing = false; clearTimeout(P.timer); setPlayBtn(); }
  function setPlayBtn() { const b = $('cPlay'); b.textContent = P.playing ? '❚❚' : '▶'; b.setAttribute('aria-pressed', String(P.playing)); }

  function empty() {
    P.calc = null; P.i = -1; pause(); resetGraph();
    $('cSheet').innerHTML = '<li class="ws-empty"><b>Nothing to play yet.</b><br>Translate an address (try <code>300</code>, then <code>300</code> again) and the full derivation plays here: every division, comparison, table lookup and nanosecond.</li>';
    renderRail(); renderLedger();
  }

  /* ------------------------------------------------- quick result */
  function quickResult(rec) {
    const bar = $('resultBar');
    if (!rec) { bar.hidden = true; return; }
    bar.hidden = false;
    const c = app.state.cfg;
    const lab = { HIT: 'TLB HIT', MISS: 'TLB MISS', FAULT: rec.serviced ? 'PAGE FAULT · SERVICED' : 'PAGE FAULT', PROT: 'PROTECTION FAULT' }[rec.outcome];
    const pa = rec.pa === null || rec.pa === undefined;
    $('quickResult').innerHTML = `<span class="qr-pill o-${rec.outcome}">${lab}</span>
      <span class="qr-map"><small>VA</small><b>${rec.addr}</b><i>→</i><small>PA</small><b class="${pa ? 'none' : ''}">${pa ? (rec.outcome === 'PROT' ? 'blocked' : 'none') : rec.pa}</b></span>
      <span class="qr-meta">VPN ${rec.vpn} · offset ${rec.offset}${rec.pfn !== null && rec.pfn !== undefined ? ` · PFN ${rec.pfn}` : ''} · <b>${rec.cost} ns</b></span>`;
    const q = $('quickResult'); q.classList.remove('in'); void q.offsetWidth; q.classList.add('in');
    $('showHow').innerHTML = `<span class="sh-ic" aria-hidden="true">${P.open ? '↺' : '▶'}</span>${P.open ? 'Replay the calculation' : "Show me what's happening"}`;
  }

  function openPlayer(playNow, scroll) {
    const card = $('calc');
    const wasHidden = card.hidden;
    card.hidden = false;
    card.classList.add('in'); // never stay hidden behind the scroll-reveal
    P.open = true;
    if (wasHidden) { card.classList.remove('opening'); void card.offsetWidth; card.classList.add('opening'); }
    if (scroll) card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    if (!P.calc) return;
    if (playNow && !reduce) { pause(); P.i = -1; setTimeout(play, scroll ? 380 : 0); }
    else show(P.calc.steps.length - 1, false);
    quickResult(app.currentRecord());
  }
  function closePlayer() {
    pause();
    $('calc').hidden = true;
    P.open = false;
    quickResult(app.currentRecord());
    $('showHow').focus();
  }

  /* ---------------------------------------------------------- wiring */
  function onRender(e) {
    const rec = app.currentRecord();
    if (!rec) { quickResult(null); if (P.key !== null) { P.key = null; empty(); } return; }
    const key = rec.seq + ':' + rec.addr + ':' + JSON.stringify(app.state.cfg) + ':' + app.state.cursor;
    if (key === P.key) return;
    P.key = key;
    pause();
    P.calc = build(rec);
    P.i = -1;
    quickResult(rec);
    if (P.always && e.detail.animate && !app.state.playing) { openPlayer(true, false); return; }
    if (!P.open) return; // normal mode: just the result, the player stays closed
    const card = $('calc').getBoundingClientRect();
    const visible = card.bottom > 0 && card.top < innerHeight;
    if (e.detail.animate && visible && !reduce && !app.state.playing) play();
    else show(P.calc.steps.length - 1, false);
  }

  buildGraph();
  empty();
  $('showHow').addEventListener('click', () => openPlayer(true, true));
  $('cClose').addEventListener('click', closePlayer);
  document.querySelectorAll('a[href="#calc"]').forEach(l => l.addEventListener('click', ev => { ev.preventDefault(); if (P.calc) openPlayer(true, true); else document.getElementById('bench').scrollIntoView({ behavior: 'smooth' }); }));
  $('alwaysExplain').checked = P.always;
  $('alwaysExplain').addEventListener('change', e => {
    P.always = e.target.checked;
    try { localStorage.setItem('tlbscope-explain', P.always ? '1' : '0'); } catch (err) { /* ignore */ }
    if (P.always && P.calc) openPlayer(true, true);
  });
  $('cPlay').addEventListener('click', () => (P.playing ? pause() : play()));
  $('cRestart').addEventListener('click', () => { pause(); P.i = -1; play(); });
  $('cPrev').addEventListener('click', () => { pause(); show(P.i - 1, false); });
  $('cNext').addEventListener('click', () => { pause(); show(P.i + 1, true); });
  $('cRail').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; pause(); const t = +b.dataset.i; if (t === P.i + 1) show(t, true); else show(t, false); });
  $('cSpeed').addEventListener('click', e => {
    const b = e.target.closest('[data-sp]'); if (!b) return;
    P.speed = +b.dataset.sp;
    $('cSpeed').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  document.addEventListener('tlb:render', onRender);
  onRender({ detail: { animate: false } });
})();
