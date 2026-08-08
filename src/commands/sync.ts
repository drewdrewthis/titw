import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../core/errors.js';
import { comparePaths, ensureDir, pathExists, rmTreeForce, walkFiles } from '../core/fsx.js';
import { hashFile, hashTree } from '../core/hash.js';
import {
  PACKAGE_MANIFEST_FILENAME,
  loadPackageManifest,
  type Lock,
  type LockEntry,
  type PackageSelection,
} from '../core/manifest.js';
import { selectFiles } from '../core/select.js';
import {
  activateGeneration,
  newGenerationId,
  pruneStaging,
  rollbackTarget,
} from '../materialize/generation.js';
import { installedPackageDir, targetLayout, type Layout } from '../materialize/layout.js';
import {
  buildReceipt,
  currentReceiptFile,
  detectDrift,
  readCurrentReceipt,
  swapReceipts,
  writeReceipt,
  type Drift,
  type ReceiptPackage,
} from '../materialize/receipt.js';
import { CATALOG_FILENAME } from '../targets/claude/index.js';
import { targetById } from '../targets/registry.js';
import type { TargetPackageInput } from '../targets/types.js';
import {
  contextFor,
  enabledTargets,
  readEnvironment,
  writeEnvironment,
  type CommandContext,
  type CommandOptions,
} from './context.js';
import { inventory } from './install.js';

export interface SyncOptions extends CommandOptions {
  readonly dryRun?: boolean | undefined;
  /** Fixed generation id, for reproducible tests. */
  readonly generation?: string | undefined;
}

export interface SyncTargetResult {
  readonly id: string;
  readonly root: string;
  readonly generation: string;
  readonly paths: number;
  readonly receipt: string | null;
  readonly activated: boolean;
  readonly warnings: string[];
  /** Drift found in the projection being replaced; reported, never deleted. */
  readonly drift: Drift | null;
}

export interface SyncResult {
  readonly environment: string;
  readonly generation: string;
  readonly dryRun: boolean;
  readonly packages: Array<{
    readonly name: string;
    readonly version: string;
    readonly commit: string | null;
    readonly source: string;
    readonly selected: number;
  }>;
  readonly targets: SyncTargetResult[];
}

interface ResolvedPackage {
  readonly name: string;
  readonly entry: LockEntry;
  readonly rootDir: string;
  readonly input: TargetPackageInput;
}

/**
 * Validate, stage, and atomically activate every enabled target projection.
 *
 * Implements handoff §13 steps 1-9. Selection is recomputed from `titw.yaml`
 * on every run — the manifest is authoritative for what is selected, the lock
 * for which bytes those selectors resolve against.
 */
export async function sync(options: SyncOptions = {}): Promise<SyncResult> {
  const context = contextFor(options);
  const { manifest, lock, existed } = await readEnvironment(context);
  if (!existed) {
    throw new TitwError('E_NO_ENVIRONMENT', `no environment at ${context.env.manifest}`, [
      'run "titw install <source>" first',
    ]);
  }

  const resolved = await resolvePackages(context.layout, manifest.packages, lock);
  const generation = options.generation ?? newGenerationId();
  const stageRoot = path.join(context.env.generationsDir, generation);
  const dryRun = options.dryRun === true;
  const targets: SyncTargetResult[] = [];

  try {
    for (const id of enabledTargets(manifest)) {
      targets.push(await syncTarget({ id, generation, stageRoot, dryRun, context, packages: resolved }));
    }
  } finally {
    await rmTreeForce(stageRoot);
  }

  if (!dryRun) {
    await writeEnvironment(context, manifest, await relockSelections(lock, resolved));
  }

  return {
    environment: context.env.name,
    generation,
    dryRun,
    packages: resolved.map((pkg) => ({
      name: pkg.name,
      version: pkg.entry.version,
      commit: pkg.entry.commit,
      source: pkg.entry.source,
      selected: pkg.input.files.length,
    })),
    targets,
  };
}

async function syncTarget(args: {
  id: string;
  generation: string;
  stageRoot: string;
  dryRun: boolean;
  context: CommandContext;
  packages: readonly ResolvedPackage[];
}): Promise<SyncTargetResult> {
  const { id, generation, stageRoot, dryRun, context, packages } = args;
  const layout = targetLayout(context.layout, id);
  await pruneStaging(layout);

  const previousReceipt = await readCurrentReceipt(context.env.receiptsDir, id);
  const drift =
    previousReceipt !== null && (await pathExists(layout.active))
      ? await detectDrift(layout.active, previousReceipt)
      : null;

  const stageDir = path.join(stageRoot, id);
  await ensureDir(stageDir);
  const built = await targetById(id).build({
    outDir: stageDir,
    packages: packages.map((pkg) => pkg.input),
  });
  await validateStaged(stageDir, built.paths);

  const receiptPackages: ReceiptPackage[] = packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.entry.version,
    commit: pkg.entry.commit,
    source: pkg.entry.source,
  }));
  const receipt = await buildReceipt({
    root: stageDir,
    environment: context.env.name,
    target: id,
    generation,
    packages: receiptPackages,
  });

  if (dryRun) {
    return {
      id,
      root: layout.active,
      generation,
      paths: receipt.paths.length,
      receipt: null,
      activated: false,
      warnings: built.warnings,
      drift,
    };
  }

  await activateGeneration(stageDir, layout, generation);
  const receiptFile = await writeReceipt(context.env.receiptsDir, receipt);

  return {
    id,
    root: layout.active,
    generation,
    paths: receipt.paths.length,
    receipt: receiptFile,
    activated: true,
    warnings: built.warnings,
    drift,
  };
}

/**
 * Re-activate a target's previous generation.
 *
 * The receipt pair swaps with the directory pair, so the restored tree keeps
 * the receipt that was written when it was originally staged.
 */
export async function rollback(
  options: CommandOptions & { target?: string | undefined } = {},
): Promise<SyncTargetResult> {
  const context = contextFor(options);
  const { manifest } = await readEnvironment(context);
  const id = options.target ?? enabledTargets(manifest)[0] ?? 'claude';
  const layout = targetLayout(context.layout, id);

  await rollbackTarget(layout);
  await swapReceipts(context.env.receiptsDir, id);
  const restored = await readCurrentReceipt(context.env.receiptsDir, id);

  return {
    id,
    root: layout.active,
    generation: restored?.generation ?? '(unreceipted)',
    paths: restored?.paths.length ?? 0,
    receipt: restored === null ? null : currentReceiptFile(context.env.receiptsDir, id),
    activated: true,
    warnings: [],
    drift: null,
  };
}

/**
 * Load every locked package, verify its installed bytes, and recompute its
 * selection.
 *
 * @throws TitwError when a package is unlocked, uninstalled, or has drifted
 * from the hashes recorded at install time.
 */
async function resolvePackages(
  layout: Layout,
  selections: Record<string, PackageSelection>,
  lock: Lock,
): Promise<ResolvedPackage[]> {
  const resolved: ResolvedPackage[] = [];

  for (const name of Object.keys(selections).sort(comparePaths)) {
    const selection = selections[name];
    const entry = lock.packages[name];
    if (selection === undefined) continue;
    if (entry === undefined) {
      throw new TitwError('E_LOCK_MISSING', `${name} is in titw.yaml but not in titw.lock`, [
        `run "titw install ${name}" to lock it`,
      ]);
    }

    const rootDir = installedPackageDir(layout, name, entry.version);
    if (!(await pathExists(path.join(rootDir, PACKAGE_MANIFEST_FILENAME)))) {
      throw new TitwError('E_NOT_INSTALLED', `${name}@${entry.version} is not installed`, [
        `expected ${rootDir}`,
      ]);
    }

    const packageManifest = await loadPackageManifest(path.join(rootDir, PACKAGE_MANIFEST_FILENAME));
    const files = await walkFiles(rootDir);
    const hashes = await Promise.all(
      files.map(
        async (file) => [file, await hashFile(path.join(rootDir, ...file.split('/')))] as const,
      ),
    );
    const treeHash = hashTree(hashes);
    if (treeHash !== entry.treeHash) {
      throw new TitwError(
        'E_HASH_MISMATCH',
        `installed copy of ${name}@${entry.version} does not match titw.lock`,
        [`expected ${entry.treeHash}`, `found    ${treeHash}`, `reinstall to repair: ${rootDir}`],
      );
    }

    const computed = selectFiles({
      files,
      exports: packageManifest.exports,
      include: selection.include,
      exclude: selection.exclude,
    });

    resolved.push({
      name,
      entry,
      rootDir,
      input: {
        name,
        version: entry.version,
        commit: entry.commit,
        source: entry.source,
        ...(packageManifest.repository === undefined
          ? {}
          : { repository: packageManifest.repository }),
        rootDir,
        files: computed.selected,
      },
    });
  }

  return resolved;
}

/** Refresh the lock's selection and file inventory from what was just synced. */
async function relockSelections(lock: Lock, resolved: readonly ResolvedPackage[]): Promise<Lock> {
  const packages: Record<string, LockEntry> = { ...lock.packages };
  for (const pkg of resolved) {
    packages[pkg.name] = {
      ...pkg.entry,
      selection: [...pkg.input.files],
      files: await inventory(pkg.rootDir, pkg.input.files),
    };
  }
  return { ...lock, packages };
}

/**
 * Cross-check a staged projection against what the target claims it wrote.
 *
 * A target reporting a path it did not write would leave that path out of the
 * receipt, and TITW only ever removes receipted paths.
 */
async function validateStaged(stageDir: string, claimed: readonly string[]): Promise<void> {
  const onDisk = await walkFiles(stageDir);
  const claimedSet = new Set(claimed);
  const onDiskSet = new Set(onDisk);
  const missing = claimed.filter((p) => !onDiskSet.has(p));
  const extra = onDisk.filter((p) => !claimedSet.has(p));
  if (missing.length > 0 || extra.length > 0) {
    throw new TitwError('E_TARGET_INVALID', 'staged projection does not match the target manifest', [
      ...missing.map((p) => `declared but absent: ${p}`),
      ...extra.map((p) => `written but undeclared: ${p}`),
    ]);
  }

  const catalog = path.join(stageDir, CATALOG_FILENAME);
  if (await pathExists(catalog)) {
    try {
      JSON.parse(await fs.readFile(catalog, 'utf8'));
    } catch (error) {
      throw new TitwError('E_TARGET_INVALID', `${CATALOG_FILENAME} is not valid JSON`, [
        (error as Error).message,
      ]);
    }
  }
}
