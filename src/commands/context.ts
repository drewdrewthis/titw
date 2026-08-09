import { DEFAULT_ENVIRONMENT, resolveTitwHome } from '../core/env.js';
import { TitwError } from '../core/errors.js';
import { ensureDir, pathExists, writeFile } from '../core/fsx.js';
import {
  emptyEnvironmentManifest,
  emptyLock,
  loadEnvironmentManifest,
  loadLock,
  renderEnvironmentManifest,
  renderLock,
  type EnvironmentManifest,
  type Lock,
} from '../core/manifest.js';
import {
  environmentLayout,
  layoutFor,
  type EnvironmentLayout,
  type Layout,
} from '../materialize/layout.js';

/** Options every command accepts, so tests can point at a tmp `$TITW_HOME`. */
export interface CommandOptions {
  readonly environment?: string | undefined;
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
}

/** Resolved paths a command works against. */
export interface CommandContext {
  readonly layout: Layout;
  readonly env: EnvironmentLayout;
  readonly cwd: string;
}

/** Resolve `$TITW_HOME`, the environment layout, and the working directory. */
export function contextFor(options: CommandOptions = {}): CommandContext {
  const environment = options.environment ?? DEFAULT_ENVIRONMENT;
  if (environment !== DEFAULT_ENVIRONMENT) {
    // D15: targets/<id>/{active,previous} is $TITW_HOME-global, so a second
    // environment syncing the same target would clobber the first's projection.
    throw new TitwError(
      'E_ENV_UNSUPPORTED',
      `only the "${DEFAULT_ENVIRONMENT}" environment is supported in v0 (DECISIONS D15)`,
      ['multi-environment support needs per-environment target roots first'],
    );
  }
  const home = options.home ?? resolveTitwHome(options.processEnv ?? process.env);
  const layout = layoutFor(home);
  return {
    layout,
    env: environmentLayout(layout, environment),
    cwd: options.cwd ?? process.cwd(),
  };
}

/** Environment manifest plus lock, defaulted when the environment is new. */
export interface EnvironmentState {
  readonly manifest: EnvironmentManifest;
  readonly lock: Lock;
  /** False when nothing was on disk yet — the environment is being created. */
  readonly existed: boolean;
}

/** Load an environment's manifest and lock, defaulting both when absent. */
export async function readEnvironment(context: CommandContext): Promise<EnvironmentState> {
  const hasManifest = await pathExists(context.env.manifest);
  const manifest = hasManifest
    ? await loadEnvironmentManifest(context.env.manifest)
    : emptyEnvironmentManifest(context.env.name);
  const lock = (await pathExists(context.env.lock)) ? await loadLock(context.env.lock) : emptyLock();
  return { manifest, lock, existed: hasManifest };
}

/** Persist an environment's manifest (intent — only commands that change intent call this). */
export async function writeManifest(
  context: CommandContext,
  manifest: EnvironmentManifest,
): Promise<void> {
  await ensureDir(context.env.root);
  await writeFile(context.env.manifest, renderEnvironmentManifest(manifest));
}

/** Persist an environment's lock (derived state — safe for sync to rewrite, D17). */
export async function writeLock(context: CommandContext, lock: Lock): Promise<void> {
  await ensureDir(context.env.root);
  await writeFile(context.env.lock, renderLock(lock));
}

/** Persist an environment's manifest and lock. */
export async function writeEnvironment(
  context: CommandContext,
  manifest: EnvironmentManifest,
  lock: Lock,
): Promise<void> {
  await writeManifest(context, manifest);
  await writeLock(context, lock);
}

/**
 * Target ids enabled in an environment manifest.
 *
 * The Claude target is the default only when `targets:` is unconfigured;
 * an explicit `enabled: false` on every target means none (not the default).
 */
export function enabledTargets(manifest: EnvironmentManifest): string[] {
  const entries = Object.entries(manifest.targets);
  if (entries.length === 0) return ['claude'];
  return entries
    .filter(([, value]) => value.enabled)
    .map(([id]) => id)
    .sort();
}
