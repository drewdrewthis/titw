import { describe, expect, it } from 'vitest';
import type { TitwError } from '../src/core/errors.js';
import {
  parseEnvironmentManifest,
  parseLock,
  parsePackageManifest,
  renderEnvironmentManifest,
  renderLock,
} from '../src/core/manifest.js';

const VALID_PACKAGE = `
schema: 1
name: "@dru/engineering-way"
version: 1.2.0
description: Shared engineering knowledge
repository: https://github.com/drewdrewthis/engineering-way
license: MIT
knowledge:
  format: okf
  version: "0.2"
exports:
  - README.md
  - knowledge/**
publish:
  default: false
dependencies:
  "@example/common":
    source: github:example/common
    version: "^1.1.0"
components:
  - id: lookup-skill
    type: agent-skill
    path: skills/lookup
    requires:
      - knowledge/procedures/lookup/**
targets:
  claude:
    knowledge: knowledge/**
`;

describe('package manifest', () => {
  it('accepts the schema-1 manifest from the handoff', () => {
    const manifest = parsePackageManifest(VALID_PACKAGE, 'titw.package.yaml');
    expect(manifest.name).toBe('@dru/engineering-way');
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.exports).toEqual(['README.md', 'knowledge/**']);
    expect(manifest.components?.[0]?.id).toBe('lookup-skill');
    expect(manifest.dependencies?.['@example/common']?.source).toBe('github:example/common');
  });

  it('requires version to be an exact semver, not a range (D2)', () => {
    expect(() =>
      parsePackageManifest('schema: 1\nname: pkg\nversion: "^1.2.0"\nexports: [a.md]\n', 'm.yaml'),
    ).toThrow(/exact semver/);
  });

  it('names the file, the field, and the problem in its diagnostic', () => {
    try {
      parsePackageManifest('schema: 1\nname: pkg\nexports: []\n', 'titw.package.yaml');
      expect.unreachable('should have thrown');
    } catch (error) {
      const titw = error as TitwError;
      expect(titw.code).toBe('E_MANIFEST_INVALID');
      expect(titw.message).toContain('titw.package.yaml');
      expect(titw.details.join('\n')).toContain('version:');
      expect(titw.details.join('\n')).toContain('exports:');
    }
  });

  it('rejects unknown keys rather than silently ignoring them', () => {
    expect(() =>
      parsePackageManifest('schema: 1\nname: p\nversion: 1.0.0\nexports: [a]\nexprts: [b]\n', 'm'),
    ).toThrow(/exprts/);
  });

  it('reports invalid YAML as a YAML error, not a schema error', () => {
    try {
      parsePackageManifest('schema: 1\n  bad: [indent\n', 'titw.package.yaml');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TitwError).code).toBe('E_YAML_INVALID');
    }
  });
});

describe('environment manifest', () => {
  it('accepts the consumer manifest from the handoff and round-trips', () => {
    const text = `
schema: 1
name: local-agents
packages:
  "@dru/engineering-way":
    source: github:drewdrewthis/engineering-way
    version: "^1.2.0"
    exclude:
      - knowledge/procedures/production-only/**
targets:
  claude:
    enabled: true
`;
    const manifest = parseEnvironmentManifest(text, 'titw.yaml');
    expect(manifest.packages['@dru/engineering-way']?.exclude).toEqual([
      'knowledge/procedures/production-only/**',
    ]);
    expect(manifest.targets['claude']?.enabled).toBe(true);

    const reparsed = parseEnvironmentManifest(renderEnvironmentManifest(manifest), 'titw.yaml');
    expect(reparsed).toEqual(manifest);
  });

  it('rejects a version that is not a semver range', () => {
    expect(() =>
      parseEnvironmentManifest(
        'schema: 1\nname: e\npackages:\n  p:\n    source: github:o/r\n    version: "not-a-range"\n',
        'titw.yaml',
      ),
    ).toThrow(/semver range/);
  });

  it('defaults packages and targets so a fresh environment is valid', () => {
    const manifest = parseEnvironmentManifest('schema: 1\nname: fresh\n', 'titw.yaml');
    expect(manifest.packages).toEqual({});
    expect(manifest.targets).toEqual({});
  });
});

describe('lock', () => {
  const lock = {
    schema: 1 as const,
    packages: {
      '@dru/engineering-way': {
        source: 'github:drewdrewthis/engineering-way',
        cloneUrl: 'https://github.com/drewdrewthis/engineering-way.git',
        range: '^1.2.0',
        version: '1.2.0',
        commit: 'a91c2f0000000000000000000000000000000000',
        ref: 'v1.2.0',
        manifestHash: 'sha256:aa',
        treeHash: 'sha256:bb',
        selection: ['knowledge/principles/simple-first.md'],
        files: { 'knowledge/principles/simple-first.md': 'sha256:cc' },
      },
    },
  };

  it('round-trips through render and parse', () => {
    expect(parseLock(renderLock(lock), 'titw.lock')).toEqual(lock);
  });

  it('allows a null commit only alongside the rest of the entry', () => {
    const pathLock = { ...lock, packages: { p: { ...lock.packages['@dru/engineering-way'], commit: null, ref: null } } };
    expect(parseLock(JSON.stringify(pathLock), 'titw.lock').packages['p']?.commit).toBeNull();
  });

  it('reports malformed JSON distinctly from a schema failure', () => {
    try {
      parseLock('{ nope', 'titw.lock');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TitwError).code).toBe('E_LOCK_INVALID');
    }
  });
});
