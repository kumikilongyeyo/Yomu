FROM ghcr.io/miwayomi/miwayomi:latest AS miwayomi
FROM caddy:2-alpine AS caddy

FROM eclipse-temurin:21-jre

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=miwayomi /app/miwayomi-all.jar /app/miwayomi-all.jar
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh

RUN chmod 0555 /entrypoint.sh \
    && useradd --home-dir /app --shell /usr/sbin/nologin -u 10001 yomu-runtime \
    && mkdir -p /data /config /caddy-data \
    && chown -R yomu-runtime:yomu-runtime /app /data /config /caddy-data

USER yomu-runtime

ENV PORT=8080 \
    MIWAYOMI_PORT=4567 \
    JAVA_OPTS="-Xmx512m -Xms64m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC" \
    FLARESOLVERR_URL="" \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/caddy-data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS -u "$YOMU_RUNTIME_USER:$YOMU_RUNTIME_PASSWORD" "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
