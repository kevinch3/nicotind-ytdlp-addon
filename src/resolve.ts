import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createInterface } from "node:readline";
import {
  parseYtdlpPlaylistTitle,
  parseYtdlpProgress,
  parseYtdlpTrackEvent,
  type DownloaderTrackEvent,
} from "@nicotind/addon-sdk";

const AUDIO_EXT = new Set([
  ".mp3",
  ".m4a",
  ".opus",
  ".flac",
  ".ogg",
  ".wav",
  ".aac",
  ".webm",
]);

export interface YtdlpConfig {
  binaryPath: string;
  cookiesFile?: string;
  format?: string;
  /** bgutil PO-token provider base URL (the sidecar). */
  potProviderUrl?: string;
}

export interface ResolveDeps {
  /** Injectable spawner (tests pass a fake). */
  spawn?: typeof nodeSpawn;
}

export interface ResolvedFile {
  path: string;
  filename: string;
  size: number;
}

/** What the run reports while it is going; every hook fires line-at-a-time. */
export interface RunHooks {
  /** `[download] Downloading playlist: <name>` — at most once. */
  onTitle?: (title: string) => void;
  /** The playlist's item count (`Downloading item N of M`), at most once. */
  onTotal?: (total: number) => void;
  /** One per `TRACK_START` / `TRACK_DONE` marker, in output order, with the file path. */
  onTrack?: (event: DownloaderTrackEvent) => void;
  /** Every output line, for the addon's own log. */
  onOutput?: (line: string) => void;
}

export interface RunResult {
  files: ResolvedFile[];
  exitCode: number | null;
  /** yt-dlp's `ERROR:` lines, oldest first — the real reasons. */
  errorLines: string[];
  /** The last ~2 KB of combined output, for a run that said nothing useful. */
  outputTail: string;
}

export interface RunningResolve {
  done: Promise<RunResult>;
  /** SIGTERM yt-dlp. Returns whether a process was signalled. */
  cancel: () => boolean;
}

/**
 * yt-dlp argument vector. Mirrors the retired in-process plugin: extract audio,
 * parse "Artist - Title" from the video title, embed metadata (so core reads real
 * tags — unlike tagless archive), skip unavailable playlist items. Adds the
 * bgutil PO-token provider extractor-arg and cookies when configured.
 *
 * The output contract: two `--print` markers give one line per track —
 * `TRACK_START::<artist - title>\t<path>` once a video is selected for download
 * (`before_dl`) and `TRACK_DONE::…` once the post-processed file is in place
 * (`after_move`). The path after the TAB is what pairs a landed file to its
 * track exactly (a title can repeat within a playlist; `::` can appear in a
 * title, a tab cannot). `--print` implies `--quiet`, which would also silence
 * the `[download] Downloading playlist:` / `Downloading item N of M` lines the
 * title and the total are read from — hence `--no-quiet`; `--newline` keeps
 * every progress update on its own line.
 */
export function buildArgs(
  url: string,
  stagingDir: string,
  cfg: YtdlpConfig,
): string[] {
  const args = [
    url,
    "--ignore-errors",
    "--no-progress",
    "--newline",
    "--no-quiet",
    "--extract-audio",
    "--audio-quality",
    "0",
    "--parse-metadata",
    "title:%(artist)s - %(title)s",
    "--embed-metadata",
    "--paths",
    stagingDir,
    "-o",
    "%(artist)s/%(album,playlist_title,uploader)s/%(title)s.%(ext)s",
    "--print",
    "before_dl:TRACK_START::%(artist)s - %(title)s\t%(filename)s",
    "--print",
    "after_move:TRACK_DONE::%(artist)s - %(title)s\t%(filepath)s",
  ];
  if (cfg.format) args.push("--format", cfg.format);
  if (cfg.cookiesFile && existsSync(cfg.cookiesFile))
    args.push("--cookies", cfg.cookiesFile);
  if (cfg.potProviderUrl) {
    args.push(
      "--extractor-args",
      `youtubepot-bgutilhttp:base_url=${cfg.potProviderUrl}`,
    );
  }
  return args;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function globAudioFiles(dir: string): ResolvedFile[] {
  const out: ResolvedFile[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (AUDIO_EXT.has(extname(entry.name).toLowerCase())) {
        out.push({ path: p, filename: basename(p), size: statSync(p).size });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Spawn yt-dlp for `url`, downloading audio into `stagingDir`, streaming its
 * output through `hooks`, and settle with the files that landed plus what the
 * run said about itself. Success is the caller's call: yt-dlp exits non-zero
 * whenever any playlist item failed — even with `--ignore-errors`, even after
 * downloading every other item — so the exit code decides nothing on its own.
 */
export function runYtdlp(
  url: string,
  stagingDir: string,
  cfg: YtdlpConfig,
  deps: ResolveDeps = {},
  hooks: RunHooks = {},
): RunningResolve {
  const spawn = deps.spawn ?? nodeSpawn;
  const args = buildArgs(url, stagingDir, cfg);
  const child: ChildProcess = spawn(cfg.binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  let titleSeen = false;
  let totalSeen = false;
  let progress = { done: 0, total: 0 };
  const errorLines: string[] = [];
  let tail = "";
  const onLine = (raw: string): void => {
    const line = raw.replace(ANSI, "").trimEnd();
    if (!line) return;
    hooks.onOutput?.(line);
    tail = (tail + line + "\n").slice(-2048);
    if (line.startsWith("ERROR:")) errorLines.push(line);
    if (!titleSeen) {
      const title = parseYtdlpPlaylistTitle(line);
      if (title) {
        titleSeen = true;
        hooks.onTitle?.(title);
      }
    }
    if (!totalSeen) {
      // The percent form also parses (`total: 100`); only the item counter is a count.
      const next = /Downloading item \d+ of \d+/.test(line)
        ? parseYtdlpProgress(line, progress)
        : progress;
      if (next.total > 0 && next !== progress) {
        totalSeen = true;
        hooks.onTotal?.(next.total);
      }
      progress = next;
    }
    const event = parseYtdlpTrackEvent(line);
    if (event) hooks.onTrack?.(event);
  };

  const readers: Promise<void>[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", onLine);
    readers.push(new Promise((resolve) => rl.once("close", () => resolve())));
  }

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      // Drain both line readers before reporting: `close` can beat the last
      // buffered marker.
      void Promise.all(readers).then(() =>
        resolve({
          files: globAudioFiles(stagingDir),
          exitCode: code,
          errorLines,
          outputTail: tail,
        }),
      );
    });
  });

  return {
    done,
    cancel: () => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return child.kill("SIGTERM");
    },
  };
}
