import fs from 'node:fs/promises';
import path from 'node:path';
import { lt } from 'semver';
import { TitwError } from '../core/errors.js';
import { fetchPackage } from '../core/fetch.js';
import { copyTree, rmTreeForce } from '../core/fsx.js';
import { hashFile } from '../core/hash.js';
import type { EnvironmentManifest, Lock, LockEntry, PackageSelection } from '../core/manifest.js';
import { selectFiles, validateSelectors } from '../core/select.js';
import { parseSource } from '../core/source.js';
import { installedPackageDir } from '../materialize/layout.js';
import { contextFor, readEnvironment, writeEnvironment, type CommandOptions } from './context.js';

export interface InstallOptions extends CommandOptions {
  readonly source: string;
  /** Semver range; when omitted the newest release is used and `^<version>` is recorded. */
  readonly version?: string | undefined;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface InstallResult {
  readonly package: string;
  readonly version: string;
  readonly commit: string | null;
  readonly source: string;
  readonly range: string;
  readonly exported: string[];
  readonly selected: string[];
  readonly installedDir: string;
  readonly dryRun: boolean;
  readonly warnings: string[];
}

/**
 * Fetch, lock, and record a package in an environment.
 *
 * The whole package is fetched and copied read-only even when one file is
 * selected (handoff invariant 3 + 10); nothing is projected until `sync`.
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const context = contextFor(options);
  validateSelectors(options.include, 'include');
  validateSelectors(options.exclude, 'exclude');

  const source = parseSource(options.source, { baseDir: context.cwd });
  const range = options.version ?? '*';
  const fetched = await fetchPackage({ source, range, cacheDir: context.layout.cacheDir });

  const selection = selectFiles({
    files: fetched.files,
    exports: fetched.manifest.exports,
    include: options.include,
    exclude: options.exclude,
  });

  if (selection.selected.length === 0) {
    throw new TitwError(
      'E_SELECTION_EMPTY',
      `nothing selected from ${fetched.manifest.name}@${fetched.version}`,
      [`the package exports ${selection.exported.length} file(s); check --include/--exclude`],
    );
  }

  const warnings = [
    ...selection.unmatchedInclude.map((p) => `--include "${p}" matched no exported file`),
    ...selection.unmatchedExclude.map((p) => `--exclude "${p}" subtracted nothing`),
    // D3: these manifest keys are validated but inert until active-component
    // support (D4) lands — say so instead of silently ignoring them.
    ...(['dependencies', 'components'] as const)
      .filter((key) => fetched.manifest[key] !== undefined)
      .map((key) => `${fetched.manifest.name} declares "${key}", which titw v0 does not act on yet`),
  ];

  const installedDir = installedPackageDir(
    context.layout,
    fetched.manifest.name,
    fetched.version,
  );

  const result: InstallResult = {
    package: fetched.manifest.name,
    version: fetched.version,
    commit: fetched.commit,
    source: source.canonical,
    range: options.version ?? `^${fetched.version}`,
    exported: selection.exported,
    selected: selection.selected,
    installedDir,
    dryRun: options.dryRun === true,
    warnings,
  };
  if (result.dryRun) return result;

  const { manifest, lock } = await readEnvironment(context);

  // D19: versions are monotonic — a source whose published version moved
  // backwards is refused rather than silently replacing newer locked content.
  const locked = lock.packages[result.package];
  if (locked !== undefined && lt(fetched.version, locked.version)) {
    throw new TitwError(
      'E_VERSION_DOWNGRADE',
      `${result.package} is locked at ${locked.version}; ${source.canonical} now publishes ${fetched.version}`,
      ['a published version must only increase (D19)', 'uninstall the package first to accept the downgrade'],
    );
  }

  await stageInstalledTree(fetched.dir, installedDir);
  const selectionEntry: PackageSelection = {
    source: source.canonical,
    version: result.range,
    ...(options.include === undefined ? {} : { include: [...options.include] }),
    ...(options.exclude === undefined ? {} : { exclude: [...options.exclude] }),
  };

  const nextManifest: EnvironmentManifest = {
    ...manifest,
    packages: { ...manifest.packages, [result.package]: selectionEntry },
    targets: Object.keys(manifest.targets).length === 0
      ? { claude: { enabled: true } }
      : manifest.targets,
  };

  const entry: LockEntry = {
    source: source.canonical,
    cloneUrl: source.cloneUrl,
    range: result.range,
    version: fetched.version,
    commit: fetched.commit,
    ref: fetched.ref,
    manifestHash: fetched.manifestHash,
    treeHash: fetched.treeHash,
    selection: selection.selected,
    files: await inventory(installedDir, selection.selected),
  };
  const nextLock: Lock = {
    ...lock,
    packages: { ...lock.packages, [result.package]: entry },
  };

  await writeEnvironment(context, nextManifest, nextLock);
  return result;
}

export interface FrozenInstallResult {
  readonly packages: Array<{ readonly name: string; readonly version: string; readonly commit: string | null }>;
  readonly dryRun: boolean;
}

/**
 * Reproduce every locked package exactly (`titw install --frozen`).
 *
 * The lock is the input: each entry is fetched at its pinned commit and must
 * hash to the locked `treeHash`/`manifestHash`. Nothing is resolved from a
 * range and neither `titw.yaml` nor `titw.lock` is rewritten — copying both
 * files to another machine and running this reproduces the same bytes
 * (handoff §18/§19).
 */
export async function installFrozen(
  options: CommandOptions & { readonly dryRun?: boolean | undefined },
): Promise<FrozenInstallResult> {
  const context = contextFor(options);
  const { manifest, lock, existed } = await readEnvironment(context);
  if (!existed) {
    throw new TitwError('E_NO_ENVIRONMENT', `no environment at ${context.env.manifest}`);
  }

  const names = Object.keys(manifest.packages).sort();
  const packages: FrozenInstallResult['packages'] = [];
  for (const name of names) {
    const entry = lock.packages[name];
    if (entry === undefined) {
      throw new TitwError('E_LOCK_MISSING', `${name} is in titw.yaml but not in titw.lock`, [
        'a frozen install never rewrites the lock; run "titw install <source>" to lock it first',
      ]);
    }
    const source = parseSource(entry.source, { baseDir: context.cwd });
    if (entry.commit === null) {
      throw new TitwError('E_FROZEN_UNSUPPORTED', `${name} is a path: source and cannot be frozen`);
    }
    const fetched = await fetchPackage({
      source,
      range: entry.range,
      cacheDir: context.layout.cacheDir,
      commit: entry.commit,
    });
    if (fetched.treeHash !== entry.treeHash || fetched.manifestHash !== entry.manifestHash) {
      throw new TitwError(
        'E_FROZEN_CHANGED',
        `${name}@${entry.version} at ${entry.commit.slice(0, 7)} does not match titw.lock`,
        [`locked tree ${entry.treeHash}`, `fetched tree ${fetched.treeHash}`],
      );
    }
    if (options.dryRun !== true) {
      const installedDir = installedPackageDir(context.layout, name, entry.version);
      await stageInstalledTree(fetched.dir, installedDir);
    }
    packages.push({ name, version: entry.version, commit: entry.commit });
  }
  return { packages, dryRun: options.dryRun === true };
}

/**
 * Replace an installed tree via stage-then-rename: copy into a sibling temp
 * directory first so a mid-copy crash never leaves a partial tree the lock
 * still names.
 */
async function stageInstalledTree(from: string, installedDir: string): Promise<void> {
  const staged = `${installedDir}.staging-${process.pid}`;
  await rmTreeForce(staged);
  try {
    await copyTree(from, staged);
    await rmTreeForce(installedDir);
    await fs.rename(staged, installedDir);
  } finally {
    await rmTreeForce(staged);
  }
}

/** Hash inventory of the selected files, keyed by package-relative path. */
export async function inventory(
  root: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => [file, await hashFile(path.join(root, ...file.split('/')))] as const),
  );
  return Object.fromEntries(entries);
}
