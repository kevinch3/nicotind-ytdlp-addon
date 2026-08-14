import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.opus', '.flac', '.ogg', '.wav', '.aac']);

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

/**
 * yt-dlp argument vector. Mirrors the retired in-process plugin: extract audio,
 * parse "Artist - Title" from the video title, embed metadata (so core reads real
 * tags — unlike tagless archive), skip unavailable playlist items. Adds the
 * bgutil PO-token provider extractor-arg and cookies when configured.
 */
export function buildArgs(url: string, stagingDir: string, cfg: YtdlpConfig): string[] {
  const args = [
    url,
    '--ignore-errors',
    '--no-progress',
    '--extract-audio',
    '--audio-quality',
    '0',
    '--parse-metadata',
    'title:%(artist)s - %(title)s',
    '--embed-metadata',
    '--paths',
    stagingDir,
    '-o',
    '%(artist)s/%(album,playlist_title,uploader)s/%(title)s.%(ext)s',
  ];
  if (cfg.format) args.push('--format', cfg.format);
  if (cfg.cookiesFile && existsSync(cfg.cookiesFile)) args.push('--cookies', cfg.cookiesFile);
  if (cfg.potProviderUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${cfg.potProviderUrl}`);
  }
  return args;
}

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
 * Spawn yt-dlp for `url`, downloading audio into `stagingDir`, and return the
 * files that landed. yt-dlp exits non-zero on a partial playlist, so success is
 * decided by whether audio files landed — not the exit code (matches the plugin).
 */
export async function resolveYtdlp(
  url: string,
  stagingDir: string,
  cfg: YtdlpConfig,
  deps: ResolveDeps = {},
): Promise<ResolvedFile[]> {
  const spawn = deps.spawn ?? nodeSpawn;
  const args = buildArgs(url, stagingDir, cfg);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cfg.binaryPath, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return globAudioFiles(stagingDir);
}
