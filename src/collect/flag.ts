/** 能力标志代理采集器：/model/info（404 时回退 /v1/model/info），能力布尔族 + 每 token 价格。 */
import { getJson, HttpError } from '../util/http.js';
import { perTokenToPerMillion, type RawModel } from '../domain.js';
import type { Collector } from './registry.js';

interface ModelInfoItem {
  model_name?: unknown;
  model?: unknown;
  model_info?: Record<string, unknown>;
}

async function fetchInfo(
  baseUrl: string,
  apiKey: string | null | undefined,
  timeoutMs: number | undefined,
): Promise<unknown> {
  try {
    const res = await getJson(`${baseUrl}/model/info`, { apiKey, timeoutMs });
    return res.json;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 405)) {
      const res = await getJson(`${baseUrl}/v1/model/info`, { apiKey, timeoutMs });
      return res.json;
    }
    throw err;
  }
}

export const flagCollector: Collector = {
  kind: 'flag',
  needsAuth: true,
  async collect(baseUrl, apiKey, opts) {
    const json = await fetchInfo(baseUrl, apiKey, opts.timeoutMs);
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('/model/info 响应缺少 data 数组');
    if (data.length === 0) throw new Error('/model/info 返回了空的模型列表');

    const models: RawModel[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as ModelInfoItem;
      const id = typeof entry.model_name === 'string' ? entry.model_name : typeof entry.model === 'string' ? entry.model : '';
      if (id === '') continue;
      const info = entry.model_info ?? {};

      const pricing: RawModel['pricing'] = {};
      const convert = (target: keyof NonNullable<RawModel['pricing']>, src: unknown): void => {
        if (typeof src === 'number') {
          const converted = perTokenToPerMillion(src);
          if (converted !== null) pricing[target] = converted;
        }
      };
      convert('input', info.input_cost_per_token);
      convert('output', info.output_cost_per_token);
      convert('cacheRead', info.cache_read_input_token_cost);

      const capabilities: RawModel['capabilities'] = {};
      const bool = (target: keyof NonNullable<RawModel['capabilities']>, src: unknown): void => {
        if (typeof src === 'boolean') capabilities[target] = src;
      };
      bool('toolCalling', info.supports_function_calling);
      bool('structuredOutput', info.supports_response_schema);
      bool('vision', info.supports_vision);
      bool('parallelToolCalls', info.supports_parallel_function_calling);
      bool('streaming', info.supports_native_streaming);
      bool('reasoning', info.supports_reasoning);

      const maxInput = typeof info.max_input_tokens === 'number' ? info.max_input_tokens : undefined;
      const maxTokens = typeof info.max_tokens === 'number' ? info.max_tokens : undefined;
      const maxOutput = typeof info.max_output_tokens === 'number' ? info.max_output_tokens : maxTokens;

      const model: RawModel = {
        id,
        contextWindow: maxInput,
        maxOutput,
        capabilities,
        sourceUrl: `${baseUrl}/model/info`,
        extra: {
          mode: info.mode,
          supportedOpenAiParams: Array.isArray(info.supported_openai_params) ? info.supported_openai_params : undefined,
        },
      };
      if (Object.keys(pricing).length > 0) model.pricing = pricing;
      models.push(model);
    }
    if (models.length === 0) throw new Error('/model/info 未能解析出任何模型');
    return models;
  },
};
