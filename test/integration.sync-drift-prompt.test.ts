import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../src/commands/install.js';
import { sync } from '../src/commands/sync.js';
import { hashFile } from '../src/core/hash.js';
import { buildFixtureRepo, makeTmpDir, removeTree, type FixtureRepo } from './helpers/fixture.js';

/** Verbatim per-package projection root (D23). */
const PKG = 'corpus/@titw+fixture-way';
const README = `${PKG}/README.md`;
const SCRIPT = `${PKG}/scripts/verify.sh`;

type PromptStdin = NodeJS.ReadableStream & { readonly isTTY?: boolean };

/** A non-TTY stdin with nothing to read: the auto-detect fallback (no prompt). */
function nonTtyStdin(): PromptStdin {
  return Object.assign(Readable.from([]), { isTTY: false });
}

/** A TTY-looking stdin with scripted answers, one per line. */
function ttyStdinAnswers(lines: readonly string[]): PromptStdin {
  return Object.assign(Readable.from([`${lines.join('\n')}\n`]), { isTTY: true });
}

/** A TTY-looking stdin with no answers available: proves a prompt was never attempted. */
function ttyStdinNoAnswers(): PromptStdin {
  return Object.assign(Readable.from([]), { isTTY: true });
}

/** Discards prompt output so tests stay quiet. */
function sinkStdout(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

async function readActive(active: string, rel: string): Promise<string> {
  return fs.readFile(path.join(active, ...rel.split('/')), 'utf8');
}

async function editActive(active: string, rel: string, content: string): Promise<void> {
  await fs.writeFile(path.join(active, ...rel.split('/')), content);
}

describe('sync drift resolution: replace / keep / propose', () => {
  let root: string;
  let home: string;
  let active: string;
  let originalReadme: string;
  let originalScript: string;

  beforeAll(async () => {
    root = await makeTmpDir('drift-prompt');
    home = path.join(root, 'home');
    const repo: FixtureRepo = await buildFixtureRepo(path.join(root, 'fixture-way'));

    await install({
      home,
      source: repo.source,
      version: '^1.0.0',
      include: ['README.md', 'scripts/verify.sh', 'knowledge/principles/simple-first.md'],
    });
    const result = await sync({ home });
    active = result.targets[0]?.root ?? '';
    originalReadme = await readActive(active, README);
    originalScript = await readActive(active, SCRIPT);
  }, 60_000);

  afterAll(async () => {
    await removeTree(root);
  });

  it('auto-detected non-interactive (no TTY): replaces silently, still reports the drift', async () => {
    await editActive(active, README, 'LOCAL EDIT — no tty\n');
    await editActive(active, SCRIPT, '#!/usr/bin/env bash\necho local-edit-no-tty\n');
    expect(await readActive(active, README)).toContain('LOCAL EDIT');

    const result = await sync({ home, stdin: nonTtyStdin(), stdout: sinkStdout() });
    const target = result.targets[0];

    expect((target?.drift?.modified ?? []).slice().sort()).toEqual([README, SCRIPT].slice().sort());
    expect(target?.kept).toEqual([]);
    expect(target?.proposed).toBeNull();
    expect(await readActive(active, README)).toBe(originalReadme);
    expect(await readActive(active, SCRIPT)).toBe(originalScript);
  }, 30_000);

  it('--no-interactive escape hatch replaces even when stdin looks like a TTY', async () => {
    await editActive(active, README, 'LOCAL EDIT — escape hatch\n');

    // No answers are scripted: if the flag were ignored and a prompt were
    // attempted anyway, this would reject/hang instead of silently passing.
    const result = await sync({
      home,
      interactive: false,
      stdin: ttyStdinNoAnswers(),
      stdout: sinkStdout(),
    });
    const target = result.targets[0];

    expect(target?.drift?.modified).toEqual([README]);
    expect(target?.kept).toEqual([]);
    expect(await readActive(active, README)).toBe(originalReadme);
  }, 30_000);

  it('interactive keep: preserves the local edit and updates the receipt to its hash', async () => {
    await editActive(active, README, 'LOCAL EDIT — kept\n');

    const result = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    const target = result.targets[0];

    expect(target?.drift?.modified).toEqual([README]);
    expect(target?.kept).toEqual([README]);
    expect(target?.proposed).toBeNull();
    expect(await readActive(active, README)).toBe('LOCAL EDIT — kept\n');

    const receipt = JSON.parse(
      await fs.readFile(path.join(home, 'environments/default/receipts/claude/current.json'), 'utf8'),
    ) as { paths: Array<{ path: string; sha256: string }> };
    const entry = receipt.paths.find((p) => p.path === README);
    expect(entry?.sha256).toBe(await hashFile(path.join(active, ...README.split('/'))));

    // The receipt now matches what's active, so an immediate re-check with no
    // further local edit reports no drift for this path — proving "kept" is
    // no longer flagged, as intended.
    const again = await sync({ home, stdin: nonTtyStdin(), stdout: sinkStdout() });
    expect(again.targets[0]?.drift?.modified ?? []).not.toContain(README);

    // Known consequence of that same mechanism, made explicit rather than
    // hidden: with no drift left to resolve, that verification sync just
    // performed a plain replace, so the kept edit is gone again already. A
    // "keep" choice survives exactly as long as it keeps showing up as
    // drift — see the comment on resolveModifiedDrift in src/commands/sync.ts.
    expect(await readActive(active, README)).toBe(originalReadme);
  }, 30_000);

  it('interactive propose: keeps the edit and records it for upstream contribution', async () => {
    await editActive(active, SCRIPT, '#!/usr/bin/env bash\necho local-edit-propose\n');

    const result = await sync({ home, stdin: ttyStdinAnswers(['p']), stdout: sinkStdout() });
    const target = result.targets[0];

    expect(target?.drift?.modified).toEqual([SCRIPT]);
    expect(target?.kept).toEqual([SCRIPT]);
    expect(await readActive(active, SCRIPT)).toBe('#!/usr/bin/env bash\necho local-edit-propose\n');

    const proposed = target?.proposed;
    expect(proposed).not.toBeNull();
    expect(proposed?.paths).toEqual([SCRIPT]);
    expect(proposed?.file).toMatch(/proposals\.json$/);

    const proposals = JSON.parse(await fs.readFile(proposed!.file, 'utf8')) as {
      schema: number;
      target: string;
      paths: string[];
    };
    expect(proposals).toEqual({ schema: 1, target: 'claude', paths: [SCRIPT] });
  }, 30_000);

  it('interactive apply-to-all: one uppercase answer resolves every remaining modified file', async () => {
    await editActive(active, README, 'LOCAL EDIT — bulk readme\n');
    await editActive(active, SCRIPT, '#!/usr/bin/env bash\necho bulk-script\n');

    // A single answer for two modified files: if apply-to-all did not work,
    // the second question would await input the stream never provides.
    const result = await sync({ home, stdin: ttyStdinAnswers(['K']), stdout: sinkStdout() });
    const target = result.targets[0];

    expect((target?.drift?.modified ?? []).slice().sort()).toEqual([README, SCRIPT].slice().sort());
    expect((target?.kept ?? []).slice().sort()).toEqual([README, SCRIPT].slice().sort());
    expect(target?.proposed).toBeNull();
    expect(await readActive(active, README)).toBe('LOCAL EDIT — bulk readme\n');
    expect(await readActive(active, SCRIPT)).toBe('#!/usr/bin/env bash\necho bulk-script\n');
  }, 30_000);
});
