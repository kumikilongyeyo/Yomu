FROM caddy:2-alpine AS caddy

FROM eclipse-temurin:21-jre

ARG MIWAYOMI_VERSION=0.2.9
ARG MIWAYOMI_SHA256=475b95dabaaca9f283263a5eafa12bec3580b658caae70407ae227ae4fa0e9b7

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fL --retry 3 \
      "https://github.com/miwayomi/miwayomi/releases/download/v${MIWAYOMI_VERSION}/miwayomi-all.jar" \
      -o /app/miwayomi-all.jar \
    && echo "${MIWAYOMI_SHA256}  /app/miwayomi-all.jar" | sha256sum -c -

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
