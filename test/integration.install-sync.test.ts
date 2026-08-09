import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { files } from '../src/commands/files.js';
import { install } from '../src/commands/install.js';
import { outdated } from '../src/commands/outdated.js';
import { status } from '../src/commands/status.js';
import { rollback, sync } from '../src/commands/sync.js';
import { hashFile } from '../src/core/hash.js';
import { loadLock } from '../src/core/manifest.js';
import { walkFiles } from '../src/core/fsx.js';
import type { Catalog } from '../src/targets/claude/index.js';
import {
  FIXTURE_PACKAGE,
  buildFixtureRepo,
  publishFixtureVersion,
  makeTmpDir,
  removeTree,
  type FixtureRepo,
} from './helpers/fixture.js';

const VM_ONLY = 'knowledge/procedures/vm-only/**';

/** Verbatim per-package projection root (D23). */
const PKG = 'corpus/@titw+fixture-way';

const CORPUS_PATHS = [
  `${PKG}/README.md`,
  `${PKG}/knowledge/decisions/2026-08-08-use-yaml.md`,
  `${PKG}/knowledge/failure-modes/stale-projection.md`,
  `${PKG}/knowledge/principles/added-in-1-1.md`,
  `${PKG}/knowledge/principles/simple-first.md`,
  `${PKG}/knowledge/procedures/deploy/PROCEDURE.md`,
  `${PKG}/knowledge/research/okf-adoption.md`,
  `${PKG}/knowledge/solutions/2026-08-08-tag-resolution.md`,
  `${PKG}/plans/ship-v1.md`,
  `${PKG}/scripts/verify.sh`,
];

describe('install -> sync -> Claude corpus projection', () => {
  let root: string;
  let home: string;
  let repo: FixtureRepo;
  let active: string;

  beforeAll(async () => {
    root = await makeTmpDir('slice');
    home = path.join(root, 'home');
    repo = await buildFixtureRepo(path.join(root, 'fixture-way'));

    await install({
      home,
      source: repo.source,
      version: '^1.0.0',
      exclude: [VM_ONLY],
    });
    const result = await sync({ home });
    active = result.targets[0]?.root ?? '';
  }, 60_000);

  afterAll(async () => {
    await removeTree(root);
  });

  it('resolves the version from the default-branch manifest (no tags) and locks the exact commit', async () => {
    const lock = await loadLock(path.join(home, 'environments/default/titw.lock'));
    const entry = lock.packages[FIXTURE_PACKAGE];
    expect(entry?.version).toBe('1.1.0');
    expect(entry?.ref).toBe('origin/main');
    expect(entry?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry?.range).toBe('^1.0.0');
    expect(entry?.treeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fetches and installs the whole package even though a path is excluded', async () => {
    const installed = path.join(home, 'packages/installed/@titw+fixture-way/1.1.0');
    const present = await walkFiles(installed);
    expect(present).toContain('knowledge/procedures/vm-only/PROCEDURE.md');
    expect(present).toContain('titw.package.yaml');
    expect(present).toContain('CHANGELOG.md');

    const lock = await loadLock(path.join(home, 'environments/default/titw.lock'));
    expect(lock.packages[FIXTURE_PACKAGE]?.selection).not.toContain(
      'knowledge/procedures/vm-only/PROCEDURE.md',
    );
  });

  it('preserves source file modes: a packaged script survives install+sync executable (D22)', async () => {
    const installed = path.join(
      home,
      'packages/installed/@titw+fixture-way/1.1.0/scripts/verify.sh',
    );
    const projected = path.join(active, ...`${PKG}/scripts/verify.sh`.split('/'));
    expect((await fs.stat(installed)).mode & 0o111).not.toBe(0);
    expect((await fs.stat(projected)).mode & 0o111).not.toBe(0);
  });

  it('projects every selected file verbatim under the package dir, omitting the excluded path', async () => {
    const present = await walkFiles(active);
    expect(present).toEqual([...CORPUS_PATHS, 'catalog.json'].sort());
    expect(present).not.toContain(`${PKG}/knowledge/procedures/vm-only/PROCEDURE.md`);
  });

  it('copies six-key record bytes identically into the projection', async () => {
    const source = path.join(
      home,
      'packages/installed/@titw+fixture-way/1.1.0/knowledge/procedures/deploy/PROCEDURE.md',
    );
    const projected = path.join(active, ...`${PKG}/knowledge/procedures/deploy/PROCEDURE.md`.split('/'));
    expect(await hashFile(projected)).toBe(await hashFile(source));
  });

  it('decorates only the projected copy of an OKF record with compat keys', async () => {
    const rel = 'knowledge/research/okf-adoption.md';
    const source = path.join(home, 'packages/installed/@titw+fixture-way/1.1.0', rel);
    const projected = path.join(active, ...`${PKG}/knowledge/research/okf-adoption.md`.split('/'));

    const sourceText = await fs.readFile(source, 'utf8');
    const projectedText = await fs.readFile(projected, 'utf8');

    expect(sourceText).not.toContain('kind:');
    expect(sourceText).not.toContain('keywords:');
    expect(sourceText).not.toMatch(/^id:/m);
    expect(projectedText).toMatch(/^id: res.okf-adoption$/m);
    expect(projectedText).toContain('kind: research');
    expect(projectedText).toMatch(/^keywords: \[okf, frontmatter, titwfixture\]$/m);
    expect(projectedText).toContain('type: Research');
    expect(projectedText.slice(projectedText.indexOf('\n---', 4))).toBe(
      sourceText.slice(sourceText.indexOf('\n---', 4)),
    );
  });

  it('emits a provenance catalog keyed by stable record id', async () => {
    const catalog = JSON.parse(
      await fs.readFile(path.join(active, 'catalog.json'), 'utf8'),
    ) as Catalog;

    const entry = catalog['proc.deploy.fixture'];
    expect(entry).toBeDefined();
    expect(entry?.package).toBe(FIXTURE_PACKAGE);
    expect(entry?.version).toBe('1.1.0');
    expect(entry?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry?.sourcePath).toBe('knowledge/procedures/deploy/PROCEDURE.md');
    expect(entry?.targetPath).toBe(`${PKG}/knowledge/procedures/deploy/PROCEDURE.md`);
    expect(entry?.editable).toBe(false);

    expect(catalog['res.okf-adoption']?.sourcePath).toBe('knowledge/research/okf-adoption.md');
    expect(catalog[`${PKG}/README.md`]?.sourcePath).toBe('README.md');
    expect(Object.keys(catalog)).not.toContain('proc.vm-only.fixture');
  });

  it('records a receipt naming every owned path with its hash', async () => {
    const receipt = JSON.parse(
      await fs.readFile(path.join(home, 'environments/default/receipts/claude/current.json'), 'utf8'),
    ) as { paths: Array<{ path: string; sha256: string; bytes: number }>; packages: unknown[] };

    expect(receipt.paths.map((entry) => entry.path)).toEqual(await walkFiles(active));
    for (const entry of receipt.paths) {
      expect(await hashFile(path.join(active, ...entry.path.split('/')))).toBe(entry.sha256);
      expect(entry.bytes).toBeGreaterThan(0);
    }
    expect(receipt.packages).toHaveLength(1);
  });

  it('reports the package and its corpus root in status and files', async () => {
    const state = await status({ home });
    expect(state.packages[0]?.name).toBe(FIXTURE_PACKAGE);
    expect(state.packages[0]?.installed).toBe(true);
    expect(state.targets[0]?.corpusRoot).toBe(path.join(active, 'corpus'));

    const listed = await files({ home, package: FIXTURE_PACKAGE });
    const deploy = listed.files.find(
      (file) => file.path === 'knowledge/procedures/deploy/PROCEDURE.md',
    );
    expect(deploy?.targetPath).toBe(`${PKG}/knowledge/procedures/deploy/PROCEDURE.md`);
    expect(deploy?.sha256).toMatch(/^sha256:/);
  });

  it('reports current, wanted, and latest from the published manifest version', async () => {
    const report = await outdated({ home });
    expect(report.packages[0]).toMatchObject({
      current: '1.1.0',
      wanted: '1.1.0',
      latest: '1.1.0',
      upToDate: true,
    });
  });

  it('re-syncs idempotently: same paths, same bytes, retained previous generation', async () => {
    const before = await inventoryOf(active);
    const second = await sync({ home });

    expect(second.targets[0]?.activated).toBe(true);
    expect(await inventoryOf(active)).toEqual(before);
    expect(await walkFiles(path.join(home, 'targets/claude/previous'))).toEqual(
      Object.keys(before),
    );
    expect(await walkFiles(path.join(home, 'environments/default/generations'))).toEqual([]);
  });

  it('activates a narrowed selection and rolls back to the previous projection', async () => {
    const before = await inventoryOf(active);

    await install({
      home,
      source: repo.source,
      version: '^1.0.0',
      include: ['knowledge/principles/**'],
    });
    await sync({ home });

    const narrowed = await walkFiles(active);
    expect(narrowed).toEqual([
      'catalog.json',
      `${PKG}/knowledge/principles/added-in-1-1.md`,
      `${PKG}/knowledge/principles/simple-first.md`,
    ]);

    const rolledBack = await rollback({ home });
    expect(rolledBack.id).toBe('claude');
    expect(await inventoryOf(active)).toEqual(before);

    const receipt = JSON.parse(
      await fs.readFile(path.join(home, 'environments/default/receipts/claude/current.json'), 'utf8'),
    ) as { paths: Array<{ path: string }> };
    expect(receipt.paths.map((entry) => entry.path)).toEqual(Object.keys(before));
  });

  async function inventoryOf(dir: string): Promise<Record<string, string>> {
    const entries = await Promise.all(
      (await walkFiles(dir)).map(
        async (rel) => [rel, await hashFile(path.join(dir, ...rel.split('/')))] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
});

describe('selection and dry runs', () => {
  let root: string;
  let home: string;
  let repo: FixtureRepo;

  beforeAll(async () => {
    root = await makeTmpDir('slice-select');
    home = path.join(root, 'home');
    repo = await buildFixtureRepo(path.join(root, 'fixture-way'));
  }, 60_000);

  afterAll(async () => {
    await removeTree(root);
  });

  it('refuses a range the published version does not satisfy (D19: only HEAD is installable)', async () => {
    await expect(
      install({ home, source: repo.source, version: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'E_VERSION_UNRESOLVED' });
  }, 30_000);

  it('installs a single file and projects only that record', async () => {
    await install({
      home,
      source: repo.source,
      version: '1.1.0',
      include: ['knowledge/principles/simple-first.md'],
    });
    const result = await sync({ home });

    const lock = await loadLock(path.join(home, 'environments/default/titw.lock'));
    expect(lock.packages[FIXTURE_PACKAGE]?.version).toBe('1.1.0');
    expect(lock.packages[FIXTURE_PACKAGE]?.selection).toEqual([
      'knowledge/principles/simple-first.md',
    ]);
    expect(await walkFiles(result.targets[0]?.root ?? '')).toEqual([
      'catalog.json',
      `${PKG}/knowledge/principles/simple-first.md`,
    ]);
  }, 30_000);

  it('refuses a downgrade against the lock (D19: versions are monotonic)', async () => {
    await publishFixtureVersion(repo, '0.9.0');
    await expect(install({ home, source: repo.source })).rejects.toMatchObject({
      code: 'E_VERSION_DOWNGRADE',
    });
    await publishFixtureVersion(repo, '1.1.0');
  }, 30_000);

  it('leaves no state behind on a dry-run install', async () => {
    const dryHome = path.join(root, 'dry-home');
    const result = await install({
      home: dryHome,
      source: repo.source,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.version).toBe('1.1.0');
    expect(result.selected.length).toBeGreaterThan(0);
    await expect(fs.stat(path.join(dryHome, 'environments'))).rejects.toThrow();
  }, 30_000);

  it('stages and validates without activating on a dry-run sync', async () => {
    const before = await walkFiles(path.join(home, 'targets/claude/active'));
    const result = await sync({ home, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.targets[0]?.activated).toBe(false);
    expect(result.targets[0]?.paths).toBe(2);
    expect(await walkFiles(path.join(home, 'targets/claude/active'))).toEqual(before);
    expect(await walkFiles(path.join(home, 'environments/default/generations'))).toEqual([]);
  }, 30_000);

  it('refuses a selection that matches nothing', async () => {
    await expect(
      install({
        home: path.join(root, 'empty-home'),
        source: repo.source,
        include: ['knowledge/does-not-exist/**'],
      }),
    ).rejects.toThrow(/nothing selected/);
  }, 30_000);
});
