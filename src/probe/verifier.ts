/**
 * 能力探测验证器：对元数据缺失的能力项发送最小化探测请求，实测主机是否支持。
 *
 * 探测项：工具调用、结构化输出、流式（vision/并行工具等无法低成本实测，仅依赖元数据）。
 *
 * 判读规则：
 *  - 2xx                -> 支持
 *  - 400/404/405/422    -> 不支持（错误体摘要作为证据）
 *  - 401/403            -> 鉴权失败，中止全部剩余探测（避免无效消耗）
 *  - 5xx/网络/超时      -> 判定为"未知"，保留 null，短暂缓存错误避免反复打
 *
 * 结果按 (baseUrl, model, 能力) 缓存（默认 24 小时；错误类结果 30 分钟）。
 * 探测模式：never 关闭；auto 仅在有密钥或本地主机（ollama/vllm）时执行；always 无条件执行。
 */
import { normalizeBaseUrl, PROBEABLE_CAPS, type Capabilities, type ModelEntry, type ProbeableCap } from '../domain.js';
import { KEYLESS_KINDS } from '../domain.js';
import { postJson } from '../util/http.js';
import type { Vault } from '../storage/vault.js';

export type ProbeMode = 'auto' | 'never' | 'always';

export interface VerifyOptions {
  mode: ProbeMode;
  apiKey: string | null;
  timeoutMs?: number;
  probeTtlSec?: number;
  errorTtlSec?: number;
}

export interface VerifyResult {
  applied: number;
  warnings: string[];
}

export interface ProbeEvidence {
  supported: boolean | null;
  evidence: string;
  at: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TTL_SEC = 24 * 3600;
const DEFAULT_ERROR_TTL_SEC = 30 * 60;

/** 探测用聊天请求（最小化：max_tokens 极小、消息极短）。
 *  注意：不携带 temperature 等采样参数——推理类模型可能拒绝部分参数，造成与能力无关的误判。 */
export function buildProbeBody(model: string, cap: ProbeableCap): Record<string, unknown> {
  const base = {
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 1,
    stream: false,
  };
  if (cap === 'toolCalling') {
    return {
      ...base,
      tools: [
        {
          type: 'function',
          function: {
            name: 'ping',
            description: 'Reply with a greeting.',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'ping' } },
    };
  }
  if (cap === 'structuredOutput') {
    // JSON 模式要求消息中出现 "json" 字样，否则会被拒绝（与能力无关）
    return {
      ...base,
      messages: [{ role: 'user', content: 'Return a JSON object: {"ok": true}' }],
      max_tokens: 16,
      response_format: { type: 'json_object' },
    };
  }
  // streaming
  return { ...base, stream: true };
}

function snippet(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function cacheKey(baseUrl: string, model: string, cap: ProbeableCap): string {
  return `probe::${normalizeBaseUrl(baseUrl)}::${model}::${cap}`;
}

export class ProbeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeAuthError';
  }
}

export async function verifyCapabilities(
  entries: ModelEntry[],
  host: { baseUrl: string; kind: ModelEntry['hostKind'] },
  opts: VerifyOptions,
  vault: Vault,
): Promise<VerifyResult> {
  const warnings: string[] = [];
  if (opts.mode === 'never' || entries.length === 0) return { applied: 0, warnings };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTtlMs = (opts.probeTtlSec ?? DEFAULT_PROBE_TTL_SEC) * 1000;
  const errorTtlMs = (opts.errorTtlSec ?? DEFAULT_ERROR_TTL_SEC) * 1000;

  const permitted = opts.mode === 'always' || Boolean(opts.apiKey) || KEYLESS_KINDS.has(host.kind);
  if (!permitted) {
    warnings.push(
      `能力探测已跳过：主机需要鉴权但未提供密钥（可设置密钥环境变量，或将探测模式改为 always）`,
    );
    return { applied: 0, warnings };
  }

  let applied = 0;
  outer: for (const entry of entries) {
    for (const cap of PROBEABLE_CAPS) {
      const current = entry.capabilities[cap];
      if (current !== null && current !== undefined) continue;
      const key = cacheKey(host.baseUrl, entry.id, cap);

      const cached = vault.read<ProbeEvidence>(key, probeTtlMs);
      if (cached) {
        applyEvidence(entry, cap, cached);
        continue;
      }

      try {
        const body = buildProbeBody(entry.id, cap);
        const res = await postJson(
          `${normalizeBaseUrl(host.baseUrl)}/v1/chat/completions`,
          body,
          {
            apiKey: opts.apiKey,
            timeoutMs,
            retries: 0,
            // 流式探测声明 SSE 内容类型，避免严格网关因 Accept 不符而拒绝
            headers: cap === 'streaming' ? { accept: 'text/event-stream' } : undefined,
          },
        );
        let supported = true;
        if (cap === 'streaming') {
          // 实测校验：真正的流式响应应包含 SSE 事件（data:）并以 [DONE] 收尾；
          // 只回普通 JSON 说明主机静默降级了 stream 参数，判为不支持
          const isSse = res.text.includes('data:') || res.text.includes('[DONE]');
          supported = isSse;
        }
        const evidence: ProbeEvidence = {
          supported,
          evidence: `HTTP ${res.status}${supported ? '' : '（非 SSE 响应）'}`,
          at: new Date().toISOString(),
        };
        vault.write(key, evidence);
        applyEvidence(entry, cap, evidence);
        applied += 1;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) {
          warnings.push(
            `能力探测中止：HTTP ${status}（${(err as Error).message}）。请检查密钥是否有效。`,
          );
          break outer;
        }
        const message = (err as Error).message;
        const transient =
          status === 429 || status === 408 || status === 409 || status === 425 ||
          // 参数形状问题（推理类模型对 max_tokens 等的拒绝）同样不是能力结论
          /max_tokens|max_completion_tokens|temperature/i.test(message);
        if (status !== undefined && status >= 400 && status < 500 && !transient) {
          // 400/404/405/422 等：请求被拒绝 = 该能力不可用（message 已含 "HTTP <status>:" 前缀）
          const evidence: ProbeEvidence = {
            supported: false,
            evidence: snippet(message),
            at: new Date().toISOString(),
          };
          vault.write(key, evidence);
          applyEvidence(entry, cap, evidence);
          applied += 1;
        } else {
          // 5xx / 网络 / 超时 / 限流 / 参数形状：保留未知，短暂缓存错误避免反复请求
          const evidence: ProbeEvidence = {
            supported: null,
            evidence: `error: ${snippet(message)}`,
            at: new Date().toISOString(),
          };
          vault.write(key, evidence, errorTtlMs);
          applyEvidence(entry, cap, evidence);
          warnings.push(`模型 ${entry.id} 的${cap}探测失败（${snippet(message)}），保持未知`);
          applied += 1;
        }
      }
    }
  }
  return { applied, warnings };
}

function applyEvidence(entry: ModelEntry, cap: ProbeableCap, evidence: ProbeEvidence): void {
  entry.capabilities[cap] = evidence.supported;
  const probeLog = (entry.extra['probe'] as Record<string, ProbeEvidence> | undefined) ?? {};
  probeLog[cap] = evidence;
  entry.extra['probe'] = probeLog;
}

/** 供报告使用的能力摘要（显式声明/实测/未知）。 */
export function capabilitySummary(caps: Capabilities): string {
  const labels: Array<[ProbeableCap | keyof Capabilities, string]> = [
    ['toolCalling', '工具'],
    ['structuredOutput', '结构化'],
    ['streaming', '流式'],
    ['vision', '视觉'],
    ['parallelToolCalls', '并行工具'],
    ['reasoning', '推理'],
    ['responsesApi', 'Responses'],
  ];
  const known = labels.filter(([k]) => caps[k] === true).map(([, l]) => l);
  if (known.length === 0) return '无已声明能力';
  return known.join('、');
}
