import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADER = "# Netscape HTTP Cookie File";

export type CookieParse =
  | { ok: true; text: string; count: number; youtube: number }
  | { ok: false; reason: string };

/**
 * Validate and normalise a pasted Netscape cookies.txt (NicotinD #2068).
 *
 * A cookie line is 7 tab-separated fields; `#HttpOnly_` lines are cookies,
 * other `#` lines are comments. A paste whose tabs became spaces is repaired
 * when each line still splits into exactly 7 fields. The header yt-dlp's jar
 * expects is added when missing. A paste whose newlines were dropped (a one-line
 * input on a core that predates `multiline`) fails here instead of reaching yt-dlp.
 */
export function parseCookies(raw: string): CookieParse {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let count = 0;
  let youtube = 0;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) {
      if (!/^#( Netscape)? HTTP Cookie File/i.test(trimmed)) out.push(trimmed);
      continue;
    }
    let fields = trimmed.split("\t");
    if (fields.length !== 7) fields = trimmed.split(/\s+/);
    if (fields.length !== 7) {
      return {
        ok: false,
        reason: `line ${i + 1} is not a cookies.txt line (expected 7 tab-separated fields, got ${fields.length})`,
      };
    }
    count++;
    if (/(^|\.)youtube\.com$/i.test(fields[0]!.replace(/^#HttpOnly_/, ""))) youtube++;
    out.push(fields.join("\t"));
  }
  if (count === 0) return { ok: false, reason: "no cookies found" };
  return { ok: true, text: `${HEADER}\n${out.join("\n")}\n`, count, youtube };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The cookies an admin pasted on the Plugins page, persisted at
 * `<dataDir>/cookies.txt` (0600) so they survive an addon restart.
 *
 * yt-dlp writes rotated cookies back into that file after every run, and core
 * re-pushes its stored config on every boot. So the hash of the last *applied*
 * paste is kept beside it, and a re-push of that same paste is a no-op: only a
 * new paste replaces the jar yt-dlp has been keeping fresh.
 */
export class CookieStore {
  private readonly file: string;
  private readonly hashFile: string;
  private lastError: string | null = null;

  constructor(
    dataDir: string,
    private readonly envFile?: string,
  ) {
    this.file = join(dataDir, "cookies.txt");
    this.hashFile = join(dataDir, "cookies.sha256");
  }

  /** Apply a pushed value. Blank keeps the current cookies. */
  apply(raw: string | undefined): { ok: true } | { ok: false; reason: string } {
    if (raw == null || raw.trim() === "") return { ok: true };
    const parsed = parseCookies(raw);
    if (!parsed.ok) {
      this.lastError = parsed.reason;
      return parsed;
    }
    this.lastError = null;
    const hash = sha(raw);
    if (existsSync(this.file) && this.readHash() === hash) return { ok: true };
    writeFileSync(this.file, parsed.text, { mode: 0o600 });
    chmodSync(this.file, 0o600);
    writeFileSync(this.hashFile, hash, { mode: 0o600 });
    return { ok: true };
  }

  /** The file to hand `--cookies`: the pasted one, else the operator's env path. */
  path(): string | undefined {
    if (existsSync(this.file)) return this.file;
    if (this.envFile && existsSync(this.envFile)) return this.envFile;
    return undefined;
  }

  /** One-line state for the Plugins page status panel. */
  describe(): string {
    if (this.lastError) return `Rejected: ${this.lastError}`;
    const file = this.path();
    if (!file) {
      return this.envFile
        ? `None — YTDLP_ADDON_COOKIES points at ${this.envFile}, which does not exist`
        : "None";
    }
    let parsed: CookieParse;
    try {
      parsed = parseCookies(readFileSync(file, "utf8"));
    } catch {
      return `Unreadable: ${file}`;
    }
    if (!parsed.ok) return `Invalid file: ${parsed.reason}`;
    const source = file === this.file ? "pasted in Settings" : "from YTDLP_ADDON_COOKIES";
    return `${parsed.youtube} YouTube cookies (${parsed.count} total), ${source}`;
  }

  private readHash(): string | null {
    try {
      return readFileSync(this.hashFile, "utf8").trim();
    } catch {
      return null;
    }
  }
}
