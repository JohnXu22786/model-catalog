/**
 * 主机类型识别：通过一组轻量端点探测，判定目标主机的元数据风格。
 *
 * 探测顺序（首个命中即停止）：
 *   1. GET /models            —— 富元数据（带 context_length / pricing / supported_parameters）
 *   2. GET /v1/models          —— OpenAI 兼容系列
 *        ├─ GET /api/pricing   —— 倍率计价网关（quota 体系）
 *        ├─ GET /version       —— vLLM 判别端点
 *        ├─ GET /model/info    —— 能力标志代理（404 时回退 /v1/model/info）
 *        └─ （否则）           —— 标准兼容（最小字段）
 *   3. GET /api/tags           —— Ollama
 *   4. GET /model/info         —— 能力标志代理（无 /v1/models 的主机）
 *   5. 全部失败                —— unknown
 *
 * 错误码语义：404/405 视为"路由不存在"；401/403 视为"路由存在但需鉴权"（仍可作为判定依据）。
 * 分类结果写入缓存（detect::<baseUrl>，默认 TTL 1 小时）。
 */
import type { HostKind } from '../domain.js';
import { normalizeBaseUrl } from '../domain.js';
import { tryGetJson } from '../util/http.js';
import type { Vault } from '../storage/vault.js';

export interface Detection {
  kind: HostKind;
  probes: string[];
}

export interface ClassifyOptions {
  timeoutMs?: number;
  detectTtlSec?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_DETECT_TTL_SEC = 3600;

function hasAugmentedShape(json: unknown): boolean {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return false;
  return (
    first.context_length !== undefined ||
    first.pricing !== undefined ||
    first.supported_parameters !== undefined ||
    first.architecture !== undefined
  );
}

function hasQuotaShape(json: unknown): boolean {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    const first = data[0] as Record<string, unknown> | undefined;
    return (
      !!first &&
      typeof first === 'object' &&
      (first.model_ratio !== undefined || first.model_name !== undefined || first.quota_type !== undefined)
    );
  }
  // 旧式 map 形态：{ model_ratio: {...}, completion_ratio: {...}, model_price: {...} }
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    return d.model_ratio !== undefined || d.completion_ratio !== undefined || d.model_price !== undefined;
  }
  return false;
}

function hasFlagShape(json: unknown): boolean {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0] as Record<string, unknown> | undefined;
  return !!first && typeof first === 'object' && (first.model_info !== undefined || first.model_name !== undefined || first.model !== undefined);
}

export async function classifyHost(
  baseUrlRaw: string,
  apiKey: string | null | undefined,
  vault: Vault,
  opts: ClassifyOptions = {},
): Promise<Detection> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = (opts.detectTtlSec ?? DEFAULT_DETECT_TTL_SEC) * 1000;

  // 缓存键区分鉴权态：无密钥时 401 会被判定为 bare，带密钥后必须能重新探测
  const key = `detect::${baseUrl}::${apiKey ? 'auth' : 'anon'}`;
  const cached = vault.read<Detection>(key, ttlMs);
  if (cached) return cached;

  const probes: string[] = [];
  const cacheResult = (d: Detection): Detection => {
    // unknown 不缓存：主机瞬时故障不应造成 1 小时硬失败
    if (d.kind !== 'unknown') vault.write(key, d);
    return d;
  };

  // 1. 富元数据端点
  const enriched = await tryGetJson(`${baseUrl}/models`, apiKey, timeout);
  probes.push(`GET /models (${enriched ? `HTTP ${enriched.status}` : '网络失败'})`);
  if (enriched && enriched.status === 200 && hasAugmentedShape(enriched.json)) {
    const d: Detection = { kind: 'augmented', probes };
    return cacheResult(d);
  }

  // 2. OpenAI 兼容系列
  const list = await tryGetJson(`${baseUrl}/v1/models`, apiKey, timeout);
  probes.push(`GET /v1/models (${list ? `HTTP ${list.status}` : '网络失败'})`);
  if (list && (list.status === 200 || list.status === 401 || list.status === 403)) {
    if (list.status === 200) {
      // 次级探测：倍率网关
      const pricing = await tryGetJson(`${baseUrl}/api/pricing`, apiKey, timeout);
      probes.push(`GET /api/pricing (${pricing ? `HTTP ${pricing.status}` : '网络失败'})`);
      if (pricing && pricing.status === 200 && hasQuotaShape(pricing.json)) {
        const d: Detection = { kind: 'quota', probes };
        return cacheResult(d);
      }
      // vLLM 判别端点
      const version = await tryGetJson(`${baseUrl}/version`, apiKey, timeout);
      probes.push(`GET /version (${version ? `HTTP ${version.status}` : '网络失败'})`);
      if (
        version &&
        version.status === 200 &&
        version.json &&
        typeof (version.json as { version?: unknown }).version === 'string'
      ) {
        const d: Detection = { kind: 'vllm', probes };
        return cacheResult(d);
      }
      // 能力标志代理
      const info = await tryGetJson(`${baseUrl}/model/info`, apiKey, timeout);
      let infoJson: unknown = null;
      if (info && info.status !== 404 && info.status !== 405) {
        infoJson = info.status === 200 ? info.json : null;
        probes.push(`GET /model/info (HTTP ${info.status})`);
      } else {
        const info2 = await tryGetJson(`${baseUrl}/v1/model/info`, apiKey, timeout);
        probes.push(
          `GET /model/info (HTTP ${info ? info.status : '网络失败'}); GET /v1/model/info (${info2 ? `HTTP ${info2.status}` : '网络失败'})`,
        );
        if (info2 && info2.status === 200) infoJson = info2.json;
      }
      if (infoJson && hasFlagShape(infoJson)) {
        const d: Detection = { kind: 'flag', probes };
        return cacheResult(d);
      }
      const d: Detection = { kind: 'bare', probes };
      return cacheResult(d);
    }
    // 401/403：路由存在但需鉴权，按最保守的标准兼容处理
    const d: Detection = { kind: 'bare', probes };
    return cacheResult(d);
  }

  // 3. Ollama
  const tags = await tryGetJson(`${baseUrl}/api/tags`, apiKey, timeout);
  probes.push(`GET /api/tags (${tags ? `HTTP ${tags.status}` : '网络失败'})`);
  if (tags && tags.status === 200 && Array.isArray((tags.json as { models?: unknown })?.models)) {
    const d: Detection = { kind: 'ollama', probes };
    return cacheResult(d);
  }

  // 4. 能力标志代理（未暴露 /v1/models 的主机）
  const info = await tryGetJson(`${baseUrl}/model/info`, apiKey, timeout);
  let infoJson: unknown = null;
  if (info && info.status !== 404 && info.status !== 405) {
    infoJson = info.status === 200 ? info.json : null;
    probes.push(`GET /model/info (HTTP ${info.status})`);
  } else {
    const info2 = await tryGetJson(`${baseUrl}/v1/model/info`, apiKey, timeout);
    probes.push(
      `GET /model/info (HTTP ${info ? info.status : '网络失败'}); GET /v1/model/info (${info2 ? `HTTP ${info2.status}` : '网络失败'})`,
    );
    if (info2 && info2.status === 200) infoJson = info2.json;
  }
  if (infoJson && hasFlagShape(infoJson)) {
    const d: Detection = { kind: 'flag', probes };
    return cacheResult(d);
  }

  const d: Detection = { kind: 'unknown', probes };
  return cacheResult(d);
}
