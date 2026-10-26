# TLB/Scope — an MMU workbench

**OS Mini Project #45 · Module 5 (Memory Management) · “Simulate virtual-to-physical address translation using TLB.”**

TLB/Scope is a browser-based simulator of a memory-management unit. You can probe one address at a time and watch it travel. It is split into bits, looked up in the TLB, resolved by a multi-level page walk on a miss, handled by the OS on a page fault, checked for write permission, and turned into a physical address. Every action is recorded on a timeline that you can **rewind, scrub, branch and replay under a different configuration**.

## Run it

- **No install:** open `index.html` in Chrome, Edge, Firefox or Safari. It works offline from `file://`; fonts fall back to system fonts when offline.
- **Optional local server:** `npm start` (or `python -m http.server 5173`), then visit <http://localhost:5173>.
- **Tests:** `npm test` runs 96 automated tests in Node and rewrites `TEST_RESULTS.md`. The same suite runs inside the app under **Self-test**.

## What makes it different

| Feature | What you see |
|---|---|
| **Bit surgery** | The VA drawn bit by bit with brackets for VPN / TLB tag / set index / page-table level indices / offset. The offset bits fall straight down into the PA, and the PFN bits are swapped in from the TLB, the page table or the OS. |
| **MMU datapath** | Six hardware stages (CPU → TLB → WALK → OS → CHK → RAM) light up in hit, miss, fault or protection colours. **Step through** pauses at each stage with a plain-English explanation containing the actual numbers. |
| **Logic-analyzer timeline** | A VPN “bus” lane plus HIT / MISS / FAULT / PROT / CTX signal lanes. Click any column (or use ← →, Home/End, Space) to time-travel. A new access after rewinding branches the timeline. |
| **What-if replay** | Change any setting (policy, TLB size, associativity, ASID vs flush, fault handling) and the *whole timeline replays* under the new machine. Telemetry updates immediately. |
| **Policy lab** | Runs one trace through FIFO, LRU, LFU, CLOCK, RANDOM and OPT at 1–32 entries, plots hit ratio against size, and **detects Belady’s anomaly** automatically. |
| **Live structures** | The TLB is shown as sets × ways cards with policy-specific “victim-ness” meters, the CLOCK hand and evicted ghosts. The page table is a clickable cell map with a PTE inspector (make read-only, INVLPG). Physical frames are colour-coded by process. |
| **Telemetry** | Eight KPIs, a cumulative and rolling hit-ratio chart, the outcome mix, and an EAT calculator comparing the model with the *measured* run. |
| **Built-in self-test** | The full automated suite, run in the browser against the live engine. |
| **Live hero MMU** | A real mini-MMU runs continuously in the hero; glowing packets fly CPU → TLB → RAM on a hit, through the page table on a miss and via disk on a fault, with live TLB slots and hit ratio. |
| **Motion design** | Boot splash, staggered scroll reveals, a packet travelling the datapath on every translation, 3D bit flips, outcome bursts and glow rings, TLB entries gliding to new slots (FLIP), count-up KPIs, circular theme-switch reveal and scenario cross-fades (View Transitions). All of it is disabled automatically for reduced-motion users. |
| **Calculation player** | Opt-in. Every translation first shows a clean one-line result (outcome, VA → PA, VPN/offset/PFN, ns). Press **Show me what's happening**, or switch on **Always explain**, to play the full derivation: a computation graph whose edges draw and nodes fill as values are computed; a worksheet whose formulas morph from symbols to numbers to results (⌊VA ÷ S⌋ → ⌊300 ÷ 256⌋ → 1, PFN × S + offset → 1 × 256 + 44 → 300); the TLB comparator scan; per-level page-walk indices; fault victim choice; and a time ledger of nanoseconds growing stage by stage. It has play/pause/step/restart, clickable step dots and 0.5×/1×/2× speed. |
| **Applications** | A “Where this is useful” section at the bottom: who it helps (students, teachers, lab viva, hardware designers, performance engineers, OS and security engineers), how it helps, and a table mapping each simulator concept to real x86, ARM and RISC-V hardware and to Linux. |
| **Print / PDF report** | Print report (or Ctrl+P → Save as PDF) produces a clean light A4 report with a dated header and the machine configuration. Interactive controls are hidden, and the timeline, structures, telemetry, log, notes and applications are all included. |
| **Command palette** | `Ctrl/⌘ K`: run any scenario or action, switch policy, jump to sections, or type `0x12C` / `w 300` to translate directly. |

## The model

| Area | Supported |
|---|---|
| Geometry | 4–32-bit VA and PA, power-of-two pages, 1–4 page-table levels |
| TLB | 1–64 entries, fully associative, direct-mapped or N-way set associative |
| TLB replacement | FIFO, LRU, LFU, CLOCK (second chance), RANDOM (seeded, reproducible), OPT (lab only) |
| Page faults | *Report only* (no PA invented) or *demand paging* with FIFO / LRU / CLOCK frame replacement, dirty write-back and TLB shootdown |
| Processes | 1–4 address spaces; ASID-tagged TLB entries or flush-on-switch |
| Protection | Per-page read/write bit, checked on the cached TLB bits; dirty and referenced bits |
| Input | Decimal, `0x` hex, `0b` binary, `0o` octal, `_` separators; traces as `[P1:]addr[:W]`, with `#` comments |
| Timing | Hit = `t + m`; miss = `t + k·m + m`; fault adds `S`; `EAT = h(t+m) + (1−h)(t+(k+1)m) + p·S` |

## Files

```
index.html          page structure
css/styles.css      glass + aurora design system (dark/light), motion, responsive, print
js/engine.js        DOM-free MMU engine (browser + Node)
js/app.js           UI: timeline, renderers, lab, exports, share links, self-test
js/fx.js            effects: splash, reveals, spotlight, live hero MMU, command palette
js/calc.js          calculation player: computation graph, morphing worksheet, time ledger
tests/suite.js      96 test cases shared by Node and the in-app self-test
tests/run.js        Node runner (writes TEST_RESULTS.md)
TEST_RESULTS.md     latest automated results
PROJECT_REPORT.md   full project report
```

## Keyboard

`Ctrl/⌘ K` command palette · `/` focus probe · `Enter` translate · `W`/`R` write/read · `←`/`→` step through time · `Home`/`End` · `Space` play · `X` DEC/HEX · `T` theme · `?` help

## Persistence and privacy

Everything runs locally. Your last session and theme are kept in `localStorage` when available. **Share** puts the configuration and timeline into the URL fragment, so nothing is uploaded. **Session JSON** and **CSV** exports download files.
