import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Database } from 'bun:sqlite';
import { JobStore } from './job-store.js';

// A yt-dlp that writes one file then exits 0 — the job completes to `done`.
function fakeSpawn() {
  return ((_bin: string, args: string[]) => {
    const em = new EventEmitter();
    const paths = args[args.indexOf('--paths') + 1]!;
    queueMicrotask(() => {
      mkdirSync(join(paths, 'A', 'B'), { recursive: true });
      writeFileSync(join(paths, 'A', 'B', 'Song.opus'), 'audio');
      em.emit('close', 0);
    });
    return em;
  }) as unknown as typeof import('node:child_process').spawn;
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'yts-persist-'));
  return { stage: join(dir, 'downloads'), db: join(dir, 'jobs.db') };
}

async function waitDone(store: JobStore, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (store.get(id)?.state !== 'active') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never left active');
}

describe('JobStore persistence (issue #515)', () => {
  it('a completed job + its file path survive a restart', async () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(stage, () => ({ binaryPath: 'yt-dlp' }), { spawn: fakeSpawn() }, db);
    const job = s1.create('https://youtube.com/watch?v=x');
    await waitDone(s1, job.id);
    expect(s1.get(job.id)?.state).toBe('done');
    const itemId = s1.get(job.id)!.items[0]!.itemId;
    const path = s1.filePath(job.id, itemId);
    expect(path).toBeTruthy();

    // "Restart": a fresh store on the same db file.
    const s2 = new JobStore(stage, () => ({ binaryPath: 'yt-dlp' }), {}, db);
    expect(s2.get(job.id)?.state).toBe('done');
    expect(s2.filePath(job.id, itemId)).toBe(path);
  });

  it('an in-flight (active) job is marked failed on restart, not forgotten', () => {
    const { stage, db } = tmp();
    // Seed a persisted job left `active` (the addon died mid-download).
    const seed = new Database(db);
    seed.run(
      `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, job_json TEXT NOT NULL, files_json TEXT NOT NULL)`,
    );
    const active = {
      id: 'ghost-1',
      intent: 'url',
      artist: null,
      album: null,
      state: 'active',
      error: null,
      items: [],
      createdAt: 1000,
      updatedAt: 2000,
    };
    seed.run(`INSERT INTO jobs (id, state, updated_at, job_json, files_json) VALUES (?,?,?,?,?)`, [
      'ghost-1',
      'active',
      2000,
      JSON.stringify(active),
      '{}',
    ]);
    seed.close();

    const store = new JobStore(stage, () => ({ binaryPath: 'yt-dlp' }), {}, db);
    const reloaded = store.get('ghost-1');
    expect(reloaded?.state).toBe('failed');
    expect(reloaded?.error).toContain('restarted');
    // The failed transition bumps updatedAt so core's cursor poll sees it.
    expect(reloaded!.updatedAt).toBeGreaterThan(2000);
    // And it's listed (not a ghost that vanished).
    expect(store.list(0).map((j) => j.id)).toContain('ghost-1');
  });

  it('remove deletes the row so it does not resurrect on restart', () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(stage, () => ({ binaryPath: 'yt-dlp' }), { spawn: fakeSpawn() }, db);
    const job = s1.create('https://youtube.com/watch?v=y');
    s1.remove(job.id);
    const s2 = new JobStore(stage, () => ({ binaryPath: 'yt-dlp' }), {}, db);
    expect(s2.get(job.id)).toBeUndefined();
  });
});
