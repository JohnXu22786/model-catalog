import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockHost, routeTable } from './helpers/mock-host.js';
import { collectorFor } from '../src/collect/registry.js';

test('标准采集：最小字段列表', async () => {
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
  try {
    const raw = await collectorFor('bare').collect(host.url, undefined, {});
    assert.deepEqual(raw.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
    assert.equal(raw[0]!.contextWindow, undefined);
    assert.equal(raw[0]!.pricing, undefined);
  } finally {
    await host.close();
  }
});

test('标准采集：兼容"模型名到对象"的字典形态', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: { 'm1': {}, 'm2': {} } } },
    }),
  );
  await host.start();
  try {
    const raw = await collectorFor('bare').collect(host.url, undefined, {});
    assert.deepEqual(raw.map((m) => m.id).sort(), ['m1', 'm2']);
  } finally {
    await host.close();
  }
});

test('富元数据采集：字段映射与单位换算', async () => {
  const host = new MockHost(
    routeTable({
      'GET /models': {
        status: 200,
        body: {
          data: [
            {
              id: 'vendor/model-1',
              name: 'Model One',
              context_length: 131072,
              top_provider: { max_completion_tokens: 8192, context_length: 131072 },
              pricing: {
                prompt: '0.000002',
                completion: '0.000008',
                input_cache_read: '0.0000002',
                input_cache_write: '0.0000008',
                internal_reasoning: '0',
              },
              supported_parameters: ['temperature', 'tools', 'tool_choice', 'parallel_tool_calls', 'structured_outputs', 'reasoning'],
              architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            },
          ],
        },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('augmented').collect(host.url, undefined, {});
    assert.equal(m!.id, 'vendor/model-1');
    assert.equal(m!.contextWindow, 131072);
    assert.equal(m!.maxOutput, 8192);
    assert.deepEqual(m!.pricing, {
      input: 2,
      output: 8,
      cacheRead: 0.2,
      cacheWrite: 0.8,
      internalReasoning: 0,
    });
    assert.deepEqual(m!.capabilities, {
      toolCalling: true,
      parallelToolCalls: true,
      structuredOutput: true,
      reasoning: true,
      vision: true,
    });
    assert.equal(m!.extra?.['name'], 'Model One');
  } finally {
    await host.close();
  }
});

test('富元数据采集：pricing 缺失字段不生成条目', async () => {
  const host = new MockHost(
    routeTable({
      'GET /models': {
        status: 200,
        body: { data: [{ id: 'm1', context_length: null, pricing: { prompt: '0' } }] },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('augmented').collect(host.url, undefined, {});
    assert.equal(m!.pricing?.input, 0);
    assert.equal(m!.pricing?.output, undefined);
  } finally {
    await host.close();
  }
});

test('倍率采集：ratio 与 groupRatio 换算', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }, { id: 'gpt-z' }] } },
      'GET /api/pricing': {
        status: 200,
        body: {
          success: true,
          group_ratio: { default: 2 },
          data: [
            { model_name: 'gpt-x', model_ratio: 0.5, completion_ratio: 2 },
            { model_name: 'gpt-y', model_ratio: 1, quota_type: 1, model_price: 0.05 },
          ],
        },
      },
    }),
  );
  await host.start();
  try {
    const raw = await collectorFor('quota').collect(host.url, undefined, {});
    const x = raw.find((m) => m.id === 'gpt-x')!;
    assert.deepEqual(x.pricing, { input: 2, output: 4 });
    assert.equal(x.billing, 'per-token');
    const y = raw.find((m) => m.id === 'gpt-y')!;
    assert.equal(y.billing, 'per-call');
    assert.equal(y.perCallUsd, 0.1);
    assert.equal(y.pricing, undefined);
    const z = raw.find((m) => m.id === 'gpt-z')!;
    assert.equal(z.pricing, undefined, '无定价条目的模型不生成价格');
  } finally {
    await host.close();
  }
});

test('倍率采集：group_ratio 为数字与缺省处理', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'a' }] } },
      'GET /api/pricing': {
        status: 200,
        body: { success: true, group_ratio: 1.5, data: [{ model_name: 'a', model_ratio: 1 }] },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('quota').collect(host.url, undefined, {});
    assert.deepEqual(m!.pricing, { input: 3, output: 3 });
  } finally {
    await host.close();
  }
});

test('倍率采集：兼容旧式 map 形态（/api/ratio_config）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'a' }] } },
      'GET /api/pricing': {
        status: 200,
        body: {
          success: true,
          data: { model_ratio: { a: 2 }, completion_ratio: { a: 1 } },
        },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('quota').collect(host.url, undefined, {});
    assert.deepEqual(m!.pricing, { input: 4, output: 4 });
  } finally {
    await host.close();
  }
});

test('能力标志采集：per-token 价格换算与能力布尔族', async () => {
  const host = new MockHost(
    routeTable({
      'GET /model/info': {
        status: 200,
        body: {
          data: [
            {
              model_name: 'big-model',
              model_info: {
                input_cost_per_token: 1.5e-7,
                output_cost_per_token: 6e-7,
                cache_read_input_token_cost: 7.5e-8,
                max_input_tokens: 128000,
                max_output_tokens: 16384,
                supports_function_calling: true,
                supports_response_schema: true,
                supports_vision: false,
                supports_parallel_function_calling: true,
                supports_native_streaming: true,
                supports_reasoning: true,
                mode: 'chat',
              },
            },
          ],
        },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('flag').collect(host.url, undefined, {});
    assert.deepEqual(m!.pricing, { input: 0.15, output: 0.6, cacheRead: 0.075 });
    assert.equal(m!.contextWindow, 128000);
    assert.equal(m!.maxOutput, 16384);
    assert.deepEqual(m!.capabilities, {
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      parallelToolCalls: true,
      streaming: true,
      reasoning: true,
    });
  } finally {
    await host.close();
  }
});

test('能力标志采集：max_output_tokens 缺失时回退 max_tokens', async () => {
  const host = new MockHost(
    routeTable({
      'GET /model/info': {
        status: 200,
        body: { data: [{ model_name: 'm', model_info: { max_tokens: 4096 } }] },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('flag').collect(host.url, undefined, {});
    assert.equal(m!.maxOutput, 4096);
  } finally {
    await host.close();
  }
});

test('倍率采集：缺字段的模型定价为未知（不产生零价）', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'no-ratio' }, { id: 'no-price' }, { id: 'bad-ratio' }] } },
      'GET /api/pricing': {
        status: 200,
        body: {
          success: true,
          data: [
            { model_name: 'no-ratio', quota_type: 0 },
            { model_name: 'no-price', quota_type: 1 },
            { model_name: 'bad-ratio', model_ratio: -2 },
          ],
        },
      },
    }),
  );
  await host.start();
  try {
    const raw = await collectorFor('quota').collect(host.url, undefined, {});
    const noRatio = raw.find((m) => m.id === 'no-ratio')!;
    assert.equal(noRatio.pricing, undefined, '缺 model_ratio 不应产生 0 价');
    assert.ok(noRatio.note?.includes('model_ratio'));
    const noPrice = raw.find((m) => m.id === 'no-price')!;
    assert.equal(noPrice.perCallUsd, undefined, '缺 model_price 不应产生价格字段（交由兜底链）');
    assert.ok(noPrice.note?.includes('model_price'));
    const badRatio = raw.find((m) => m.id === 'bad-ratio')!;
    assert.equal(badRatio.pricing, undefined, '非法 model_ratio 不应产生定价对象');
  } finally {
    await host.close();
  }
});

test('倍率采集：group_ratio 数字字符串宽容解析', async () => {
  const host = new MockHost(
    routeTable({
      'GET /v1/models': { status: 200, body: { data: [{ id: 'a' }] } },
      'GET /api/pricing': {
        status: 200,
        body: { success: true, group_ratio: '1.5', data: [{ model_name: 'a', model_ratio: 1 }] },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('quota').collect(host.url, undefined, {});
    assert.deepEqual(m!.pricing, { input: 3, output: 3 });
  } finally {
    await host.close();
  }
});

test('Ollama 采集：/api/show 能力与上下文长度', async () => {
  const host = new MockHost(
    routeTable({
      'GET /api/tags': {
        status: 200,
        body: {
          models: [
            { name: 'llama3.2:8b', details: { parameter_size: '8.0B' } },
            { name: 'plain-model' },
          ],
        },
      },
      'POST /api/show': {
        status: 200,
        body: {
          capabilities: ['completion', 'tools', 'vision', 'thinking'],
          model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 131072 },
        },
      },
    }),
  );
  await host.start();
  try {
    const raw = await collectorFor('ollama').collect(host.url, undefined, {});
    assert.equal(raw.length, 2);
    const llama = raw.find((m) => m.id === 'llama3.2:8b')!;
    assert.equal(llama.contextWindow, 131072);
    assert.deepEqual(llama.capabilities, {
      toolCalling: true,
      vision: true,
      reasoning: true,
    });
    assert.equal(llama.extra?.['size'], '8.0B');
  } finally {
    await host.close();
  }
});

test('Ollama 采集：context_length 键缺失时按后缀扫描', async () => {
  const host = new MockHost(
    routeTable({
      'GET /api/tags': { status: 200, body: { models: [{ name: 'm' }] } },
      'POST /api/show': {
        status: 200,
        body: { capabilities: ['completion'], model_info: { 'llama4.context_length': 4096 } },
      },
    }),
  );
  await host.start();
  try {
    const [m] = await collectorFor('ollama').collect(host.url, undefined, {});
    assert.equal(m!.contextWindow, 4096);
    assert.equal(m!.capabilities?.toolCalling, undefined, '无 tools 能力时保持未声明');
  } finally {
    await host.close();
  }
});
