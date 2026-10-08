import json
from uuid import uuid4

from django.test import TestCase

from twin.models import Incident


def body(**changes):
    data = {
        "station": "painting", "name": "Окраска", "start": 150, "clock": "10:30", "duration": 45,
        "reason": "Замена фильтра", "equipment": "Камера-02", "priority": "high",
        "impact": {"lossCars": 7, "idleMin": 49, "output": 115},
    }
    data.update(changes)
    return data


class IncidentApiTests(TestCase):
    def post(self, data):
        return self.client.post("/api/incidents/", json.dumps(data), content_type="application/json")

    def test_create_list_numbering(self):
        r1 = self.post(body())
        r2 = self.post(body(station="assembly", name="Сборка", priority="low"))
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.json()["id"], "INC-001")
        self.assertEqual(r2.json()["id"], "INC-002")
        listed = self.client.get("/api/incidents/").json()
        self.assertEqual([i["id"] for i in listed], ["INC-002", "INC-001"])
        self.assertEqual(listed[1]["impact"], {"lossCars": 7, "idleMin": 49, "output": 115})
        self.assertEqual(listed[1]["status"], "new")

    def test_retrying_create_returns_same_incident(self):
        data = body(client_id=str(uuid4()))
        first = self.post(data)
        retry = self.post(data)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(first.json()["id"], retry.json()["id"])
        self.assertEqual(first.json()["client_id"], data["client_id"])
        self.assertEqual(Incident.objects.count(), 1)

    def test_invalid_client_id_and_enum_types_return_400(self):
        for data in (body(client_id="invalid"), body(client_id=[]), body(priority=[]), body(source={}), body(status=[])):
            with self.subTest(data=data):
                self.assertEqual(self.post(data).status_code, 400)
        inc = self.post(body()).json()
        response = self.client.patch(f"/api/incidents/{inc['n']}/", {"status": []}, content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_validation(self):
        r = self.post(body(start=-1, clock="25:00", priority="urgent", station=""))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()["fields"]), {"start", "clock", "priority", "station"})
        self.assertEqual(Incident.objects.count(), 0)

    def test_status_on_create(self):
        self.assertEqual(self.post(body(status="work")).json()["status"], "work")
        r = self.post(body(status="done"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("status", r.json()["fields"])

    def test_impact_whitelist(self):
        r = self.post(body(impact={"lossCars": 1, "evil": "<script>"}))
        self.assertEqual(r.json()["impact"], {"lossCars": 1})

    def test_status_change_and_delete(self):
        n = self.post(body()).json()["n"]
        r = self.client.patch(f"/api/incidents/{n}/", json.dumps({"status": "work"}), content_type="application/json")
        self.assertEqual(r.json()["status"], "work")
        bad = self.client.patch(f"/api/incidents/{n}/", json.dumps({"status": "done"}), content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.delete(f"/api/incidents/{n}/").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/incidents/{n}/").status_code, 404)
