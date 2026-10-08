import copy
import json
from unittest import mock

import httpx
from django.test import SimpleTestCase, override_settings

from twin import simulation as sim
from twin.ai import contract, service

LIVE = {
    "PROVIDER": "openai_compatible", "BASE_URL": "https://example.invalid/v1", "MODEL": "test-model",
    "API_KEY": "test-key", "TIMEOUT_S": 1.0, "JSON_MODE": True, "ALLOW_EXTERNAL": True,
}
DEMO = {**LIVE, "PROVIDER": "demo", "API_KEY": "", "ALLOW_EXTERNAL": False}


_tmp = None
_dir_patch = None


def setUpModule():
    # Живые ответы в тестах не должны попадать в настоящую папку сохранённых ответов.
    global _tmp, _dir_patch
    import tempfile
    from pathlib import Path
    from twin.ai import saved_answers
    _tmp = tempfile.TemporaryDirectory()
    _dir_patch = mock.patch.object(saved_answers, "DIR", Path(_tmp.name))
    _dir_patch.start()


def tearDownModule():
    _dir_patch.stop()
    _tmp.cleanup()


def params():
    p = copy.deepcopy(sim.DEFAULT_PRESET)
    p.pop("label")
    return p


def chat_response(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]},
                          request=httpx.Request("POST", "https://example.invalid"))


class ContractTests(SimpleTestCase):
    def setUp(self):
        self.result = sim.run(params())
        self.facts = contract.build_facts(self.result)
        self.fields = contract.allowed_fields(self.result["params"])

    def test_evidence_is_checked_against_facts(self):
        text = json.dumps({
            "summary": "s",
            "findings": [
                {"observation": "верно", "evidence": [{"key": "a.output_units", "value": self.facts["a.output_units"]}]},
                {"observation": "выдумано", "evidence": [{"key": "a.output_units", "value": 9999}]},
                {"observation": "нет ключа", "evidence": [{"key": "a.unknown", "value": 1}]},
            ],
        })
        parsed = contract.parse_response(text, self.facts, self.fields)
        self.assertEqual([f["verified"] for f in parsed["findings"]], [True, False, False])

    def test_proposal_outside_whitelist_or_range_is_rejected(self):
        base = {"summary": "s", "findings": [{"observation": "o", "evidence": []}]}
        cases = [
            ({"field": "horizon_min", "value": 900}, "поле не входит"),
            ({"field": "stoppage.duration_min", "value": 500}, "вне диапазона"),
            ({"field": "stoppage.duration_min", "value": 12.5}, "целым"),
            ({"field": "__import__('os')", "value": 1}, "поле не входит"),
        ]
        for prop, reason in cases:
            parsed = contract.parse_response(json.dumps({**base, "proposal": prop}), self.facts, self.fields)
            self.assertFalse(parsed["proposal"]["accepted"])
            self.assertIn(reason, parsed["proposal"]["reason"])

    def test_garbage_raises_contract_error(self):
        for text in ("", "Конечно! Вот анализ.", "[1,2]", '{"summary": ""}', "{broken"):
            with self.assertRaises(contract.ContractError):
                contract.parse_response(text, self.facts, self.fields)

    def test_json_inside_markdown_fence_is_accepted(self):
        text = '```json\n{"summary": "s", "findings": [{"observation": "o", "evidence": []}]}\n```'
        self.assertEqual(contract.parse_response(text, self.facts, self.fields)["summary"], "s")

    def test_wrong_array_types_raise_contract_error(self):
        base = {"summary": "s", "findings": [{"observation": "o", "evidence": []}]}
        for value in ({"key": "a.output_units", "value": 1}, 123, "evidence"):
            with self.subTest(value=value), self.assertRaises(contract.ContractError):
                contract.parse_response(json.dumps({**base, "findings": [{"observation": "o", "evidence": value}]}),
                                        self.facts, self.fields)
        for key in ("assumptions", "limitations"):
            with self.subTest(key=key), self.assertRaises(contract.ContractError):
                contract.parse_response(json.dumps({**base, key: {"text": "invalid"}}), self.facts, self.fields)

    def test_nonfinite_proposal_is_rejected(self):
        for value in (float("nan"), float("inf")):
            answer = {"summary": "s", "findings": [{"observation": "o", "evidence": []}],
                      "proposal": {"field": "stoppage.duration_min", "value": value}}
            parsed = contract.parse_response(json.dumps(answer), self.facts, self.fields)
            self.assertFalse(parsed["proposal"]["accepted"])


@override_settings(AI=DEMO)
class DemoFlowTests(SimpleTestCase):
    def test_demo_propose_runs_second_simulation(self):
        out = service.propose(params())
        self.assertEqual(out["ai"]["status"], "ok")
        self.assertEqual(out["ai"]["source"], "demo")
        self.assertFalse(out["ai"]["live"])
        self.assertTrue(out["ai"]["result"]["proposal"]["accepted"])
        self.assertEqual(out["b_params"]["stoppage"]["duration_min"], 20)
        self.assertIsNotNone(out["comparison"])
        self.assertTrue(all(f["verified"] for f in out["ai"]["result"]["findings"]))

    def test_demo_explain(self):
        b = params()
        b["stoppage"]["duration_min"] = 20
        out = service.explain(params(), b)
        self.assertEqual(out["ai"]["status"], "ok")
        self.assertTrue(all(f["verified"] for f in out["ai"]["result"]["findings"]))


@override_settings(AI=LIVE)
class FailureTests(SimpleTestCase):
    def test_malformed_evidence_keeps_api_calculation(self):
        answer = {"summary": "s", "findings": [{"observation": "o", "evidence": {"key": "a.output_units"}}]}
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response(json.dumps(answer))):
            response = self.client.post("/api/ai/propose/", {"params": params()}, content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ai"]["status"], "invalid")
        self.assertIsNotNone(response.json()["a"]["output_units"])

    def test_cache_write_failure_keeps_valid_ai_answer(self):
        answer = {"summary": "s", "findings": [{"observation": "o", "evidence": []}]}
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response(json.dumps(answer))), \
                mock.patch("twin.ai.saved_answers.save", side_effect=OSError("read only")):
            result = service.propose(params())
        self.assertEqual(result["ai"]["status"], "ok")
        self.assertIn("save_error", result["ai"])

    def test_timeout_keeps_simulation(self):
        with mock.patch("twin.ai.providers.httpx.post", side_effect=httpx.ReadTimeout("t")):
            out = service.propose(params())
        self.assertEqual(out["ai"]["status"], "unavailable")
        self.assertEqual(out["ai"]["error_code"], "timeout")
        self.assertEqual(out["a"]["output_units"], sim.run(params())["output_units"])
        self.assertIsNone(out["b"])

    def test_invalid_model_answer_keeps_simulation(self):
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response("не JSON")):
            out = service.propose(params())
        self.assertEqual(out["ai"]["status"], "invalid")
        self.assertIn("output_units", out["a"])

    def test_http_error_codes(self):
        resp = httpx.Response(401, request=httpx.Request("POST", "https://example.invalid"))
        with mock.patch("twin.ai.providers.httpx.post", return_value=resp):
            out = service.explain(params(), params())
        self.assertEqual(out["ai"]["error_code"], "auth")
        self.assertNotIn("test-key", json.dumps(out, ensure_ascii=False))

    def test_live_answer_with_valid_proposal(self):
        answer = {
            "summary": "Остановка окраски вызывает нехватку потока на сборке.",
            "findings": [{"observation": "Сборка без потока", "evidence": [
                {"key": "a.assembly.starved_min", "value": sim.run(params())["stations"][2]["starved_min"]}],
                "consequence": "Потерян выпуск"}],
            "proposal": {"field": "buffers.1.initial", "value": 8, "rationale": "Больше запаса перед сборкой"},
        }
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response(json.dumps(answer))) as post:
            out = service.propose(params())
        self.assertEqual(out["ai"]["source"], "live")
        self.assertTrue(out["ai"]["result"]["findings"][0]["verified"])
        self.assertEqual(out["b_params"]["buffers"][1]["initial"], 8)
        sent = post.call_args.kwargs["json"]
        self.assertNotIn("origin", json.dumps(sent, ensure_ascii=False))

    @override_settings(AI={**LIVE, "ALLOW_EXTERNAL": False})
    def test_external_call_requires_explicit_permission(self):
        with mock.patch("twin.ai.providers.httpx.post") as post:
            out = service.propose(params())
        post.assert_not_called()
        self.assertEqual(out["ai"]["error_code"], "not_allowed")


@override_settings(AI=DEMO)
class ApiTests(SimpleTestCase):
    def test_endpoints(self):
        self.assertEqual(self.client.get("/api/overview/?date=2026-10-01").json()["date"], "2026-10-01")
        p = self.client.get("/api/scenario/preset/").json()["params"]
        r = self.client.post("/api/scenario/run/", {"params": p}, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        bad = self.client.post("/api/scenario/run/", {"params": {**p, "horizon_min": -1}},
                               content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("horizon_min", bad.json()["fields"])
        status = self.client.get("/api/ai/status/").json()
        self.assertEqual(status["provider"], "demo")


@override_settings(AI=LIVE)
class SavedAnswerTests(SimpleTestCase):
    def test_live_answer_is_saved_and_replayed_only_for_same_facts(self):
        import tempfile
        from pathlib import Path
        from twin.ai import saved_answers

        answer = {"summary": "s", "findings": [{"observation": "o", "evidence": [{"key": "a.horizon_min", "value": 480}]}]}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(saved_answers, "DIR", Path(tmp)):
            with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response(json.dumps(answer))):
                service.explain(params(), params())
            saved = list(Path(tmp).glob("*.json"))
            self.assertEqual(len(saved), 1)
            self.assertNotIn("test-key", saved[0].read_text(encoding="utf-8"))

            with override_settings(AI={**LIVE, "PROVIDER": "saved"}):
                same = service.explain(params(), params())
                other_b = params()
                other_b["stoppage"]["duration_min"] = 10
                other = service.explain(params(), other_b)
        self.assertEqual(same["ai"]["source"], "saved")
        self.assertEqual(same["ai"]["model"], "test-model")
        # Нет сохранённого ответа на эти факты — шаблон с честной пометкой «демо».
        self.assertEqual(other["ai"]["status"], "ok")
        self.assertEqual(other["ai"]["source"], "demo")
        self.assertEqual(other["ai"]["fallback"], "no_saved")


@override_settings(AI=LIVE)
class MultiProposalTests(SimpleTestCase):
    def test_server_simulates_each_proposal_and_picks_best(self):
        answer = {
            "summary": "s",
            "findings": [{"observation": "o", "evidence": [{"key": "a.horizon_min", "value": 480}]}],
            "proposals": [
                {"field": "buffers.0.capacity", "value": 9, "rationale": "r1"},
                {"field": "stoppage.duration_min", "value": 20, "rationale": "r2"},
                {"field": "horizon_min", "value": 900, "rationale": "запрещено"},
            ],
        }
        with mock.patch("twin.ai.providers.httpx.post", return_value=chat_response(json.dumps(answer))):
            out = service.propose(params())
        props = out["ai"]["result"]["proposals"]
        self.assertEqual([p["accepted"] for p in props], [True, True, False])
        self.assertTrue(all("delta_output" in p for p in props if p["accepted"]))
        best = max((p for p in props if p["accepted"]), key=lambda p: (p["delta_output"], -p["delta_idle_min"]))
        self.assertTrue(best["best"])
        self.assertEqual(out["comparison"]["delta"]["output_units"], best["delta_output"])
        self.assertEqual(out["ai"]["result"]["proposal"], best)


class InlineEvidenceTests(SimpleTestCase):
    def test_evidence_written_into_text_is_extracted(self):
        r = sim.run(params())
        facts = contract.build_facts(r)
        text = json.dumps({"summary": "итог evidence: [{\"key\":\"a.horizon_min\",\"value\":480}]", "findings": [
            {"observation": "Сборка стоит evidence: [{\"key\":\"a.output_units\",\"value\":%d}]" % r["output_units"]}]})
        parsed = contract.parse_response(text, facts, {})
        self.assertEqual(parsed["summary"], "итог")
        self.assertEqual(parsed["findings"][0]["observation"], "Сборка стоит")
        self.assertTrue(parsed["findings"][0]["verified"])
