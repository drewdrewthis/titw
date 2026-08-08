import { describe, expect, it } from 'vitest';
import { TitwError } from '../src/core/errors.js';
import { parseSource } from '../src/core/source.js';

describe('parseSource', () => {
  it('treats github: as sugar over an https clone url and preserves the user-facing form', () => {
    const source = parseSource('github:drewdrewthis/engineering-way');
    expect(source.kind).toBe('github');
    expect(source.raw).toBe('github:drewdrewthis/engineering-way');
    expect(source.canonical).toBe('github:drewdrewthis/engineering-way');
    expect(source.cloneUrl).toBe('https://github.com/drewdrewthis/engineering-way.git');
  });

  it('normalizes a bare owner/repo slug to the github form', () => {
    const source = parseSource('vercel-labs/agent-skills');
    expect(source.kind).toBe('github');
    expect(source.canonical).toBe('github:vercel-labs/agent-skills');
    expect(source.raw).toBe('vercel-labs/agent-skills');
  });

  it('strips the git+ prefix for the clone url of ssh and https sources', () => {
    expect(parseSource('git+ssh://git@github.com/owner/repo.git').cloneUrl).toBe(
      'ssh://git@github.com/owner/repo.git',
    );
    expect(parseSource('git+https://github.com/owner/repo.git').cloneUrl).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('resolves path: sources against the given base directory', () => {
    const source = parseSource('path:../local-package', { baseDir: '/tmp/work/env' });
    expect(source.kind).toBe('path');
    expect(source.dir).toBe('/tmp/work/local-package');
    expect(source.cloneUrl).toBeNull();
    expect(source.canonical).toBe('path:../local-package');
  });

  it('rejects a url embedding credentials, which must never reach TITW state', () => {
    expect(() => parseSource('git+https://user:ghp_secret@github.com/o/r.git')).toThrow(TitwError);
    try {
      parseSource('git+https://user:ghp_secret@github.com/o/r.git');
    } catch (error) {
      expect((error as TitwError).code).toBe('E_SOURCE_CREDENTIALS');
      expect((error as TitwError).message).not.toContain('ghp_secret');
    }
  });

  it('rejects unsupported source forms with the accepted list', () => {
    expect(() => parseSource('ftp://example.com/pkg')).toThrow(/unsupported source/);
    expect(() => parseSource('')).toThrow(/source is empty/);
  });

  it('gives each distinct source a stable, distinct cache key', () => {
    const a = parseSource('github:owner/repo');
    const b = parseSource('github:owner/repo');
    const c = parseSource('github:owner/other');
    expect(a.cacheKey).toBe(b.cacheKey);
    expect(a.cacheKey).not.toBe(c.cacheKey);
    expect(a.cacheKey).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
