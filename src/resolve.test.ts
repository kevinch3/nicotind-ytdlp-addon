import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { buildArgs, resolveYtdlp } from './resolve.js';

// A fake yt-dlp: runs `writeTo` (dropping files into staging), then closes.
function fakeSpawn(writeTo: () => void) {
  return ((_bin: string, _args: string[]) => {
    const em = new EventEmitter();
    queueMicrotask(() => {
      writeTo();
      em.emit('close', 0);
    });
    return em;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('buildArgs', () => {
  it('extracts audio and wires the pot-provider + cookies when configured', () => {
    const args = buildArgs('https://youtube.com/watch?v=x', '/stage', {
      binaryPath: 'yt-dlp',
      potProviderUrl: 'http://pot:4416',
    });
    expect(args).toContain('--extract-audio');
    expect(args).toContain('--ignore-errors');
    expect(args.join(' ')).toContain('youtubepot-bgutilhttp:base_url=http://pot:4416');
  });
});

describe('resolveYtdlp', () => {
  it('returns the audio files that landed in staging', async () => {
    const stage = join(tmpdir(), `yt-${process.pid}-${Date.now()}`);
    const write = (): void => {
      mkdirSync(join(stage, 'Artist', 'Album'), { recursive: true });
      writeFileSync(join(stage, 'Artist', 'Album', 'Song.mp3'), 'audio-bytes');
    };
    const files = await resolveYtdlp(
      'https://youtube.com/watch?v=x',
      stage,
      { binaryPath: 'yt-dlp' },
      { spawn: fakeSpawn(write) },
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe('Song.mp3');
    expect(files[0]!.size).toBeGreaterThan(0);
  });
});
