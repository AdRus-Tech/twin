"""Признаки, модель и проверка прогноза отказов.

Модель — логистическая регрессия на стандартизованных признаках, своя реализация
без внешних библиотек: веса читаются как «какой сигнал и насколько повышает риск»,
поэтому каждое предупреждение можно объяснить. Задача: вероятность отказа
в ближайшие HORIZON_MIN минут по последним 60 минутам телеметрии.
"""
import math
import random
from statistics import fmean, pstdev

from .telemetry import STEP_MIN, Series

HORIZON_MIN = 120
WINDOW = 60 // STEP_MIN  # 12 точек = 60 мин
SHORT = 15 // STEP_MIN  # 3 точки = 15 мин


def feature_names(series: Series) -> list[str]:
    names = []
    for c in series.equipment.channels:
        names += [f"{c.key}_15", f"{c.key}_60", f"{c.key}_slope", f"{c.key}_sd"]
    return names + ["since_maint"]


def features_at(series: Series, i: int) -> list[float] | None:
    """Признаки в точке i по окну 60 мин; None — окно попадает на ремонт."""
    lo = i - WINDOW + 1
    if lo < 0 or not all(series.running[lo:i + 1]):
        return None
    out = []
    for c in series.equipment.channels:
        v = series.values[c.key]
        w = v[lo:i + 1]
        last = fmean(v[i - SHORT + 1:i + 1])
        prev = fmean(v[i - 2 * SHORT + 1:i - SHORT + 1])
        out += [last / c.norm - 1, fmean(w) / c.norm - 1, (last - prev) / c.norm, pstdev(w) / c.norm]
    return out + [series.since_maint[i] / (7 * 24 * 60)]


def labels(series: Series) -> list[int]:
    """1 — в ближайшие HORIZON_MIN минут будет отказ."""
    y = [0] * len(series.t)
    for f in series.failures:
        for i, t in enumerate(series.t):
            if f - HORIZON_MIN <= t < f:
                y[i] = 1
    return y


def dataset(series_list, neg_keep=1.0, seed=0):
    """Признаки и метки по нескольким историям; отрицательные точки можно прореживать."""
    rng = random.Random(seed)
    X, Y, W = [], [], []
    for s in series_list:
        y = labels(s)
        for i in range(len(s.t)):
            if y[i] == 0 and neg_keep < 1 and rng.random() > neg_keep:
                continue
            x = features_at(s, i)
            if x is None:
                continue
            X.append(x)
            Y.append(y[i])
            W.append(1.0 if y[i] else 1 / neg_keep)
    return X, Y, W


class LogisticModel:
    def __init__(self, names, mean=None, std=None, weights=None, bias=0.0):
        self.names = names
        self.mean = mean or [0.0] * len(names)
        self.std = std or [1.0] * len(names)
        self.weights = weights or [0.0] * len(names)
        self.bias = bias

    def _z(self, x):
        return [(a - m) / s for a, m, s in zip(x, self.mean, self.std)]

    def proba(self, x) -> float:
        z = self._z(x)
        s = self.bias + sum(w * v for w, v in zip(self.weights, z))
        return 1 / (1 + math.exp(-max(-30.0, min(30.0, s))))

    def contributions(self, x) -> list[tuple[str, float]]:
        """Вклад признаков в логит — для объяснения предупреждения."""
        z = self._z(x)
        return sorted(((n, w * v) for n, w, v in zip(self.names, self.weights, z)), key=lambda p: -p[1])

    def fit(self, X, Y, W, epochs=400, lr=0.3, l2=1e-3):
        n = len(self.names)
        cols = list(zip(*X))
        self.mean = [fmean(c) for c in cols]
        self.std = [pstdev(c) or 1.0 for c in cols]
        Z = [self._z(x) for x in X]
        wsum = sum(W)
        # Полный градиентный спуск с Adam: данных немного, результат воспроизводим.
        m = [0.0] * (n + 1)
        v = [0.0] * (n + 1)
        b1, b2, eps = 0.9, 0.999, 1e-8
        for step in range(1, epochs + 1):
            g = [0.0] * (n + 1)
            for z, y, w in zip(Z, Y, W):
                s = self.bias + sum(wi * zi for wi, zi in zip(self.weights, z))
                p = 1 / (1 + math.exp(-max(-30.0, min(30.0, s))))
                d = (p - y) * w
                for j in range(n):
                    g[j] += d * z[j]
                g[n] += d
            for j in range(n + 1):
                gj = g[j] / wsum + (l2 * self.weights[j] if j < n else 0.0)
                m[j] = b1 * m[j] + (1 - b1) * gj
                v[j] = b2 * v[j] + (1 - b2) * gj * gj
                upd = lr * (m[j] / (1 - b1 ** step)) / (math.sqrt(v[j] / (1 - b2 ** step)) + eps)
                if j < n:
                    self.weights[j] -= upd
                else:
                    self.bias -= upd
        return self

    def to_dict(self):
        return {"names": self.names, "mean": self.mean, "std": self.std, "weights": self.weights, "bias": self.bias}

    @classmethod
    def from_dict(cls, d):
        return cls(d["names"], d["mean"], d["std"], d["weights"], d["bias"])


def roc_auc(scores, y) -> float:
    pairs = sorted(zip(scores, y))
    pos = sum(y)
    neg = len(y) - pos
    if not pos or not neg:
        return float("nan")
    rank_sum, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        avg = (i + j + 1) / 2  # средний ранг для одинаковых значений
        rank_sum += avg * sum(1 for k in range(i, j) if pairs[k][1])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def risk_series(model: LogisticModel, series: Series) -> list:
    """Риск в каждой точке ряда; None — участок в ремонте или мало истории."""
    out = []
    for i in range(len(series.t)):
        x = features_at(series, i)
        out.append(None if x is None else model.proba(x))
    return out


def alarms(series: Series, risk: list, threshold: float) -> list[dict]:
    """Предупреждение: 2 точки подряд выше порога; снимается, когда риск падает вдвое
    или начинается ремонт."""
    out, open_at, above = [], None, 0
    for i, p in enumerate(risk):
        if p is None:
            open_at, above = None, 0
            continue
        if open_at is None:
            above = above + 1 if p >= threshold else 0
            if above >= 2:
                open_at = series.t[i]
                out.append({"start": open_at, "index": i})
        elif p < threshold / 2:
            open_at, above = None, 0
    return out


def score(series_list, risk_fn) -> list:
    """Риск по каждой истории: [(series, risk)] — считается один раз."""
    return [(s, risk_fn(s)) for s in series_list]


def evaluate(scored, threshold) -> dict:
    """Метрики на историях, которых модель не видела."""
    scores, ys = [], []
    warned, total, leads, false_alarms, hours = 0, 0, [], 0, 0.0
    for s, risk in scored:
        y = labels(s)
        for p, yy in zip(risk, y):
            if p is not None:
                scores.append(p)
                ys.append(yy)
        hours += sum(s.running) * STEP_MIN / 60
        al = alarms(s, risk, threshold)
        for f in s.failures:
            total += 1
            hit = [a for a in al if f - HORIZON_MIN <= a["start"] < f]
            if hit:
                warned += 1
                leads.append(f - hit[0]["start"])
        for a in al:
            if not any(a["start"] < f <= a["start"] + HORIZON_MIN for f in s.failures):
                false_alarms += 1
    leads.sort()
    auc = roc_auc(scores, ys)
    return {
        "roc_auc": None if math.isnan(auc) else round(auc, 3),
        "failures": total,
        "warned": warned,
        "lead_median_min": leads[len(leads) // 2] if leads else None,
        "false_alarms": false_alarms,
        "false_per_100h": round(false_alarms / hours * 100, 2) if hours else None,
        "hours": round(hours),
    }


def choose_threshold(scored, max_false_per_100h=0.5) -> float:
    """Порог на валидации: больше предупреждённых отказов при ложных ≤ лимита."""
    best = (0.9, -1, 0)
    for thr in [x / 100 for x in range(30, 96, 5)]:
        m = evaluate(scored, thr)
        if m["false_per_100h"] is not None and m["false_per_100h"] <= max_false_per_100h:
            key = (m["warned"], m["lead_median_min"] or 0)
            if key > best[1:]:
                best = (thr, *key)
    return best[0]
