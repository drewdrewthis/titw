import { describe, expect, it } from 'vitest';
import { latestVersion, pickVersion, sortDescending, versionFromTag } from '../src/core/fetch.js';

const TAGS = [
  { version: '1.0.0', ref: 'v1.0.0' },
  { version: '1.1.0', ref: 'v1.1.0' },
  { version: '2.0.0', ref: 'v2.0.0' },
  { version: '1.2.0', ref: '1.2.0' },
];

describe('versionFromTag', () => {
  it('accepts both v-prefixed and bare semver tags', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('1.2.3')).toBe('1.2.3');
    expect(versionFromTag('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
  });

  it('ignores tags that are not releases', () => {
    for (const ref of ['latest', 'release-2026', 'v1.2', 'v1.2.3.4', '']) {
      expect(versionFromTag(ref)).toBeNull();
    }
  });
});

describe('resolution', () => {
  it('picks the newest tag satisfying a caret range', () => {
    expect(pickVersion(TAGS, '^1.0.0')?.version).toBe('1.2.0');
    expect(pickVersion(TAGS, '^1.0.0')?.ref).toBe('1.2.0');
  });

  it('honours an exact pin', () => {
    expect(pickVersion(TAGS, '1.0.0')?.ref).toBe('v1.0.0');
  });

  it('returns null when no release satisfies the range', () => {
    expect(pickVersion(TAGS, '^3.0.0')).toBeNull();
  });

  it('reports latest independently of the range', () => {
    expect(latestVersion(TAGS)?.version).toBe('2.0.0');
    expect(latestVersion([])).toBeNull();
  });

  it('sorts newest-first by semver, not lexically', () => {
    expect(
      sortDescending([
        { version: '1.9.0', ref: 'v1.9.0' },
        { version: '1.10.0', ref: 'v1.10.0' },
      ]).map((tag) => tag.version),
    ).toEqual(['1.10.0', '1.9.0']);
  });

  it('excludes prereleases from a plain range', () => {
    const tags = [
      { version: '1.0.0', ref: 'v1.0.0' },
      { version: '1.1.0-rc.1', ref: 'v1.1.0-rc.1' },
    ];
    expect(pickVersion(tags, '^1.0.0')?.version).toBe('1.0.0');
  });
});
