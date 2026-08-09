import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../core/errors.js';
import { ensureDir, pathExists, rmTreeForce, writeFile } from '../core/fsx.js';
import type { TargetLayout } from './layout.js';

/** Sortable, collision-free generation id: `<utc timestamp>-<counter>`. */
export function newGenerationId(now: Date = new Date(), suffix = ''): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tail = suffix === '' ? Math.random().toString(36).slice(2, 8) : suffix;
  return `${stamp}-${tail}`;
}

/** Journal written (atomically) before an activation's renames begin. */
const SWAP_JOURNAL = '.swap.json';

interface SwapJournal {
  readonly generation: string;
}

function journalFile(target: TargetLayout): string {
  return path.join(target.root, SWAP_JOURNAL);
}

/**
 * Swap a staged generation into place as the target's active projection.
 *
 * The swap is several renames, so a crash can interrupt it. A journal is
 * written (atomically) before the first rename and removed after the last;
 * {@link recoverInterruptedSwap} reads it on the next run and puts the last
 * good tree back before anything is pruned — the previous generation is never
 * lost to a crash.
 */
export async function activateGeneration(
  stagedDir: string,
  target: TargetLayout,
  generation: string,
): Promise<void> {
  await ensureDir(target.root);
  const incoming = path.join(target.root, `.next-${generation}`);
  const retired = path.join(target.root, `.prev-${generation}`);

  await rmTreeForce(incoming);
  await fs.rename(stagedDir, incoming);

  const journal: SwapJournal = { generation };
  await writeFile(journalFile(target), `${JSON.stringify(journal)}\n`);

  const hadActive = await pathExists(target.active);
  if (hadActive) await fs.rename(target.active, retired);
  await fs.rename(incoming, target.active);

  if (hadActive) {
    await rmTreeForce(target.previous);
    await fs.rename(retired, target.previous);
  }
  await fs.rm(journalFile(target), { force: true });
}

/**
 * Complete or unwind an activation that crashed mid-swap.
 *
 * Reads the journal left by {@link activateGeneration}: a surviving
 * `.prev-<gen>` with no `active/` means the crash hit between the demote and
 * promote renames — the retired tree is restored as `active/`. Only after
 * recovery is the journal cleared.
 */
export async function recoverInterruptedSwap(target: TargetLayout): Promise<void> {
  const file = journalFile(target);
  if (!(await pathExists(file))) return;
  const journal = JSON.parse(await fs.readFile(file, 'utf8')) as SwapJournal;
  const incoming = path.join(target.root, `.next-${journal.generation}`);
  const retired = path.join(target.root, `.prev-${journal.generation}`);

  if (!(await pathExists(target.active))) {
    // Crashed between demoting active and promoting the incoming tree.
    if (await pathExists(incoming)) await fs.rename(incoming, target.active);
    else if (await pathExists(retired)) await fs.rename(retired, target.active);
  }
  if ((await pathExists(retired)) && !(await pathExists(target.previous))) {
    // Crashed before the retired tree was promoted to previous/.
    await fs.rename(retired, target.previous);
  }
  await fs.rm(file, { force: true });
}

/**
 * Re-activate the previous projection, demoting the current one.
 *
 * Rollback is symmetric: the tree being rolled back becomes the new
 * `previous/`, so a second rollback returns to where it started.
 */
export async function rollbackTarget(target: TargetLayout): Promise<void> {
  if (!(await pathExists(target.previous))) {
    throw new TitwError(
      'E_NO_PREVIOUS',
      `target "${target.id}" has no previous generation to roll back to`,
    );
  }
  const parked = path.join(target.root, `.rollback-${Date.now()}`);
  await rmTreeForce(parked);

  const hadActive = await pathExists(target.active);
  if (hadActive) await fs.rename(target.active, parked);
  await fs.rename(target.previous, target.active);
  if (hadActive) await fs.rename(parked, target.previous);
}

/**
 * Delete staging leftovers from interrupted activations.
 *
 * Always runs after {@link recoverInterruptedSwap}: anything still matching a
 * staging prefix at that point is unreferenced by the journal or a receipt
 * and safe to delete.
 */
export async function pruneStaging(target: TargetLayout): Promise<void> {
  if (!(await pathExists(target.root))) return;
  await recoverInterruptedSwap(target);
  for (const entry of await fs.readdir(target.root)) {
    if (entry.startsWith('.next-') || entry.startsWith('.prev-') || entry.startsWith('.rollback-')) {
      await rmTreeForce(path.join(target.root, entry));
    }
  }
}
