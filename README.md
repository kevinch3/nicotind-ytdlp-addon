# nicotind-ytdlp-addon

The **yt-dlp acquisition addon** for [NicotinD](https://github.com/kevinch3/NicotinD) — an
out-of-process HTTP addon speaking the **acquisition addon protocol v1**. It resolves audio from any
[yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported URL (YouTube, SoundCloud, Bandcamp, …).

Core carries no yt-dlp code; register this addon by URL + token under **Extensions** and it becomes
the low-priority **catch-all** resolver (`urlPatterns: ['^https?://']`, `priority: -10`) — so specific
addons (archive.org, spotdl) win their URLs and yt-dlp takes everything else.

## How it works

`POST /addon/v1/jobs {intent:'url', url}` spawns `yt-dlp` (extract-audio, embed metadata, skip
unavailable playlist items), downloading into the addon's storage. Items flip `fileReady` and the
bytes are served from `GET /addon/v1/jobs/:id/files/:itemId` — core's `AddonJobPoller` fetches them and
runs the same organize → scan pipeline every source uses. YouTube bot-checks are mitigated by the
**bgutil PO-token provider** run as a **sidecar**; the addon image bakes the paired
`bgutil-ytdlp-pot-provider` yt-dlp plugin.

## Run (Docker)

```bash
docker run -d --name ytdlp-addon \
  -p 8586:8586 \
  -v /srv/ytdlp-addon:/data \
  -e YTDLP_ADDON_TOKEN=<a-long-random-secret> \
  -e POT_PROVIDER_URL=http://bgutil-provider:4416 \
  ghcr.io/kevinch3/nicotind-ytdlp-addon:latest
```

Then in NicotinD → **Extensions → Add addon**, register `http://<host>:8586` with the same token.

## Configuration

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `YTDLP_ADDON_TOKEN` | **yes** | — | Bearer token core authenticates with |
| `POT_PROVIDER_URL` | — | `http://127.0.0.1:4416` | bgutil PO-token provider sidecar base URL |
| `YTDLP_ADDON_BINARY` | — | `yt-dlp` | yt-dlp binary path |
| `YTDLP_ADDON_FORMAT` | — | — | yt-dlp format selector |
| `YTDLP_ADDON_COOKIES` | — | — | Netscape cookies.txt path (unblocks a flagged IP) |
| `YTDLP_ADDON_DOWNLOADS_DIR` | — | `/data/downloads` | staging dir |
| `YTDLP_ADDON_PORT` | — | `8586` | HTTP listen port |

Only `GET /addon/v1/manifest` + `/health` are unauthenticated; every other route needs the bearer token.

## Develop

```bash
bun install
bun run typecheck   # tsc --build
bun run test        # bun:test — resolve engine (injected spawner) + protocol server
```

> The addon depends on `@nicotind/addon-sdk`. The `url` job intent it uses shipped in core but is
> pending in the published SDK; once `@nicotind/addon-sdk@^0.1.1` is out, bump the dep and drop the
> one `as unknown as` cast in `src/job-store.ts`.

## License

AGPL-3.0-only, matching NicotinD.
