import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CookieStore, parseCookies } from "./cookies.js";

const JAR = [
  "# Netscape HTTP Cookie File",
  "# exported by an extension",
  ".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc",
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1800000000\t__Secure-3PSID\tdef",
  ".google.com\tTRUE\t/\tTRUE\t1800000000\tNID\tghi",
].join("\n");

const tmp = () => mkdtempSync(join(tmpdir(), "ytdlp-cookies-"));

describe("parseCookies", () => {
  it("counts cookies, YouTube ones, and HttpOnly lines", () => {
    const r = parseCookies(JAR);
    expect(r.ok && [r.count, r.youtube]).toEqual([3, 2]);
  });

  it("adds the header yt-dlp's jar expects when the paste lacks it", () => {
    const r = parseCookies(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc");
    expect(r.ok && r.text.split("\n")[0]).toBe("# Netscape HTTP Cookie File");
  });

  it("repairs tabs that became spaces, and CRLF line ends", () => {
    const r = parseCookies(".youtube.com TRUE / TRUE 0 SID abc\r\n.youtube.com  TRUE / TRUE 0 HSID x\r\n");
    expect(r.ok && r.text).toContain(".youtube.com\tTRUE\t/\tTRUE\t0\tHSID\tx");
  });

  it("rejects a paste whose newlines were dropped by a one-line input", () => {
    const r = parseCookies(JAR.replace(/\n/g, ""));
    expect(r.ok).toBe(false);
  });

  it("rejects text with no cookies in it", () => {
    expect(parseCookies("# Netscape HTTP Cookie File\n# nothing").ok).toBe(false);
  });
});

describe("CookieStore", () => {
  it("persists a paste at <dataDir>/cookies.txt, readable only by the addon", () => {
    const dir = tmp();
    const store = new CookieStore(dir);
    expect(store.apply(JAR)).toEqual({ ok: true });
    expect(store.path()).toBe(join(dir, "cookies.txt"));
    expect(statSync(join(dir, "cookies.txt")).mode & 0o777).toBe(0o600);
    expect(store.describe()).toBe("2 YouTube cookies (3 total), pasted in Settings");
  });

  it("keeps the jar yt-dlp rotated when core re-pushes the same paste", () => {
    const dir = tmp();
    new CookieStore(dir).apply(JAR);
    const rotated = JAR.replace("abc", "rotated");
    writeFileSync(join(dir, "cookies.txt"), rotated);
    // A restart + core's boot-time re-push of the unchanged stored config.
    new CookieStore(dir).apply(JAR);
    expect(readFileSync(join(dir, "cookies.txt"), "utf8")).toContain("rotated");
  });

  it("replaces the jar when a different paste arrives", () => {
    const dir = tmp();
    const store = new CookieStore(dir);
    store.apply(JAR);
    store.apply(JAR.replace("abc", "fresh"));
    expect(readFileSync(join(dir, "cookies.txt"), "utf8")).toContain("fresh");
  });

  it("treats blank as keep, and an invalid paste leaves the old jar in place", () => {
    const dir = tmp();
    const store = new CookieStore(dir);
    store.apply(JAR);
    expect(store.apply("  ")).toEqual({ ok: true });
    expect(store.apply("not cookies").ok).toBe(false);
    expect(readFileSync(join(dir, "cookies.txt"), "utf8")).toContain("abc");
    expect(store.describe()).toStartWith("Rejected: line 1");
  });

  it("falls back to the YTDLP_ADDON_COOKIES file, and says when that file is missing", () => {
    const dir = tmp();
    const envFile = join(dir, "operator.txt");
    const store = new CookieStore(dir, envFile);
    expect(store.path()).toBeUndefined();
    expect(store.describe()).toContain("does not exist");
    writeFileSync(envFile, JAR);
    expect(store.path()).toBe(envFile);
    expect(store.describe()).toContain("from YTDLP_ADDON_COOKIES");
  });

  it("reports None when nothing is configured", () => {
    expect(new CookieStore(tmp()).describe()).toBe("None");
  });
});
