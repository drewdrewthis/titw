import { TitwError } from '../core/errors.js';
import { comparePaths } from '../core/fsx.js';
import { install } from './install.js';
import { contextFor, readEnvironment, type CommandOptions } from './context.js';

export interface UpdateOptions extends CommandOptions {
  /** Installed package name; omitted = every package in the environment. */
  readonly package?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface UpdateRow {
  readonly name: string;
  readonly from: string;
  /** Version after re-resolution; `null` when the update errored. */
  readonly to: string | null;
  readonly updated: boolean;
  readonly error?: string | undefined;
}

export interface UpdateResult {
  readonly environment: string;
  readonly dryRun: boolean;
  readonly packages: UpdateRow[];
}

/**
 * Re-resolve locked package(s) against their recorded source and range.
 *
 * `update` never takes a new source or range — that is `install`'s contract.
 * It replays each package's recorded install (source, range, selection), which
 * routes through the same resolution and D19 downgrade guard, and reports
 * old → new per package. One package failing does not abort the rest.
 * The caller still runs `titw sync` to materialize (D17).
 */
export async function update(options: UpdateOptions = {}): Promise<UpdateResult> {
  const context = contextFor(options);
  const { manifest, lock } = await readEnvironment(context);

  if (options.package !== undefined && manifest.packages[options.package] === undefined) {
    throw new TitwError('E_NOT_FOUND', `${options.package} is not installed in "${context.env.name}"`);
  }
  const names =
    options.package === undefined
      ? Object.keys(manifest.packages).sort(comparePaths)
      : [options.package];

  const rows: UpdateRow[] = [];
  for (const name of names) {
    const selection = manifest.packages[name];
    const entry = lock.packages[name];
    if (selection === undefined || entry === undefined) continue;
    try {
      const result = await install({
        ...(options.home === undefined ? {} : { home: options.home }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        source: selection.source,
        version: selection.version,
        ...(selection.include === undefined ? {} : { include: selection.include }),
        ...(selection.exclude === undefined ? {} : { exclude: selection.exclude }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      rows.push({
        name,
        from: entry.version,
        to: result.version,
        updated: result.version !== entry.version,
      });
    } catch (error) {
      rows.push({
        name,
        from: entry.version,
        to: null,
        updated: false,
        error: (error as Error).message,
      });
    }
  }

  return { environment: context.env.name, dryRun: options.dryRun === true, packages: rows };
}
