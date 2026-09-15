FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev libfontconfig1-dev libfreetype6-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 libfontconfig1 libfreetype6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/yomu-aidoku-runtime /usr/local/bin/yomu-aidoku-runtime
ENV PORT=8080
EXPOSE 8080
CMD ["yomu-aidoku-runtime"]
