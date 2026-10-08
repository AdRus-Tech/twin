"""Настройки Django: JSON для исходных показателей, БД для журнала инцидентов."""
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"


def _load_env_file(path: Path) -> None:
    """Минимальный разбор backend/.env (KEY=VALUE). Переменные окружения важнее файла."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(BASE_DIR / ".env")


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


DEBUG = _flag("DJANGO_DEBUG", "1")
# Ключ нужен Django только для подписи cookie/сессий, которых здесь нет.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or "local-dev-only-not-secret"
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "rest_framework",
    "twin",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"


def _database(url: str) -> dict:
    """DATABASE_URL=postgres://user:pass@host:5432/name — PostgreSQL (так в Docker).
    Без переменной — файл SQLite рядом с manage.py: локальный запуск без установки СУБД."""
    if not url:
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}
    u = urlparse(url)
    if u.scheme not in ("postgres", "postgresql"):
        raise ValueError("DATABASE_URL: поддерживается только postgres://")
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": u.path.lstrip("/"),
        "USER": unquote(u.username or ""),
        "PASSWORD": unquote(u.password or ""),
        "HOST": u.hostname or "",
        "PORT": str(u.port or 5432),
        "CONN_MAX_AGE": 60,
    }


DATABASES = {"default": _database(os.environ.get("DATABASE_URL", "").strip())}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

TEMPLATES = []
STATIC_URL = "/static/"
LANGUAGE_CODE = "ru"
TIME_ZONE = "Asia/Almaty"
USE_TZ = True

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}

AI = {
    # demo — шаблонный ответ без сети; openai_compatible — Chat Completions API.
    "PROVIDER": os.environ.get("AI_PROVIDER", "demo").strip(),
    "BASE_URL": os.environ.get("AI_BASE_URL", "").strip(),
    "MODEL": os.environ.get("AI_MODEL", "").strip(),
    "API_KEY": os.environ.get("AI_API_KEY", "").strip(),
    "TIMEOUT_S": float(os.environ.get("AI_TIMEOUT_S", "30")),
    "JSON_MODE": _flag("AI_JSON_MODE", "1"),
    # Пусто — temperature не передаётся (некоторые модели принимают только значение по умолчанию).
    "TEMPERATURE": os.environ.get("AI_TEMPERATURE", "").strip(),
    # Явное разрешение отправлять расчётные факты внешнему провайдеру.
    "ALLOW_EXTERNAL": _flag("AI_ALLOW_EXTERNAL", "0"),
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"twin": {"handlers": ["console"], "level": "INFO"}},
}
