import path from 'node:path';
import {
  ENVIRONMENT_MANIFEST_FILENAME,
  LOCK_FILENAME,
} from '../core/manifest.js';

/** Absolute paths of the `$TITW_HOME` tree (handoff §13). */
export interface Layout {
  readonly home: string;
  /** Editable packages / registrations. Reserved by the layout; unused in the v1 slice. */
  readonly localDir: string;
  /** Immutable, read-only installed package versions. */
  readonly installedDir: string;
  /** Fetched package objects (git checkouts). */
  readonly cacheDir: string;
  readonly environmentsDir: string;
  readonly targetsDir: string;
}

/** Per-environment paths under `$TITW_HOME/environments/<name>`. */
export interface EnvironmentLayout {
  readonly name: string;
  readonly root: string;
  readonly manifest: string;
  readonly lock: string;
  readonly receiptsDir: string;
  readonly generationsDir: string;
}

/** Per-target paths under `$TITW_HOME/targets/<target>`. */
export interface TargetLayout {
  readonly id: string;
  readonly root: string;
  readonly active: string;
  readonly previous: string;
}

/** Build the `$TITW_HOME` layout for a data root. */
export function layoutFor(home: string): Layout {
  return {
    home,
    localDir: path.join(home, 'packages', 'local'),
    installedDir: path.join(home, 'packages', 'installed'),
    cacheDir: path.join(home, 'cache'),
    environmentsDir: path.join(home, 'environments'),
    targetsDir: path.join(home, 'targets'),
  };
}

/** Paths for one environment. */
export function environmentLayout(layout: Layout, name: string): EnvironmentLayout {
  const root = path.join(layout.environmentsDir, name);
  return {
    name,
    root,
    manifest: path.join(root, ENVIRONMENT_MANIFEST_FILENAME),
    lock: path.join(root, LOCK_FILENAME),
    receiptsDir: path.join(root, 'receipts'),
    generationsDir: path.join(root, 'generations'),
  };
}

/** Paths for one target's active/previous projections. */
export function targetLayout(layout: Layout, id: string): TargetLayout {
  const root = path.join(layout.targetsDir, id);
  return {
    id,
    root,
    active: path.join(root, 'active'),
    previous: path.join(root, 'previous'),
  };
}

/**
 * Directory holding one installed package version.
 *
 * The scope separator is folded to `+` so a scoped name stays a single
 * directory level and cannot be confused with a nested package.
 */
export function installedPackageDir(layout: Layout, name: string, version: string): string {
  return path.join(layout.installedDir, encodePackageName(name), version);
}

/** Filesystem-safe encoding of a package name. */
export function encodePackageName(name: string): string {
  return name.replace(/\//g, '+');
}
