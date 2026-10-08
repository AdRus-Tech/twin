# Сборка в два этапа: фронтенд собирается в Node, приложение запускается в Python.

FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/backend
COPY backend/requirements.txt backend/requirements-docker.txt ./
RUN pip install -r requirements-docker.txt
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY frontend/src/__fixtures__/plan_month.json /app/frontend/src/__fixtures__/plan_month.json
RUN useradd --create-home app && chown -R app /app
USER app
EXPOSE 8000
# Миграции при старте: база может быть новой.
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 2 --timeout 120 --access-logfile -"]
