import { join } from "node:path";
import { JobStore } from "./job-store.js";
import { createServer } from "./server.js";
import type { YtdlpConfig } from "./resolve.js";

const token = process.env.YTDLP_ADDON_TOKEN;
if (!token) {
  console.error(
    "YTDLP_ADDON_TOKEN is not set — refusing to start without an access token",
  );
  process.exit(1);
}

const config = (): YtdlpConfig => ({
  binaryPath: process.env.YTDLP_ADDON_BINARY ?? "yt-dlp",
  cookiesFile: process.env.YTDLP_ADDON_COOKIES || undefined,
  format: process.env.YTDLP_ADDON_FORMAT || undefined,
  // The bgutil provider sidecar. Defaults to the shared-netns local URL the
  // in-process plugin used, so a compose that shares the network namespace works
  // with no extra config.
  potProviderUrl: process.env.POT_PROVIDER_URL || "http://127.0.0.1:4416",
});

const stagingBase = process.env.YTDLP_ADDON_DOWNLOADS_DIR ?? "/data/downloads";
const port = Number(process.env.YTDLP_ADDON_PORT ?? "8586");

// Persist the job ledger under the addon's data volume so a restart reports
// in-flight downloads as failed rather than forgetting them (issue #515).
const dataDir = process.env.YTDLP_ADDON_DATA_DIR ?? "/data";
const jobs = new JobStore(stagingBase, config, {}, join(dataDir, "jobs.db"));
const app = createServer({ token, jobs });

console.log(`yt-dlp addon listening on :${port}`);
export default { port, fetch: app.fetch };
