import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, rmTreeForce } from '../core/fsx.js';
import { parseSource } from '../core/source.js';
import { encodePackageName } from '../materialize/layout.js';
import { contextFor, readEnvironment, type CommandOptions } from './context.js';

export interface GcOptions extends CommandOptions {
  readonly dryRun?: boolean | undefined;
}

export interface GcResult {
  /** Installed package-version directories removed (or would be, on a dry run). */
  readonly installed: string[];
  /** Cache clones removed (or would be, on a dry run). */
  readonly cache: string[];
  readonly dryRun: boolean;
}

/**
 * Delete installed trees and cache clones no lock entry references.
 *
 * `titw uninstall` leaves the cache warm on purpose; this is the explicit
 * reclaim step. Nothing under `targets/` is ever touched — projections are
 * owned by sync/rollback and their receipts.
 */
export async function gc(options: GcOptions = {}): Promise<GcResult> {
  const context = contextFor(options);
  const { lock } = await readEnvironment(context);
  const dryRun = options.dryRun === true;

  const liveInstalled = new Set<string>();
  const liveCache = new Set<string>();
  for (const [name, entry] of Object.entries(lock.packages)) {
    liveInstalled.add(`${encodePackageName(name)}/${entry.version}`);
    const source = parseSource(entry.source, { baseDir: context.cwd });
    if (source.cloneUrl !== null) liveCache.add(source.cacheKey);
  }

  const installed: string[] = [];
  if (await pathExists(context.layout.installedDir)) {
    for (const pkgDir of await fs.readdir(context.layout.installedDir)) {
      const abs = path.join(context.layout.installedDir, pkgDir);
      if (!(await fs.stat(abs)).isDirectory()) continue;
      for (const version of await fs.readdir(abs)) {
        if (liveInstalled.has(`${pkgDir}/${version}`)) continue;
        installed.push(path.join(abs, version));
      }
    }
  }

  const cache: string[] = [];
  if (await pathExists(context.layout.cacheDir)) {
    for (const entry of await fs.readdir(context.layout.cacheDir)) {
      if (liveCache.has(entry)) continue;
      cache.push(path.join(context.layout.cacheDir, entry));
    }
  }

  if (!dryRun) {
    for (const target of [...installed, ...cache]) await rmTreeForce(target);
    // Drop now-empty per-package parents so `installed/` doesn't accumulate husks.
    if (await pathExists(context.layout.installedDir)) {
      for (const pkgDir of await fs.readdir(context.layout.installedDir)) {
        const abs = path.join(context.layout.installedDir, pkgDir);
        if ((await fs.stat(abs)).isDirectory() && (await fs.readdir(abs)).length === 0) {
          await fs.rmdir(abs);
        }
      }
    }
  }

  return { installed, cache, dryRun };
}
