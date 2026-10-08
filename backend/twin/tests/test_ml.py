from django.test import SimpleTestCase

from twin.ml import model as M
from twin.ml import service
from twin.ml import telemetry as T


class TelemetryTests(SimpleTestCase):
    def test_history_is_reproducible(self):
        a = T.history("conveyor03", 42, days=20)
        b = T.history("conveyor03", 42, days=20)
        self.assertEqual(a.values["vibration"][:500], b.values["vibration"][:500])
        self.assertEqual(a.failures, b.failures)

    def test_labels_cover_horizon_before_failure(self):
        s = T.history("conveyor03", 7, days=30)
        self.assertTrue(s.failures)
        y = M.labels(s)
        f = s.failures[0]
        positives = [t for t, v in zip(s.t, y) if v and f - M.HORIZON_MIN <= t < f]
        self.assertEqual(len(positives), M.HORIZON_MIN // T.STEP_MIN)

    def test_features_skip_repair(self):
        s = T.history("booth02", 3, days=10)
        f = s.failures[0]
        i = s.t.index(f)
        self.assertIsNone(M.features_at(s, i))  # в момент отказа участок в ремонте


class MetricsTests(SimpleTestCase):
    def test_roc_auc(self):
        self.assertEqual(M.roc_auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75)
        self.assertEqual(M.roc_auc([0.5, 0.5], [0, 1]), 0.5)


class SavedModelTests(SimpleTestCase):
    def test_honest_verdicts(self):
        eq = service.load_meta()["equipment"]
        self.assertTrue(eq["conveyor03"]["predictable"])
        self.assertTrue(eq["booth02"]["predictable"])
        # Внезапный сбой датчика без предвестника не должен выдаваться за прогнозируемый.
        self.assertFalse(eq["abb01"]["predictable"])
        self.assertGreaterEqual(eq["conveyor03"]["test"]["warned"], 0.8 * eq["conveyor03"]["test"]["failures"])

    def test_demo_shift_warns_before_failure(self):
        mon = service.demo_monitor()
        by = {e["id"]: e for e in mon["equipment"]}
        conv = by["conveyor03"]
        self.assertTrue(conv["alarms"])
        lead = conv["failures"][0] - conv["alarms"][0]["t"]
        self.assertGreaterEqual(lead, 30)
        self.assertLessEqual(lead, M.HORIZON_MIN)
        self.assertTrue(conv["alarms"][0]["why"])
        self.assertEqual(by["abb01"]["alarms"], [])
        self.assertEqual(len(conv["points"]), T.SHIFT_MIN // T.STEP_MIN)

    def test_endpoint(self):
        r = self.client.get("/api/ml/shift/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual({e["id"] for e in r.json()["equipment"]}, {"conveyor03", "booth02", "abb01"})
