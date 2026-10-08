from django.test import SimpleTestCase

from twin import dataset


class PercentTests(SimpleTestCase):
    def test_fact_above_plan_is_not_clipped(self):
        self.assertEqual(dataset.pct(121, 120), 100.83)

    def test_zero_base(self):
        self.assertIsNone(dataset.pct(5, 0))


class OverviewTests(SimpleTestCase):
    def node(self, ov, node_id):
        return next(n for n in ov["chain"] if n["id"] == node_id)

    def test_painting_defect_rates(self):
        day1 = self.node(dataset.overview("2026-10-01"), "painting")
        day2 = self.node(dataset.overview("2026-10-02"), "painting")
        self.assertAlmostEqual(day1["quality"]["defect_pct"]["value"], 3.48, places=2)
        self.assertAlmostEqual(day2["quality"]["defect_pct"]["value"], 5.17, places=2)
        for node in (day1, day2):
            self.assertIn("defect_over_limit", [f["type"] for f in node["flags"]])
            self.assertTrue(node["quality"]["matches_stated"])

    def test_welding_second_day_also_over_limit(self):
        welding = self.node(dataset.overview("2026-10-02"), "welding")
        self.assertAlmostEqual(welding["quality"]["defect_pct"]["value"], 2.70, places=2)
        self.assertIn("defect_over_limit", [f["type"] for f in welding["flags"]])

    def test_assembly_over_plan_reported_as_is(self):
        assembly = self.node(dataset.overview("2026-10-01"), "assembly")
        self.assertEqual(assembly["line"]["plan_completion_pct"]["value"], 100.83)
        self.assertNotIn("plan_shortfall", [f["type"] for f in assembly["flags"]])

    def test_plan_inconsistency_is_shown_not_fixed(self):
        check = dataset.overview()["plan_check"]
        self.assertEqual(check["models_total"]["value"], 4800)
        self.assertEqual(check["required_min"]["value"], 5500)
        self.assertEqual(check["gap"]["value"], 700)
        self.assertFalse(check["consistent"])

    def test_nodes_without_data_are_marked(self):
        ov = dataset.overview()
        empty = [n["id"] for n in ov["chain"] if not n["has_data"]]
        self.assertEqual(empty, ["parts_store", "quality", "fg_store"])

    def test_oee_not_calculated(self):
        oee = dataset.overview()["oee"]
        self.assertEqual(oee["status"], "not_calculated")
        self.assertEqual(oee["target_pct"]["value"], 85)

    def test_unknown_date_falls_back_to_latest(self):
        self.assertEqual(dataset.overview("1999-01-01")["date"], "2026-10-02")
