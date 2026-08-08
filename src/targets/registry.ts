import { TitwError } from '../core/errors.js';
import { ClaudeTarget } from './claude/index.js';
import type { Target } from './types.js';

/** Target adapters available in v1. Adding one must not change the package format. */
export const TARGETS: Record<string, () => Target> = {
  claude: () => new ClaudeTarget(),
};

/** Look up a target adapter by id. */
export function targetById(id: string): Target {
  const factory = TARGETS[id];
  if (factory === undefined) {
    throw new TitwError('E_UNKNOWN_TARGET', `unknown target: ${id}`, [
      `known targets: ${Object.keys(TARGETS).join(', ')}`,
    ]);
  }
  return factory();
}
