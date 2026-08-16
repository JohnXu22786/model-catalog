import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockHost, routeTable, type MockHandler } from './helpers/mock-host.js';
import { verifyCapabilities } from '../src/probe/verifier.js';
import { Vault } from '../src/storage/vault.js';
import { emptyCapabilities, type ModelEntry } from '../src/domain.js';

const OK_CHAT = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const SSE_RESPONSE = ['data: {"choices":[{"delta":{"content":"a"},"index":0}]}', '', 'data: [DONE]', ''].join('\n');

/** 对流式探测返回 SSE，其余返回普通 JSON（模拟真实主机的行为差异）。 */
function chatHandler(plain: unknown): MockHandler {
  return (_method, _path, body) => {
    if ((body as { stream?: boolean })?.stream) {
      return { status: 200, body: SSE_RESPONSE, headers: { 'content-type': 'text/event-stream' } };
    }
    return { status: 200, body: plain };
  };
}

function entry(id: string): ModelEntry {
  return {
    id,
    provider: 'test',
    contextWindow: null,
    maxOutput: null,
    pricing: null,
    capabilities: emptyCapabilities(),
    aliases: [],
    status: 'unknown',
    origin: 'api',
    capturedAt: '2026-08-16T00:00:00.000Z',
    hostKind: 'bare',
    extra: {},
  };
}

async function withVault<T>(fn: (vault: Vault) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'verify-test-'));
  const vault = new Vault(dir, { now: () => 0 });
  await vault.init();
  try {
    return await fn(vault);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('工具调用探测：请求携带 tools 与强制 tool_choice，200 判支持', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': {
        status: 200,
        body: {
          ...OK_CHAT,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'tool_calls' }],
        },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      entries[0]!.capabilities.structuredOutput = true;
      entries[0]!.capabilities.streaming = true;
      const res = await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      const body = host.lastBody('POST', '/v1/chat/completions') as any;
      assert.ok(body.tools, '探测请求应包含 tools');
      assert.equal(body.tool_choice?.type, 'function');
      assert.equal(body.max_tokens, 1);
      assert.equal(entries[0]!.capabilities.toolCalling, true);
      assert.equal(res.applied, 1, '仅工具调用一项未知，只探测一次');
    });
  } finally {
    await host.close();
  }
});

test('结构化输出探测：请求携带 response_format json_object', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 200, body: OK_CHAT },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      const bodies = host.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body as any);
      const jsonProbe = bodies.find((b) => b.response_format);
      assert.ok(jsonProbe, '应发送 response_format 探测');
      assert.equal(jsonProbe.response_format.type, 'json_object');
      assert.ok(String(jsonProbe.messages?.[0]?.content).toLowerCase().includes('json'), 'JSON 模式要求消息中出现 json 字样');
      assert.equal(entries[0]!.capabilities.structuredOutput, true);
    });
  } finally {
    await host.close();
  }
});

test('流式探测：解析 SSE 直到 [DONE]', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
    '',
    'data: {"choices":[{"delta":{"content":"a"},"index":0}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': {
        status: 200,
        body: sse,
        headers: { 'content-type': 'text/event-stream' },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      const bodies = host.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body as any);
      assert.ok(bodies.some((b) => b.stream === true));
      assert.equal(entries[0]!.capabilities.streaming, true);
    });
  } finally {
    await host.close();
  }
});

test('400 "not supported" 判不支持', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': {
        status: 400,
        body: { error: { message: "'tools' is not supported with model version m1" } },
      },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      assert.equal(entries[0]!.capabilities.toolCalling, false);
      assert.equal(entries[0]!.capabilities.structuredOutput, false);
      assert.equal(entries[0]!.capabilities.streaming, false);
    });
  } finally {
    await host.close();
  }
});

test('422 判不支持；401 中止全部探测并告警', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 401, body: { error: { message: 'invalid api key' } } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1'), entry('m2')];
      const res = await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'bad', timeoutMs: 5000 }, vault);
      assert.equal(entries[0]!.capabilities.toolCalling, null);
      assert.ok(res.warnings.some((w) => w.includes('401')), '应告警鉴权失败');
      assert.equal(host.count('POST', '/v1/chat/completions'), 1, '401 后不应继续探测其余模型');
    });
  } finally {
    await host.close();
  }
});

test('结果按 (baseUrl, model) 缓存，二次运行不再发请求', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 200, body: OK_CHAT },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      const n = host.count('POST', '/v1/chat/completions');
      assert.ok(n >= 3, '一次运行应完成三项探测');
      const entries2 = [entry('m1')];
      const res2 = await verifyCapabilities(entries2, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      assert.equal(res2.applied, 0, '全部命中缓存');
      assert.equal(host.count('POST', '/v1/chat/completions'), n, '缓存命中时不应发请求');
      assert.equal(entries2[0]!.capabilities.toolCalling, true);
    });
  } finally {
    await host.close();
  }
});

test('never 模式完全不发请求', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 200, body: OK_CHAT },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'never', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      assert.equal(host.count('POST', '/v1/chat/completions'), 0);
    });
  } finally {
    await host.close();
  }
});

test('auto 模式：无密钥且非本地主机时不探测；本地主机（ollama）无密钥也探测', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 200, body: OK_CHAT },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const a = [entry('m1')];
      await verifyCapabilities(a, { baseUrl: host.url, kind: 'bare' }, { mode: 'auto', apiKey: null, timeoutMs: 5000 }, vault);
      assert.equal(host.count('POST', '/v1/chat/completions'), 0, '无密钥的标准主机跳过探测');

      const b = [entry('m1')];
      await verifyCapabilities(b, { baseUrl: host.url, kind: 'ollama' }, { mode: 'auto', apiKey: null, timeoutMs: 5000 }, vault);
      assert.ok(host.count('POST', '/v1/chat/completions') >= 3, '本地主机无密钥也可探测');
    });
  } finally {
    await host.close();
  }
});

test('429 限流判为瞬态错误而非不支持', async () => {
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 429, body: { error: { message: 'rate limited' } } },
    }),
  );
  await host.start();
  try {
    await withVault(async (vault) => {
      const entries = [entry('m1')];
      const res = await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      assert.equal(entries[0]!.capabilities.toolCalling, null, '限流不构成能力结论');
      assert.ok(res.warnings.some((w) => w.includes('探测失败')));
    });
  } finally {
    await host.close();
  }
});

test('探测错误结果以短 TTL 缓存，过期后重试', async () => {
  const clock = { n: 1000 };
  const dir = mkdtempSync(join(tmpdir(), 'verify-ttl-'));
  const vault = new Vault(dir, { now: () => clock.n });
  await vault.init();
  const host = new MockHost(
    routeTable({
      'POST /v1/chat/completions': { status: 500, body: { error: { message: 'boom' } } },
    }),
  );
  await host.start();
  try {
    const opts = { mode: 'always' as const, apiKey: 'sk-x', timeoutMs: 5000, probeTtlSec: 86400, errorTtlSec: 30 };
    const entries = [entry('m1')];
    await verifyCapabilities(entries, { baseUrl: host.url, kind: 'bare' }, opts, vault);
    const n1 = host.count('POST', '/v1/chat/completions');
    assert.ok(n1 >= 3);
    // 未过期：命中缓存，不发请求
    const e2 = [entry('m1')];
    await verifyCapabilities(e2, { baseUrl: host.url, kind: 'bare' }, opts, vault);
    assert.equal(host.count('POST', '/v1/chat/completions'), n1, '错误结果在短 TTL 内被缓存');
    // 超过错误 TTL：重新探测
    clock.n += 31_000;
    const e3 = [entry('m1')];
    await verifyCapabilities(e3, { baseUrl: host.url, kind: 'bare' }, opts, vault);
    assert.ok(host.count('POST', '/v1/chat/completions') >= n1 + 3, '错误 TTL 过期后重新探测');
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('已有元数据的能力不被重复探测', async () => {
  const host = new MockHost(chatHandler(OK_CHAT));
  await host.start();
  try {
    await withVault(async (vault) => {
      const e = entry('m1');
      e.capabilities.toolCalling = true;
      e.capabilities.structuredOutput = false;
      await verifyCapabilities(e ? [e] : [], { baseUrl: host.url, kind: 'bare' }, { mode: 'always', apiKey: 'sk-x', timeoutMs: 5000 }, vault);
      const bodies = host.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body as any);
      assert.equal(bodies.length, 1, '仅流式未知，只发一次探测');
      assert.equal(bodies[0]!.stream, true);
      assert.equal(e.capabilities.streaming, true);
    });
  } finally {
    await host.close();
  }
});
