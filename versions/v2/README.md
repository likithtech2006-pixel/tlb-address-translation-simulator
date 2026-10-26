# TLB/Scope v2 — an MMU workbench

**OS Mini Project #45 · Module 5 (Memory Management) · “Simulate virtual-to-physical address translation using TLB.”**

TLB/Scope is a browser-based simulator of a memory-management unit. You can probe one address at a time and watch it travel. It is split into bits, looked up in the TLB, resolved by a multi-level page walk on a miss, handled by the OS on a page fault, checked for write permission, and turned into a physical address. Every action is recorded on a timeline that you can **rewind, scrub, branch and replay under a different configuration**.

## Run it

- **Best experience:** `npm start` (or `python -m http.server 5173`), then open <http://localhost:5173> in Chrome or Edge. Served over http, pages glide into each other with native cross-document View Transitions, and shared elements morph between pages.
- **No install:** double-click `index.html`. Everything works from `file://` too; page changes then use the built-in fade/slide fallback.
- **Tests:** `npm test` runs the 96 engine tests in Node and rewrites `TEST_RESULTS.md`. `npm run test:pages` runs 29 page-level smoke tests in headless Chrome/Edge. `npm run test:all` runs both. The engine suite also runs live on the **Self-test** page.

## Pages and how they connect (v2)

Version 2 splits the app into nine connected rooms plus a home page. Each page does one job:

| Step | Page | Job | Hands off to |
|---|---|---|---|
| — | `index.html` **Home** | Live mini-MMU hero, the journey as nine cards, "continue where you left off", who it helps | any step |
| 1 | `machine.html` **Machine** | Configure geometry, TLB, paging, processes, timing; ten one-click scenarios | Translate (explain), Timeline (play), Structures, Lab |
| 2 | `translate.html` **Translate** | Probe an address; instant result; opt-in animated calculation player; bit surgery; datapath | Structures (`#pte-N`), Timeline (`?t=`) |
| 3 | `timeline.html` **Timeline** | Workloads and generators, logic-analyzer timeline, playback, event log | Structures |
| 4 | `structures.html` **Structures** | TLB sets × ways, page-table map + PTE inspector, physical frames | Analytics |
| 5 | `analytics.html` **Analytics** | KPIs, hit-ratio chart, outcome mix, EAT (model vs measured vs no TLB) | Policy lab |
| 6 | `lab.html` **Policy lab** | Six policies × seven sizes, Belady-anomaly detection | Learn |
| 7 | `learn.html` **Learn** | Field notes, viva drill, applications, real-world mapping | Self-test |
| 8 | `verify.html` **Self-test** | The 96-test suite, auto-run in the browser | Report |
| 9 | `report.html` **Report** | Print-first A4 report generated from the session → Save as PDF | Home |

**How they stay connected**
- **One session.** Configuration, timeline and cursor live in `localStorage` and are saved on every change, so a scenario loaded on *Machine* is already there on *Structures*. Share links (`#s=…`) still reproduce a session anywhere.
- **Persistent shell** on every page: tabs, a context bar (machine spec, `t = cursor / total`, last outcome linking back to Translate), the journey stepper (visited steps are ticked), and a bottom tab bar on phones.
- **Hand-offs:** every page ends with Previous / Next cards; scenario cards offer "explain / play / inspect / compare"; the Translate result links straight to that page's PTE and to that moment on the timeline.
- **Deep links:** `translate.html?addr=0x12C&w=1&explain=1`, `timeline.html?t=12` or `?play=1`, `structures.html#pte-4`, `lab.html?trace=belady&run=1`, `any.html?scenario=belady`.
- **Guiding empty states:** pages that read the session say so when it is empty and offer one-click fixes.
- **Command palette (Ctrl/⌘ K)** on every page: go to any page, run any scenario or action, or type an address.
- Keyboard: `[` and `]` move to the previous / next step in the journey.

**Transitions**
- Over http(s) in Chromium: native cross-document View Transitions. The shell stays still, the content slides in the journey's direction (forward = from the right, back = from the left) with blur and fade, the active tab indicator and stepper bubble glide, and a journey card's title morphs into the page heading.
- Elsewhere (file://, Firefox): an equivalent JS fade/slide that is direction-aware with no white flash. Neighbouring pages are prefetched for instant loads.
- All motion is disabled automatically under `prefers-reduced-motion`.

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
index.html … report.html   ten pages (one task each), generated from the v1 components
css/styles.css             design system: tokens, components, motion (dark/light), print
css/pages.css              v2 shell, page layouts, page-to-page transitions, report styles
js/engine.js               DOM-free MMU engine (browser + Node), unchanged since v1
js/shell.js                shell: tabs, context bar, journey, palette/dialog markup, hand-offs, transitions
js/app.js                  shared session (replay, persistence, deep links) + all panel renderers
js/fx.js                   effects: splash, reveals, spotlight, live hero MMU, command palette
js/calc.js                 calculation player (Translate page)
js/report.js               printable report (Report page)
tests/suite.js, run.js     96 engine tests (Node + in-app)
tests/pages.js             29 page-level smoke tests (headless Chrome/Edge, file://)
TEST_RESULTS.md            latest engine test results
../versions/               v1 (single page) and v2 snapshots, screenshots, VERSIONS.md
```

## Keyboard

`Ctrl/⌘ K` command palette · `[` / `]` previous / next page · `/` focus probe · `Enter` translate · `W`/`R` write/read · `←`/`→` step through time · `Home`/`End` · `Space` play · `X` DEC/HEX · `T` theme · `?` help

## Persistence and privacy

Everything runs locally. Your last session and theme are kept in `localStorage` when available. **Share** puts the configuration and timeline into the URL fragment, so nothing is uploaded. **Session JSON** and **CSV** exports download files.
