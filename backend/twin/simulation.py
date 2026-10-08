"""Пошаговая модель последовательной цепочки операций с конечными буферами.

Модель намеренно маленькая, чтобы её можно было проверить руками.

Правила (шаг — 1 секунда):
* Операции стоят последовательно: 0 → 1 → … → n-1. Между соседями — буфер
  с конечной вместимостью и начальным запасом.
* Перед первой операцией — неограниченный запас (допущение: склад
  комплектующих не ограничивает поток). После последней — неограниченный выход.
* Операция обрабатывает одну единицу за `cycle_s` секунд.
* Готовую единицу операция сразу пытается передать дальше. Если буфер полон,
  операция держит единицу и стоит в состоянии «блокировка».
* Если входной буфер пуст, операция стоит в состоянии «нет потока».
* Остановок в смене может быть несколько: основная (`stoppage`, её сравнивают
  варианты) и уже случившиеся раньше (`extra_stoppages`, одинаковые в обоих).
* Во время остановки операция заморожена: незавершённая единица остаётся
  внутри, время обработки не идёт. Остановка — полная остановка операции.
* В пределах одной секунды операции обходятся от последней к первой: сначала
  нижний по потоку участок забирает единицу из буфера, затем верхний может
  положить в освободившееся место.

Не моделируются: брак и ремонт брака, партии, переналадки, транспортировка,
смены и перерывы, случайные отказы. Результат детерминирован.
"""
from dataclasses import dataclass, field, asdict
import math

STATE_WORKING = "working"
STATE_BLOCKED = "blocked"
STATE_STARVED = "starved"
STATE_DOWN = "down"

# Эпизод блокировки/нехватки короче этого порога не считается «проблемой»
# для журнала событий (короткие ожидания возникают каждый цикл из-за разницы тактов).
EPISODE_MIN_S = 60

LIMITS = {
    "cycle_s": (30, 3600),
    "capacity": (1, 200),
    "initial": (0, 200),
    "horizon_min": (30, 960),
    "duration_min": (0, 960),
    "extra_stoppages": 8,
}


class ParamError(ValueError):
    def __init__(self, errors: dict):
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass(frozen=True)
class Station:
    id: str
    name: str
    cycle_s: int


@dataclass(frozen=True)
class Buffer:
    capacity: int
    initial: int


@dataclass(frozen=True)
class Stoppage:
    station: str
    start_min: int
    duration_min: int


@dataclass(frozen=True)
class ScenarioParams:
    stations: tuple
    buffers: tuple
    horizon_min: int
    stoppage: Stoppage | None = None
    extra_stoppages: tuple = ()

    def to_dict(self) -> dict:
        d = asdict(self)
        d["stations"] = list(d["stations"])
        d["buffers"] = list(d["buffers"])
        # Поле появляется только когда есть другие остановки — старые ответы не меняются.
        if d["extra_stoppages"]:
            d["extra_stoppages"] = list(d["extra_stoppages"])
        else:
            del d["extra_stoppages"]
        return d


# Синтетический пример. Числа выбраны для демонстрации механики модели,
# а не получены из данных завода: такт не выводится из плана 120.
DEFAULT_PRESET = {
    "label": "Синтетический пример: остановка окраски",
    "stations": [
        {"id": "welding", "name": "Сварка", "cycle_s": 230},
        {"id": "painting", "name": "Окраска", "cycle_s": 225},
        {"id": "assembly", "name": "Сборка", "cycle_s": 235},
    ],
    "buffers": [
        {"capacity": 8, "initial": 4},
        {"capacity": 8, "initial": 4},
    ],
    "horizon_min": 480,
    "stoppage": {"station": "painting", "start_min": 120, "duration_min": 40},
}


def _int_in(errors: dict, key: str, value, lo: int, hi: int) -> int | None:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or (isinstance(value, float) and not math.isfinite(value)) or value != int(value)):
        errors[key] = "ожидается целое число"
        return None
    value = int(value)
    if not lo <= value <= hi:
        errors[key] = f"допустимо от {lo} до {hi}"
        return None
    return value


def parse_params(raw: dict) -> ScenarioParams:
    """Проверяет типы, диапазоны и состав полей. Лишние поля отклоняются."""
    errors: dict = {}
    if not isinstance(raw, dict):
        raise ParamError({"params": "ожидается объект"})
    allowed = {"stations", "buffers", "horizon_min", "stoppage", "extra_stoppages", "label"}
    extra = set(raw) - allowed
    if extra:
        errors["params"] = f"неизвестные поля: {', '.join(sorted(extra))}"

    stations = []
    raw_st = raw.get("stations")
    if not isinstance(raw_st, list) or not 2 <= len(raw_st) <= 6:
        errors["stations"] = "ожидается список из 2–6 операций"
        raw_st = []
    for i, s in enumerate(raw_st):
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not s["id"]:
            errors[f"stations[{i}]"] = "нужны поля id, name, cycle_s"
            continue
        cyc = _int_in(errors, f"stations[{i}].cycle_s", s.get("cycle_s"), *LIMITS["cycle_s"])
        name = str(s.get("name") or s["id"])[:40]
        if cyc is not None:
            stations.append(Station(s["id"][:32], name, cyc))
    if len({s.id for s in stations}) != len(stations):
        errors["stations"] = "идентификаторы операций должны быть уникальны"

    buffers = []
    raw_buf = raw.get("buffers")
    if not isinstance(raw_buf, list) or (raw_st and len(raw_buf) != len(raw_st) - 1):
        errors["buffers"] = "число буферов должно быть на 1 меньше числа операций"
        raw_buf = []
    for i, b in enumerate(raw_buf):
        if not isinstance(b, dict):
            errors[f"buffers[{i}]"] = "ожидается объект"
            continue
        cap = _int_in(errors, f"buffers[{i}].capacity", b.get("capacity"), *LIMITS["capacity"])
        ini = _int_in(errors, f"buffers[{i}].initial", b.get("initial"), *LIMITS["initial"])
        if cap is not None and ini is not None:
            if ini > cap:
                errors[f"buffers[{i}].initial"] = "начальный запас больше вместимости"
            else:
                buffers.append(Buffer(cap, ini))

    horizon = _int_in(errors, "horizon_min", raw.get("horizon_min"), *LIMITS["horizon_min"])

    ids = {s.id for s in stations}
    stoppage = None
    raw_stop = raw.get("stoppage")
    if raw_stop is not None:
        stoppage = _parse_stoppage(errors, "stoppage", raw_stop, ids, horizon)

    extra = []
    raw_extra = raw.get("extra_stoppages")
    if raw_extra is not None:
        if not isinstance(raw_extra, list) or len(raw_extra) > LIMITS["extra_stoppages"]:
            errors["extra_stoppages"] = f"ожидается список до {LIMITS['extra_stoppages']} остановок"
        else:
            for i, item in enumerate(raw_extra):
                st = _parse_stoppage(errors, f"extra_stoppages[{i}]", item, ids, horizon)
                if st is not None:
                    extra.append(st)

    if errors:
        raise ParamError(errors)
    return ScenarioParams(tuple(stations), tuple(buffers), horizon, stoppage, tuple(extra))


def _parse_stoppage(errors: dict, key: str, raw, ids: set, horizon: int | None) -> Stoppage | None:
    if not isinstance(raw, dict):
        errors[key] = "ожидается объект или null"
        return None
    st_id = raw.get("station")
    if not isinstance(st_id, str) or st_id not in ids:
        errors[f"{key}.station"] = "нет такой операции"
    start = _int_in(errors, f"{key}.start_min", raw.get("start_min"), 0, LIMITS["horizon_min"][1])
    dur = _int_in(errors, f"{key}.duration_min", raw.get("duration_min"), *LIMITS["duration_min"])
    if horizon is not None and start is not None and start >= horizon:
        errors[f"{key}.start_min"] = "начало остановки должно быть внутри горизонта"
        return None
    if f"{key}.station" not in errors and start is not None and dur is not None:
        return Stoppage(st_id, start, dur)
    return None


@dataclass
class _Episodes:
    """Непрерывные интервалы одного состояния на операции."""
    current: str | None = None
    since: int = 0
    items: list = field(default_factory=list)

    def update(self, state: str, t: int):
        if state != self.current:
            self.close(t)
            self.current, self.since = state, t

    def close(self, t: int):
        if self.current in (STATE_BLOCKED, STATE_STARVED, STATE_DOWN) and t > self.since:
            self.items.append((self.current, self.since, t))


def simulate(p: ScenarioParams) -> dict:
    n = len(p.stations)
    cycle = [s.cycle_s for s in p.stations]
    cap = [b.capacity for b in p.buffers]
    buf = [b.initial for b in p.buffers]
    remaining = [0] * n      # секунд до окончания текущей единицы; 0 — единицы в работе нет
    holding = [False] * n    # готовая единица ждёт места в следующем буфере
    released = 0
    output = 0
    seconds = {s.id: {STATE_WORKING: 0, STATE_BLOCKED: 0, STATE_STARVED: 0, STATE_DOWN: 0} for s in p.stations}
    episodes = [_Episodes() for _ in range(n)]
    buf_max = list(buf)
    buf_max_at = [0] * n
    buf_min = list(buf)
    buf_min_at = [0] * n

    # Окна остановок по операциям, в секундах: [(от, до), ...].
    down = [[] for _ in range(n)]
    for st in (p.stoppage, *p.extra_stoppages):
        if st and st.duration_min > 0:
            i = next(i for i, s in enumerate(p.stations) if s.id == st.station)
            down[i].append((st.start_min * 60, (st.start_min + st.duration_min) * 60))

    initial_wip = sum(buf)
    # buffers — мгновенный уровень на конце минуты; avg — среднее за минуту (для графика).
    frames = [{"t": 0, "buffers": list(buf), "avg": [float(x) for x in buf], "states": [None] * n, "output": 0}]
    acc = [0] * (n - 1)
    states = [STATE_STARVED] * n
    total_s = p.horizon_min * 60

    def push(i: int) -> bool:
        nonlocal output
        if i == n - 1:
            output += 1
            return True
        if buf[i] < cap[i]:
            buf[i] += 1
            return True
        return False

    def pull(i: int) -> bool:
        nonlocal released
        if i == 0:
            released += 1
            return True
        if buf[i - 1] > 0:
            buf[i - 1] -= 1
            return True
        return False

    for t in range(total_s):
        for i in range(n - 1, -1, -1):
            if down[i] and any(a <= t < b for a, b in down[i]):
                state = STATE_DOWN
            elif holding[i] and not push(i):
                state = STATE_BLOCKED
            else:
                holding[i] = False
                if remaining[i] == 0 and pull(i):
                    remaining[i] = cycle[i]
                if remaining[i] == 0:
                    state = STATE_STARVED
                else:
                    remaining[i] -= 1
                    state = STATE_WORKING
                    if remaining[i] == 0 and not push(i):
                        holding[i] = True
            states[i] = state
            seconds[p.stations[i].id][state] += 1
            episodes[i].update(state, t)

        for j in range(n - 1):
            acc[j] += buf[j]
            if buf[j] > buf_max[j]:
                buf_max[j], buf_max_at[j] = buf[j], t + 1
            if buf[j] < buf_min[j]:
                buf_min[j], buf_min_at[j] = buf[j], t + 1

        if (t + 1) % 60 == 0:
            frames.append({"t": (t + 1) // 60, "buffers": list(buf), "avg": [round(x / 60, 2) for x in acc],
                           "states": list(states), "output": output})
            acc = [0] * (n - 1)

    for ep in episodes:
        ep.close(total_s)
    if len(frames) > 1:
        frames[0]["states"] = list(frames[1]["states"])

    in_stations = sum(1 for i in range(n) if remaining[i] > 0 or holding[i])
    wip_end = sum(buf) + in_stations

    station_stats = []
    events = []
    for i, s in enumerate(p.stations):
        sec = seconds[s.id]
        firsts = {}
        for state, a, b in episodes[i].items:
            if b - a >= EPISODE_MIN_S or state == STATE_DOWN:
                events.append({
                    "station": s.id, "station_name": s.name, "state": state,
                    "start_min": round(a / 60, 1), "end_min": round(b / 60, 1),
                    "duration_min": round((b - a) / 60, 1),
                })
                firsts.setdefault(state, round(a / 60, 1))
        station_stats.append({
            "id": s.id, "name": s.name, "cycle_s": s.cycle_s,
            "working_min": round(sec[STATE_WORKING] / 60, 1),
            "blocked_min": round(sec[STATE_BLOCKED] / 60, 1),
            "starved_min": round(sec[STATE_STARVED] / 60, 1),
            "down_min": round(sec[STATE_DOWN] / 60, 1),
            "first_blocked_min": firsts.get(STATE_BLOCKED),
            "first_starved_min": firsts.get(STATE_STARVED),
        })
    events.sort(key=lambda e: (e["start_min"], e["station"]))

    buffer_stats = []
    for j in range(n - 1):
        buffer_stats.append({
            "index": j,
            "from": p.stations[j].id,
            "to": p.stations[j + 1].id,
            "name": f"{p.stations[j].name} → {p.stations[j + 1].name}",
            "capacity": cap[j],
            "initial": p.buffers[j].initial,
            "final": buf[j],
            "max": buf_max[j],
            "max_at_min": round(buf_max_at[j] / 60, 1),
            "min": buf_min[j],
            "min_at_min": round(buf_min_at[j] / 60, 1),
        })

    return {
        "kind": "simulation",
        "params": p.to_dict(),
        "output_units": output,
        "released_units": released,
        "initial_wip": initial_wip,
        "wip_end": wip_end,
        "stations": station_stats,
        "buffers": buffer_stats,
        "events": events,
        "frames": frames,
        "rules": {"step_s": 1, "episode_min_s": EPISODE_MIN_S},
    }


def totals(result: dict) -> dict:
    return {
        "output_units": result["output_units"],
        "blocked_min": round(sum(s["blocked_min"] for s in result["stations"]), 1),
        "starved_min": round(sum(s["starved_min"] for s in result["stations"]), 1),
        "max_queue": max((b["max"] for b in result["buffers"]), default=0),
    }


def compare(a: dict, b: dict) -> dict:
    """Разница B − A по ключевым показателям. Описывает модель, а не завод."""
    ta, tb = totals(a), totals(b)
    per_station = []
    for sa, sb in zip(a["stations"], b["stations"]):
        per_station.append({
            "id": sa["id"], "name": sa["name"],
            "blocked_min": round(sb["blocked_min"] - sa["blocked_min"], 1),
            "starved_min": round(sb["starved_min"] - sa["starved_min"], 1),
            "down_min": round(sb["down_min"] - sa["down_min"], 1),
        })
    per_buffer = [
        {"name": ba["name"], "max": bb["max"] - ba["max"]}
        for ba, bb in zip(a["buffers"], b["buffers"])
    ]
    return {
        "kind": "simulation",
        "a": ta,
        "b": tb,
        "delta": {k: round(tb[k] - ta[k], 1) for k in ta},
        "per_station": per_station,
        "per_buffer": per_buffer,
    }


def run(raw: dict) -> dict:
    return simulate(parse_params(raw))
