import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../core/errors.js';
import { pathExists } from '../core/fsx.js';
import { targetLayout } from '../materialize/layout.js';
import { CATALOG_FILENAME, type Catalog } from '../targets/claude/index.js';
import { contextFor, enabledTargets, readEnvironment, type CommandOptions } from './context.js';

export interface FileRow {
  readonly path: string;
  readonly sha256: string | null;
  /** Where the file landed in the active projection, when it is projected. */
  readonly targetPath: string | null;
}

export interface FilesResult {
  readonly package: string;
  readonly version: string;
  readonly commit: string | null;
  readonly source: string;
  readonly target: string | null;
  readonly files: FileRow[];
}

/** List the files a package contributes, with their projected locations. */
export async function files(
  options: CommandOptions & { readonly package: string },
): Promise<FilesResult> {
  const context = contextFor(options);
  const { manifest, lock } = await readEnvironment(context);
  const entry = lock.packages[options.package];
  if (entry === undefined) {
    const known = Object.keys(lock.packages);
    throw new TitwError('E_NOT_INSTALLED', `${options.package} is not installed`, [
      known.length === 0 ? 'no packages are installed' : `installed: ${known.join(', ')}`,
    ]);
  }

  const target = enabledTargets(manifest)[0] ?? null;
  const catalog = target === null ? {} : await readCatalog(context, target);
  const bySourcePath = new Map<string, string>();
  for (const value of Object.values(catalog)) {
    if (value.package === options.package) bySourcePath.set(value.sourcePath, value.targetPath);
  }

  return {
    package: options.package,
    version: entry.version,
    commit: entry.commit,
    source: entry.source,
    target,
    files: entry.selection.map((file) => ({
      path: file,
      sha256: entry.files[file] ?? null,
      targetPath: bySourcePath.get(file) ?? null,
    })),
  };
}

async function readCatalog(
  context: ReturnType<typeof contextFor>,
  target: string,
): Promise<Catalog> {
  const file = path.join(targetLayout(context.layout, target).active, CATALOG_FILENAME);
  if (!(await pathExists(file))) return {};
  return JSON.parse(await fs.readFile(file, 'utf8')) as Catalog;
}
