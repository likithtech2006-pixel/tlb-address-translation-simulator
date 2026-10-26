/*
 * TLB/Scope — user interface
 * ----------------------------------------------------------------------------
 * The UI never mutates translation state directly. Everything the user does
 * becomes an *operation* appended to a timeline:
 *     { type: 'access', pid, addr, write }      a memory reference
 *     { type: 'prot',   pid, vpn, writable }    change page permissions
 *     { type: 'invlpg', pid, vpn }              invalidate one TLB entry
 *     { type: 'flush' }                         flush the whole TLB
 * Because the engine is deterministic, the state at any time t is obtained by
 * replaying ops[0..t). That gives time travel, "what-if" re-runs after a
 * config change, branchable history and shareable links essentially for free.
 */
(() => {
  'use strict';
  const E = window.TLBEngine;
  /*
   * Multi-page support: each page contains only some panels. A lookup for an
   * element this page does not have returns a detached stand-in, so shared
   * logic (state, persistence, replay) runs unchanged on every page, while
   * renderAll() skips panels that are not present.
   */
  const stubs = new Map();
  const stub = id => {
    if (!stubs.has(id)) {
      const el = document.createElement('div');
      Object.assign(el, { value: '', options: [], files: [], select() {}, showModal() {}, close() {} });
      stubs.set(id, el);
    }
    return stubs.get(id);
  };
  const $ = id => document.getElementById(id) || stub(id);
  const has = id => !!document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  /* ================================================================ state */
  const S = {
    cfg: E.normalizeConfig({}),
    ops: [],          // timeline of operations
    events: [],       // result of every op on a full replay (index-aligned with ops)
    cursor: 0,        // number of ops applied to S.mmu
    mmu: null,        // machine state at the cursor
    radix: 'dec',
    rw: 'r',
    pidView: 0,
    ptWin: 0, memWin: 0,
    selectedVpn: null,
    preview: null,    // { pid, addr } while typing in the probe
    stage: null,      // { rec, steps, i } manual step-through
    anim: null,       // auto stage animation token
    playing: false, playTimer: null,
    logFilter: 'ALL',
    followPt: -1, followMem: -1,
  };
  const WIN = 1024; // cells per page-table / frame window

  /* ============================================================ formatting */
  const hexN = n => '0x' + Math.floor(n).toString(16).toUpperCase();
  const fa = (n, bits) => (n === null || n === undefined ? '—' : S.radix === 'hex' ? E.toHex(n, bits) : String(n));
  const fv = n => (n === null || n === undefined || n < 0 ? '—' : S.radix === 'hex' ? hexN(n) : String(n));
  const pct = x => (x * 100).toFixed(x === 0 || x === 1 ? 0 : 1) + '%';
  const ns = x => (Math.round(x * 100) / 100).toLocaleString('en-US') + ' ns';
  const bytes = n => (n >= 2 ** 30 ? n / 2 ** 30 + ' GiB' : n >= 2 ** 20 ? n / 2 ** 20 + ' MiB' : n >= 1024 ? n / 1024 + ' KiB' : n + ' B');
  const pColor = pid => `var(--p${pid % 4})`;

  /* ================================================================ toast */
  let toastTimer;
  function toast(msg, warn = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('warn', warn);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ======================================================== op execution */
  function applyOp(mmu, op, index) {
    if (op.type === 'access') return mmu.access(op);
    const ev = { kind: 'op', op, index, outcome: 'OP' };
    if (op.type === 'prot') { ev.shotDown = mmu.setWritable(op.pid, op.vpn, op.writable); ev.label = `${op.writable ? 'RW' : 'RO'} P${op.pid}:${op.vpn}`; }
    else if (op.type === 'invlpg') { ev.shotDown = mmu.invalidate(op.pid, op.vpn); ev.label = `INVLPG P${op.pid}:${op.vpn}`; }
    else if (op.type === 'flush') { ev.flushed = mmu.flushTLB(); ev.label = 'FLUSH'; }
    return ev;
  }

  /** Full replay of every op (used for the timeline's "future" ghost and the log). */
  function rebuild() {
    const full = new E.MMU(S.cfg);
    S.events = S.ops.map((op, i) => applyOp(full, op, i));
    if (S.cursor >= S.ops.length) { S.cursor = S.ops.length; S.mmu = full; }
    else seek(S.cursor, true);
  }

  function seek(k, silent) {
    k = Math.max(0, Math.min(S.ops.length, k));
    if (!S.mmu || k < S.cursor) { S.mmu = new E.MMU(S.cfg); S.cursor = 0; }
    for (let i = S.cursor; i < k; i++) applyOp(S.mmu, S.ops[i], i);
    S.cursor = k;
    if (!silent) { S.preview = null; endStage(); renderAll(true); persist(); }
  }

  /** Append ops at the cursor (branching if we have rewound) and execute them. */
  function execute(ops, { animate = true } = {}) {
    if (!ops.length) return null;
    stopPlay();
    if (S.cursor < S.ops.length) {
      S.ops.length = S.cursor; S.events.length = S.cursor;
      toast(`Timeline branched at t = ${S.cursor}. Later events were discarded.`);
    }
    let last = null;
    for (const op of ops) {
      const ev = applyOp(S.mmu, op, S.ops.length);
      if (ev.error) { showAddrError(ev.error); break; }
      S.ops.push(op); S.events.push(ev); S.cursor++;
      last = ev;
    }
    S.preview = null;
    endStage();
    renderAll(animate && ops.length === 1);
    persist();
    return last;
  }

  /** The most recent access record at the cursor (what the bit/datapath views show). */
  function currentRecord() {
    for (let i = S.cursor - 1; i >= 0; i--) if (S.events[i] && S.events[i].kind !== 'op') return S.events[i];
    return null;
  }
  const lastEvent = () => (S.cursor ? S.events[S.cursor - 1] : null);

  /* ======================================================== config deck */
  const CFG_IDS = ['vaBits', 'paBits', 'pageSize', 'ptLevels', 'tlbEntries', 'tlbWays', 'tlbPolicy', 'mapping', 'faultMode', 'framePolicy', 'processes', 'contextMode', 't', 'm', 'faultTime'];
  const NUMERIC = new Set(['vaBits', 'paBits', 'pageSize', 'ptLevels', 'tlbEntries', 'tlbWays', 'processes', 't', 'm', 'faultTime']);

  function fillPageSizes(va, pa, want) {
    const sel = $('pageSize');
    const max = Math.min(2 ** (va - 1), 2 ** pa, 1 << 20);
    const opts = [];
    for (let s = 2; s <= max; s *= 2) opts.push(s);
    sel.innerHTML = opts.map(s => `<option value="${s}">${bytes(s)}</option>`).join('');
    const pick = opts.includes(want) ? want : opts.filter(s => s <= want).pop() || opts[0];
    sel.value = String(pick);
  }
  function fillWays(entries, want) {
    const sel = $('tlbWays');
    const opts = [[entries, entries === 1 ? 'Single entry' : 'Fully associative']];
    for (let w = entries / 2; w >= 1; w /= 2) {
      if (!Number.isInteger(w) || entries % w) break;
      if (E.isPow2(entries / w)) opts.push([w, w === 1 ? 'Direct-mapped' : `${w}-way set assoc.`]);
    }
    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = String(opts.some(o => o[0] === want) ? want : entries);
  }
  function syncLevels(vpnBits) {
    [...$('ptLevels').options].forEach(o => { o.disabled = +o.value > vpnBits; });
    if (+$('ptLevels').value > vpnBits) $('ptLevels').value = '1';
  }

  function writeDeck(cfg) {
    $('vaBits').value = cfg.vaBits; $('paBits').value = cfg.paBits;
    fillRange($('vaBits')); fillRange($('paBits'));
    $('vaBitsOut').textContent = cfg.vaBits + ' b'; $('paBitsOut').textContent = cfg.paBits + ' b';
    fillPageSizes(cfg.vaBits, cfg.paBits, cfg.pageSize);
    fillWays(cfg.tlbEntries, cfg.tlbWays);
    syncLevels(cfg.vaBits - Math.log2(cfg.pageSize));
    for (const id of ['ptLevels', 'tlbEntries', 'tlbPolicy', 'mapping', 'faultMode', 'framePolicy', 'processes', 'contextMode', 't', 'm', 'faultTime']) $(id).value = String(cfg[id]);
    $('framePolicy').disabled = cfg.faultMode !== 'demand';
    $('contextMode').disabled = cfg.processes < 2;
  }

  function fillRange(el) { el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); }
  function readDeck() {
    const c = {};
    for (const id of CFG_IDS) c[id] = NUMERIC.has(id) ? Number($(id).value) : $(id).value;
    c.seed = S.cfg.seed;
    return c;
  }

  function onDeckChange(e) {
    const id = e.target.id;
    if (id === 'vaBits' || id === 'paBits') {
      $('vaBitsOut').textContent = $('vaBits').value + ' b'; $('paBitsOut').textContent = $('paBits').value + ' b';
      fillRange($('vaBits')); fillRange($('paBits'));
      fillPageSizes(+$('vaBits').value, +$('paBits').value, +$('pageSize').value);
    }
    if (id === 'tlbEntries') fillWays(+$('tlbEntries').value, +$('tlbWays').value);
    syncLevels(+$('vaBits').value - Math.log2(+$('pageSize').value));
    if (e.type === 'input' && (id === 'vaBits' || id === 'paBits')) return; // apply on release
    applyConfig(readDeck());
  }

  /** Applies a configuration and replays the existing timeline under it ("what-if"). */
  function applyConfig(next, { keepOps = true, quiet = false } = {}) {
    const err = E.validateConfig(next);
    const box = $('cfgError');
    if (err) { box.textContent = err + ' (Not applied — the previous machine is still running.)'; box.hidden = false; return false; }
    box.hidden = true;
    const prev = S.cfg;
    S.cfg = E.normalizeConfig(next);
    stopPlay();
    const g = E.geometry(S.cfg);
    let dropped = false;
    if (keepOps && S.ops.length) {
      const fits = S.ops.every(op => {
        if (op.type === 'flush') return true;
        if (op.pid >= S.cfg.processes) return false;
        return op.type === 'access' ? op.addr <= g.vaMax : op.vpn < g.pages;
      });
      if (!fits) { S.ops = []; S.cursor = 0; dropped = true; }
    } else if (!keepOps) { S.ops = []; S.cursor = 0; }
    S.mmu = null;
    S.pidView = Math.min(S.pidView, S.cfg.processes - 1);
    S.ptWin = 0; S.memWin = 0; S.selectedVpn = null;
    rebuild();
    writeDeck(S.cfg);
    syncProbe();
    syncEatInputs();
    renderAll(false);
    persist();
    if (!quiet) {
      if (dropped) toast('The timeline did not fit the new geometry, so it was cleared.', true);
      else if (S.ops.length && JSON.stringify(prev) !== JSON.stringify(S.cfg)) toast(`Replayed ${S.ops.length} operation${S.ops.length === 1 ? '' : 's'} under the new configuration. Compare the telemetry.`);
    }
    return true;
  }

  /* ============================================================ rendering */
  function renderAll(animate) {
    if (has('specStrip')) renderSpec();
    if (has('derived')) renderDerived();
    if (has('bits') || has('datapath')) renderBitsAndPath(animate);
    if (has('scope')) renderScope();
    if (has('tlbView')) renderTLB(animate);
    if (has('ptMap')) renderPT();
    if (has('memMap')) renderMem();
    if (has('kpis')) renderKPIs();
    if (has('hitChart')) renderChart();
    if (has('eH')) renderEAT();
    if (has('logBody')) renderLog();
    document.dispatchEvent(new CustomEvent('tlb:render', { detail: { animate: !!animate } }));
  }

  function renderSpec() {
    const c = S.cfg, g = E.geometry(c);
    const org = g.fullyAssociative ? 'FA' : g.directMapped ? 'DM' : `${c.tlbWays}-way`;
    const items = [
      ['VA', `${c.vaBits} bit`], ['PA', `${c.paBits} bit`], ['Page', bytes(c.pageSize)],
      ['TLB', `${c.tlbEntries} × ${org} · ${c.tlbPolicy}`], ['Walk', `${c.ptLevels}-level`],
      ['Faults', c.faultMode === 'demand' ? `demand · ${c.framePolicy}` : 'report'],
      ['Procs', c.processes > 1 ? `${c.processes} · ${c.contextMode === 'asid' ? 'ASID' : 'flush'}` : '1'],
      ['t / m / S', `${c.t} / ${c.m} / ${c.faultTime} ns`],
    ];
    $('specStrip').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
  }

  function renderDerived() {
    const g = E.geometry(S.cfg);
    const cells = [
      ['Pages', g.pages.toLocaleString('en-US')], ['Frames', g.frames.toLocaleString('en-US')], ['Offset', g.offsetBits + ' b'],
      ['VPN', g.vpnBits + ' b'], ['PFN', g.pfnBits + ' b'], [g.fullyAssociative ? 'Sets' : 'Tag / idx', g.fullyAssociative ? '1' : `${g.tagBits} / ${g.indexBits} b`],
    ];
    $('derived').innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('addrRange').textContent = `0 – ${fa(g.vaMax, S.cfg.vaBits)}`;
  }

  /* ----------------------------------------------------- bit surgery */
  function renderBitsAndPath(animate) {
    const rec = currentRecord();
    if (S.preview) renderBits({ addr: S.preview.addr, pid: S.preview.pid, rec: null });
    else if (rec) renderBits({ addr: rec.addr, pid: rec.pid, rec }, animate);
    else renderBits(null);
    if (S.stage) renderStage();
    else renderDatapath(rec, animate);
  }

  function renderBits(t, animate) {
    const c = S.cfg, g = E.geometry(c), box = $('bits'), badge = $('outcomeBadge');
    if (!t) {
      box.innerHTML = '<p class="muted small">Type an address in the probe to see it split into fields.</p>';
      $('equation').innerHTML = '<span class="k">VA = VPN × page size + offset</span>';
      badge.dataset.o = 'idle'; badge.textContent = 'IDLE';
      return;
    }
    const { rec } = t;
    const d = S.mmu.decompose(t.addr);
    const N = Math.max(c.vaBits, c.paBits);
    const vaStart = N - c.vaBits + 2, paStart = N - c.paBits + 2; // grid columns (col 1 = labels)
    const offStart = N - g.offsetBits + 2;
    const vaBin = E.toBin(t.addr, c.vaBits);
    const pa = rec ? rec.pa : null;
    const pfn = rec ? rec.pfn : null;
    const html = [];
    const put = (row, col, span, cls, content, title) => html.push(`<div class="${cls}" style="grid-row:${row};grid-column:${col} / span ${span}"${title ? ` title="${esc(title)}"` : ''}>${content}</div>`);
    let row = 1;
    // bit numbers
    put(row, 1, 1, 'lbl', 'bit');
    for (let b = N - 1; b >= 0; b--) if (b % 4 === 0 || b === N - 1) put(row, N - b + 1, 1, 'bitno', b);
    row++;
    // page-table level indices
    if (c.ptLevels > 1) {
      put(row, 1, 1, 'lbl', 'walk');
      let col = vaStart;
      g.levelBits.forEach((bits, i) => { put(row, col, bits, 'brace c-lvl', `L${i + 1}=${d.levels[i]}`, `Level ${i + 1} index (${bits} bits)`); col += bits; });
      row++;
    }
    // VA fields
    put(row, 1, 1, 'lbl', '');
    if (g.fullyAssociative) put(row, vaStart, g.vpnBits, 'brace c-vpn', `VPN ${fv(d.vpn)}`, `Virtual page number: ${g.vpnBits} bits`);
    else {
      if (g.tagBits > 0) put(row, vaStart, g.tagBits, 'brace c-vpn', `TAG ${fv(d.tag)}`, `TLB tag: ${g.tagBits} bits`);
      put(row, vaStart + g.tagBits, g.indexBits, 'brace c-index', `SET ${d.set}`, `TLB set index: ${g.indexBits} bits`);
    }
    put(row, offStart, g.offsetBits, 'brace c-off', `OFFSET ${fv(d.offset)}`, `Page offset: ${g.offsetBits} bits`);
    row++;
    // VA bits
    put(row, 1, 1, 'lbl', `VA${c.processes > 1 ? ' P' + t.pid : ''}`);
    for (let i = 0; i < c.vaBits; i++) {
      const bitPos = c.vaBits - 1 - i;
      const field = bitPos < g.offsetBits ? 'f-off' : (!g.fullyAssociative && bitPos < g.offsetBits + g.indexBits) ? 'f-index' : 'f-vpn';
      const v = vaBin[i];
      html.push(`<div class="bit ${field} ${v === '1' ? 'one' : 'zero'}" style="grid-row:${row};grid-column:${vaStart + i};--i:${i}">${v}</div>`);
    }
    row++;
    // wires
    put(row, 1, 1, 'lbl', '');
    put(row, paStart, Math.max(1, g.pfnBits), 'wire swap', rec ? (rec.hit ? '↓ PFN from TLB' : rec.outcome === 'FAULT' && !rec.serviced ? '✗ no frame' : rec.serviced ? '↓ PFN from OS' : '↓ PFN from page table') : '↓ PFN = ?');
    for (let i = 0; i < g.offsetBits; i++) put(row, offStart + i, 1, 'wire carry', '');
    row++;
    // PA bits
    put(row, 1, 1, 'lbl', 'PA');
    const paBin = pa !== null ? E.toBin(pa, c.paBits) : null;
    const offBin = E.toBin(d.offset, g.offsetBits);
    for (let i = 0; i < c.paBits; i++) {
      const bitPos = c.paBits - 1 - i;
      if (bitPos < g.offsetBits) { const v = offBin[g.offsetBits - 1 - bitPos]; html.push(`<div class="bit f-off ${v === '1' ? 'one' : 'zero'}" style="grid-row:${row};grid-column:${paStart + i};--i:${i}">${v}</div>`); }
      else if (paBin) { const v = paBin[i]; html.push(`<div class="bit f-pfn ${v === '1' ? 'one' : 'zero'}" style="grid-row:${row};grid-column:${paStart + i};--i:${i}">${v}</div>`); }
      else html.push(`<div class="bit f-none" style="grid-row:${row};grid-column:${paStart + i};--i:${i}">${rec ? '×' : '?'}</div>`);
    }
    row++;
    put(row, 1, 1, 'lbl', '');
    put(row, paStart, Math.max(1, g.pfnBits), `brace below ${pa !== null ? 'c-pfn' : 'c-none'}`, pa !== null ? `PFN ${fv(pfn)}` : rec ? 'NO FRAME' : 'PFN ?', `Physical frame number: ${g.pfnBits} bits`);
    put(row, offStart, g.offsetBits, 'brace below c-off', `OFFSET ${fv(d.offset)}`);
    box.style.setProperty('--cw', N <= 12 ? '34px' : N <= 16 ? '30px' : N <= 24 ? '26px' : '22px');
    box.style.gridTemplateColumns = `56px repeat(${N}, var(--cw))`;
    box.innerHTML = html.join('');
    box.classList.toggle('animate', !!animate && !reduceMotion);
    const sc = box.parentElement; // on narrow screens keep the low-order bits (offset, PFN) in view
    if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
    // equation
    const eq = $('equation');
    const base = `<span class="k">VA</span> ${fa(t.addr, c.vaBits)} = ${fv(d.vpn)} × ${c.pageSize} + ${fv(d.offset)}`;
    if (!rec) eq.innerHTML = `${base} <span class="k">→ translate to resolve the frame</span>`;
    else if (pa === null) eq.innerHTML = `${base} <span class="k">→</span> ${rec.outcome === 'PROT' ? 'write to a read-only page: access blocked' : 'page not present: no physical address'}`;
    else eq.innerHTML = `${base} <span class="k">→ PA</span> = ${fv(pfn)} × ${c.pageSize} + ${fv(d.offset)} = <b>${fa(pa, c.paBits)}</b>`;
    if (animate && rec && !reduceMotion) { badge.classList.remove('burst'); void badge.offsetWidth; badge.classList.add('burst'); }
    badge.dataset.o = rec ? rec.outcome : 'PREVIEW';
    badge.textContent = rec ? (rec.outcome === 'FAULT' && rec.serviced ? 'FAULT · SERVICED' : rec.outcome === 'PROT' ? 'PROTECTION' : rec.outcome) : 'PREVIEW';
  }

  /* ----------------------------------------------------- datapath */
  const NODES = [
    ['cpu', 'VA', 'CPU request'], ['tlb', 'TLB', 'Associative lookup'], ['walk', 'WALK', 'Page-table walk'],
    ['os', 'OS', 'Fault handler'], ['prot', 'CHK', 'Permission check'], ['ram', 'RAM', 'Data access'],
  ];

  function nodeStates(rec) {
    const st = { cpu: 'pass', tlb: 'skip', walk: 'skip', os: 'skip', prot: 'skip', ram: 'skip' };
    if (!rec) return null;
    st.tlb = rec.hit ? 'hit' : 'miss';
    if (!rec.hit) st.walk = rec.pageFault ? 'fault' : 'miss';
    if (rec.pageFault) st.os = rec.serviced ? 'miss' : 'fault';
    if (rec.outcome !== 'FAULT' || rec.serviced) st.prot = rec.outcome === 'PROT' ? 'prot' : 'pass';
    if (rec.pa !== null && rec.pa !== undefined) st.ram = 'hit';
    return st;
  }

  function nodeValues(rec) {
    const c = S.cfg, v = {};
    if (!rec) return v;
    v.cpu = `${rec.write ? 'W' : 'R'} ${fa(rec.addr, c.vaBits)}${c.processes > 1 ? ' · P' + rec.pid : ''}${rec.switchedFrom !== undefined ? ` <small>(switch from P${rec.switchedFrom}${rec.flushed !== undefined ? `, flushed ${rec.flushed}` : ''})</small>` : ''}`;
    v.tlb = rec.hit ? `set ${rec.tlbSlot.set} · way ${rec.tlbSlot.way} → PFN ${fv(rec.pfn)}` : `no (P${rec.pid}, VPN ${fv(rec.vpn)}) in set ${rec.set}`;
    const lv = rec.levels.map((x, i) => `<span>L${i + 1}:${x}</span>`).join('');
    v.walk = rec.hit ? 'skipped' : `${c.ptLevels} read${c.ptLevels > 1 ? 's' : ''} → ${rec.pageFault ? 'PTE not present' : 'PFN ' + fv(rec.pfn)}<div class="lvls">${lv}</div>`;
    if (rec.pageFault) {
      const f = rec.fault;
      v.os = !rec.serviced ? 'trap raised · not serviced (report mode)'
        : `page-in → F${fv(f.pfn)}${f.evicted ? ` · evicted P${f.evicted.pid}:${fv(f.evicted.vpn)}${f.evicted.dirty ? ' (dirty → write-back)' : ''}` : ' (free frame)'}`;
    } else v.os = 'not needed';
    v.prot = rec.outcome === 'PROT' ? 'write to read-only ✗' : rec.outcome === 'FAULT' && !rec.serviced ? '—' : rec.write ? 'write allowed ✓' : 'read ✓';
    v.ram = rec.pa === null || rec.pa === undefined ? 'no access' : `PA ${fa(rec.pa, c.paBits)} · ${rec.cost} ns`;
    return v;
  }

  function renderDatapath(rec, animate, stepIdx) {
    const box = $('datapath');
    const states = nodeStates(rec);
    const vals = nodeValues(rec);
    const order = rec ? stepsFor(rec).map(s => s.node) : [];
    box.style.setProperty('--n', NODES.length);
    box.innerHTML = NODES.map(([id, code, title]) => {
      let s = states ? states[id] : 'idle';
      if (stepIdx !== undefined) {
        const pos = order.indexOf(id);
        if (pos === -1) s = 'skip';
        else if (pos > stepIdx) s = 'idle';
        else if (pos === stepIdx) s = 'active';
      }
      return `<div class="node" data-node="${id}" data-s="${s}"><div class="code">${code}</div><div class="title">${title}</div><div class="val">${(stepIdx !== undefined && order.indexOf(id) > stepIdx) ? '' : (vals[id] || '')}</div></div>`;
    }).join('');
    if (stepIdx === undefined) $('narration').innerHTML = rec ? summaryFor(rec) : '<p>Translate an address to light up its route. <b>Step through</b> pauses at each hardware stage.</p>';
    if (animate && rec && !reduceMotion && stepIdx === undefined) autoAnimate(rec);
  }

  /** Sweeps a glowing packet through the stages so every translation visibly "travels". */
  const OUT_COLOR = { HIT: 'var(--hit)', MISS: 'var(--miss)', FAULT: 'var(--fault)', PROT: 'var(--prot)' };
  function flashCard(sel, outcome) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.remove('flash-HIT', 'flash-MISS', 'flash-FAULT', 'flash-PROT');
    void el.offsetWidth;
    el.classList.add('flash-' + outcome);
  }
  function autoAnimate(rec) {
    const token = {};
    S.anim = token;
    const box = $('datapath');
    const order = stepsFor(rec).map(s => s.node);
    const nodes = [...box.querySelectorAll('.node')];
    nodes.forEach(n => { n.dataset.final = n.dataset.s; if (order.includes(n.dataset.node)) n.dataset.s = 'idle'; });
    const STEP = 240;
    const br = box.getBoundingClientRect();
    const pts = order.map(id => { const r = nodes.find(x => x.dataset.node === id).getBoundingClientRect(); return [r.left - br.left + r.width / 2, r.top - br.top + r.height / 2]; });
    const total = STEP * Math.max(1, order.length - 1);
    if (pts.length && document.createElement('div').animate) {
      const pk = document.createElement('div');
      pk.className = 'packet';
      pk.style.setProperty('--pc', OUT_COLOR[rec.outcome]);
      box.appendChild(pk);
      const n = pts.length;
      const frames = pts.map((p, i) => ({ transform: `translate(${p[0]}px, ${p[1]}px)`, opacity: 1, offset: n > 1 ? (i / (n - 1)) * 0.85 : 0 }));
      frames[0].opacity = 0.2;
      frames.push({ transform: `translate(${pts[n - 1][0]}px, ${pts[n - 1][1]}px) scale(2.6)`, opacity: 0, offset: 1 });
      pk.animate(frames, { duration: total + 320, easing: 'cubic-bezier(.45,.05,.35,1)' }).finished.then(() => pk.remove(), () => pk.remove());
    }
    order.forEach((id, i) => setTimeout(() => {
      if (S.anim !== token) return;
      const nd = nodes.find(x => x.dataset.node === id);
      if (!nd) return;
      nd.dataset.s = nd.dataset.final;
      nd.classList.remove('ping'); void nd.offsetWidth; nd.classList.add('ping');
    }, (order.length > 1 ? (total + 320) * (i / (order.length - 1)) * 0.85 : 0)));
    setTimeout(() => { if (S.anim === token) { flashCard('.path-card', rec.outcome); flashCard('.bits-card', rec.outcome); } }, total);
  }

  function stepsFor(rec) {
    const c = S.cfg, g = E.geometry(c), steps = [];
    steps.push({ node: 'cpu', text: `The CPU issues a <b>${rec.write ? 'write' : 'read'}</b> to virtual address <code>${fa(rec.addr, c.vaBits)}</code>${c.processes > 1 ? ` in process P${rec.pid}` : ''}. Splitting it with a ${c.pageSize}-byte page: <code>VPN = ⌊${rec.addr} / ${c.pageSize}⌋ = ${rec.vpn}</code>, <code>offset = ${rec.addr} mod ${c.pageSize} = ${rec.offset}</code>.${rec.switchedFrom !== undefined ? ` This is a <b>context switch</b> from P${rec.switchedFrom}${rec.flushed !== undefined ? `; the TLB was flushed (${rec.flushed} entries lost)` : '; ASID tags let the old entries stay'}.` : ''}` });
    steps.push({ node: 'tlb', text: rec.hit
      ? `The TLB compares the tag in ${g.fullyAssociative ? 'all entries in parallel' : `set ${rec.set}`} and finds <b>(P${rec.pid}, VPN ${rec.vpn})</b> in way ${rec.tlbSlot.way}. <b>TLB hit:</b> frame ${rec.pfn} comes back in one lookup (${c.t} ns) and the page table is not touched.`
      : `No entry in ${g.fullyAssociative ? 'the TLB' : `set ${rec.set}`} matches (P${rec.pid}, VPN ${rec.vpn}). <b>TLB miss:</b> the hardware must walk the page table.` });
    if (!rec.hit) steps.push({ node: 'walk', text: `The walker reads ${c.ptLevels} page-table entr${c.ptLevels > 1 ? 'ies' : 'y'} (${c.ptLevels} × ${c.m} ns)${c.ptLevels > 1 ? ` using indices ${rec.levels.map((x, i) => `L${i + 1}=${x}`).join(', ')}` : ''}. ${rec.pageFault ? 'The final PTE has its <b>present bit = 0</b>.' : `The PTE is present: VPN ${rec.vpn} → <b>frame ${rec.pfn}</b>. The translation is inserted into the TLB${rec.tlbEvicted ? `, evicting P${rec.tlbEvicted.asid}:${rec.tlbEvicted.vpn} under ${c.tlbPolicy}` : ''}.`}` });
    if (rec.pageFault) steps.push({ node: 'os', text: rec.serviced
      ? `<b>Page fault.</b> The OS ${rec.fault.usedFreeFrame ? `finds free frame ${rec.fault.pfn}` : `chooses victim frame ${rec.fault.pfn} by ${c.framePolicy}, evicting P${rec.fault.evicted.pid}:${rec.fault.evicted.vpn}${rec.fault.evicted.dirty ? ' (dirty, so it is written back to disk first)' : ' (clean, so it is simply dropped)'}${rec.fault.evicted.shotDown ? ' and shooting down its stale TLB entry' : ''}`}, loads the page (${c.faultTime} ns), sets the PTE present and fills the TLB${rec.tlbEvicted ? ` (evicting P${rec.tlbEvicted.asid}:${rec.tlbEvicted.vpn})` : ''}.`
      : `<b>Page fault.</b> In report-only mode the trap is recorded but not serviced, so <b>no frame and no physical address</b> exist for this access. Switch “On page fault” to demand paging to service it.` });
    if (rec.outcome !== 'FAULT' || rec.serviced) steps.push({ node: 'prot', text: rec.outcome === 'PROT'
      ? `The cached permission bits say this page is <b>read-only</b>. A write is not allowed, so the MMU raises a <b>protection fault</b> and memory is not accessed.`
      : `Permission check passes (${rec.write ? 'page is writable; the dirty bit is set' : 'reads are always allowed'}).` });
    if (rec.pa !== null && rec.pa !== undefined) steps.push({ node: 'ram', text: `The offset is carried unchanged: <code>PA = ${rec.pfn} × ${c.pageSize} + ${rec.offset} = ${rec.pa}</code> (${E.toHex(rec.pa, c.paBits)}). Total cost of this access: <b>${rec.cost} ns</b>.` });
    return steps;
  }

  function summaryFor(rec) {
    const c = S.cfg;
    const label = { HIT: 'TLB hit', MISS: 'TLB miss → page walk', FAULT: rec.serviced ? 'Page fault → serviced' : 'Page fault', PROT: 'Protection fault' }[rec.outcome];
    const steps = stepsFor(rec);
    const key = rec.outcome === 'HIT' ? steps[1] : rec.outcome === 'MISS' ? steps[2] : rec.outcome === 'PROT' ? steps[steps.length - 1] : steps.find(s => s.node === 'os');
    const tail = rec.pa !== null && rec.pa !== undefined ? ` <code>PA = ${rec.pfn} × ${c.pageSize} + ${rec.offset} = ${rec.pa}</code> · ${rec.cost} ns.` : ` Cost so far: ${rec.cost} ns.`;
    return `<span class="step-tag">t = ${S.cursor} · ${label}</span>${key.text}${rec.outcome === 'MISS' || rec.outcome === 'HIT' ? tail : ''}`;
  }

  /* ----------------------------------------------- manual step-through */
  function startStage(rec) {
    S.anim = null;
    S.stage = { rec, steps: stepsFor(rec), i: 0 };
    $('stepper').hidden = false;
    renderStage();
    $('stageNext').focus();
  }
  function renderStage() {
    const st = S.stage;
    renderDatapath(st.rec, false, st.i);
    $('stageCount').textContent = `${st.i + 1} / ${st.steps.length}`;
    $('stagePrev').disabled = st.i === 0;
    $('stageNext').disabled = st.i === st.steps.length - 1;
    $('narration').innerHTML = `<span class="step-tag">Stage ${st.i + 1} of ${st.steps.length} · ${NODES.find(n => n[0] === st.steps[st.i].node)[2]}</span>${st.steps[st.i].text}`;
  }
  function endStage() {
    if (!S.stage) return;
    S.stage = null;
    $('stepper').hidden = true;
  }

  /* ----------------------------------------------------- logic analyzer */
  const LANES = [['BUS', 'VPN'], ['HIT', 'HIT'], ['MISS', 'MISS'], ['FAULT', 'FAULT'], ['PROT', 'PROT'], ['CTX', 'CTX']];
  function renderScope() {
    const box = $('scope');
    const total = S.events.length;
    $('scrub').max = total; $('scrub').value = S.cursor;
    $('tCount').textContent = `t = ${S.cursor} / ${total}`;
    $('branchNote').hidden = S.cursor >= total;
    $('tPlay').textContent = S.playing ? '❚❚' : '▶';
    $('tPlay').setAttribute('aria-pressed', String(S.playing));
    if (!total) { box.innerHTML = '<div class="scope-empty">No accesses yet. Translate an address or run a workload, then scrub back and forth through time.</div>'; return; }
    const W = Math.max(320, box.clientWidth || 800);
    const LW = 58, laneH = 22, busH = 24, top = 8;
    const minCW = W < 560 ? 14 : 16;
    const CW = Math.max(minCW, Math.min(44, Math.floor((W - LW - 6) / Math.max(total, 16))));
    const cols = Math.max(4, Math.floor((W - LW - 6) / CW));
    let start = 0;
    if (total > cols) start = Math.max(0, Math.min(total - cols, S.cursor - Math.floor(cols * 0.75)));
    const end = Math.min(total, start + cols);
    const H = top + busH + 6 + laneH * (LANES.length - 1) + 22;
    const x = i => LW + (i - start) * CW;
    const parts = [];
    const laneY = li => (li === 0 ? top : top + busH + 6 + (li - 1) * laneH);
    LANES.forEach(([name], li) => {
      const y = laneY(li), h = li === 0 ? busH : laneH;
      parts.push(`<text class="lane-name" x="6" y="${y + h / 2 + 4}">${name === 'BUS' ? 'VPN' : name}</text>`);
      parts.push(`<line class="gridline" x1="${LW}" x2="${W}" y1="${y + h}" y2="${y + h}"/>`);
    });
    // VPN bus: merged hexagon segments
    let i = start;
    while (i < end) {
      const ev = S.events[i];
      const key = ev.kind === 'op' ? 'op' : ev.pid + ':' + ev.vpn;
      let j = i + 1;
      while (j < end && S.events[j].kind !== 'op' && key !== 'op' && (S.events[j].pid + ':' + S.events[j].vpn) === key) j++;
      const x0 = x(i) + 1, x1 = x(j) - 1, y = laneY(0), h = busH, m = y + h / 2, k = Math.min(4, (x1 - x0) / 3);
      if (ev.kind === 'op') parts.push(`<text class="marker" x="${x0 + CW / 2 - 4}" y="${m + 4}"><title>${esc(ev.label)}</title>◆</text>`);
      else {
        parts.push(`<polygon class="bus" points="${x0},${m} ${x0 + k},${y + 3} ${x1 - k},${y + 3} ${x1},${m} ${x1 - k},${y + h - 3} ${x0 + k},${y + h - 3}"/>`);
        const label = (S.cfg.processes > 1 ? `${ev.pid}:` : '') + fv(ev.vpn);
        if (x1 - x0 >= label.length * 6.4 + 6) parts.push(`<text class="bus-t" x="${(x0 + x1) / 2}" y="${m + 3.5}" text-anchor="middle">${label}</text>`);
      }
      i = j;
    }
    // digital lanes
    LANES.slice(1).forEach(([name], idx) => {
      const li = idx + 1, y = laneY(li), hi = y + 4, lo = y + laneH - 4;
      let d = '', fills = '';
      for (let k = start; k < end; k++) {
        const ev = S.events[k];
        const on = name === 'CTX' ? (ev.switchedFrom !== undefined || (ev.kind === 'op' && ev.op.type === 'flush')) : ev.outcome === name;
        const yy = on ? hi : lo;
        d += k === start ? `M${x(k)},${yy}` : `V${yy}`;
        d += `H${x(k + 1)}`;
        if (on) fills += `<rect class="fill ${name}" x="${x(k)}" y="${hi}" width="${CW}" height="${lo - hi}"/>`;
      }
      parts.push(fills, `<path class="sig ${name}" d="${d}"/>`);
    });
    // ticks
    for (let k = start; k < end; k++) if ((k + 1) % 8 === 0 || k === start) parts.push(`<text class="tick" x="${x(k) + CW / 2}" y="${H - 6}" text-anchor="middle">${k + 1}</text>`);
    // future veil + click columns
    if (S.cursor < end) parts.push(`<rect x="${x(Math.max(S.cursor, start))}" y="0" width="${W - x(Math.max(S.cursor, start))}" height="${H - 16}" fill="var(--panel-2)" opacity=".62" pointer-events="none"/>`);
    for (let k = start; k < end; k++) parts.push(`<g class="col" data-k="${k}"><rect class="hover-col" x="${x(k)}" y="0" width="${CW}" height="${H}"/><title>t=${k + 1}: ${esc(eventTitle(S.events[k]))}</title></g>`);
    // cursor
    if (S.cursor >= start && S.cursor <= end) {
      const cx = x(S.cursor);
      parts.push(`<line class="cursor" x1="${cx}" x2="${cx}" y1="0" y2="${H - 16}"/>`);
      const tag = `t=${S.cursor}`, tw = tag.length * 6.4 + 8, tx = Math.min(W - tw - 2, Math.max(LW, cx - tw / 2));
      parts.push(`<rect class="cursor-tag" x="${tx}" y="${H - 17}" width="${tw}" height="15" rx="2"/><text class="cursor-t" x="${tx + tw / 2}" y="${H - 6}" text-anchor="middle">${tag}</text>`);
    }
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet">${parts.join('')}</svg>`;
  }
  function eventTitle(ev) {
    if (ev.kind === 'op') return ev.label;
    return `${ev.write ? 'W' : 'R'} ${ev.addr} (P${ev.pid}, VPN ${ev.vpn}) → ${ev.outcome}${ev.pa !== null && ev.pa !== undefined ? ' PA ' + ev.pa : ''}`;
  }

  /* ---------------------------------------------------------------- TLB */
  function renderTLB(animate) {
    const first = new Map();
    if (animate && !reduceMotion) $('tlbView').querySelectorAll('[data-key]').forEach(el => first.set(el.dataset.key, el.getBoundingClientRect()));
    renderTLBInner();
    if (!first.size) return;
    $('tlbView').querySelectorAll('[data-key]').forEach(el => {
      const f = first.get(el.dataset.key);
      if (!f || !el.animate) return;
      const l = el.getBoundingClientRect(), dx = f.left - l.left, dy = f.top - l.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    });
  }
  function renderTLBInner() {
    const m = S.mmu, c = S.cfg, g = E.geometry(c);
    const rec = lastEvent() && lastEvent().kind !== 'op' ? lastEvent() : null;
    const used = m.tlbEntries().length;
    $('tlbChip').textContent = `${used} / ${c.tlbEntries} valid · ${g.sets} set${g.sets > 1 ? 's' : ''} × ${g.ways} way${g.ways > 1 ? 's' : ''}`;
    const clock = Math.max(1, m.clock);
    let maxUses = 1;
    m.tlbEntries().forEach(e => { maxUses = Math.max(maxUses, e.uses); });
    const rows = m.tlb.map((row, set) => {
      const ways = row.map((e, way) => {
        const hand = c.tlbPolicy === 'CLOCK' && m.tlbHands[set] === way && row.every(Boolean) ? '<span class="hand" title="CLOCK hand">▼ hand</span>' : '';
        if (!e) return `<div class="way empty">way ${way}<br>— invalid —</div>`;
        let cls = '';
        if (rec && rec.tlbSlot && rec.tlbSlot.set === set && rec.tlbSlot.way === way) cls = rec.outcome === 'PROT' ? 'is-prot' : rec.hit ? 'is-hit' : 'is-new';
        let meta = '', bar = 0;
        if (c.tlbPolicy === 'FIFO') { meta = `in @t${e.insertedAt}`; bar = (clock - e.insertedAt) / clock; }
        else if (c.tlbPolicy === 'LRU') { meta = `used @t${e.lastUse}`; bar = (clock - e.lastUse) / clock; }
        else if (c.tlbPolicy === 'LFU') { meta = `${e.uses} use${e.uses > 1 ? 's' : ''}`; bar = 1 - e.uses / maxUses; }
        else if (c.tlbPolicy === 'CLOCK') { meta = `R = ${e.ref}`; bar = e.ref ? 0 : 1; }
        else { meta = `${e.uses} use${e.uses > 1 ? 's' : ''}`; bar = 0; }
        const victimness = Math.round(Math.max(0, Math.min(1, bar)) * 100);
        return `<div class="way ${cls}${cls ? ' flash' : ''}" data-key="${e.asid}:${e.vpn}" style="--agepos:${victimness}%" title="Entry: ASID ${e.asid}, VPN ${e.vpn} → PFN ${e.pfn}. Inserted t${e.insertedAt}, last used t${e.lastUse}, ${e.uses} uses.">${hand}
          <div class="w-top"><span>WAY ${way}</span><span>${cls === 'is-hit' ? 'HIT' : cls === 'is-new' ? 'FILLED' : cls === 'is-prot' ? 'PROT' : ''}</span></div>
          <div class="map">${fv(e.vpn)}<span>→</span>${fv(e.pfn)}</div>
          <div class="flags"><span class="flag on">V</span>${c.processes > 1 ? `<span class="flag asid" style="--pc:${pColor(e.asid)}">P${e.asid}</span>` : ''}<span class="flag ${e.writable ? '' : 'ro'}">${e.writable ? 'RW' : 'RO'}</span>${e.dirty ? '<span class="flag dirty">D</span>' : ''}</div>
          <div class="meta"><span>${meta}</span><span title="How close this entry is to eviction under ${c.tlbPolicy}">${c.tlbPolicy === 'RANDOM' ? 'seeded' : 'victim ' + victimness + '%'}</span></div>
          <div class="age"><i style="width:${victimness}%"></i></div></div>`;
      });
      const ev = rec && rec.tlbEvicted && rec.tlbEvicted.set === set ? rec.tlbEvicted : null;
      if (ev) ways.push(`<div class="way ghost" title="Evicted by the last access"><div class="w-top"><span>EVICTED</span><span>${c.tlbPolicy}</span></div><div class="map">${fv(ev.vpn)}<span>→</span>${fv(ev.pfn)}</div><div class="meta"><span>${c.processes > 1 ? 'P' + ev.asid + ' · ' : ''}in @t${ev.insertedAt}</span><span>last @t${ev.lastUse}</span></div></div>`);
      return `<div class="set-row"><div class="set-label">${g.fullyAssociative ? 'FULLY<br>ASSOC.' : `SET <b>${set}</b><span>idx ${E.toBin(set, g.indexBits)}</span>`}</div><div class="ways">${ways.join('')}</div></div>`;
    });
    $('tlbView').innerHTML = rows.join('');
  }

  /* --------------------------------------------------------- page table */
  function renderPT() {
    const m = S.mmu, c = S.cfg, g = E.geometry(c);
    const tabs = $('ptTabs');
    tabs.innerHTML = c.processes > 1 ? Array.from({ length: c.processes }, (_, p) => `<button type="button" role="tab" aria-selected="${p === S.pidView}" data-pid="${p}" style="--pc:${pColor(p)}">P${p}</button>`).join('') : '';
    const rec = currentRecord();
    const pages = g.pages;
    if (rec && rec.pid === S.pidView && !S.preview && S.followPt !== S.cursor) { S.ptWin = Math.floor(rec.vpn / WIN); S.followPt = S.cursor; }
    const wins = Math.ceil(pages / WIN);
    S.ptWin = Math.min(S.ptWin, wins - 1);
    pager('ptPager', wins, S.ptWin, pages, 'pages', v => { S.ptWin = v; renderPT(); });
    const inTlb = new Set(m.tlbEntries().filter(e => e.asid === S.pidView).map(e => e.vpn));
    const t = m.pt[S.pidView];
    const from = S.ptWin * WIN, to = Math.min(pages, from + WIN);
    const out = [];
    for (let v = from; v < to; v++) {
      const f = t.flags[v];
      let cls = 'cell';
      if (f & 1) cls += inTlb.has(v) ? ' present intlb' : ' present';
      if (f & 4) cls += ' dirty';
      if (!(f & 2)) cls += ' ro';
      if (rec && rec.pid === S.pidView && rec.vpn === v) cls += ' current o-' + rec.outcome;
      if (S.selectedVpn === v) cls += ' selected';
      out.push(`<button type="button" class="${cls}" data-v="${v}" title="VPN ${v}${f & 1 ? ' → PFN ' + t.pfn[v] : ' (not present)'}${f & 2 ? '' : ' · read-only'}${f & 4 ? ' · dirty' : ''}">${fv(v)}</button>`);
    }
    $('ptMap').innerHTML = out.join('');
    renderInspector();
  }

  function pager(id, wins, cur, total, noun, onPick) {
    const el = $(id);
    if (wins <= 1) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span>Showing</span><select aria-label="Window">${Array.from({ length: wins }, (_, w) => `<option value="${w}"${w === cur ? ' selected' : ''}>${(w * WIN).toLocaleString('en-US')} – ${Math.min(total, (w + 1) * WIN - 1).toLocaleString('en-US')}</option>`).join('')}</select><span>of ${total.toLocaleString('en-US')} ${noun}</span>`;
    el.querySelector('select').addEventListener('change', e => onPick(+e.target.value));
  }

  function renderInspector() {
    const box = $('ptInspector');
    const v = S.selectedVpn;
    const c = S.cfg, g = E.geometry(c);
    if (v === null || v >= g.pages) { box.innerHTML = '<p class="muted">Select a page to inspect its page-table entry.</p>'; return; }
    const p = S.mmu.pte(S.pidView, v);
    const tl = S.mmu.tlbFind(S.pidView, v);
    const word = `${p.present ? E.toBin(p.pfn, g.pfnBits) : 'x'.repeat(g.pfnBits)} | R${+p.referenced} D${+p.dirty} W${+p.writable} P${+p.present}`;
    box.innerHTML = `
      <div class="pte">
        <div><span>Process</span><b>P${S.pidView}</b></div><div><span>VPN</span><b>${fv(v)}</b></div><div><span>PFN</span><b>${p.present ? fv(p.pfn) : '—'}</b></div>
        <div><span>Present</span><b>${+p.present}</b></div><div><span>Writable</span><b>${+p.writable}</b></div><div><span>Dirty</span><b>${+p.dirty}</b></div>
        <div><span>Referenced</span><b>${+p.referenced}</b></div><div><span>In TLB</span><b>${tl.entry ? `set ${tl.set}·w${tl.way}` : 'no'}</b></div>
        <div><span>VA range</span><b>${fa(v * c.pageSize, c.vaBits)}–${fa(v * c.pageSize + c.pageSize - 1, c.vaBits)}</b></div>
      </div>
      <div class="pte-word">PTE word: <b>${word}</b></div>
      <div class="insp-actions">
        <button type="button" class="btn" data-act="probe">Probe page start</button>
        <button type="button" class="btn" data-act="prot">${p.writable ? 'Make read-only' : 'Make writable'}</button>
        <button type="button" class="btn" data-act="invlpg" ${tl.entry ? '' : 'disabled'}>INVLPG</button>
      </div>`;
  }

  /* ------------------------------------------------------------- frames */
  function renderMem() {
    const m = S.mmu, c = S.cfg, g = E.geometry(c);
    const rec = currentRecord();
    const used = m.frames.filter(f => f.pid >= 0).length;
    $('memChip').textContent = `${used} / ${g.frames} used · ${bytes(c.pageSize)} each`;
    if (rec && rec.pfn !== null && rec.pfn !== undefined && !S.preview && S.followMem !== S.cursor) { S.memWin = Math.floor(rec.pfn / WIN); S.followMem = S.cursor; }
    const wins = Math.ceil(g.frames / WIN);
    S.memWin = Math.min(S.memWin, wins - 1);
    pager('memPager', wins, S.memWin, g.frames, 'frames', v => { S.memWin = v; renderMem(); });
    const from = S.memWin * WIN, to = Math.min(g.frames, from + WIN);
    const victim = rec && rec.fault && rec.fault.evicted ? rec.fault.pfn : -1;
    const out = [];
    for (let i = from; i < to; i++) {
      const f = m.frames[i];
      const isCur = rec && rec.pfn === i && rec.pa !== undefined;
      const hand = c.faultMode === 'demand' && c.framePolicy === 'CLOCK' && m.frameHand === i ? '<span class="hand" title="CLOCK hand">◆</span>' : '';
      if (f.pid < 0) { out.push(`<div class="frame free${isCur ? ' current o-' + rec.outcome : ''}" title="Frame ${i}: free"><b>F${fv(i)}</b>free${hand}</div>`); continue; }
      const dirty = m.pt[f.pid].flags[f.vpn] & 4;
      out.push(`<div class="frame${dirty ? ' dirty' : ''}${isCur ? ' current o-' + rec.outcome : ''}${victim === i ? ' victim' : ''}" style="--pc:${pColor(f.pid)}" title="Frame ${i} holds P${f.pid} VPN ${f.vpn}; loaded t${f.loadedAt}, used t${f.lastUse}${dirty ? ', dirty' : ''}"><b>F${fv(i)}</b><span class="owner">${c.processes > 1 ? 'P' + f.pid + '·' : 'VPN '}${fv(f.vpn)}</span>${hand}</div>`);
    }
    $('memMap').innerHTML = out.join('');
    const leg = [];
    for (let p = 0; p < c.processes; p++) leg.push(`<span><i class="pdot" style="--pc:${pColor(p)}"></i>P${p}</span>`);
    leg.push('<span><i class="sw absent"></i>Free</span>', '<span><b style="color:var(--miss)">D</b> Dirty</span>');
    if (c.faultMode === 'demand' && c.framePolicy === 'CLOCK') leg.push('<span style="color:var(--ctx)">◆ CLOCK hand</span>');
    if (victim >= 0) leg.push('<span><i class="sw ghost"></i>Just replaced</span>');
    $('memLegend').innerHTML = leg.join('');
  }

  /* --------------------------------------------------------- telemetry */
  function renderKPIs() {
    const s = S.mmu.stats, met = S.mmu.metrics();
    const tiles = [
      ['', 'Accesses', s.accesses, `${s.reads} R · ${s.writes} W`],
      ['k-hit', 'Hit ratio', s.accesses ? pct(met.hitRatio) : '—', `${s.hits} hits`],
      ['k-miss', 'TLB misses', s.misses, `${s.walkReads} PTE reads walked`],
      ['k-fault', 'Page faults', s.pageFaults, S.cfg.faultMode === 'demand' ? `${s.faultsServiced} serviced` : 'reported only'],
      ['k-prot', 'Protection', s.protFaults, 'writes blocked'],
      ['', 'TLB evictions', s.tlbEvictions, `${s.tlbFills} fills · ${s.shootdowns} shootdowns`],
      ['', 'Page evictions', s.pageEvictions, `${s.writebacks} dirty write-backs`],
      ['k-ctx', 'Context switches', s.contextSwitches, S.cfg.contextMode === 'flush' ? `${s.flushedEntries} entries flushed` : 'ASID-tagged'],
    ];
    const box = $('kpis');
    if (box.children.length !== tiles.length) box.innerHTML = tiles.map(([cls]) => `<div class="kpi ${cls}"><span></span><b>0</b><small></small></div>`).join('');
    tiles.forEach(([, k, v, sub], i) => {
      const el = box.children[i];
      el.children[0].textContent = k; el.children[2].textContent = sub;
      countTo(el.children[1], v, el);
    });
  }

  /** Animates a KPI number from its current value to the new one (handles '42.5%' and '—'). */
  function countTo(el, target, tile) {
    const str = String(target);
    if (el.textContent === str) return;
    const m = /^(-?\d+(?:\.\d+)?)(%?)$/.exec(str);
    const prev = parseFloat(el.textContent);
    if (tile) { tile.classList.remove('bump'); void tile.offsetWidth; tile.classList.add('bump'); }
    if (!m || reduceMotion || Number.isNaN(prev)) { el.textContent = str; return; }
    const to = parseFloat(m[1]), dec = (m[1].split('.')[1] || '').length, suf = m[2];
    const t0 = performance.now(), dur = 650;
    cancelAnimationFrame(el._raf);
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (prev + (to - prev) * e).toFixed(dec) + suf;
      if (k < 1) el._raf = requestAnimationFrame(step); else el.textContent = str;
    };
    el._raf = requestAnimationFrame(step);
    clearTimeout(el._fin);
    el._fin = setTimeout(() => { cancelAnimationFrame(el._raf); el.textContent = str; }, dur + 80); // exact value even if rAF is throttled
  }

  function accessEvents() { return S.events.slice(0, S.cursor).filter(e => e.kind !== 'op'); }

  function renderChart() {
    const evs = accessEvents();
    const W = 560, H = 190, L = 34, R = 10, T = 10, B = 24;
    const box = $('hitChart');
    if (evs.length < 2) {
      box.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty-t" x="${W / 2}" y="${H / 2}" text-anchor="middle">Run at least two accesses to draw the curve.</text></svg>`;
    } else {
      const n = evs.length, cum = [], roll = [];
      let hits = 0;
      evs.forEach((e, i) => {
        if (e.outcome === 'HIT') hits++;
        cum.push(hits / (i + 1));
        const w = evs.slice(Math.max(0, i - 7), i + 1);
        roll.push(w.filter(x => x.outcome === 'HIT').length / w.length);
      });
      const x = i => L + (i / (n - 1)) * (W - L - R), y = v => T + (1 - v) * (H - T - B);
      const line = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const grid = [0, .25, .5, .75, 1].map(v => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-t" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v * 100}</text>`).join('');
      const xt = [0, Math.floor((n - 1) / 2), n - 1].map(i => `<text class="axis-t" x="${x(i)}" y="${H - 6}" text-anchor="middle">${i + 1}</text>`).join('');
      box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hit ratio over ${n} accesses, ending at ${pct(cum[n - 1])}"><defs><linearGradient id="hitArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--hit)" stop-opacity=".35"/><stop offset="1" stop-color="var(--hit)" stop-opacity="0"/></linearGradient></defs>${grid}${xt}<path class="area" d="${line(cum)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line-roll" d="${line(roll)}"/><path class="line-cum" d="${line(cum)}"/><circle cx="${x(n - 1)}" cy="${y(cum[n - 1])}" r="4.5" fill="var(--hit)" style="filter:drop-shadow(0 0 6px var(--hit))"/></svg>`;
    }
    const counts = { HIT: 0, MISS: 0, FAULT: 0, PROT: 0 };
    evs.forEach(e => { counts[e.outcome]++; });
    const tot = evs.length;
    $('mixbar').innerHTML = tot ? Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `<div class="${k}" style="flex-grow:${v}" title="${k}: ${v}">${v / tot > .08 ? `${k} ${Math.round(v / tot * 100)}%` : ''}</div>`).join('') : '<div class="none">no data</div>';
  }

  /* --------------------------------------------------------------- EAT */
  function syncEatInputs() { $('eT').value = S.cfg.t; $('eM').value = S.cfg.m; $('eK').value = S.cfg.ptLevels; $('eS').value = S.cfg.faultTime; }
  function renderEAT() {
    const v = id => Number($(id).value);
    const r = E.eat({ h: v('eH'), t: v('eT'), m: v('eM'), levels: v('eK'), p: v('eP'), S: v('eS') });
    ['eH', 'eT', 'eM', 'eK', 'eP', 'eS'].forEach(id => $(id).setAttribute('aria-invalid', String(!!r.error)));
    if (r.error) { $('eatSub').textContent = r.error; $('eatBars').innerHTML = `<p class="eat-err">${esc(r.error)}</p>`; return; }
    const h = v('eH'), k = v('eK');
    $('eatSub').textContent = `= ${h}(${v('eT')} + ${v('eM')}) + ${+(1 - h).toFixed(4)}(${v('eT')} + ${k + 1}·${v('eM')})${v('eP') ? ` + ${v('eP')}·${v('eS')}` : ''} = ${ns(r.total)}`;
    const met = S.mmu.metrics();
    const bars = [['hit', 'TLB hit path', r.hit], ['miss', 'Miss path', r.miss], ['eat', 'EAT (model)', r.total], ['', 'No TLB at all', r.noTlb]];
    if (S.mmu.stats.accesses) bars.push(['measured', 'Measured, this run', met.measuredEAT]);
    const max = Math.max(...bars.map(b => b[2]), 1);
    $('eatBars').innerHTML = bars.map(([cls, label, val]) => `<div class="ebar ${cls}"><span>${label}</span><div class="track"><i style="width:${(val / max) * 100}%"></i></div><b>${ns(val)}</b></div>`).join('')
      + `<p class="eat-note">${r.speedup ? `The TLB makes translation ${r.speedup.toFixed(2)}× faster than walking the table on every access.` : ''}${S.mmu.stats.accesses ? ` Measured: h = ${met.hitRatio.toFixed(3)}, p = ${met.faultRate.toFixed(3)}.` : ''}</p>`;
  }

  /* ----------------------------------------------------------------- log */
  function noteFor(ev) {
    if (ev.kind === 'op') return ev.op.type === 'flush' ? `TLB flushed (${ev.flushed} entries)` : `${ev.label}${ev.shotDown ? ' · TLB entry shot down' : ''}`;
    const n = [];
    if (ev.switchedFrom !== undefined) n.push(`switch P${ev.switchedFrom}→P${ev.pid}${ev.flushed !== undefined ? ` (flushed ${ev.flushed})` : ''}`);
    if (ev.tlbEvicted) n.push(`TLB evict P${ev.tlbEvicted.asid}:${ev.tlbEvicted.vpn}`);
    if (ev.fault) n.push(ev.fault.evicted ? `page-in F${ev.fault.pfn}, evict P${ev.fault.evicted.pid}:${ev.fault.evicted.vpn}${ev.fault.evicted.dirty ? ' (write-back)' : ''}` : `page-in F${ev.fault.pfn} (free)`);
    if (ev.outcome === 'FAULT' && !ev.serviced) n.push('not serviced');
    if (ev.outcome === 'PROT') n.push('write to read-only page');
    return n.join(' · ');
  }
  function renderLog() {
    const c = S.cfg;
    const rows = [];
    let shown = 0, matched = 0;
    for (let i = S.cursor - 1; i >= 0; i--) {
      const ev = S.events[i];
      if (S.logFilter !== 'ALL' && ev.outcome !== S.logFilter) continue;
      matched++;
      if (shown >= 400) continue;
      shown++;
      if (ev.kind === 'op') { rows.push(`<tr data-k="${i}"${i === S.cursor - 1 ? ' class="now"' : ''}><td>${i + 1}</td><td colspan="5">${esc(ev.label)}</td><td><span class="pill OP">OP</span></td><td colspan="3"></td><td class="notes">${esc(noteFor(ev))}</td></tr>`); continue; }
      rows.push(`<tr data-k="${i}"${i === S.cursor - 1 ? ' class="now"' : ''}><td>${i + 1}</td><td>P${ev.pid}</td><td>${ev.write ? 'W' : 'R'}</td><td>${fa(ev.addr, c.vaBits)}</td><td>${fv(ev.vpn)}</td><td>${fv(ev.offset)}</td><td><span class="pill ${ev.outcome}">${ev.outcome}</span></td><td>${ev.pfn === null || ev.pfn === undefined ? '—' : fv(ev.pfn)}</td><td>${ev.pa === null || ev.pa === undefined ? '—' : fa(ev.pa, c.paBits)}</td><td>${ev.cost}</td><td class="notes">${esc(noteFor(ev))}</td></tr>`);
    }
    $('logBody').innerHTML = rows.length ? rows.join('') : `<tr class="empty-row"><td colspan="11">${S.cursor ? 'No events match this filter.' : 'No translations yet.'}</td></tr>`;
    $('logCount').textContent = `${matched} event${matched === 1 ? '' : 's'}${matched > shown ? ` · newest ${shown} shown` : ''}`;
  }

  /* ========================================================= policy lab */
  const LAB_COLORS = { FIFO: 'var(--miss)', LRU: 'var(--hit)', LFU: 'var(--ctx)', CLOCK: 'var(--p1)', RANDOM: 'var(--muted)', OPT: 'var(--ink)' };
  function runLab() {
    const src = $('labSource').value;
    let ops;
    if (src === 'current') ops = S.ops.filter(o => o.type === 'access');
    else if (src === 'textarea') { const r = E.parseTrace($('trace').value, S.cfg); if (!r.ok) { toast(r.error, true); return; } ops = r.ops; }
    else ops = E.generate(src, S.cfg, src === 'locality' ? 400 : 200, S.cfg.seed);
    if (!ops.length) { toast('The current timeline is empty. Run a workload first, or choose another trace source.', true); return; }
    let res;
    try { res = E.compare(S.cfg, ops, undefined, [1, 2, 3, 4, 8, 16, 32]); } catch (e) { toast(e.message, true); return; }
    const W = 520, H = 260, L = 40, R = 14, T = 12, B = 30;
    const n = res.sizes.length;
    const x = i => L + (i / (n - 1)) * (W - L - R), y = v => T + (1 - v) * (H - T - B);
    const grid = [0, .25, .5, .75, 1].map(v => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-t" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v * 100}%</text>`).join('');
    const xt = res.sizes.map((s, i) => `<text class="axis-t" x="${x(i)}" y="${H - 10}" text-anchor="middle">${s}</text>`).join('') + `<text class="axis-t" x="${(W + L) / 2}" y="${H}" text-anchor="middle">TLB entries →</text>`;
    const lines = res.rows.map(r => {
      const pts = r.points.map((p, i) => (p.hitRatio === null ? null : [x(i), y(p.hitRatio)])).filter(Boolean);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      return `<path class="pl" d="${d}" stroke="${LAB_COLORS[r.policy]}"${r.policy === 'OPT' ? ' stroke-dasharray="5 4"' : ''}><title>${r.policy}</title></path>` + pts.map(p => `<circle class="pt" cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${LAB_COLORS[r.policy]}"/>`).join('');
    }).join('');
    const best = res.sizes.map((_, i) => Math.max(...res.rows.filter(r => r.policy !== 'OPT').map(r => r.points[i].hitRatio ?? -1)));
    const table = `<table class="lab-table"><thead><tr><th>Policy</th>${res.sizes.map(s => `<th>${s}</th>`).join('')}</tr></thead><tbody>${res.rows.map(r => `<tr><td><span class="lab-key" style="background:${LAB_COLORS[r.policy]}"></span>${r.policy}</td>${r.points.map((p, i) => `<td class="${r.policy !== 'OPT' && p.hitRatio === best[i] && p.hitRatio !== null ? 'best' : ''}" title="${p.misses ?? '—'} misses">${p.hitRatio === null ? '—' : (p.hitRatio * 100).toFixed(1)}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="muted small" style="margin-top:8px">Hit % over ${ops.length} accesses. Bold green = best practical policy at that size (OPT is excluded because it needs to know the future). Physical memory is enlarged for the experiment so page evictions never disturb the TLB.</p>`;
    const anomaly = res.anomalies.length
      ? `<div class="callout"><b>Belady's anomaly detected.</b> ${res.anomalies.map(a => `${a.policy}: ${a.from} → ${a.to} entries raised misses from ${a.missesFrom} to ${a.missesTo}`).join('; ')}. Stack algorithms (LRU, OPT) can never do this.</div>`
      : `<div class="callout ok">No Belady anomaly on this trace: for every policy, adding TLB entries never increased misses.${src !== 'belady' ? ' Try “Belady’s string” to see one.' : ''}</div>`;
    store.set('tlbscope-lab', JSON.stringify({ at: Date.now(), source: src, n: ops.length, rows: res.rows.map(r => ({ policy: r.policy, hit: r.points.map(p => p.hitRatio) })), sizes: res.sizes, anomalies: res.anomalies }));
    $('labOut').innerHTML = `<div class="lab-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hit ratio by TLB size for each policy">${grid}${xt}${lines}</svg></div><div>${table}</div>${anomaly}`;
  }

  /* ===================================================== probe & inputs */
  function syncProbe() {
    const c = S.cfg;
    $('pidWrap').hidden = c.processes < 2;
    const cur = Math.min(+$('pid').value || 0, c.processes - 1);
    $('pid').innerHTML = Array.from({ length: c.processes }, (_, p) => `<option value="${p}">P${p}</option>`).join('');
    $('pid').value = String(cur);
    updatePreview();
  }

  function showAddrError(msg) {
    $('addrError').textContent = msg; $('addrError').hidden = !msg;
    $('addr').setAttribute('aria-invalid', String(!!msg));
  }

  function readProbe() {
    const p = E.parseAddress($('addr').value);
    const g = E.geometry(S.cfg);
    if (!p.ok) return { error: p.error };
    if (p.value > g.vaMax) return { error: `${p.value} is outside the ${S.cfg.vaBits}-bit virtual address space (max ${g.vaMax.toLocaleString('en-US')} = ${E.toHex(g.vaMax, S.cfg.vaBits)}).` };
    return { op: { type: 'access', pid: +$('pid').value || 0, addr: p.value, write: S.rw === 'w' } };
  }

  function updatePreview() {
    if (!has('addr')) return; // the probe lives on the Translate page only
    const raw = String($('addr').value);
    const r = readProbe();
    const out = $('addrPreview');
    if (r.error) {
      out.textContent = raw.trim() ? '' : 'Enter an address.';
      if (raw.trim()) showAddrError(r.error); else showAddrError('');
      return;
    }
    showAddrError('');
    const c = S.cfg, a = r.op.addr, d = S.mmu.decompose(a);
    const pte = S.mmu.pte(r.op.pid, d.vpn);
    const cached = !!S.mmu.tlbFind(r.op.pid, d.vpn).entry;
    out.innerHTML = `<b>${a}</b> = <b>${E.toHex(a, c.vaBits)}</b> = ${E.toBin(a, c.vaBits).replace(/(.{4})(?=.)/g, '$1 ')} · VPN <b>${d.vpn}</b>, offset <b>${d.offset}</b> · prediction: <b>${cached ? 'TLB hit' : pte.present ? 'TLB miss, PTE present' : c.faultMode === 'demand' ? 'page fault → demand page-in' : 'page fault'}</b>`;
    const rec = currentRecord();
    if (!rec || rec.addr !== a || rec.pid !== r.op.pid) { S.preview = { addr: a, pid: r.op.pid }; renderBits({ addr: a, pid: r.op.pid, rec: null }); }
    else if (S.preview) { S.preview = null; renderBits({ addr: rec.addr, pid: rec.pid, rec }); }
  }

  function translateProbe(step) {
    const r = readProbe();
    if (r.error) { showAddrError(r.error); $('addr').focus(); return; }
    const rec = execute([r.op], { animate: !step });
    if (rec && step) startStage(rec);
    if (rec) updatePreview();
    if (rec && !step) $('addr').select();
  }

  /* ============================================================ workload */
  function parseBox() {
    const r = E.parseTrace($('trace').value, S.cfg);
    $('traceError').hidden = r.ok;
    if (!r.ok) { $('traceError').textContent = r.error; return null; }
    return r.ops.map(o => Object.assign({ type: 'access' }, o));
  }
  function runTrace() {
    const ops = parseBox();
    if (!ops) return;
    execute(ops, { animate: false });
    const s = S.mmu.stats;
    toast(`Ran ${ops.length} access${ops.length === 1 ? '' : 'es'}. Hit ratio is now ${pct(S.mmu.metrics().hitRatio)} (${s.hits}/${s.accesses}).`);
  }
  function queueTrace() {
    const ops = parseBox();
    if (!ops) return;
    stopPlay();
    S.ops.length = S.cursor;
    S.ops.push(...ops);
    rebuild();
    renderAll(false);
    toast(`Queued ${ops.length} access${ops.length === 1 ? '' : 'es'} after t = ${S.cursor}. Playing…`);
    startPlay();
  }

  /* ============================================================ playback */
  function startPlay() {
    if (S.cursor >= S.ops.length) {
      if (!S.ops.length) { toast('Nothing to play. Queue a trace or run some accesses first.'); return; }
      seek(0, true);
    }
    S.playing = true;
    endStage();
    tick();
  }
  function tick() {
    if (!S.playing) return;
    if (S.cursor >= S.ops.length) { stopPlay(); renderScope(); return; }
    seek(S.cursor + 1, true);
    S.preview = null;
    renderAll(+$('speed').value >= 160);
    S.playTimer = setTimeout(tick, +$('speed').value);
  }
  function stopPlay() {
    S.playing = false;
    clearTimeout(S.playTimer);
    if ($('tPlay')) { $('tPlay').textContent = '▶'; $('tPlay').setAttribute('aria-pressed', 'false'); }
  }

  /* ==================================================== export & sharing */
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCSV() {
    const evs = S.events.slice(0, S.cursor);
    if (!evs.length) { toast('Nothing to export yet.'); return; }
    const head = ['t', 'process', 'access', 'virtual_address', 'vpn', 'offset', 'tlb_set', 'outcome', 'pfn', 'physical_address', 'cost_ns', 'notes'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = evs.map((e, i) => e.kind === 'op'
      ? [i + 1, e.op.pid ?? '', 'OP', '', e.op.vpn ?? '', '', '', 'OP', '', '', 0, noteFor(e)]
      : [i + 1, e.pid, e.write ? 'W' : 'R', e.addr, e.vpn, e.offset, e.set, e.outcome, e.pfn ?? '', e.pa ?? '', e.cost, noteFor(e)]);
    const s = S.mmu.stats, met = S.mmu.metrics();
    const summary = [[], ['summary'], ['config', JSON.stringify(S.cfg)], ['accesses', s.accesses], ['hits', s.hits], ['misses', s.misses], ['hit_ratio', met.hitRatio.toFixed(4)], ['page_faults', s.pageFaults], ['protection_faults', s.protFaults], ['measured_eat_ns', met.measuredEAT.toFixed(2)]];
    download('tlbscope-log.csv', '﻿' + [head, ...rows, ...summary].map(r => r.map(q).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    toast(`Exported ${evs.length} events to CSV.`);
  }
  function sessionObject() { return { app: 'tlbscope', version: 2, cfg: S.cfg, ops: S.ops, cursor: S.cursor }; }
  function exportJSON() {
    download('tlbscope-session.json', JSON.stringify(Object.assign(sessionObject(), { stats: S.mmu.stats, metrics: S.mmu.metrics() }), null, 2), 'application/json');
    toast('Session exported. Import it later to restore this exact timeline.');
  }
  function loadSession(obj, source, quiet) {
    if (!obj || typeof obj !== 'object' || !obj.cfg || !Array.isArray(obj.ops)) throw new Error('Not a TLB/Scope session.');
    const cfg = Object.assign({}, E.DEFAULTS, obj.cfg);
    const err = E.validateConfig(cfg);
    if (err) throw new Error(err);
    const ops = obj.ops.filter(o => o && ['access', 'prot', 'invlpg', 'flush'].includes(o.type)).map(o => ({
      type: o.type, pid: o.pid | 0, addr: o.addr, vpn: o.vpn, write: !!o.write, writable: !!o.writable,
    })).map(o => { const c = { type: o.type }; if (o.type === 'access') Object.assign(c, { pid: o.pid, addr: o.addr, write: o.write }); else if (o.type !== 'flush') Object.assign(c, { pid: o.pid, vpn: o.vpn }); if (o.type === 'prot') c.writable = o.writable; return c; });
    S.ops = ops; S.cursor = Math.max(0, Math.min(ops.length, obj.cursor | 0));
    if (!applyConfig(cfg, { keepOps: true, quiet: true })) throw new Error('Configuration rejected.');
    if (!quiet) toast(`Loaded ${source}: ${ops.length} operation${ops.length === 1 ? '' : 's'}.`);
  }
  const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function shareLink() {
    if (S.ops.length > 3000) { toast('Timelines over 3,000 operations are too long for a link. Use Session JSON instead.', true); return; }
    const diff = {};
    Object.keys(E.DEFAULTS).forEach(k => { if (S.cfg[k] !== E.DEFAULTS[k] && !(k === 'tlbWays' && S.cfg.tlbWays === S.cfg.tlbEntries)) diff[k] = S.cfg[k]; });
    const packed = { c: diff, o: S.ops.map(o => o.type === 'access' ? [o.pid, o.addr, o.write ? 1 : 0] : [o.type, o.pid, o.vpn, o.writable ? 1 : 0]), k: S.cursor };
    const url = `${location.href.split('#')[0]}#s=${b64e(JSON.stringify(packed))}`;
    history.replaceState(null, '', url);
    const done = () => toast('Link copied. It reproduces this machine and timeline exactly.');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => toast('The address bar now holds the share link. Copy it from there.'));
    else toast('The address bar now holds the share link. Copy it from there.');
  }
  function readHash() {
    const m = /#s=([\w-]+)/.exec(location.hash);
    if (!m) return false;
    try {
      const p = JSON.parse(b64d(m[1]));
      const ops = (p.o || []).map(a => (typeof a[0] === 'number' ? { type: 'access', pid: a[0], addr: a[1], write: !!a[2] } : { type: a[0], pid: a[1], vpn: a[2], writable: !!a[3] }));
      loadSession({ cfg: Object.assign({}, E.DEFAULTS, p.c || {}), ops, cursor: p.k ?? ops.length }, 'shared link');
      return true;
    } catch (e) { toast('That share link could not be read: ' + e.message, true); return false; }
  }
  /** Saves the session synchronously so it is always there when the next page loads. */
  function persist() {
    if (S.ops.length <= 5000) store.set('tlbscope-session', JSON.stringify(sessionObject()));
    else store.set('tlbscope-session', JSON.stringify(Object.assign(sessionObject(), { ops: S.ops.slice(0, 5000), cursor: Math.min(S.cursor, 5000) })));
  }

  /* ============================================================ scenarios */
  const SMALL = { vaBits: 8, paBits: 8, pageSize: 16 };
  const acc = (list, pid = 0) => list.map(a => (typeof a === 'object' ? Object.assign({ type: 'access', pid }, a) : { type: 'access', pid, addr: a, write: false }));
  const SCENARIOS = [
    { id: 'basics', name: 'Miss, then hit', sub: '300 ×2 · locality', color: 'var(--hit)', cfg: {}, ops: acc([300, 300, 301, 1200, 300]), note: 'First touch of page 1 misses and fills the TLB. Every later byte on that page hits.' },
    { id: 'evict', name: 'FIFO eviction', sub: '2-entry TLB', color: 'var(--miss)', cfg: Object.assign({ tlbEntries: 2, tlbPolicy: 'FIFO' }, SMALL), ops: acc([16, 32, 16, 48, 16]), note: 'FIFO evicts page 1 even though it was just used. Switch the policy to LRU and the timeline replays with one more hit.' },
    { id: 'belady', name: "Belady's anomaly", sub: 'FIFO 3 vs 4 entries', color: 'var(--fault)', cfg: Object.assign({ tlbEntries: 3, tlbPolicy: 'FIFO' }, SMALL), ops: acc([1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5].map(p => p * 16)), note: '9 misses with 3 entries. Change the TLB to 4 entries and the replay gives 10. Then open the Policy lab.', lab: 'current' },
    { id: 'thrash', name: 'LRU thrashing', sub: 'loop of 5 pages', color: 'var(--p1)', cfg: { tlbEntries: 4 }, ops: acc(Array.from({ length: 20 }, (_, i) => (i % 5) * 256 + 8)), note: 'A loop one page bigger than the TLB makes LRU miss every time. Try RANDOM or CLOCK.' },
    { id: 'fault', name: 'Page fault', sub: 'report only', color: 'var(--fault)', cfg: {}, ops: acc([300, 4096, 8000, 300]), note: 'Pages 16 and above are not resident: the walk finds present = 0 and no physical address exists.' },
    { id: 'demand', name: 'Demand paging', sub: '4 frames · dirty', color: 'var(--prot)', cfg: { vaBits: 8, paBits: 6, pageSize: 16, mapping: 'empty', faultMode: 'demand', framePolicy: 'LRU', tlbEntries: 2 }, ops: acc([{ addr: 0, write: true }, 16, 32, 48, 0, { addr: 64 }, 16, { addr: 80, write: true }, 32]), note: 'Faults are serviced into 4 frames. Watch LRU victims, write-backs of dirty pages and TLB shootdowns.' },
    { id: 'prot', name: 'Write protection', sub: 'RO code page', color: 'var(--prot)', cfg: {}, ops: [{ type: 'prot', pid: 0, vpn: 1, writable: false }].concat(acc([300, { addr: 300, write: true }, { addr: 600, write: true }])), note: 'Page 1 is read-only. The read succeeds, the write raises a protection fault even on a TLB hit, and page 2 is marked dirty.' },
    { id: 'asid', name: 'Context switch', sub: '2 processes · ASID', color: 'var(--ctx)', cfg: { processes: 2, contextMode: 'asid' }, ops: acc([5, 300]).concat(acc([5, 300], 1), acc([5, 300]), acc([5], 1)), note: 'ASID tags keep both processes’ entries. Set “On context switch” to Flush and the replay loses every hit.' },
    { id: 'direct', name: 'Conflict misses', sub: 'direct-mapped', color: 'var(--miss)', cfg: { tlbEntries: 4, tlbWays: 1 }, ops: acc([0, 1024, 0, 1024, 256, 256]), note: 'Pages 0 and 4 share set 0 of a direct-mapped TLB, so they keep evicting each other. Make it fully associative to fix it.' },
    { id: 'walk', name: '3-level walk', sub: '32-bit VA', color: 'var(--ink-2)', cfg: { vaBits: 32, paBits: 20, pageSize: 4096, ptLevels: 3, tlbEntries: 8, tlbWays: 2, mapping: 'empty', faultMode: 'demand' }, ops: acc([0x00401A2C, 0x00401FFF, 0x7FFFF010, 0x00402000, 0x00401A2C, 0x7FFFF7F0]), note: 'A 32-bit space with 4 KiB pages. First touches walk 3 levels and demand-page in; repeats hit. The bit view shows the L1/L2/L3 indices and the TLB set.' },
  ];
  /** Runs `fn` inside a View Transition when possible; always runs it exactly once, even if the transition is skipped. */
  function withTransition(fn) {
    if (!document.startViewTransition || reduceMotion || document.visibilityState !== 'visible') { fn(); return null; }
    let ran = false;
    const once = () => { if (!ran) { ran = true; fn(); } };
    try {
      const vt = document.startViewTransition(once);
      vt.updateCallbackDone.catch(once);
      vt.ready.catch(() => {});
      vt.finished.catch(() => {});
      return vt;
    } catch (e) { once(); return null; }
  }
  function loadScenario(sc) { withTransition(() => loadScenarioNow(sc)); }
  function loadScenarioNow(sc) {
    const cfg = Object.assign({}, E.DEFAULTS, sc.cfg);
    S.ops = sc.ops.map(o => Object.assign({}, o)); S.cursor = S.ops.length;
    if (!applyConfig(cfg, { keepOps: true, quiet: true })) return;
    $('trace').value = sc.ops.filter(o => o.type === 'access').map(o => E.formatOp(o)).join(', ');
    const rec = currentRecord();
    if (rec) { $('addr').value = rec.addr; $('pid').value = String(rec.pid); }
    updatePreview();
    S.preview = null;
    renderAll(true);
    if (sc.lab && has('labOut')) { $('labSource').value = sc.lab; runLab(); }
    toast(sc.note);
    persist();
    if (has('scenarioNext')) {
      const box = $('scenarioNext');
      box.hidden = false;
      box.innerHTML = `<div class="sn-head"><span class="sn-dot" style="background:${sc.color}"></span><b>${esc(sc.name)}</b> loaded · ${S.ops.length} operations</div>
        <p>${esc(sc.note)}</p>
        <div class="sn-actions">
          <a class="btn primary" href="translate.html?explain=1">Explain the last translation →</a>
          <a class="btn" href="timeline.html?play=1">Play it on the timeline</a>
          <a class="btn" href="structures.html">Inspect structures</a>
          ${sc.lab ? '<a class="btn" href="lab.html?trace=current&run=1">Open in policy lab</a>' : ''}
        </div>`;
      box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
      document.querySelectorAll('[data-sc]').forEach(b => b.classList.toggle('active', b.dataset.sc === sc.id));
    }
  }

  /* ================================================================ BIST */
  function runBist() {
    if (!window.TLBSuite) { $('bistOut').innerHTML = '<p class="eat-err">Test suite failed to load.</p>'; return; }
    const { tests } = window.TLBSuite(E);
    const results = [];
    const btn = $('bistRun');
    btn.disabled = true;
    const t0 = performance.now();
    let i = 0;
    const out = $('bistOut');
    const step = () => {
      const until = performance.now() + 12;
      while (i < tests.length && performance.now() < until) {
        const t = tests[i++];
        try { t.fn(); results.push({ t, ok: true }); } catch (e) { results.push({ t, ok: false, err: e.message }); }
      }
      draw(i < tests.length);
      if (i < tests.length) setTimeout(step, 0); // setTimeout, not rAF: keeps running in background tabs
      else { btn.disabled = false; store.set('tlbscope-bist', JSON.stringify({ at: Date.now(), pass: results.filter(r => r.ok).length, total: tests.length })); }
    };
    const draw = running => {
      const pass = results.filter(r => r.ok).length;
      const groups = [...new Set(tests.map(t => t.group))];
      const ms = (performance.now() - t0).toFixed(0);
      out.innerHTML = `<div class="bist-summary"><div class="bist-score ${running ? '' : pass === tests.length ? 'pass' : 'fail'}">${pass}/${tests.length}</div>
        <div><div class="bist-meter"><i style="width:${(results.length / tests.length) * 100}%"></i></div>
        <p class="bist-meta">${running ? 'running…' : `${pass === tests.length ? 'ALL PASS' : `${tests.length - pass} FAILED`} · ${tests.filter(t => t.edge).length} edge cases · ${ms} ms in this browser`}</p></div></div>
        <div class="bist-groups">${groups.map(g => {
          const rs = results.filter(r => r.t.group === g);
          const bad = rs.filter(r => !r.ok).length;
          const total = tests.filter(t => t.group === g).length;
          return `<details class="bist-group"${bad ? ' open' : ''}><summary>${esc(g)}<b class="${bad ? 'bad' : ''}">${rs.length - bad}/${total}</b></summary><ul>${rs.map(r => `<li class="${r.ok ? '' : 'bad'}">${esc(r.t.name)}${r.t.edge ? '<span class="edge">EDGE</span>' : ''}${r.ok ? '' : `<em>${esc(r.err)}</em>`}</li>`).join('')}</ul></details>`;
        }).join('')}</div>`;
    };
    step();
  }

  /* ================================================================ viva */
  const VIVA = [
    ['What is a TLB and why is it needed?', 'A small, fast associative cache of recent page-table entries. Without it every memory reference would need extra memory reads for the page walk. With a high hit ratio, translation costs about one lookup.'],
    ['Does a TLB miss mean a page fault?', 'No. A miss only means the translation is not cached. The page table is walked; if the PTE is present it is a plain miss (the timeline shows it amber). A fault (red) happens only when the PTE’s present bit is 0.'],
    ['Why must page size be a power of two?', 'So the split is pure wiring: the low log₂(S) bits are the offset and the rest are the VPN. No division circuit is needed.'],
    ['Why is the offset unchanged during translation?', 'Pages and frames are the same size, so the byte’s position within the page is the same in the frame. Only the high bits (VPN → PFN) are replaced. The bit view draws the offset bits falling straight through.'],
    ['How is a set-associative TLB indexed?', 'sets = entries ÷ ways; the low log₂(sets) VPN bits choose the set and the rest form the tag. Direct-mapped (1-way) TLBs suffer conflict misses, as in the “Conflict misses” scenario.'],
    ['FIFO vs LRU vs CLOCK?', 'FIFO evicts the oldest insertion, LRU the least recently used, and CLOCK approximates LRU with a reference bit and a rotating hand (second chance). CLOCK is cheap in hardware, while true LRU needs timestamps or ordering.'],
    ['What is Belady’s anomaly?', 'For FIFO, more capacity can give more misses: on 1 2 3 4 1 2 5 1 2 3 4 5, 3 entries give 9 misses and 4 entries give 10. LRU and OPT are stack algorithms and cannot show it. The policy lab reproduces this.'],
    ['What is OPT and why can’t hardware use it?', 'OPT evicts the entry whose next use is farthest in the future. It gives the minimum possible misses but needs future knowledge, so it is used only as a benchmark.'],
    ['What is an ASID?', 'An address-space identifier stored in each TLB entry. Lookups match (ASID, VPN), so entries from different processes can coexist and a context switch does not require a flush.'],
    ['What is a TLB shootdown?', 'When the OS changes or removes a mapping (eviction, permission change), any cached copy of that translation becomes stale and must be invalidated, for example with INVLPG.'],
    ['What does the dirty bit do?', 'It is set on the first write. When the page is evicted, a dirty page must be written back to disk; a clean one can simply be dropped.'],
    ['Give the EAT formula used here.', 'EAT = h(t + m) + (1 − h)(t + k·m + m) + p·S, with k page-table levels, fault rate p and fault service time S. With h = 0.8, t = 10, m = 100, k = 1 and no faults, EAT = 130 ns.'],
    ['Why does a multi-level page table make the TLB more important?', 'A k-level walk costs k memory reads on every miss. Four-level x86-64 paging would need five memory accesses per reference without a TLB.'],
    ['How did you verify the simulator?', 'With an automated suite (run in Node and in-app) that checks textbook results: Belady’s 9/10, LRU 10/8, OPT 7/6, the CLOCK trace, EAT 130 ns and 608 ns. It also checks invariants (hits + misses = accesses, no stale TLB entries, frame/PTE agreement) and edge cases such as 0, the maximum address, 32-bit addresses and malformed input.'],
  ];
  function renderViva() {
    $('vivaList').innerHTML = VIVA.map(([q, a], i) => `<details><summary><span>Q${String(i + 1).padStart(2, '0')}</span>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('');
  }

  /* ================================================================ theme */
  function effectiveTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
  let lastPointer = null;
  document.addEventListener('pointerdown', e => { lastPointer = [e.clientX, e.clientY]; }, true);
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    const apply = () => { document.documentElement.dataset.theme = next; store.set('tlbscope-theme', next); };
    const btn = $('themeBtn').getBoundingClientRect();
    const [x, y] = lastPointer || [btn.left + btn.width / 2, btn.top + btn.height / 2];
    lastPointer = null;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.documentElement.classList.add('vt-theme'); // one snapshot, so the circular reveal covers the shell too
    const vt = withTransition(apply);
    if (vt) vt.finished.then(() => document.documentElement.classList.remove('vt-theme'), () => document.documentElement.classList.remove('vt-theme'));
    else document.documentElement.classList.remove('vt-theme');
    if (vt) vt.ready.then(() => {
      document.documentElement.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 750, easing: 'cubic-bezier(.7,0,.2,1)', pseudoElement: '::view-transition-new(root)' });
    }, () => {});
  }
  function setRadix(r) {
    S.radix = r;
    store.set('tlbscope-radix', r);
    document.querySelectorAll('[data-radix]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.radix === r)));
    renderAll(false);
  }
  function setRW(rw) {
    S.rw = rw;
    document.querySelectorAll('[data-rw]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rw === rw)));
    updatePreview();
  }

  /* ================================================================ bind */
  function bind() {
    CFG_IDS.forEach(id => {
      $(id).addEventListener('change', onDeckChange);
      if (id === 'vaBits' || id === 'paBits') $(id).addEventListener('input', onDeckChange);
    });
    $('resetCfg').addEventListener('click', () => { S.ops = []; S.cursor = 0; applyConfig(Object.assign({}, E.DEFAULTS), { keepOps: false, quiet: true }); toast('Factory defaults restored. Timeline cleared.'); });
    $('scenarioGrid').innerHTML = SCENARIOS.map(s => `<button type="button" class="scenario" data-sc="${s.id}" style="--sc:${s.color}"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><small>${esc(s.sub)}</small></button>`).join('');
    $('scenarioGrid').addEventListener('click', e => { const b = e.target.closest('[data-sc]'); if (b) loadScenario(SCENARIOS.find(s => s.id === b.dataset.sc)); });

    $('addr').addEventListener('input', updatePreview);
    $('addr').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); translateProbe(false); } });
    $('pid').addEventListener('change', updatePreview);
    $('translateBtn').addEventListener('click', () => translateProbe(false));
    $('explainBtn').addEventListener('click', () => translateProbe(true));
    document.querySelectorAll('[data-rw]').forEach(b => b.addEventListener('click', () => setRW(b.dataset.rw)));
    document.querySelectorAll('[data-radix]').forEach(b => b.addEventListener('click', () => setRadix(b.dataset.radix)));

    $('stagePrev').addEventListener('click', () => { if (S.stage && S.stage.i > 0) { S.stage.i--; renderStage(); } });
    $('stageNext').addEventListener('click', () => { if (S.stage && S.stage.i < S.stage.steps.length - 1) { S.stage.i++; renderStage(); } });
    $('stageDone').addEventListener('click', () => { endStage(); renderDatapath(currentRecord(), false); });

    $('tFirst').addEventListener('click', () => { stopPlay(); seek(0); });
    $('tBack').addEventListener('click', () => { stopPlay(); seek(S.cursor - 1); });
    $('tFwd').addEventListener('click', () => { stopPlay(); seek(S.cursor + 1); });
    $('tLast').addEventListener('click', () => { stopPlay(); seek(S.ops.length); });
    $('tPlay').addEventListener('click', () => (S.playing ? (stopPlay(), renderScope()) : startPlay()));
    $('scrub').addEventListener('input', e => { stopPlay(); seek(+e.target.value); });
    $('scope').addEventListener('click', e => { const g = e.target.closest('[data-k]'); if (g) { stopPlay(); seek(+g.dataset.k + 1); } });

    $('runTrace').addEventListener('click', runTrace);
    $('loadTrace').addEventListener('click', queueTrace);
    $('genKind').innerHTML = Object.entries(E.WORKLOADS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    $('genBtn').addEventListener('click', () => {
      const n = Math.max(1, Math.min(5000, Math.floor(+$('genCount').value) || 48));
      $('genCount').value = n;
      const ops = E.generate($('genKind').value, S.cfg, n, (S.cfg.seed + Date.now()) >>> 0);
      $('trace').value = ops.map(E.formatOp).join(', ');
      $('traceError').hidden = true;
      toast(`Generated ${ops.length} accesses. Run trace to execute them, or Queue & play to watch.`);
    });
    $('importFile').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 2e6) { toast('File is larger than 2 MB.', true); return; }
      f.text().then(txt => {
        const trimmed = txt.trim();
        if (trimmed.startsWith('{')) { try { loadSession(JSON.parse(trimmed), f.name); } catch (err) { toast('Import failed: ' + err.message, true); } return; }
        $('trace').value = trimmed;
        const r = E.parseTrace(trimmed, S.cfg);
        $('traceError').hidden = r.ok;
        if (!r.ok) $('traceError').textContent = r.error;
        else toast(`Imported ${r.ops.length} accesses from ${f.name}.`);
      });
    });
    $('clearRun').addEventListener('click', () => { stopPlay(); S.ops = []; S.cursor = 0; S.mmu = null; rebuild(); endStage(); renderAll(false); persist(); toast('Timeline cleared and machine restarted.'); });

    $('flushBtn').addEventListener('click', () => { execute([{ type: 'flush' }], { animate: false }); toast('TLB flushed. This was recorded on the timeline as an operation.'); });
    $('ptTabs').addEventListener('click', e => { const b = e.target.closest('[data-pid]'); if (b) { S.pidView = +b.dataset.pid; S.selectedVpn = null; S.ptWin = 0; renderPT(); } });
    $('ptMap').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { S.selectedVpn = +b.dataset.v; renderPT(); } });
    $('ptInspector').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || S.selectedVpn === null) return;
      const v = S.selectedVpn, pid = S.pidView;
      if (b.dataset.act === 'probe') { $('addr').value = v * S.cfg.pageSize; $('pid').value = String(pid); translateProbe(false); }
      if (b.dataset.act === 'prot') { const w = !S.mmu.pte(pid, v).writable; execute([{ type: 'prot', pid, vpn: v, writable: w }], { animate: false }); toast(`P${pid} page ${v} is now ${w ? 'writable' : 'read-only'}${S.events[S.cursor - 1].shotDown ? '; its TLB entry was shot down' : ''}.`); }
      if (b.dataset.act === 'invlpg') { execute([{ type: 'invlpg', pid, vpn: v }], { animate: false }); toast(`INVLPG: TLB entry for P${pid} page ${v} invalidated.`); }
    });

    ['eH', 'eT', 'eM', 'eK', 'eP', 'eS'].forEach(id => $(id).addEventListener('input', renderEAT));
    $('eatUseMeasured').addEventListener('click', () => {
      if (!S.mmu.stats.accesses) { toast('Run some accesses first.'); return; }
      const met = S.mmu.metrics();
      $('eH').value = +met.hitRatio.toFixed(4); $('eP').value = +met.faultRate.toFixed(4);
      syncEatInputs(); renderEAT();
    });

    $('labRun').addEventListener('click', runLab);
    $('logFilter').addEventListener('click', e => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      S.logFilter = b.dataset.f;
      $('logFilter').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderLog();
    });
    $('logBody').addEventListener('click', e => { const tr = e.target.closest('[data-k]'); if (tr) { stopPlay(); seek(+tr.dataset.k + 1); } });
    $('exportCsv').addEventListener('click', exportCSV);
    $('exportCsv2').addEventListener('click', exportCSV);
    $('exportJson').addEventListener('click', exportJSON);
    $('printBtn').addEventListener('click', () => window.print());
    $('shareBtn').addEventListener('click', shareLink);
    $('bistJump').addEventListener('click', () => { $('bist').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); runBist(); });
    $('bistRun').addEventListener('click', runBist);
    $('bistRun2').addEventListener('click', runBist);
    $('themeBtn').addEventListener('click', toggleTheme);
    $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) { if (e.key === 'Escape') e.target.blur(); return; }
      if ($('helpDialog').open) return;
      const k = e.key;
      const onTimeline = has('scope');
      if (k === '/') { e.preventDefault(); if (has('addr')) { $('addr').focus(); $('addr').select(); } else if (window.tlbshell) window.tlbshell.go('translate.html'); }
      else if (onTimeline && k === 'ArrowLeft') { e.preventDefault(); stopPlay(); seek(S.cursor - 1); }
      else if (onTimeline && k === 'ArrowRight') { e.preventDefault(); stopPlay(); seek(S.cursor + 1); }
      else if (onTimeline && k === 'Home') { e.preventDefault(); stopPlay(); seek(0); }
      else if (onTimeline && k === 'End') { e.preventDefault(); stopPlay(); seek(S.ops.length); }
      else if (onTimeline && k === ' ' && tag !== 'button') { e.preventDefault(); S.playing ? (stopPlay(), renderScope()) : startPlay(); }
      else if (k === 'w' || k === 'W') setRW('w');
      else if (k === 'r' || k === 'R') setRW('r');
      else if (k === 'x' || k === 'X') setRadix(S.radix === 'dec' ? 'hex' : 'dec');
      else if (k === 't' || k === 'T') toggleTheme();
      else if (k === '?') $('helpDialog').showModal();
    });

    if ('ResizeObserver' in window) { let raf; new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderScope); }).observe($('scope')); }
    if ('IntersectionObserver' in window) {
      const links = [...document.querySelectorAll('.jump a')];
      const io = new IntersectionObserver(entries => entries.forEach(en => {
        if (en.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id));
      }), { rootMargin: '-30% 0px -60% 0px' });
      links.forEach(a => { const t = document.querySelector(a.getAttribute('href')); if (t) io.observe(t); });
    }
  }

  /* ================================================================ boot */
  function boot() {
    bind();
    renderViva();
    writeDeck(S.cfg);
    syncEatInputs();
    S.mmu = new E.MMU(S.cfg);
    if (!readHash()) {
      let restored = false;
      const saved = store.get('tlbscope-session');
      if (saved) { try { loadSession(JSON.parse(saved), 'your last session', true); restored = true; } catch (e) { /* ignore a corrupt save */ } }
      if (!restored) { rebuild(); syncProbe(); renderAll(false); }
    }
    const last = currentRecord(); // keep the probe in sync with a restored timeline
    if (last) { $('addr').value = last.addr; $('pid').value = String(last.pid); }
    updatePreview();
    const savedRadix = store.get('tlbscope-radix');
    if (savedRadix === 'hex' || savedRadix === 'dec') setRadix(savedRadix);
    deepLinks();
  }

  /**
   * Deep links make every view addressable:
   *   translate.html?addr=0x12C[&w=1][&pid=1][&explain=1]   timeline.html?t=12 | ?play=1
   *   structures.html#pte-4   machine.html?scenario=belady   lab.html?trace=belady&run=1   verify.html (auto-runs)
   */
  function deepLinks() {
    const q = new URLSearchParams(location.search);
    // Show the session's own trace in the workload editor rather than the sample.
    const acc = S.ops.filter(o => o.type === 'access');
    if (has('trace') && acc.length && acc.length <= 2000) $('trace').value = acc.map(E.formatOp).join(', ');
    const sc = q.get('scenario');
    if (sc && SCENARIOS.some(s => s.id === sc)) loadScenarioNow(SCENARIOS.find(s => s.id === sc));
    if (q.has('addr') && has('addr')) {
      const a = E.parseAddress(q.get('addr'));
      const rec = currentRecord();
      if (q.has('pid')) $('pid').value = String(Math.min(+q.get('pid') || 0, S.cfg.processes - 1));
      setRW(q.get('w') === '1' ? 'w' : 'r');
      $('addr').value = q.get('addr');
      // Re-use the current record when it is the same address; otherwise translate it now.
      if (a.ok && !(rec && rec.addr === a.value && String(rec.pid) === $('pid').value && !q.has('w'))) translateProbe(false);
      else updatePreview();
    }
    if (q.get('explain') === '1' && has('showHow') && currentRecord()) setTimeout(() => $('showHow').click(), 450);
    if (q.has('t') && has('scope')) seek(+q.get('t') || 0);
    if (q.get('play') === '1' && has('scope') && S.ops.length) setTimeout(() => { seek(0); startPlay(); }, 500);
    if (has('labOut')) {
      const tr = q.get('trace');
      if (tr && [...$('labSource').options].some(o => o.value === tr)) $('labSource').value = tr;
      if (q.get('run') === '1') setTimeout(runLab, 350);
      else {
        // Restore the last experiment's settings so the page is never blank after a visit.
        try { const prev = JSON.parse(store.get('tlbscope-lab') || 'null'); if (prev && !tr && [...$('labSource').options].some(o => o.value === prev.source)) $('labSource').value = prev.source; } catch (e) { /* ignore */ }
      }
    }
    if (has('bistOut')) setTimeout(runBist, reduceMotion ? 0 : 420);
    const pte = /^#pte-(\d+)$/.exec(location.hash);
    if (pte && has('ptMap')) {
      const v = +pte[1];
      if (v < E.geometry(S.cfg).pages) {
        S.selectedVpn = v; S.ptWin = Math.floor(v / WIN); S.followPt = S.cursor; renderPT();
        setTimeout(() => { const c = document.querySelector(`#ptMap [data-v="${v}"]`); if (c) c.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' }); $('ptInspector').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' }); }, 500);
      }
    }
    if (q.get('lastScenario') === '1' && has('scenarioNext')) { /* reserved */ }
  }
  boot();

  // Exposed for debugging from the console.
  /** Machine state immediately *before* a given access record (replays the timeline up to it). */
  function stateBefore(rec) {
    const idx = S.events.indexOf(rec);
    if (idx < 0 || idx > 20000) return null;
    const m = new E.MMU(S.cfg);
    for (let i = 0; i < idx; i++) applyOp(m, S.ops[i], i);
    return m;
  }
  window.tlbscope = {
    state: S, engine: E, execute, seek, currentRecord, stateBefore,
    scenarios: SCENARIOS.map(s => ({ id: s.id, name: s.name, sub: s.sub, color: s.color })),
    loadScenario: id => loadScenario(SCENARIOS.find(s => s.id === id)),
    translate: (addr, write) => { $('addr').value = addr; setRW(write ? 'w' : 'r'); translateProbe(false); },
    runBist, runLab, exportCSV, exportJSON, shareLink, toggleTheme,
    setRadix: r => setRadix(r),
    setPolicy: p => { applyConfig(Object.assign({}, S.cfg, { tlbPolicy: p })); if (has('tlbPolicy')) $('tlbPolicy').value = p; },
    clear: () => { stopPlay(); S.ops = []; S.cursor = 0; S.mmu = null; rebuild(); endStage(); renderAll(false); persist(); toast('Timeline cleared and machine restarted.'); },
    play: () => startPlay(), rewind: () => { stopPlay(); seek(0); },
    flush: persist, has, noteFor, summaryFor, stepsFor, accessEvents: () => accessEvents(),
  };
  // The first render happened before the API existed; let listeners (shell, calc) catch up.
  document.dispatchEvent(new CustomEvent('tlb:render', { detail: { animate: false } }));
})();
