# Prompt — TLB/Scope Version 2: multi-page premium application

## Role
Act as a senior front-end engineer and product designer. Restructure **TLB/Scope** (an OS mini-project: a TLB address-translation simulator) from one long page into a **connected multi-page application** with a premium UI and very smooth, top-quality transitions.

## Context
- The current build is frozen as **Version 1** in `versions/v1/`. Do not modify it. If I say **"version 1"**, restore that snapshot exactly.
- The live code is in `tlb-simulator/`. The engine (`js/engine.js`) and the 96-test suite (`tests/`) are correct and must stay behaviourally identical. `npm test` must still pass 96/96, and the in-app self-test must too.
- It must keep working with **no build step and no backend**: plain HTML/CSS/JS, opening `index.html` directly (also via `file://`), plus `npm start` for a local server.
- Before you start, snapshot the result of this work as **Version 2** in `versions/v2/` and update `versions/VERSIONS.md`.

## Goal
One task per page, with pages linked the way a user naturally works through the material:
**Configure the machine → Translate an address → Run a workload → Inspect structures → Analyse performance → Compare policies → Learn & verify → Report.**
Moving between pages should feel like moving around inside one app, not like jumping between separate websites.

## Pages (one task each)
| File | Page | Contents (reuse the existing components) |
|---|---|---|
| `index.html` | **Home** | Hero with the live mini-MMU animation, the six-step journey shown as large clickable cards, "Continue where you left off", and the Applications summary |
| `machine.html` | **Machine** | Full-width configuration (geometry, TLB, paging and faults, processes, timing), derived-geometry readout, ten scenario presets shown as rich cards |
| `translate.html` | **Translate** | Address probe, quick result, opt-in **"Show me what's happening"** calculation player (graph + morphing worksheet + time ledger), bit surgery, MMU datapath, Step-through |
| `timeline.html` | **Timeline** | Workload editor and generators, logic-analyzer timeline, playback, event log (click a row to time-travel) |
| `structures.html` | **Structures** | TLB sets × ways, page-table cell map with PTE inspector, physical frames |
| `analytics.html` | **Analytics** | KPIs, hit-ratio chart, outcome mix, EAT calculator (modelled vs measured vs no TLB) |
| `lab.html` | **Policy lab** | Policy × size experiment, chart, table, Belady-anomaly detection |
| `learn.html` | **Learn** | Field notes, viva drill, Applications, "How it helps", real-world mapping table |
| `verify.html` | **Self-test** | In-browser test runner with grouped results; link to `TEST_RESULTS.md` |
| `report.html` | **Report** | A print-first A4 report generated from the current session (config, summary, translations with working, structures, telemetry, lab result). Light theme only; one-click "Save as PDF" |

## How the pages connect (most important)
1. **One shared session.** Machine configuration, the operation timeline and the cursor persist across pages (`localStorage`, with URL-fragment share links as now). Changing a setting on *Machine* replays the timeline everywhere. All page state survives back/forward navigation and reloads.
2. **Persistent app shell** on every page:
   - a top bar with the logo, the page tabs and the command palette (Ctrl/⌘ K);
   - a compact **context bar** showing the machine spec, `t = cursor / total` and the last outcome;
   - a **journey stepper** that marks the current step and which steps already have data.
   These elements must not visibly reload between pages.
3. **Contextual hand-offs.** Every page ends with a clear "next step" call to action, and cross-links carry context:
   - a TLB entry → its row in Structures;
   - a log row → Timeline at that time;
   - a result on Translate → its calculation;
   - a scenario on Machine → straight to Translate or Timeline, with the trace loaded.
4. **Deep links.** Every view is addressable, e.g. `translate.html?addr=0x12C&explain=1`, `timeline.html?t=12`, `structures.html#pte-1`, `lab.html?trace=belady`.
5. **Empty states that guide.** A page with no data explains why and offers the one action that fills it, e.g. "Load a scenario" or "Translate 300".
6. **Command palette** on every page can run any action and navigate to any page, carrying the session with it.

## Transitions (top-notch, very smooth)
- **Between pages:** use cross-document View Transitions (`@view-transition { navigation: auto; }`).
  - The shell (top bar, context bar, stepper) stays still while only the content cross-fades and slides (about 280–420 ms, `cubic-bezier(.2,.8,.2,1)`).
  - **Shared elements morph** using `view-transition-name`: the clicked journey card expands into the page header; the active tab indicator glides; the address chip flies from Translate into Timeline and Structures.
  - Direction-aware: forward in the journey slides left, backward slides right.
  - **Fallback** where View Transitions are not supported (e.g. Firefox, `file://`): a JS pre-navigation fade/slide overlay of equal quality, never a hard white flash.
- **Inside pages:** keep and polish the existing motion: staggered entrances, the datapath packet, 3D bit flips, FLIP-animated TLB entries, count-up numbers, the morphing worksheet, chart draw-ins and the circular theme reveal. Add skeleton shimmer for anything computed after paint.
- **Quality bar:**
  - 60 fps; animate only `transform`, `opacity` and `filter`;
  - no layout shift;
  - no animation longer than 700 ms on the critical path;
  - everything interruptible;
  - full `prefers-reduced-motion` support (instant swaps, no parallax).

## Premium UI requirements
- Keep the current visual language (dark-first glass on an aurora background, Geist / Geist Mono / Instrument Serif, signal colours: emerald = hit, amber = miss, rose = fault, violet = protection, cyan = VPN/context) and a polished light theme.
- Each page gets a distinct hero header (kicker, serif title, one-line purpose, primary action) and a consistent 12-column grid. Use generous whitespace and no cramped panels.
- Fully responsive down to 360 px. On mobile, page tabs become a bottom tab bar and the context bar collapses into a pill.
- Accessible: semantic landmarks, focus management on navigation (move focus to the page `h1`), visible focus rings, WCAG AA contrast, all actions keyboard-reachable.
- Print: `report.html` produces a clean multi-page A4 PDF with no blank or clipped cards.

## Architecture constraints
- Shared modules: `js/engine.js` (unchanged), `js/store.js` (session state, persistence, replay, pub/sub), `js/shell.js` (shell, palette, page transitions), and one small module per page.
- Reuse the existing renderers rather than rewriting them; split `app.js` by page.
- No external JS libraries (Google Fonts only, with system fallbacks); everything works offline.

## Acceptance criteria
1. Ten pages exist, each focused on one task, linked by the shell, the journey stepper, next-step actions, deep links and the palette.
2. A setting or translation made on any page is reflected on every other page after navigating, and also after a reload.
3. Page-to-page navigation shows smooth shared-element transitions in Chromium and an equally smooth fallback elsewhere, with no white flash.
4. `npm test` passes 96/96. Add page-level smoke tests: every page loads with no console errors, empty-state and populated-state renders, deep links resolve, and the session persists across pages.
5. No horizontal scroll at 360 px; Lighthouse accessibility ≥ 95; the reduced-motion mode works.
6. `report.html` prints a correct multi-page PDF.
7. `versions/v1` is untouched, `versions/v2` contains the new build, `VERSIONS.md` is updated, and the README describes the page map and the flow.

## Deliverables
The restructured `tlb-simulator/`, the `versions/v2/` snapshot, updated `README.md` and `PROJECT_REPORT.md` (new architecture and page-flow diagram), test results, and before/after screenshots of every page in both themes.
