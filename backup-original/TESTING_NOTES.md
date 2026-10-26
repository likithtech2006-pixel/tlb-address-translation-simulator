# Verification notes

- `node --check simulator.js` completed successfully during assembly (JavaScript syntax check).
- A browser-driven smoke test was attempted in the available headless Chromium environment, but the environment's browser policy blocked both `file://` and local HTTP URLs before the app loaded. Therefore no claim is made that interactive browser tests passed in this environment.
- The full manual test plan is in `PROJECT_REPORT.md`, Section 12. Run those cases in Chrome/Edge/Firefox on your own machine and fill in actual outcomes before submitting the report.

Recommended local verification order:
1. Open `index.html` directly in your browser.
2. Load **TLB hit** preset and inspect the TLB hit count.
3. Load **TLB miss** preset and inspect page-table lookup count.
4. Load **TLB replacement** preset and inspect eviction behavior.
5. Load **Page fault** preset and confirm no physical address is generated.
6. Try invalid input and confirm the validation message appears without adding a translation.
7. Run the sequence, random mode, step-by-step mode, demo mode, CSV exports, dark-mode toggle, and EAT calculator.
