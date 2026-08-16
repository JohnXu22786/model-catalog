import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockHost, routeTable } from './helpers/mock-host.js';
import { Vault } from '../src/storage/vault.js';
import { discover, type DiscoverOptions } from '../src/core/orchestrator.js';

test('端到端：标准兼容主机 + 内置默认表补齐 DeepSeek 定价', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': {
        status: 200,
        body: {
          object: 'list',
          data: [
            { id: 'deepseek-v4-flash', object: 'model', created: 1, owned_by: 'ds' },
            { id: 'deepseek-v4-pro', object: 'model', created: 1, owned_by: 'ds' },
          ],
        },
      },
    }),
  );
  await host.start();
  const dir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  try {
    const vault = new Vault(join(dir, 'var'), { now: () => 0 });
    await vault.init();
    const settings: DiscoverOptions['settings'] = {
      baseUrl: null,
      probe: 'never',
      catalogTtlSec: 900,
      probeTtlSec: 86400,
      detectTtlSec: 3600,
      externalUrl: null,
      outputDir: join(dir, 'out'),
      cacheDir: join(dir, 'var'),
      concurrency: 4,
      httpTimeoutMs: 5000,
      apiKeyEnv: null,
      kindHint: null,
    };
    const result = await discover({
      baseUrl: host.url,
      apiKey: null,
      settings,
      vault,
    });
    assert.equal(result.detection.kind, 'bare');
    assert.equal(result.entries.length, 2);

    const flash = result.entries.find((e) => e.id === 'deepseek-v4-flash')!;
    assert.equal(flash.contextWindow, 1048576);
    assert.equal(flash.maxOutput, 393216);
    assert.equal(flash.pricing?.source, 'builtin');
    assert.equal(flash.pricing?.dynamic, true);
    assert.equal(flash.capabilities.toolCalling, true);
    assert.equal(flash.provider, 'local', '本地测试主机的 provider 应为 local');
    assert.equal(flash.pricing?.amounts.output, 0.66);

    const pro = result.entries.find((e) => e.id === 'deepseek-v4-pro')!;
    assert.equal(pro.pricing?.amounts.output, 1.98);

    // 输出三件套
    assert.ok(existsSync(join(dir, 'out', 'catalog.json')));
    assert.ok(existsSync(join(dir, 'out', 'report.md')));
    const snippetPath = join(dir, 'out', 'dsh-models.json');
    assert.ok(existsSync(snippetPath));
    const snippet = JSON.parse(readFileSync(snippetPath, 'utf8'));
    assert.equal(snippet.schema, 'dsh/models/v1');
    assert.equal(snippet.models.length, 2);
    assert.equal(snippet.models[0]!.auth, null, '未配置密钥环境变量时 auth 为空');
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：外部镜像不可达/结构非法时降级并告警', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'deepseek-v4-flash' }] } },
    }),
  );
  await host.start();
  const dir = mkdtempSync(join(tmpdir(), 'e2e3-test-'));
  try {
    const vault = new Vault(join(dir, 'var'), { now: () => 0 });
    await vault.init();
    const base = {
      baseUrl: null,
      probe: 'never' as const,
      catalogTtlSec: 900,
      probeTtlSec: 86400,
      detectTtlSec: 3600,
      outputDir: join(dir, 'out'),
      cacheDir: join(dir, 'var'),
      concurrency: 4,
      httpTimeoutMs: 3000,
      apiKeyEnv: null,
      kindHint: null,
    };
    // 1. 不可达端口
    const r1 = await discover({ baseUrl: host.url, apiKey: null, settings: { ...base, externalUrl: 'http://127.0.0.1:1/mirror.json' }, vault });
    assert.ok(r1.warnings.some((w) => w.includes('镜像拉取失败')), '不可达镜像应告警');
    assert.equal(r1.entries.length, 1, '镜像失败不影响发现');
    assert.equal(r1.entries[0]!.pricing?.source, 'builtin', '回退到内置默认表');
    // 2. 结构非法
    const host2 = new MockHost(routeTable({ 'GET /mirror.json': { status: 200, body: { unexpected: true } } }));
    await host2.start();
    try {
      const r2 = await discover({ baseUrl: host.url, apiKey: null, settings: { ...base, externalUrl: `${host2.url}/mirror.json` }, vault });
      assert.ok(r2.warnings.some((w) => w.includes('结构无法识别')), '非法结构镜像应告警');
    } finally {
      await host2.close();
    }
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：富元数据主机直接采用主机定价', async () => {
  const host = new MockHost(
    routeTable({
      'GET /models': {
        status: 200,
        body: {
          data: [
            {
              id: 'm1',
              context_length: 65536,
              top_provider: { max_completion_tokens: 4096 },
              pricing: { prompt: '0.000001', completion: '0.000004', input_cache_read: '0.0000001' },
              supported_parameters: ['tools', 'parallel_tool_calls', 'structured_outputs', 'response_format'],
              architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            },
          ],
        },
      },
    }),
  );
  await host.start();
  const dir = mkdtempSync(join(tmpdir(), 'e2e2-test-'));
  try {
    const vault = new Vault(join(dir, 'var'), { now: () => 0 });
    await vault.init();
      const result = await discover({
        baseUrl: host.url,
        apiKey: 'sk-test',
        settings: {
          baseUrl: null,
          probe: 'never',
          catalogTtlSec: 900,
          probeTtlSec: 86400,
          detectTtlSec: 3600,
          externalUrl: null,
          outputDir: join(dir, 'out'),
          cacheDir: join(dir, 'var'),
          concurrency: 4,
          httpTimeoutMs: 5000,
          apiKeyEnv: null,
          kindHint: null,
        },
        vault,
      });
    assert.equal(result.detection.kind, 'augmented');
    const m = result.entries[0]!;
    assert.equal(m.pricing?.source, 'host');
    assert.equal(m.pricing?.amounts.input, 1);
    assert.equal(m.pricing?.amounts.output, 4);
    assert.equal(m.pricing?.amounts.cacheRead, 0.1);
    assert.equal(m.capabilities.toolCalling, true);
    assert.equal(m.capabilities.structuredOutput, true);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
