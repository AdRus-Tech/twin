"""Мониторинг оборудования на демонстрационной смене: риск отказа по сохранённой модели."""
import json
from functools import lru_cache
from pathlib import Path

from . import model as M
from . import telemetry as T

MODEL_FILE = Path(__file__).resolve().parent / "model.json"
SUFFIX = {"15": "последние 15 мин", "60": "последний час", "slope": "рост за 15 мин", "sd": "разброс за час"}


@lru_cache(maxsize=1)
def load_meta() -> dict:
    return json.loads(MODEL_FILE.read_text(encoding="utf-8"))


def _explain(eq, contributions, x, names):
    """Три главных вклада в риск человеческим языком."""
    channels = {c.key: c for c in eq.channels}
    out = []
    for name, value in contributions[:3]:
        if value <= 0.2:
            continue
        if name == "since_maint":
            out.append({"text": "давно не было ремонта", "weight": round(value, 2)})
            continue
        key, part = name.rsplit("_", 1)
        c = channels[key]
        rel = x[names.index(name)]
        if part in ("15", "60"):
            text = f"{c.name} {'выше' if rel > 0 else 'ниже'} нормы на {abs(rel) * 100:.0f}% ({SUFFIX[part]})"
        else:
            text = f"{c.name}: {SUFFIX[part]}"
        out.append({"text": text, "weight": round(value, 2)})
    return out


@lru_cache(maxsize=1)
def demo_monitor() -> dict:
    """Риск по каждой единице оборудования на смене (шаг 5 мин) и предупреждения."""
    meta = load_meta()
    shift = T.demo_shift()
    w0 = T.WARMUP_MIN
    equipment = []
    for eq in T.EQUIPMENT:
        cfg = meta["equipment"][eq.id]
        mdl = M.LogisticModel.from_dict(cfg["model"])
        s = shift[eq.id]
        risk = M.risk_series(mdl, s)
        names = mdl.names
        alarms = []
        if cfg["predictable"]:
            for a in M.alarms(s, risk, cfg["threshold"]):
                if a["start"] < w0:
                    continue
                x = M.features_at(s, a["index"])
                alarms.append({
                    "t": a["start"] - w0,
                    "risk": round(risk[a["index"]], 3),
                    "why": _explain(eq, mdl.contributions(x), x, names),
                })
        points = []
        for i, t in enumerate(s.t):
            if t < w0:
                continue
            p = risk[i]
            points.append({
                "t": t - w0,
                "risk": None if p is None else round(p, 3),
                "sensors": {c.key: round(s.values[c.key][i], 2) for c in eq.channels},
                "running": s.running[i],
            })
        equipment.append({
            "id": eq.id, "name": eq.name, "station": eq.station, "failure": eq.failure,
            "repair_min": eq.repair_min, "planned_min": eq.planned_min,
            "channels": [{"key": c.key, "name": c.name, "unit": c.unit, "norm": c.norm} for c in eq.channels],
            "predictable": cfg["predictable"], "threshold": cfg["threshold"], "background": cfg["background"],
            "metrics": cfg["test"], "baseline": cfg["baseline"],
            "points": points, "alarms": alarms,
            # Отказ, заложенный в демонстрационную смену (для проверки предупреждения задним числом).
            "failures": [f - w0 for f in s.failures if f >= w0],
        })
    return {
        "kind": "ml",
        "data": meta["data"], "method": meta["method"], "trained_at": meta["trained_at"],
        "horizon_min": meta["horizon_min"], "step_min": meta["step_min"],
        "shift_min": T.SHIFT_MIN, "equipment": equipment,
    }
