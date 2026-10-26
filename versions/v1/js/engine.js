/*
 * TLB/Scope — MMU engine
 * ----------------------------------------------------------------------------
 * A deterministic, DOM-free model of virtual-to-physical address translation.
 * It runs unchanged in the browser (window.TLBEngine) and in Node (require),
 * which is what lets the same test suite run in both places.
 *
 * Modelled hardware/OS behaviour
 *   - Byte-addressed paging with power-of-two page sizes
 *   - TLB: fully associative, direct-mapped or N-way set associative
 *   - TLB replacement: FIFO, LRU, LFU, CLOCK (second chance), RANDOM (seeded),
 *     OPT (Belady; only when the future trace is known, i.e. simulate())
 *   - Multi-level page-table walk (cost model + per-level indices)
 *   - Up to 4 processes with ASID-tagged TLB entries, or flush-on-switch
 *   - Page faults: either reported only, or serviced by demand paging with
 *     FIFO / LRU / CLOCK frame replacement, dirty write-back and TLB shootdown
 *   - Read/write protection and dirty bits
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TLBEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TLB_POLICIES = ['FIFO', 'LRU', 'LFU', 'CLOCK', 'RANDOM', 'OPT'];
  const FRAME_POLICIES = ['FIFO', 'LRU', 'CLOCK'];
  const MAPPINGS = ['sequential', 'sparse', 'random', 'empty'];
  const OUTCOMES = { HIT: 'HIT', MISS: 'MISS', FAULT: 'FAULT', PROT: 'PROT' };

  // PTE flag bits (stored in a Uint8Array, one byte per page)
  const F_PRESENT = 1, F_WRITABLE = 2, F_DIRTY = 4, F_REF = 8;

  const LIMITS = {
    minBits: 4, maxBits: 32,
    maxTotalPages: 1 << 20,   // pages × processes
    maxFrames: 1 << 16,
    maxTlbEntries: 64,
    maxLevels: 4,
    maxProcesses: 4,
    maxTraceLength: 20000,
  };

  const DEFAULTS = Object.freeze({
    vaBits: 16,
    paBits: 12,
    pageSize: 256,
    tlbEntries: 4,
    tlbWays: 0,              // 0 = fully associative (ways = entries)
    tlbPolicy: 'LRU',
    ptLevels: 1,
    mapping: 'sequential',
    faultMode: 'report',     // 'report' | 'demand'
    framePolicy: 'FIFO',
    processes: 1,
    contextMode: 'asid',     // 'asid' | 'flush'
    t: 10,                   // TLB lookup time (ns)
    m: 100,                  // memory access time (ns)
    faultTime: 8000,         // page-fault service time (ns)
    seed: 2024,
  });

  /* ---------------------------------------------------------------- utils */
  const isPow2 = n => Number.isInteger(n) && n > 0 && Number.isInteger(Math.log2(n));
  const log2i = n => Math.round(Math.log2(n));

  /** mulberry32 — tiny seeded PRNG so "random" runs are reproducible. */
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = n => Math.floor(next() * n);
    next.state = () => a;
    return next;
  }

  /* ----------------------------------------------------- config & geometry */
  function normalizeConfig(input) {
    const c = Object.assign({}, DEFAULTS, input || {});
    for (const k of ['vaBits', 'paBits', 'pageSize', 'tlbEntries', 'tlbWays', 'ptLevels', 'processes', 't', 'm', 'faultTime', 'seed']) {
      if (typeof c[k] === 'string' && c[k].trim() !== '') c[k] = Number(c[k]);
    }
    if (c.tlbWays === 0 || c.tlbWays === undefined || c.tlbWays === null) c.tlbWays = c.tlbEntries;
    if (typeof c.tlbPolicy === 'string') c.tlbPolicy = c.tlbPolicy.toUpperCase();
    if (typeof c.framePolicy === 'string') c.framePolicy = c.framePolicy.toUpperCase();
    return c;
  }

  /** Returns '' when valid, otherwise a human-readable reason. */
  function validateConfig(input) {
    const c = normalizeConfig(input);
    const int = (k, lo, hi) => Number.isInteger(c[k]) && c[k] >= lo && c[k] <= hi;
    if (!int('vaBits', LIMITS.minBits, LIMITS.maxBits)) return `Virtual address width must be a whole number from ${LIMITS.minBits} to ${LIMITS.maxBits} bits.`;
    if (!int('paBits', LIMITS.minBits, LIMITS.maxBits)) return `Physical address width must be a whole number from ${LIMITS.minBits} to ${LIMITS.maxBits} bits.`;
    if (!isPow2(c.pageSize) || c.pageSize < 2) return 'Page size must be a power of two (at least 2 bytes).';
    const off = log2i(c.pageSize);
    if (off >= c.vaBits) return 'Page size must be smaller than the virtual address space (need at least one page-number bit).';
    if (off > c.paBits) return 'Page size cannot exceed physical memory (need at least one frame).';
    if (!int('processes', 1, LIMITS.maxProcesses)) return `Process count must be 1 to ${LIMITS.maxProcesses}.`;
    const pages = 2 ** (c.vaBits - off);
    if (pages * c.processes > LIMITS.maxTotalPages) return `This geometry creates ${(pages * c.processes).toLocaleString('en-US')} page-table entries; the limit is ${LIMITS.maxTotalPages.toLocaleString('en-US')}. Use larger pages or fewer address bits.`;
    if (2 ** (c.paBits - off) > LIMITS.maxFrames) return `This geometry creates more than ${LIMITS.maxFrames.toLocaleString('en-US')} physical frames. Use larger pages or fewer physical bits.`;
    if (!int('tlbEntries', 1, LIMITS.maxTlbEntries)) return `TLB size must be 1 to ${LIMITS.maxTlbEntries} entries.`;
    if (!Number.isInteger(c.tlbWays) || c.tlbWays < 1 || c.tlbWays > c.tlbEntries) return 'TLB associativity must be between 1 way and the TLB size.';
    if (c.tlbEntries % c.tlbWays !== 0) return 'TLB size must be a multiple of the associativity.';
    const sets = c.tlbEntries / c.tlbWays;
    if (!isPow2(sets)) return 'Number of TLB sets (entries ÷ ways) must be a power of two.';
    if (log2i(sets) > c.vaBits - off) return 'Too many TLB sets: the set index needs more bits than the page number has.';
    if (!TLB_POLICIES.includes(c.tlbPolicy)) return `Unknown TLB replacement policy "${c.tlbPolicy}".`;
    if (!FRAME_POLICIES.includes(c.framePolicy)) return `Unknown frame replacement policy "${c.framePolicy}".`;
    if (!MAPPINGS.includes(c.mapping)) return `Unknown initial mapping "${c.mapping}".`;
    if (!['report', 'demand'].includes(c.faultMode)) return 'Fault mode must be "report" or "demand".';
    if (!['asid', 'flush'].includes(c.contextMode)) return 'Context-switch mode must be "asid" or "flush".';
    if (!int('ptLevels', 1, LIMITS.maxLevels)) return `Page-table levels must be 1 to ${LIMITS.maxLevels}.`;
    if (c.ptLevels > c.vaBits - off) return 'Each page-table level needs at least one page-number bit.';
    for (const k of ['t', 'm', 'faultTime']) {
      if (typeof c[k] !== 'number' || !Number.isFinite(c[k]) || c[k] < 0) return `Timing value "${k}" must be a finite number ≥ 0.`;
    }
    if (!Number.isInteger(c.seed)) return 'Seed must be an integer.';
    return '';
  }

  function geometry(input) {
    const c = normalizeConfig(input);
    const offsetBits = log2i(c.pageSize);
    const vpnBits = c.vaBits - offsetBits;
    const pfnBits = c.paBits - offsetBits;
    const sets = c.tlbEntries / c.tlbWays;
    const indexBits = log2i(sets);
    const levelBits = [];
    const base = Math.floor(vpnBits / c.ptLevels), extra = vpnBits % c.ptLevels;
    for (let i = 0; i < c.ptLevels; i++) levelBits.push(base + (i === 0 ? extra : 0));
    return {
      offsetBits, vpnBits, pfnBits,
      pages: 2 ** vpnBits, frames: 2 ** pfnBits,
      sets, ways: c.tlbWays, indexBits, tagBits: vpnBits - indexBits,
      levelBits,
      vaMax: 2 ** c.vaBits - 1, paMax: 2 ** c.paBits - 1,
      fullyAssociative: sets === 1, directMapped: c.tlbWays === 1,
    };
  }

  /* --------------------------------------------------------------- parsing */
  /** Parses one address literal: decimal, 0x hex, 0b binary or 0o octal. `_` separators allowed. */
  function parseAddress(raw) {
    if (raw === null || raw === undefined) return { ok: false, error: 'Enter an address.' };
    const s = String(raw).trim().toLowerCase().replace(/_/g, '');
    if (s === '') return { ok: false, error: 'Enter an address.' };
    if (s.startsWith('-')) return { ok: false, error: 'Addresses cannot be negative.' };
    let value;
    if (/^0x[0-9a-f]+$/.test(s)) value = parseInt(s.slice(2), 16);
    else if (/^0b[01]+$/.test(s)) value = parseInt(s.slice(2), 2);
    else if (/^0o[0-7]+$/.test(s)) value = parseInt(s.slice(2), 8);
    else if (/^\d+$/.test(s)) value = Number(s);
    else if (/^\d*\.\d+$|^\d+\.\d*$/.test(s)) return { ok: false, error: `"${raw}" is fractional — addresses are whole bytes.` };
    else return { ok: false, error: `"${raw}" is not a valid address. Use decimal, 0x hex, 0b binary or 0o octal.` };
    if (!Number.isSafeInteger(value)) return { ok: false, error: `"${raw}" is too large.` };
    return { ok: true, value };
  }

  /**
   * Parses a trace. Token grammar:  [P<pid>:]<address>[:R|:W]
   * Separators: whitespace, comma, semicolon. `#` starts a comment until end of line.
   *   e.g.  300, 0x12C:W, P1:300, P1:0b1010:r
   */
  function parseTrace(text, input) {
    const c = normalizeConfig(input);
    const vaMax = 2 ** c.vaBits - 1;
    const src = String(text ?? '').replace(/#[^\n]*/g, ' ');
    const tokens = src.split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return { ok: false, error: 'The trace is empty — add at least one address.', ops: [] };
    if (tokens.length > LIMITS.maxTraceLength) return { ok: false, error: `Traces are limited to ${LIMITS.maxTraceLength.toLocaleString('en-US')} accesses.`, ops: [] };
    const ops = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const m = /^(?:p(\d+):)?([^:]+)(?::([rw]))?$/i.exec(tok);
      if (!m) return { ok: false, error: `Token ${i + 1} "${tok}" is malformed. Expected [P<n>:]address[:R|W].`, ops: [], index: i };
      const pid = m[1] === undefined ? 0 : Number(m[1]);
      if (!Number.isInteger(pid) || pid >= c.processes) return { ok: false, error: `Token ${i + 1} "${tok}" names process P${m[1]}, but ${c.processes === 1 ? 'only P0 exists' : `only P0–P${c.processes - 1} exist`}.`, ops: [], index: i };
      const a = parseAddress(m[2]);
      if (!a.ok) return { ok: false, error: `Token ${i + 1}: ${a.error}`, ops: [], index: i };
      if (a.value > vaMax) return { ok: false, error: `Token ${i + 1}: address ${m[2]} is outside the ${c.vaBits}-bit virtual space (0–${vaMax.toLocaleString('en-US')}).`, ops: [], index: i };
      ops.push({ pid, addr: a.value, write: (m[3] || 'r').toLowerCase() === 'w' });
    }
    return { ok: true, ops };
  }

  function formatOp(op) {
    return `${op.pid ? `P${op.pid}:` : ''}${op.addr}${op.write ? ':W' : ''}`;
  }

  /* ---------------------------------------------------------------- engine */
  class MMU {
    constructor(input) {
      const err = validateConfig(input);
      if (err) throw new RangeError(err);
      this.cfg = Object.freeze(normalizeConfig(input));
      this.geo = Object.freeze(geometry(this.cfg));
      this.reset();
    }

    reset() {
      const { cfg, geo } = this;
      this.rng = makeRng(cfg.seed);
      this.clock = 0;
      this.currentPid = 0;
      this.records = [];
      this.stats = MMU.emptyStats();
      // page tables: typed arrays per process
      this.pt = Array.from({ length: cfg.processes }, () => ({
        pfn: new Int32Array(geo.pages).fill(-1),
        flags: new Uint8Array(geo.pages).fill(F_WRITABLE),
      }));
      this.frames = Array.from({ length: geo.frames }, (_, pfn) => ({ pfn, pid: -1, vpn: -1, loadedAt: 0, lastUse: 0, ref: 0 }));
      this.frameHand = 0;
      this.tlb = Array.from({ length: geo.sets }, () => new Array(geo.ways).fill(null));
      this.tlbHands = new Array(geo.sets).fill(0);
      this.lastEvictedTlb = null;
      this.applyInitialMapping();
    }

    static emptyStats() {
      return {
        accesses: 0, hits: 0, misses: 0, walks: 0, walkReads: 0,
        pageFaults: 0, faultsServiced: 0, protFaults: 0,
        tlbEvictions: 0, tlbFills: 0, pageEvictions: 0, writebacks: 0, shootdowns: 0,
        contextSwitches: 0, flushes: 0, flushedEntries: 0,
        memAccesses: 0, reads: 0, writes: 0, cycles: 0,
      };
    }

    applyInitialMapping() {
      const { cfg, geo } = this;
      const P = cfg.processes;
      if (cfg.mapping === 'empty') return;
      let next = 0;
      if (cfg.mapping === 'sequential' || cfg.mapping === 'sparse') {
        const step = cfg.mapping === 'sparse' ? 2 : 1;
        for (let vpn = 0; vpn < geo.pages && next < geo.frames; vpn += step) {
          for (let pid = 0; pid < P && next < geo.frames; pid++) this.mapPage(pid, vpn, next++);
        }
      } else if (cfg.mapping === 'random') {
        // Fill half of the frames with random distinct (pid, vpn) pairs (seeded).
        const rng = makeRng(cfg.seed ^ 0x5bd1e995);
        const want = Math.max(1, Math.min(Math.floor(geo.frames / 2), geo.pages * P));
        const order = Array.from({ length: geo.frames }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) { const j = rng.int(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        let placed = 0, guard = 0;
        while (placed < want && guard++ < want * 50) {
          const pid = rng.int(P), vpn = rng.int(geo.pages);
          if (this.pt[pid].flags[vpn] & F_PRESENT) continue;
          this.mapPage(pid, vpn, order[placed++]);
        }
      }
    }

    mapPage(pid, vpn, pfn) {
      const t = this.pt[pid];
      t.pfn[vpn] = pfn;
      t.flags[vpn] |= F_PRESENT;
      Object.assign(this.frames[pfn], { pid, vpn, loadedAt: this.clock, lastUse: this.clock, ref: 1 });
    }

    pte(pid, vpn) {
      const t = this.pt[pid], f = t.flags[vpn];
      return {
        pid, vpn, pfn: t.pfn[vpn],
        present: !!(f & F_PRESENT), writable: !!(f & F_WRITABLE),
        dirty: !!(f & F_DIRTY), referenced: !!(f & F_REF),
      };
    }

    /** Splits an address into every field the UI needs. */
    decompose(addr) {
      const { geo } = this;
      const vpn = Math.floor(addr / this.cfg.pageSize);
      const offset = addr % this.cfg.pageSize;
      const set = vpn % geo.sets;
      const tag = Math.floor(vpn / geo.sets);
      const levels = [];
      let shift = geo.vpnBits;
      for (const bits of geo.levelBits) {
        shift -= bits;
        levels.push(Math.floor(vpn / 2 ** shift) % 2 ** bits);
      }
      return { vpn, offset, set, tag, levels };
    }

    /* ---------------------------------------------------------- TLB ops */
    tlbFind(pid, vpn) {
      const set = vpn % this.geo.sets;
      const row = this.tlb[set];
      for (let w = 0; w < row.length; w++) {
        const e = row[w];
        if (e && e.vpn === vpn && e.asid === pid) return { set, way: w, entry: e };
      }
      return { set, way: -1, entry: null };
    }

    chooseTlbVictim(set) {
      const row = this.tlb[set];
      const empty = row.indexOf(null);
      if (empty >= 0) return empty;
      const policy = this.cfg.tlbPolicy;
      let best = 0;
      if (policy === 'CLOCK') {
        // Second chance: skip (and clear) referenced entries.
        let hand = this.tlbHands[set];
        for (;;) {
          if (row[hand].ref) { row[hand].ref = 0; hand = (hand + 1) % row.length; }
          else { this.tlbHands[set] = (hand + 1) % row.length; return hand; }
        }
      }
      if (policy === 'RANDOM') return this.rng.int(row.length);
      const key = {
        FIFO: e => [e.insertedAt],
        LRU: e => [e.lastUse],
        LFU: e => [e.uses, e.lastUse],
        OPT: e => [-e.nextUse, e.insertedAt], // farthest next use → smallest key
      }[policy];
      for (let w = 1; w < row.length; w++) {
        const a = key(row[w]), b = key(row[best]);
        if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = w;
      }
      return best;
    }

    tlbInsert(pid, vpn, pfn, writable, dirty, nextUse) {
      const set = vpn % this.geo.sets;
      const way = this.chooseTlbVictim(set);
      const old = this.tlb[set][way];
      let evicted = null;
      if (old) { evicted = Object.assign({ set, way }, old); this.stats.tlbEvictions++; }
      this.tlb[set][way] = { asid: pid, vpn, pfn, writable, dirty, insertedAt: this.clock, lastUse: this.clock, uses: 1, ref: 1, nextUse };
      this.stats.tlbFills++;
      return { set, way, evicted };
    }

    /** INVLPG: drop one translation (used by page eviction / protection change). */
    invalidate(pid, vpn) {
      const hit = this.tlbFind(pid, vpn);
      if (hit.entry) { this.tlb[hit.set][hit.way] = null; this.stats.shootdowns++; return true; }
      return false;
    }

    flushTLB() {
      let n = 0;
      for (const row of this.tlb) for (let w = 0; w < row.length; w++) if (row[w]) { row[w] = null; n++; }
      this.tlbHands.fill(0);
      return n;
    }

    setWritable(pid, vpn, writable) {
      const t = this.pt[pid];
      if (writable) t.flags[vpn] |= F_WRITABLE; else t.flags[vpn] &= ~F_WRITABLE;
      // A cached translation would carry stale permissions → shoot it down.
      return this.invalidate(pid, vpn);
    }

    tlbEntries() {
      const out = [];
      this.tlb.forEach((row, set) => row.forEach((e, way) => { if (e) out.push(Object.assign({ set, way }, e)); }));
      return out;
    }

    /* -------------------------------------------------------- frame ops */
    chooseFrameVictim() {
      const frames = this.frames;
      const free = frames.findIndex(f => f.pid < 0);
      if (free >= 0) return { pfn: free, free: true };
      const policy = this.cfg.framePolicy;
      if (policy === 'CLOCK') {
        for (;;) {
          const f = frames[this.frameHand];
          if (f.ref) { f.ref = 0; this.frameHand = (this.frameHand + 1) % frames.length; }
          else { const pfn = this.frameHand; this.frameHand = (pfn + 1) % frames.length; return { pfn, free: false }; }
        }
      }
      let best = 0;
      const k = policy === 'LRU' ? 'lastUse' : 'loadedAt';
      for (let i = 1; i < frames.length; i++) if (frames[i][k] < frames[best][k]) best = i;
      return { pfn: best, free: false };
    }

    servicePageFault(pid, vpn) {
      const choice = this.chooseFrameVictim();
      const frame = this.frames[choice.pfn];
      let evicted = null;
      if (!choice.free) {
        const victimPt = this.pt[frame.pid];
        const dirty = !!(victimPt.flags[frame.vpn] & F_DIRTY);
        evicted = { pid: frame.pid, vpn: frame.vpn, pfn: choice.pfn, dirty, shotDown: false };
        victimPt.flags[frame.vpn] &= ~(F_PRESENT | F_DIRTY | F_REF);
        victimPt.pfn[frame.vpn] = -1;
        if (dirty) this.stats.writebacks++;
        evicted.shotDown = this.invalidate(frame.pid, frame.vpn);
        this.stats.pageEvictions++;
      }
      this.mapPage(pid, vpn, choice.pfn);
      this.pt[pid].flags[vpn] &= ~F_DIRTY;
      this.stats.faultsServiced++;
      return { pfn: choice.pfn, usedFreeFrame: choice.free, evicted };
    }

    touchFrame(pfn) {
      const f = this.frames[pfn];
      f.lastUse = this.clock; f.ref = 1;
    }

    /* ------------------------------------------------------- translate */
    /**
     * Performs one memory access. Returns a record describing every step,
     * or { error } for invalid input (state is untouched in that case).
     * @param {{pid?:number, addr:number, write?:boolean}} op
     * @param {{nextUse?:number}} [ctx] future knowledge for OPT
     */
    access(op, ctx) {
      const { cfg, geo, stats } = this;
      const pid = op.pid ?? 0;
      const addr = op.addr;
      const write = !!op.write;
      if (!Number.isSafeInteger(addr) || addr < 0 || addr > geo.vaMax) {
        return { error: `Address must be a whole number from 0 to ${geo.vaMax.toLocaleString('en-US')}.` };
      }
      if (!Number.isInteger(pid) || pid < 0 || pid >= cfg.processes) return { error: `Process P${pid} does not exist.` };
      if (cfg.tlbPolicy === 'OPT' && (!ctx || ctx.nextUse === undefined)) return { error: 'OPT replacement needs the future trace; run it through simulate().' };

      const rec = { seq: this.records.length + 1, pid, addr, write };
      // context switch
      if (pid !== this.currentPid) {
        stats.contextSwitches++;
        rec.switchedFrom = this.currentPid;
        if (cfg.contextMode === 'flush') {
          const n = this.flushTLB();
          stats.flushes++; stats.flushedEntries += n;
          rec.flushed = n;
        }
        this.currentPid = pid;
      }
      this.clock++;
      rec.clock = this.clock;
      Object.assign(rec, this.decompose(addr));
      const { vpn, offset } = rec;
      stats.accesses++;
      if (write) stats.writes++; else stats.reads++;
      const nextUse = ctx && ctx.nextUse !== undefined ? ctx.nextUse : Infinity;
      const pt = this.pt[pid];
      let cost = cfg.t;
      let entryWritable;

      const found = this.tlbFind(pid, vpn);
      if (found.entry) {
        // ---- TLB HIT
        stats.hits++;
        const e = found.entry;
        e.lastUse = this.clock; e.uses++; e.ref = 1; e.nextUse = nextUse;
        rec.hit = true; rec.pfn = e.pfn; rec.tlbSlot = { set: found.set, way: found.way };
        entryWritable = e.writable;
      } else {
        // ---- TLB MISS → page-table walk
        stats.misses++; stats.walks++;
        stats.walkReads += cfg.ptLevels;
        cost += cfg.ptLevels * cfg.m;
        rec.hit = false;
        if (!(pt.flags[vpn] & F_PRESENT)) {
          stats.pageFaults++;
          rec.pageFault = true;
          if (cfg.faultMode === 'report') {
            rec.outcome = OUTCOMES.FAULT; rec.serviced = false; rec.pfn = null; rec.pa = null;
            rec.cost = cost; stats.cycles += cost;
            this.lastEvictedTlb = null;
            this.records.push(rec);
            return rec;
          }
          const svc = this.servicePageFault(pid, vpn);
          rec.serviced = true; rec.fault = svc;
          cost += cfg.faultTime;
        }
        rec.pfn = pt.pfn[vpn];
        const ins = this.tlbInsert(pid, vpn, rec.pfn, !!(pt.flags[vpn] & F_WRITABLE), !!(pt.flags[vpn] & F_DIRTY), nextUse);
        rec.tlbSlot = { set: ins.set, way: ins.way };
        rec.tlbEvicted = ins.evicted;
        entryWritable = !!(pt.flags[vpn] & F_WRITABLE);
      }
      this.lastEvictedTlb = rec.tlbEvicted || null;

      pt.flags[vpn] |= F_REF;
      this.touchFrame(rec.pfn);

      // ---- protection check (on the cached permission bits)
      if (write && !entryWritable) {
        stats.protFaults++;
        rec.outcome = OUTCOMES.PROT; rec.pa = null;
        rec.cost = cost; stats.cycles += cost;
        this.records.push(rec);
        return rec;
      }
      if (write) {
        pt.flags[vpn] |= F_DIRTY;
        const e = this.tlb[rec.tlbSlot.set][rec.tlbSlot.way];
        if (e) e.dirty = true;
      }
      // ---- data access
      cost += cfg.m;
      stats.memAccesses++;
      rec.pa = rec.pfn * cfg.pageSize + offset;
      rec.outcome = rec.pageFault ? OUTCOMES.FAULT : rec.hit ? OUTCOMES.HIT : OUTCOMES.MISS;
      rec.cost = cost; stats.cycles += cost;
      this.records.push(rec);
      return rec;
    }

    /** Derived metrics; every ratio is 0 when nothing has run. */
    metrics() {
      const s = this.stats, n = s.accesses;
      const ratio = (a, b) => (b ? a / b : 0);
      return {
        hitRatio: ratio(s.hits, n),
        missRatio: ratio(s.misses, n),
        faultRate: ratio(s.pageFaults, n),
        measuredEAT: ratio(s.cycles, n),
        tlbOccupancy: this.tlbEntries().length,
      };
    }

    /** Self-consistency checks — used by tests and the in-app BIST. */
    checkInvariants() {
      const s = this.stats, problems = [];
      const unservedFaults = s.pageFaults - s.faultsServiced;
      if (s.hits + s.misses !== s.accesses) problems.push('hits + misses ≠ accesses');
      if (s.walks !== s.misses) problems.push('walks ≠ misses');
      if (s.memAccesses !== s.accesses - unservedFaults - s.protFaults) problems.push('memory accesses mismatch');
      if (s.reads + s.writes !== s.accesses) problems.push('reads + writes ≠ accesses');
      // TLB never exceeds capacity, no duplicate (asid, vpn), every entry agrees with the page table
      const seen = new Set();
      for (const e of this.tlbEntries()) {
        const k = e.asid + ':' + e.vpn;
        if (seen.has(k)) problems.push('duplicate TLB entry ' + k);
        seen.add(k);
        if (e.set !== e.vpn % this.geo.sets) problems.push('entry in wrong set ' + k);
        const p = this.pte(e.asid, e.vpn);
        if (!p.present || p.pfn !== e.pfn) problems.push('stale TLB entry ' + k);
      }
      if (seen.size > this.cfg.tlbEntries) problems.push('TLB over capacity');
      // frame ↔ PTE agreement (inverted page table must be consistent)
      for (const f of this.frames) {
        if (f.pid < 0) continue;
        const p = this.pte(f.pid, f.vpn);
        if (!p.present || p.pfn !== f.pfn) problems.push('frame/PTE mismatch at frame ' + f.pfn);
      }
      for (let pid = 0; pid < this.cfg.processes; pid++) {
        const t = this.pt[pid];
        for (let v = 0; v < this.geo.pages; v++) {
          if (t.flags[v] & F_PRESENT) {
            const f = this.frames[t.pfn[v]];
            if (!f || f.pid !== pid || f.vpn !== v) { problems.push(`PTE P${pid}:${v} points at a frame it does not own`); break; }
          }
        }
      }
      return problems;
    }
  }

  /* ----------------------------------------------------- batch simulation */
  /** Precomputes, for each access, the index of the next access to the same (pid, vpn). */
  function nextUseIndex(cfg, ops) {
    const ps = normalizeConfig(cfg).pageSize;
    const next = new Array(ops.length);
    const last = new Map();
    for (let i = ops.length - 1; i >= 0; i--) {
      const k = (ops[i].pid || 0) + ':' + Math.floor(ops[i].addr / ps);
      next[i] = last.has(k) ? last.get(k) : Infinity;
      last.set(k, i);
    }
    return next;
  }

  function simulate(cfg, ops) {
    const mmu = new MMU(cfg);
    const future = mmu.cfg.tlbPolicy === 'OPT' ? nextUseIndex(mmu.cfg, ops) : null;
    const records = [];
    for (let i = 0; i < ops.length; i++) {
      const r = mmu.access(ops[i], future ? { nextUse: future[i] } : undefined);
      if (r.error) throw new RangeError(`Access ${i + 1}: ${r.error}`);
      records.push(r);
    }
    return { mmu, records, stats: mmu.stats, metrics: mmu.metrics() };
  }

  /**
   * Physical memory large enough that demand paging never evicts a page, so the
   * TLB is the only thing that differs between runs (compulsory faults remain,
   * and count as TLB misses identically for every policy).
   */
  function isolateTlb(input) {
    const c = normalizeConfig(input);
    const off = log2i(c.pageSize);
    const vpnBits = c.vaBits - off;
    const pfnBits = Math.min(16, vpnBits + Math.ceil(Math.log2(c.processes)));
    return Object.assign({}, c, { paBits: Math.min(LIMITS.maxBits, off + pfnBits), mapping: 'empty', faultMode: 'demand' });
  }

  /** Runs one trace across policies × TLB sizes (fully associative) → hit-ratio matrix. */
  function compare(cfg, ops, policies = ['FIFO', 'LRU', 'LFU', 'CLOCK', 'RANDOM', 'OPT'], sizes = [1, 2, 4, 8, 16, 32], { isolate = true } = {}) {
    const base = isolate ? isolateTlb(cfg) : normalizeConfig(cfg);
    const rows = policies.map(policy => ({
      policy,
      points: sizes.map(size => {
        const c = Object.assign({}, base, { tlbPolicy: policy, tlbEntries: size, tlbWays: size });
        if (validateConfig(c)) return { size, hitRatio: null, misses: null };
        const r = simulate(c, ops);
        return { size, hitRatio: r.metrics.hitRatio, misses: r.stats.misses, eat: r.metrics.measuredEAT };
      }),
    }));
    // Belady's anomaly: more entries but more misses
    const anomalies = [];
    for (const row of rows) {
      for (let i = 1; i < row.points.length; i++) {
        const a = row.points[i - 1], b = row.points[i];
        if (a.misses !== null && b.misses !== null && b.misses > a.misses) anomalies.push({ policy: row.policy, from: a.size, to: b.size, missesFrom: a.misses, missesTo: b.misses });
      }
    }
    return { sizes, rows, anomalies };
  }

  /* ------------------------------------------------------------ workloads */
  const WORKLOADS = {
    locality: 'Working set (80/20 locality)',
    sequential: 'Sequential scan',
    loop: 'Cyclic loop (TLB size + 1 pages)',
    strided: 'Strided (one access per page)',
    uniform: 'Uniform random',
    belady: "Belady's string 1 2 3 4 1 2 5 1 2 3 4 5",
    multiprocess: 'Round-robin processes',
    writes: 'Read/write mix (30% writes)',
  };

  function generate(kind, input, n = 48, seed) {
    const c = normalizeConfig(input);
    const g = geometry(c);
    const rng = makeRng(seed ?? c.seed);
    const ps = c.pageSize, pages = g.pages;
    const at = (vpn, off) => (vpn % pages) * ps + (off % ps);
    const ops = [];
    const push = (addr, pid = 0, write = false) => ops.push({ pid, addr, write });
    // Prefer pages that start mapped, so demos produce hits rather than faults.
    const usable = Math.max(1, Math.min(pages, c.mapping === 'sequential' ? Math.floor(g.frames / c.processes) || 1 : pages));
    switch (kind) {
      case 'sequential':
        for (let i = 0; i < n; i++) push(Math.min(g.vaMax, i * Math.max(1, Math.floor(ps / 4))));
        break;
      case 'loop': {
        const k = Math.min(usable, c.tlbEntries + 1);
        for (let i = 0; i < n; i++) push(at(i % k, 4 * i));
        break;
      }
      case 'strided':
        for (let i = 0; i < n; i++) push(at(i % usable, 8));
        break;
      case 'uniform':
        for (let i = 0; i < n; i++) push(rng.int(g.vaMax + 1));
        break;
      case 'belady':
        [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5].forEach(p => push(at(p % pages, 0)));
        break;
      case 'multiprocess':
        for (let i = 0; i < n; i++) {
          const pid = Math.floor(i / 4) % c.processes;
          push(at(rng.int(Math.min(usable, 6)), rng.int(ps)), pid);
        }
        break;
      case 'writes':
        for (let i = 0; i < n; i++) push(at(rng.int(Math.min(usable, 8)), rng.int(ps)), 0, rng() < 0.3);
        break;
      case 'locality':
      default: {
        const hot = Array.from({ length: Math.min(3, usable) }, (_, i) => i);
        for (let i = 0; i < n; i++) {
          const vpn = rng() < 0.8 ? hot[rng.int(hot.length)] : rng.int(usable);
          push(at(vpn, rng.int(ps)));
        }
      }
    }
    return ops;
  }

  /* ------------------------------------------------------------------ EAT */
  /**
   * Analytic effective access time.
   *   hit  = t + m
   *   miss = t + k·m + m           (k page-table levels)
   *   EAT  = h·hit + (1−h)·miss + p·S
   */
  function eat({ h, t, m, levels = 1, p = 0, S = 0 }) {
    const nums = [h, t, m, levels, p, S];
    if (nums.some(x => typeof x !== 'number' || !Number.isFinite(x))) return { error: 'All inputs must be numbers.' };
    if (h < 0 || h > 1) return { error: 'Hit ratio h must be between 0 and 1.' };
    if (p < 0 || p > 1) return { error: 'Fault rate p must be between 0 and 1.' };
    if (t < 0 || m < 0 || S < 0) return { error: 'Times cannot be negative.' };
    if (!Number.isInteger(levels) || levels < 1) return { error: 'Levels must be a positive integer.' };
    const hit = t + m, miss = t + (levels + 1) * m;
    const base = h * hit + (1 - h) * miss;
    const total = base + p * S;
    const noTlb = (levels + 1) * m;
    return { hit, miss, base, total, noTlb, speedup: total > 0 ? noTlb / total : null };
  }

  /* ------------------------------------------------------------ formatting */
  const toBin = (n, bits) => (bits <= 0 ? '' : Math.floor(n).toString(2).padStart(bits, '0').slice(-bits));
  const toHex = (n, bits) => '0x' + Math.floor(n).toString(16).toUpperCase().padStart(Math.max(1, Math.ceil(bits / 4)), '0');

  return {
    MMU, DEFAULTS, LIMITS, TLB_POLICIES, FRAME_POLICIES, MAPPINGS, OUTCOMES, WORKLOADS,
    normalizeConfig, validateConfig, geometry, parseAddress, parseTrace, formatOp,
    simulate, compare, isolateTlb, generate, eat, nextUseIndex, makeRng, toBin, toHex, isPow2,
  };
});
