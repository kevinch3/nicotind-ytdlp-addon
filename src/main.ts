import { join } from "node:path";
import { prepareDirs, resolveDirs } from "./paths.js";
import { JobStore } from "./job-store.js";
import { createServer } from "./server.js";
import { jsRuntimeFor, type YtdlpConfig } from "./resolve.js";
import { spawnSync } from "node:child_process";

const token = process.env.YTDLP_ADDON_TOKEN;
if (!token) {
  console.error(
    "YTDLP_ADDON_TOKEN is not set — refusing to start without an access token",
  );
  process.exit(1);
}

// Probed once: whether this yt-dlp can take Bun as its JS runtime (#1738).
const jsRuntime = jsRuntimeFor(process.env, process.execPath, () => {
  const r = spawnSync(process.env.YTDLP_ADDON_BINARY ?? "yt-dlp", ["--help"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return r.stdout ?? "";
});

const config = (): YtdlpConfig => ({
  binaryPath: process.env.YTDLP_ADDON_BINARY ?? "yt-dlp",
  cookiesFile: process.env.YTDLP_ADDON_COOKIES || undefined,
  format: process.env.YTDLP_ADDON_FORMAT || undefined,
  // The bgutil provider sidecar. Defaults to the shared-netns local URL the
  // in-process plugin used, so a compose that shares the network namespace works
  // with no extra config.
  potProviderUrl: process.env.POT_PROVIDER_URL || "http://127.0.0.1:4416",
  jsRuntime,
});

// /data in Docker; the XDG data dir on bare metal, where /data is not writable
// and the ledger used to crash the boot with SQLITE_CANTOPEN (NicotinD #1737).
const dirs = resolveDirs(process.env);
try {
  prepareDirs(dirs);
} catch (err) {
  console.error(`yt-dlp addon: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const stagingBase = dirs.downloadsDir;
const port = Number(process.env.YTDLP_ADDON_PORT ?? "8586");

// Persist the job ledger under the addon's data volume so a restart reports
// in-flight downloads as failed rather than forgetting them (issue #515).
const jobs = new JobStore(stagingBase, config, {}, join(dirs.dataDir, "jobs.db"));
const app = createServer({ token, jobs });

// Bun.serve, not a default export: the default-export form prints Bun's
// "Started development server" banner, which reads wrong in production.
Bun.serve({ port, fetch: app.fetch });
console.log(
  `yt-dlp addon listening on :${port} (data ${dirs.dataDir}, downloads ${dirs.downloadsDir}, ` +
    `JS runtime ${jsRuntime ? `bun:${jsRuntime}` : "yt-dlp default"})`,
);
