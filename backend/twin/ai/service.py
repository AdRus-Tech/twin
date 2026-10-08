"""Сценарии AI-анализа поверх симулятора.

Порядок: параметры → симуляция → ответ модели → проверка контракта →
(если предложено допустимое изменение) повторная симуляция → сравнение →
объяснение. Числа всегда берутся из симулятора; при любой ошибке ИИ
расчёт возвращается полностью, а AI-блок получает статус ошибки.
"""
import logging
from datetime import datetime, timezone

from .. import simulation
from . import contract
from . import saved_answers
from .providers import DemoProvider, ProviderError, get_provider

log = logging.getLogger(__name__)


def _ask(task: str, a: dict, b: dict | None, comparison: dict | None, fields: dict) -> dict:
    facts = contract.build_facts(a, b, comparison)
    names = {s["id"]: s["name"] for s in a["params"]["stations"]}
    meta = {"task": task, "requested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "facts_count": len(facts)}
    try:
        provider = get_provider()
        meta.update(provider=provider.name, model=provider.model, live=provider.live)
        messages = contract.build_messages(task, facts, contract.describe_chain(a), fields)
        try:
            text = provider.complete(messages, task=task, facts=facts, fields=fields, names=names)
        except ProviderError as exc:
            # Без сохранённого ответа на эти факты — шаблонный ответ, помеченный «демо».
            if exc.code != "no_saved":
                raise
            provider = DemoProvider()
            meta.update(provider=provider.name, model=provider.model, live=False, fallback="no_saved")
            text = provider.complete(messages, task=task, facts=facts, fields=fields, names=names)
        parsed = contract.parse_response(text, facts, fields)
        if provider.live:
            try:
                saved_answers.save(task, facts, provider.model, meta["requested_at"], text)
            except OSError:
                log.warning("AI answer could not be saved")
                meta["save_error"] = "Ответ получен, но не сохранён для повторного показа"
        elif provider.name == "saved":
            meta.update(model=provider.model, saved_at=provider.saved_at)
    except ProviderError as exc:
        log.warning("AI provider error: %s", exc.code)
        return {**meta, "status": "unavailable", "error": exc.message, "error_code": exc.code}
    except contract.ContractError as exc:
        log.warning("AI contract error: %s", exc)
        return {**meta, "status": "invalid", "error": f"Ответ модели не прошёл проверку: {exc}",
                "error_code": "contract"}
    source = "live" if meta["live"] else ("saved" if meta["provider"] == "saved" else "demo")
    return {**meta, "status": "ok", "source": source, "result": parsed}


def _score(comparison: dict) -> tuple:
    d = comparison["delta"]
    return (d["output_units"], -(d["blocked_min"] + d["starved_min"]))


def propose(raw_params: dict) -> dict:
    """ИИ предлагает до трёх изменений; сервер проверяет и пересчитывает каждое,
    лучшее (больше выпуск, затем меньше простоя соседей) становится сценарием B."""
    params_a = simulation.parse_params(raw_params)
    a = simulation.simulate(params_a)
    fields = contract.allowed_fields(a["params"])
    ai = _ask("propose", a, None, None, fields)
    response = {"a": a, "ai": ai, "allowed_fields": {k: list(v) for k, v in fields.items()},
                "b": None, "comparison": None, "b_params": None}

    if ai["status"] != "ok":
        return response
    best = None
    for proposal in ai["result"]["proposals"]:
        if not proposal["accepted"]:
            continue
        b_raw = contract.apply_proposal(a["params"], proposal["field"], proposal["value"])
        try:
            b = simulation.simulate(simulation.parse_params(b_raw))
        except simulation.ParamError as exc:
            proposal.update(accepted=False, reason=f"параметры не прошли проверку: {exc}")
            continue
        comparison = simulation.compare(a, b)
        d = comparison["delta"]
        proposal.update(output_units=b["output_units"], delta_output=d["output_units"],
                        delta_idle_min=round(d["blocked_min"] + d["starved_min"], 1))
        if best is None or _score(comparison) > _score(best[2]):
            best = (proposal, b_raw, comparison, b)
    for proposal in ai["result"]["proposals"]:
        proposal["best"] = best is not None and proposal is best[0]
    if best:
        ai["result"]["proposal"] = best[0]
        response.update(b=best[3], b_params=best[1], comparison=best[2])
    return response


def explain(raw_a: dict, raw_b: dict) -> dict:
    a = simulation.simulate(simulation.parse_params(raw_a))
    b = simulation.simulate(simulation.parse_params(raw_b))
    comparison = simulation.compare(a, b)
    ai = _ask("explain", a, b, comparison, {})
    return {"a": a, "b": b, "comparison": comparison, "ai": ai}
