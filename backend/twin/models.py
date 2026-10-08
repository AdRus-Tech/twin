"""Журнал инцидентов смены. Единственное, что хранится в базе: тестовые данные
остаются в JSON, сценарии считаются на лету."""
from django.db import models


class Incident(models.Model):
    STATUS = [("new", "новый"), ("work", "в работе"), ("closed", "закрыт")]
    PRIORITY = [("high", "высокий"), ("medium", "средний"), ("low", "низкий")]
    SOURCE = [("manual", "руководитель смены"), ("ml", "прогноз ML")]

    number = models.PositiveIntegerField(unique=True)
    # Повторная отправка после потери связи возвращает ту же запись.
    client_id = models.UUIDField(null=True, blank=True, unique=True, editable=False)
    station = models.CharField(max_length=32)
    station_name = models.CharField(max_length=40)
    start_min = models.PositiveIntegerField(help_text="минута от начала смены")
    clock = models.CharField(max_length=5, help_text="время по часам, ЧЧ:ММ")
    duration_min = models.PositiveIntegerField()
    reason = models.CharField(max_length=80, blank=True)
    equipment = models.CharField(max_length=40, blank=True)
    priority = models.CharField(max_length=8, choices=PRIORITY, default="low")
    status = models.CharField(max_length=8, choices=STATUS, default="new")
    source = models.CharField(max_length=8, choices=SOURCE, default="manual")
    # Последствия по модели линии: потерянные машины, простой соседей, выпуск смены.
    impact = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-number"]

    @property
    def code(self) -> str:
        return f"INC-{self.number:03d}"

    def to_dict(self) -> dict:
        return {
            "n": self.number,
            "client_id": str(self.client_id) if self.client_id else None,
            "id": self.code,
            "station": self.station,
            "name": self.station_name,
            "start": self.start_min,
            "clock": self.clock,
            "duration": self.duration_min,
            "reason": self.reason,
            "equipment": self.equipment,
            "priority": self.priority,
            "status": self.status,
            "source": self.source,
            "impact": self.impact,
            "at": self.created_at.isoformat(timespec="seconds"),
            "updated": self.updated_at.isoformat(timespec="seconds"),
        }
