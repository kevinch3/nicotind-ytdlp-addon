import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { JobStore, matchFilesToItems } from "./job-store.js";
import { fakeSpawn } from "./resolve.test.js";

/** A yt-dlp that prints `lines` (with `{paths}` = the job's staging dir) and writes `files` there. */
function ytdlpThat(lines: string[], files: string[], code = 0) {
  return fakeSpawn({
    lines,
    code,
    writeTo: (paths) => {
      for (const rel of files) {
        mkdirSync(join(paths, rel, ".."), { recursive: true });
        writeFileSync(join(paths, rel), "audio");
      }
    },
  });
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "yts-persist-"));
  return { stage: join(dir, "downloads"), db: join(dir, "jobs.db") };
}

async function waitDone(store: JobStore, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (store.get(id)?.state !== "active") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job never left active");
}

const cfg = () => ({ binaryPath: "yt-dlp" });
const quiet = () => {};

describe("file ↔ track matching", () => {
  it("pairs by the marker path, falling back to the stem across the extraction rename", () => {
    const files = [
      { path: "/s/A/M/One.opus", filename: "One.opus", size: 1 },
      { path: "/s/A/M/Two.opus", filename: "Two.opus", size: 1 },
      { path: "/s/A/M/Stray.opus", filename: "Stray.opus", size: 1 },
    ];
    expect(
      matchFilesToItems(files, [
        "/s/A/M/Two.webm",
        "/s/A/M/One.opus",
        undefined,
      ]),
    ).toEqual([1, 0, -1]);
  });
});

describe("what a job reports (NicotinD #585)", () => {
  it("a fully downloaded playlist: title, one completed item per video in output order, done", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: ytdlpThat(
          [
            "[download] Downloading playlist: Summer Mix",
            "[download] Downloading item 1 of 2",
            "TRACK_START::B - Second\t{paths}/B/Summer Mix/Second.webm",
            "TRACK_DONE::B - Second\t{paths}/B/Summer Mix/Second.opus",
            "[download] Downloading item 2 of 2",
            "TRACK_START::A - First\t{paths}/A/Summer Mix/First.webm",
            "TRACK_DONE::A - First\t{paths}/A/Summer Mix/First.opus",
          ],
          ["A/Summer Mix/First.opus", "B/Summer Mix/Second.opus"],
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://youtube.com/playlist?list=x");
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.state).toBe("done");
    expect(got.title).toBe("Summer Mix");
    expect(got.error).toBeNull();
    expect(
      got.items.map((i) => [i.title, i.state, i.fileReady, i.filename]),
    ).toEqual([
      ["B - Second", "completed", true, "Second.opus"],
      ["A - First", "completed", true, "First.opus"],
    ]);
    for (const i of got.items)
      expect(store.filePath(job.id, i.itemId)).toEndWith(i.filename);
  });

  it("1 of 16 reads as a partial with 16 items, the unreached ones unavailable, and the ERROR lines", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: ytdlpThat(
          [
            "[download] Downloading playlist: Big Mix",
            "[download] Downloading item 1 of 16",
            "TRACK_START::A - One\t{paths}/A/Big Mix/One.webm",
            "TRACK_DONE::A - One\t{paths}/A/Big Mix/One.opus",
            "[download] Downloading item 2 of 16",
            "ERROR: [youtube] zzz: Video unavailable",
            "[download] Downloading item 3 of 16",
            "TRACK_START::C - Three\t{paths}/C/Big Mix/Three.webm",
            "ERROR: [download] Got error: timed out",
          ],
          ["A/Big Mix/One.opus"],
          1,
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://youtube.com/playlist?list=x");
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.state).toBe("partial");
    expect(got.title).toBe("Big Mix");
    expect(got.items).toHaveLength(16);
    expect(got.items.filter((i) => i.fileReady)).toHaveLength(1);
    expect(got.items[0]).toMatchObject({
      title: "A - One",
      state: "completed",
    });
    // Started, never finished → unavailable, not "downloading" forever.
    expect(got.items[1]).toMatchObject({
      title: "C - Three",
      state: "unavailable",
    });
    expect(
      got.items
        .slice(2)
        .every((i) => i.state === "unavailable" && i.title === null),
    ).toBe(true);
    expect(got.error).toContain("Downloaded 1 of 16 tracks");
    expect(got.error).toContain("ERROR: [youtube] zzz: Video unavailable");
  });

  it("nothing landed → failed, with yt-dlp's ERROR lines as the reason", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: ytdlpThat(
          ["ERROR: Unsupported URL: https://beatport.com/x"],
          [],
          1,
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://beatport.com/x");
    await waitDone(store, job.id);
    expect(store.get(job.id)).toMatchObject({
      state: "failed",
      error: "ERROR: Unsupported URL: https://beatport.com/x",
    });
  });

  it("the title and each track are visible to a poll while yt-dlp is still running; cancel closes it", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: fakeSpawn({
          lines: [
            "[download] Downloading playlist: Live Mix",
            "TRACK_START::A - One\t{paths}/A/L/One.webm",
          ],
          hang: true,
        }),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://youtube.com/playlist?list=x");
    await new Promise((r) => setTimeout(r, 20));
    const mid = store.get(job.id)!;
    expect(mid.state).toBe("active");
    expect(mid.title).toBe("Live Mix");
    expect(mid.items.map((i) => [i.title, i.state])).toEqual([
      ["A - One", "downloading"],
    ]);
    expect(store.cancel(job.id)).toBe(true);
    expect(store.get(job.id)).toMatchObject({ state: "cancelled" });
    expect(store.get(job.id)!.items[0]!.state).toBe("unavailable");
    expect(store.cancel(job.id)).toBe(false);
  });

  it("writes every yt-dlp line to the addon log, tagged with the job", async () => {
    const { stage } = tmp();
    const logged: string[] = [];
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: ytdlpThat(
          ["[download] Downloading playlist: L"],
          ["A/L/One.opus"],
        ),
      },
      ":memory:",
      (l) => logged.push(l),
    );
    const job = store.create("https://youtube.com/playlist?list=x");
    await waitDone(store, job.id);
    expect(logged).toEqual([
      `[yt-dlp ${job.id.slice(0, 8)}] [download] Downloading playlist: L`,
    ]);
  });
});

describe("JobStore persistence (issue #515)", () => {
  it("a completed job + its file path survive a restart", async () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(
      stage,
      cfg,
      { spawn: ytdlpThat([], ["A/B/Song.opus"]) },
      db,
      quiet,
    );
    const job = s1.create("https://youtube.com/watch?v=x");
    await waitDone(s1, job.id);
    expect(s1.get(job.id)!.state).toBe("done");
    const itemId = s1.get(job.id)!.items[0]!.itemId;

    const s2 = new JobStore(stage, cfg, {}, db, quiet);
    expect(s2.get(job.id)!.state).toBe("done");
    expect(s2.filePath(job.id, itemId)).toBe(
      join(stage, job.id, "A", "B", "Song.opus"),
    );
  });

  it("an in-flight (active) job is marked failed on restart, not forgotten", () => {
    const { stage, db } = tmp();
    const raw = new Database(db);
    raw.run(
      `CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, job_json TEXT NOT NULL, files_json TEXT NOT NULL)`,
    );
    const job = {
      id: "j1",
      intent: "url",
      artist: null,
      album: null,
      state: "active",
      error: null,
      items: [],
      createdAt: 1,
      updatedAt: 1,
    };
    raw.run(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?)`, [
      "j1",
      "active",
      1,
      JSON.stringify(job),
      "{}",
    ]);
    raw.close();

    const store = new JobStore(stage, cfg, {}, db, quiet);
    const got = store.get("j1")!;
    expect(got.state).toBe("failed");
    expect(got.error).toContain("restarted");
    expect(got.updatedAt).toBeGreaterThan(1);
    expect(store.list(1)).toHaveLength(1);
  });

  it("remove deletes the row so it does not resurrect on restart", () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(stage, cfg, {}, db, quiet);
    s1.remove("nope");
    const raw = new Database(db);
    raw.run(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?)`, [
      "j2",
      "done",
      5,
      JSON.stringify({
        id: "j2",
        intent: "url",
        artist: null,
        album: null,
        state: "done",
        error: null,
        items: [],
        createdAt: 1,
        updatedAt: 5,
      }),
      "{}",
    ]);
    raw.close();
    const s2 = new JobStore(stage, cfg, {}, db, quiet);
    expect(s2.get("j2")).toBeDefined();
    s2.remove("j2");
    expect(new JobStore(stage, cfg, {}, db, quiet).get("j2")).toBeUndefined();
  });
});
