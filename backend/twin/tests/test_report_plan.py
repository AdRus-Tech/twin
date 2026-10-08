import json
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase, override_settings

from twin import plan
from twin.ai import report

LIVE = {"PROVIDER": "openai_compatible", "ALLOW_EXTERNAL": True, "BASE_URL": "https://example.test/v1",
        "MODEL": "test-model", "API_KEY": "test-key", "TIMEOUT_S": 5, "JSON_MODE": True, "TEMPERATURE": ""}


def chat(text):
    resp = mock.Mock(status_code=200)
    resp.json.return_value = {"choices": [{"message": {"content": text}}]}
    return resp


class ReportRulesTests(SimpleTestCase):
    def test_typical_messages(self):
        r = report.parse_rules("на сборке порвалась цепь, минут на 40")
        self.assertEqual((r["station"], r["reason"], r["duration_min"], r["missing"]), ("assembly", "обрыв цепи", 40, []))
        r = report.parse_rules("ABB-04 ошибка датчика, полчаса")
        self.assertEqual((r["station"], r["equipment"], r["duration_min"]), ("welding", "ABB-04", 30))
        r = report.parse_rules("Камера 2 — засорился фильтр, ремонт 1,5 ч")
        self.assertEqual((r["station"], r["equipment"], r["duration_min"]), ("painting", "Камера-02", 90))

    def test_unknown_parts_are_missing_not_invented(self):
        r = report.parse_rules("сейчас что-то случилось")
        self.assertIsNone(r["station"])
        self.assertIsNone(r["duration_min"])  # «сейчас» не читается как «час»
        self.assertEqual(set(r["missing"]), {"station", "duration_min"})


@override_settings(AI=LIVE)
class ReportAiTests(SimpleTestCase):
    def test_model_answer_is_validated_and_gaps_filled_by_rules(self):
        answer = json.dumps({"station": "painting", "equipment": "", "reason": "засор форсунки", "duration_min": None})
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat(answer)):
            r = report.parse_report("окраска встала, засор форсунки, минут 25")
        self.assertEqual((r["source"], r["station"], r["reason"], r["duration_min"]), ("ai", "painting", "засор форсунки", 25))

    def test_invalid_model_answer_falls_back_to_rules(self):
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat('{"station": "кухня", "duration_min": 9999}')):
            r = report.parse_report("на сборке порвалась цепь, 40 мин")
        self.assertEqual(r["source"], "ai")
        self.assertEqual((r["station"], r["duration_min"]), ("assembly", 40))
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat("не json")):
            r = report.parse_report("на сборке порвалась цепь, 40 мин")
        self.assertEqual(r["source"], "rules")


class PlanTests(SimpleTestCase):
    def test_month_inputs_from_case_journal(self):
        m = plan.month_inputs()
        self.assertEqual(m["target"], 5500)
        self.assertEqual(len(m["events"]), 4)
        self.assertEqual(m["events_per_shift"], 1.0)
        for e in m["events"]:
            self.assertLessEqual(e["loss_rec"], e["loss_none"])  # мера не хуже, чем без мер
        conveyor = next(e for e in m["events"] if e["equipment"] == "Конвейер-03")
        self.assertGreater(conveyor["loss_none"], conveyor["loss_rec"])
        # План по моделям — как в демонстрационных данных, без изменений.
        self.assertEqual([x["units"] for x in m["models"]], [2500, 1800, 500])

    def test_frontend_fixture_matches_server(self):
        # Фронтенд-тесты прогноза месяца считают по этому файлу — он должен совпадать с ответом сервера.
        fixture = settings.BASE_DIR.parent / "frontend" / "src" / "__fixtures__" / "plan_month.json"
        self.assertEqual(json.loads(fixture.read_text(encoding="utf-8")), plan.month_inputs())

    def test_endpoints(self):
        self.assertEqual(self.client.get("/api/plan/month/").status_code, 200)
        r = self.client.post("/api/ai/parse-report/", {"text": "ABB-01 ошибка датчика, 25 мин"}, content_type="application/json")
        self.assertEqual(r.json()["station"], "welding")
        self.assertEqual(self.client.post("/api/ai/parse-report/", {}, content_type="application/json").status_code, 400)
