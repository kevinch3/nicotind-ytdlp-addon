# nicotind-ytdlp-addon

The **yt-dlp acquisition addon** for [NicotinD](https://github.com/kevinch3/NicotinD) — an
out-of-process HTTP addon speaking the **acquisition addon protocol v1**. It resolves audio from any
[yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported URL (YouTube, SoundCloud, Bandcamp, …).

Core carries no yt-dlp code; register this addon by URL + token under **Extensions** and it becomes
the low-priority **catch-all** resolver (`urlPatterns: ['^https?://']`, `priority: -10`) — so specific
addons (archive.org, spotdl) win their URLs and yt-dlp takes everything else.

## How it works

`POST /addon/v1/jobs {intent:'url', url}` spawns `yt-dlp` (extract-audio, embed metadata, skip
unavailable playlist items), downloading into the addon's storage, and **reads its output as it
runs** (parsed with `@nicotind/addon-sdk`'s `downloader-output` parsers): `[download] Downloading
playlist: <name>` becomes the job's `title`, two `--print` markers (`TRACK_START::<artist - title>\t<path>`
at `before_dl`, `TRACK_DONE::…` at `after_move`) become one item per video **in that order** — the
path after the TAB pairs the landed file exactly — and when yt-dlp announced more items
(`Downloading item N of M`) than ever reached a marker, the remainder are `unavailable` placeholders.
So a 1-of-16 playlist reads "1 of 16", `partial`, with yt-dlp's own `ERROR:` lines, not a clean
"Done 1 of 1" (NicotinD #585; the addon used to run with `stdio: 'ignore'` and glob staging).
`--print` implies `--quiet`, so `--no-quiet` keeps the lines the title and count come from. Every
yt-dlp line is also written to the addon's log, so `docker logs` has the transcript. Items flip
`fileReady` and the bytes are served from `GET /addon/v1/jobs/:id/files/:itemId` — core's
`AddonJobPoller` fetches them and runs the same organize → scan pipeline every source uses.
`POST /addon/v1/jobs/:id/cancel` SIGTERMs yt-dlp and closes the job `cancelled`. YouTube bot-checks are mitigated by the
**bgutil PO-token provider** run as a **sidecar**; the addon image bakes the paired
`bgutil-ytdlp-pot-provider` yt-dlp plugin.

The image pins **yt-dlp to the PyPI version current at build time** (`--build-arg YTDLP_VERSION`,
resolved by CI). It used to be "latest", which a cached Docker layer silently froze for weeks while
YouTube moved on — every media fetch 403'd (NicotinD #588). Rebuild the image to pick up a newer
yt-dlp; a local build needs the arg: `docker build --build-arg YTDLP_VERSION=$(curl -fsS https://pypi.org/pypi/yt-dlp/json | python3 -c 'import sys,json;print(json.load(sys.stdin)["info"]["version"])') .`

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

| Env var                     | Required | Default                 | Purpose                                           |
| --------------------------- | -------- | ----------------------- | ------------------------------------------------- |
| `YTDLP_ADDON_TOKEN`         | **yes**  | —                       | Bearer token core authenticates with              |
| `POT_PROVIDER_URL`          | —        | `http://127.0.0.1:4416` | bgutil PO-token provider sidecar base URL         |
| `YTDLP_ADDON_BINARY`        | —        | `yt-dlp`                | yt-dlp binary path                                |
| `YTDLP_ADDON_FORMAT`        | —        | —                       | yt-dlp format selector                            |
| `YTDLP_ADDON_COOKIES`       | —        | —                       | Netscape cookies.txt path (unblocks a flagged IP) |
| `YTDLP_ADDON_DOWNLOADS_DIR` | —        | `/data/downloads`       | staging dir                                       |
| `YTDLP_ADDON_PORT`          | —        | `8586`                  | HTTP listen port                                  |

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
