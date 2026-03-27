FROM node:22-bookworm-slim

RUN useradd --create-home --shell /bin/bash dev \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
    && rm -rf /var/lib/apt/lists/*

USER dev
WORKDIR /workspace

ENV npm_config_update_notifier=false
ENV CI=false
