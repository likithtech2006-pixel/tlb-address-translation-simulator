# Operating Systems Mini Project Report

## TLB/Scope — TLB Address Translation Simulator

**Module:** Module 5 — Memory Management
**Project:** #45, “TLB Address Translation Simulator: simulate virtual-to-physical address translation using TLB”
**Implementation:** HTML, CSS, JavaScript (no frameworks, no build step, no backend)
**Verification:** 96 engine tests (38 edge cases) passing in Node 22 and in the browser, plus 29 page-level smoke tests in headless Chrome
**Version:** 2.0, a multi-page application. Version 1 (single page) is preserved in `versions/v1`.

> Add your name, register number, department, guide and academic year as your college requires.

---

## 1. Problem statement

A CPU issues **virtual** addresses, but memory understands only **physical** addresses. With paging, the virtual address is split into a virtual page number (VPN) and an offset, and a page table maps each VPN to a physical frame (PFN). Consulting the page table on every reference would multiply memory traffic, especially with multi-level tables. The **Translation Lookaside Buffer (TLB)** is a small associative cache of recent translations that removes most of that cost.

The goal is to make this process **observable and measurable**. A student should be able to see every bit of the split, every TLB decision (hit, miss, fill, eviction), every page-table walk and fault, and the resulting physical address. They should also be able to *compare* design choices (replacement policy, TLB size, associativity, ASIDs, page-table depth) on the same workload.

## 2. Objectives

1. Show the split of a virtual address into VPN, TLB tag and set index, page-table level indices, and offset, at bit level.
2. Simulate the TLB hit and miss paths, the page-table walk, insertion, and replacement under FIFO, LRU, LFU, CLOCK and RANDOM, with OPT as a benchmark.
3. Handle page faults in two modes, *report only* and *demand paging* (frame replacement, dirty write-back, TLB shootdown), and handle write-protection faults.
4. Model multiple processes with ASID-tagged entries versus flush-on-switch.
5. Measure hit ratio, faults, evictions and **effective access time**, both analytically and measured from the run.
6. Provide history with time travel, export, sharing and a verifiable automated test suite.

## 3. Key concepts

| Concept | Rule used in the simulator |
|---|---|
| Address split | `VPN = ⌊VA / S⌋`, `offset = VA mod S`, `offset bits = log₂ S` |
| Physical address | `PA = PFN × S + offset` (the offset is unchanged because page size = frame size) |
| Set-associative TLB | `sets = entries ÷ ways`, `set = VPN mod sets`, `tag = ⌊VPN / sets⌋` |
| k-level walk | VPN bits divided among k levels (top level takes the remainder); a miss reads k PTEs |
| TLB hit | (ASID, VPN) found → PFN in time `t` |
| TLB miss | Walk the table: `t + k·m`; if the PTE is present, fill the TLB (evicting by policy) |
| Page fault | PTE present bit = 0. *Report mode:* no frame and no PA are produced. *Demand mode:* free frame or victim (FIFO/LRU/CLOCK), write back if dirty, shoot down the victim’s TLB entry, load (`+S`) |
| Protection fault | Write to a page whose cached W bit = 0; no memory access |
| Context switch | ASID mode keeps tagged entries; flush mode empties the TLB |
| EAT | `EAT = h(t + m) + (1 − h)(t + (k+1)m) + p·S` |

### Replacement policies

| Policy | Victim | Note |
|---|---|---|
| FIFO | Earliest insertion | Can show **Belady’s anomaly** |
| LRU | Oldest last use | Stack algorithm; never anomalous |
| LFU | Fewest uses (ties → LRU) | Good for skewed workloads, slow to adapt |
| CLOCK | First entry with R = 0, clearing R bits as the hand passes | Cheap LRU approximation (second chance) |
| RANDOM | Seeded pseudo-random way | Reproducible because of the seeded PRNG |
| OPT | Farthest next use | Needs the future; lower bound, available in the Policy lab |

## 4. System design

```
          ┌──────────────── js/app.js (UI) ────────────────┐
 user ──► │ probe · trace · scenarios · deck · keyboard    │
          │            │  ops appended to a TIMELINE        │
          │            ▼                                    │
          │  replay ops[0..t) ──► engine state at time t    │──► renderers: bits, datapath,
          └────────────┬───────────────────────────────────┘    timeline, TLB, page table,
                       │ pure function calls                     frames, KPIs, charts, log
          ┌────────────▼──────── js/engine.js ─────────────┐
          │ MMU: decompose · tlbFind · chooseTlbVictim      │
          │      page walk · servicePageFault · protection  │
          │      stats · metrics · checkInvariants          │
          │ simulate · compare · generate · eat · parsers   │
          └────────────▲───────────────────────────────────┘
                       │ same code
          tests/suite.js (96 tests) ── Node runner / in-app self-test
```

**Design decision: an event-sourced timeline.** The UI never edits translation state directly. Each user action (access, permission change, INVLPG, flush) is appended as an *operation*. Because the engine is deterministic (even RANDOM uses a seeded PRNG), the state at any time `t` is just the replay of `ops[0..t)`. This gives four features from one mechanism:

- **time travel:** scrub, step back or step forward;
- **branching:** a new action after rewinding discards the old future;
- **what-if:** change the configuration and the whole timeline replays under it;
- **sharing:** configuration plus operations, encoded in the URL fragment.

**Data structures.** The page tables are typed arrays (`Int32Array` PFN plus a `Uint8Array` flag byte holding P, W, D and R bits), which keeps a 32-bit address space with 4 KiB pages (2²⁰ PTEs) fast. The TLB is an array of sets, each an array of ways. Each frame records its owner (pid, vpn), which works as an inverted page table for O(1) victim invalidation.

### 4.1 Version 2: multi-page architecture

```
                 ┌──────────────── shell.js (every page) ─────────────────┐
                 │ tabs · context bar · journey · palette · transitions   │
                 └───────────────┬────────────────────────────────────────┘
 index ─► machine ─► translate ─► timeline ─► structures ─► analytics ─► lab ─► learn ─► verify ─► report
   ▲         │  scenario hand-offs │ ?addr= / #pte-N / ?t= deep links │                        │
   └─────────┴─────────── shared session in localStorage (cfg + ops + cursor) ─────────────────┘
                                   │ replay through js/engine.js on every page
```

Every page loads the same engine and session code (`app.js`). On load it restores the session, replays it, and renders only the panels that page contains. Because the engine is deterministic, every page shows the same machine at the same moment. The shell provides the navigation, the hand-offs between pages and the page-to-page transitions: native cross-document View Transitions, with a JS fallback.

## 5. Algorithm (one access)

```
ACCESS(pid, VA, write):
  reject if VA ∉ [0, 2^vaBits − 1] or pid invalid        (state untouched)
  if pid ≠ current: count switch; if flush-mode: flush TLB
  clock++ ; VPN, offset, set, tag, level indices ← split(VA)
  cost ← t
  e ← TLB[set].find(asid = pid, vpn = VPN)
  if e:                                    # HIT
      update lastUse, uses, R bit ; PFN ← e.pfn ; W ← e.writable
  else:                                    # MISS → walk
      cost += k·m ; walks++
      if not PTE.present:
          pageFaults++
          if mode = report: record FAULT (no PFN, no PA) ; return
          frame ← free frame or victim(FIFO|LRU|CLOCK)
          if victim: invalidate victim PTE; write back if dirty; shoot down its TLB entry
          map VPN → frame ; cost += S
      PFN ← PTE.pfn
      way ← empty way or victim(policy) in TLB[set]; insert (pid, VPN, PFN, W, D)
  if write and not W: record PROT ; return  # no memory access
  if write: set dirty in PTE and TLB entry
  cost += m ; PA ← PFN·S + offset ; record HIT | MISS | FAULT(serviced)
```

## 6. User interface

| Area | Purpose |
|---|---|
| Masthead and spec strip | Datasheet-style readout of the current machine; DEC/HEX, Share, Self-test, Help, Theme |
| Control deck | Geometry, TLB, paging and faults, processes, timing; derived geometry; ten one-click **scenarios** |
| A · Probe | Address in any radix with a live preview and a hit/miss/fault **prediction** before you translate |
| B · Bit surgery | Bit-level VA → PA rewrite |
| C · MMU datapath | Stage lighting and manual **Step through** narration |
| D · Access timeline | Logic-analyzer lanes, scrubber, transport controls, playback speeds |
| E · Workload | Trace editor, eight generators (locality, loop, strided, Belady, multi-process…), import, queue & play |
| F–H · Structures | TLB sets × ways; page-table cell map with inspector; physical frames by process |
| I–J · Telemetry | KPIs, hit-ratio chart, outcome mix, EAT calculator (model vs measured vs no TLB) |
| K · Policy lab | Six policies × seven sizes, chart, table, anomaly detection |
| L · Event log | Filterable; click a row to jump there; CSV / JSON / print |
| M · Self-test | Runs the automated suite in the browser |
| N · Field notes, viva drill | Concept cards and 14 viva questions |

Design: light theme as a printed hardware datasheet (warm paper, ink rules, boxed figure letters); dark theme as a logic analyzer (phosphor signals). Signal colours are consistent everywhere: green = hit, amber = miss, red = fault, violet = protection, blue = VPN / context. The layout is responsive down to 375 px with no horizontal page scroll. It respects `prefers-reduced-motion` and has keyboard shortcuts, ARIA live regions and print styles.

## 7. Testing

### 7.1 Method

- **Automated unit and property tests.** `tests/suite.js` contains 96 cases, run by `npm test` (Node 22) and by the in-app Self-test (browser). Expected values come from **hand derivation or textbook results**, not from the code’s own output.
- **Invariant checking.** `checkInvariants()` asserts that hits + misses = accesses, walks = misses, memory accesses = accesses − unserviced faults − protection faults, reads + writes = accesses, the TLB is within capacity with no duplicates, every entry is in its correct set and agrees with a present PTE, and frame ↔ PTE ownership is consistent. Randomised runs of up to 3,000 multi-process demand-paging accesses must keep every invariant.
- **Mutation testing.** To confirm the tests catch real bugs, faults were planted in the engine on purpose (FIFO using the LRU key, CLOCK ignoring R bits for both TLB and frames, the walk ignoring levels, write-backs not counted, no TLB shootdown, ASID ignored). Each was caught by at least one test. Two CLOCK tests were added after an early run showed that Belady’s string alone cannot tell CLOCK from FIFO.
- **Page-level smoke tests (v2).** `tests/pages.js` loads all ten pages in headless Chrome from `file://`. It checks that there are no script errors, that the shell and panels are present, that empty-state guidance appears, that a scenario loaded on one page appears on another, and that every deep link resolves: 29/29 pass.
- **Browser verification.** The UI was driven in Chromium at 1440 × 900 and 375 × 812, in both themes. All ten scenarios ran, as did invalid inputs, step-through, rewind and branch, what-if replay, an invalid configuration, trace errors, DEC/HEX, playback, a share-link round trip and the policy lab. There were no console errors and no horizontal overflow on mobile.

### 7.2 Results summary (full list in `TEST_RESULTS.md`)

| Group | Passed |
|---|---|
| Configuration & geometry | 20 / 20 |
| Address & trace parsing | 11 / 11 |
| Translation arithmetic | 12 / 12 |
| TLB replacement policies | 19 / 19 |
| Page faults & demand paging | 10 / 10 |
| Protection & dirty bits | 5 / 5 |
| Processes, ASIDs & context switches | 5 / 5 |
| Statistics & effective access time | 8 / 8 |
| Workload generators & utilities | 6 / 6 |
| **Total** | **96 / 96 (38 edge cases)** |

### 7.3 Key test cases

| # | Input / setup | Expected | Actual |
|---|---|---|---|
| 1 | Default (16-bit VA, 256 B pages); VA 300 twice | VPN 1, offset 44, PA 300; MISS then HIT | Pass |
| 2 | VA 4095 / 4096 (last mapped byte / first unmapped byte) | PA 4095 / FAULT with no frame and no PA | Pass |
| 3 | VA 65535, 65536, −1, 1.5, NaN, `"300"` | Max accepted; the rest rejected with state untouched | Pass |
| 4 | `0x12C`, `0b100101100`, `0o454`, `0x1_2C` | All equal 300 | Pass |
| 5 | `12.5`, `1e3`, `0x`, `12abc`, empty, 20-digit number | Rejected with a specific message | Pass |
| 6 | Trace `1 2 70000` | Error names token 3 | Pass |
| 7 | FIFO, 3 entries, pages 1 2 3 1 4 1 | Evicts page 1; outcomes MMMHMM | Pass |
| 8 | LRU, same trace | Evicts page 2; outcomes MMMHMH | Pass |
| 9 | Belady string 1 2 3 4 1 2 5 1 2 3 4 5, FIFO 3 vs 4 entries | 9 vs 10 misses (anomaly) | Pass |
| 10 | Same string, LRU 3 / 4 and OPT 3 / 4 | 10 / 8 and 7 / 6 misses | Pass |
| 11 | CLOCK, 3 entries, Belady string | 9 misses, hits at accesses 8, 9, 12 | Pass |
| 12 | CLOCK vs FIFO on 1 2 3 4 2 5 | CLOCK evicts 3 (second chance for 2); FIFO evicts 2 | Pass |
| 13 | OPT vs every policy, 50 random traces | OPT never has more misses | Pass |
| 14 | Direct-mapped, 4 entries, pages 0 1 4 0 1 | 0 and 4 conflict in set 0: MMMMH | Pass |
| 15 | Demand paging, 2 frames, pages 0 1 2 | Page 0 evicted, PTE invalid, TLB entry shot down | Pass |
| 16 | Dirty page evicted | Exactly one write-back | Pass |
| 17 | Write to read-only page (also on a TLB hit) | PROT, no PA, page stays clean | Pass |
| 18 | Permission change on a cached page | Stale TLB entry shot down; next access misses | Pass |
| 19 | 2 processes, ASID mode: P0, P1, P0 on the same VPN | MMH, 2 switches, 0 flushes | Pass |
| 20 | Same with flush mode | MMM, 2 flushes | Pass |
| 21 | EAT: h = 0.8, t = 10, m = 100 | 130 ns | Pass |
| 22 | EAT: h = 0.95, t = 20, m = 80, k = 2, p = 0.1, S = 5000 | 108 ns base, 608 ns total | Pass |
| 23 | Measured EAT of a fault-free run | Equals the formula at the observed h | Pass |
| 24 | 32-bit VA, address 0xFFFFFFFF | VPN 0xFFFFF, offset 0xFFF (no 32-bit overflow) | Pass |
| 25 | 3,000 random multi-process demand-paging accesses | All invariants hold | Pass |

## 8. Sample calculations

**Default machine, VA 300:** page size 256 → offset bits 8, VPN = ⌊300/256⌋ = 1, offset = 44. Sequential mapping puts page 1 in frame 1, so PA = 1 × 256 + 44 = **300**. The first access is a miss costing t + m + m = 10 + 100 + 100 = 210 ns. The repeat is a hit costing t + m = 110 ns.

**3-level walk scenario:** 32-bit VA, 4 KiB pages → 20 VPN bits split [8, 6, 6]. VA 0x7FFFF7F0 → VPN 0x7FFFF = 524287, offset 0x7F0 = 2032, level indices L1 = 127, L2 = 63, L3 = 63. A miss costs t + 3m + m = 410 ns before any fault service time.

## 9. Advantages

- Bit-level, stage-level and time-level views of the same translation.
- An event-sourced timeline gives rewind, branching, what-if replay and shareable links.
- Covers TLB organisation (fully, set and direct), six policies, multi-level walks, demand paging, protection and ASIDs.
- Quantitative: measured versus modelled EAT, plus a policy lab with automatic Belady-anomaly detection.
- Verified by 96 automated tests that run in Node and in the browser.
- Runs anywhere from a single `index.html`; nothing is uploaded.

## 10. Limitations

- A teaching model, not a cycle-accurate MMU. There is no split I/D TLB, no huge pages, no hardware page-table caches (PWCs) and no multi-core shootdown IPIs.
- The page-table walk is costed per level but the intermediate table pages are not individually allocated.
- The page-table and frame views show 1,024 cells per window (pager provided); the model itself is not truncated.
- OPT is available only in the lab because it needs the future trace.

## 11. Future enhancements

- Huge pages (2 MiB) with a separate large-page TLB.
- Two-level TLB hierarchy (L1 dTLB plus shared L2 STLB).
- Working-set and page-fault-frequency frame allocation.
- Recording real address traces from a small instrumented program.

## 12. Conclusion

TLB/Scope meets the project requirement of simulating virtual-to-physical translation with a TLB, and goes further. Every translation is shown at bit, stage and timeline level. Hardware and OS design choices can be swapped and compared on the same run, and correctness is backed by an automated suite checked against textbook results.

## 13. Viva questions (short answers)

1. **TLB?** A small associative cache of PTEs keyed by (ASID, VPN).
2. **Is a miss a fault?** No. A miss is answered by the page table; a fault means the PTE is not present.
3. **Why a power-of-two page size?** So the VPN/offset split is just wiring.
4. **Why is the offset unchanged?** Page size = frame size.
5. **Set index?** The low log₂(sets) VPN bits; the remaining bits are the tag.
6. **FIFO vs LRU vs CLOCK?** Oldest insertion vs oldest use vs reference-bit approximation of LRU.
7. **Belady’s anomaly?** FIFO with more entries can miss more (9 → 10 on the classic string); LRU and OPT cannot.
8. **OPT?** Evict the farthest next use. It is optimal but needs the future.
9. **ASID?** A per-process tag so a context switch does not need a flush.
10. **Shootdown?** Invalidating a stale cached translation after the OS changes a mapping.
11. **Dirty bit?** Marks that a page must be written back when evicted.
12. **EAT?** `h(t+m) + (1−h)(t+(k+1)m) + p·S`; 130 ns for h = 0.8, t = 10, m = 100.
13. **Why does depth matter?** Each level adds one memory read per miss.
14. **How was it verified?** 96 automated tests, invariants, mutation testing and browser checks (section 7).

## 14. References

1. College-provided *Operating System Mini Projects (30 Marks)*, Module 5, Project #45.
2. Silberschatz, Galvin, Gagne, *Operating System Concepts*: paging, TLB, EAT, page replacement.
3. Arpaci-Dusseau, *Operating Systems: Three Easy Pieces*, chapter “Paging: Faster Translations (TLBs)” (context switches and ASIDs).
4. Colorado State University CS370 lecture notes on virtual memory: FIFO Belady example (9 vs 10 faults), CLOCK. <https://www.cs.colostate.edu/~cs370/Fall25/lectures/10virtualmemoryL19.pdf>
5. University of Utah CS3810 slides on virtual memory and set-associative TLB indexing. <https://users.cs.utah.edu/~rajeev/cs3810/slides/3810-17-23.pdf>
6. GATE Overflow, EAT with multi-level paging and page-fault service time. <https://gateoverflow.in/3500/gate2007-it-28>
7. MDN Web Docs for HTML, CSS and JavaScript APIs. <https://developer.mozilla.org/>
