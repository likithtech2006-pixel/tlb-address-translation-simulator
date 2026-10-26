"""Unit tests for tlb_sim.py. Run with:  python3 -m unittest -v test_tlb_sim"""
import unittest

from tlb_sim import Config, MMU, compare, eat, parse_trace, simulate


def outcomes(mmu):
    return "".join(r.outcome[0] for r in mmu.records)  # H / M / F / P


class TranslationTests(unittest.TestCase):
    def test_split_and_physical_address(self):
        r = MMU(Config()).access(300)
        self.assertEqual((r.vpn, r.offset, r.pfn, r.pa), (1, 44, 1, 300))

    def test_miss_then_hit_and_costs(self):
        mmu = simulate(Config(), parse_trace("300 300"))
        self.assertEqual(outcomes(mmu), "MH")
        self.assertEqual([r.cost for r in mmu.records], [210, 110])

    def test_last_mapped_byte_and_first_unmapped(self):
        mmu = simulate(Config(), parse_trace("4095 4096"))
        self.assertEqual(mmu.records[0].pa, 4095)
        self.assertEqual(mmu.records[1].outcome, "FAULT")
        self.assertIsNone(mmu.records[1].pa)

    def test_number_formats(self):
        self.assertEqual({va for va, _ in parse_trace("300 0x12C 0b100101100 0o454 0x1_2C")}, {300})

    def test_out_of_range_rejected(self):
        mmu = MMU(Config())
        with self.assertRaises(ValueError):
            mmu.access(65536)
        self.assertEqual(mmu.stats["accesses"], 0)  # state untouched


class PolicyTests(unittest.TestCase):
    def run_pages(self, policy, entries, pages):
        cfg = Config(va_bits=8, pa_bits=8, page_size=1, tlb_entries=entries, tlb_policy=policy)
        return simulate(cfg, parse_trace(pages))

    def test_fifo_eviction(self):
        self.assertEqual(outcomes(self.run_pages("FIFO", 3, "1 2 3 1 4 1")), "MMMHMM")

    def test_lru_eviction(self):
        self.assertEqual(outcomes(self.run_pages("LRU", 3, "1 2 3 1 4 1")), "MMMHMH")

    def test_belady_anomaly_fifo(self):
        s = "1 2 3 4 1 2 5 1 2 3 4 5"
        self.assertEqual(self.run_pages("FIFO", 3, s).stats["misses"], 9)
        self.assertEqual(self.run_pages("FIFO", 4, s).stats["misses"], 10)

    def test_lru_and_opt_no_anomaly(self):
        s = "1 2 3 4 1 2 5 1 2 3 4 5"
        self.assertEqual([self.run_pages("LRU", n, s).stats["misses"] for n in (3, 4)], [10, 8])
        self.assertEqual([self.run_pages("OPT", n, s).stats["misses"] for n in (3, 4)], [7, 6])

    def test_clock_second_chance(self):
        # page 2 is re-referenced, so CLOCK evicts 3 instead
        self.assertEqual(self.run_pages("CLOCK", 3, "1 2 3 4 2 5").records[-1].note, "TLB evict page 3")

    def test_compare_flags_anomaly(self):
        _, anomalies = compare(parse_trace("1 2 3 4 1 2 5 1 2 3 4 5"))
        self.assertIn(("FIFO", 3, 4), anomalies)

    def test_direct_mapped_conflict(self):
        cfg = Config(tlb_entries=4, tlb_ways=1)
        self.assertEqual(outcomes(simulate(cfg, parse_trace("0 1024 0 1024 256 256"))), "MMMMMH")


class FaultAndProtectionTests(unittest.TestCase):
    def test_demand_paging_evicts_and_writes_back(self):
        cfg = Config(va_bits=8, pa_bits=5, page_size=16, mapping="empty", fault_mode="demand")
        mmu = simulate(cfg, parse_trace("0:W 16 32"))  # 2 frames, 3 pages
        self.assertEqual(mmu.stats["page_faults"], 3)
        self.assertEqual(mmu.stats["page_evictions"], 1)
        self.assertEqual(mmu.stats["writebacks"], 1)
        self.assertFalse(mmu.page_table[0].present)

    def test_write_to_read_only_page(self):
        mmu = MMU(Config())
        mmu.set_read_only(1)
        r = mmu.access(300, write=True)
        self.assertEqual(r.outcome, "PROT")
        self.assertIsNone(r.pa)
        self.assertFalse(mmu.page_table[1].dirty)


class MetricTests(unittest.TestCase):
    def test_eat_formula(self):
        self.assertAlmostEqual(eat(0.8, 10, 100), 130)

    def test_sample_run_matches_web_app(self):
        mmu = simulate(Config(), parse_trace("300 300 301 1200 0x1A2B 0 256 512 768 0 300:W"))
        self.assertAlmostEqual(mmu.hit_ratio(), 5 / 11)
        self.assertAlmostEqual(mmu.measured_eat(), 1710 / 11)


if __name__ == "__main__":
    unittest.main(verbosity=2)
