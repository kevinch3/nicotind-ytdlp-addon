# The yt-dlp acquisition addon — NicotinD acquisition addon protocol v1.
FROM oven/bun:1.3.14

# yt-dlp needs Python + ffmpeg; the bgutil PO-token provider *plugin* teaches
# yt-dlp to fetch a token from the pot-provider sidecar. Pin both — the plugin
# version must pair with the sidecar image (mirror the monorepo's BGUTIL_VERSION).
# `unzip` is required by the Deno installer below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Deno — yt-dlp needs a JS runtime to solve YouTube's player-signature challenges;
# without one YouTube extraction is deprecated/degraded and many videos fail
# ("No supported JavaScript runtime could be found"). Matches the monorepo image.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# yt-dlp is deliberately unpinned (latest) — YouTube breaks older versions
# continuously, matching the monorepo's own image. BGUTIL_VERSION pins the
# provider plugin to the pot-provider sidecar image (same default as the
# monorepo; override to move both in lockstep).
ARG BGUTIL_VERSION=1.3.1
RUN pip3 install --no-cache-dir --break-system-packages --upgrade \
  yt-dlp \
  "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}"

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENV YTDLP_ADDON_BINARY=yt-dlp \
    YTDLP_ADDON_DOWNLOADS_DIR=/data/downloads \
    YTDLP_ADDON_PORT=8586

EXPOSE 8586

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS "http://127.0.0.1:${YTDLP_ADDON_PORT}/addon/v1/health" | grep -q '"ok":true' || exit 1

CMD ["bun", "run", "src/main.ts"]
