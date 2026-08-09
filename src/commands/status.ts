import path from 'node:path';
import { comparePaths, pathExists } from '../core/fsx.js';
import { PACKAGE_MANIFEST_FILENAME } from '../core/manifest.js';
import { installedPackageDir, targetLayout } from '../materialize/layout.js';
import { readCurrentReceipt } from '../materialize/receipt.js';
import { contextFor, enabledTargets, readEnvironment, type CommandOptions } from './context.js';

export interface StatusPackage {
  readonly name: string;
  readonly source: string;
  readonly range: string;
  readonly version: string;
  readonly commit: string | null;
  readonly selected: number;
  readonly installed: boolean;
  readonly installedDir: string;
}

export interface StatusTarget {
  readonly id: string;
  readonly root: string;
  readonly active: boolean;
  readonly previous: boolean;
  readonly generation: string | null;
  readonly paths: number;
  readonly corpusRoot: string;
}

export interface StatusResult {
  readonly home: string;
  readonly environment: string;
  readonly manifest: string;
  readonly lock: string;
  readonly initialized: boolean;
  readonly packages: StatusPackage[];
  readonly targets: StatusTarget[];
}

/** Report the environment, its locked packages, and each target's active projection. */
export async function status(options: CommandOptions = {}): Promise<StatusResult> {
  const context = contextFor(options);
  const { manifest, lock, existed } = await readEnvironment(context);

  const packages: StatusPackage[] = [];
  for (const name of Object.keys(manifest.packages).sort(comparePaths)) {
    const selection = manifest.packages[name];
    const entry = lock.packages[name];
    if (selection === undefined) continue;
    const version = entry?.version ?? '(unlocked)';
    const dir = entry === undefined ? '' : installedPackageDir(context.layout, name, version);
    packages.push({
      name,
      source: selection.source,
      range: selection.version ?? '*',
      version,
      commit: entry?.commit ?? null,
      selected: entry?.selection.length ?? 0,
      installed: dir !== '' && (await pathExists(path.join(dir, PACKAGE_MANIFEST_FILENAME))),
      installedDir: dir,
    });
  }

  const targets: StatusTarget[] = [];
  for (const id of enabledTargets(manifest)) {
    const layout = targetLayout(context.layout, id);
    const receipt = await readCurrentReceipt(context.env.receiptsDir, id);
    targets.push({
      id,
      root: layout.active,
      active: await pathExists(layout.active),
      previous: await pathExists(layout.previous),
      generation: receipt?.generation ?? null,
      paths: receipt?.paths.length ?? 0,
      corpusRoot: path.join(layout.active, 'corpus'),
    });
  }

  return {
    home: context.layout.home,
    environment: context.env.name,
    manifest: context.env.manifest,
    lock: context.env.lock,
    initialized: existed,
    packages,
    targets,
  };
}
