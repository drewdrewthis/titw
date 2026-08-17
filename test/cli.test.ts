import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { TITW_HOME_ENV } from '../src/core/env.js';
import { buildFixtureRepo, makeTmpDir, removeTree, type FixtureRepo } from './helpers/fixture.js';

/** Run the CLI as a user would: argv in, exit code + captured stdout/stderr out. */
async function cli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await main(['node', 'titw', ...args]);
    return { code, stdout, stderr };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('titw CLI', () => {
  let root: string;
  let repo: FixtureRepo;

  beforeAll(async () => {
    root = await makeTmpDir('cli');
    repo = await buildFixtureRepo(path.join(root, 'fixture-way'));
    vi.stubEnv(TITW_HOME_ENV, path.join(root, 'home'));
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await removeTree(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('install + sync + status drive the full path with exit code 0 and valid --json', async () => {
    const installed = await cli(['install', repo.source, '--version', '^1.0.0', '--json']);
    expect(installed.code).toBe(0);
    const installPayload = JSON.parse(installed.stdout) as { package: string; version: string };
    expect(installPayload).toMatchObject({ package: '@titw/fixture-way', version: '1.1.0' });

    const synced = await cli(['sync', '--json']);
    expect(synced.code).toBe(0);
    const syncPayload = JSON.parse(synced.stdout) as { targets: Array<{ activated: boolean }> };
    expect(syncPayload.targets[0]?.activated).toBe(true);

    const status = await cli(['status', '--json']);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as { packages: Array<{ name: string }> };
    expect(statusPayload.packages[0]?.name).toBe('@titw/fixture-way');
  }, 60_000);

  it('exits 1 with the error on stderr for a failing command', async () => {
    const result = await cli(['install', 'not a valid source!!']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('titw:');
    expect(result.stdout).toBe('');
  });

  it('rejects --env other than default (D15) with exit code 1', async () => {
    const result = await cli(['sync', '--env', 'staging']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('D15');
  });

  it('sync --locked exits 0 when the lock is stable', async () => {
    const result = await cli(['sync', '--locked']);
    expect(result.code).toBe(0);
  });

  it('sync --no-interactive is accepted and reports kept/proposed in --json', async () => {
    const result = await cli(['sync', '--no-interactive', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      targets: Array<{ kept: string[]; proposed: unknown }>;
    };
    expect(payload.targets[0]?.kept).toEqual([]);
    expect(payload.targets[0]?.proposed).toBeNull();
  });

  it('install --frozen --dry-run reports without writing state', async () => {
    const result = await cli(['install', '--frozen', '--dry-run', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { dryRun: boolean; packages: Array<{ name: string }> };
    expect(payload.dryRun).toBe(true);
    expect(payload.packages[0]?.name).toBe('@titw/fixture-way');
  }, 30_000);

  it('install --frozen rejects --version/--include/--exclude instead of ignoring them', async () => {
    for (const flags of [['--version', '^1.0.0'], ['--include', 'knowledge/**'], ['--exclude', 'plans/**']]) {
      const result = await cli(['install', '--frozen', ...flags]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not allowed');
    }
  });

  it('install --frozen with a source is refused; without, it reproduces the lock', async () => {
    const refused = await cli(['install', repo.source, '--frozen']);
    expect(refused.code).toBe(1);

    const frozen = await cli(['install', '--frozen', '--json']);
    expect(frozen.code).toBe(0);
    const payload = JSON.parse(frozen.stdout) as { packages: Array<{ name: string }> };
    expect(payload.packages[0]?.name).toBe('@titw/fixture-way');
  }, 60_000);

  it('uninstall then gc leave an empty, reclaimed home', async () => {
    const removed = await cli(['uninstall', '@titw/fixture-way', '--json']);
    expect(removed.code).toBe(0);

    const reclaimed = await cli(['gc', '--json']);
    expect(reclaimed.code).toBe(0);
    const payload = JSON.parse(reclaimed.stdout) as { cache: string[] };
    expect(payload.cache.length).toBeGreaterThan(0);

    const missing = await cli(['uninstall', '@titw/fixture-way']);
    expect(missing.code).toBe(1);
  }, 60_000);
});
