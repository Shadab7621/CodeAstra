# Engine node image. Build from the repo root:  docker build -f engine/Dockerfile -t codeastra-engine .
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY engine/requirements.txt engine/requirements.txt
RUN pip install --no-cache-dir -r engine/requirements.txt

COPY engine engine

# The database lives in /data so it can be a volume and survive container restarts.
RUN useradd --create-home app && mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]

# NODE_ID, PORT, PEERS and DB_PATH are supplied by docker-compose.yml.
ENV PORT=8001
EXPOSE 8001 8002 8003
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ['PORT'], timeout=2)"

CMD ["sh", "-c", "exec uvicorn engine.app.main:create_app --factory --host 0.0.0.0 --port ${PORT} --log-level warning"]
