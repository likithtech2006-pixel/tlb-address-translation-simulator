# TLB Address Translation Simulator

**Operating Systems · Module 5 (Memory Management) · Mini Project #45**
*Simulate virtual-to-physical address translation using a TLB.*

**Live demo:** LIVE_URL

TLB/Scope is an interactive simulator of a memory-management unit (MMU). Type a virtual address and watch it travel: it is split into a page number and an offset, looked up in the TLB, resolved by a page-table walk on a miss, handled by the OS on a page fault, checked for write permission, and turned into a physical address. The simulator also measures the hit ratio and effective access time and compares TLB replacement policies.

## What is in this repository

| Folder | Contents |
|---|---|
| [`tlb-simulator/`](tlb-simulator/) | The interactive web app (HTML, CSS, JavaScript; no build step, no back end) and its 96 engine tests |
| [`python-implementation/`](python-implementation/) | A command-line Python version of the simulator, with 16 unit tests |
| [`project-report/`](project-report/) | Project report (PDF and Word) and presentation (PowerPoint) |
| [`case-study/`](case-study/) | Case study (PDF and Word) |
| [`versions/`](versions/) | Snapshots of version 1 (single page) and version 2 (multi-page), with screenshots |
| [`backup-original/`](backup-original/) | The first prototype |

## Run it

**Web app**

```bash
python3 -m http.server 5173 --directory tlb-simulator
```

Then open <http://localhost:5173>. You can also open `tlb-simulator/index.html` directly in a browser.

**Python version**

```bash
cd python-implementation
python3 tlb_sim.py                                   # built-in demo
python3 tlb_sim.py --trace "300 300 0x1A2B 300:W"    # your own addresses
python3 tlb_sim.py --compare "1 2 3 4 1 2 5 1 2 3 4 5"
python3 -m unittest -v test_tlb_sim                  # 16 tests
```

**JavaScript tests**

```bash
cd tlb-simulator
npm test                                             # 96 engine tests
```

## Sample input and output

Default machine: 16-bit virtual address, 12-bit physical address, 256-byte pages, 4-entry fully associative LRU TLB, TLB time 10 ns, memory time 100 ns.

| Input | VPN, offset | Output | Physical address | Time |
|---|---|---|---|---|
| `300` | 1, 44 | TLB miss | 300 | 210 ns |
| `300` again | 1, 44 | TLB hit | 300 | 110 ns |
| `0x1A2B` | 26, 43 | Page fault | none | — |

On Belady's reference string `1 2 3 4 1 2 5 1 2 3 4 5`, FIFO gets 9 misses with 3 TLB entries but 10 misses with 4 (Belady's anomaly), while LRU and OPT never get worse with more entries.

## Features

- Bit-level view of the address split and the physical address
- MMU datapath with step-through explanations
- TLB replacement: FIFO, LRU, LFU, CLOCK, RANDOM and OPT
- Fully associative, set-associative and direct-mapped TLBs; 1 to 4 page-table levels
- Page faults (report-only or demand paging), write protection, multiple processes with ASIDs
- Timeline with rewind, branching and what-if replay
- Hit ratio, effective access time (modelled vs measured) and a policy lab
- Printable report

## Team

- P V Sai Likith (24BCI0174)
- M V S Sujan (24BCE2294)
- Shrijit (24BCE2469)
- Rajnihil (24BCT0191)

## License

MIT
