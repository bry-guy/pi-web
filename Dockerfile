FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real \
    HOME=/data/pi-ez-operator-home \
    XDG_CONFIG_HOME=/data/pi-ez-operator-home/.config \
    XDG_DATA_HOME=/data/pi-ez-operator-home/.local/share \
    XDG_CACHE_HOME=/data/pi-ez-operator-home/.cache

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      openssl \
      python3 \
      rsync \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# mise and yadm let deployment prestart hooks install the operator's dotfiles
# and project tools. Downloads are pinned by SHA-256.
RUN set -eu; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$tmp/mise" \
      'https://github.com/jdx/mise/releases/download/v2026.8.5/mise-v2026.8.5-linux-x64'; \
    echo "ee362b6d96c648e27325a8bc7ee866bde4fffc20c88c777c5eb5c3b5c6f3e226  $tmp/mise" | sha256sum -c -; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$tmp/yadm.tar.gz" \
      'https://github.com/yadm-dev/yadm/archive/refs/tags/3.5.0.tar.gz'; \
    echo "2a15ed91238dd2f15db9905eb56702272c079ad9c37c505dfee69c6b5e9054b6  $tmp/yadm.tar.gz" | sha256sum -c -; \
    tar -xzf "$tmp/yadm.tar.gz" -C "$tmp" yadm-3.5.0/yadm; \
    install -m 0755 "$tmp/mise" /usr/local/bin/mise; \
    install -m 0755 "$tmp/yadm-3.5.0/yadm" /usr/local/bin/yadm; \
    rm -rf "$tmp"

COPY package.json package-lock.json ./

# Pi is a production dependency: the real supervisor imports its SDK in-process.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# pi-sync is installed from the public bry-guy/pi-sync repository at the
# commit pinned in PI_SYNC_COMMIT.
COPY PI_SYNC_COMMIT ./
COPY scripts/install-pi-sync.sh ./scripts/
RUN ./scripts/install-pi-sync.sh \
    && rm -rf .cache \
    && npm cache clean --force

COPY server ./server
COPY workspaced ./workspaced

COPY public ./public

RUN mkdir -p /data/pi-ez-operator-home \
    && printf '#!/bin/sh\nexec node /app/server/git-credential-helper.js "$@"\n' > /usr/local/bin/pi-ez-web-git-credential-helper \
    && chmod 0755 /usr/local/bin/pi-ez-web-git-credential-helper \
    && git config --system credential.https://github.com.helper /usr/local/bin/pi-ez-web-git-credential-helper \
    && chown -R node:node /data

# Last, so a new build ID does not invalidate the dependency layers above.
ARG PI_WEB_BUILD_ID=development
ENV PI_WEB_BUILD_ID=$PI_WEB_BUILD_ID

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
