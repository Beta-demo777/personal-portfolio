FROM python:3.14.6-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10

WORKDIR /app

RUN groupadd --gid 10001 portfolio \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin portfolio \
    && mkdir -p /app/uploads \
    && chown -R portfolio:portfolio /app

COPY backend/requirements.lock ./requirements.lock
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --no-compile --require-hashes -r requirements.lock

COPY --chown=portfolio:portfolio alembic.ini ./alembic.ini
COPY --chown=portfolio:portfolio backend/alembic ./backend/alembic
COPY --chown=portfolio:portfolio backend/app ./app
COPY backend/docker-entrypoint.sh /usr/local/bin/portfolio-entrypoint
RUN chmod 0755 /usr/local/bin/portfolio-entrypoint

USER portfolio

EXPOSE 8000

ENTRYPOINT ["portfolio-entrypoint"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
