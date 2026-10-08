import math
import re
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import Max
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import dataset, plan, simulation
from .ai import report
from .ml import service as ml_service
from .models import Incident
from .ai import service as ai_service
from .ai.providers import provider_status


def _params_error(exc: simulation.ParamError) -> Response:
    return Response({"error": "Параметры сценария не прошли проверку", "fields": exc.errors},
                    status=status.HTTP_400_BAD_REQUEST)


def _require(data, *keys):
    if not isinstance(data, dict):
        raise simulation.ParamError({"body": "ожидается JSON-объект"})
    missing = [k for k in keys if k not in data]
    if missing:
        raise simulation.ParamError({k: "обязательное поле" for k in missing})


@api_view(["GET"])
def overview(request):
    return Response(dataset.overview(request.query_params.get("date")))


@api_view(["GET"])
def preset(request):
    return Response({
        "kind": "assumption",
        "params": simulation.DEFAULT_PRESET,
        "limits": simulation.LIMITS,
        "rules": simulation.__doc__,
    })


@api_view(["POST"])
def run_scenario(request):
    try:
        _require(request.data, "params")
        return Response(simulation.run(request.data["params"]))
    except simulation.ParamError as exc:
        return _params_error(exc)


@api_view(["POST"])
def compare_scenarios(request):
    try:
        _require(request.data, "a", "b")
        a = simulation.run(request.data["a"])
        b = simulation.run(request.data["b"])
    except simulation.ParamError as exc:
        return _params_error(exc)
    return Response({"a": a, "b": b, "comparison": simulation.compare(a, b)})


@api_view(["GET"])
def ai_status(request):
    return Response(provider_status())


@api_view(["POST"])
def ai_propose(request):
    try:
        _require(request.data, "params")
        return Response(ai_service.propose(request.data["params"]))
    except simulation.ParamError as exc:
        return _params_error(exc)


@api_view(["POST"])
def ai_explain(request):
    try:
        _require(request.data, "a", "b")
        return Response(ai_service.explain(request.data["a"], request.data["b"]))
    except simulation.ParamError as exc:
        return _params_error(exc)


# --- Журнал инцидентов -------------------------------------------------------

_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _incident_fields(data) -> tuple[dict, dict]:
    """Проверка тела запроса на создание инцидента. Лишние поля игнорируются."""
    errors, out = {}, {}
    if not isinstance(data, dict):
        return {}, {"body": "ожидается JSON-объект"}

    def text(key, limit, required=False):
        v = data.get(key, "")
        if not isinstance(v, str) or (required and not v.strip()):
            errors[key] = "обязательная строка" if required else "ожидается строка"
            return ""
        return v.strip()[:limit]

    def integer(key, lo, hi):
        v = data.get(key)
        if (isinstance(v, bool) or not isinstance(v, (int, float))
                or (isinstance(v, float) and not math.isfinite(v)) or v != int(v) or not lo <= v <= hi):
            errors[key] = f"целое от {lo} до {hi}"
            return None
        return int(v)

    out["station"] = text("station", 32, required=True)
    out["station_name"] = text("name", 40, required=True)
    out["start_min"] = integer("start", 0, 960)
    out["duration_min"] = integer("duration", 1, 960)
    out["clock"] = text("clock", 5, required=True)
    if out["clock"] and not _CLOCK.match(out["clock"]):
        errors["clock"] = "формат ЧЧ:ММ"
    out["reason"] = text("reason", 80)
    out["equipment"] = text("equipment", 40)
    if "client_id" in data:
        try:
            out["client_id"] = UUID(data["client_id"]) if isinstance(data["client_id"], str) else None
            if out["client_id"] is None:
                errors["client_id"] = "ожидается UUID"
        except ValueError:
            errors["client_id"] = "ожидается UUID"
    for key, choices in (("priority", Incident.PRIORITY), ("source", Incident.SOURCE)):
        v = data.get(key, choices[-1][0] if key == "priority" else "manual")
        if not isinstance(v, str) or v not in dict(choices):
            errors[key] = "недопустимое значение"
        out[key] = v
    # Статус при создании — по желанию: решение могло быть принято сразу (живая смена).
    if "status" in data:
        if not isinstance(data["status"], str) or data["status"] not in dict(Incident.STATUS):
            errors["status"] = "недопустимое значение"
        else:
            out["status"] = data["status"]
    impact = data.get("impact", {})
    if not isinstance(impact, dict) or len(str(impact)) > 500:
        errors["impact"] = "ожидается небольшой объект"
    out["impact"] = {k: impact[k] for k in ("lossCars", "idleMin", "output") if isinstance(impact, dict) and k in impact}
    return out, errors


@api_view(["GET", "POST"])
def incidents(request):
    if request.method == "GET":
        return Response([i.to_dict() for i in Incident.objects.all()[:200]])
    fields, errors = _incident_fields(request.data)
    if errors:
        return Response({"error": "Инцидент не прошёл проверку", "fields": errors}, status=status.HTTP_400_BAD_REQUEST)
    # Номер — следующий по порядку; при гонке двух запросов повторяем.
    for _ in range(3):
        try:
            with transaction.atomic():
                if fields.get("client_id"):
                    existing = Incident.objects.filter(client_id=fields["client_id"]).first()
                    if existing:
                        return Response(existing.to_dict())
                n = (Incident.objects.aggregate(m=Max("number"))["m"] or 0) + 1
                inc = Incident.objects.create(number=n, **fields)
            return Response(inc.to_dict(), status=status.HTTP_201_CREATED)
        except IntegrityError:
            continue
    return Response({"error": "Не удалось присвоить номер, повторите"}, status=status.HTTP_409_CONFLICT)


@api_view(["PATCH", "DELETE"])
def incident_detail(request, number: int):
    inc = Incident.objects.filter(number=number).first()
    if inc is None:
        return Response({"error": "Нет такого инцидента"}, status=status.HTTP_404_NOT_FOUND)
    if request.method == "DELETE":
        inc.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
    new_status = request.data.get("status") if isinstance(request.data, dict) else None
    if not isinstance(new_status, str) or new_status not in dict(Incident.STATUS):
        return Response({"error": "Статус: new, work или closed", "fields": {"status": "недопустимое значение"}},
                        status=status.HTTP_400_BAD_REQUEST)
    inc.status = new_status
    inc.save(update_fields=["status", "updated_at"])
    return Response(inc.to_dict())


@api_view(["GET"])
def ml_shift(request):
    """Риск отказа оборудования на демонстрационной смене (синтетическая телеметрия)."""
    return Response(ml_service.demo_monitor())


# --- Сообщение с линии и месячный план ---------------------------------------

@api_view(["POST"])
def ai_parse_report(request):
    """Сообщение рабочего свободным текстом → поля события (ИИ или правила)."""
    text = request.data.get("text") if isinstance(request.data, dict) else None
    if not isinstance(text, str) or not text.strip():
        return Response({"error": "Нужен текст сообщения", "fields": {"text": "обязательная строка"}},
                        status=status.HTTP_400_BAD_REQUEST)
    return Response(report.parse_report(text[:500]))


@api_view(["GET"])
def plan_month(request):
    """Таблица сбоев из демонстрационного журнала с потерями по модели линии — для прогноза месяца."""
    return Response(plan.month_inputs())
