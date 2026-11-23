import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeSpawn } from "./resolve.test.js";
import { JobStore } from "./job-store.js";
import { createServer, type AddonSettings } from "./server.js";
import { CookieStore } from "./cookies.js";

const TOKEN = "test-token";

// A yt-dlp that writes one file then exits 0 — the job completes to `done`.
function spawnOneFile() {
  return fakeSpawn({
    lines: ["TRACK_DONE::A - Song\t{paths}/A/B/Song.opus"],
    writeTo: (paths) => {
      mkdirSync(join(paths, "A", "B"), { recursive: true });
      writeFileSync(join(paths, "A", "B", "Song.opus"), "audio");
    },
  });
}

function makeApp(spawn = spawnOneFile()) {
  const stage = join(tmpdir(), `yts-${process.pid}-${Date.now()}`);
  const jobs = new JobStore(
    stage,
    () => ({ binaryPath: "yt-dlp" }),
    { spawn },
    ":memory:",
    () => {},
  );
  return createServer({ token: TOKEN, jobs });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("ytdlp addon server", () => {
  it("serves the manifest unauthenticated with the catch-all priority", async () => {
    const res = await makeApp().request("/addon/v1/manifest");
    expect(res.status).toBe(200);
    const m = (await res.json()) as {
      id: string;
      priority: number;
      urlPatterns: string[];
    };
    expect(m.id).toBe("ytdlp-addon");
    expect(m.priority).toBe(-10);
    expect(m.urlPatterns).toContain("^https?://");
  });

  it("401s a jobs call without the bearer token", async () => {
    const res = await makeApp().request("/addon/v1/jobs", {
      method: "POST",
      body: JSON.stringify({ intent: "url", url: "https://youtube.com/x" }),
    });
    expect(res.status).toBe(401);
  });

  it("resolves a url job → fileReady item → serves the bytes", async () => {
    const app = makeApp();
    const created = await app.request("/addon/v1/jobs", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "url",
        url: "https://youtube.com/watch?v=x",
      }),
    });
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: { id: string } };

    // Poll until the background resolve completes.
    let done:
      | {
          id: string;
          state: string;
          items: Array<{ itemId: string; fileReady: boolean }>;
        }
      | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await app.request(`/addon/v1/jobs/${job.id}`, {
        headers: auth,
      });
      const body = (await res.json()) as { job: typeof done };
      if (body.job && body.job.state !== "active") {
        done = body.job;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(done?.state).toBe("done");
    expect(done?.items[0]?.fileReady).toBe(true);

    const file = await app.request(
      `/addon/v1/jobs/${job.id}/files/${encodeURIComponent(done!.items[0]!.itemId)}`,
      {
        headers: auth,
      },
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("audio");
  });

  // Core's `POST jobs/:id/cancel` used to 404 here — the route did not exist —
  // so "Cancel" on a running YouTube download read as an addon error.
  it("cancels a running job, and 404s an unknown one", async () => {
    const app = makeApp(fakeSpawn({ hang: true }));
    const created = await app.request("/addon/v1/jobs", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "url",
        url: "https://youtube.com/watch?v=x",
      }),
    });
    const { job } = (await created.json()) as { job: { id: string } };
    const cancelled = await app.request(`/addon/v1/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(cancelled.status).toBe(200);
    const after = await app.request(`/addon/v1/jobs/${job.id}`, {
      headers: auth,
    });
    expect(((await after.json()) as { job: { state: string } }).job.state).toBe(
      "cancelled",
    );
    const missing = await app.request("/addon/v1/jobs/nope/cancel", {
      method: "POST",
      headers: auth,
    });
    expect(missing.status).toBe(404);
  });
});

describe("PUT config (NicotinD #2068: it used to be acknowledged and dropped)", () => {
  const JAR = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n";

  function configApp() {
    const dir = mkdtempSync(join(tmpdir(), "ytdlp-cfg-"));
    const cookies = new CookieStore(dir);
    const settings: AddonSettings = {};
    const jobs = new JobStore(dir, () => ({ binaryPath: "yt-dlp" }), {}, ":memory:", () => {});
    return { app: createServer({ token: TOKEN, jobs, cookies, settings }), dir, cookies, settings };
  }

  const put = (app: ReturnType<typeof configApp>["app"], body: unknown) =>
    app.request("/addon/v1/config", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores pasted cookies and the format selector", async () => {
    const { app, dir, cookies, settings } = configApp();
    expect((await put(app, { cookies: JAR, format: " bestaudio " })).status).toBe(204);
    expect(readFileSync(join(dir, "cookies.txt"), "utf8")).toContain("SID\tabc");
    expect(cookies.path()).toBe(join(dir, "cookies.txt"));
    expect(settings.format).toBe("bestaudio");
  });

  it("400s a paste that is not a cookies.txt, so core logs the push as failed", async () => {
    const { app, cookies } = configApp();
    const res = await put(app, { cookies: "SID=abc; HSID=def" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("cookies rejected");
    expect(cookies.path()).toBeUndefined();
  });

  it("reports the cookie state as a status row", async () => {
    const { app } = configApp();
    await put(app, { cookies: JAR });
    const rows = (await (await app.request("/addon/v1/status", { headers: auth })).json()) as {
      key: string;
      label: string;
      value: string;
    }[];
    expect(rows).toEqual([
      { key: "cookies", label: "YouTube cookies", value: "1 YouTube cookies (1 total), pasted in Settings" },
    ]);
  });

  it("declares the cookies field as a write-only multiline secret with help text", async () => {
    const m = (await (await configApp().app.request("/addon/v1/manifest")).json()) as {
      configFields: { key: string; type: string; multiline?: boolean; help?: string }[];
    };
    const field = m.configFields.find((f) => f.key === "cookies");
    expect(field).toMatchObject({ type: "password", multiline: true });
    expect(field?.help).toContain("not a bot");
  });
});
