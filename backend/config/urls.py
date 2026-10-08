import mimetypes

from django.conf import settings
from django.http import FileResponse, HttpResponse
from django.urls import include, path, re_path
from django.views.static import serve

# Keep image responses consistent across Windows and minimal Linux images.
mimetypes.add_type("image/webp", ".webp")


def spa_index(request):
    index = settings.FRONTEND_DIST / "index.html"
    if not index.is_file():
        return HttpResponse(
            "Фронтенд не собран. Выполните: cd frontend && npm run build "
            "или откройте dev-сервер Vite (npm run dev).",
            content_type="text/plain; charset=utf-8",
            status=503,
        )
    return FileResponse(index.open("rb"), content_type="text/html; charset=utf-8")


urlpatterns = [
    path("api/", include("twin.urls")),
    re_path(r"^assets/(?P<path>.*)$", serve, {"document_root": settings.FRONTEND_DIST / "assets"}),
    # HDR-панорама окружения (Poly Haven, CC0) из frontend/public/env, после сборки — dist/env.
    re_path(r"^env/(?P<path>.*)$", serve, {"document_root": settings.FRONTEND_DIST / "env"}),
    path("", spa_index),
]
