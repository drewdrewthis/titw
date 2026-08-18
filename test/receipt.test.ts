import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TitwError } from '../src/core/errors.js';
import { readPins } from '../src/materialize/receipt.js';
import { makeTmpDir, removeTree } from './helpers/fixture.js';

describe('readPins', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTmpDir('pins');
  });

  afterEach(async () => {
    await removeTree(root);
  });

  it('returns an empty pin list when no pins.json exists yet', async () => {
    expect(await readPins(root, 'claude')).toEqual({ schema: 1, target: 'claude', pins: [] });
  });

  it('reports malformed JSON as a TitwError, not a raw SyntaxError', async () => {
    const dir = path.join(root, 'claude');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'pins.json'), '{ nope');

    try {
      await readPins(root, 'claude');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TitwError);
      expect((error as TitwError).code).toBe('E_PINS_INVALID');
    }
  });
});
