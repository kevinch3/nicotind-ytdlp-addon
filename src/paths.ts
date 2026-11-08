import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AddonDirs {
  /** Holds the job ledger (jobs.db). */
  dataDir: string;
  /** Staging for downloads core fetches over the protocol. */
  downloadsDir: string;
  /** Where dataDir came from, for the error and the startup log. */
  source: "env" | "default" | "xdg";
}

type Env = Record<string, string | undefined>;

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the addon keeps its state (NicotinD #1737).
 *
 * YTDLP_ADDON_DATA_DIR wins. Unset, `/data` (the Docker volume) is used when it
 * is writable; on bare metal it is not, so the ledger goes to the XDG data dir
 * (`$XDG_DATA_HOME` or `~/.local/share`) instead of crashing with
 * SQLITE_CANTOPEN. Downloads default to `<dataDir>/downloads`.
 */
export function resolveDirs(env: Env, writable: (p: string) => boolean = isWritable): AddonDirs {
  let dataDir: string;
  let source: AddonDirs["source"];
  if (env.YTDLP_ADDON_DATA_DIR) {
    dataDir = env.YTDLP_ADDON_DATA_DIR;
    source = "env";
  } else if (writable("/data")) {
    dataDir = "/data";
    source = "default";
  } else {
    const xdg = env.XDG_DATA_HOME || join(env.HOME ?? "/root", ".local", "share");
    dataDir = join(xdg, "nicotind-ytdlp-addon");
    source = "xdg";
  }
  const downloadsDir = env.YTDLP_ADDON_DOWNLOADS_DIR || join(dataDir, "downloads");
  return { dataDir, downloadsDir, source };
}

/** Create both dirs, or throw a message that names the variable to set. */
export function prepareDirs(dirs: AddonDirs): void {
  for (const [dir, variable] of [
    [dirs.dataDir, "YTDLP_ADDON_DATA_DIR"],
    [dirs.downloadsDir, "YTDLP_ADDON_DOWNLOADS_DIR"],
  ] as const) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `cannot use ${dir} (${why}). Set ${variable} to a directory this user can write.`,
      );
    }
  }
}
