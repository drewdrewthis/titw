import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../src/commands/install.js';
import { status } from '../src/commands/status.js';
import { sync } from '../src/commands/sync.js';
import { hashFile } from '../src/core/hash.js';
import { buildFixtureRepo, makeTmpDir, removeTree, type FixtureRepo } from './helpers/fixture.js';

/** Verbatim per-package projection root (D23). */
const PKG = 'corpus/@titw+fixture-way';
const README = `${PKG}/README.md`;
const SCRIPT = `${PKG}/scripts/verify.sh`;
const PRINCIPLE = `${PKG}/knowledge/principles/simple-first.md`;

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

/** Captures prompt output for assertions, unlike `sinkStdout`, which discards it. */
function collectStdout(): { stream: NodeJS.WritableStream; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

async function readActive(active: string, rel: string): Promise<string> {
  return fs.readFile(path.join(active, ...rel.split('/')), 'utf8');
}

async function editActive(active: string, rel: string, content: string): Promise<void> {
  await fs.writeFile(path.join(active, ...rel.split('/')), content);
}

interface PinsFile {
  schema: number;
  target: string;
  pins: Array<{ path: string; hash: string; upstreamHash: string }>;
}

async function readPinsFile(home: string): Promise<PinsFile> {
  const file = path.join(home, 'environments/default/receipts/claude/pins.json');
  return JSON.parse(await fs.readFile(file, 'utf8')) as PinsFile;
}

/** Simulates "upstream moved since the pin was made" without a second fixture version. */
async function corruptPinUpstreamHash(home: string, rel: string): Promise<void> {
  const file = path.join(home, 'environments/default/receipts/claude/pins.json');
  const current = await readPinsFile(home);
  const next: PinsFile = {
    ...current,
    pins: current.pins.map((pin) =>
      pin.path === rel ? { ...pin, upstreamHash: 'stale-upstream-hash-for-test' } : pin,
    ),
  };
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

describe('sync drift resolution: replace / keep / propose', () => {
  let root: string;
  let home: string;
  let active: string;
  let originalReadme: string;
  let originalScript: string;
  let originalPrinciple: string;

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
    originalPrinciple = await readActive(active, PRINCIPLE);
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

  it('interactive keep: preserves the local edit and pins it so the choice survives the next sync', async () => {
    await editActive(active, README, 'LOCAL EDIT — kept\n');

    const result = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    const target = result.targets[0];

    expect(target?.drift?.modified).toEqual([README]);
    expect(target?.kept).toEqual([README]);
    expect(target?.pinned).toEqual([]);
    expect(target?.proposed).toBeNull();
    expect(await readActive(active, README)).toBe('LOCAL EDIT — kept\n');

    const receipt = JSON.parse(
      await fs.readFile(path.join(home, 'environments/default/receipts/claude/current.json'), 'utf8'),
    ) as { paths: Array<{ path: string; sha256: string }> };
    const entry = receipt.paths.find((p) => p.path === README);
    expect(entry?.sha256).toBe(await hashFile(path.join(active, ...README.split('/'))));

    // The receipt now matches what's active, so an immediate re-check with no
    // further local edit reports no drift for this path. Unlike before pins
    // existed, that is not the end of the story: the earlier `keep` left a
    // pin behind (receipts/claude/pins.json), and this sync honors it
    // silently — the kept bytes are copied back over the fresh build before
    // the receipt is built — so the choice survives instead of expiring
    // after one sync. See the comment on resolveModifiedDrift in
    // src/commands/sync.ts.
    const again = await sync({ home, stdin: nonTtyStdin(), stdout: sinkStdout() });
    expect(again.targets[0]?.drift?.modified ?? []).not.toContain(README);
    expect(again.targets[0]?.kept).toEqual([]);
    expect(again.targets[0]?.pinned).toEqual([README]);
    expect(await readActive(active, README)).toBe('LOCAL EDIT — kept\n');
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

  it('interactive: a pin whose upstream baseline moved is re-prompted, not silently honored', async () => {
    await editActive(active, PRINCIPLE, 'LOCAL EDIT — principle\n');
    const pinned = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    expect(pinned.targets[0]?.kept).toEqual([PRINCIPLE]);

    // Simulate upstream changing since the pin was made, without a second
    // fixture version: corrupt the recorded upstreamHash directly on disk.
    await corruptPinUpstreamHash(home, PRINCIPLE);

    // A different answer than the original pin ('r' instead of 'k') so the
    // assertion below can only pass if the user was actually asked again —
    // silently re-honoring the stale pin would never consult this answer.
    const out = collectStdout();
    const again = await sync({ home, stdin: ttyStdinAnswers(['r']), stdout: out.stream });
    const target = again.targets[0];

    expect(target?.drift?.modified ?? []).toEqual([]);
    expect(target?.kept).toEqual([]);
    // README and SCRIPT still carry valid pins from earlier tests (upstream
    // unchanged for them) and are silently re-honored this same sync; only
    // the stale PRINCIPLE pin is excluded, since it fell back to replace.
    expect((target?.pinned ?? []).slice().sort()).toEqual([README, SCRIPT].slice().sort());
    expect(out.text()).toContain('upstream changed for 1 pinned file(s)');
    expect(out.text()).toContain(PRINCIPLE);
    expect(await readActive(active, PRINCIPLE)).toBe(originalPrinciple);

    const pins = await readPinsFile(home);
    expect(pins.pins.find((p) => p.path === PRINCIPLE)).toBeUndefined();
  }, 30_000);

  it('non-interactive: a pin whose upstream baseline moved falls back to replace, and is dropped', async () => {
    await editActive(active, PRINCIPLE, 'LOCAL EDIT — principle again\n');
    const pinned = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    expect(pinned.targets[0]?.kept).toEqual([PRINCIPLE]);

    await corruptPinUpstreamHash(home, PRINCIPLE);

    // No answers are scripted: a non-interactive run must resolve the stale
    // pin (and any other drift) without ever attempting to prompt, or this
    // would hang instead of completing.
    const result = await sync({ home, stdin: nonTtyStdin(), stdout: sinkStdout() });
    const target = result.targets[0];

    expect(target?.drift?.modified ?? []).toEqual([]);
    expect(target?.kept).toEqual([]);
    // Same carried-forward-pin reasoning as the interactive case above.
    expect((target?.pinned ?? []).slice().sort()).toEqual([README, SCRIPT].slice().sort());
    expect(await readActive(active, PRINCIPLE)).toBe(originalPrinciple);

    const pins = await readPinsFile(home);
    expect(pins.pins.find((p) => p.path === PRINCIPLE)).toBeUndefined();
  }, 30_000);

  it('--clear-pins drops every recorded pin without prompting, letting the fresh build reclaim it', async () => {
    await editActive(active, PRINCIPLE, 'LOCAL EDIT — principle clear-pins\n');
    const pinned = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    expect(pinned.targets[0]?.kept).toEqual([PRINCIPLE]);

    // No answers are scripted: clearing pins must not itself trigger a
    // prompt, since there is no fresh drift left once the pin no longer
    // protects the file.
    const result = await sync({
      home,
      clearPins: true,
      stdin: ttyStdinNoAnswers(),
      stdout: sinkStdout(),
    });
    const target = result.targets[0];

    expect(target?.kept).toEqual([]);
    expect(target?.pinned).toEqual([]);
    expect(await readActive(active, PRINCIPLE)).toBe(originalPrinciple);

    const pins = await readPinsFile(home);
    expect(pins.pins).toEqual([]);
  }, 30_000);

  it('status() reports currently pinned paths per target', async () => {
    await editActive(active, PRINCIPLE, 'LOCAL EDIT — principle for status\n');
    const pinned = await sync({ home, stdin: ttyStdinAnswers(['k']), stdout: sinkStdout() });
    expect(pinned.targets[0]?.kept).toEqual([PRINCIPLE]);

    const result = await status({ home });
    expect(result.targets[0]?.pinned).toEqual([PRINCIPLE]);
  }, 30_000);
});
