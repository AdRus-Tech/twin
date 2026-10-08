import copy

from django.test import SimpleTestCase

from twin import simulation as sim


def preset(**changes):
    p = copy.deepcopy(sim.DEFAULT_PRESET)
    p.pop("label")
    for key, value in changes.items():
        p[key] = value
    return p


def variants():
    """Небольшая сетка параметров, включая крайние случаи."""
    yield preset()
    yield preset(stoppage=None)
    yield preset(buffers=[{"capacity": 1, "initial": 0}, {"capacity": 1, "initial": 1}])
    yield preset(buffers=[{"capacity": 30, "initial": 30}, {"capacity": 2, "initial": 0}])
    yield preset(stoppage={"station": "welding", "start_min": 0, "duration_min": 200})
    yield preset(stoppage={"station": "assembly", "start_min": 470, "duration_min": 60})
    yield preset(extra_stoppages=[{"station": "welding", "start_min": 60, "duration_min": 25},
                                  {"station": "assembly", "start_min": 300, "duration_min": 55}])
    yield preset(stations=[
        {"id": "s1", "name": "1", "cycle_s": 60},
        {"id": "s2", "name": "2", "cycle_s": 300},
        {"id": "s3", "name": "3", "cycle_s": 45},
    ], stoppage=None)


class ConservationTests(SimpleTestCase):
    def test_units_are_conserved(self):
        for params in variants():
            r = sim.run(params)
            self.assertEqual(r["initial_wip"] + r["released_units"], r["output_units"] + r["wip_end"], params)

    def test_queues_stay_within_capacity(self):
        for params in variants():
            r = sim.run(params)
            caps = [b["capacity"] for b in params["buffers"]]
            for frame in r["frames"]:
                for level, cap in zip(frame["buffers"], caps):
                    self.assertGreaterEqual(level, 0)
                    self.assertLessEqual(level, cap)
            for b in r["buffers"]:
                self.assertLessEqual(b["max"], b["capacity"])
                self.assertGreaterEqual(b["min"], 0)

    def test_state_time_adds_up_to_horizon(self):
        r = sim.run(preset())
        for s in r["stations"]:
            total = s["working_min"] + s["blocked_min"] + s["starved_min"] + s["down_min"]
            self.assertAlmostEqual(total, 480, delta=0.2)


class BehaviourTests(SimpleTestCase):
    def test_zero_duration_stoppage_equals_baseline(self):
        base = sim.run(preset(stoppage=None))
        zero = sim.run(preset(stoppage={"station": "painting", "start_min": 120, "duration_min": 0}))
        for key in ("output_units", "stations", "buffers", "events", "frames"):
            self.assertEqual(base[key], zero[key], key)

    def test_same_params_same_result(self):
        self.assertEqual(sim.run(preset()), sim.run(preset()))

    def test_downstream_stop_blocks_upstream(self):
        params = {
            "stations": [{"id": "a", "name": "A", "cycle_s": 60}, {"id": "b", "name": "B", "cycle_s": 60}],
            "buffers": [{"capacity": 2, "initial": 0}],
            "horizon_min": 30,
            "stoppage": {"station": "b", "start_min": 10, "duration_min": 10},
        }
        r = sim.run(params)
        a, b = r["stations"]
        self.assertEqual(b["down_min"], 10)
        # Буфер на 2 единицы заполняется за 2 минуты, третья единица ждёт: ~7 мин блокировки.
        self.assertAlmostEqual(a["blocked_min"], 7, delta=1)
        self.assertEqual(r["buffers"][0]["max"], 2)

    def test_upstream_stop_starves_downstream(self):
        params = {
            "stations": [{"id": "a", "name": "A", "cycle_s": 60}, {"id": "b", "name": "B", "cycle_s": 60}],
            "buffers": [{"capacity": 5, "initial": 3}],
            "horizon_min": 30,
            "stoppage": {"station": "a", "start_min": 5, "duration_min": 10},
        }
        r = sim.run(params)
        b = r["stations"][1]
        self.assertGreater(b["starved_min"], 0)
        self.assertGreater(b["first_starved_min"], 5)

    def test_painting_stop_in_preset_causes_both_effects(self):
        r = sim.run(preset())
        by_id = {s["id"]: s for s in r["stations"]}
        self.assertGreater(by_id["welding"]["blocked_min"], 0)
        self.assertGreater(by_id["assembly"]["starved_min"], 0)
        self.assertEqual(by_id["painting"]["down_min"], 40)

    def test_compare_delta_is_b_minus_a(self):
        a = sim.run(preset())
        b = sim.run(preset(stoppage={"station": "painting", "start_min": 120, "duration_min": 20}))
        c = sim.compare(a, b)
        self.assertEqual(c["delta"]["output_units"], b["output_units"] - a["output_units"])


class ValidationTests(SimpleTestCase):
    def assertRejected(self, params, field):
        with self.assertRaises(sim.ParamError) as ctx:
            sim.parse_params(params)
        self.assertIn(field, ctx.exception.errors)

    def test_extra_fields_rejected(self):
        self.assertRejected({**preset(), "exec": "rm -rf"}, "params")

    def test_initial_above_capacity_rejected(self):
        self.assertRejected(preset(buffers=[{"capacity": 2, "initial": 3}, {"capacity": 2, "initial": 0}]),
                            "buffers[0].initial")

    def test_types_and_ranges(self):
        self.assertRejected(preset(horizon_min="480"), "horizon_min")
        self.assertRejected(preset(horizon_min=10_000), "horizon_min")
        self.assertRejected(preset(stoppage={"station": "nope", "start_min": 0, "duration_min": 5}),
                            "stoppage.station")
        self.assertRejected(preset(stoppage={"station": "painting", "start_min": 480, "duration_min": 5}),
                            "stoppage.start_min")

    def test_invalid_station_types_return_400(self):
        for station in ([], {}, None, 12):
            with self.subTest(station=station):
                p = preset(stoppage={"station": station, "start_min": 10, "duration_min": 5})
                response = self.client.post("/api/scenario/run/", {"params": p}, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                self.assertIn("stoppage.station", response.json()["fields"])

    def test_nonfinite_numbers_are_rejected(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            self.assertRejected(preset(horizon_min=value), "horizon_min")


class ExtraStoppageTests(SimpleTestCase):
    def test_extra_equals_main_stoppage(self):
        stop = {"station": "assembly", "start_min": 300, "duration_min": 55}
        main = sim.run(preset(stoppage=stop))
        extra = sim.run(preset(stoppage=None, extra_stoppages=[stop]))
        self.assertEqual(main["output_units"], extra["output_units"])
        self.assertEqual(main["stations"], extra["stations"])

    def test_two_stoppages_cost_more_than_one(self):
        one = sim.run(preset())
        two = sim.run(preset(extra_stoppages=[{"station": "assembly", "start_min": 300, "duration_min": 55}]))
        self.assertLess(two["output_units"], one["output_units"])
        self.assertEqual(len([e for e in two["events"] if e["state"] == "down"]), 2)

    def test_params_without_extra_unchanged(self):
        self.assertNotIn("extra_stoppages", sim.run(preset())["params"])

    def test_extra_validated(self):
        with self.assertRaises(sim.ParamError) as cm:
            sim.parse_params(preset(extra_stoppages=[{"station": "nope", "start_min": 10, "duration_min": 5}]))
        self.assertIn("extra_stoppages[0].station", cm.exception.errors)
        with self.assertRaises(sim.ParamError):
            sim.parse_params(preset(extra_stoppages=[{"station": "welding", "start_min": 10, "duration_min": 5}] * 9))
