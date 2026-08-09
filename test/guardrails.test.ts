import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enabledTargets } from '../src/commands/context.js';
import { install, installFrozen } from '../src/commands/install.js';
import { sync, validateStaged } from '../src/commands/sync.js';
import { uninstall } from '../src/commands/uninstall.js';
import { gc } from '../src/commands/gc.js';
import { copyFile, walkFiles, writeFile } from '../src/core/fsx.js';
import { loadLock, parseLock, renderLock } from '../src/core/manifest.js';
import { recoverInterruptedSwap } from '../src/materialize/generation.js';
import { targetLayout, layoutFor } from '../src/materialize/layout.js';
import { ClaudeTarget } from '../src/targets/claude/index.js';
import type { TargetPackageInput } from '../src/targets/types.js';
import { FIXTURE_PACKAGE, buildFixtureRepo, makeTmpDir, removeTree, type FixtureRepo } from './helpers/fixture.js';

const RECORD = (id: string) =>
  `---\nid: ${id}\nkind: principle\nkeywords: [x]\n---\n\n# R\n`;

async function fakePackage(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<TargetPackageInput> {
  const dir = path.join(root, name.replace(/\//g, '+'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
  return {
    name,
    version: '1.0.0',
    commit: null,
    source: `path:${dir}`,
    rootDir: dir,
    files: Object.keys(files).sort(),
  };
}

describe('projection guard rails', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTmpDir('guards');
  });
  afterAll(async () => {
    await removeTree(root);
  });

  it('throws E_DUPLICATE_RECORD_ID when two packages project the same record id', async () => {
    const a = await fakePackage(root, '@t/a', { 'k/one.md': RECORD('prin.same') });
    const b = await fakePackage(root, '@t/b', { 'k/two.md': RECORD('prin.same') });
    const out = path.join(root, 'out-dup');
    await expect(new ClaudeTarget().build({ outDir: out, packages: [a, b] })).rejects.toMatchObject({
      code: 'E_DUPLICATE_RECORD_ID',
    });
  });

  it('is immune to prototype poisoning via id: __proto__ (catalog has a null prototype)', async () => {
    const a = await fakePackage(root, '@t/proto', { 'k/evil.md': RECORD('__proto__') });
    const out = path.join(root, 'out-proto');
    await new ClaudeTarget().build({ outDir: out, packages: [a] });
    const catalog = JSON.parse(await fs.readFile(path.join(out, 'catalog.json'), 'utf8')) as Record<
      string,
      { sourcePath: string }
    >;
    expect(Object.keys(catalog)).toContain('__proto__');
    expect(catalog['__proto__']?.sourcePath).toBe('k/evil.md');

    const b = await fakePackage(root, '@t/proto2', { 'k/evil2.md': RECORD('__proto__') });
    await expect(
      new ClaudeTarget().build({ outDir: path.join(root, 'out-proto2'), packages: [a, b] }),
    ).rejects.toMatchObject({ code: 'E_DUPLICATE_RECORD_ID' });
  });

  it('warns on an unrecognized record kind instead of dropping the file', async () => {
    const a = await fakePackage(root, '@t/evo', {
      'k/EVOLUTION.md': '---\nid: x.e\nkind: evolution\nkeywords: [x]\n---\n# E\n',
    });
    const out = path.join(root, 'out-evo');
    const result = await new ClaudeTarget().build({ outDir: out, packages: [a] });
    expect(result.paths).toContain('corpus/@t+evo/k/EVOLUTION.md');
    expect(result.warnings.join('\n')).toContain('unrecognized kind "evolution"');
  });

  it('rejects a symlink anywhere under a walked tree (E_SYMLINK)', async () => {
    const dir = path.join(root, 'symlinked');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'real.md'), 'x');
    await fs.symlink(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
    await expect(walkFiles(dir)).rejects.toMatchObject({ code: 'E_SYMLINK' });
  });

  it('validateStaged rejects a target claiming paths it did not write, and vice versa', async () => {
    const stage = path.join(root, 'stage');
    await fs.mkdir(stage, { recursive: true });
    await fs.writeFile(path.join(stage, 'present.md'), 'x');
    await expect(validateStaged(stage, ['present.md', 'ghost.md'])).rejects.toMatchObject({
      code: 'E_TARGET_INVALID',
    });
    await expect(validateStaged(stage, [])).rejects.toMatchObject({ code: 'E_TARGET_INVALID' });
    await expect(validateStaged(stage, ['present.md'])).resolves.toBeUndefined();
  });

  it('enabledTargets: explicit enabled:false disables — it never falls back to the default', () => {
    expect(enabledTargets({ schema: 1, name: 'default', packages: {}, targets: {} })).toEqual([
      'claude',
    ]);
    expect(
      enabledTargets({
        schema: 1,
        name: 'default',
        packages: {},
        targets: { claude: { enabled: false } },
      }),
    ).toEqual([]);
  });

  it('hard-rejects a non-default environment (D15)', async () => {
    await expect(sync({ environment: 'staging', home: root })).rejects.toMatchObject({
      code: 'E_ENV_UNSUPPORTED',
    });
  });

  it('gc refuses to run against a missing environment instead of deleting everything', async () => {
    await expect(gc({ home: path.join(root, 'no-env-home') })).rejects.toMatchObject({
      code: 'E_NO_ENVIRONMENT',
    });
  });

  it('rejects an https source with a token in the username', async () => {
    const { parseSource } = await import('../src/core/source.js');
    expect(() => parseSource('git+https://x-access-token@github.com/o/r.git')).toThrowError(
      /credentials/,
    );
  });
});

describe('fsx atomicity and mode preservation (D22)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTmpDir('fsx');
  });
  afterAll(async () => {
    await removeTree(root);
  });

  it('writeFile replaces via temp+rename and leaves no temp file behind', async () => {
    const file = path.join(root, 'lock.json');
    await writeFile(file, 'one');
    await writeFile(file, 'two');
    expect(await fs.readFile(file, 'utf8')).toBe('two');
    expect((await fs.readdir(root)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('copyFile preserves the execute bit', async () => {
    const src = path.join(root, 'tool.sh');
    await fs.writeFile(src, '#!/bin/sh\n');
    await fs.chmod(src, 0o755);
    const dst = path.join(root, 'copied', 'tool.sh');
    await copyFile(src, dst);
    expect((await fs.stat(dst)).mode & 0o111).not.toBe(0);
  });
});

describe('activation crash recovery', () => {
  it('restores the retired tree as active when a swap crashed mid-rename', async () => {
    const root = await makeTmpDir('crash');
    const layout = targetLayout(layoutFor(root), 'claude');
    const gen = 'g1';
    await fs.mkdir(path.join(layout.root, `.prev-${gen}`), { recursive: true });
    await fs.writeFile(path.join(layout.root, `.prev-${gen}`, 'kept.md'), 'last good');
    await fs.writeFile(path.join(layout.root, '.swap.json'), JSON.stringify({ generation: gen }));

    await recoverInterruptedSwap(layout);
    expect(await fs.readFile(path.join(layout.active, 'kept.md'), 'utf8')).toBe('last good');
    await removeTree(root);
  });

  it('promotes the journalled retired tree over a stale previous/', async () => {
    const root = await makeTmpDir('crash2');
    const layout = targetLayout(layoutFor(root), 'claude');
    const gen = 'g2';
    await fs.mkdir(layout.active, { recursive: true });
    await fs.mkdir(layout.previous, { recursive: true });
    await fs.writeFile(path.join(layout.previous, 'stale.md'), 'older generation');
    await fs.mkdir(path.join(layout.root, `.prev-${gen}`), { recursive: true });
    await fs.writeFile(path.join(layout.root, `.prev-${gen}`, 'kept.md'), 'journalled');
    await fs.writeFile(path.join(layout.root, '.swap.json'), JSON.stringify({ generation: gen }));

    await recoverInterruptedSwap(layout);
    expect(await fs.readFile(path.join(layout.previous, 'kept.md'), 'utf8')).toBe('journalled');
    await removeTree(root);
  });

  it('recovers an interrupted rollback: the parked tree is never lost to pruning', async () => {
    const root = await makeTmpDir('crash3');
    const layout = targetLayout(layoutFor(root), 'claude');
    // Crash right after active→parked: no active, previous still in place.
    await fs.mkdir(layout.previous, { recursive: true });
    await fs.writeFile(path.join(layout.previous, 'old.md'), 'restore me');
    await fs.mkdir(path.join(layout.root, '.rollback-123'), { recursive: true });
    await fs.writeFile(path.join(layout.root, '.rollback-123', 'was-active.md'), 'park me');
    await fs.writeFile(
      path.join(layout.root, '.swap.json'),
      JSON.stringify({ generation: 'rollback', rollback: '.rollback-123' }),
    );

    await recoverInterruptedSwap(layout);
    expect(await fs.readFile(path.join(layout.active, 'old.md'), 'utf8')).toBe('restore me');
    expect(await fs.readFile(path.join(layout.previous, 'was-active.md'), 'utf8')).toBe('park me');
    await removeTree(root);
  });
});

describe('lifecycle against a real fixture repo', () => {
  let root: string;
  let home: string;
  let repo: FixtureRepo;

  beforeAll(async () => {
    root = await makeTmpDir('lifecycle');
    home = path.join(root, 'home');
    repo = await buildFixtureRepo(path.join(root, 'fixture-way'));
    await install({ home, source: repo.source, version: '^1.0.0' });
    await sync({ home });
  }, 60_000);
  afterAll(async () => {
    await removeTree(root);
  });

  it('sync never rewrites titw.yaml: a hand-written comment survives (D17)', async () => {
    const manifest = path.join(home, 'environments/default/titw.yaml');
    const commented = `# hand-edited\n${await fs.readFile(manifest, 'utf8')}`;
    await fs.writeFile(manifest, commented);
    await sync({ home });
    expect(await fs.readFile(manifest, 'utf8')).toBe(commented);
  });

  it('sync --locked passes when nothing changes and fails when the lock would change', async () => {
    await sync({ home, locked: true });

    const lockFile = path.join(home, 'environments/default/titw.lock');
    const lock = parseLock(await fs.readFile(lockFile, 'utf8'), lockFile);
    const entry = lock.packages[FIXTURE_PACKAGE];
    if (entry === undefined) throw new Error('fixture not locked');
    lock.packages[FIXTURE_PACKAGE] = { ...entry, selection: entry.selection.slice(1) };
    await fs.writeFile(lockFile, renderLock(lock));
    await expect(sync({ home, locked: true })).rejects.toMatchObject({ code: 'E_LOCK_DRIFT' });
    await sync({ home }); // repair for the following tests
  });

  it('detects installed-tree tampering against the lock (E_HASH_MISMATCH)', async () => {
    const readme = path.join(home, 'packages/installed/@titw+fixture-way/1.1.0/README.md');
    const original = await fs.readFile(readme);
    await fs.writeFile(readme, 'tampered');
    await expect(sync({ home })).rejects.toMatchObject({ code: 'E_HASH_MISMATCH' });
    await fs.writeFile(readme, original);
    await sync({ home });
  });

  it('reports drift in the replaced projection without deleting it', async () => {
    const active = targetLayout(layoutFor(home), 'claude').active;
    const unowned = path.join(active, 'corpus', 'hand-made.md');
    await fs.writeFile(unowned, 'mine');
    const result = await sync({ home });
    expect(result.targets[0]?.drift?.unowned).toContain('corpus/hand-made.md');
  });

  it('install --frozen reproduces the locked bytes and refuses a lock mismatch', async () => {
    const installedDir = path.join(home, 'packages/installed/@titw+fixture-way/1.1.0');
    await removeTree(installedDir);
    const result = await installFrozen({ home });
    expect(result.packages).toEqual([
      { name: FIXTURE_PACKAGE, version: '1.1.0', commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(await walkFiles(installedDir)).toContain('titw.package.yaml');

    const lockFile = path.join(home, 'environments/default/titw.lock');
    const lock = await loadLock(lockFile);
    const entry = lock.packages[FIXTURE_PACKAGE];
    if (entry === undefined) throw new Error('fixture not locked');
    lock.packages[FIXTURE_PACKAGE] = { ...entry, treeHash: 'sha256:'.padEnd(71, '0') };
    await fs.writeFile(lockFile, renderLock(lock));
    await expect(installFrozen({ home })).rejects.toMatchObject({ code: 'E_FROZEN_CHANGED' });
    lock.packages[FIXTURE_PACKAGE] = entry;
    await fs.writeFile(lockFile, renderLock(lock));
  });

  it('uninstall removes manifest + lock entries and the installed tree, then gc reclaims the cache', async () => {
    const result = await uninstall({ home, package: FIXTURE_PACKAGE });
    expect(result.sync?.targets[0]?.paths).toBe(1); // catalog.json only

    const lock = await loadLock(path.join(home, 'environments/default/titw.lock'));
    expect(lock.packages).toEqual({});
    const manifestText = await fs.readFile(path.join(home, 'environments/default/titw.yaml'), 'utf8');
    expect(manifestText).not.toContain(FIXTURE_PACKAGE);
    await expect(
      fs.stat(path.join(home, 'packages/installed/@titw+fixture-way/1.1.0')),
    ).rejects.toThrow();

    const cacheDir = path.join(home, 'cache');
    expect((await fs.readdir(cacheDir)).length).toBeGreaterThan(0);
    const reclaimed = await gc({ home });
    expect(reclaimed.cache.length).toBeGreaterThan(0);
    expect(await fs.readdir(cacheDir)).toEqual([]);
  });
});
