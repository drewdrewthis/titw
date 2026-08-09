import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from '../../core/errors.js';
import { insertFrontmatterKeys } from '../../core/frontmatter.js';
import { comparePaths, copyFile, writeFile } from '../../core/fsx.js';
import { encodePackageName } from '../../materialize/layout.js';
import type { Target, TargetBuildInput, TargetBuildResult, TargetPackageInput } from '../types.js';
import { classifyRecord, normalizeRecordText } from './records.js';

/** Directory inside the projection that becomes the plugin's `titw` store (D23). */
export const CORPUS_DIR = 'corpus';
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
 * Claude Code target: projects each package verbatim under
 * `corpus/<encoded package name>/<source path>` (DECISIONS D23). The corpus
 * directory is what lands in the plugin's `titw` store; the plugin's `--kind`
 * filter is frontmatter-based, so no kind routing happens here — a selected
 * byte is never re-homed or dropped.
 */
export class ClaudeTarget implements Target {
  readonly id = 'claude';

  async build(input: TargetBuildInput): Promise<TargetBuildResult> {
    const catalog: Catalog = Object.create(null) as Catalog;
    const paths: string[] = [];
    const warnings: string[] = [];

    for (const pkg of input.packages) {
      for (const sourcePath of pkg.files) {
        const placed = await this.placeFile(input.outDir, pkg, sourcePath, warnings);
        paths.push(placed.targetPath);
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
    );

    return { paths: [...paths, CATALOG_FILENAME].sort(comparePaths), warnings };
  }

  /**
   * Materialize one selected file at its verbatim projected path. Markdown is
   * normalized for the plugin's scanner (BOM/CRLF/keywords) and, when it is a
   * recognized record, decorated with compat frontmatter; everything else is
   * copied byte-for-byte with its mode preserved (D22).
   */
  private async placeFile(
    outDir: string,
    pkg: TargetPackageInput,
    sourcePath: string,
    warnings: string[],
  ): Promise<{ targetPath: string; key: string }> {
    const absSource = path.join(pkg.rootDir, ...sourcePath.split('/'));
    const targetPath = `${CORPUS_DIR}/${encodePackageName(pkg.name)}/${sourcePath}`;
    const absTarget = path.join(outDir, ...targetPath.split('/'));

    if (!sourcePath.toLowerCase().endsWith('.md')) {
      await copyFile(absSource, absTarget);
      return { targetPath, key: targetPath };
    }

    const text = normalizeRecordText(await fs.readFile(absSource, 'utf8'));
    const info = classifyRecord(text);
    if (info.unknownKind !== null) {
      warnings.push(
        `${pkg.name}:${sourcePath}: unrecognized kind "${info.unknownKind}" — projected verbatim, not decorated`,
      );
    }
    await writeFile(
      absTarget,
      info.compat.length > 0 ? insertFrontmatterKeys(text, info.compat) : text,
    );
    return { targetPath, key: info.id ?? targetPath };
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
  const sorted: Catalog = Object.create(null) as Catalog;
  for (const key of Object.keys(catalog).sort(comparePaths)) {
    const entry = catalog[key];
    if (entry !== undefined) sorted[key] = entry;
  }
  return sorted;
}
