import { describe, expect, it } from 'vitest';
import { insertFrontmatterKeys, parseFrontmatter } from '../src/core/frontmatter.js';
import {
  RECORD_KINDS,
  classifyRecord,
  normalizeKind,
  normalizeRecordText,
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

describe('kind recognition', () => {
  it('recognizes the seven record kinds the plugin uses (D5)', () => {
    expect([...RECORD_KINDS].sort()).toEqual(
      ['decision', 'failure-mode', 'plan', 'principle', 'procedure', 'research', 'solution'].sort(),
    );
  });

  it('normalizes an OKF type to a record kind', () => {
    expect(normalizeKind('Procedure')).toBe('procedure');
    expect(normalizeKind('Failure Mode')).toBe('failure-mode');
    expect(normalizeKind('Concept')).toBeNull();
    expect(normalizeKind(null)).toBeNull();
  });
});

describe('classifyRecord', () => {
  it('reads a six-key record without needing any compat decoration', () => {
    const info = classifyRecord(SIX_KEY);
    expect(info.kind).toBe('procedure');
    expect(info.id).toBe('proc.deploy.fixture');
    expect(info.compat).toEqual([]);
    expect(info.unknownKind).toBeNull();
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
    expect(info.unknownKind).toBeNull();
  });

  it('reports an unrecognized declared kind so the projection can warn (never drop)', () => {
    const info = classifyRecord('---\nkind: evolution\nid: x\n---\n# E\n');
    expect(info.kind).toBeNull();
    expect(info.unknownKind).toBe('evolution');
  });

  it('never derives kind from type: when an explicit kind: exists (no duplicate key)', () => {
    const info = classifyRecord('---\nkind: evolution\ntype: procedure\nid: x\n---\n# E\n');
    expect(info.kind).toBeNull();
    expect(info.unknownKind).toBe('evolution');
    expect(info.compat).toEqual([]);
  });
});

describe('normalizeRecordText', () => {
  it('rewrites a block-style keywords list to the inline form the matcher tokenizes', () => {
    const block = [
      '---',
      'id: prin.block-keys',
      'kind: principle',
      'keywords:',
      '  - alpha',
      '  - beta',
      'status: active',
      '---',
      '',
      '# Block keys',
      '',
      'keywords:',
      '  - body text that must not be touched',
      '',
    ].join('\n');
    const out = normalizeRecordText(block);
    expect(out).toMatch(/^keywords: \[alpha, beta\]$/m);
    expect(out).toContain('  - body text that must not be touched');
    expect(parseFrontmatter(out).data['keywords']).toEqual(['alpha', 'beta']);
  });

  it('normalizes a same-indent block sequence (valid YAML) too', () => {
    const block = '---\nid: a\nkind: decision\nkeywords:\n- deployment\n- rollback\n---\n\n# A\n';
    const out = normalizeRecordText(block);
    expect(out).toMatch(/^keywords: \[deployment, rollback\]$/m);
  });

  it('folds CRLF to LF and strips a BOM so the awk scanner sees the fences', () => {
    const crlf = `﻿---\r\nid: a\r\nkind: decision\r\nkeywords: [x]\r\n---\r\n\r\n# A\r\n`;
    const out = normalizeRecordText(crlf);
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(out).not.toContain('\r');
    expect(parseFrontmatter(out).data['id']).toBe('a');
  });

  it('leaves an already-normalized document byte-identical', () => {
    expect(normalizeRecordText(SIX_KEY)).toBe(SIX_KEY);
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
