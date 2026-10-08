"""Хранение успешных живых ответов модели для резервной демонстрации.

Файл содержит только расчётные факты синтетического сценария и текст ответа;
ключ API и заголовки запроса не сохраняются.
"""
import hashlib
import json
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "data" / "ai_saved"


def facts_hash(task: str, facts: dict) -> str:
    raw = json.dumps({"task": task, "facts": facts}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def save(task: str, facts: dict, model: str, requested_at: str, text: str) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    record = {"task": task, "model": model, "requested_at": requested_at, "facts": facts, "text": text}
    path = DIR / f"{task}-{facts_hash(task, facts)}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def load(task: str, facts: dict) -> dict | None:
    path = DIR / f"{task}-{facts_hash(task, facts)}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
