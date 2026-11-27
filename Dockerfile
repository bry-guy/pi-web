FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real \
    PI_KEEPALIVE=off \
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
      libxml2 \
      openssh-client \
      openssl \
      python3 \
      rsync \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# mise and yadm let deployment prestart hooks install the operator's dotfiles
# and project tools; workspaced drives OpenShell sandboxes with the openshell
# CLI (a static musl build); kubectl matches the cluster (v1.34); gh lets role
# workers open and merge pull requests. Downloads are
# pinned by SHA-256, kubectl by the SHA-512 its release notes publish.
RUN set -eu; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$tmp/mise" \
      'https://github.com/jdx/mise/releases/download/v2026.8.5/mise-v2026.8.5-linux-x64'; \
    echo "ee362b6d96c648e27325a8bc7ee866bde4fffc20c88c777c5eb5c3b5c6f3e226  $tmp/mise" | sha256sum -c -; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$tmp/yadm.tar.gz" \
      'https://github.com/yadm-dev/yadm/archive/refs/tags/3.5.0.tar.gz'; \
    echo "2a15ed91238dd2f15db9905eb56702272c079ad9c37c505dfee69c6b5e9054b6  $tmp/yadm.tar.gz" | sha256sum -c -; \
    tar -xzf "$tmp/yadm.tar.gz" -C "$tmp" yadm-3.5.0/yadm; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 -o "$tmp/openshell.tar.gz" \
      'https://github.com/ai-openshell/openshell/releases/download/v0.1.10/openshell-x86_64-unknown-linux-musl.tar.gz'; \
    echo "2467a09d839bb9af43bf1d649d72e77e596578cbd8e567b6e55a0c504c222f5f  $tmp/openshell.tar.gz" | sha256sum -c -; \
    tar -xzf "$tmp/openshell.tar.gz" -C "$tmp" openshell; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 -o "$tmp/gh.tar.gz" \
      'https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_linux_amd64.tar.gz'; \
    echo "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f  $tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf "$tmp/gh.tar.gz" -C "$tmp" gh_2.105.0_linux_amd64/bin/gh; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 -o "$tmp/kubernetes-client.tar.gz" \
      'https://dl.k8s.io/v1.34.5/kubernetes-client-linux-amd64.tar.gz'; \
    echo "293977e3cb48e669a1354d643a61ff736337e6869a6ce5e109428fadda8e1fcf8597ebdbedfafd60fd096e1521fab4dfade6430c1911d1f4f05f7737dc5c453a  $tmp/kubernetes-client.tar.gz" | sha512sum -c -; \
    tar -xzf "$tmp/kubernetes-client.tar.gz" -C "$tmp" kubernetes/client/bin/kubectl; \
    install -m 0755 "$tmp/mise" /usr/local/bin/mise; \
    install -m 0755 "$tmp/yadm-3.5.0/yadm" /usr/local/bin/yadm; \
    install -m 0755 "$tmp/openshell" /usr/local/bin/openshell; \
    install -m 0755 "$tmp/kubernetes/client/bin/kubectl" /usr/local/bin/kubectl; \
    install -m 0755 "$tmp/gh_2.105.0_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf "$tmp"

# agy (Antigravity CLI) for workers that load @estebanforge/pi-antigravity-bridge: a pinned build from Google's
# release manifest (https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_<arch>.json),
# pinned by SHA-512. Bump these to update.
ARG AGY_BUILD=1.5.18-6386224290725888
ARG AGY_SHA512_X64=ef379ec869719112f696e8c7cfddf776618712e58fc38e53df80801d6528abb4677782c7c8778f9c09c9123fa44c2c32675d228c06f2a8f7a8f4214e75f5bb26
ARG AGY_SHA512_ARM64=6c59cbce5a7632083dd4ef594296e52ce0abdc12f8b4ecb55523e093748cf178f8f8383d7e51e9ed7859ea6e46c83a43a7b46364b0e033dd13afb24d6bfbe4c8
RUN set -eu; \
    arch="$([ "$(uname -m)" = x86_64 ] && echo x64 || echo arm64)"; \
    dir="$([ "$arch" = x64 ] && echo linux-x64 || echo linux-arm)"; \
    sum="$([ "$arch" = x64 ] && echo "$AGY_SHA512_X64" || echo "$AGY_SHA512_ARM64")"; \
    tmp="$(mktemp -d)"; \
    curl -fsSL --proto '=https' --tlsv1.2 --max-time 300 -o "$tmp/agy.tar.gz" \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/$AGY_BUILD/$dir/cli_linux_$arch.tar.gz"; \
    echo "$sum  $tmp/agy.tar.gz" | sha512sum -c -; \
    tar -xzf "$tmp/agy.tar.gz" -C "$tmp" antigravity; \
    install -m 0755 "$tmp/antigravity" /usr/local/bin/agy; \
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
