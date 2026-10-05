FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app

COPY cloud_app /app/cloud_app
COPY cloud_remote /app/cloud_remote
COPY scripts/verify-codex-web-assets.py /tmp/verify-codex-web-assets.py
RUN python /tmp/verify-codex-web-assets.py /app/cloud_app/static/codex-ui --version-file /app/cloud_app/pyproject.toml \
    && pip install --no-cache-dir /app/cloud_app \
    && useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin lanpower \
    && mkdir -p /var/lib/lanpower-cloud \
    && chown 10001:10001 /var/lib/lanpower-cloud

USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=2).read()" || exit 1
CMD ["uvicorn", "cloud_app.app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8765", "--no-access-log"]
