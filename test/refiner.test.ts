import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineModels, type RefineContext } from '../src/core/refiner.js';
import type { RawModel } from '../src/domain.js';

const capturedAt = '2026-08-16T08:00:00.000Z';

const ctx: RefineContext = {
  baseUrl: 'https://api.deepseek.com',
  hostKind: 'bare',
  capturedAt,
  apiKeyEnvName: null,
  supplements: {
    builtin: [
      {
        id: 'deepseek-v4-flash',
        contextWindow: 1048576,
        maxOutput: 393216,
        status: 'active',
        dynamic: true,
        tiers: [
          {
            label: 'off-peak',
            amounts: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: null, internalReasoning: null },
          },
          {
            label: 'peak',
            windows: [
              ['01:00', '04:00'],
              ['06:00', '10:00'],
            ],
            amounts: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: null, internalReasoning: null },
          },
        ],
        note: '动态定价示例',
        capabilities: {
          toolCalling: true,
          structuredOutput: true,
          parallelToolCalls: true,
          streaming: true,
          vision: false,
          reasoning: true,
          responsesApi: true,
        },
      },
      {
        id: 'deepseek-chat',
        status: 'deprecated',
        capabilities: { toolCalling: true },
      },
    ],
    overrides: [
      {
        id: 'm1',
        pricing: { input: 9, output: 9 },
        capabilities: { toolCalling: false },
      },
    ],
    mirror: [{ id: 'm1', pricing: { input: 5, output: 10 } }, { id: 'm2', pricing: { input: 1, output: 2 } }],
    aliases: { 'alias-m2': 'm2' },
  },
};

function refine(raw: RawModel[]): ReturnType<typeof refineModels> {
  return refineModels(raw, ctx);
}

test('主机自带定价时保留并标记来源为 host', () => {
  const { entries } = refine([{ id: 'x1', pricing: { input: 2, output: 4 } }]);
  const e = entries[0]!;
  assert.equal(e.pricing?.source, 'host');
  assert.deepEqual(e.pricing?.amounts, { input: 2, output: 4, cacheRead: null, cacheWrite: null, internalReasoning: null });
  assert.equal(e.origin, 'api');
});

test('内置默认表补齐最小字段模型的定价与能力', () => {
  const { entries } = refine([{ id: 'deepseek-v4-flash' }]);
  const e = entries[0]!;
  assert.equal(e.contextWindow, 1048576);
  assert.equal(e.maxOutput, 393216);
  assert.equal(e.pricing?.source, 'builtin');
  assert.equal(e.pricing?.dynamic, true);
  assert.equal(e.pricing?.tiers.length, 2);
  // 基准价 = 首档（off-peak）
  assert.deepEqual(e.pricing?.amounts, { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: null, internalReasoning: null });
  assert.equal(e.capabilities.toolCalling, true);
  assert.equal(e.capabilities.structuredOutput, true);
  assert.equal(e.pricing?.capturedAt, capturedAt);
});

test('主机显式能力优先于内置表（主机说 false 就 false）', () => {
  const { entries } = refine([
    { id: 'deepseek-v4-flash', capabilities: { toolCalling: false } },
  ]);
  assert.equal(entries[0]!.capabilities.toolCalling, false);
});

test('用户覆盖优先于主机与镜像', () => {
  const { entries } = refine([{ id: 'm1', pricing: { input: 2 } }]);
  const e = entries[0]!;
  assert.equal(e.pricing?.source, 'override');
  assert.equal(e.pricing?.amounts.input, 9);
  assert.equal(e.pricing?.amounts.output, 9);
  assert.equal(e.capabilities.toolCalling, false, '覆盖文件的能力逐字段替换');
});

test('用户覆盖的定价为字段级合并：未配置的价格项保留主机值', () => {
  const { entries } = refine([{ id: 'm1', pricing: { input: 2, output: 3 } }]);
  const p = entries[0]!.pricing!;
  assert.equal(p.source, 'override');
  assert.equal(p.amounts.input, 9, '覆盖的 input 生效');
  assert.equal(p.amounts.output, 9, '覆盖的 output 生效');
  // 用仅含 output 的覆盖条目验证合并
  const ctxPartial = {
    ...ctx,
    supplements: {
      ...ctx.supplements,
      overrides: [{ id: 'm1', pricing: { output: 5 } }],
    },
  };
  const { entries: e2 } = refineModels([{ id: 'm1', pricing: { input: 2, output: 3 } }], ctxPartial);
  assert.equal(e2[0]!.pricing?.amounts.input, 2, '主机 input 保留');
  assert.equal(e2[0]!.pricing?.amounts.output, 5, '覆盖的 output 生效');
});

test('覆盖仅配置 tiers 时基准价取自首档', () => {
  const ctxTiersOnly: RefineContext = {
    ...ctx,
    supplements: {
      ...ctx.supplements,
      overrides: [
        {
          id: 'm1',
          dynamic: true,
          tiers: [
            { label: 'off-peak', amounts: { input: 1, output: 2, cacheRead: null, cacheWrite: null, internalReasoning: null } },
            { label: 'peak', windows: [['01:00', '04:00']], amounts: { input: 2, output: 4, cacheRead: null, cacheWrite: null, internalReasoning: null } },
          ],
        },
      ],
    },
  };
  const { entries } = refineModels([{ id: 'm1' }], ctxTiersOnly);
  const p = entries[0]!.pricing!;
  assert.equal(p.source, 'override');
  assert.equal(p.dynamic, true);
  assert.equal(p.amounts.input, 1, '基准价取自 tiers 首档');
  assert.equal(p.amounts.output, 2);
  assert.equal(p.tiers.length, 2);
});

test('外部镜像兜底未知名模型', () => {
  const { entries } = refine([{ id: 'm2' }]);
  const e = entries[0]!;
  assert.equal(e.pricing?.source, 'mirror');
  assert.equal(e.pricing?.amounts.input, 1);
});

test('别名映射命中镜像条目', () => {
  const { entries } = refine([{ id: 'alias-m2' }]);
  const e = entries[0]!;
  assert.equal(e.pricing?.source, 'mirror');
  assert.equal(e.pricing?.amounts.input, 1);
  assert.deepEqual(e.aliases, ['m2']);
});

test('无任何来源时定价为 null 并产生告警', () => {
  const { entries, warnings } = refine([{ id: 'totally-unknown-model' }]);
  assert.equal(entries[0]!.pricing, null);
  assert.equal(entries[0]!.status, 'unknown');
  assert.ok(warnings.some((w) => w.includes('totally-unknown-model')), '应告警未知定价');
});

test('内置表的 deprecated 状态透传', () => {
  const { entries } = refine([{ id: 'deepseek-chat' }]);
  assert.equal(entries[0]!.status, 'deprecated');
  assert.equal(entries[0]!.capabilities.toolCalling, true);
});

test('provider 标识由 baseUrl 推断', () => {
  const { entries } = refine([{ id: 'deepseek-v4-flash' }]);
  assert.equal(entries[0]!.provider, 'deepseek');
});

test('主机提供部分价格时不再被补充来源覆盖（整体信任主机）', () => {
  const { entries } = refine([{ id: 'm2', pricing: { input: 2 } }]);
  assert.equal(entries[0]!.pricing?.amounts.input, 2);
  assert.equal(entries[0]!.pricing?.amounts.output, null, '缺项保持 null，不拼接镜像价');
  assert.equal(entries[0]!.pricing?.source, 'host', '镜像仅在主机完全无定价时兜底');
});
