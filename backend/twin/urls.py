from django.urls import path

from . import views

urlpatterns = [
    path("overview/", views.overview),
    path("scenario/preset/", views.preset),
    path("scenario/run/", views.run_scenario),
    path("scenario/compare/", views.compare_scenarios),
    path("ai/status/", views.ai_status),
    path("ai/propose/", views.ai_propose),
    path("ai/explain/", views.ai_explain),
    path("incidents/", views.incidents),
    path("ml/shift/", views.ml_shift),
    path("ai/parse-report/", views.ai_parse_report),
    path("plan/month/", views.plan_month),
    path("incidents/<int:number>/", views.incident_detail),
]
