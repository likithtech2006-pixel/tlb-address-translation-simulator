# Versions

## Version 1 — single-page premium build (2026-10-09)
Snapshot: `versions/v1/` (checksums in `versions/v1.sha256`)

- Single-page app: hero with live mini-MMU, control deck, probe, calculation player (opt-in), bit surgery, MMU datapath, logic-analyzer timeline, workload, TLB / page table / frames, telemetry + EAT, policy lab, event log, self-test, field notes, viva, applications, print/PDF report.
- Engine: `js/engine.js` — 96/96 automated tests passing (`npm test`).

### Restore Version 1
Copy `versions/v1/*` back over `tlb-simulator/` (or open `versions/v1/index.html` directly).

## Version 2 — multi-page premium application (2026-10-09)
Snapshot: `versions/v2/` (checksums in `versions/v2.sha256`, screenshots in `versions/v2-screenshots/`)

- Ten connected pages, one task each: Home → Machine → Translate → Timeline → Structures → Analytics → Policy lab → Learn → Self-test → Report.
- Shared session across pages (localStorage), persistent shell (tabs, context bar, journey stepper, mobile tab bar, command palette), next-step hand-offs, deep links, guiding empty states.
- Page-to-page motion: native cross-document View Transitions (direction-aware slides, shared-element morphs), with a JS fallback for file:// and other browsers.
- New printable report page (session → A4 PDF).
- Engine unchanged: 96/96 engine tests; 29/29 page smoke tests (`npm run test:pages`).

### Restore Version 2
Copy `versions/v2/*` back over `tlb-simulator/`.
