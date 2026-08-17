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
  readPins,
  recordProposals,
  swapReceipts,
  writePins,
  writeReceipt,
  type Drift,
  type Pin,
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
  /**
   * Drop every recorded pin for every synced target before resolving drift,
   * so a previously-kept path is no longer protected and this sync's fresh
   * build is free to reclaim it. The escape hatch out of a `keep`/`propose`
   * decision (CLI: `--clear-pins`).
   */
  readonly clearPins?: boolean | undefined;
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
  /**
   * Previously-kept paths whose pin was silently re-applied this sync: no
   * further local edit, and upstream's build for that path is unchanged
   * since the pin was made. Disjoint from `kept`, which is only paths
   * decided (or re-decided) *this* sync — see `resolveModifiedDrift`.
   */
  readonly pinned: string[];
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
  const clearPins = options.clearPins === true;
  const targets: SyncTargetResult[] = [];

  try {
    for (const id of enabledTargets(manifest)) {
      targets.push(
        await syncTarget({
          id,
          generation,
          stageRoot,
          dryRun,
          context,
          packages: resolved,
          prompt,
          io,
          clearPins,
        }),
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
  clearPins: boolean;
}): Promise<SyncTargetResult> {
  const { id, generation, stageRoot, dryRun, context, packages, prompt, io, clearPins } = args;
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
    clearPins,
    io,
    activeDir: layout.active,
    stageDir,
    receiptsDir: context.env.receiptsDir,
    target: id,
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
      pinned: resolution.pinned,
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
    pinned: resolution.pinned,
    proposed,
  };
}

/**
 * Resolve every path that needs a decision before the stage is activated:
 * paths freshly flagged as drift, plus any previously-pinned path whose
 * upstream baseline has moved since the pin was made.
 *
 * Choosing `keep` or `propose` writes a receipt entry for the kept (local)
 * hash, so the very next `detectDrift` no longer sees that path as modified
 * — "no drift" and "no local divergence" become indistinguishable once the
 * receipt matches the active file. Left there, that path would fall back
 * into the ordinary build-and-activate path with nothing to stop the fresh
 * upstream build from silently overwriting it — the user's answer would
 * expire after exactly one sync. A pin is what makes `keep` durable: a
 * `{path, hash, upstreamHash}` record (`materialize/receipt.ts`) checked on
 * every later sync independently of `drift.modified`.
 *
 * A pin is honored (the active file copied back over the stage, silently,
 * no prompt) when both hold: the active file still matches `hash` (no
 * further local edit — if it doesn't, the path is back in `drift.modified`
 * and this function's ordinary prompt-or-replace handling owns it instead),
 * and this sync's fresh build for that path still matches `upstreamHash`
 * (upstream hasn't changed since the pin was made). Pins are honored even
 * non-interactively: a pin is a decision the user already made, not a
 * prompt being skipped.
 *
 * A pin whose fresh-build hash no longer matches `upstreamHash` is stale:
 * upstream moved since the user chose to keep this file, so silently
 * re-honoring it would mask that change forever — exactly the "permanent
 * blindfold" a pin must not become. Interactively, it is folded into this
 * sync's prompt set (alongside genuinely new drift) with a note pointing
 * out why it's being asked again. Non-interactively there is no one to ask,
 * so it falls back to the same default as any other non-interactive path —
 * replace — and the stale pin is dropped rather than left to be flagged as
 * stale forever after.
 *
 * A dry run touches no pin state at all: nothing it decides survives the
 * caller's `rmTreeForce(stageRoot)`, so reading or writing pins would only
 * be discarded work — matching why it never prompts either.
 */
async function resolveModifiedDrift(args: {
  drift: Drift | null;
  dryRun: boolean;
  prompt: boolean;
  clearPins: boolean;
  io: DriftPromptIO;
  activeDir: string;
  stageDir: string;
  receiptsDir: string;
  target: string;
}): Promise<{ kept: string[]; pinned: string[]; proposed: string[] }> {
  if (args.dryRun) return { kept: [], pinned: [], proposed: [] };

  const modified = args.drift?.modified ?? [];
  const modifiedSet = new Set(modified);
  const existingPins = await readPins(args.receiptsDir, args.target);
  const hadPins = existingPins.pins.length > 0;
  const candidates = args.clearPins ? [] : existingPins.pins;

  // Classify every recorded pin: still-valid ones are honored immediately
  // (regardless of interactivity); stale-by-upstream ones join this sync's
  // prompt set below. A pin whose path is back in `modified` was edited
  // again locally since the pin, so it is left out of `nextPins` here and
  // handled entirely by the ordinary resolution loop below instead.
  const pinned: string[] = [];
  const staleByUpstream: string[] = [];
  const nextPins = new Map<string, Pin>();
  for (const pin of candidates) {
    if (modifiedSet.has(pin.path)) continue;
    const activeAbs = path.join(args.activeDir, ...pin.path.split('/'));
    const stageAbs = path.join(args.stageDir, ...pin.path.split('/'));
    if (!(await pathExists(activeAbs)) || !(await pathExists(stageAbs))) {
      nextPins.set(pin.path, pin); // path not part of this sync either way; carry the pin forward as-is
      continue;
    }
    if ((await hashFile(activeAbs)) !== pin.hash) {
      nextPins.set(pin.path, pin); // shouldn't happen (detectDrift would have flagged it); don't fight it
      continue;
    }
    if ((await hashFile(stageAbs)) === pin.upstreamHash) {
      await copyFile(activeAbs, stageAbs);
      pinned.push(pin.path);
      nextPins.set(pin.path, pin);
    } else {
      staleByUpstream.push(pin.path); // resolved below; re-pinned or dropped depending on this sync's choice
    }
  }

  const toResolve = [...modified, ...staleByUpstream];
  if (toResolve.length === 0 || !args.prompt) {
    await persistPins(args, hadPins, nextPins);
    return { kept: [], pinned, proposed: [] };
  }

  if (staleByUpstream.length > 0) {
    args.io.output.write(
      `note: upstream changed for ${staleByUpstream.length} pinned file(s) since you kept them` +
        ` — asking again: ${staleByUpstream.join(', ')}\n`,
    );
  }

  const choices = await promptDriftChoices(toResolve, args.io);
  const kept: string[] = [];
  const proposed: string[] = [];

  for (const rel of toResolve) {
    const choice = choices.get(rel) ?? 'replace';
    if (choice === 'replace') continue; // left out of nextPins: nothing local left to protect

    const activeAbs = path.join(args.activeDir, ...rel.split('/'));
    const stageAbs = path.join(args.stageDir, ...rel.split('/'));
    const upstreamHash = await hashFile(stageAbs); // read before the copy below overwrites it
    await copyFile(activeAbs, stageAbs);
    kept.push(rel);
    if (choice === 'propose') proposed.push(rel);
    nextPins.set(rel, { path: rel, hash: await hashFile(activeAbs), upstreamHash });
  }

  await persistPins(args, hadPins, nextPins);
  return { kept, pinned, proposed };
}

/** Write a target's next pin state, but only touch disk when there is something to record or clear. */
async function persistPins(
  args: { receiptsDir: string; target: string },
  hadPins: boolean,
  nextPins: ReadonlyMap<string, Pin>,
): Promise<void> {
  if (nextPins.size === 0 && !hadPins) return; // never create pins.json for a target that has never used it
  await writePins(args.receiptsDir, args.target, [...nextPins.values()]);
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
    pinned: [],
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
