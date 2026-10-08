"""Предоставленные тестовые данные и расчёты, выполненные строго по ним.

Здесь нет допущений модели: только значения источника ("source")
и прямые арифметические расчёты по ним ("derived").
"""
import json
from functools import lru_cache
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "source_dataset.json"

OEE_MISSING = [
    "плановое производственное время (период строки не указан)",
    "идеальное время цикла по операциям",
    "согласованное определение годного выпуска",
]


@lru_cache(maxsize=1)
def load_dataset() -> dict:
    with DATA_FILE.open(encoding="utf-8") as fh:
        return json.load(fh)


def pct(part: float, whole: float) -> float | None:
    """Доля в процентах без обрезки сверху: факт 121 при плане 120 даёт 100.83."""
    if not whole:
        return None
    return round(part / whole * 100, 2)


def _src(value):
    return {"value": value, "kind": "source"}


def _calc(value, formula: str):
    return {"value": value, "kind": "derived", "formula": formula}


def available_dates(ds: dict) -> list[str]:
    return sorted({row["date"] for row in ds["line_runs"]})


def _node_metrics(ds: dict, node: dict, date: str) -> dict:
    targets = ds["targets"]
    result = {"line": None, "quality": None, "downtimes": [], "flags": []}

    run = next((r for r in ds["line_runs"] if r["line"] == node.get("line") and r["date"] == date), None)
    if run:
        plan_pct = pct(run["fact"], run["plan"])
        result["line"] = {
            "plan": _src(run["plan"]),
            "fact": _src(run["fact"]),
            "hours": _src(run["hours"]),
            "load_pct": _src(run["load_pct"]),
            "plan_completion_pct": _calc(plan_pct, "факт / план × 100"),
        }
        if run["fact"] < run["plan"]:
            result["flags"].append({
                "type": "plan_shortfall",
                "severity": "warning",
                "text": f"Выпуск ниже плана: {run['fact']} из {run['plan']} ({plan_pct}%)",
            })

    q = next((r for r in ds["quality"] if r["section"] == node.get("section") and r["date"] == date), None)
    if q:
        defect_pct = pct(q["defects"], q["released"])
        rounded = round(defect_pct, 1)
        result["quality"] = {
            "released": _src(q["released"]),
            "defects": _src(q["defects"]),
            "stated_defect_pct": _src(q["stated_defect_pct"]),
            "defect_pct": _calc(defect_pct, "брак / выпущено × 100"),
            "matches_stated": abs(rounded - q["stated_defect_pct"]) < 0.051,
        }
        if defect_pct > targets["defect_limit_pct"]:
            result["flags"].append({
                "type": "defect_over_limit",
                "severity": "critical",
                "text": f"Брак {q['defects']}/{q['released']} ≈ {defect_pct:.2f}% при пороге {targets['defect_limit_pct']}%",
            })
        if not result["quality"]["matches_stated"]:
            result["flags"].append({
                "type": "stated_pct_mismatch",
                "severity": "info",
                "text": f"Указанный % брака {q['stated_defect_pct']} не совпадает с расчётом {defect_pct:.2f}",
            })

    for d in ds["downtimes"]:
        if d["section"] == node.get("section") and d["date"] == date:
            result["downtimes"].append({**d, "kind": "source"})
    total = sum(d["minutes"] for d in result["downtimes"])
    if result["downtimes"]:
        result["downtime_total_min"] = _calc(total, "сумма записей журнала по участку за дату")
    return result


def overview(date: str | None = None) -> dict:
    ds = load_dataset()
    dates = available_dates(ds)
    if date not in dates:
        date = dates[-1]
    targets = ds["targets"]

    chain = []
    for node in ds["chain"]:
        has_data = node["section"] is not None
        entry = {"id": node["id"], "name": node["name"], "has_data": has_data}
        if has_data:
            entry.update(_node_metrics(ds, node, date))
        else:
            entry["no_data_reason"] = "В предоставленных данных нет показателей по этому узлу"
        chain.append(entry)

    model_total = sum(m["units"] for m in ds["monthly_plan"])
    gap = targets["monthly_output_min"] - model_total
    plan_check = {
        "models": [{**m, "kind": "source"} for m in ds["monthly_plan"]],
        "models_total": _calc(model_total, "сумма планов по моделям"),
        "required_min": _src(targets["monthly_output_min"]),
        "gap": _calc(gap, "общий план − сумма по моделям"),
        "consistent": gap <= 0,
        "note": (
            f"Планы по моделям дают {model_total}, общий план — не менее {targets['monthly_output_min']}. "
            f"Разница {gap} не распределена по моделям: данные несогласованы или неполны."
            if gap > 0 else "План по моделям покрывает общий план."
        ),
    }

    # Сумма простоев за дату по всему журналу — справочно; к лимиту 60 мин
    # она не применяется, т.к. лимит задан для единицы критического оборудования.
    day_downtimes = [d for d in ds["downtimes"] if d["date"] == date]
    over_limit_equipment = [
        d["equipment"] for d in day_downtimes
        if d["minutes"] > targets["critical_downtime_limit_min_per_day"]
    ]

    notes = [
        ds["meta"]["aggregation_period_note"],
        "Процент загрузки передан источником; это не доступность оборудования и не OEE.",
        "Простой единицы оборудования не равен остановке линии; критичность оборудования не указана.",
        "Различия выпуска соседних участков не доказывают ошибку: возможны запасы и разные периоды учёта.",
        "Выпуск сварки, окраски и сборки нельзя складывать как число готовых автомобилей.",
    ]

    return {
        "dataset_label": "Предоставленные тестовые данные",
        "origin": ds["meta"]["origin"],
        "dates": dates,
        "date": date,
        "is_historical": True,
        "chain": chain,
        "downtime_check": {
            "limit_min": _src(targets["critical_downtime_limit_min_per_day"]),
            "day_total_min": _calc(sum(d["minutes"] for d in day_downtimes), "сумма журнала за дату, справочно"),
            "equipment_over_limit": over_limit_equipment,
            "note": "Лимит относится к критическому оборудованию; какое оборудование критично, в данных не указано.",
        },
        "plan_check": plan_check,
        "oee": {
            "status": "not_calculated",
            "target_pct": _src(targets["oee_target_pct"]),
            "missing": OEE_MISSING,
        },
        "targets": {k: _src(v) for k, v in targets.items()},
        "notes": notes,
    }
