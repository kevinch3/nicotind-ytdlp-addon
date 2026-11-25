import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildArgs, isAlbumPlaylist, jsRuntimeFor, runYtdlp } from "./resolve.js";

/**
 * A fake yt-dlp: writes `lines` to stdout, runs `writeTo` (dropping files into
 * staging), then closes with `code`. Captures the spawn options.
 */
export function fakeSpawn(
  opts: {
    lines?: string[];
    writeTo?: (paths: string) => void;
    code?: number;
    hang?: boolean;
  } = {},
  capture?: { opts?: unknown; killed?: string },
) {
  return ((_bin: string, args: string[], spawnOpts?: unknown) => {
    if (capture) capture.opts = spawnOpts;
    const paths = args[args.indexOf("--paths") + 1]!;
    const em = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: string | null;
      kill: (sig: string) => boolean;
    };
    em.stdout = new PassThrough();
    em.stderr = new PassThrough();
    em.exitCode = null;
    em.signalCode = null;
    const finish = (code: number | null): void => {
      em.exitCode = code;
      em.stdout.end();
      em.stderr.end();
      em.emit("close", code);
    };
    em.kill = (sig: string) => {
      if (capture) capture.killed = sig;
      em.signalCode = sig;
      queueMicrotask(() => finish(null));
      return true;
    };
    queueMicrotask(() => {
      for (const l of opts.lines ?? [])
        em.stdout.write(l.replace(/\{paths\}/g, paths) + "\n");
      opts.writeTo?.(paths);
      if (!opts.hang) setTimeout(() => finish(opts.code ?? 0), 5);
    });
    return em;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("buildArgs", () => {
  it("extracts audio and wires the pot-provider + cookies when configured", () => {
    const args = buildArgs("https://youtube.com/watch?v=x", "/stage", {
      binaryPath: "yt-dlp",
      potProviderUrl: "http://pot:4416",
    });
    expect(args).toContain("--extract-audio");
    expect(args).toContain("--ignore-errors");
    expect(args.join(" ")).toContain(
      "youtubepot-bgutilhttp:base_url=http://pot:4416",
    );
  });

  it("prints per-track markers with the path after a TAB, and keeps the playlist lines", () => {
    const args = buildArgs("https://youtube.com/playlist?list=x", "/stage", {
      binaryPath: "yt-dlp",
    });
    expect(args).toContain(
      "before_dl:TRACK_START::%(artists.0,artist,uploader)s - %(title)s\t%(filename)s",
    );
    expect(args).toContain(
      "after_move:TRACK_DONE::%(artists.0,artist,uploader)s - %(title)s\t%(filepath)s",
    );
    // --print implies --quiet, which would silence "Downloading playlist:" / "item N of M".
    expect(args).toContain("--no-quiet");
    expect(args).toContain("--newline");
  });
});

// NicotinD #1738: YouTube needs a JS runtime and the EJS challenge solver. The
// image ships Deno (yt-dlp's default); a bare-metal install usually has only the
// Bun this addon runs on, and without it formats go missing and the n challenge
// fails.
describe("buildArgs — JS runtime", () => {
  it("enables the given Bun and lets yt-dlp fetch the EJS solver from npm", () => {
    const args = buildArgs("u", "/stage", { binaryPath: "yt-dlp", jsRuntime: "/home/u/.bun/bin/bun" });
    const at = args.indexOf("--js-runtimes");
    expect(args[at + 1]).toBe("bun:/home/u/.bun/bin/bun");
    const rc = args.indexOf("--remote-components");
    expect(args[rc + 1]).toBe("ejs:npm");
  });

  it("adds nothing when no runtime is configured (an older yt-dlp rejects the flags)", () => {
    const args = buildArgs("u", "/stage", { binaryPath: "yt-dlp" });
    expect(args).not.toContain("--js-runtimes");
    expect(args).not.toContain("--remote-components");
  });
});

describe("jsRuntimeFor", () => {
  const help = (text: string) => () => text;

  it("offers this process's Bun when yt-dlp knows --js-runtimes", () => {
    expect(
      jsRuntimeFor({}, "/bin/bun", help("  --js-runtimes RUNTIME[:PATH]\n  --remote-components")),
    ).toBe("/bin/bun");
  });

  it("offers nothing to a yt-dlp that predates the flag", () => {
    expect(jsRuntimeFor({}, "/bin/bun", help("  --format FORMAT"))).toBeUndefined();
  });

  it("honours YTDLP_ADDON_JS_RUNTIME: a path, or none", () => {
    const h = help("--js-runtimes --remote-components");
    expect(jsRuntimeFor({ YTDLP_ADDON_JS_RUNTIME: "/opt/bun" }, "/bin/bun", h)).toBe("/opt/bun");
    expect(jsRuntimeFor({ YTDLP_ADDON_JS_RUNTIME: "none" }, "/bin/bun", h)).toBeUndefined();
  });
});

describe("runYtdlp", () => {
  const stageFor = (tag: string): string =>
    join(tmpdir(), `yt-${process.pid}-${Date.now()}-${tag}`);

  it("streams the title, the total and each marker, then reports the files", async () => {
    const stage = stageFor("run");
    const seen: string[] = [];
    const run = runYtdlp(
      "https://youtube.com/playlist?list=x",
      stage,
      { binaryPath: "yt-dlp" },
      {
        spawn: fakeSpawn({
          lines: [
            "[download] Downloading playlist: My Mix",
            "[download] Downloading item 1 of 3",
            "TRACK_START::A - One\t{paths}/A/My Mix/One.webm",
            "[download]  45.2% of 3MiB",
            "TRACK_DONE::A - One\t{paths}/A/My Mix/One.opus",
            "[download] Downloading item 2 of 3",
            "ERROR: [youtube] zzz: Video unavailable",
          ],
          writeTo: (paths) => {
            mkdirSync(join(paths, "A", "My Mix"), { recursive: true });
            writeFileSync(
              join(paths, "A", "My Mix", "One.opus"),
              "audio-bytes",
            );
          },
          code: 1,
        }),
      },
      {
        onTitle: (t) => seen.push(`title:${t}`),
        onTotal: (n) => seen.push(`total:${n}`),
        onTrack: (e) => seen.push(`${e.status}:${e.title}`),
      },
    );
    const result = await run.done;
    expect(seen).toEqual([
      "title:My Mix",
      "total:3",
      "downloading:A - One",
      "done:A - One",
    ]);
    expect(result.files.map((f) => f.filename)).toEqual(["One.opus"]);
    expect(result.exitCode).toBe(1);
    expect(result.errorLines).toEqual([
      "ERROR: [youtube] zzz: Video unavailable",
    ]);
  });

  it("spawns with piped output", async () => {
    const capture: { opts?: { stdio?: unknown } } = {};
    await runYtdlp(
      "https://youtube.com/watch?v=x",
      stageFor("env"),
      { binaryPath: "yt-dlp" },
      {
        spawn: fakeSpawn({}, capture),
      },
    ).done;
    expect(capture.opts?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("cancel SIGTERMs the child", async () => {
    const capture: { killed?: string } = {};
    const run = runYtdlp(
      "https://youtube.com/watch?v=x",
      stageFor("cancel"),
      { binaryPath: "yt-dlp" },
      {
        spawn: fakeSpawn({ hang: true }, capture),
      },
    );
    await new Promise((r) => setTimeout(r, 2));
    expect(run.cancel()).toBe(true);
    await run.done;
    expect(capture.killed).toBe("SIGTERM");
  });
});

/**
 * NicotinD #866. Runs the real yt-dlp over info dicts, because these rules are only
 * as good as how yt-dlp reads them: the first draft of the title pattern looked right
 * and read `[99] TE VAS` as an artist called `99] TE VAS`. No network.
 */
describe.skipIf(!Bun.which("yt-dlp"))("what yt-dlp makes of a video's metadata", () => {
  const FIELDS = "%(artist)s|%(meta_artist)s|%(title)s|%(meta_date)s|%(artists.0,artist,uploader)s";

  function read(info: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "ytdlp-meta-"));
    try {
      const file = join(dir, "video.info.json");
      writeFileSync(
        file,
        JSON.stringify({
          id: "x",
          extractor: "youtube",
          extractor_key: "Youtube",
          webpage_url: "https://x",
          webpage_url_basename: "watch",
          ext: "mp4",
          url: "https://x/a",
          formats: [{ format_id: "1", url: "https://x/a", ext: "mp4" }],
          uploader: "Uploader",
          upload_date: "20150502",
          ...info,
        }),
      );
      const parse = buildArgs("u", "/stage", { binaryPath: "yt-dlp" }).flatMap((a, i, all) =>
        all[i - 1] === "--parse-metadata" ? ["--parse-metadata", a] : [],
      );
      const r = Bun.spawnSync([
        "yt-dlp",
        "--ignore-config",
        "--simulate",
        "--load-info-json",
        file,
        ...parse,
        "--print",
        FIELDS,
      ]);
      const [artist, metaArtist, title, metaDate, folder] = r.stdout
        .toString()
        .trim()
        .split("\n")
        .at(-1)!
        .split("|");
      return { artist, metaArtist, title, metaDate, folder };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("takes the performer from a YouTube Music credit list, and the release year", () => {
    const got = read({
      title: "Volver a los 17",
      artists: ["Sanampay", "A. ZITARROSA"],
      release_year: 1997,
    });
    expect(got.metaArtist).toBe("Sanampay");
    expect(got.folder).toBe("Sanampay");
    expect(got.title).toBe("Volver a los 17");
    expect(got.metaDate).toBe("1997");
  });

  it("does not read a bracketed chart position as an artist", () => {
    const title = "[99] TE VAS - DJ LOCO CABANA-PERU FT. DVJ LUIS BRAVO";
    const got = read({ title });
    expect(got.artist).toBe("NA");
    expect(got.title).toBe(title);
    expect(got.folder).toBe("Uploader");
  });

  it("still splits a plain Artist - Title, hyphens included", () => {
    expect(read({ title: "Lenny Kravitz - Low" })).toMatchObject({
      artist: "Lenny Kravitz",
      title: "Low",
      folder: "Lenny Kravitz",
    });
    expect(read({ title: "Jay-Z - 99 Problems" })).toMatchObject({
      artist: "Jay-Z",
      title: "99 Problems",
    });
  });

  it("leaves the date to the embed when there is no release year", () => {
    expect(read({ title: "A - B" }).metaDate).toBe("NA");
  });
});

// #4: a YouTube category is not a genre, and only an album playlist's position
// is a track number and its thumbnail a cover. Proven against yt-dlp 2026.03.17
// offline (MetadataParser + FFmpegMetadata on synthetic info, and a file:// run
// through ThumbnailsConvertor + EmbedThumbnail): categories ["Music"] → no genre
// tag, track_number outranks playlist_index, a 1280x720 thumbnail → 720x720 cover.
describe("buildArgs — genre, track number, cover (#4)", () => {
  const ALBUM = "https://music.youtube.com/playlist?list=OLAK5uy_abc";
  const pairAfter = (args: string[], flag: string) =>
    args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  it("writes the real genre or none, never YouTube's category", () => {
    const args = buildArgs("https://youtube.com/watch?v=x", "/stage", { binaryPath: "yt-dlp" });
    expect(pairAfter(args, "--parse-metadata")).toContain("%(genre,genres|)s:(?P<meta_genre>.*)");
  });

  it("an album playlist falls back to the playlist position and embeds the square cover", () => {
    const args = buildArgs(ALBUM, "/stage", { binaryPath: "yt-dlp" });
    expect(pairAfter(args, "--parse-metadata")).toContain(
      "%(track_number,playlist_index|)s:(?P<meta_track>.+)",
    );
    expect(args).toContain("--embed-thumbnail");
    expect(pairAfter(args, "--convert-thumbnails")).toEqual(["png"]);
    expect(pairAfter(args, "--ppa")[0]).toContain(`crop="'min(iw,ih)':'min(iw,ih)'"`);
  });

  it("a video or a user playlist gets neither", () => {
    for (const url of ["https://youtube.com/watch?v=x", "https://youtube.com/playlist?list=PLabc"]) {
      const args = buildArgs(url, "/stage", { binaryPath: "yt-dlp" });
      expect(args).not.toContain("--embed-thumbnail");
      expect(args.join(" ")).not.toContain("playlist_index");
    }
  });

  it("isAlbumPlaylist reads the list id, and a non-URL is not one", () => {
    expect(isAlbumPlaylist(ALBUM)).toBe(true);
    expect(isAlbumPlaylist("https://www.youtube.com/watch?v=a&list=OLAK5uy_x")).toBe(true);
    expect(isAlbumPlaylist("https://youtube.com/playlist?list=PLx")).toBe(false);
    expect(isAlbumPlaylist("not a url")).toBe(false);
  });
});
