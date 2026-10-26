/*
 * TLB/Scope — shared test suite.
 * The same cases run in Node (`npm test`) and inside the app (Self-test panel).
 * Every expected value below is derived by hand or from a textbook result
 * (Belady's string, CLOCK trace, GATE-style EAT examples) — not from the code.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TLBSuite = factory;
})(typeof self !== 'undefined' ? self : this, function defineSuite(E) {
  'use strict';

  /* ---------------------------------------------------------- tiny assert */
  class AssertionError extends Error {}
  const fmt = v => (typeof v === 'string' ? JSON.stringify(v) : Number.isNaN(v) ? 'NaN' : JSON.stringify(v));
  const assert = {
    ok(v, msg) { if (!v) throw new AssertionError(msg || `expected truthy, got ${fmt(v)}`); },
    equal(a, b, msg) { if (a !== b) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(b)}, got ${fmt(a)}`); },
    close(a, b, eps = 1e-9, msg) { if (Math.abs(a - b) > eps) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ≈${b}, got ${a}`); },
    deep(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
    match(s, re, msg) { if (!re.test(String(s))) throw new AssertionError(`${msg ? msg + ': ' : ''}${fmt(s)} does not match ${re}`); },
    throws(fn, re) {
      try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new AssertionError(`wrong error: ${e.message}`); return; }
      throw new AssertionError('expected an exception');
    },
  };

  const tests = [];
  let group = '';
  const describe = (g, body) => { group = g; body(); };
  const it = (name, fn, meta = {}) => tests.push({ group, name, fn, edge: !!meta.edge });

  /* ---------------------------------------------------------- helpers */
  const mmu = cfg => new E.MMU(cfg);
  const pageAddrs = (pages, ps = 16) => pages.map(p => ({ pid: 0, addr: p * ps }));
  const BELADY = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];
  // 8-bit VA, 8-bit PA, 16-byte pages → 16 pages, 16 frames, all mapped (sequential)
  const SMALL = { vaBits: 8, paBits: 8, pageSize: 16 };
  const run = (cfg, ops) => E.simulate(cfg, ops);
  const outcomes = r => r.records.map(x => x.outcome[0]).join('');

  /* ================================================================ */
  describe('Configuration & geometry', () => {
    it('default configuration is valid', () => assert.equal(E.validateConfig({}), ''));
    it('default geometry: 8 offset bits, 8 VPN bits, 256 pages, 16 frames', () => {
      const g = E.geometry({});
      assert.deep([g.offsetBits, g.vpnBits, g.pages, g.frames, g.pfnBits], [8, 8, 256, 16, 4]);
    });
    it('rejects address widths outside 4–32 bits', () => {
      assert.match(E.validateConfig({ vaBits: 3 }), /Virtual/);
      assert.match(E.validateConfig({ vaBits: 33 }), /Virtual/);
      assert.match(E.validateConfig({ paBits: 2 }), /Physical/);
      assert.match(E.validateConfig({ vaBits: 12.5 }), /Virtual/);
    }, { edge: true });
    it('rejects a page size that is not a power of two', () => assert.match(E.validateConfig({ pageSize: 300 }), /power of two/), { edge: true });
    it('rejects page size ≥ virtual space (no page-number bits left)', () => assert.match(E.validateConfig({ vaBits: 8, pageSize: 256 }), /smaller than the virtual/), { edge: true });
    it('rejects page size larger than physical memory', () => assert.match(E.validateConfig({ vaBits: 16, paBits: 8, pageSize: 512 }), /exceed physical/), { edge: true });
    it('rejects geometries with too many page-table entries', () => assert.match(E.validateConfig({ vaBits: 32, pageSize: 16 }), /limit/), { edge: true });
    it('accepts the largest supported geometry (32-bit VA, 4 KB pages)', () => assert.equal(E.validateConfig({ vaBits: 32, paBits: 20, pageSize: 4096 }), ''), { edge: true });
    it('accepts the smallest geometry (4-bit VA/PA, 2-byte pages)', () => assert.equal(E.validateConfig({ vaBits: 4, paBits: 4, pageSize: 2 }), ''), { edge: true });
    it('rejects TLB sizes of 0 and 65', () => {
      assert.match(E.validateConfig({ tlbEntries: 0 }), /TLB size/);
      assert.match(E.validateConfig({ tlbEntries: 65 }), /TLB size/);
    }, { edge: true });
    it('rejects associativity that does not divide the TLB size', () => assert.match(E.validateConfig({ tlbEntries: 6, tlbWays: 4 }), /multiple/), { edge: true });
    it('rejects a non-power-of-two number of sets (6 entries / 2 ways = 3 sets)', () => assert.match(E.validateConfig({ tlbEntries: 6, tlbWays: 2 }), /power of two/), { edge: true });
    it('allows a non-power-of-two fully associative TLB (3 entries)', () => assert.equal(E.validateConfig({ tlbEntries: 3 }), ''));
    it('set-associative geometry: 8 entries, 2-way → 4 sets, 2 index bits, 6 tag bits', () => {
      const g = E.geometry({ tlbEntries: 8, tlbWays: 2 });
      assert.deep([g.sets, g.indexBits, g.tagBits], [4, 2, 6]);
    });
    it('splits 10 VPN bits over 3 page-table levels as [4,3,3]', () => assert.deep(E.geometry({ vaBits: 16, pageSize: 64, ptLevels: 3 }).levelBits, [4, 3, 3]));
    it('rejects more page-table levels than VPN bits', () => assert.match(E.validateConfig({ vaBits: 8, pageSize: 64, ptLevels: 3 }), /level/), { edge: true });
    it('rejects negative or non-finite timings', () => {
      assert.match(E.validateConfig({ m: -1 }), /Timing/);
      assert.match(E.validateConfig({ t: NaN }), /Timing/);
      assert.match(E.validateConfig({ faultTime: Infinity }), /Timing/);
    }, { edge: true });
    it('normalises lower-case policy names and numeric strings', () => {
      assert.equal(E.validateConfig({ tlbPolicy: 'fifo', pageSize: '64' }), '');
      assert.equal(mmu({ tlbPolicy: 'clock' }).cfg.tlbPolicy, 'CLOCK');
    });
    it('rejects unknown policies, mappings and modes', () => {
      assert.match(E.validateConfig({ tlbPolicy: 'MRU' }), /Unknown TLB/);
      assert.match(E.validateConfig({ mapping: 'zigzag' }), /mapping/);
      assert.match(E.validateConfig({ faultMode: 'panic' }), /Fault mode/);
      assert.match(E.validateConfig({ contextMode: 'none' }), /Context/);
    }, { edge: true });
    it('MMU constructor throws RangeError on an invalid configuration', () => assert.throws(() => mmu({ pageSize: 100 }), /power of two/), { edge: true });
  });

  /* ================================================================ */
  describe('Address & trace parsing', () => {
    it('parses decimal, hex, binary and octal literals', () => {
      assert.deep(['300', '0x12C', '0b100101100', '0o454', ' 0X12c '].map(s => E.parseAddress(s).value), [300, 300, 300, 300, 300]);
    });
    it('accepts digit-group underscores (0x1_2C, 1_000)', () => {
      assert.equal(E.parseAddress('0x1_2C').value, 300);
      assert.equal(E.parseAddress('1_000').value, 1000);
    });
    it('rejects negative, fractional, empty and garbage input', () => {
      for (const bad of ['-1', '12.5', '.5', '', '   ', '12abc', '1e3', '0x', '0b102', 'NaN', null]) {
        assert.equal(E.parseAddress(bad).ok, false, `input ${JSON.stringify(bad)}`);
      }
    }, { edge: true });
    it('rejects numbers beyond Number.MAX_SAFE_INTEGER', () => assert.match(E.parseAddress('99999999999999999999').error, /too large/), { edge: true });
    it('parses a mixed trace with processes, writes and comments', () => {
      const r = E.parseTrace('300, 0x12C:W # comment\nP1:12;P1:0b1:r', { processes: 2 });
      assert.ok(r.ok);
      assert.deep(r.ops, [
        { pid: 0, addr: 300, write: false }, { pid: 0, addr: 300, write: true },
        { pid: 1, addr: 12, write: false }, { pid: 1, addr: 1, write: false },
      ]);
    });
    it('reports the exact token that is out of range', () => {
      const r = E.parseTrace('1 2 70000', {});
      assert.equal(r.ok, false); assert.equal(r.index, 2); assert.match(r.error, /Token 3/);
    }, { edge: true });
    it('rejects a process id that does not exist', () => assert.match(E.parseTrace('P3:10', { processes: 2 }).error, /P0–P1/), { edge: true });
    it('rejects an empty or comment-only trace', () => {
      assert.equal(E.parseTrace('   ', {}).ok, false);
      assert.equal(E.parseTrace('# nothing here', {}).ok, false);
    }, { edge: true });
    it('rejects malformed access modes like 300:X', () => assert.equal(E.parseTrace('300:X', {}).ok, false), { edge: true });
    it(`caps traces at ${E.LIMITS.maxTraceLength.toLocaleString('en-US')} accesses`, () => {
      assert.match(E.parseTrace(new Array(E.LIMITS.maxTraceLength + 1).fill('1').join(' '), {}).error, /limited/);
    }, { edge: true });
    it('formatOp round-trips through parseTrace', () => {
      const ops = [{ pid: 0, addr: 5, write: false }, { pid: 1, addr: 7, write: true }];
      assert.deep(E.parseTrace(ops.map(E.formatOp).join(' '), { processes: 2 }).ops, ops);
    });
  });

  /* ================================================================ */
  describe('Translation arithmetic', () => {
    it('VA 300 (256-B pages): page 1, offset 44, PA 300; miss then hit', () => {
      const m = mmu({});
      const a = m.access({ addr: 300 }), b = m.access({ addr: 300 });
      assert.deep([a.vpn, a.offset, a.pfn, a.pa, a.outcome], [1, 44, 1, 300, 'MISS']);
      assert.deep([b.outcome, b.pa], ['HIT', 300]);
    });
    it('VA 0 maps to PA 0 (first byte of the first page)', () => assert.equal(mmu({}).access({ addr: 0 }).pa, 0), { edge: true });
    it('last mapped byte 4095 → page 15, offset 255, PA 4095', () => {
      const r = mmu({}).access({ addr: 4095 });
      assert.deep([r.vpn, r.offset, r.pa], [15, 255, 4095]);
    }, { edge: true });
    it('first unmapped byte 4096 → page fault, no frame, no PA', () => {
      const r = mmu({}).access({ addr: 4096 });
      assert.deep([r.outcome, r.pfn, r.pa, r.serviced], ['FAULT', null, null, false]);
    }, { edge: true });
    it('maximum address 65535 is accepted (page 255, offset 255)', () => {
      const r = mmu({}).access({ addr: 65535 });
      assert.deep([r.vpn, r.offset, r.outcome], [255, 255, 'FAULT']);
    }, { edge: true });
    it('out-of-range and non-integer addresses return an error and change nothing', () => {
      const m = mmu({});
      for (const addr of [65536, -1, 1.5, NaN, Infinity, '300']) assert.ok(m.access({ addr }).error, `addr ${addr}`);
      assert.equal(m.stats.accesses, 0); assert.equal(m.records.length, 0);
    }, { edge: true });
    it('rejects an access from a process that does not exist', () => assert.ok(mmu({}).access({ pid: 1, addr: 0 }).error), { edge: true });
    it('sparse mapping: page 2 lives in frame 1, page 1 faults', () => {
      const m = mmu(Object.assign({ mapping: 'sparse' }, SMALL));
      assert.equal(m.access({ addr: 2 * 16 + 5 }).pa, 16 + 5);
      assert.equal(m.access({ addr: 16 }).outcome, 'FAULT');
    });
    it('property: offset preserved and PA < 2^paBits for 2,000 random addresses', () => {
      const rng = E.makeRng(7);
      const cfg = { vaBits: 20, paBits: 16, pageSize: 1024, mapping: 'random', faultMode: 'demand' };
      const m = mmu(cfg);
      for (let i = 0; i < 2000; i++) {
        const addr = rng.int(2 ** 20), r = m.access({ addr });
        assert.equal(r.vpn * 1024 + r.offset, addr);
        assert.equal(r.pa % 1024, r.offset);
        assert.ok(r.pa >= 0 && r.pa < 2 ** 16);
      }
    });
    it('32-bit virtual address 0xFFFFFFFF splits correctly (no 32-bit overflow)', () => {
      const r = mmu({ vaBits: 32, paBits: 20, pageSize: 4096 }).access({ addr: 0xFFFFFFFF });
      assert.deep([r.vpn, r.offset], [0xFFFFF, 0xFFF]);
    }, { edge: true });
    it('multi-level indices: VPN 0b1011_011_101 → L1=11, L2=3, L3=5', () => {
      const m = mmu({ vaBits: 16, pageSize: 64, ptLevels: 3 });
      assert.deep(m.decompose(0b1011011101 * 64).levels, [11, 3, 5]);
    });
    it('set-associative decomposition: tag and index rebuild the VPN', () => {
      const m = mmu({ tlbEntries: 8, tlbWays: 2 });
      const d = m.decompose(0xBEEF);
      assert.equal(d.tag * 4 + d.set, d.vpn);
    });
  });

  /* ================================================================ */
  describe('TLB replacement policies', () => {
    const seq = (policy, pages, extra = {}) => run(Object.assign({ tlbEntries: 3, tlbPolicy: policy }, SMALL, extra), pageAddrs(pages));
    it('FIFO evicts the oldest insertion even if it was just used', () => {
      const r = seq('FIFO', [1, 2, 3, 1, 4, 1]);
      assert.equal(outcomes(r), 'MMMHMM');
      assert.equal(r.records[4].tlbEvicted.vpn, 1);
    });
    it('LRU evicts the least recently used entry', () => {
      const r = seq('LRU', [1, 2, 3, 1, 4, 1]);
      assert.equal(outcomes(r), 'MMMHMH');
      assert.equal(r.records[4].tlbEvicted.vpn, 2);
    });
    it('LFU evicts the least frequently used entry', () => {
      const r = seq('LFU', [1, 1, 2, 2, 3, 4, 3]);
      assert.equal(r.records[5].tlbEvicted.vpn, 3);
      assert.equal(r.records[6].outcome, 'MISS');
    });
    it("CLOCK on Belady's string with 3 entries: 9 misses, hits at accesses 8, 9, 12", () => {
      const r = seq('CLOCK', BELADY);
      assert.equal(r.stats.misses, 9);
      assert.deep(r.records.map((x, i) => (x.hit ? i + 1 : 0)).filter(Boolean), [8, 9, 12]);
    });
    it('CLOCK second chance: a re-referenced entry survives where FIFO evicts it', () => {
      // 1 2 3 4 → all R bits cleared, 1 evicted; 2 is re-referenced; 5 must skip 2 and evict 3
      assert.equal(seq('CLOCK', [1, 2, 3, 4, 2, 5]).records[5].tlbEvicted.vpn, 3);
      assert.equal(seq('FIFO', [1, 2, 3, 4, 2, 5]).records[5].tlbEvicted.vpn, 2);
    });
    it("Belady's anomaly: FIFO gets 9 misses with 3 entries but 10 with 4", () => {
      assert.equal(seq('FIFO', BELADY).stats.misses, 9);
      assert.equal(seq('FIFO', BELADY, { tlbEntries: 4 }).stats.misses, 10);
    });
    it('compare() flags the FIFO anomaly and none for LRU/OPT', () => {
      const c = E.compare(SMALL, pageAddrs(BELADY), ['FIFO', 'LRU', 'OPT'], [3, 4]);
      assert.deep(c.anomalies.map(a => a.policy), ['FIFO']);
    });
    it('compare() isolates the TLB: a 4-frame demand-paging machine still shows the FIFO anomaly', () => {
      const tinyMem = { vaBits: 8, paBits: 6, pageSize: 16, mapping: 'empty', faultMode: 'demand' };
      const c = E.compare(tinyMem, pageAddrs(BELADY), ['FIFO'], [3, 4]);
      assert.deep(c.rows[0].points.map(p => p.misses), [9, 10]);
      assert.equal(E.isolateTlb(tinyMem).paBits, 8);
    });
    it("LRU on Belady's string: 10 misses (3 entries), 8 misses (4 entries)", () => {
      assert.equal(seq('LRU', BELADY).stats.misses, 10);
      assert.equal(seq('LRU', BELADY, { tlbEntries: 4 }).stats.misses, 8);
    });
    it("OPT on Belady's string: 7 misses (3 entries), 6 misses (4 entries)", () => {
      assert.equal(seq('OPT', BELADY).stats.misses, 7);
      assert.equal(seq('OPT', BELADY, { tlbEntries: 4 }).stats.misses, 6);
    });
    it('OPT never misses more than FIFO/LRU/LFU/CLOCK/RANDOM (50 random traces)', () => {
      const rng = E.makeRng(99);
      for (let t = 0; t < 50; t++) {
        const ops = pageAddrs(Array.from({ length: 40 }, () => rng.int(8)));
        const opt = run(Object.assign({ tlbEntries: 3, tlbPolicy: 'OPT' }, SMALL), ops).stats.misses;
        for (const p of ['FIFO', 'LRU', 'LFU', 'CLOCK', 'RANDOM']) {
          assert.ok(opt <= run(Object.assign({ tlbEntries: 3, tlbPolicy: p }, SMALL), ops).stats.misses, `${p} beat OPT on trace ${t}`);
        }
      }
    });
    it('LRU is a stack algorithm: misses never increase with TLB size', () => {
      const rng = E.makeRng(3);
      const ops = pageAddrs(Array.from({ length: 200 }, () => rng.int(16)));
      const c = E.compare(SMALL, ops, ['LRU'], [1, 2, 4, 8, 16]);
      assert.equal(c.anomalies.length, 0);
    });
    it('RANDOM replacement is reproducible for a given seed', () => {
      const ops = pageAddrs(Array.from({ length: 60 }, (_, i) => (i * 7) % 11));
      const a = run(Object.assign({ tlbPolicy: 'RANDOM', seed: 5 }, SMALL), ops);
      const b = run(Object.assign({ tlbPolicy: 'RANDOM', seed: 5 }, SMALL), ops);
      assert.equal(outcomes(a), outcomes(b));
    });
    it('OPT through access() without future knowledge is refused', () => assert.match(mmu({ tlbPolicy: 'OPT' }).access({ addr: 0 }).error, /OPT/), { edge: true });
    it('1-entry TLB: alternating pages always miss', () => assert.equal(seq('LRU', [1, 2, 1, 2, 1, 2], { tlbEntries: 1 }).stats.hits, 0), { edge: true });
    it('cyclic loop over N+1 pages defeats LRU and FIFO (0 hits) but not OPT', () => {
      const ops = pageAddrs(Array.from({ length: 30 }, (_, i) => i % 4));
      assert.equal(seq('LRU', ops.map(o => o.addr / 16)).stats.hits, 0);
      assert.equal(seq('FIFO', ops.map(o => o.addr / 16)).stats.hits, 0);
      assert.ok(seq('OPT', ops.map(o => o.addr / 16)).stats.hits > 0);
    });
    it('direct-mapped TLB: pages 0 and 4 conflict in set 0 while page 1 stays cached', () => {
      const r = run(Object.assign({ tlbEntries: 4, tlbWays: 1 }, SMALL), pageAddrs([0, 1, 4, 0, 1]));
      assert.equal(outcomes(r), 'MMMMH');
      assert.equal(r.records[2].tlbEvicted.vpn, 0);
    });
    it('2-way set-associative: each entry lands in set VPN mod sets', () => {
      const r = run(Object.assign({ tlbEntries: 8, tlbWays: 2 }, SMALL), pageAddrs([0, 1, 2, 3, 5, 9, 13]));
      for (const e of r.mmu.tlbEntries()) assert.equal(e.set, e.vpn % 4);
      assert.equal(r.mmu.tlbEntries().filter(e => e.set === 1).length, 2);
    });
    it('TLB never exceeds capacity and holds no duplicates (invariants, 500 accesses)', () => {
      const ops = E.generate('uniform', SMALL, 500, 11);
      const r = run(Object.assign({ tlbEntries: 4, tlbWays: 2, faultMode: 'demand' }, SMALL), ops);
      assert.deep(r.mmu.checkInvariants(), []);
      assert.ok(r.mmu.tlbEntries().length <= 4);
    });
  });

  /* ================================================================ */
  describe('Page faults & demand paging', () => {
    const tiny = { vaBits: 8, paBits: 5, pageSize: 16, mapping: 'empty', faultMode: 'demand', tlbEntries: 4 }; // 2 frames
    it('report mode: fault produces no PA, no TLB fill, no memory access', () => {
      const m = mmu({ mapping: 'empty' });
      const r = m.access({ addr: 10 });
      assert.deep([r.outcome, r.pa, m.tlbEntries().length, m.stats.memAccesses, m.stats.pageFaults], ['FAULT', null, 0, 0, 1]);
    });
    it('demand mode: first touch faults into frame 0, repeat is a TLB hit', () => {
      const m = mmu(tiny);
      const a = m.access({ addr: 0x35 }), b = m.access({ addr: 0x36 });
      assert.deep([a.outcome, a.serviced, a.pfn, a.pa], ['FAULT', true, 0, 5]);
      assert.equal(b.outcome, 'HIT');
    });
    it('frames full → FIFO evicts the oldest page, invalidates its PTE and shoots down its TLB entry', () => {
      const m = mmu(tiny);
      [0, 16, 32].forEach(addr => m.access({ addr }));
      const r = m.records[2];
      assert.deep([r.fault.evicted.vpn, r.fault.evicted.shotDown, r.pfn], [0, true, 0]);
      assert.equal(m.pte(0, 0).present, false);
      assert.equal(m.tlbFind(0, 0).entry, null);
      assert.equal(m.access({ addr: 0 }).outcome, 'FAULT');
    });
    it('frame LRU keeps the recently used page that FIFO would evict', () => {
      const ops = [0, 16, 0, 32].map(addr => ({ addr }));
      assert.equal(run(Object.assign({}, tiny, { framePolicy: 'FIFO' }), ops).records[3].fault.evicted.vpn, 0);
      assert.equal(run(Object.assign({}, tiny, { framePolicy: 'LRU' }), ops).records[3].fault.evicted.vpn, 1);
    });
    it('frame CLOCK gives a referenced page a second chance (FIFO does not)', () => {
      const four = Object.assign({}, tiny, { paBits: 6 }); // 4 frames
      const ops = [0, 1, 2, 3, 4, 1, 5].map(p => ({ addr: p * 16 }));
      const clock = run(Object.assign({}, four, { framePolicy: 'CLOCK' }), ops);
      const fifo = run(Object.assign({}, four, { framePolicy: 'FIFO' }), ops);
      assert.equal(clock.records[6].fault.evicted.vpn, 2);
      assert.equal(fifo.records[6].fault.evicted.vpn, 1);
      assert.deep(clock.mmu.checkInvariants(), []);
    });
    it('evicting a dirty page counts one write-back; clean pages none', () => {
      const r = run(tiny, [{ addr: 0, write: true }, { addr: 16 }, { addr: 32 }, { addr: 48 }]);
      assert.equal(r.stats.writebacks, 1);
      assert.deep(r.records.slice(2).map(x => x.fault.evicted.dirty), [true, false]);
    });
    it('a reloaded page starts clean (dirty bit cleared on page-in)', () => {
      const r = run(tiny, [{ addr: 0, write: true }, { addr: 16 }, { addr: 32 }, { addr: 0 }]);
      assert.equal(r.mmu.pte(0, 0).dirty, false);
    }, { edge: true });
    it('single-frame memory: every new page evicts the previous one', () => {
      const r = run({ vaBits: 8, paBits: 4, pageSize: 16, mapping: 'empty', faultMode: 'demand' }, [0, 16, 0, 16].map(addr => ({ addr })));
      assert.equal(r.stats.pageEvictions, 3); assert.equal(r.stats.hits, 0);
    }, { edge: true });
    it('fault cost = t + k·m + S + m', () => {
      const r = mmu(Object.assign({}, tiny, { t: 1, m: 10, faultTime: 1000, ptLevels: 2 })).access({ addr: 0 });
      assert.equal(r.cost, 1 + 20 + 1000 + 10);
    });
    it('invariants hold over 3,000 random multi-process demand-paging accesses', () => {
      const cfg = { vaBits: 10, paBits: 7, pageSize: 16, processes: 3, mapping: 'random', faultMode: 'demand', framePolicy: 'CLOCK', tlbEntries: 8, tlbWays: 2, tlbPolicy: 'CLOCK' };
      const rng = E.makeRng(42);
      const ops = Array.from({ length: 3000 }, () => ({ pid: rng.int(3), addr: rng.int(1024), write: rng() < 0.3 }));
      const r = run(cfg, ops);
      assert.deep(r.mmu.checkInvariants(), []);
      assert.equal(r.stats.pageFaults, r.stats.faultsServiced);
    });
  });

  /* ================================================================ */
  describe('Protection & dirty bits', () => {
    it('write to a read-only page raises PROT with no PA and leaves it clean', () => {
      const m = mmu({});
      m.setWritable(0, 1, false);
      const r = m.access({ addr: 300, write: true });
      assert.deep([r.outcome, r.pa, m.pte(0, 1).dirty], ['PROT', null, false]);
    });
    it('reads from a read-only page still succeed', () => {
      const m = mmu({});
      m.setWritable(0, 1, false);
      assert.equal(m.access({ addr: 300 }).pa, 300);
    });
    it('a protection fault is also raised on a TLB hit (cached permission bits)', () => {
      const m = mmu({});
      m.setWritable(0, 1, false);
      m.access({ addr: 300 });
      const r = m.access({ addr: 300, write: true });
      assert.deep([r.hit, r.outcome], [true, 'PROT']);
    });
    it('changing permissions shoots down the stale TLB entry', () => {
      const m = mmu({});
      m.access({ addr: 300 });
      assert.equal(m.setWritable(0, 1, false), true);
      assert.equal(m.access({ addr: 300 }).outcome, 'MISS');
    });
    it('a write sets the dirty bit in both the PTE and the TLB entry', () => {
      const m = mmu({});
      m.access({ addr: 300, write: true });
      assert.equal(m.pte(0, 1).dirty, true);
      assert.equal(m.tlbFind(0, 1).entry.dirty, true);
    });
  });

  /* ================================================================ */
  describe('Processes, ASIDs & context switches', () => {
    const two = { processes: 2 };
    it('sequential mapping isolates processes: P0 and P1 page 0 get different frames', () => {
      const m = mmu(two);
      assert.ok(m.access({ pid: 0, addr: 5 }).pa !== m.access({ pid: 1, addr: 5 }).pa);
    });
    it('ASID mode: entries survive a context switch (switch back → HIT)', () => {
      const r = run(two, [{ pid: 0, addr: 5 }, { pid: 1, addr: 5 }, { pid: 0, addr: 5 }]);
      assert.equal(outcomes(r), 'MMH');
      assert.equal(r.stats.contextSwitches, 2); assert.equal(r.stats.flushes, 0);
    });
    it('flush mode: every switch empties the TLB (switch back → MISS)', () => {
      const r = run(Object.assign({ contextMode: 'flush' }, two), [{ pid: 0, addr: 5 }, { pid: 1, addr: 5 }, { pid: 0, addr: 5 }]);
      assert.equal(outcomes(r), 'MMM');
      assert.deep([r.stats.flushes, r.stats.flushedEntries], [2, 2]);
    });
    it('same VPN in two processes never hits the other process’s entry', () => {
      const m = mmu(two);
      m.access({ pid: 0, addr: 5 });
      assert.equal(m.access({ pid: 1, addr: 5 }).hit, false);
      assert.equal(m.tlbEntries().length, 2);
    });
    it('no context switch is counted when the same process keeps running', () => assert.equal(run(two, [{ pid: 1, addr: 1 }, { pid: 1, addr: 2 }]).stats.contextSwitches, 1), { edge: true });
  });

  /* ================================================================ */
  describe('Statistics & effective access time', () => {
    it('textbook EAT: h=0.8, t=10, m=100 → 130 ns', () => assert.close(E.eat({ h: 0.8, t: 10, m: 100 }).total, 130));
    it('two-level paging with faults: h=.95, t=20, m=80, k=2, p=.1, S=5000 → 608 ns', () => {
      const r = E.eat({ h: 0.95, t: 20, m: 80, levels: 2, p: 0.1, S: 5000 });
      assert.close(r.base, 108); assert.close(r.total, 608);
    });
    it('EAT boundaries: h=1 → t+m, h=0 → t+2m', () => {
      assert.close(E.eat({ h: 1, t: 10, m: 100 }).total, 110);
      assert.close(E.eat({ h: 0, t: 10, m: 100 }).total, 210);
    }, { edge: true });
    it('EAT rejects h outside [0,1], negative times and non-numbers', () => {
      assert.ok(E.eat({ h: 1.2, t: 1, m: 1 }).error);
      assert.ok(E.eat({ h: 0.5, t: -1, m: 1 }).error);
      assert.ok(E.eat({ h: 0.5, t: 1, m: NaN }).error);
    }, { edge: true });
    it('measured EAT of a run equals the analytic formula at the observed hit ratio', () => {
      const r = run({}, E.generate('locality', {}, 200, 1).map(o => ({ addr: o.addr % 4096 })));
      const h = r.metrics.hitRatio;
      assert.close(r.metrics.measuredEAT, E.eat({ h, t: 10, m: 100 }).total, 1e-9);
    });
    it('all ratios are 0 (not NaN) before any access', () => {
      const met = mmu({}).metrics();
      assert.deep([met.hitRatio, met.missRatio, met.measuredEAT], [0, 0, 0]);
    }, { edge: true });
    it('hits + misses = accesses and walks = misses on a mixed run', () => {
      const r = run({}, E.generate('uniform', {}, 300, 9));
      assert.equal(r.stats.hits + r.stats.misses, r.stats.accesses);
      assert.equal(r.stats.walks, r.stats.misses);
      assert.deep(r.mmu.checkInvariants(), []);
    });
    it('k-level walk reads k page-table entries per miss', () => assert.equal(run({ ptLevels: 3, pageSize: 64 }, [{ addr: 0 }, { addr: 64 }]).stats.walkReads, 6));
  });

  /* ================================================================ */
  describe('Workload generators & utilities', () => {
    it('every generator yields in-range, parseable accesses (default and tiny geometry)', () => {
      for (const cfg of [{}, { vaBits: 4, paBits: 4, pageSize: 2, processes: 2 }]) {
        const g = E.geometry(cfg);
        for (const kind of Object.keys(E.WORKLOADS)) {
          const ops = E.generate(kind, cfg, 40, 1);
          assert.ok(ops.length > 0, kind);
          for (const o of ops) assert.ok(o.addr >= 0 && o.addr <= g.vaMax && o.pid < (cfg.processes || 1), `${kind} ${o.addr}`);
          run(cfg, ops); // must not throw
        }
      }
    }, { edge: true });
    it('generators are deterministic for a given seed', () => assert.deep(E.generate('uniform', {}, 20, 5), E.generate('uniform', {}, 20, 5)));
    it('nextUseIndex points at the next access to the same page', () => assert.deep(E.nextUseIndex(SMALL, pageAddrs([1, 2, 1, 3, 2])), [2, 4, Infinity, Infinity, Infinity]));
    it('binary/hex helpers pad to the field width', () => {
      assert.equal(E.toBin(5, 8), '00000101');
      assert.equal(E.toHex(300, 16), '0x012C');
    });
    it('simulate() throws with the failing access index on bad input', () => assert.throws(() => E.simulate({}, [{ addr: 1 }, { addr: 1e9 }]), /Access 2/), { edge: true });
    it('random initial mapping is reproducible and internally consistent', () => {
      const a = mmu({ mapping: 'random', processes: 2, seed: 8 }), b = mmu({ mapping: 'random', processes: 2, seed: 8 });
      assert.deep(Array.from(a.pt[1].pfn), Array.from(b.pt[1].pfn));
      assert.deep(a.checkInvariants(), []);
    });
  });

  return { tests, AssertionError };
});
