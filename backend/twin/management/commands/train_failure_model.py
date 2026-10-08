"""Обучение прогноза отказов: python manage.py train_failure_model

Данные — синтетическая телеметрия (twin/ml/telemetry.py), независимые истории по seed:
обучение, валидация (выбор порога), проверка (итоговые метрики). Результат —
backend/twin/ml/model.json и отчёт docs/ML_REPORT.md.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from django.core.management.base import BaseCommand

from twin.ml import model as M
from twin.ml import telemetry as T

ML_DIR = Path(__file__).resolve().parents[2] / "ml"
MODEL_FILE = ML_DIR / "model.json"
REPORT_FILE = Path(__file__).resolve().parents[4] / "docs" / "ML_REPORT.md"

TRAIN, VALID, TEST = (1001, 1002, 1003), (1004,), (1005,)
# Правило для сравнения: «ток за 15 мин выше нормы на 8%» (как сделал бы наладчик).
BASELINE = {"conveyor03": ("current_15", 0.08), "booth02": ("dp_15", 0.82), "abb01": ("current_15", 0.08)}


def baseline_risk(eq_id):
    name, limit = BASELINE[eq_id]

    def fn(series):
        idx = M.feature_names(series).index(name)
        out = []
        for i in range(len(series.t)):
            x = M.features_at(series, i)
            out.append(None if x is None else float(x[idx] > limit))
        return out
    return fn


class Command(BaseCommand):
    help = "Обучить и проверить прогноз отказов на синтетической телеметрии"

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=150, help="длина каждой истории, суток")
        parser.add_argument("--epochs", type=int, default=300)

    def handle(self, *args, **opts):
        days, out = opts["days"], {}
        for eq in T.EQUIPMENT:
            hist = {seed: T.history(eq.id, seed, days) for seed in TRAIN + VALID + TEST}
            X, Y, W = M.dataset([hist[s] for s in TRAIN], neg_keep=0.05, seed=7)
            model = M.LogisticModel(M.feature_names(hist[TRAIN[0]])).fit(X, Y, W, epochs=opts["epochs"])
            valid = M.score([hist[s] for s in VALID], lambda s: M.risk_series(model, s))
            threshold = M.choose_threshold(valid)
            test = M.score([hist[s] for s in TEST], lambda s: M.risk_series(model, s))
            m_test = M.evaluate(test, threshold)
            base = M.evaluate(M.score([hist[s] for s in TEST], baseline_risk(eq.id)), 0.5)
            # Прогнозируемым считаем отказ, если модель ловит большинство случаев и заметно лучше случайного.
            predictable = (m_test["roc_auc"] or 0) >= 0.75 and m_test["warned"] >= 0.5 * max(1, m_test["failures"])
            fails = sum(len(hist[s].failures) for s in TRAIN)
            hours = sum(sum(hist[s].running) for s in TRAIN) * T.STEP_MIN / 60
            background = min(1.0, fails / hours * M.HORIZON_MIN / 60) if hours else 0.0
            weights = sorted(zip(model.names, model.weights), key=lambda p: -abs(p[1]))
            out[eq.id] = {
                "name": eq.name, "station": eq.station, "failure": eq.failure,
                "repair_min": eq.repair_min, "planned_min": eq.planned_min,
                "model": model.to_dict(), "threshold": threshold, "predictable": predictable,
                "background": round(background, 4), "test": m_test, "baseline": base,
                "baseline_rule": BASELINE[eq.id], "top_weights": [[n, round(w, 3)] for n, w in weights[:5]],
                "train_rows": len(X), "train_failures": fails,
            }
            self.stdout.write(f"{eq.name}: AUC {m_test['roc_auc']}, предупреждено {m_test['warned']}/{m_test['failures']}, "
                              f"упреждение {m_test['lead_median_min']} мин, ложных {m_test['false_per_100h']}/100 ч, "
                              f"порог {threshold}, прогнозируем: {predictable}")
        meta = {
            "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "horizon_min": M.HORIZON_MIN, "step_min": T.STEP_MIN, "days": days,
            "seeds": {"train": TRAIN, "valid": VALID, "test": TEST},
            "method": "логистическая регрессия на признаках окна 60 мин (своя реализация, без внешних библиотек)",
            "data": "синтетическая телеметрия; отказы заложены генератором",
            "equipment": out,
        }
        MODEL_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        REPORT_FILE.write_text(report(meta), encoding="utf-8")
        self.stdout.write(f"Сохранено: {MODEL_FILE.name}, {REPORT_FILE.name}")


SUFFIX = {"15": "за 15 мин к норме", "60": "за 60 мин к норме", "slope": "рост за 15 мин", "sd": "разброс за 60 мин"}


def human(feature, eq_id):
    if feature == "since_maint":
        return "время с последнего ремонта"
    key, part = feature.rsplit("_", 1)
    names = {c.key: c.name for c in T.BY_ID[eq_id].channels}
    return f"{names.get(key, key)}: {SUFFIX.get(part, part)}"


def report(meta) -> str:
    lines = [
        "# Прогноз отказов оборудования: как обучено и как проверено",
        "",
        f"Сформирован командой `python manage.py train_failure_model` ({meta['trained_at'][:10]}).",
        "",
        "**Данные синтетические.** Реальной производственной телеметрии нет: генератор `backend/twin/ml/telemetry.py` "
        "создаёт ряды датчиков с шагом 5 минут и сам закладывает отказы и их предвестники. Метрики ниже показывают, "
        "что цепочка «датчики → признаки → модель → предупреждение» работает и как её проверять. "
        "Точность на заводе неизвестна, пока модель не переобучена и не проверена на настоящей истории.",
        "",
        "## Задача и метод",
        "",
        f"- Предсказать отказ в ближайшие **{meta['horizon_min']} минут** по последним 60 минутам телеметрии.",
        f"- Метод: {meta['method']}. Веса показывают, какой сигнал повышает риск, — каждое предупреждение объяснимо.",
        "- Признаки по каждому датчику: среднее за 15 и 60 мин относительно нормы, рост за 15 мин, разброс за 60 мин; "
        "плюс время с последнего ремонта.",
        "- Предупреждение: 2 оценки подряд выше порога; снимается, когда риск падает вдвое.",
        f"- Истории по {meta['days']} суток: обучение — seed {', '.join(map(str, meta['seeds']['train']))}; "
        f"порог — на валидации (seed {meta['seeds']['valid'][0]}, не более 0,5 ложных на 100 ч); "
        f"итог — на отдельной проверочной истории (seed {meta['seeds']['test'][0]}), которую модель не видела.",
        "",
        "## Результаты на проверочной истории",
        "",
        "| Оборудование | Отказ | ROC-AUC | Предупреждено заранее | Упреждение, медиана | Ложных на 100 ч | Порог | Вывод |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for e in meta["equipment"].values():
        t = e["test"]
        verdict = "прогнозируется" if e["predictable"] else f"не прогнозируется — фоновая вероятность {e['background'] * 100:.1f}% за 2 ч"
        lead = f"{t['lead_median_min']} мин" if t["lead_median_min"] is not None else "—"
        lines.append(f"| {e['name']} | {e['failure']} | {t['roc_auc']} | {t['warned']} из {t['failures']} | {lead} | "
                     f"{t['false_per_100h']} | {e['threshold']} | {verdict} |")
    lines += ["", "## Модель против простого правила", "",
              "| Оборудование | Правило | Предупреждено | Упреждение | Ложных на 100 ч |", "|---|---|---|---|---|"]
    for eq_id, e in meta["equipment"].items():
        b = e["baseline"]
        name, limit = e["baseline_rule"]
        lead = f"{b['lead_median_min']} мин" if b["lead_median_min"] is not None else "—"
        lines.append(f"| {e['name']} | {human(name, eq_id)} > {limit:+.0%} | {b['warned']} из {b['failures']} | {lead} | {b['false_per_100h']} |")
    lines += ["", "## Какие сигналы важнее всего", ""]
    for eq_id, e in meta["equipment"].items():
        top = ", ".join(f"{human(n, eq_id)} ({w:+.2f})" for n, w in e["top_weights"][:3])
        lines.append(f"- **{e['name']}:** {top}.")
    lines += [
        "",
        "## Ограничения и путь к реальным данным",
        "",
        "- Отказы и их предвестники заложены генератором — модель находит то, что в данных есть. На заводе нужны "
        "история датчиков (ток, вибрация, температура, перепад давления), журнал отказов с точным временем и график ТО.",
        "- Внезапные отказы без предвестника (сбой датчика робота) прогнозом не лечатся: помогают запас датчиков у линии "
        "и быстрая реакция наладчика. Интерфейс показывает для них только фоновую вероятность.",
        "- Переобучение: заменить генератор загрузкой истории, запустить `train_failure_model`, сравнить метрики "
        "с этим отчётом и с простым правилом на отдельном, более позднем периоде.",
        "",
    ]
    return "\n".join(lines)
