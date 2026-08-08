import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../core/errors.js';
import { ensureDir, pathExists, rmTreeForce } from '../core/fsx.js';
import type { TargetLayout } from './layout.js';

/** Sortable, collision-free generation id: `<utc timestamp>-<counter>`. */
export function newGenerationId(now: Date = new Date(), suffix = ''): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tail = suffix === '' ? Math.random().toString(36).slice(2, 8) : suffix;
  return `${stamp}-${tail}`;
}

/**
 * Swap a staged generation into place as the target's active projection.
 *
 * Every step is a `rename` on one filesystem — no symlinks (handoff §13, v1
 * invariant 8) and no partially-written active tree. The previous active
 * projection is retained as `previous/` so {@link rollbackTarget} can undo the
 * swap; nothing outside `targets/<id>/` is touched.
 *
 * @param stagedDir directory holding the validated new projection.
 * @param target the target's active/previous paths.
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

  const hadActive = await pathExists(target.active);
  if (hadActive) await fs.rename(target.active, retired);
  await fs.rename(incoming, target.active);

  if (hadActive) {
    await rmTreeForce(target.previous);
    await fs.rename(retired, target.previous);
  }
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

/** Delete every staging directory left behind by an interrupted activation. */
export async function pruneStaging(target: TargetLayout): Promise<void> {
  if (!(await pathExists(target.root))) return;
  for (const entry of await fs.readdir(target.root)) {
    if (entry.startsWith('.next-') || entry.startsWith('.prev-') || entry.startsWith('.rollback-')) {
      await rmTreeForce(path.join(target.root, entry));
    }
  }
}
