import { describe, expect, it } from 'vitest';
import { insertFrontmatterKeys, parseFrontmatter } from '../src/core/frontmatter.js';
import {
  RECORD_STORES,
  classifyRecord,
  normalizeKind,
  projectionPath,
  storeForKind,
} from '../src/targets/claude/records.js';

const SIX_KEY = [
  '---',
  'id: proc.deploy.fixture',
  'kind: procedure',
  'date: 2026-08-08',
  'keywords: [deployment, release]',
  'links: {}',
  'status: active',
  '---',
  '',
  '# Deploy the fixture',
  '',
].join('\n');

const OKF = [
  '---',
  'type: Research',
  'title: OKF adoption notes',
  'tags: [okf, frontmatter]',
  'status: stable',
  'titw:',
  '  id: res.okf-adoption',
  '---',
  '',
  '# OKF adoption notes',
  '',
].join('\n');

describe('kind mapping', () => {
  it('maps every record kind to the store the procedures plugin scans (D5)', () => {
    expect(RECORD_STORES).toEqual({
      'failure-mode': 'references/failure-modes',
      decision: 'references/decisions',
      solution: 'references/solutions',
      procedure: 'references/procedures',
      research: 'references/research',
      plan: 'plans',
      principle: 'references/principles',
    });
  });

  it('normalizes an OKF type to a record kind', () => {
    expect(normalizeKind('Procedure')).toBe('procedure');
    expect(normalizeKind('Failure Mode')).toBe('failure-mode');
    expect(normalizeKind('Concept')).toBeNull();
    expect(normalizeKind(null)).toBeNull();
  });

  it('returns no store for a non-record kind', () => {
    expect(storeForKind('skill')).toBeNull();
  });
});

describe('projectionPath', () => {
  it('preserves the subpath following the store directory', () => {
    expect(
      projectionPath('references/procedures', 'knowledge/procedures/deploy/PROCEDURE.md'),
    ).toBe('references/procedures/deploy/PROCEDURE.md');
    expect(projectionPath('references/principles', 'knowledge/principles/simple-first.md')).toBe(
      'references/principles/simple-first.md',
    );
    expect(projectionPath('plans', 'plans/ship-v1.md')).toBe('plans/ship-v1.md');
  });

  it('falls back to the basename when no store directory appears in the path', () => {
    expect(projectionPath('references/decisions', 'docs/notes/pick-yaml.md')).toBe(
      'references/decisions/pick-yaml.md',
    );
  });
});

describe('classifyRecord', () => {
  it('reads a six-key record without needing any compat decoration', () => {
    const info = classifyRecord(SIX_KEY);
    expect(info.kind).toBe('procedure');
    expect(info.id).toBe('proc.deploy.fixture');
    expect(info.compat).toEqual([]);
  });

  it('derives compat id/kind/keywords for an OKF-native record from titw.id, type, tags', () => {
    const info = classifyRecord(OKF);
    expect(info.kind).toBe('research');
    expect(info.id).toBe('res.okf-adoption');
    expect(info.compat).toEqual([
      'id: res.okf-adoption',
      'kind: research',
      'keywords: [okf, frontmatter]',
    ]);
  });

  it('classifies a file without frontmatter as a non-record and decorates nothing', () => {
    const info = classifyRecord('# Just a readme\n');
    expect(info.kind).toBeNull();
    expect(info.id).toBeNull();
    expect(info.compat).toEqual([]);
  });

  it('leaves a non-record OKF concept undecorated even when it has tags', () => {
    const info = classifyRecord('---\ntype: Concept\ntags: [a, b]\n---\n\n# Concept\n');
    expect(info.kind).toBeNull();
    expect(info.compat).toEqual([]);
  });
});

describe('insertFrontmatterKeys', () => {
  it('inserts compat keys inline and leaves every other byte untouched', () => {
    const decorated = insertFrontmatterKeys(OKF, classifyRecord(OKF).compat);
    const lines = decorated.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('id: res.okf-adoption');
    expect(lines[2]).toBe('kind: research');
    expect(lines[3]).toBe('keywords: [okf, frontmatter]');
    expect(lines[4]).toBe('type: Research');
    expect(decorated).toContain('titw:\n  id: res.okf-adoption');
    expect(decorated.slice(decorated.indexOf('---', 4))).toBe(OKF.slice(OKF.indexOf('---', 4)));
  });

  it('keeps the keywords list in the inline syntax the plugin matcher tokenizes', () => {
    const decorated = insertFrontmatterKeys(OKF, classifyRecord(OKF).compat);
    expect(decorated).toMatch(/^keywords: \[[^\]]+\]$/m);
    expect(parseFrontmatter(decorated).data['keywords']).toEqual(['okf', 'frontmatter']);
  });

  it('is a no-op when there is nothing to add', () => {
    expect(insertFrontmatterKeys(SIX_KEY, [])).toBe(SIX_KEY);
  });
});
