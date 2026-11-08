import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDirs, resolveDirs } from "./paths.js";

/**
 * NicotinD #1737: outside Docker the addon crashed at boot with
 * SQLITE_CANTOPEN, because its job ledger defaulted to /data and the variable
 * that moves it (YTDLP_ADDON_DATA_DIR) was in neither the README nor the error.
 */
describe("resolveDirs", () => {
  const writable = (ok: string[]) => (p: string) => ok.includes(p);

  it("keeps /data when it is writable (the Docker volume)", () => {
    expect(resolveDirs({ HOME: "/home/u" }, writable(["/data"]))).toEqual({
      dataDir: "/data",
      downloadsDir: "/data/downloads",
      source: "default",
    });
  });

  it("falls back to the XDG data dir when /data is not writable", () => {
    const dirs = resolveDirs({ HOME: "/home/u" }, writable([]));
    expect(dirs.dataDir).toBe("/home/u/.local/share/nicotind-ytdlp-addon");
    expect(dirs.downloadsDir).toBe("/home/u/.local/share/nicotind-ytdlp-addon/downloads");
    expect(dirs.source).toBe("xdg");
  });

  it("honours XDG_DATA_HOME, and explicit variables over everything", () => {
    expect(resolveDirs({ HOME: "/h", XDG_DATA_HOME: "/x" }, writable([])).dataDir).toBe(
      "/x/nicotind-ytdlp-addon",
    );
    expect(
      resolveDirs(
        { HOME: "/h", YTDLP_ADDON_DATA_DIR: "/srv/y", YTDLP_ADDON_DOWNLOADS_DIR: "/dl" },
        writable(["/data"]),
      ),
    ).toEqual({ dataDir: "/srv/y", downloadsDir: "/dl", source: "env" });
  });
});

describe("prepareDirs", () => {
  it("names the variable when the data dir cannot be created", () => {
    const base = mkdtempSync(join(tmpdir(), "ytdlp-paths-"));
    try {
      chmodSync(base, 0o500); // read-only parent
      expect(() =>
        prepareDirs({
          dataDir: join(base, "nope"),
          downloadsDir: join(base, "nope", "downloads"),
          source: "env",
        }),
      ).toThrow(/YTDLP_ADDON_DATA_DIR/);
    } finally {
      chmodSync(base, 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
