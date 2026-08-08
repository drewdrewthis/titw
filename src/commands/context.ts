import { DEFAULT_ENVIRONMENT, resolveTitwHome } from '../core/env.js';
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
  const home = options.home ?? resolveTitwHome(options.processEnv ?? process.env);
  const layout = layoutFor(home);
  return {
    layout,
    env: environmentLayout(layout, options.environment ?? DEFAULT_ENVIRONMENT),
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

/** Persist an environment's manifest and lock. */
export async function writeEnvironment(
  context: CommandContext,
  manifest: EnvironmentManifest,
  lock: Lock,
): Promise<void> {
  await ensureDir(context.env.root);
  await writeFile(context.env.manifest, renderEnvironmentManifest(manifest));
  await writeFile(context.env.lock, renderLock(lock));
}

/** Target ids enabled in an environment manifest; the Claude target is the default. */
export function enabledTargets(manifest: EnvironmentManifest): string[] {
  const entries = Object.entries(manifest.targets).filter(([, value]) => value.enabled);
  return entries.length === 0 ? ['claude'] : entries.map(([id]) => id).sort();
}
