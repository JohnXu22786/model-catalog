/**
 * 倍率计价网关采集器：quota 定价接口 + /v1/models 模型清单。
 *
 * 支持两种响应形态：
 *  - 数组形态：data 为 [{ model_name, quota_type, model_ratio, completion_ratio, model_price, ... }]
 *  - 旧式 map 形态：data 为 { model_ratio: {id: ratio}, completion_ratio: {...}, model_price: {...} }
 *
 * 换算（quota_type=0，按量）：
 *   input_per_1m  = model_ratio * 2.0 * group_ratio
 *   output_per_1m = model_ratio * completion_ratio * 2.0 * group_ratio
 * quota_type=1（按次）：per_call_usd = model_price * group_ratio
 * group_ratio 为数字时直接使用；为映射时取 default 组（其余组倍率可在覆盖配置中修正）。
 */
import { getJson } from '../util/http.js';
import { ratioToPerCall, ratioToPerMillion, type RawModel } from '../domain.js';
import { pickId } from './ids.js';
import type { Collector } from './registry.js';

interface QuotaEntry {
  model_name?: unknown;
  quota_type?: unknown;
  model_ratio?: unknown;
  completion_ratio?: unknown;
  model_price?: unknown;
}

function extractGroupRatio(json: unknown): number {
  const gr = (json as { group_ratio?: unknown })?.group_ratio;
  if (typeof gr === 'number' && Number.isFinite(gr)) return gr;
  // 宽容处理数字字符串（部分网关的序列化习惯）
  if (typeof gr === 'string' && gr.trim() !== '' && Number.isFinite(Number(gr))) {
    return Number(gr);
  }
  if (gr && typeof gr === 'object') {
    const map = gr as Record<string, unknown>;
    const v = map.default ?? map.default_group;
    const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(num)) return num;
  }
  return 1;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** 把数组/旧式 map 两种形态统一为条目列表（对非对象输入做类型守卫）。 */
function extractQuotaEntries(data: unknown): QuotaEntry[] {
  if (Array.isArray(data)) {
    return data.filter((x): x is QuotaEntry => !!x && typeof x === 'object');
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const ratioMap = d.model_ratio;
    if (!ratioMap || typeof ratioMap !== 'object' || Array.isArray(ratioMap)) return [];
    const r = ratioMap as Record<string, unknown>;
    const completionMap = d.completion_ratio && typeof d.completion_ratio === 'object' && !Array.isArray(d.completion_ratio)
      ? (d.completion_ratio as Record<string, unknown>)
      : {};
    const priceMap = d.model_price && typeof d.model_price === 'object' && !Array.isArray(d.model_price)
      ? (d.model_price as Record<string, unknown>)
      : {};
    const entries: QuotaEntry[] = [];
    for (const key of Object.keys(r)) {
      entries.push({
        model_name: key,
        model_ratio: r[key],
        completion_ratio: completionMap[key],
        model_price: priceMap[key],
      });
    }
    return entries;
  }
  return [];
}

export const quotaCollector: Collector = {
  kind: 'quota',
  needsAuth: true,
  async collect(baseUrl, apiKey, opts) {
    const [modelsRes, pricingRes] = await Promise.all([
      getJson(`${baseUrl}/v1/models`, { apiKey, timeoutMs: opts.timeoutMs }),
      getJson(`${baseUrl}/api/pricing`, { apiKey, timeoutMs: opts.timeoutMs }).catch(() => {
        // 某些网关旧版本使用 /api/ratio_config
        return getJson(`${baseUrl}/api/ratio_config`, { apiKey, timeoutMs: opts.timeoutMs });
      }),
    ]);

    const data = (modelsRes.json as { data?: unknown })?.data;
    const ids: string[] = [];
    if (Array.isArray(data)) {
      ids.push(...data.map(pickId).filter((x): x is string => x !== null));
    } else if (data && typeof data === 'object') {
      ids.push(...Object.keys(data as Record<string, unknown>));
    }
    if (ids.length === 0) throw new Error('/v1/models 返回了空的模型列表');

    const groupRatio = extractGroupRatio(pricingRes.json);
    const entries = extractQuotaEntries((pricingRes.json as { data?: unknown })?.data);
    const byName = new Map<string, QuotaEntry>();
    for (const e of entries) {
      if (typeof e.model_name === 'string') byName.set(e.model_name, e);
    }

    const models: RawModel[] = [];
    for (const id of ids) {
      const entry = byName.get(id);
      const model: RawModel = { id, sourceUrl: `${baseUrl}/api/pricing` };
      if (entry) {
        const quotaType = toNumber(entry.quota_type);
        if (quotaType === 1) {
          const price = toNumber(entry.model_price);
          if (price === undefined) {
            // 缺 model_price：不产生任何价格字段，交由归一化兜底链；note 说明原因
            model.note = '该模型按次计费但缺少 model_price，定价未知';
          } else {
            model.billing = 'per-call';
            model.perCallUsd = ratioToPerCall(price, groupRatio);
          }
        } else {
          const ratio = toNumber(entry.model_ratio);
          if (ratio === undefined) {
            model.note = '该模型缺少有效的 model_ratio，定价未知';
          } else {
            const converted = ratioToPerMillion(ratio, toNumber(entry.completion_ratio), groupRatio);
            if (converted.input === null || converted.output === null) {
              model.note = '该模型缺少有效的 model_ratio，定价未知';
            } else {
              model.billing = 'per-token';
              model.pricing = converted;
            }
          }
        }
      }
      models.push(model);
    }
    return models;
  },
};
