import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin, PLUGIN_ID } from '../src/plugin.js';
import { MockHost, routeTable } from './helpers/mock-host.js';
import { writeCatalog } from '../src/emit/catalog.js';
import { emptyCapabilities, type ModelEntry } from '../src/domain.js';

interface ToolHandler {
  (params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

function makeCtx(configMap: Record<string, unknown>) {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const tools = new Map<string, ToolHandler>();
  const ctx = {
    config: { get: (key: string, fallback: unknown = null): unknown => configMap[key] ?? fallback },
    events: { emit: (name: string, payload: Record<string, unknown>) => events.push({ name, payload }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (name: string, handler: ToolHandler) => void tools.set(name, handler) },
  };
  return { ctx, events, tools };
}

async function setup(host: MockHost): Promise<{ ctx: ReturnType<typeof makeCtx>['ctx']; events: ReturnType<typeof makeCtx>['events']; tools: ReturnType<typeof makeCtx>['tools']; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'));
  const { ctx, events, tools } = makeCtx({
    'catalog.baseUrl': host.url,
    'catalog.outputDir': join(dir, 'out'),
    'catalog.cacheDir': join(dir, 'var'),
  });
  const plugin = createPlugin();
  assert.equal(plugin.id, PLUGIN_ID);
  await plugin.register(ctx);
  return { ctx, events, tools, dir };
}

test('注册 5 个工具', async () => {
  const host = new MockHost(routeTable({}));
  await host.start();
  try {
    const { tools } = await setup(host);
    for (const name of ['catalog.discover', 'catalog.list', 'catalog.refresh', 'catalog.select', 'catalog.probe']) {
      assert.ok(tools.has(name), `应注册 ${name}`);
    }
  } finally {
    await host.close();
  }
});

test('catalog.discover：成功路径与事件载荷', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
    }),
  );
  await host.start();
  try {
    const { tools, events } = await setup(host);
    const res = await tools.get('catalog.discover')!({});
    assert.equal(res.ok, true);
    const data = res.data as { kind: string; modelCount: number; baseUrl: string };
    assert.equal(data.kind, 'bare');
    assert.equal(data.modelCount, 1);
    assert.equal(data.baseUrl, host.url);
    const updated = events.find((e) => e.name === 'catalog.updated');
    assert.ok(updated, '应发出 catalog.updated');
    assert.equal(updated!.payload.modelCount, 1);
  } finally {
    await host.close();
  }
});

test('catalog.discover：失败路径发出 catalog.failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-test-'));
  try {
    const { ctx, events, tools } = makeCtx({ 'catalog.outputDir': join(dir, 'out'), 'catalog.cacheDir': join(dir, 'var') });
    await createPlugin().register(ctx);
    const res = await tools.get('catalog.discover')!({});
    assert.equal(res.ok, false);
    assert.ok((res.error ?? '').includes('主机地址'), '应提示缺少主机地址');
    assert.ok(events.some((e) => e.name === 'catalog.failed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog.list：新鲜目录走缓存，过期目录重新发现', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] } },
    }),
  );
  await host.start();
  try {
    const { tools, dir } = await setup(host);
    // 首次：无缓存，重新发现（分类探测 + 采集各一次请求）
    const first = await tools.get('catalog.list')!({});
    assert.equal((first.data as { source: string }).source, 'fresh');
    const n1 = host.count('GET', '/v1/models');
    assert.equal(n1, 2);

    // 二次：命中新鲜缓存，不再请求主机
    const second = await tools.get('catalog.list')!({});
    assert.equal((second.data as { source: string }).source, 'cache');
    assert.equal(host.count('GET', '/v1/models'), n1, '缓存命中时不再请求主机');

    // 篡改 generatedAt 使其过期
    const stale: ModelEntry = {
      id: 'm1',
      provider: 'test',
      contextWindow: 1,
      maxOutput: 1,
      pricing: null,
      capabilities: emptyCapabilities(),
      aliases: [],
      status: 'active',
      origin: 'api',
      capturedAt: '2020-01-01T00:00:00.000Z',
      hostKind: 'bare',
      extra: {},
    };
    await writeCatalog(join(dir, 'out'), {
      host: { baseUrl: host.url, kind: 'bare' },
      entries: [stale],
      warnings: [],
      generatedAt: '2020-01-01T00:00:00.000Z',
    });
    const third = await tools.get('catalog.list')!({});
    assert.equal((third.data as { source: string }).source, 'fresh', '过期目录应重新发现');
    assert.ok(host.count('GET', '/v1/models') > n1);
  } finally {
    await host.close();
  }
});

test('catalog.select：按 id 过滤并生成片段', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] } },
    }),
  );
  await host.start();
  try {
    const { tools, dir } = await setup(host);
    await tools.get('catalog.discover')!({});
    const res = await tools.get('catalog.select')!({ ids: ['m1'] });
    assert.equal(res.ok, true);
    const data = res.data as { modelCount: number; file: string };
    assert.equal(data.modelCount, 1);
    const doc = JSON.parse(readFileSync(data.file, 'utf8'));
    assert.equal(doc.models.length, 1);
    assert.equal(doc.models[0]!.id, 'm1');

    const bad = await tools.get('catalog.select')!({ ids: ['nope'] });
    assert.equal(bad.ok, false, '不存在的 id 应报错');
    void dir;
  } finally {
    await host.close();
  }
});

test('catalog.probe：对单个模型执行探测并返回证据', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
      'POST /v1/chat/completions': { status: 400, body: { error: { message: 'not supported' } } },
    }),
  );
  await host.start();
  try {
    const { tools } = await setup(host);
    await tools.get('catalog.discover')!({});
    const res = await tools.get('catalog.probe')!({ model: 'm1' });
    assert.equal(res.ok, true);
    const data = res.data as { model: string; capabilities: Record<string, unknown> };
    assert.equal(data.model, 'm1');
    assert.equal(data.capabilities.toolCalling, false, '400 拒绝判不支持');
  } finally {
    await host.close();
  }
});
