import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockHost, routeTable } from './helpers/mock-host.js';
import { classifyHost } from '../src/core/classifier.js';
import { Vault } from '../src/storage/vault.js';

async function withVault<T>(fn: (vault: Vault) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'classify-test-'));
  const vault = new Vault(dir, { now: () => 0 });
  await vault.init();
  try {
    return await fn(vault);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('识别富元数据主机（/models 携带定价与上下文）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /models': {
        status: 200,
        body: {
          data: [{ id: 'm1', context_length: 128000, pricing: { prompt: '0.000002' } }],
        },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'augmented');
    });
  } finally {
    await host.close();
  }
});

test('识别标准兼容主机（仅最小字段）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'bare');
    });
  } finally {
    await host.close();
  }
});

test('识别倍率计价网关（/api/pricing）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
      'GET /api/pricing': {
        status: 200,
        body: { success: true, data: [{ model_name: 'm1', model_ratio: 1 }] },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'quota');
    });
  } finally {
    await host.close();
  }
});

test('识别 vLLM（/version 判别端点）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
      'GET /version': { status: 200, body: { version: 'v0.14.0' } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'vllm');
    });
  } finally {
    await host.close();
  }
});

test('识别能力标志代理（/model/info）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
      'GET /model/info': {
        status: 200,
        body: { data: [{ model_name: 'm1', model_info: { supports_function_calling: true } }] },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'flag');
    });
  } finally {
    await host.close();
  }
});

test('能力标志代理：/model/info 404 时回退 /v1/model/info', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
      'GET /v1/model/info': {
        status: 200,
        body: { data: [{ model_name: 'm1', model_info: {} }] },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'flag');
    });
  } finally {
    await host.close();
  }
});

test('识别 Ollama（/api/tags）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /api/tags': { status: 200, body: { models: [{ name: 'llama3.2' }] } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'ollama');
    });
  } finally {
    await host.close();
  }
});

test('全部端点 404 时报 unknown 并列出探测记录', async () => {
  const host = new MockHost(routeTable({}));
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d.kind, 'unknown');
      assert.ok(d.probes.length >= 4, '应记录至少 4 个探测端点');
    });
  } finally {
    await host.close();
  }
});

test('/v1/models 返回 401 时按标准兼容处理（路由存在但需鉴权）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 401, body: { error: { message: 'unauthorized' } } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(host.url, 'sk-test', vault, {});
      assert.equal(d.kind, 'bare');
    });
  } finally {
    await host.close();
  }
});

test('baseUrl 以 /v1 结尾时自动规整后探测', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d = await classifyHost(`${host.url}/v1`, undefined, vault, {});
      assert.equal(d.kind, 'bare');
      assert.equal(host.count('GET', '/v1/models'), 1);
    });
  } finally {
    await host.close();
  }
});

test('分类结果写入缓存，二次调用不再发请求', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { object: 'list', data: [{ id: 'm1' }] } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const d1 = await classifyHost(host.url, undefined, vault, {});
      const d2 = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d2.kind, d1.kind);
      assert.equal(host.count('GET', '/v1/models'), 1, '二次调用应命中缓存');
    });
  } finally {
    await host.close();
  }
});

test('unknown 分类结果不写缓存，下次重新探测', async () => {
  const host = new MockHost(routeTable({}));
  await host.start();
  try {
    await withVault(async (vault) => {
      const d1 = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d1.kind, 'unknown');
      const d2 = await classifyHost(host.url, undefined, vault, {});
      assert.equal(d2.kind, 'unknown');
      assert.ok(host.requests.length >= d1.probes.length + d2.probes.length, 'unknown 结果不应缓存（需重新探测）');
    });
  } finally {
    await host.close();
  }
});

test('缓存键区分鉴权态：无密钥判定 bare 后，带密钥重新探测', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 401, body: { error: { message: 'unauthorized' } } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const dAnon = await classifyHost(host.url, undefined, vault, {});
      assert.equal(dAnon.kind, 'bare', '无密钥 401 判定为 bare');
      const dAuth = await classifyHost(host.url, 'sk-ok', vault, {});
      assert.equal(dAuth.kind, 'bare');
      assert.equal(host.count('GET', '/v1/models'), 2, '带密钥后应重新探测（缓存键区分鉴权态）');
    });
  } finally {
    await host.close();
  }
});
