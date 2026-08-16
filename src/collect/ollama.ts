/** Ollama 采集器：/api/tags 列表 + /api/show 细节（能力、上下文长度）。 */
import { getJson, postJson } from '../util/http.js';
import { mapLimit } from '../util/async.js';
import type { RawModel } from '../domain.js';
import type { Collector } from './registry.js';

interface TagItem {
  name?: unknown;
  details?: Record<string, unknown>;
  digest?: unknown;
  size?: unknown;
}

/** 从 model_info 中找上下文长度：优先 <arch>.context_length，否则扫描后缀匹配的键。 */
function extractContextLength(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') return undefined;
  const info = modelInfo as Record<string, unknown>;
  const arch = info['general.architecture'];
  if (typeof arch === 'string') {
    const direct = info[`${arch}.context_length`];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  }
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export const ollamaCollector: Collector = {
  kind: 'ollama',
  needsAuth: false,
  async collect(baseUrl, apiKey, opts) {
    const res = await getJson(`${baseUrl}/api/tags`, { apiKey, timeoutMs: opts.timeoutMs });
    const list = (res.json as { models?: unknown })?.models;
    if (!Array.isArray(list)) throw new Error('/api/tags 响应缺少 models 数组');
    if (list.length === 0) throw new Error('/api/tags 返回了空的模型列表');

    const tags = list.filter((x): x is TagItem => !!x && typeof x === 'object');
    const details = await mapLimit(tags, opts.concurrency ?? 4, async (tag) => {
      const name = tag.name;
      if (typeof name !== 'string') return { tag, show: null as unknown };
      try {
        const show = await postJson(`${baseUrl}/api/show`, { name }, { apiKey, timeoutMs: opts.timeoutMs });
        return { tag, show: show.json };
      } catch {
        return { tag, show: null };
      }
    });

    const models: RawModel[] = [];
    for (const { tag, show } of details) {
      const name = tag.name;
      if (typeof name !== 'string' || name === '') continue;
      const capabilities: RawModel['capabilities'] = {};
      if (show && typeof show === 'object') {
        const caps = (show as { capabilities?: unknown }).capabilities;
        if (Array.isArray(caps)) {
          const set = caps.map((x) => String(x));
          if (set.includes('tools')) capabilities.toolCalling = true;
          if (set.includes('vision')) capabilities.vision = true;
          if (set.includes('thinking')) capabilities.reasoning = true;
        }
      }
      const model: RawModel = {
        id: name,
        capabilities,
        contextWindow: show ? extractContextLength((show as { model_info?: unknown }).model_info) : undefined,
        sourceUrl: `${baseUrl}/api/show`,
        extra: {
          size: (tag.details as Record<string, unknown> | undefined)?.parameter_size,
          family: (tag.details as Record<string, unknown> | undefined)?.family,
          quantization: (tag.details as Record<string, unknown> | undefined)?.quantization_level,
          digest: tag.digest,
        },
      };
      models.push(model);
    }
    if (models.length === 0) throw new Error('/api/tags 未能解析出任何模型');
    return models;
  },
};
