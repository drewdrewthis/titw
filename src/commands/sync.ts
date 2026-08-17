import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../core/errors.js';
import { comparePaths, copyFile, ensureDir, pathExists, rmTreeForce, walkFiles } from '../core/fsx.js';
import { hashFile, hashTree } from '../core/hash.js';
import {
  PACKAGE_MANIFEST_FILENAME,
  loadPackageManifest,
  renderLock,
  type Lock,
  type LockEntry,
  type PackageSelection,
} from '../core/manifest.js';
import { selectFiles } from '../core/select.js';
import { promptDriftChoices, type DriftPromptIO } from './drift-prompt.js';
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
  recordProposals,
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
  writeLock,
  type CommandContext,
  type CommandOptions,
} from './context.js';
import { inventory } from './install.js';

/** A readable stream that may report TTY-ness, e.g. `process.stdin` or a test double. */
type PromptStdin = NodeJS.ReadableStream & { readonly isTTY?: boolean };

export interface SyncOptions extends CommandOptions {
  readonly dryRun?: boolean | undefined;
  /** Refuse to run if syncing would change `titw.lock`. */
  readonly locked?: boolean | undefined;
  /** Fixed generation id, for reproducible tests. */
  readonly generation?: string | undefined;
  /**
   * Prompt to resolve locally-modified paths instead of replacing them
   * unconditionally. Defaults to on only when `stdin` is a TTY; `false` (CLI:
   * `--no-interactive`) always replaces without prompting, and so does a
   * non-TTY `stdin` (CI/scripted use) even when this is left unset — matching
   * pre-existing behavior.
   */
  readonly interactive?: boolean | undefined;
  /** Stream the drift prompt reads from; default `process.stdin`. Test seam. */
  readonly stdin?: PromptStdin | undefined;
  /** Stream the drift prompt writes to; default `process.stdout`. Test seam. */
  readonly stdout?: NodeJS.WritableStream | undefined;
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
  /** Locally-modified paths whose edit was kept (replace declined) this sync. */
  readonly kept: string[];
  /** Where kept paths were recorded for upstream contribution, when any were proposed. */
  readonly proposed: { readonly paths: string[]; readonly file: string } | null;
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
  const stdin = options.stdin ?? process.stdin;
  const io: DriftPromptIO = { input: stdin, output: options.stdout ?? process.stdout };
  const prompt = options.interactive !== false && stdin.isTTY === true;
  const targets: SyncTargetResult[] = [];

  try {
    for (const id of enabledTargets(manifest)) {
      targets.push(
        await syncTarget({ id, generation, stageRoot, dryRun, context, packages: resolved, prompt, io }),
      );
    }
  } finally {
    await rmTreeForce(stageRoot);
  }

  if (!dryRun) {
    // Sync's contract is "read intent, write derived state" (D17): the lock is
    // rewritten (selection inventory refreshed, entries for packages no longer
    // in titw.yaml pruned) but the hand-edited titw.yaml is never touched.
    const nextLock = await relockSelections(lock, resolved);
    if (options.locked === true && renderLock(nextLock) !== renderLock(lock)) {
      throw new TitwError('E_LOCK_DRIFT', 'sync --locked: titw.lock would change', [
        'run "titw sync" without --locked to update it',
      ]);
    }
    await writeLock(context, nextLock);
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
  prompt: boolean;
  io: DriftPromptIO;
}): Promise<SyncTargetResult> {
  const { id, generation, stageRoot, dryRun, context, packages, prompt, io } = args;
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

  // Resolve every locally-modified path before the receipt is built from the
  // stage, so both the activated tree and the receipt hashed from it reflect
  // the user's choice rather than only the fresh build.
  const resolution = await resolveModifiedDrift({
    drift,
    dryRun,
    prompt,
    io,
    activeDir: layout.active,
    stageDir,
  });

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
      kept: resolution.kept,
      proposed: null,
    };
  }

  await activateGeneration(stageDir, layout, generation);
  const receiptFile = await writeReceipt(context.env.receiptsDir, receipt);
  const proposed =
    resolution.proposed.length === 0
      ? null
      : {
          paths: resolution.proposed,
          file: await recordProposals(context.env.receiptsDir, id, resolution.proposed),
        };

  return {
    id,
    root: layout.active,
    generation,
    paths: receipt.paths.length,
    receipt: receiptFile,
    activated: true,
    warnings: built.warnings,
    drift,
    kept: resolution.kept,
    proposed,
  };
}

/**
 * Resolve each locally-modified path against the user's choice, copying kept
 * edits from the active projection onto the freshly staged one so activation
 * does not clobber them.
 *
 * A dry run never prompts (nothing activates, so a prompt would have no
 * effect and could only hang a scripted `--dry-run`); a non-interactive run
 * (no TTY, or `interactive: false`) replaces every path silently — today's
 * behavior. Once a path is kept, its receipt entry is the kept (local) hash
 * (see `buildReceipt`'s call site), so it is no longer reported as drift —
 * the tradeoff is that a *later* sync with no further local edit will then
 * find no drift to resolve and silently reactivate the fresh upstream build,
 * since "no drift" and "no local divergence" are indistinguishable once the
 * receipt has been updated to match. Recording the kept hash is still the
 * only coherent choice: the receipt is hashed from whatever bytes are
 * actually in the stage, so deliberately writing a different (stale) hash
 * would desync the receipt from the tree it describes.
 */
async function resolveModifiedDrift(args: {
  drift: Drift | null;
  dryRun: boolean;
  prompt: boolean;
  io: DriftPromptIO;
  activeDir: string;
  stageDir: string;
}): Promise<{ kept: string[]; proposed: string[] }> {
  const modified = args.drift?.modified ?? [];
  if (args.dryRun || !args.prompt || modified.length === 0) {
    return { kept: [], proposed: [] };
  }

  const choices = await promptDriftChoices(modified, args.io);
  const kept: string[] = [];
  const proposed: string[] = [];

  for (const rel of modified) {
    const choice = choices.get(rel) ?? 'replace';
    if (choice === 'replace') continue;
    await copyFile(
      path.join(args.activeDir, ...rel.split('/')),
      path.join(args.stageDir, ...rel.split('/')),
    );
    kept.push(rel);
    if (choice === 'propose') proposed.push(rel);
  }

  return { kept, proposed };
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
    kept: [],
    proposed: null,
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

/**
 * Refresh the lock's selection and file inventory from what was just synced.
 *
 * Entries for packages no longer in `titw.yaml` are dropped: the manifest is
 * authoritative for membership, so an uninstalled package must not linger in
 * the lock as an orphan.
 */
async function relockSelections(lock: Lock, resolved: readonly ResolvedPackage[]): Promise<Lock> {
  const packages: Record<string, LockEntry> = {};
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
export async function validateStaged(stageDir: string, claimed: readonly string[]): Promise<void> {
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
