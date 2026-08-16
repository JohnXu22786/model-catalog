/**
 * dsh 配置片段输出：out/dsh-models.json（schema: dsh/models/v1）。
 *
 * 该文件是 harness 可直接消费的模型配置：每条目包含 baseUrl、鉴权（仅环境变量引用，
 * 绝不出现密钥明文）、上下文/最大输出、定价族（每百万 token 美元 + 溯源）与能力标志。
 */
import { join } from 'node:path';
import { writeJsonAtomic } from '../util/fsx.js';
import type { HostKind, ModelEntry, PriceTier } from '../domain.js';

export interface SnippetModel {
  id: string;
  provider: string;
  baseUrl: string;
  auth: { kind: 'env'; name: string } | null;
  contextWindow: number | null;
  maxOutput: number | null;
  pricing: {
    billing: string;
    unit: string;
    currency: string;
    amounts: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; internalReasoning: number | null };
    tiers: PriceTier[];
    dynamic: boolean;
    perCallUsd: number | null;
    source: string;
    capturedAt: string;
    note: string | null;
  } | null;
  capabilities: {
    toolCalling: boolean | null;
    structuredOutput: boolean | null;
    streaming: boolean | null;
    vision: boolean | null;
    parallelToolCalls: boolean | null;
    reasoning: boolean | null;
    responsesApi: boolean | null;
  };
  aliases: string[];
  status: string;
}

export interface SnippetDocument {
  schema: 'dsh/models/v1';
  generatedAt: string;
  source: { baseUrl: string; kind: HostKind };
  models: SnippetModel[];
}

export async function writeSnippet(
  dir: string,
  meta: { baseUrl: string; hostKind: HostKind; apiKeyEnvName: string | null; entries: ModelEntry[]; generatedAt: string },
): Promise<string> {
  const models: SnippetModel[] = meta.entries.map((e) => ({
    id: e.id,
    provider: e.provider,
    baseUrl: meta.baseUrl,
    auth: meta.apiKeyEnvName ? { kind: 'env', name: meta.apiKeyEnvName } : null,
    contextWindow: e.contextWindow,
    maxOutput: e.maxOutput,
    pricing: e.pricing
      ? {
          billing: e.pricing.billing,
          unit: e.pricing.unit,
          currency: e.pricing.currency,
          amounts: e.pricing.amounts,
          tiers: e.pricing.tiers,
          dynamic: e.pricing.dynamic,
          perCallUsd: e.pricing.perCallUsd,
          source: e.pricing.source,
          capturedAt: e.pricing.capturedAt,
          note: e.pricing.note,
        }
      : null,
    capabilities: e.capabilities,
    aliases: e.aliases,
    status: e.status,
  }));

  const doc: SnippetDocument = {
    schema: 'dsh/models/v1',
    generatedAt: meta.generatedAt,
    source: { baseUrl: meta.baseUrl, kind: meta.hostKind },
    models,
  };
  const file = join(dir, 'dsh-models.json');
  await writeJsonAtomic(file, doc);
  return file;
}
