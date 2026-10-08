"""Контракт обмена с языковой моделью.

Модель получает плоский словарь фактов (ключ → число), посчитанных симулятором,
и обязана ссылаться на эти ключи. Ответ модели — недоверенные данные:
мы разбираем только JSON, проверяем типы, длины, ссылки на факты
и допустимость предложенного изменения параметров.
"""
import copy
import json
import math
import re

from ..simulation import LIMITS

MAX_TEXT = 600
MAX_FINDINGS = 6
MAX_EVIDENCE = 4
VALUE_TOLERANCE = 0.051
MAX_PROPOSALS = 3
MIN_REPAIR_MIN = 10

STATE_NAMES = {"down": "остановка", "blocked": "блокировка", "starved": "нет потока"}

SYSTEM_PROMPT = """Ты помогаешь руководителю смены разбирать результаты расчётной модели
последовательной производственной цепочки. Все числа посчитал симулятор; ты их не меняешь
и не придумываешь новых чисел (выпуск, длительности, вероятности отказов).

Правила:
- Используй только факты из блока FACTS. Каждое наблюдение подкрепляй ссылками
  evidence: [{"key": <ключ из FACTS>, "value": <значение из FACTS>}].
- Не утверждай причинные связи, которых нет в фактах. Модель не учитывает брак,
  партии, переналадки, транспорт и случайные отказы.
- Определения: blocked_min — операция стоит, потому что буфер ПОСЛЕ неё заполнен
  (вторичный простой выше по потоку); starved_min — операция стоит, потому что буфер
  ПЕРЕД ней пуст (вторичный простой ниже по потоку); down_min — заданная остановка.
  buffers.N.max — наибольшая очередь, buffers.N.min — наименьший запас.
- Остановленная операция указана в STOPPAGE. Не путай её с операциями, которые стоят
  из-за блокировки или нехватки потока.
- Операции называй по-русски, как в скобках в CHAIN (Сварка, Окраска, Сборка), а не id.
- Предложение должно быть реалистичным вариантом для проверки на участке (например,
  более короткий ремонт в пределах диапазона или иной запас/вместимость буфера), а не
  крайним значением диапазона только ради лучшего числа.
- Ссылки на факты клади ТОЛЬКО в отдельное поле evidence (массив объектов), не вписывай
  их и слово evidence в текст observation/consequence/summary.
- Пиши по-русски для руководителя без технической подготовки: простые слова, без id
  и англицизмов в тексте; 1–2 коротких предложения на пункт. Вместо
  «блокировка» можно писать «стоит — некуда отдать», вместо «нехватка потока» —
  «стоит — нет кузовов», вместо «буфер» — «накопитель». Числа округляй до целых минут.
- Пиши по-русски, коротко и предметно, без рекламных оборотов.
- Ответ — только JSON-объект без пояснений и без markdown.

Схема ответа:
{
  "summary": "1–2 предложения",
  "findings": [
    {"observation": "...", "evidence": [{"key": "...", "value": 0}], "consequence": "..."}
  ],
  "proposals": [{"field": "<одно из ALLOWED_FIELDS>", "value": <целое>, "rationale": "..."}],
  "assumptions": ["..."],
  "limitations": ["..."]
}
"""

TASK_PROPOSE = """Задача: по фактам сценария A объясни, где возникают блокировка и нехватка
входящего потока, когда они начинаются и как связаны с остановкой. Предложи 2–3 РАЗНЫХ
изменения параметров из ALLOWED_FIELDS (каждое — одно поле), которые могут снизить потери
выпуска; сервер пересчитает каждое и выберет лучшее. Это условные сценарии для проверки,
а не рекомендации к действию.
Текст читает руководитель смены: не называй вариант буквой — пиши «без мер», а не «сценарий A»."""

TASK_EXPLAIN = """Задача: сравни сценарии A и B по фактам (ключи delta.* — это B минус A).
Объясни, что изменилось в выпуске, блокировке, нехватке потока и очередях, какие входные
параметры различаются и какие ограничения у вывода. Поле proposals верни пустым списком.
Текст читает руководитель смены: не называй варианты буквами — A это «без мер», B — «с рекомендацией»."""


def allowed_fields(params: dict) -> dict:
    """Поля, которые ИИ может предложить изменить, и их допустимые диапазоны."""
    fields = {}
    stop = params.get("stoppage")
    if stop and stop.get("duration_min", 0) > 0:
        # Только более короткое восстановление: доступность такого ремонта не подтверждена,
        # поэтому это условный сценарий.
        # Нижняя граница 10 мин: почти нулевой ремонт — это отмена остановки, а не вариант действий.
        fields["stoppage.duration_min"] = (min(MIN_REPAIR_MIN, stop["duration_min"]), stop["duration_min"])
    for i, _ in enumerate(params.get("buffers", [])):
        fields[f"buffers.{i}.capacity"] = LIMITS["capacity"]
        fields[f"buffers.{i}.initial"] = LIMITS["initial"]
    return fields


def apply_proposal(params: dict, field: str, value: int) -> dict:
    out = copy.deepcopy(params)
    out.pop("label", None)
    if field == "stoppage.duration_min":
        out["stoppage"]["duration_min"] = value
    else:
        _, idx, key = field.split(".")
        out["buffers"][int(idx)][key] = value
    return out


def _scenario_facts(prefix: str, result: dict) -> dict:
    f = {}
    p = result["params"]
    f[f"{prefix}.horizon_min"] = p["horizon_min"]
    if p.get("stoppage"):
        f[f"{prefix}.stoppage.start_min"] = p["stoppage"]["start_min"]
        f[f"{prefix}.stoppage.duration_min"] = p["stoppage"]["duration_min"]
    for s in p["stations"]:
        f[f"{prefix}.param.{s['id']}.cycle_s"] = s["cycle_s"]
    for i, b in enumerate(p["buffers"]):
        f[f"{prefix}.param.buffers.{i}.capacity"] = b["capacity"]
        f[f"{prefix}.param.buffers.{i}.initial"] = b["initial"]
    f[f"{prefix}.output_units"] = result["output_units"]
    for s in result["stations"]:
        for k in ("blocked_min", "starved_min", "down_min", "first_blocked_min", "first_starved_min"):
            if s[k] is not None:
                f[f"{prefix}.{s['id']}.{k}"] = s[k]
    for b in result["buffers"]:
        for k in ("max", "max_at_min", "min", "min_at_min", "final"):
            f[f"{prefix}.buffers.{b['index']}.{k}"] = b[k]
    return f


def build_facts(a: dict, b: dict | None = None, comparison: dict | None = None) -> dict:
    facts = _scenario_facts("a", a)
    if b is not None:
        facts.update(_scenario_facts("b", b))
    if comparison is not None:
        for k, v in comparison["delta"].items():
            facts[f"delta.{k}"] = v
        for s in comparison["per_station"]:
            facts[f"delta.{s['id']}.blocked_min"] = s["blocked_min"]
            facts[f"delta.{s['id']}.starved_min"] = s["starved_min"]
    return facts


def describe_chain(result: dict) -> str:
    stations = result["params"]["stations"]
    names = [f"{s['id']} ({s['name']})" for s in stations]
    text = " → ".join(names) + ". " + "; ".join(
        f"buffers.{i} стоит между {stations[i]['id']} и {stations[i + 1]['id']}" for i in range(len(stations) - 1)) + "."
    stop = result["params"].get("stoppage")
    if stop and stop["duration_min"] > 0:
        name = next(s["name"] for s in stations if s["id"] == stop["station"])
        text += ("\nSTOPPAGE (сценарий A): "
                 f"полная остановка операции {stop['station']} ({name}) "
                 f"с {stop['start_min']}-й минуты на {stop['duration_min']} мин. Остальные операции исправны.")
    return text


def build_messages(task: str, facts: dict, chain: str, fields: dict) -> list[dict]:
    allowed = {k: {"min": lo, "max": hi} for k, (lo, hi) in fields.items()}
    user = (
        f"{TASK_PROPOSE if task == 'propose' else TASK_EXPLAIN}\n\n"
        f"CHAIN: {chain}\n"
        f"ALLOWED_FIELDS: {json.dumps(allowed, ensure_ascii=False)}\n"
        f"FACTS: {json.dumps(facts, ensure_ascii=False)}"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


class ContractError(ValueError):
    pass


def _extract_json(text: str) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise ContractError("пустой ответ")
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ContractError("в ответе нет JSON-объекта")
    try:
        data = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ContractError(f"JSON не разобран: {exc.msg}") from None
    if not isinstance(data, dict):
        raise ContractError("ожидался JSON-объект")
    return data


def _text(value, limit: int = MAX_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _number(value):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or (isinstance(value, float) and not math.isfinite(value))):
        return None
    return value


_INLINE_EVIDENCE = re.compile(r"\s*evidence\s*:\s*(\[.*\])\s*$", re.IGNORECASE | re.DOTALL)


def _split_inline_evidence(text):
    """Модель иногда вписывает «evidence: [...]» в конец текста — отделяем и разбираем."""
    if not isinstance(text, str):
        return text, []
    m = _INLINE_EVIDENCE.search(text)
    if not m:
        return text, []
    try:
        items = json.loads(m.group(1))
    except json.JSONDecodeError:
        return text[:m.start()], []
    return text[:m.start()], items if isinstance(items, list) else []


def _check_proposal(raw_prop: dict, fields: dict) -> dict:
    field = _text(raw_prop.get("field"), 60)
    value = _number(raw_prop.get("value"))
    proposal = {"field": field, "value": value, "rationale": _text(raw_prop.get("rationale")),
                "accepted": False, "reason": None}
    if field not in fields:
        proposal["reason"] = "поле не входит в список разрешённых"
    elif value is None or value != int(value):
        proposal["reason"] = "значение должно быть целым числом"
    else:
        lo, hi = fields[field]
        if not lo <= int(value) <= hi:
            proposal["reason"] = f"значение вне диапазона {lo}–{hi}"
        else:
            proposal["value"] = int(value)
            proposal["accepted"] = True
    return proposal


def parse_response(text: str, facts: dict, fields: dict) -> dict:
    """Разбирает ответ модели. Бросает ContractError, если структура непригодна."""
    data = _extract_json(text)
    summary = _text(_split_inline_evidence(data.get("summary"))[0])
    raw_findings = data.get("findings")
    if not summary or not isinstance(raw_findings, list):
        raise ContractError("нет обязательных полей summary/findings")

    findings = []
    for item in raw_findings[:MAX_FINDINGS]:
        if not isinstance(item, dict):
            continue
        raw_obs, inline = _split_inline_evidence(item.get("observation"))
        raw_evidence = item.get("evidence") or inline
        if not isinstance(raw_evidence, list):
            raise ContractError("evidence должен быть массивом")
        evidence = []
        for ev in raw_evidence[:MAX_EVIDENCE]:
            if not isinstance(ev, dict):
                continue
            key = _text(ev.get("key"), 80)
            claimed = _number(ev.get("value"))
            actual = facts.get(key)
            ok = actual is not None and claimed is not None and abs(claimed - actual) <= VALUE_TOLERANCE
            evidence.append({"key": key, "claimed": claimed, "actual": actual, "verified": ok})
        observation = _text(raw_obs)
        if not observation:
            continue
        findings.append({
            "observation": observation,
            "consequence": _text(item.get("consequence")),
            "evidence": evidence,
            "verified": bool(evidence) and all(e["verified"] for e in evidence),
        })
    if not findings:
        raise ContractError("нет ни одного корректного наблюдения")

    raw_props = data.get("proposals")
    if not isinstance(raw_props, list):
        raw_props = [data["proposal"]] if isinstance(data.get("proposal"), dict) else []
    proposals = []
    seen = set()
    for raw_prop in raw_props[:MAX_PROPOSALS]:
        if not isinstance(raw_prop, dict):
            continue
        proposal = _check_proposal(raw_prop, fields)
        key = (proposal["field"], proposal["value"])
        if key in seen:
            continue
        seen.add(key)
        proposals.append(proposal)
    accepted = [p for p in proposals if p["accepted"]]

    for key in ("assumptions", "limitations"):
        if data.get(key) is not None and not isinstance(data[key], list):
            raise ContractError(f"{key} должен быть массивом")

    return {
        "summary": summary,
        "findings": findings,
        "proposals": proposals,
        # Для совместимости: лучшее принятое (сервис уточнит после пересчёта).
        "proposal": accepted[0] if accepted else (proposals[0] if proposals else None),
        "assumptions": [_text(x) for x in (data.get("assumptions") or [])[:6] if _text(x)],
        "limitations": [_text(x) for x in (data.get("limitations") or [])[:6] if _text(x)],
    }
