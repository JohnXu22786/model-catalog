/** 富元数据采集器：GET /models 直接携带上下文长度、定价（每 token 美元字符串）、参数清单、模态。 */
import { getJson } from '../util/http.js';
import { perTokenToPerMillion, type RawModel } from '../domain.js';
import type { Collector } from './registry.js';

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x) => String(x)) : [];
}

export const augmentedCollector: Collector = {
  kind: 'augmented',
  needsAuth: true,
  async collect(baseUrl, apiKey, opts) {
    const res = await getJson(`${baseUrl}/models`, { apiKey, timeoutMs: opts.timeoutMs });
    const data = (res.json as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('/models 响应缺少 data 数组');
    if (data.length === 0) throw new Error('/models 返回了空的模型列表');

    const models: RawModel[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      if (id === '') continue;

      const pricingRaw = (m.pricing ?? {}) as Record<string, unknown>;
      const pricing: RawModel['pricing'] = {};
      const mapPricing = (target: string, src: string): void => {
        const v = pricingRaw[src];
        if (v !== undefined) {
          const converted = perTokenToPerMillion(String(v));
          if (converted !== null) pricing[target as keyof typeof pricing] = converted;
        }
      };
      mapPricing('input', 'prompt');
      mapPricing('output', 'completion');
      mapPricing('cacheRead', 'input_cache_read');
      mapPricing('cacheWrite', 'input_cache_write');
      mapPricing('internalReasoning', 'internal_reasoning');
      const hasPricing = Object.keys(pricing).length > 0;

      const params = strList(m.supported_parameters);
      const capabilities: RawModel['capabilities'] = {};
      if (params.includes('tools')) capabilities.toolCalling = true;
      if (params.includes('parallel_tool_calls')) capabilities.parallelToolCalls = true;
      if (params.includes('structured_outputs') || params.includes('response_format')) {
        capabilities.structuredOutput = true;
      }
      if (params.includes('reasoning') || params.includes('include_reasoning')) capabilities.reasoning = true;

      const arch = (m.architecture ?? {}) as Record<string, unknown>;
      const inputModalities = strList(arch.input_modalities);
      if (inputModalities.length > 0) capabilities.vision = inputModalities.includes('image');

      const topProvider = (m.top_provider ?? {}) as Record<string, unknown>;
      const maxOutput = num(topProvider.max_completion_tokens) ?? num(m.max_completion_tokens);

      const model: RawModel = {
        id,
        contextWindow: num(m.context_length),
        maxOutput,
        capabilities,
        sourceUrl: `${baseUrl}/models`,
        extra: { name: m.name, modalities: inputModalities, supportedParameters: params },
      };
      if (hasPricing) model.pricing = pricing;
      models.push(model);
    }
    if (models.length === 0) throw new Error('/models 未能解析出任何模型');
    return models;
  },
};
