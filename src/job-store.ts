import { randomUUID } from "node:crypto";
import { join, basename, extname, resolve as resolvePath } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AddonJob,
  AddonJobItem,
  DownloaderTrackEvent,
} from "@nicotind/addon-sdk";
import {
  runYtdlp,
  type YtdlpConfig,
  type ResolveDeps,
  type ResolvedFile,
  type RunningResolve,
} from "./resolve.js";

interface JobEntry {
  job: AddonJob;
  paths: Map<string, string>;
}

interface JobRow {
  id: string;
  job_json: string;
  files_json: string;
}

const USERNAME = "ytdlp-addon";

/**
 * Pair the files that landed with the tracks yt-dlp reported. A `TRACK_DONE`
 * marker carries the final path, so the match is exact; a track that only
 * reached `TRACK_START` carries the pre-postprocessing filename, whose stem
 * survives the audio extraction (`.webm` → `.opus`), so the stem is the
 * fallback. Returns the item index each file belongs to, or -1 for a file no
 * reported track claims (it still ships — it is real audio).
 */
export function matchFilesToItems(
  files: ResolvedFile[],
  reported: ReadonlyArray<string | undefined>,
): number[] {
  const byPath = new Map<string, number>();
  const byStem = new Map<string, number>();
  reported.forEach((p, i) => {
    if (!p) return;
    byPath.set(resolvePath(p), i);
    byStem.set(basename(p, extname(p)), i);
  });
  const claimed = new Set<number>();
  return files.map((f) => {
    const candidates = [
      byPath.get(resolvePath(f.path)),
      byStem.get(basename(f.path, extname(f.path))),
    ];
    for (const idx of candidates) {
      if (idx !== undefined && !claimed.has(idx)) {
        claimed.add(idx);
        return idx;
      }
    }
    return -1;
  });
}

/**
 * SQLite-backed job store (issue #515). `create` returns an active job
 * immediately and resolves the URL in the background (yt-dlp runs for
 * seconds/minutes), so core's poll sees an in-flight job flip to `done` with
 * `fileReady` items — the exact loop the archive/slskd addons use. Files stage
 * under `<stagingBase>/<jobId>/`.
 *
 * **What a job reports** (NicotinD issue #585): this store used to glob staging
 * after yt-dlp exited and call whatever it found a complete job — so a playlist
 * of 16 where one video came through read as a clean "Done 1 of 1" under the
 * source label, and the addon kept no record of why. Now yt-dlp's output is
 * read as it runs: the playlist title becomes `AddonJob.title`, every
 * `TRACK_START`/`TRACK_DONE` marker becomes an item **in that order**, and a
 * shortfall against the announced item count is filled with `unavailable`
 * placeholders so the host's count is honest. The job closes `done` only when
 * every track landed, `partial` with yt-dlp's own `ERROR:` lines otherwise, and
 * `failed` when nothing did.
 *
 * **Why persist** (the ghost-card fix): jobs used to live only in memory, so a
 * restart mid-download dropped them and core's cursor poll never revisited them
 * — they sat "downloading" until core's 24h valve (#515/#516). Now every
 * mutation writes through to `<dataDir>/jobs.db`, and on boot any job still
 * `active` is marked **failed** (the process that was downloading it is gone),
 * so core surfaces an honest failure instead of a ghost. The in-memory Map is
 * kept as a write-through cache so the frequently-polled `list`/`get` stay hot.
 */
export class JobStore {
  private jobs = new Map<string, JobEntry>();
  private running = new Map<string, RunningResolve>();
  private db: Database;

  constructor(
    private readonly stagingBase: string,
    private readonly config: () => YtdlpConfig,
    private readonly deps: ResolveDeps = {},
    dbPath = ":memory:",
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id         TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        job_json   TEXT NOT NULL,
        files_json TEXT NOT NULL
      )
    `);
    this.hydrate();
  }

  /**
   * Rebuild the in-memory cache from disk on boot. A job still `active` means
   * the addon died while downloading it — mark it failed (with a fresh
   * `updatedAt` so core's cursor poll picks up the transition) rather than let
   * it ghost forever.
   */
  private hydrate(): void {
    const rows = this.db
      .query<JobRow, []>(`SELECT id, job_json, files_json FROM jobs`)
      .all();
    for (const row of rows) {
      let entry: JobEntry;
      try {
        const job = JSON.parse(row.job_json) as AddonJob;
        const paths = new Map(
          Object.entries(JSON.parse(row.files_json) as Record<string, string>),
        );
        entry = { job, paths };
      } catch {
        // A corrupt row must never take the boot path down — drop it.
        this.db.run(`DELETE FROM jobs WHERE id = ?`, [row.id]);
        continue;
      }
      if (entry.job.state === "active") {
        entry.job.state = "failed";
        entry.job.error =
          "The addon restarted while this download was in progress.";
        entry.job.updatedAt = Date.now();
        this.persist(entry);
      }
      this.jobs.set(entry.job.id, entry);
    }
  }

  private persist(entry: JobEntry): void {
    const files: Record<string, string> = {};
    for (const [k, v] of entry.paths) files[k] = v;
    this.db.run(
      `INSERT INTO jobs (id, state, updated_at, job_json, files_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, updated_at = excluded.updated_at,
         job_json = excluded.job_json, files_json = excluded.files_json`,
      [
        entry.job.id,
        entry.job.state,
        entry.job.updatedAt,
        JSON.stringify(entry.job),
        JSON.stringify(files),
      ],
    );
  }

  create(url: string): AddonJob {
    const id = randomUUID();
    const job: AddonJob = {
      id,
      intent: "url",
      artist: null,
      album: null,
      title: null,
      state: "active",
      error: null,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const entry: JobEntry = { job, paths: new Map() };
    this.jobs.set(id, entry);
    this.persist(entry); // durable as `active` before the background run starts
    void this.run(id, url, entry);
    return job;
  }

  private async run(id: string, url: string, entry: JobEntry): Promise<void> {
    const { job } = entry;
    let expected = 0;
    let seq = 0;
    // The marker path per item, in item order — what pairs a landed file to it.
    const reported: Array<string | undefined> = [];
    const touch = (): void => {
      job.updatedAt = Date.now();
      this.persist(entry);
    };
    const item = (
      title: string | null,
      state: AddonJobItem["state"],
    ): AddonJobItem => ({
      itemId: `${id}:${seq++}`,
      title,
      username: USERNAME,
      filename: "",
      size: 0,
      state,
      fileReady: false,
      updatedAt: Date.now(),
    });
    const onTrack = (ev: DownloaderTrackEvent): void => {
      // TRACK_START opens the item (`downloading`); TRACK_DONE for the same
      // title settles it and supplies the final path.
      const idx = job.items.findIndex(
        (i) => i.title === ev.title && i.state === "downloading",
      );
      if (idx >= 0) {
        const existing = job.items[idx]!;
        existing.state =
          ev.status === "failed"
            ? "unavailable"
            : ev.status === "done"
              ? "completed"
              : "downloading";
        existing.updatedAt = Date.now();
        if (ev.path) reported[idx] = ev.path;
      } else {
        job.items.push(
          item(
            ev.title,
            ev.status === "failed"
              ? "unavailable"
              : ev.status === "done"
                ? "completed"
                : "downloading",
          ),
        );
        reported.push(ev.path);
      }
      touch();
    };

    try {
      const running = runYtdlp(
        url,
        join(this.stagingBase, id),
        this.config(),
        this.deps,
        {
          onTitle: (title) => {
            job.title = title;
            touch();
          },
          onTotal: (total) => {
            expected = total;
          },
          onTrack,
          onOutput: (line) => this.log(`[yt-dlp ${id.slice(0, 8)}] ${line}`),
        },
      );
      this.running.set(id, running);
      const result = await running.done;
      if (job.state === "cancelled") return; // `cancel()` already closed it

      const owner = matchFilesToItems(result.files, reported);
      result.files.forEach((f, fi) => {
        let target = owner[fi]! >= 0 ? job.items[owner[fi]!]! : undefined;
        if (!target) {
          target = item(basename(f.path, extname(f.path)), "completed");
          job.items.push(target);
        }
        target.state = "completed";
        target.fileReady = true;
        target.filename = f.filename;
        target.size = f.size;
        target.updatedAt = Date.now();
        entry.paths.set(target.itemId, f.path);
      });
      // A track that started (or claimed done) but has no file is not
      // deliverable — say so rather than hand the host an item it can't fetch.
      for (const i of job.items) {
        if (!i.fileReady && i.state !== "unavailable") i.state = "unavailable";
      }
      // The announced item count is the honest denominator: videos yt-dlp never
      // reached (or that failed before `before_dl`) become unavailable placeholders.
      for (let n = job.items.length; n < expected; n++)
        job.items.push(item(null, "unavailable"));

      const landed = job.items.filter((i) => i.fileReady).length;
      const reasons = result.errorLines.slice(-5).join("\n");
      if (landed === 0) {
        job.state = "failed";
        job.error =
          reasons ||
          result.outputTail.trim() ||
          `yt-dlp exited with code ${result.exitCode}`;
      } else if (landed < job.items.length) {
        job.state = "partial";
        job.error = `Downloaded ${landed} of ${job.items.length} tracks — the rest failed or were skipped.${
          reasons ? `\n${reasons}` : ""
        }`;
      } else {
        job.state = "done";
        job.error = null;
      }
    } catch (err) {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(id);
      touch();
    }
  }

  get(id: string): AddonJob | undefined {
    return this.jobs.get(id)?.job;
  }

  list(sinceMs = 0): AddonJob[] {
    return [...this.jobs.values()]
      .map((e) => e.job)
      .filter((j) => j.updatedAt > sinceMs);
  }

  /**
   * Stop an in-flight job: SIGTERM yt-dlp and close the job `cancelled` with
   * every undelivered item `unavailable`. The host called this route before
   * and got a 404 — the route did not exist, so "Cancel" on a running YouTube
   * download read as an addon error. A job already settled is left alone.
   */
  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.job.state !== "active") return false;
    this.running.get(id)?.cancel();
    for (const i of entry.job.items) {
      if (!i.fileReady) i.state = "unavailable";
    }
    entry.job.state = "cancelled";
    entry.job.error = "Cancelled.";
    entry.job.updatedAt = Date.now();
    this.persist(entry);
    return true;
  }

  remove(id: string): void {
    this.cancel(id);
    this.jobs.delete(id);
    this.db.run(`DELETE FROM jobs WHERE id = ?`, [id]);
  }

  filePath(id: string, itemId: string): string | undefined {
    return this.jobs.get(id)?.paths.get(itemId);
  }
}
