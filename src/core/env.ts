import os from 'node:os';
import path from 'node:path';

/** Environment variable that overrides the TITW data root (tests set it to a tmp dir). */
export const TITW_HOME_ENV = 'TITW_HOME';

/**
 * Resolve the TITW data root: `$TITW_HOME`, else `$XDG_DATA_HOME/titw`, else
 * `~/.local/share/titw` (DECISIONS D7).
 *
 * @param env process environment to read from; injectable so commands stay hermetic.
 */
export function resolveTitwHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[TITW_HOME_ENV];
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit);
  const xdg = env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return path.join(path.resolve(xdg), 'titw');
  return path.join(os.homedir(), '.local', 'share', 'titw');
}

/** Default environment name when `--env` is not given. */
export const DEFAULT_ENVIRONMENT = 'default';
