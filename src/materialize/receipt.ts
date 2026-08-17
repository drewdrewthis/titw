import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TitwError } from '../core/errors.js';
import { comparePaths, ensureDir, pathExists, walkFiles, writeFile } from '../core/fsx.js';
import { hashFile } from '../core/hash.js';

const ReceiptPathSchema = z
  .object({ path: z.string().min(1), sha256: z.string().min(1), bytes: z.number().int().min(0) })
  .strict();

const ReceiptPackageSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    commit: z.string().nullable(),
    source: z.string().min(1),
  })
  .strict();

/** Schema of a sync receipt: the complete list of paths TITW owns in a projection. */
export const ReceiptSchema = z
  .object({
    schema: z.literal(1),
    environment: z.string().min(1),
    target: z.string().min(1),
    generation: z.string().min(1),
    createdAt: z.string().min(1),
    packages: z.array(ReceiptPackageSchema),
    paths: z.array(ReceiptPathSchema),
  })
  .strict();

export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptPackage = z.infer<typeof ReceiptPackageSchema>;

/** Schema of a target's recorded upstream-contribution proposals. */
export const ProposalsSchema = z
  .object({
    schema: z.literal(1),
    target: z.string().min(1),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export type Proposals = z.infer<typeof ProposalsSchema>;

/** Drift between a receipt and what is actually on disk in the active projection. */
export interface Drift {
  /** Receipted paths that are gone. */
  readonly missing: string[];
  /** Receipted paths whose bytes changed. */
  readonly modified: string[];
  /** Paths present in the projection that no receipt claims — never deleted by TITW. */
  readonly unowned: string[];
}

/** Build a receipt by hashing every file staged under `root`. */
export async function buildReceipt(options: {
  root: string;
  environment: string;
  target: string;
  generation: string;
  packages: readonly ReceiptPackage[];
  now?: Date;
}): Promise<Receipt> {
  const files = await walkFiles(options.root);
  const paths = await Promise.all(
    files.map(async (rel) => {
      const abs = path.join(options.root, ...rel.split('/'));
      const stat = await fs.stat(abs);
      return { path: rel, sha256: await hashFile(abs), bytes: stat.size };
    }),
  );
  return {
    schema: 1,
    environment: options.environment,
    target: options.target,
    generation: options.generation,
    createdAt: (options.now ?? new Date()).toISOString(),
    packages: [...options.packages],
    paths: paths.sort((a, b) => comparePaths(a.path, b.path)),
  };
}

/** File holding the receipt for the currently active generation of a target. */
export function currentReceiptFile(receiptsDir: string, target: string): string {
  return path.join(receiptsDir, target, 'current.json');
}

/** File holding the receipt for the retained previous generation of a target. */
export function previousReceiptFile(receiptsDir: string, target: string): string {
  return path.join(receiptsDir, target, 'previous.json');
}

/**
 * Write a receipt to its generation file and promote it to `current.json`,
 * demoting the outgoing receipt to `previous.json`.
 *
 * The receipt pair tracks the `active`/`previous` directory pair exactly, so a
 * rollback swaps both together and never has to re-derive which packages
 * produced the tree it restored.
 */
export async function writeReceipt(receiptsDir: string, receipt: Receipt): Promise<string> {
  const dir = path.join(receiptsDir, receipt.target);
  await ensureDir(dir);
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const file = path.join(dir, `${receipt.generation}.json`);
  await writeFile(file, body);

  const current = currentReceiptFile(receiptsDir, receipt.target);
  if (await pathExists(current)) {
    await writeFile(previousReceiptFile(receiptsDir, receipt.target), await fs.readFile(current));
  }
  await writeFile(current, body);
  return file;
}

/** Swap `current.json` and `previous.json`, mirroring a directory rollback. */
export async function swapReceipts(receiptsDir: string, target: string): Promise<void> {
  const current = currentReceiptFile(receiptsDir, target);
  const previous = previousReceiptFile(receiptsDir, target);
  const hadCurrent = await pathExists(current);
  const hadPrevious = await pathExists(previous);
  const currentBody = hadCurrent ? await fs.readFile(current) : null;
  const previousBody = hadPrevious ? await fs.readFile(previous) : null;

  if (previousBody === null) await fs.rm(current, { force: true });
  else await writeFile(current, previousBody);

  if (currentBody === null) await fs.rm(previous, { force: true });
  else await writeFile(previous, currentBody);
}

/** Read and validate a receipt. */
export async function loadReceipt(file: string): Promise<Receipt> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new TitwError('E_NOT_FOUND', `receipt not found: ${file}`);
  }
  const parsed = ReceiptSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new TitwError(
      'E_RECEIPT_INVALID',
      `${file}: invalid receipt`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** Read the current receipt of a target, or `null` when the target was never synced. */
export async function readCurrentReceipt(
  receiptsDir: string,
  target: string,
): Promise<Receipt | null> {
  const file = currentReceiptFile(receiptsDir, target);
  if (!(await pathExists(file))) return null;
  return loadReceipt(file);
}

/** File recording paths kept locally and proposed for upstream contribution. */
export function proposalsFile(receiptsDir: string, target: string): string {
  return path.join(receiptsDir, target, 'proposals.json');
}

/** Read a target's recorded proposals, or an empty list when none have been recorded yet. */
export async function readProposals(receiptsDir: string, target: string): Promise<Proposals> {
  const file = proposalsFile(receiptsDir, target);
  if (!(await pathExists(file))) return { schema: 1, target, paths: [] };
  const raw = await fs.readFile(file, 'utf8');
  const parsed = ProposalsSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new TitwError(
      'E_PROPOSALS_INVALID',
      `${file}: invalid proposals file`,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Merge newly-proposed paths into a target's proposals file and return where
 * it was written. Paths accumulate (deduplicated, sorted) across sync runs so
 * an earlier propose is never dropped by a later one.
 */
export async function recordProposals(
  receiptsDir: string,
  target: string,
  paths: readonly string[],
): Promise<string> {
  const existing = await readProposals(receiptsDir, target);
  const merged = [...new Set([...existing.paths, ...paths])].sort(comparePaths);
  const file = proposalsFile(receiptsDir, target);
  await writeFile(file, `${JSON.stringify({ schema: 1, target, paths: merged }, null, 2)}\n`);
  return file;
}

/**
 * Compare a projection on disk against its receipt.
 *
 * TITW reports drift and preserves it; it never deletes a path no receipt
 * claims (handoff §13).
 */
export async function detectDrift(root: string, receipt: Receipt): Promise<Drift> {
  const missing: string[] = [];
  const modified: string[] = [];
  const owned = new Set(receipt.paths.map((entry) => entry.path));

  for (const entry of receipt.paths) {
    const abs = path.join(root, ...entry.path.split('/'));
    if (!(await pathExists(abs))) {
      missing.push(entry.path);
      continue;
    }
    if ((await hashFile(abs)) !== entry.sha256) modified.push(entry.path);
  }

  const present = (await pathExists(root)) ? await walkFiles(root) : [];
  const unowned = present.filter((rel) => !owned.has(rel));
  return { missing, modified, unowned };
}
