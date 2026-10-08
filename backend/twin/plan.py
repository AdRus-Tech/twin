"""Исходные данные для прогноза месячного плана.

План по моделям — из демонстрационных данных. Сбои берутся из демонстрационного журнала простоев (4 записи за 2 дня), их частота — из
того же журнала. Потери машин от каждого сбоя без мер и с рекомендацией
считает модель линии: остановка в разное время смены, среднее по пяти
моментам. Сам прогноз месяца (Монте-Карло по сменам) считает интерфейс по
этой таблице — расчёт быстрый и одинаковый для сервера и автономной версии.
"""
import copy
from functools import lru_cache

from . import dataset, simulation

SECTION_TO_STATION = {"Сварка": "welding", "Окраска": "painting", "Сборка": "assembly"}
# Мера по причине из журнала: срок ремонта с мерой и формулировка.
MEASURES = {
    "Ошибка датчика": (10, "запасной датчик у линии"),
    "Замена фильтра": (15, "плановая замена по предупреждению ML"),
    "Обрыв цепи": (20, "плановая замена цепи по предупреждению ML"),
    "Плановое ТО": (0, "ТО на пересменке"),
}
STARTS = (60, 150, 240, 330, 420)


def _params(stoppage=None) -> dict:
    p = copy.deepcopy(simulation.DEFAULT_PRESET)
    p.pop("label", None)
    p["stoppage"] = stoppage
    return p


def _idle(run: dict) -> float:
    return sum(s["blocked_min"] + s["starved_min"] for s in run["stations"])


@lru_cache(maxsize=1)
def month_inputs() -> dict:
    ds = dataset.load_dataset()
    base = simulation.run(_params())
    base_out, base_idle = base["output_units"], _idle(base)
    events = []
    for d in ds["downtimes"]:
        station = SECTION_TO_STATION[d["section"]]
        rec_dur, rec_text = MEASURES.get(d["reason"], (max(5, d["minutes"] // 2), "ускоренный ремонт"))
        loss = {"none": [], "rec": []}
        idle = {"none": [], "rec": []}
        for start in STARTS:
            for key, dur in (("none", d["minutes"]), ("rec", rec_dur)):
                run = simulation.run(_params({"station": station, "start_min": start, "duration_min": dur}))
                loss[key].append(base_out - run["output_units"])
                idle[key].append(_idle(run) - base_idle)
        avg = lambda xs: round(sum(xs) / len(xs), 2)
        events.append({
            "equipment": d["equipment"], "station": station, "station_name": d["section"],
            "reason": d["reason"], "duration_min": d["minutes"], "rec_duration_min": rec_dur, "rec_text": rec_text,
            "loss_none": avg(loss["none"]), "loss_rec": avg(loss["rec"]),
            "idle_none": avg(idle["none"]), "idle_rec": avg(idle["rec"]),
        })
    dates = dataset.available_dates(ds)
    shifts_per_day = ds["targets"]["shifts_per_day"]
    stations = base["params"]["stations"]
    bottleneck = max(stations, key=lambda s: s["cycle_s"])
    return {
        "kind": "simulation",
        "target": ds["targets"]["monthly_output_min"],
        "shifts_per_day": shifts_per_day,
        "plan_per_shift": next(r["plan"] for r in ds["line_runs"] if r["line"].startswith("Сборка")),
        "base_shift": base_out,
        "horizon_min": base["params"]["horizon_min"],
        "events_per_shift": round(len(ds["downtimes"]) / (len(dates) * shifts_per_day), 3),
        "events_source": f"демонстрационный журнал простоев: {len(ds['downtimes'])} записи за {len(dates)} дня",
        "events": events,
        "bottleneck": {"id": bottleneck["id"], "name": bottleneck["name"], "cycle_s": bottleneck["cycle_s"]},
        "models": [{"model": m["model"], "units": m["units"]} for m in ds["monthly_plan"]],
    }
