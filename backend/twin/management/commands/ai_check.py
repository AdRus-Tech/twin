"""Проверка связи с облачным провайдером: python manage.py ai_check

Ключ не выводится. Отправляется только синтетический сценарий из simulation.DEFAULT_PRESET.
"""
import copy

import httpx
from django.conf import settings
from django.core.management.base import BaseCommand

from twin import simulation
from twin.ai import service
from twin.ai.providers import provider_status


class Command(BaseCommand):
    help = "Проверить настройку AI-провайдера и выполнить тестовый запрос"

    def add_arguments(self, parser):
        parser.add_argument("--models", action="store_true", help="показать доступные модели (GET /models)")

    def handle(self, *args, **opts):
        cfg = settings.AI
        status = provider_status()
        self.stdout.write(f"provider={status['provider']} model={status['model']} ready={status['ready']} "
                          f"key_set={'yes' if cfg['API_KEY'] else 'no'} external_allowed={cfg['ALLOW_EXTERNAL']}")
        if not status["ready"]:
            self.stderr.write(f"Не готов: {status['error']}")
            return
        if opts["models"]:
            resp = httpx.get(f"{cfg['BASE_URL'].rstrip('/')}/models",
                             headers={"Authorization": f"Bearer {cfg['API_KEY']}"}, timeout=cfg["TIMEOUT_S"])
            self.stdout.write(f"GET /models -> HTTP {resp.status_code}")
            if resp.is_success:
                ids = sorted(m["id"] for m in resp.json().get("data", []))
                self.stdout.write(", ".join(i for i in ids if i.startswith(("gpt-", "o"))))
            return

        params = copy.deepcopy(simulation.DEFAULT_PRESET)
        params.pop("label")
        out = service.propose(params)
        ai = out["ai"]
        self.stdout.write(f"propose: status={ai['status']} source={ai.get('source')} {ai.get('error') or ''}")
        if ai["status"] == "ok":
            r = ai["result"]
            self.stdout.write(f"  summary: {r['summary']}")
            for f in r["findings"]:
                self.stdout.write(f"  [{'OK' if f['verified'] else '??'}] {f['observation']}")
            self.stdout.write(f"  proposal: {r['proposal']}")
        if out["b_params"]:
            exp = service.explain(params, out["b_params"])["ai"]
            self.stdout.write(f"explain: status={exp['status']} {exp.get('error') or ''}")
            if exp["status"] == "ok":
                self.stdout.write(f"  summary: {exp['result']['summary']}")
                for f in exp["result"]["findings"]:
                    self.stdout.write(f"  [{'OK' if f['verified'] else '??'}] {f['observation']}")
