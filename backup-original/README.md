# TLB Lab — Address Translation Simulator

A client-side Operating Systems mini project aligned with the college PDF's **Project #45: TLB Address Translation Simulator**, under **Module 5 — Memory Management**. The official short description is “Simulate virtual-to-physical address translation using TLB.”

## Run the project

1. Extract the project ZIP (if you received the ZIP) into a folder.
2. Open `index.html` in a current Chrome, Edge, Firefox, or Safari browser. No installation, server, account, or backend is required.
3. Enter a virtual address and click **Translate**. Try address `300` twice to observe a miss followed by a hit with the default model.
4. Use the **Demo presets** for ready-made hit, miss, replacement, and page-fault scenarios.

The optional Google Fonts import improves typography when online; the application itself works without it and uses fallback fonts.

## Files

- `index.html` — page structure and UI
- `styles.css` — responsive styling, light/dark theme, transitions, print layout
- `simulator.js` — memory model, translation engine, replacement policies, statistics, step/demo modes, and exports
- `PROJECT_REPORT.md` — report draft, algorithms, test plan, expected results, viva questions, and screenshot checklist

## Memory-model assumptions

- Addresses are byte-addressed and page sizes are powers of two.
- A page table is initialized according to the selected mapping preset. The default maps the first `number of physical frames` virtual pages one-to-one; other pages start invalid.
- An invalid page-table entry causes a page fault. This teaching simulator does not emulate disk I/O or page-fault servicing; it will not fabricate a frame or physical address.
- The TLB uses fully associative lookup and supports FIFO and LRU replacement.
- A TLB hit requires a TLB lookup and one data-memory access. A TLB miss with a valid mapping requires a TLB lookup, one page-table access, and one data-memory access. The EAT calculator uses this simplified model and excludes page-fault service time.
- To keep the UI responsive for large configurations, the page-table view shows a window of at most 180 entries and the memory visualization shows at most 128 frames at once. The underlying configured model is not truncated.

## Address translation formulas

For page size `S` and virtual address `VA`:

- `page number = floor(VA / S)`
- `offset = VA mod S`
- On a valid mapping: `physical address = frame number × S + offset`
- `offset bits = log2(S)`; `page-number bits = virtual-address bits − offset bits`

## Reset behavior

Changing any memory configuration rebuilds the page table and frames and clears the TLB, history, and statistics. **Clear statistics** only resets counters; it does not clear the TLB or history. **Clear history** only clears the history table. The theme preference is saved locally in browser storage when available.
