import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCatalog, writeSnippet, writeReport } from '../src/emit/index.js';
import { emptyCapabilities, type ModelEntry } from '../src/domain.js';

function entry(id: string, opts: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id,
    provider: 'demo',
    contextWindow: 1000,
    maxOutput: 500,
    pricing: null,
    capabilities: emptyCapabilities(),
    aliases: [],
    status: 'active',
    origin: 'api',
    capturedAt: '2026-08-16T00:00:00.000Z',
    hostKind: 'bare',
    extra: {},
    ...opts,
  };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'emit-test-'));
}

test('catalog.json 包含元信息与全部条目', async () => {
  const dir = makeDir();
  try {
    const entries = [entry('a'), entry('b')];
    const path = await writeCatalog(dir, {
      host: { baseUrl: 'https://h.example.com', kind: 'bare' },
      entries,
      warnings: ['w1'],
      generatedAt: '2026-08-16T01:00:00.000Z',
    });
    assert.ok(existsSync(path));
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(doc.schema, 'model-catalog/v1');
    assert.equal(doc.models.length, 2);
    assert.deepEqual(doc.warnings, ['w1']);
    assert.equal(doc.host.kind, 'bare');
    assert.ok(doc.generatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh 配置片段：绝不包含原始密钥，密钥以环境变量引用', async () => {
  const dir = makeDir();
  try {
    const entries = [
      entry('deepseek-v4-flash', {
        contextWindow: 1048576,
        maxOutput: 393216,
        pricing: {
          billing: 'per-token',
          unit: 'usd/1M',
          currency: 'USD',
          amounts: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: null, internalReasoning: null },
          tiers: [],
          dynamic: false,
          perCallUsd: null,
          source: 'builtin',
          capturedAt: '2026-08-16T00:00:00.000Z',
          sourceUrl: null,
          note: null,
        },
        capabilities: { ...emptyCapabilities(), toolCalling: true, streaming: true },
      }),
    ];
    const path = await writeSnippet(dir, {
      baseUrl: 'https://api.deepseek.com',
      hostKind: 'bare',
      apiKeyEnvName: 'DEEPSEEK_API_KEY',
      entries,
      generatedAt: '2026-08-16T01:00:00.000Z',
    });
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('sk-'), '片段不得包含密钥明文');
    const doc = JSON.parse(text);
    assert.equal(doc.schema, 'dsh/models/v1');
    assert.equal(doc.models[0]!.auth.name, 'DEEPSEEK_API_KEY');
    assert.equal(doc.models[0]!.pricing.amounts.input, 0.22);
    assert.equal(doc.models[0]!.capabilities.toolCalling, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsh 配置片段：无密钥环境时 auth 为 null', async () => {
  const dir = makeDir();
  try {
    const path = await writeSnippet(dir, {
      baseUrl: 'http://127.0.0.1:11434',
      hostKind: 'ollama',
      apiKeyEnvName: null,
      entries: [entry('llama3.2')],
      generatedAt: '2026-08-16T01:00:00.000Z',
    });
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(doc.models[0]!.auth, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report.md 包含未知定价与动态定价提示', async () => {
  const dir = makeDir();
  try {
    const entries = [
      entry('unknown-price', { status: 'unknown' }),
      entry('dyn-model', {
        pricing: {
          billing: 'per-token',
          unit: 'usd/1M',
          currency: 'USD',
          amounts: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: null, internalReasoning: null },
          tiers: [{ label: 'peak', windows: [['01:00', '04:00']], amounts: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: null, internalReasoning: null } }],
          dynamic: true,
          perCallUsd: null,
          source: 'builtin',
          capturedAt: '2026-08-16T00:00:00.000Z',
          sourceUrl: null,
          note: '峰值时段动态计费',
        },
      }),
    ];
    const path = await writeReport(dir, {
      host: { baseUrl: 'https://h.example.com', kind: 'bare' },
      entries,
      warnings: [],
      generatedAt: '2026-08-16T01:00:00.000Z',
    });
    const text = readFileSync(path, 'utf8');
    assert.ok(text.includes('unknown-price'), '报告应列出无定价模型');
    assert.ok(text.includes('动态'), '报告应提示动态定价');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
