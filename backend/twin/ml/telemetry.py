"""Синтетическая телеметрия оборудования для демонстрации прогноза отказов.

Реальной производственной телеметрии в проекте нет. Генератор создаёт правдоподобные ряды
датчиков с шагом 5 минут для трёх единиц оборудования из демонстрационного журнала простоев
и сам закладывает в них отказы. Поэтому качество модели на этих данных
показывает только то, что конвейер «данные → признаки → модель → предупреждение»
работает; точность на заводе нужно проверять на настоящей истории.

Виды отказов (причины — из журнала простоев тестовых данных):
* Конвейер-03, «обрыв цепи»: за 1–3 ч до обрыва растут ток привода и вибрация.
  Есть помехи без отказа: скачки нагрузки (только ток) и короткие всплески вибрации.
* Камера-02, «замена фильтра»: фильтр забивается, перепад давления растёт,
  расход воздуха падает; на критическом перепаде камера встаёт на замену.
* ABB-01, «ошибка датчика»: отказ внезапный, предвестника в данных нет.
"""
import math
import random
from dataclasses import dataclass, field

STEP_MIN = 5
DAY = 24 * 60


@dataclass(frozen=True)
class Channel:
    key: str
    name: str
    unit: str
    norm: float


@dataclass(frozen=True)
class Equipment:
    id: str
    name: str
    station: str  # участок модели линии
    failure: str
    repair_min: int  # авария: сколько стоит участок
    planned_min: int  # замена/обслуживание заранее
    channels: tuple


EQUIPMENT = (
    Equipment("conveyor03", "Конвейер-03", "assembly", "обрыв цепи", 55, 20, (
        Channel("current", "ток привода", "А", 18.0),
        Channel("vibration", "вибрация", "мм/с", 2.2),
        Channel("temp", "температура редуктора", "°C", 45.0),
    )),
    Equipment("booth02", "Камера-02", "painting", "замена фильтра", 40, 15, (
        Channel("dp", "перепад давления на фильтре", "Па", 140.0),
        Channel("airflow", "расход воздуха", "м³/с", 12.0),
        Channel("temp", "температура в камере", "°C", 24.0),
    )),
    Equipment("abb01", "ABB-01", "welding", "ошибка датчика", 25, 10, (
        Channel("current", "ток робота", "А", 9.0),
        Channel("temp", "температура привода", "°C", 52.0),
        Channel("cycle", "время цикла", "с", 230.0),
    )),
)
BY_ID = {e.id: e for e in EQUIPMENT}

DP_CRITICAL = 260.0


@dataclass
class Series:
    """Ряд одной единицы оборудования: время (мин), значения каналов, отказы."""
    equipment: Equipment
    t: list = field(default_factory=list)
    values: dict = field(default_factory=dict)  # key -> list
    running: list = field(default_factory=list)  # False — ремонт, точки не используются
    since_maint: list = field(default_factory=list)  # минут с последнего ремонта/замены
    failures: list = field(default_factory=list)  # минуты отказов


def _conveyor(rng: random.Random, minutes: int, start_offset: int = 0, forced=None) -> Series:
    eq = BY_ID["conveyor03"]
    s = Series(eq, values={c.key: [] for c in eq.channels})
    # Расписание отказов: интервалы 6–16 суток; forced — заданные минуты (сценарий смены).
    failures = list(forced) if forced is not None else []
    if forced is None:
        t = rng.uniform(2, 10) * DAY
        while t < minutes:
            failures.append(int(t // STEP_MIN * STEP_MIN))
            t += rng.uniform(6, 16) * DAY
    precursors = {f: (rng.uniform(60, 180), rng.uniform(0.75, 1.25)) for f in failures}
    # Помехи без отказа: скачки нагрузки (ток) и всплески вибрации.
    surges = []
    t = rng.uniform(0.3, 1.5) * DAY
    while t < minutes:
        surges.append((t, rng.uniform(20, 45), rng.uniform(0.05, 0.10), "current"))
        t += rng.uniform(0.6, 2.0) * DAY
    t = rng.uniform(0.3, 2.0) * DAY
    while t < minutes:
        surges.append((t, rng.uniform(5, 15), rng.uniform(0.25, 0.45), "vibration"))
        t += rng.uniform(1.0, 3.0) * DAY

    repair_until = -1
    last_maint = -rng.uniform(0, 6) * DAY
    for t in range(0, minutes, STEP_MIN):
        tt = t + start_offset
        load = 1 + 0.03 * math.sin(2 * math.pi * tt / DAY) + rng.gauss(0, 0.01)
        cur = 18.0 * load + rng.gauss(0, 0.2)
        vib = 2.2 * (1 + rng.gauss(0, 0.04))
        temp = 45 + 3 * math.sin(2 * math.pi * (tt - 300) / DAY) + rng.gauss(0, 0.4)
        wear = min(1.0, (t - last_maint) / (14 * DAY))
        vib *= 1 + 0.06 * wear
        for f, (lead, amp) in precursors.items():
            if f - lead <= t < f:
                r = ((t - (f - lead)) / lead) ** 1.5
                cur *= 1 + 0.12 * amp * r
                vib *= 1 + 0.70 * amp * r
                temp += 4 * amp * r
        for st, dur, amp, key in surges:
            if st <= t < st + dur:
                if key == "current":
                    cur *= 1 + amp
                else:
                    vib *= 1 + amp
        if t in failures:
            s.failures.append(t)
            repair_until = t + eq.repair_min
            last_maint = t + eq.repair_min
        running = t >= repair_until
        s.t.append(t)
        s.values["current"].append(cur if running else 0.0)
        s.values["vibration"].append(vib if running else 0.0)
        s.values["temp"].append(temp)
        s.running.append(running)
        s.since_maint.append(max(0.0, t - last_maint))
    return s


def _booth(rng: random.Random, minutes: int, start_offset: int = 0, dp_start=None, rate=None) -> Series:
    eq = BY_ID["booth02"]
    s = Series(eq, values={c.key: [] for c in eq.channels})
    dp0 = dp_start if dp_start is not None else rng.uniform(130, 220)
    k = rate if rate is not None else rng.uniform(0.035, 0.06)
    repair_until = -1
    last_maint = -int((dp0 - 135) / k)
    base = dp0
    for t in range(0, minutes, STEP_MIN):
        tt = t + start_offset
        running = t >= repair_until
        if running:
            dp = base + k * (t - max(0, repair_until)) if repair_until >= 0 else base + k * t
        if running and dp >= DP_CRITICAL:
            s.failures.append(t)
            repair_until = t + eq.repair_min
            last_maint = t + eq.repair_min
            base = rng.uniform(130, 150)
            k = rng.uniform(0.035, 0.06) if rate is None else rate
            running = False
        dp_obs = dp + rng.gauss(0, 3) if running else 0.0
        flow = 12.0 * (1 - 0.0016 * (dp - 140)) + rng.gauss(0, 0.12) if running else 0.0
        temp = 24 + 0.8 * math.sin(2 * math.pi * tt / DAY) + rng.gauss(0, 0.3)
        s.t.append(t)
        s.values["dp"].append(dp_obs)
        s.values["airflow"].append(flow)
        s.values["temp"].append(temp)
        s.running.append(running)
        s.since_maint.append(max(0.0, t - last_maint))
    return s


def _robot(rng: random.Random, minutes: int, start_offset: int = 0, forced=None) -> Series:
    eq = BY_ID["abb01"]
    s = Series(eq, values={c.key: [] for c in eq.channels})
    failures = list(forced) if forced is not None else []
    if forced is None:
        t = rng.expovariate(1 / (7 * DAY))
        while t < minutes:
            failures.append(int(t // STEP_MIN * STEP_MIN))
            t += rng.expovariate(1 / (7 * DAY))
    repair_until = -1
    last_maint = -rng.uniform(0, 5) * DAY
    for t in range(0, minutes, STEP_MIN):
        tt = t + start_offset
        cur = 9.0 * (1 + 0.04 * math.sin(2 * math.pi * tt / 90) + rng.gauss(0, 0.03))
        temp = 52 + 2 * math.sin(2 * math.pi * (tt - 200) / DAY) + rng.gauss(0, 0.6)
        cycle = 230 + rng.gauss(0, 2.5)
        if t in failures:
            s.failures.append(t)
            repair_until = t + eq.repair_min
            last_maint = t + eq.repair_min
        running = t >= repair_until
        s.t.append(t)
        s.values["current"].append(cur if running else 0.0)
        s.values["temp"].append(temp)
        s.values["cycle"].append(cycle if running else 0.0)
        s.running.append(running)
        s.since_maint.append(max(0.0, t - last_maint))
    return s


GENERATORS = {"conveyor03": _conveyor, "booth02": _booth, "abb01": _robot}


def history(eq_id: str, seed: int, days: int = 150) -> Series:
    """«Годы» работы для обучения и проверки: независимые истории по seed."""
    rng = random.Random(f"{eq_id}:{seed}")
    return GENERATORS[eq_id](rng, days * DAY)


# Демонстрационная смена: 6 ч предыстории + смена 8 ч (минута 0 смены = 360).
WARMUP_MIN = 360
SHIFT_MIN = 480


def demo_shift() -> dict:
    """Заданная смена для показа: обрыв цепи Конвейера-03 в 13:30 (минута 330 смены),
    фильтр Камеры-02 забивается до критического перепада к ~15:50, ABB-01 без отказа."""
    total = WARMUP_MIN + SHIFT_MIN
    return {
        "conveyor03": _conveyor(random.Random("demo:conveyor03"), total, forced=[WARMUP_MIN + 330]),
        "booth02": _booth(random.Random("demo:booth02"), total, dp_start=212.0, rate=0.058),
        "abb01": _robot(random.Random("demo:abb01"), total, forced=[]),
    }
