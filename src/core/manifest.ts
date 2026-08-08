import fs from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { valid as validSemver, validRange } from 'semver';
import { z } from 'zod';
import { TitwError } from './errors.js';

/** Filename of a package manifest inside a package root. */
export const PACKAGE_MANIFEST_FILENAME = 'titw.package.yaml';
/** Filename of an environment (consumer) manifest. */
export const ENVIRONMENT_MANIFEST_FILENAME = 'titw.yaml';
/** Filename of the lockfile that sits beside an environment manifest. */
export const LOCK_FILENAME = 'titw.lock';

const packageName = z
  .string()
  .min(1)
  .regex(
    /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'must be a package name, optionally scoped (e.g. "@dru/engineering-way")',
  );

const exactVersion = z
  .string()
  .refine((v) => validSemver(v) !== null, 'must be an exact semver version (e.g. "1.2.0")');

const versionRange = z
  .string()
  .refine((v) => validRange(v) !== null, 'must be a semver range (e.g. "^1.2.0")');

const selectorList = z.array(z.string().min(1));

const ComponentSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    path: z.string().min(1),
    runtime: z.string().min(1).optional(),
    requires: selectorList.optional(),
  })
  .strict();

const DependencySchema = z
  .object({
    source: z.string().min(1),
    version: versionRange.optional(),
  })
  .strict();

/** Zod schema for `titw.package.yaml` (schema 1). */
export const PackageManifestSchema = z
  .object({
    schema: z.literal(1),
    name: packageName,
    version: exactVersion,
    description: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    knowledge: z
      .object({ format: z.string().min(1), version: z.string().min(1) })
      .strict()
      .optional(),
    exports: selectorList.min(1, 'a package must export at least one path'),
    publish: z.object({ default: z.boolean() }).strict().optional(),
    dependencies: z.record(DependencySchema).optional(),
    components: z.array(ComponentSchema).optional(),
    targets: z.record(z.record(z.union([z.string(), z.array(z.string())]))).optional(),
  })
  .strict();

/** A parsed `titw.package.yaml`. */
export type PackageManifest = z.infer<typeof PackageManifestSchema>;
/** A declared package component (skill, hook, executable). */
export type Component = z.infer<typeof ComponentSchema>;

const PackageSelectionSchema = z
  .object({
    source: z.string().min(1),
    version: versionRange.optional(),
    include: selectorList.optional(),
    exclude: selectorList.optional(),
  })
  .strict();

/** Zod schema for `titw.yaml` (schema 1). */
export const EnvironmentManifestSchema = z
  .object({
    schema: z.literal(1),
    name: z.string().min(1),
    packages: z.record(PackageSelectionSchema).default({}),
    targets: z.record(z.object({ enabled: z.boolean() }).strict()).default({}),
  })
  .strict();

/** A parsed `titw.yaml`. */
export type EnvironmentManifest = z.infer<typeof EnvironmentManifestSchema>;
/** One package entry of a `titw.yaml`. */
export type PackageSelection = z.infer<typeof PackageSelectionSchema>;

const LockEntrySchema = z
  .object({
    source: z.string().min(1),
    cloneUrl: z.string().nullable(),
    range: versionRange,
    version: exactVersion,
    /** Exact commit; `null` only for `path:` sources, which have no release. */
    commit: z.string().nullable(),
    ref: z.string().nullable(),
    manifestHash: z.string().min(1),
    treeHash: z.string().min(1),
    selection: z.array(z.string()),
    files: z.record(z.string()),
  })
  .strict();

/** Zod schema for `titw.lock` (schema 1, JSON on disk). */
export const LockSchema = z
  .object({
    schema: z.literal(1),
    packages: z.record(LockEntrySchema).default({}),
  })
  .strict();

/** A parsed `titw.lock`. */
export type Lock = z.infer<typeof LockSchema>;
/** One package entry of a `titw.lock`. */
export type LockEntry = z.infer<typeof LockEntrySchema>;

/** An empty, valid lock — the starting state of a fresh environment. */
export function emptyLock(): Lock {
  return { schema: 1, packages: {} };
}

/** An empty, valid environment manifest with the Claude target enabled. */
export function emptyEnvironmentManifest(name: string): EnvironmentManifest {
  return { schema: 1, name, packages: {}, targets: { claude: { enabled: true } } };
}

/** Parse and validate `titw.package.yaml` text. `label` names the file in diagnostics. */
export function parsePackageManifest(text: string, label: string): PackageManifest {
  return validate(PackageManifestSchema, parseYamlText(text, label), label, 'package manifest');
}

/** Parse and validate `titw.yaml` text. */
export function parseEnvironmentManifest(text: string, label: string): EnvironmentManifest {
  return validate(EnvironmentManifestSchema, parseYamlText(text, label), label, 'environment manifest');
}

/** Parse and validate `titw.lock` text (JSON). */
export function parseLock(text: string, label: string): Lock {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new TitwError('E_LOCK_INVALID', `${label}: invalid JSON: ${(error as Error).message}`);
  }
  return validate(LockSchema, data, label, 'lock');
}

/** Read and validate a package manifest from disk. */
export async function loadPackageManifest(file: string): Promise<PackageManifest> {
  return parsePackageManifest(await readOrFail(file, 'package manifest'), file);
}

/** Read and validate an environment manifest from disk. */
export async function loadEnvironmentManifest(file: string): Promise<EnvironmentManifest> {
  return parseEnvironmentManifest(await readOrFail(file, 'environment manifest'), file);
}

/** Read and validate a lockfile from disk. */
export async function loadLock(file: string): Promise<Lock> {
  return parseLock(await readOrFail(file, 'lock'), file);
}

/** Serialize an environment manifest to YAML. */
export function renderEnvironmentManifest(manifest: EnvironmentManifest): string {
  return stringifyYaml(manifest, { lineWidth: 0 });
}

/** Serialize a lock to JSON with a trailing newline. */
export function renderLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function readOrFail(file: string, what: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    throw new TitwError('E_NOT_FOUND', `${what} not found: ${file}`);
  }
}

function parseYamlText(text: string, label: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new TitwError('E_YAML_INVALID', `${label}: invalid YAML: ${(error as Error).message}`);
  }
}

function validate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  label: string,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data as z.infer<T>;
  const details = result.error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  throw new TitwError('E_MANIFEST_INVALID', `${label}: invalid ${what}`, details);
}
