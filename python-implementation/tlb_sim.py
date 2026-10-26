#!/usr/bin/env python3
"""
TLB Address Translation Simulator (Python implementation)
=========================================================

A command-line version of the TLB/Scope engine. It simulates how an MMU
translates virtual addresses to physical addresses using a TLB and a page
table, and reports hits, misses, page faults and effective access time.

Features
  * configurable address widths, page size and TLB size / associativity
  * TLB replacement: FIFO, LRU, LFU, CLOCK (second chance), RANDOM, OPT
  * page faults: "report" (no frame produced) or "demand" paging
    with FIFO / LRU frame replacement and dirty write-back
  * read / write accesses with protection (read-only pages) and dirty bits
  * policy comparison across TLB sizes (detects Belady's anomaly)

Usage
  python3 tlb_sim.py                                  # run the built-in demo
  python3 tlb_sim.py --trace "300 300 301 1200 0x1A2B"
  python3 tlb_sim.py --trace "1 2 3 4 1 2 5" --policy FIFO --entries 3
  python3 tlb_sim.py --compare "1 2 3 4 1 2 5 1 2 3 4 5"   # page numbers
"""

import argparse
import random
from dataclasses import dataclass


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
@dataclass
class Config:
    va_bits: int = 16          # virtual address width
    pa_bits: int = 12          # physical address width
    page_size: int = 256       # bytes per page (power of two)
    tlb_entries: int = 4
    tlb_ways: int = 0          # 0 = fully associative, 1 = direct-mapped
    tlb_policy: str = "LRU"    # FIFO | LRU | LFU | CLOCK | RANDOM | OPT
    fault_mode: str = "report" # report | demand
    frame_policy: str = "FIFO" # FIFO | LRU (demand paging only)
    mapping: str = "sequential"  # sequential (page n -> frame n) | empty
    t: int = 10                # TLB lookup time (ns)
    m: int = 100               # memory access time (ns)
    fault_time: int = 8000     # page-fault service time (ns)
    seed: int = 2024

    def __post_init__(self):
        if self.page_size & (self.page_size - 1):
            raise ValueError("page size must be a power of two")
        self.offset_bits = self.page_size.bit_length() - 1
        self.pages = 2 ** (self.va_bits - self.offset_bits)
        self.frames = 2 ** max(self.pa_bits - self.offset_bits, 0)
        ways = self.tlb_entries if self.tlb_ways == 0 else self.tlb_ways
        if self.tlb_entries % ways:
            raise ValueError("TLB entries must be a multiple of the ways")
        self.ways = ways
        self.sets = self.tlb_entries // ways
        self.va_max = 2 ** self.va_bits - 1


# --------------------------------------------------------------------------
# Data structures
# --------------------------------------------------------------------------
@dataclass
class TLBEntry:
    vpn: int
    pfn: int
    writable: bool
    dirty: bool
    inserted_at: int   # FIFO key
    last_use: int      # LRU key
    uses: int = 1      # LFU key
    ref: int = 1       # CLOCK reference bit
    next_use: float = float("inf")  # OPT key


@dataclass
class PTE:
    pfn: int = -1
    present: bool = False
    writable: bool = True
    dirty: bool = False
    referenced: bool = False


@dataclass
class Record:
    """One row of the translation log."""
    seq: int
    va: int
    write: bool
    vpn: int
    offset: int
    outcome: str        # HIT | MISS | FAULT | PROT
    pfn: object
    pa: object
    cost: int
    note: str = ""


# --------------------------------------------------------------------------
# The MMU
# --------------------------------------------------------------------------
class MMU:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.rng = random.Random(cfg.seed)
        self.clock = 0
        self.records = []
        self.stats = dict(accesses=0, hits=0, misses=0, page_faults=0,
                          prot_faults=0, tlb_evictions=0, page_evictions=0,
                          writebacks=0, reads=0, writes=0, cycles=0)
        self.page_table = [PTE() for _ in range(cfg.pages)]
        self.frame_owner = [-1] * cfg.frames          # inverted table: frame -> vpn
        self.frame_loaded = [0] * cfg.frames
        self.frame_used = [0] * cfg.frames
        self.tlb = [[None] * cfg.ways for _ in range(cfg.sets)]
        self.clock_hand = [0] * cfg.sets
        if cfg.mapping == "sequential":
            for vpn in range(min(cfg.pages, cfg.frames)):
                self._map(vpn, vpn)

    # ---- helpers ---------------------------------------------------------
    def _map(self, vpn, pfn):
        pte = self.page_table[vpn]
        pte.pfn, pte.present = pfn, True
        self.frame_owner[pfn] = vpn
        self.frame_loaded[pfn] = self.frame_used[pfn] = self.clock

    def decompose(self, va):
        vpn, offset = divmod(va, self.cfg.page_size)
        return vpn, offset, vpn % self.cfg.sets, vpn // self.cfg.sets

    def set_read_only(self, vpn):
        self.page_table[vpn].writable = False
        self._invalidate(vpn)  # shoot down the stale cached permission

    def _invalidate(self, vpn):
        row = self.tlb[vpn % self.cfg.sets]
        for w, e in enumerate(row):
            if e and e.vpn == vpn:
                row[w] = None

    # ---- TLB -------------------------------------------------------------
    def _tlb_find(self, vpn):
        row = self.tlb[vpn % self.cfg.sets]
        for w, e in enumerate(row):
            if e and e.vpn == vpn:
                return e
        return None

    def _choose_victim(self, s):
        row = self.tlb[s]
        if None in row:
            return row.index(None)
        policy = self.cfg.tlb_policy
        if policy == "CLOCK":                      # second chance
            while True:
                h = self.clock_hand[s]
                if row[h].ref:
                    row[h].ref = 0
                    self.clock_hand[s] = (h + 1) % len(row)
                else:
                    self.clock_hand[s] = (h + 1) % len(row)
                    return h
        if policy == "RANDOM":
            return self.rng.randrange(len(row))
        key = {
            "FIFO": lambda e: (e.inserted_at,),
            "LRU": lambda e: (e.last_use,),
            "LFU": lambda e: (e.uses, e.last_use),
            "OPT": lambda e: (-e.next_use, e.inserted_at),
        }[policy]
        return min(range(len(row)), key=lambda w: key(row[w]))

    def _tlb_insert(self, vpn, pte, next_use):
        s = vpn % self.cfg.sets
        way = self._choose_victim(s)
        old = self.tlb[s][way]
        if old:
            self.stats["tlb_evictions"] += 1
        self.tlb[s][way] = TLBEntry(vpn, pte.pfn, pte.writable, pte.dirty,
                                    self.clock, self.clock, next_use=next_use)
        return self.tlb[s][way], old

    # ---- page faults -----------------------------------------------------
    def _service_fault(self, vpn):
        if -1 in self.frame_owner:
            pfn, note = self.frame_owner.index(-1), "fault serviced (free frame)"
        else:
            keys = self.frame_used if self.cfg.frame_policy == "LRU" else self.frame_loaded
            pfn = min(range(self.cfg.frames), key=lambda f: keys[f])
            victim = self.frame_owner[pfn]
            vpte = self.page_table[victim]
            if vpte.dirty:
                self.stats["writebacks"] += 1
            self.page_table[victim] = PTE(writable=vpte.writable)
            self._invalidate(victim)
            self.stats["page_evictions"] += 1
            note = f"fault serviced (evicted page {victim})"
        self._map(vpn, pfn)
        return note

    # ---- one memory access -----------------------------------------------
    def access(self, va, write=False, next_use=float("inf")):
        cfg, st = self.cfg, self.stats
        if not isinstance(va, int) or not 0 <= va <= cfg.va_max:
            raise ValueError(f"address {va} is outside the {cfg.va_bits}-bit "
                             f"virtual space (0-{cfg.va_max})")
        self.clock += 1
        st["accesses"] += 1
        st["writes" if write else "reads"] += 1
        vpn, offset, _, _ = self.decompose(va)
        pte = self.page_table[vpn]
        cost, note, fault = cfg.t, "", False

        entry = self._tlb_find(vpn)
        if entry:                                   # TLB HIT
            st["hits"] += 1
            entry.last_use, entry.ref, entry.next_use = self.clock, 1, next_use
            entry.uses += 1
            outcome = "HIT"
        else:                                       # TLB MISS -> page walk
            st["misses"] += 1
            cost += cfg.m
            if not pte.present:                     # PAGE FAULT
                st["page_faults"] += 1
                fault = True
                if cfg.fault_mode == "report":
                    return self._log(va, write, vpn, offset, "FAULT", None, None,
                                     cost, "not serviced")
                note = self._service_fault(vpn)
                pte = self.page_table[vpn]
                cost += cfg.fault_time
            entry, old = self._tlb_insert(vpn, pte, next_use)
            if old:
                note = f"TLB evict page {old.vpn}"
            outcome = "FAULT" if fault else "MISS"

        pte.referenced = True
        self.frame_used[entry.pfn] = self.clock
        if write and not entry.writable:            # PROTECTION FAULT
            st["prot_faults"] += 1
            return self._log(va, write, vpn, offset, "PROT", entry.pfn, None,
                             cost, "write to read-only page")
        if write:
            pte.dirty = entry.dirty = True
        cost += cfg.m                               # data access
        pa = entry.pfn * cfg.page_size + offset
        return self._log(va, write, vpn, offset, outcome, entry.pfn, pa, cost, note)

    def _log(self, va, write, vpn, offset, outcome, pfn, pa, cost, note):
        self.stats["cycles"] += cost
        rec = Record(len(self.records) + 1, va, write, vpn, offset,
                     outcome, pfn, pa, cost, note)
        self.records.append(rec)
        return rec

    # ---- metrics ---------------------------------------------------------
    def hit_ratio(self):
        n = self.stats["accesses"]
        return self.stats["hits"] / n if n else 0.0

    def measured_eat(self):
        n = self.stats["accesses"]
        return self.stats["cycles"] / n if n else 0.0


# --------------------------------------------------------------------------
# Utilities
# --------------------------------------------------------------------------
def eat(h, t=10, m=100, levels=1, p=0.0, fault_time=0):
    """Effective access time: h(t+m) + (1-h)(t+(k+1)m) + p*S."""
    return h * (t + m) + (1 - h) * (t + (levels + 1) * m) + p * fault_time


def parse_trace(text):
    """Parses 'addr[:W]' tokens; addr may be decimal, 0x, 0b or 0o."""
    ops = []
    for tok in text.replace(",", " ").split():
        write = tok.upper().endswith(":W")
        tok = tok[:-2] if write else tok
        ops.append((int(tok.replace("_", ""), 0), write))
    return ops


def simulate(cfg, ops):
    """Runs a whole trace (OPT gets each access's next-use time)."""
    mmu = MMU(cfg)
    nxt, last = [float("inf")] * len(ops), {}
    for i in range(len(ops) - 1, -1, -1):
        vpn = ops[i][0] // cfg.page_size
        nxt[i] = last.get(vpn, float("inf"))
        last[vpn] = i
    for i, (va, w) in enumerate(ops):
        mmu.access(va, w, next_use=nxt[i])
    return mmu


def compare(pages, sizes=(1, 2, 3, 4, 8), policies=("FIFO", "LRU", "LFU", "CLOCK", "OPT")):
    """Hit ratio of each policy at each TLB size for a page reference string.
    Physical memory is made large enough that page faults never disturb the TLB."""
    bits = max(4, max(p for p, _ in pages).bit_length() + 1)
    table = {}
    for pol in policies:
        table[pol] = []
        for n in sizes:
            cfg = Config(va_bits=bits, pa_bits=bits, page_size=1,
                         tlb_entries=n, tlb_policy=pol)
            table[pol].append(simulate(cfg, pages).hit_ratio())
    anomalies = [(pol, sizes[i], sizes[i + 1])
                 for pol, row in table.items()
                 for i in range(len(sizes) - 1) if row[i + 1] < row[i]]
    return table, anomalies


# --------------------------------------------------------------------------
# Printing
# --------------------------------------------------------------------------
def print_run(mmu):
    cfg = mmu.cfg
    print(f"Machine: {cfg.va_bits}-bit VA, {cfg.pa_bits}-bit PA, {cfg.page_size} B pages "
          f"-> {cfg.pages} pages, {cfg.frames} frames, offset {cfg.offset_bits} bits")
    print(f"TLB    : {cfg.tlb_entries} entries ({cfg.sets} set x {cfg.ways} ways), {cfg.tlb_policy}, "
          f"faults={cfg.fault_mode}, t={cfg.t} ns, m={cfg.m} ns\n")
    print(f"{'T':>3} {'R/W':>3} {'VA':>6} {'VPN':>4} {'OFF':>4} {'OUTCOME':>7} "
          f"{'PFN':>4} {'PA':>6} {'COST':>5}  NOTES")
    for r in mmu.records:
        pfn = "-" if r.pfn is None else r.pfn
        pa = "-" if r.pa is None else r.pa
        print(f"{r.seq:>3} {'W' if r.write else 'R':>3} {r.va:>6} {r.vpn:>4} {r.offset:>4} "
              f"{r.outcome:>7} {pfn:>4} {pa:>6} {r.cost:>5}  {r.note}")
    s = mmu.stats
    print(f"\nAccesses {s['accesses']} ({s['reads']} R, {s['writes']} W) | "
          f"hits {s['hits']} | misses {s['misses']} | page faults {s['page_faults']} | "
          f"protection faults {s['prot_faults']} | TLB evictions {s['tlb_evictions']}")
    print(f"Hit ratio      : {mmu.hit_ratio() * 100:.1f} %")
    print(f"Measured EAT   : {mmu.measured_eat():.2f} ns")
    print(f"Model EAT (h=0.8): {eat(0.8, cfg.t, cfg.m):.0f} ns   |   no TLB: {2 * cfg.m} ns")


def print_compare(pages, sizes=(1, 2, 3, 4, 8)):
    table, anomalies = compare(pages, sizes)
    print("Hit % by policy and TLB size")
    print("Policy  " + "".join(f"{n:>7}" for n in sizes))
    for pol, row in table.items():
        print(f"{pol:<8}" + "".join(f"{h * 100:>7.1f}" for h in row))
    for pol, a, b in anomalies:
        print(f"Belady's anomaly: {pol} got worse going from {a} to {b} entries")


def main():
    ap = argparse.ArgumentParser(description="TLB address translation simulator")
    ap.add_argument("--trace", help='addresses, e.g. "300 300 0x1A2B 300:W"')
    ap.add_argument("--policy", default="LRU")
    ap.add_argument("--entries", type=int, default=4)
    ap.add_argument("--ways", type=int, default=0)
    ap.add_argument("--page-size", type=int, default=256)
    ap.add_argument("--fault-mode", default="report", choices=["report", "demand"])
    ap.add_argument("--compare", help="page reference string to run through every policy")
    a = ap.parse_args()

    if a.compare:
        print_compare(parse_trace(a.compare))
        return
    trace = a.trace or "300 300 301 1200 0x1A2B 0 256 512 768 0 300:W"
    cfg = Config(page_size=a.page_size, tlb_entries=a.entries, tlb_ways=a.ways,
                 tlb_policy=a.policy.upper(), fault_mode=a.fault_mode)
    print_run(simulate(cfg, parse_trace(trace)))
    if not a.trace:
        print("\n--- Policy comparison on Belady's string 1 2 3 4 1 2 5 1 2 3 4 5 ---")
        print_compare(parse_trace("1 2 3 4 1 2 5 1 2 3 4 5"))


if __name__ == "__main__":
    main()
