"""Сообщение с линии свободным текстом → событие смены.

Рабочий пишет как есть («на сборке порвалась цепь, минут на 40»). Языковая
модель (если подключена) превращает текст в поля события; ответ проверяется:
участок — только из списка, длительность — целое в разумных пределах. Без
модели и при любой ошибке работает разбор по правилам. Поля, которые не
удалось понять, возвращаются в `missing` — их уточняет руководитель.
"""
import json
import re

from .providers import ProviderError, get_provider

STATIONS = {"welding": "Сварка", "painting": "Окраска", "assembly": "Сборка"}
DURATION_LIMITS = (1, 480)

# Оборудование из демонстрационного журнала простоев и его участок.
EQUIPMENT_PATTERNS = [
    (re.compile(r"(?:abb|абб)\s*-?\s*0?(\d)"), "ABB-0{}", "welding"),
    (re.compile(r"камер\w*\s*-?\s*0?(\d)"), "Камера-0{}", "painting"),
    (re.compile(r"конвейер\w*\s*-?\s*0?(\d)"), "Конвейер-0{}", "assembly"),
]
STATION_WORDS = [
    ("welding", ("свар",)),
    ("painting", ("окрас", "покрас", "краск", "камер")),
    ("assembly", ("сбор", "конвейер")),
]
# Причина: первое совпадение по ключевому слову → короткая формулировка.
REASONS = [
    (("обрыв", "порвал", "лопнул"), "обрыв цепи"),
    (("фильтр",), "замена фильтра"),
    (("датчик",), "ошибка датчика"),
    (("засор",), "засор"),
    (("перегрев",), "перегрев"),
    (("утечк", "течёт", "течет"), "утечка"),
    (("заклин",), "заклинивание"),
    (("электр", "питани", "свет"), "нет питания"),
    ((" то ", "техобслуж", "обслуживан"), "плановое ТО"),
    (("комплект", "детал", "нехватк"), "нет комплектующих"),
    (("краск",), "нет краски"),
    (("робот",), "сбой робота"),
]
WORD_HOURS = ((r"\bпол\s?часа\b", 30), (r"\bполтора\s+часа\b", 90), (r"\bчас\b", 60))


def parse_rules(text: str) -> dict:
    t = " " + str(text).lower().replace("ё", "е") + " "
    equipment, station = "", None
    for rx, fmt, st in EQUIPMENT_PATTERNS:
        m = rx.search(t)
        if m:
            equipment, station = fmt.format(m.group(1)), st
            break
    if station is None:
        for st, words in STATION_WORDS:
            if any(w in t for w in words):
                station = st
                break

    duration = None
    hours = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:ч\b|час)", t)
    minutes = re.search(r"(\d+)\s*(?:мин|м\b)", t) or re.search(r"мин\w*\s+(?:на|по|около|где-то)?\s*(\d+)", t)
    if hours or minutes:
        duration = 0
        if hours:
            duration += round(float(hours.group(1).replace(",", ".")) * 60)
        if minutes:
            duration += int(minutes.group(1))
    else:
        for pattern, mins in WORD_HOURS:
            if re.search(pattern, t):
                duration = mins
                break

    reason = ""
    for keys, label in REASONS:
        if any(k in t for k in keys):
            reason = label
            break
    if not reason:
        reason = "остановка"
    return _finish({"station": station, "equipment": equipment, "reason": reason, "duration_min": duration}, "rules")


def _finish(fields: dict, source: str, model: str | None = None) -> dict:
    station = fields.get("station") if fields.get("station") in STATIONS else None
    duration = fields.get("duration_min")
    if not (isinstance(duration, int) and not isinstance(duration, bool) and DURATION_LIMITS[0] <= duration <= DURATION_LIMITS[1]):
        duration = None
    out = {
        "station": station,
        "station_name": STATIONS.get(station),
        "equipment": str(fields.get("equipment") or "")[:40],
        "reason": str(fields.get("reason") or "")[:80],
        "duration_min": duration,
        "source": source,
    }
    if model:
        out["model"] = model
    out["missing"] = [k for k in ("station", "duration_min") if out[k] is None]
    return out


def _messages(text: str) -> list:
    system = (
        "Ты разбираешь сообщение рабочего автомобильного завода о поломке на линии. "
        "Участки: welding — Сварка, painting — Окраска, assembly — Сборка. "
        "Оборудование из журнала: ABB-01 и ABB-04 (сварка), Камера-02 (окраска), Конвейер-03 (сборка). "
        "Верни только JSON: {\"station\": \"welding|painting|assembly\" или null, "
        "\"equipment\": строка или \"\", \"reason\": короткая причина 2–4 слова, "
        "\"duration_min\": целое число минут ремонта или null}. Ничего не придумывай: если не сказано — null."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": str(text)[:500]}]


def parse_report(text: str) -> dict:
    """Разбор сообщения: языковая модель, если подключена, иначе правила. Пропуски модели добирают правила."""
    rules = parse_rules(text)
    try:
        provider = get_provider()
    except ProviderError:
        return rules
    if not provider.live:
        return rules
    try:
        raw = provider.complete(_messages(text), task="report", facts={}, fields={}, names=STATIONS)
        data = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
        if not isinstance(data, dict):
            raise ValueError("не объект")
        duration = data.get("duration_min")
        if isinstance(duration, float) and duration.is_integer():
            duration = int(duration)
        valid_duration = isinstance(duration, int) and not isinstance(duration, bool) and \
            DURATION_LIMITS[0] <= duration <= DURATION_LIMITS[1]
        # Каждое поле модели проверяется; неверное или пустое заменяется разбором по правилам.
        merged = {
            "station": data.get("station") if data.get("station") in STATIONS else rules["station"],
            "equipment": data.get("equipment") if isinstance(data.get("equipment"), str) and data.get("equipment") else rules["equipment"],
            "reason": data.get("reason") if isinstance(data.get("reason"), str) and data.get("reason").strip() else rules["reason"],
            "duration_min": duration if valid_duration else rules["duration_min"],
        }
        return _finish(merged, "ai", provider.model)
    except (ProviderError, ValueError, TypeError, KeyError):
        return rules
