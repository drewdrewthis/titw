import fs from 'node:fs/promises';
import path from 'node:path';
import { TitwError } from './errors.js';

/** True when the path exists (of any type). */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory and every missing parent. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * List every regular file under `root` as package-relative, `/`-separated paths.
 *
 * Symlinks are rejected rather than followed or skipped: v1 package outputs and
 * projections must contain none (handoff §9), and silently dropping one would
 * make a package's selection differ from its contents.
 *
 * @param root directory to walk.
 * @param skip directory basenames to prune (defaults to `.git`).
 */
export async function walkFiles(root: string, skip: readonly string[] = ['.git']): Promise<string[]> {
  const out: string[] = [];
  const skipSet = new Set(skip);

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new TitwError('E_SYMLINK', `symlinks are not supported in v1: ${rel}`);
      }
      if (entry.isDirectory()) {
        if (skipSet.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (/\.tmp-\d+$/.test(entry.name)) continue; // crashed atomic-write leftover
        out.push(rel);
      }
    }
  }

  await walk(root, '');
  return out.sort(comparePaths);
}

/** Byte-wise ordering used everywhere TITW must be deterministic. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Copy one file, creating parents. The destination keeps the source's mode
 * (DECISIONS D22): a packaged script stays executable after materialization.
 */
export async function copyFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  const tmp = tmpName(to);
  await fs.copyFile(from, tmp);
  await fs.chmod(tmp, (await fs.stat(from)).mode & 0o777);
  await fs.rename(tmp, to);
}

/**
 * Write a file atomically: write `<path>.tmp-<pid>`, then rename over the
 * target. A crash mid-write can never truncate `titw.lock` or a receipt.
 */
export async function writeFile(to: string, contents: string | Buffer, mode?: number): Promise<void> {
  await ensureDir(path.dirname(to));
  const tmp = tmpName(to);
  await fs.writeFile(tmp, contents);
  if (mode !== undefined) await fs.chmod(tmp, mode);
  await fs.rename(tmp, to);
}

function tmpName(to: string): string {
  return `${to}.tmp-${process.pid}`;
}

/**
 * Recursively delete a tree that may contain read-only files.
 *
 * `fs.rm` cannot unlink a 0444 file inside a directory on every platform, and
 * every tree TITW deletes is one it made read-only itself.
 */
export async function rmTreeForce(target: string): Promise<void> {
  if (!(await pathExists(target))) return;
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    // chmod would follow the link and touch a file outside the TITW tree.
    await fs.unlink(target);
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o755).catch(() => undefined);
    for (const entry of await fs.readdir(target)) {
      await rmTreeForce(path.join(target, entry));
    }
    await fs.rmdir(target);
    return;
  }
  await fs.chmod(target, 0o600).catch(() => undefined);
  await fs.rm(target, { force: true });
}

/** Copy a whole tree, file by file; each file keeps its source mode (D22). */
export async function copyTree(from: string, to: string): Promise<string[]> {
  const files = await walkFiles(from);
  for (const rel of files) {
    await copyFile(path.join(from, ...rel.split('/')), path.join(to, ...rel.split('/')));
  }
  return files;
}
