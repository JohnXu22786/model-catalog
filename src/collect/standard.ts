/** 标准兼容采集器：/v1/models 最小字段（bare 与 vllm 共用）。 */
import { getJson } from '../util/http.js';
import { pickId } from './ids.js';
import type { Collector } from './registry.js';

export const standardCollector: Collector = {
  kind: 'bare',
  needsAuth: true,
  async collect(baseUrl, apiKey, opts) {
    const res = await getJson(`${baseUrl}/v1/models`, { apiKey, timeoutMs: opts.timeoutMs });
    const data = (res.json as { data?: unknown })?.data;
    if (Array.isArray(data)) {
      const ids = data.map(pickId).filter((x): x is string => x !== null);
      if (ids.length === 0) {
        throw new Error('/v1/models 返回了空的模型列表');
      }
      return ids.map((id) => ({ id }));
    }
    if (data && typeof data === 'object') {
      const ids = Object.keys(data as Record<string, unknown>);
      if (ids.length === 0) throw new Error('/v1/models 返回了空的模型列表');
      return ids.map((id) => ({ id }));
    }
    throw new Error('/v1/models 响应缺少 data 数组');
  },
};
