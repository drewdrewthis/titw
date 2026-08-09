import path from 'node:path';
import { satisfies } from 'semver';
import { comparePaths, pathExists } from '../core/fsx.js';
import { ensureRepo, publishedVersion, type Release } from '../core/fetch.js';
import { PACKAGE_MANIFEST_FILENAME, loadPackageManifest } from '../core/manifest.js';
import { parseSource } from '../core/source.js';
import { contextFor, readEnvironment, type CommandOptions } from './context.js';

export interface OutdatedRow {
  readonly name: string;
  readonly source: string;
  readonly range: string;
  /** Exact locked version. */
  readonly current: string;
  /** Newest release satisfying the declared range. */
  readonly wanted: string | null;
  /** Newest published release, range ignored. */
  readonly latest: string | null;
  readonly upToDate: boolean;
  /** Why `wanted`/`latest` are unknown, when they are. */
  readonly error?: string | undefined;
}

export interface OutdatedResult {
  readonly environment: string;
  readonly packages: OutdatedRow[];
}

/**
 * Report current / wanted / latest per package (handoff §11).
 *
 * This is the only inspection command that reaches the network, and it runs
 * only when invoked — never on an agent turn.
 */
export async function outdated(options: CommandOptions = {}): Promise<OutdatedResult> {
  const context = contextFor(options);
  const { manifest, lock } = await readEnvironment(context);
  const rows: OutdatedRow[] = [];

  for (const name of Object.keys(manifest.packages).sort(comparePaths)) {
    const selection = manifest.packages[name];
    const entry = lock.packages[name];
    if (selection === undefined || entry === undefined) continue;
    const range = entry.range;

    try {
      const source = parseSource(selection.source, { baseDir: context.cwd });
      // D19: a source publishes exactly one version — the manifest at HEAD.
      const release =
        source.kind === 'path'
          ? await pathVersion(source.dir)
          : await publishedVersion(await ensureRepo(source, context.layout.cacheDir));
      const latest = release?.version ?? null;
      const wanted = latest !== null && satisfies(latest, range) ? latest : null;
      rows.push({
        name,
        source: selection.source,
        range,
        current: entry.version,
        wanted,
        latest,
        upToDate: wanted === null || wanted === entry.version,
      });
    } catch (error) {
      rows.push({
        name,
        source: selection.source,
        range,
        current: entry.version,
        wanted: null,
        latest: null,
        upToDate: satisfies(entry.version, range),
        error: (error as Error).message,
      });
    }
  }

  return { environment: context.env.name, packages: rows };
}

/** A `path:` source publishes whatever its working tree declares. */
async function pathVersion(dir: string | null): Promise<Release | null> {
  if (dir === null) return null;
  const manifestPath = path.join(dir, PACKAGE_MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) return null;
  const manifest = await loadPackageManifest(manifestPath);
  return { version: manifest.version, ref: '(working tree)' };
}
