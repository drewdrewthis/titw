import { describe, expect, it } from 'vitest';
import { TitwError } from '../src/core/errors.js';
import { selectFiles, validateSelector } from '../src/core/select.js';

const FILES = [
  'README.md',
  'CHANGELOG.md',
  'knowledge/principles/simple-first.md',
  'knowledge/procedures/deploy/PROCEDURE.md',
  'knowledge/procedures/vm-only/PROCEDURE.md',
  'scripts/verify.sh',
  'titw.package.yaml',
];

const EXPORTS = ['README.md', 'knowledge/**', 'scripts/**'];

describe('selectFiles', () => {
  it('selects every export when include is absent', () => {
    const result = selectFiles({ files: FILES, exports: EXPORTS });
    expect(result.selected).toEqual([
      'README.md',
      'knowledge/principles/simple-first.md',
      'knowledge/procedures/deploy/PROCEDURE.md',
      'knowledge/procedures/vm-only/PROCEDURE.md',
      'scripts/verify.sh',
    ]);
  });

  it('never selects a file the publisher did not export', () => {
    const result = selectFiles({ files: FILES, exports: EXPORTS, include: ['CHANGELOG.md'] });
    expect(result.selected).toEqual([]);
    expect(result.exported).not.toContain('CHANGELOG.md');
    expect(result.unmatchedInclude).toEqual(['CHANGELOG.md']);
  });

  it('starts from only the matching exports when include is present', () => {
    const result = selectFiles({
      files: FILES,
      exports: EXPORTS,
      include: ['knowledge/procedures/**'],
    });
    expect(result.selected).toEqual([
      'knowledge/procedures/deploy/PROCEDURE.md',
      'knowledge/procedures/vm-only/PROCEDURE.md',
    ]);
  });

  it('installs a single file when include names an exact path', () => {
    const result = selectFiles({
      files: FILES,
      exports: EXPORTS,
      include: ['knowledge/principles/simple-first.md'],
    });
    expect(result.selected).toEqual(['knowledge/principles/simple-first.md']);
  });

  it('treats a bare directory selector as its whole subtree', () => {
    const result = selectFiles({ files: FILES, exports: EXPORTS, include: ['knowledge'] });
    expect(result.selected).toEqual([
      'knowledge/principles/simple-first.md',
      'knowledge/procedures/deploy/PROCEDURE.md',
      'knowledge/procedures/vm-only/PROCEDURE.md',
    ]);
  });

  it('subtracts exclude, which wins over include', () => {
    const result = selectFiles({
      files: FILES,
      exports: EXPORTS,
      include: ['knowledge/**'],
      exclude: ['knowledge/procedures/vm-only/**'],
    });
    expect(result.selected).toEqual([
      'knowledge/principles/simple-first.md',
      'knowledge/procedures/deploy/PROCEDURE.md',
    ]);
  });

  it('lets exclude subtract a file that include names exactly', () => {
    const result = selectFiles({
      files: FILES,
      exports: EXPORTS,
      include: ['knowledge/principles/simple-first.md'],
      exclude: ['knowledge/principles/simple-first.md'],
    });
    expect(result.selected).toEqual([]);
  });

  it('reports exclude patterns that subtracted nothing', () => {
    const result = selectFiles({ files: FILES, exports: EXPORTS, exclude: ['docs/**'] });
    expect(result.unmatchedExclude).toEqual(['docs/**']);
  });

  it('sorts deterministically regardless of input order', () => {
    const shuffled = [...FILES].reverse();
    expect(selectFiles({ files: shuffled, exports: EXPORTS }).selected).toEqual(
      selectFiles({ files: FILES, exports: EXPORTS }).selected,
    );
  });
});

describe('validateSelector', () => {
  const rejected: Array<[string, RegExp]> = [
    ['/etc/passwd', /absolute paths/],
    ['../outside/thing.md', /".." is not allowed/],
    ['knowledge/../../escape.md', /".." is not allowed/],
    ['!knowledge/**', /negation is not supported/],
    ['knowledge\\principles', /"\/" as the separator/],
    ['   ', /selector is empty/],
  ];

  for (const [selector, message] of rejected) {
    it(`rejects ${JSON.stringify(selector)}`, () => {
      expect(() => validateSelector(selector, 'include')).toThrow(message);
      try {
        validateSelector(selector, 'include');
      } catch (error) {
        expect((error as TitwError).code).toBe('E_SELECTOR_INVALID');
        expect((error as TitwError).message).toContain('include:');
      }
    });
  }

  it('accepts package-relative paths and ordinary globs', () => {
    for (const selector of ['README.md', 'knowledge/**', 'knowledge/*/PROCEDURE.md', 'plans']) {
      expect(() => validateSelector(selector, 'exports')).not.toThrow();
    }
  });

  it('rejects invalid selectors before any matching happens', () => {
    expect(() => selectFiles({ files: FILES, exports: EXPORTS, include: ['!x'] })).toThrow(
      /negation is not supported/,
    );
  });
});
