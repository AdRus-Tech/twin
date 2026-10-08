"""Провайдеры текста для AI-анализа.

Граница замены — метод complete(messages, task=..., facts=..., fields=...) -> str.
Для другого API (не OpenAI-совместимого) достаточно добавить ещё один класс
с этим методом и ветку в get_provider().
"""
import json

import httpx
from django.conf import settings

from . import saved_answers


class ProviderError(Exception):
    """Ошибка обращения к провайдеру. Текст безопасен для показа пользователю."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class DemoProvider:
    """Шаблонный ответ без обращения к модели.

    Собирается правилами из тех же фактов, что получила бы модель, и проходит
    ту же проверку контракта. В интерфейсе помечается как демонстрационный.
    """

    name = "demo"
    model = "шаблон на сервере"
    live = False

    def complete(self, messages, *, task, facts, fields, names):
        if task == "propose":
            return json.dumps(self._propose(facts, fields, names), ensure_ascii=False)
        return json.dumps(self._explain(facts), ensure_ascii=False)

    @staticmethod
    def _station_findings(prefix, facts, names):
        findings = []
        for key, value in facts.items():
            if not key.startswith(prefix + ".") or not key.endswith("_min") or key.count(".") != 2:
                continue
            _, station, metric = key.split(".")
            first_key = f"{prefix}.{station}.first_{metric.split('_')[0]}_min"
            if metric == "blocked_min" and value >= 1 and first_key in facts:
                findings.append({
                    "observation": f"{names.get(station, station)}: блокировка, следующий буфер заполнен.",
                    "evidence": [{"key": key, "value": value}, {"key": first_key, "value": facts[first_key]}],
                    "consequence": "Вторичный простой выше по потоку: операция исправна, но ей некуда передать единицу.",
                })
            if metric == "starved_min" and value >= 1 and first_key in facts:
                findings.append({
                    "observation": f"{names.get(station, station)}: простой без входящего потока.",
                    "evidence": [{"key": key, "value": value}, {"key": first_key, "value": facts[first_key]}],
                    "consequence": "Вторичный простой ниже по потоку: промежуточный запас израсходован.",
                })
        return findings

    @staticmethod
    def _spread(prefix, facts, names):
        """Кто из соседей простаивает: одна фраза без чисел (числа — в наблюдениях со ссылками)."""
        starved, blocked = [], []
        for key, value in facts.items():
            if not key.startswith(prefix + ".") or key.count(".") != 2 or value < 1:
                continue
            _, station, metric = key.split(".")
            if metric == "starved_min":
                starved.append(names.get(station, station))
            if metric == "blocked_min":
                blocked.append(names.get(station, station))
        parts = []
        if starved:
            parts.append(f"{', '.join(starved)} — ждёт кузовов")
        if blocked:
            parts.append(f"{', '.join(blocked)} — некуда отдать")
        if not parts:
            return "Остановку держат накопители: соседние участки не простаивают."
        return "Остановка расходится по цепочке: " + "; ".join(parts) + "."

    def _propose(self, facts, fields, names):
        findings = []
        if "a.stoppage.duration_min" in facts:
            findings.append({
                "observation": "Заданная остановка — исходное отклонение сценария.",
                "evidence": [{"key": "a.stoppage.start_min", "value": facts["a.stoppage.start_min"]},
                             {"key": "a.stoppage.duration_min", "value": facts["a.stoppage.duration_min"]}],
                "consequence": "Пока операция стоит, очередь перед ней растёт, а запас после неё расходуется.",
            })
        findings += self._station_findings("a", facts, names)
        proposals = []
        if "stoppage.duration_min" in fields:
            lo, current = fields["stoppage.duration_min"]
            proposals.append({
                "field": "stoppage.duration_min",
                "value": max(lo, current // 2),
                "rationale": "Вдвое более короткий ремонт: резервная бригада или запчасть у линии.",
            })
        if "buffers.1.initial" in fields and "a.param.buffers.1.capacity" in facts:
            proposals.append({
                "field": "buffers.1.initial",
                "value": int(facts["a.param.buffers.1.capacity"]),
                "rationale": "Полный накопитель перед сборкой в начале смены дольше кормит сборку во время остановки.",
            })
        if "buffers.0.capacity" in fields and "a.param.buffers.0.capacity" in facts:
            proposals.append({
                "field": "buffers.0.capacity",
                "value": int(facts["a.param.buffers.0.capacity"]) + 4,
                "rationale": "Больше мест перед окраской — сварка дольше работает, пока окраска стоит.",
            })
        return {
            "summary": self._spread("a", facts, names) + " Проверил меры: короче ремонт, запас и места в накопителях — "
                       "каждую пересчитала модель линии.",
            "findings": findings,
            "proposals": proposals,
            "assumptions": ["Остановка полная, время начала задано пользователем."],
            "limitations": ["Модель не учитывает брак, партии, переналадки и транспорт."],
        }

    def _explain(self, facts):
        findings = []
        for key, label, unit in (("delta.output_units", "Выпуск на выходе цепочки", "ед."),
                                 ("delta.blocked_min", "Суммарная блокировка", "мин"),
                                 ("delta.starved_min", "Суммарная нехватка потока", "мин"),
                                 ("delta.max_queue", "Максимальная очередь", "ед.")):
            if key in facts:
                v = facts[key]
                amount = f"{abs(v):g}".replace(".", ",")
                direction = "с мерой без изменений" if v == 0 else (
                    f"с мерой больше на {amount} {unit}" if v > 0 else f"с мерой меньше на {amount} {unit}")
                findings.append({
                    "observation": f"{label}: {direction}.",
                    "evidence": [{"key": key, "value": v}],
                    "consequence": "Разница — эффект меры по модели линии.",
                })
        return {
            "summary": "Эффект меры по модели линии: что изменилось в выпуске, простоях и очередях.",
            "findings": findings,
            "proposals": [],
            "assumptions": ["Параметры обоих сценариев заданы пользователем или синтетическим примером."],
            "limitations": ["Выход последней операции не равен отгрузке годных автомобилей."],
        }


class SavedProvider:
    """Повтор ранее полученного живого ответа модели для резервной демонстрации.

    Ответ отдаётся, только если факты запроса совпадают с фактами, на которые
    модель отвечала. Источник явно помечается как сохранённый.
    """

    name = "saved"
    live = False

    def __init__(self):
        self.model = None
        self.saved_at = None

    def complete(self, messages, *, task, facts, fields, names):
        record = saved_answers.load(task, facts)
        if record is None:
            raise ProviderError("no_saved", "Нет сохранённого ответа модели для этих параметров")
        self.model, self.saved_at = record["model"], record["requested_at"]
        return record["text"]


class OpenAICompatibleProvider:
    """POST {base_url}/chat/completions в формате OpenAI Chat Completions.

    Подходит только тем провайдерам, которые явно поддерживают этот формат.
    """

    name = "openai_compatible"
    live = True

    def __init__(self, base_url: str, model: str, api_key: str, timeout_s: float, json_mode: bool,
                 temperature: str = ""):
        self.base_url = base_url.rstrip("/")
        self.temperature = float(temperature) if temperature else None
        self.model = model
        self._api_key = api_key
        self.timeout_s = timeout_s
        self.json_mode = json_mode

    def complete(self, messages, *, task, facts, fields, names):
        body = {"model": self.model, "messages": messages}
        if self.temperature is not None:
            body["temperature"] = self.temperature
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            resp = httpx.post(
                f"{self.base_url}/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=self.timeout_s,
            )
        except httpx.TimeoutException:
            raise ProviderError("timeout", f"Провайдер не ответил за {self.timeout_s:g} с") from None
        except httpx.HTTPError as exc:
            raise ProviderError("network", f"Сетевая ошибка: {type(exc).__name__}") from None
        if resp.status_code in (401, 403):
            raise ProviderError("auth", "Провайдер отклонил ключ или доступ (HTTP %d)" % resp.status_code)
        if resp.status_code == 429:
            raise ProviderError("rate_limit", "Превышен лимит запросов провайдера (HTTP 429)")
        if resp.status_code >= 400:
            raise ProviderError("http", f"Провайдер вернул HTTP {resp.status_code}{_error_detail(resp)}")
        try:
            return resp.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderError("bad_response", "Ответ провайдера не в формате Chat Completions") from None


def _error_detail(resp) -> str:
    """Короткое описание ошибки от провайдера (например, неизвестная модель). Ключ в нём не возвращается."""
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return ""
    return f": {str(message)[:200]}"


def get_provider():
    cfg = settings.AI
    if cfg["PROVIDER"] == "openai_compatible":
        if not cfg["ALLOW_EXTERNAL"]:
            raise ProviderError("not_allowed", "Отправка данных внешнему провайдеру не разрешена (AI_ALLOW_EXTERNAL)")
        missing = [k for k in ("BASE_URL", "MODEL", "API_KEY") if not cfg[k]]
        if missing:
            raise ProviderError("not_configured", "Не заданы параметры: " + ", ".join("AI_" + k for k in missing))
        return OpenAICompatibleProvider(cfg["BASE_URL"], cfg["MODEL"], cfg["API_KEY"], cfg["TIMEOUT_S"],
                                        cfg["JSON_MODE"], cfg.get("TEMPERATURE", ""))
    if cfg["PROVIDER"] == "saved":
        return SavedProvider()
    return DemoProvider()


def provider_status() -> dict:
    cfg = settings.AI
    try:
        p = get_provider()
        return {"provider": p.name, "model": p.model, "live": p.live, "ready": True, "error": None}
    except ProviderError as exc:
        return {"provider": cfg["PROVIDER"], "model": cfg["MODEL"] or None, "live": True, "ready": False,
                "error": exc.message}
