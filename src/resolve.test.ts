import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildArgs, runYtdlp } from "./resolve.js";

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
      "before_dl:TRACK_START::%(artist)s - %(title)s\t%(filename)s",
    );
    expect(args).toContain(
      "after_move:TRACK_DONE::%(artist)s - %(title)s\t%(filepath)s",
    );
    // --print implies --quiet, which would silence "Downloading playlist:" / "item N of M".
    expect(args).toContain("--no-quiet");
    expect(args).toContain("--newline");
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
