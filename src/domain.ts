/**
 * 领域模型与换算规则
 *
 * 本模块定义目录条目的统一数据形状，以及所有"单位换算"逻辑：
 *   - 每 token 美元字符串/数字  ->  每百万 token 美元
 *   - 倍率计价（ratio）        ->  每百万 token 美元
 *   - 按次计价（per-call）     ->  单次美元
 *
 * 统一基准：目录内所有按量价格一律使用「每百万 token 的美元数」，按次价格使用「单次美元」。
 */

// ---------------------------------------------------------------------------
// 主机类型
// ---------------------------------------------------------------------------

/**
 * 主机类型：
 *  - bare      标准 OpenAI 兼容，/v1/models 仅返回最小字段（id/object/created/owned_by）
 *  - augmented 富元数据主机，/models 直接携带上下文长度、定价、参数清单
 *  - quota     倍率计价网关，通过 quota 定价接口返回倍率与分组倍率
 *  - flag      能力标志代理，通过 /model/info 返回能力布尔族与每 token 价格
 *  - ollama    Ollama 本地服务，/api/tags + /api/show
 *  - vllm      vLLM 推理服务，/v1/models 最小字段 + /version 判别
 */
export type HostKind =
  | 'bare'
  | 'augmented'
  | 'quota'
  | 'flag'
  | 'ollama'
  | 'vllm'
  | 'unknown';

export const HOST_KIND_LABELS: Record<HostKind, string> = {
  bare: '标准兼容（最小字段）',
  augmented: '富元数据',
  quota: '倍率计价网关',
  flag: '能力标志代理',
  ollama: 'Ollama',
  vllm: 'vLLM',
  unknown: '无法识别',
};

/** 无需鉴权即可探测/采集的主机类型（本地服务） */
export const KEYLESS_KINDS: ReadonlySet<HostKind> = new Set(['ollama', 'vllm']);

// ---------------------------------------------------------------------------
// 定价
// ---------------------------------------------------------------------------

/** 按量价格族（每百万 token 美元）。数值均已完成单位换算。 */
export interface PriceAmounts {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  internalReasoning: number | null;
}

/** 一个价格档位（用于动态定价 / 阶梯定价）。 */
export interface PriceTier {
  label: string;
  amounts: PriceAmounts;
  /** 时间档位：UTC 时段 [起, 止]，HH:MM 24 小时制，可跨午夜。 */
  windows?: Array<[string, string]>;
  /** 上下文档位：触发该档所需的最小上下文 token 数。 */
  minContext?: number;
}

export type PricingSourceKind = 'host' | 'override' | 'mirror' | 'builtin' | 'unknown';

export interface ModelPricing {
  billing: 'per-token' | 'per-call';
  unit: 'usd/1M' | 'usd/call';
  currency: 'USD';
  /** 当前生效（或基准档位）的价格。 */
  amounts: PriceAmounts;
  /** 附加价格档位（动态定价 / 上下文阶梯）。 */
  tiers: PriceTier[];
  dynamic: boolean;
  /** 按次计费时的单次价格（美元）。 */
  perCallUsd: number | null;
  /** 价格来源：主机接口 / 用户覆盖 / 外部镜像 / 内置默认表 / 未知。 */
  source: PricingSourceKind;
  /** 采集时间（ISO 8601）。 */
  capturedAt: string;
  /** 来源端点 URL（可为 null，如内置表）。 */
  sourceUrl: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// 能力
// ---------------------------------------------------------------------------

export interface Capabilities {
  toolCalling: boolean | null;
  structuredOutput: boolean | null;
  streaming: boolean | null;
  vision: boolean | null;
  parallelToolCalls: boolean | null;
  reasoning: boolean | null;
  responsesApi: boolean | null;
}

/** 可以实际探测验证的能力项（其余能力只能依赖元数据）。 */
export type ProbeableCap = 'toolCalling' | 'structuredOutput' | 'streaming';

export const PROBEABLE_CAPS: ProbeableCap[] = ['toolCalling', 'structuredOutput', 'streaming'];

export const CAP_LABELS: Record<keyof Capabilities, string> = {
  toolCalling: '工具调用',
  structuredOutput: '结构化输出',
  streaming: '流式',
  vision: '视觉',
  parallelToolCalls: '并行工具调用',
  reasoning: '推理',
  responsesApi: 'Responses API',
};

export function emptyCapabilities(): Capabilities {
  return {
    toolCalling: null,
    structuredOutput: null,
    streaming: null,
    vision: null,
    parallelToolCalls: null,
    reasoning: null,
    responsesApi: null,
  };
}

// ---------------------------------------------------------------------------
// 目录条目
// ---------------------------------------------------------------------------

export type EntryStatus = 'active' | 'deprecated' | 'unknown';
export type EntryOrigin = 'api' | 'builtin' | 'override' | 'mirror' | 'probe';

/** 归一化后的模型目录条目。 */
export interface ModelEntry {
  id: string;
  provider: string;
  contextWindow: number | null;
  maxOutput: number | null;
  pricing: ModelPricing | null;
  capabilities: Capabilities;
  aliases: string[];
  status: EntryStatus;
  /** 该条目主要事实的来源：主机接口 / 内置默认表 / 用户覆盖 / 外部镜像 / 探测。 */
  origin: EntryOrigin;
  capturedAt: string;
  hostKind: HostKind;
  /** 主机原始字段中无法归一化的部分，原样保留。 */
  extra: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 采集器产出的原始模型（尚未归一化）
// ---------------------------------------------------------------------------

export interface RawModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** 已完成单位换算的价格（每百万 token 美元）。 */
  pricing?: Partial<PriceAmounts>;
  billing?: 'per-token' | 'per-call';
  perCallUsd?: number | null;
  tiers?: PriceTier[];
  dynamic?: boolean;
  capabilities?: Partial<Capabilities>;
  status?: EntryStatus;
  note?: string;
  /** 价格/能力的来源端点 URL。 */
  sourceUrl?: string | null;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 换算：每 token -> 每百万
// ---------------------------------------------------------------------------

/**
 * 解析"每 token 美元"形式的字符串（可含 $ 前缀），换算为每百万 token 美元。
 * 例："0.00000056" -> 0.56；"$0.00003" -> 30；"0" -> 0。
 * 仅接受十进制非负数字（严格正则，拒绝十六进制/科学计数法等畸形输入），非法输入返回 null。
 */
export function perTokenToPerMillion(value: string | number): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return toPerMillion(value);
  }
  const cleaned = value.trim().replace(/^[$¥€]/, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return toPerMillion(n);
}

/** 每 token -> 每百万（含溢出防护）。 */
function toPerMillion(perToken: number): number | null {
  const perMillion = perToken * 1e6;
  if (!Number.isFinite(perMillion)) return null;
  return roundUsd(perMillion);
}

/** 四舍五入到 6 位小数（1e-6 美元 = 每百万 token 精度下限）。调用方需保证输入有限。 */
export function roundUsd(x: number): number {
  return Math.round((x + Number.EPSILON) * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// 换算：倍率计价
// ---------------------------------------------------------------------------

/**
 * 倍率计价换算（quota 体系，按量计费）：
 *   input  = modelRatio * 2.0 * groupRatio
 *   output = modelRatio * completionRatio * 2.0 * groupRatio
 * 其中 modelRatio = 1 表示 2 美元/百万 token；completionRatio 缺省为 1；groupRatio 缺省为 1。
 */
export function ratioToPerMillion(
  modelRatio: number,
  completionRatio: number | undefined,
  groupRatio: number | undefined,
): { input: number | null; output: number | null } {
  if (!Number.isFinite(modelRatio) || modelRatio < 0) {
    return { input: null, output: null };
  }
  const cr = completionRatio === undefined ? 1 : completionRatio;
  const gr = groupRatio === undefined ? 1 : groupRatio;
  if (!Number.isFinite(cr) || cr < 0 || !Number.isFinite(gr) || gr < 0) {
    return { input: null, output: null };
  }
  const input = modelRatio * 2 * gr;
  const output = modelRatio * cr * 2 * gr;
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return { input: null, output: null };
  }
  return {
    input: roundUsd(input),
    output: roundUsd(output),
  };
}

/** 倍率计价换算（按次计费）：perCall = modelPrice * groupRatio。 */
export function ratioToPerCall(
  modelPrice: number,
  groupRatio: number | undefined,
): number | null {
  if (!Number.isFinite(modelPrice) || modelPrice < 0) return null;
  const gr = groupRatio === undefined ? 1 : groupRatio;
  if (!Number.isFinite(gr) || gr < 0) return null;
  const perCall = modelPrice * gr;
  if (!Number.isFinite(perCall)) return null;
  return roundUsd(perCall);
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 规整 baseUrl：去尾部斜杠、去 /v1 后缀（假设 /v1 为 OpenAI 兼容路径）。
 *  注意去 /v1 后再清一次尾部斜杠，避免 "https://h.example.com//v1" 这类双重
 *  斜杠输入残留单个斜杠。 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`baseUrl 必须以 http:// 或 https:// 开头：${raw}`);
  }
  url = url.replace(/\/+$/, '');
  if (/\/v1$/i.test(url)) url = url.slice(0, -3);
  url = url.replace(/\/+$/, '');
  return url;
}

/** 由主机名推断 provider 标识。 */
export function providerSlug(baseUrl: string): string {
  try {
    // url.hostname 对 IPv6 回环返回 "[::1]"（带方括号），统一去括号后再匹配
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('192.168.') || host.startsWith('10.')) {
      return 'local';
    }
    const labels = host.split('.').filter(Boolean);
    const second = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return second ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
