import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../../core/errors.js';
import { insertFrontmatterKeys } from '../../core/frontmatter.js';
import { READ_ONLY_FILE_MODE, comparePaths, copyFile, writeFile } from '../../core/fsx.js';
import { encodePackageName } from '../../materialize/layout.js';
import type { Target, TargetBuildInput, TargetBuildResult, TargetPackageInput } from '../types.js';
import { classifyRecord, projectionPath, storeForKind } from './records.js';

/** Directory inside the projection that the procedures plugin is pointed at. */
export const CORPUS_DIR = 'corpus';
/** Directory holding selected non-record files, so nothing selected goes unmaterialized. */
export const FILES_DIR = 'files';
/** Provenance catalog filename (handoff §14). */
export const CATALOG_FILENAME = 'catalog.json';

/** One provenance entry of `catalog.json`. */
export interface CatalogEntry {
  readonly package: string;
  readonly version: string;
  readonly commit: string | null;
  readonly repository: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly editable: boolean;
}

/** `catalog.json`: provenance keyed by stable record id, else by materialized path. */
export type Catalog = Record<string, CatalogEntry>;

/**
 * Claude Code target: projects selected records into the seven-store corpus
 * layout the `procedures` plugin queries (DECISIONS D5).
 *
 * The plugin is pointed at `<active>/corpus` via `QUERY_RECORDS_ROOT`; the
 * plugin itself is never modified.
 */
export class ClaudeTarget implements Target {
  readonly id = 'claude';

  async build(input: TargetBuildInput): Promise<TargetBuildResult> {
    const catalog: Catalog = {};
    const written = new Map<string, string>();
    const warnings: string[] = [];

    for (const pkg of input.packages) {
      for (const sourcePath of pkg.files) {
        const placed = await this.placeFile(input.outDir, pkg, sourcePath, written);
        if (placed === null) continue;
        this.record(catalog, placed.key, {
          package: pkg.name,
          version: pkg.version,
          commit: pkg.commit,
          repository: pkg.repository ?? pkg.source,
          sourcePath,
          targetPath: placed.targetPath,
          editable: false,
        });
      }
      if (pkg.files.length === 0) warnings.push(`${pkg.name}: selection is empty`);
    }

    await writeFile(
      path.join(input.outDir, CATALOG_FILENAME),
      `${JSON.stringify(sortCatalog(catalog), null, 2)}\n`,
      READ_ONLY_FILE_MODE,
    );

    return {
      paths: [...written.keys(), CATALOG_FILENAME].sort(comparePaths),
      warnings,
    };
  }

  /**
   * Copy one selected file to its projected location.
   *
   * Markdown carrying a known record kind lands in its store; everything else
   * lands under `files/<package>/` so a selected byte is never silently
   * dropped from the projection.
   */
  private async placeFile(
    outDir: string,
    pkg: TargetPackageInput,
    sourcePath: string,
    written: Map<string, string>,
  ): Promise<{ targetPath: string; key: string } | null> {
    const absSource = path.join(pkg.rootDir, ...sourcePath.split('/'));
    const isMarkdown = sourcePath.toLowerCase().endsWith('.md');
    const text = isMarkdown ? await fs.readFile(absSource, 'utf8') : null;
    const info = text === null ? null : classifyRecord(text);
    const store = info === null ? null : storeForKind(info.kind);

    const targetPath =
      store === null
        ? `${FILES_DIR}/${encodePackageName(pkg.name)}/${sourcePath}`
        : `${CORPUS_DIR}/${projectionPath(store, sourcePath)}`;

    const owner = written.get(targetPath);
    if (owner !== undefined) {
      throw new TitwError(
        'E_TARGET_CONFLICT',
        `two selected files project to the same path: ${targetPath}`,
        [owner, `${pkg.name}:${sourcePath}`],
      );
    }
    written.set(targetPath, `${pkg.name}:${sourcePath}`);

    const absTarget = path.join(outDir, ...targetPath.split('/'));
    if (text !== null && info !== null && info.compat.length > 0) {
      await writeFile(absTarget, insertFrontmatterKeys(text, info.compat), READ_ONLY_FILE_MODE);
    } else {
      await copyFile(absSource, absTarget, READ_ONLY_FILE_MODE);
    }

    return { targetPath, key: info?.id ?? targetPath };
  }

  private record(catalog: Catalog, key: string, entry: CatalogEntry): void {
    const existing = catalog[key];
    if (existing !== undefined) {
      throw new TitwError('E_DUPLICATE_RECORD_ID', `duplicate record id in projection: ${key}`, [
        `${existing.package}:${existing.sourcePath}`,
        `${entry.package}:${entry.sourcePath}`,
      ]);
    }
    catalog[key] = entry;
  }
}

function sortCatalog(catalog: Catalog): Catalog {
  const sorted: Catalog = {};
  for (const key of Object.keys(catalog).sort(comparePaths)) {
    const entry = catalog[key];
    if (entry !== undefined) sorted[key] = entry;
  }
  return sorted;
}
