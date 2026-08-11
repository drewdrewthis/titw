import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TITW_HOME_ENV } from '../src/core/env.js';
import { makeTmpDir, removeTree } from './helpers/fixture.js';

const run = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_CONFIG = path.join(REPO_ROOT, 'tsconfig.build.json');
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
/** The file `package.json#bin` publishes as `titw`. */
const BIN = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Compile `dist/` with the project's own build config.
 *
 * `npm test` is `vitest run` and CI never runs `npm run build`, so `dist/` is
 * routinely absent or stale here — and this suite is worthless against a stale
 * one. Building the real output rather than a convenience copy keeps the symlink
 * below pointed at the artifact npm actually installs.
 */
async function buildDist(): Promise<void> {
  try {
    await run(process.execPath, [TSC, '-p', BUILD_CONFIG], { cwd: REPO_ROOT });
  } catch (error) {
    // tsc reports diagnostics on stdout; the rejection message alone says nothing.
    const details = String((error as { stdout?: string }).stdout ?? (error as Error).message).trim();
    throw new Error(`tsc -p tsconfig.build.json failed:\n${details}`);
  }
}

/**
 * Reproduce what `npm install` writes: a relative symlink in `node_modules/.bin`
 * pointing at the package's bin file.
 *
 * @returns the link path — invoking THROUGH it is the whole point, because that
 * is when Node hands the entrypoint guard a link path in `process.argv[1]` and a
 * realpath in `import.meta.url`.
 */
async function linkBin(dir: string, target: string): Promise<string> {
  const binDir = path.join(dir, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  const link = path.join(binDir, 'titw');
  await fs.symlink(path.relative(binDir, target), link);
  return link;
}

/** Run a script in a child `node`, as a shell would: a non-zero exit is a result, not a throw. */
async function cli(script: string, args: readonly string[], home: string): Promise<CliRun> {
  const options = { env: { ...process.env, [TITW_HOME_ENV]: home } };
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

describe('the published bin runs when invoked through the symlink npm installs', () => {
  let root: string;
  let home: string;
  let bin: string;
  let link: string;

  beforeAll(async () => {
    await buildDist();
    // Both roots are realpath-resolved (makeTmpDir resolves its own) so the bin
    // link is the only symlink in play and the test cannot pass by accident.
    bin = await fs.realpath(BIN);
    root = await makeTmpDir('bin');
    home = path.join(root, 'home');
    link = await linkBin(root, bin);
  }, 120_000);

  afterAll(async () => {
    await removeTree(root);
  });

  it('prints usage through the link instead of exiting 0 in silence', async () => {
    const result = await cli(link, ['--help'], home);
    expect(result.stdout).toMatch(/^Usage: titw/);
    expect(result.code).toBe(0);
  }, 30_000);

  it('runs a real command through the link, not only commander’s help', async () => {
    const result = await cli(link, ['status', '--json'], home);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { initialized: boolean; packages: unknown[] };
    expect(payload.initialized).toBe(false);
    expect(payload.packages).toEqual([]);
  }, 30_000);

  it('still runs when invoked at its own path, with no link involved', async () => {
    const result = await cli(bin, ['--help'], home);
    expect(result.stdout).toMatch(/^Usage: titw/);
    expect(result.code).toBe(0);
  }, 30_000);
});
