import { TitwError } from '../core/errors.js';
import { pathExists, rmTreeForce } from '../core/fsx.js';
import type { EnvironmentManifest, Lock } from '../core/manifest.js';
import { installedPackageDir } from '../materialize/layout.js';
import { contextFor, readEnvironment, writeEnvironment, type CommandOptions } from './context.js';
import { sync, type SyncResult } from './sync.js';

export interface UninstallOptions extends CommandOptions {
  readonly package: string;
  readonly dryRun?: boolean | undefined;
}

export interface UninstallResult {
  readonly package: string;
  readonly version: string;
  readonly removedInstalledDir: string | null;
  readonly dryRun: boolean;
  /** Result of the de-projecting sync; `null` on dry runs. */
  readonly sync: SyncResult | null;
}

/**
 * Remove a package from the environment: manifest entry, lock entry, and
 * installed tree — then sync so the projection stops carrying its files.
 *
 * The cache clone is left for `titw gc`, so a reinstall stays cheap.
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const context = contextFor(options);
  const { manifest, lock, existed } = await readEnvironment(context);
  if (!existed) {
    throw new TitwError('E_NO_ENVIRONMENT', `no environment at ${context.env.manifest}`);
  }
  const entry = lock.packages[options.package];
  const selected = manifest.packages[options.package];
  if (entry === undefined && selected === undefined) {
    throw new TitwError('E_NOT_INSTALLED', `${options.package} is not installed`);
  }

  const version = entry?.version ?? '(unlocked)';
  const installedDir =
    entry === undefined ? null : installedPackageDir(context.layout, options.package, entry.version);

  if (options.dryRun === true) {
    return { package: options.package, version, removedInstalledDir: installedDir, dryRun: true, sync: null };
  }

  const nextPackages = { ...manifest.packages };
  delete nextPackages[options.package];
  const nextManifest: EnvironmentManifest = { ...manifest, packages: nextPackages };
  const nextLockPackages = { ...lock.packages };
  delete nextLockPackages[options.package];
  const nextLock: Lock = { ...lock, packages: nextLockPackages };
  await writeEnvironment(context, nextManifest, nextLock);

  if (installedDir !== null && (await pathExists(installedDir))) {
    await rmTreeForce(installedDir);
  }

  const synced = await sync({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.processEnv === undefined ? {} : { processEnv: options.processEnv }),
  });
  return {
    package: options.package,
    version,
    removedInstalledDir: installedDir,
    dryRun: false,
    sync: synced,
  };
}
