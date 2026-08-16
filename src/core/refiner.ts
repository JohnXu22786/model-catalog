/**
 * 归一化：把采集器的原始模型合并为统一目录条目。
 *
 * 定价/能力来源优先级：
 *   1. 主机接口提供的字段（最可信，整体采用）；
 *   2. 用户覆盖配置（overrides，替换语义——配置了什么就覆盖什么）；
 *   3. 外部镜像（mirror，仅填充缺失）；
 *   4. 内置默认表（builtin，仅填充缺失）；
 *   5. 仍缺失 -> 定价为 null 并产生告警。
 *
 * 补充来源的匹配：先按 id 精确匹配，再按别名映射（aliases: 别名 -> 规范名）解析后匹配。
 */
import type {
  Capabilities,
  EntryOrigin,
  EntryStatus,
  ModelEntry,
  ModelPricing,
  PriceAmounts,
  PriceTier,
  PricingSourceKind,
  RawModel,
} from '../domain.js';
import { emptyCapabilities, providerSlug } from '../domain.js';

/** 补充来源中的模型描述（内置表 / 覆盖 / 镜像共用结构）。 */
export interface SupplementModel {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: Partial<PriceAmounts>;
  perCallUsd?: number;
  billing?: 'per-token' | 'per-call';
  tiers?: PriceTier[];
  dynamic?: boolean;
  note?: string;
  status?: EntryStatus;
  capabilities?: Partial<Capabilities>;
  aliases?: string[];
}

export interface RefineContext {
  baseUrl: string;
  hostKind: ModelEntry['hostKind'];
  capturedAt: string;
  apiKeyEnvName: string | null;
  supplements: {
    builtin: SupplementModel[];
    overrides: SupplementModel[];
    mirror: SupplementModel[];
    aliases: Record<string, string>;
  };
}

export interface RefineResult {
  entries: ModelEntry[];
  warnings: string[];
}

const EMPTY_AMOUNTS: PriceAmounts = { input: null, output: null, cacheRead: null, cacheWrite: null, internalReasoning: null };

function norm(id: string): string {
  return id.trim().toLowerCase();
}

function pricingFromSupplement(t: SupplementModel, source: PricingSourceKind, ctx: RefineContext): ModelPricing {
  const amounts: PriceAmounts =
    t.tiers && t.tiers.length > 0
      ? { ...EMPTY_AMOUNTS, ...t.tiers[0]!.amounts }
      : { ...EMPTY_AMOUNTS, ...(t.pricing ?? {}) };
  return {
    billing: t.billing ?? 'per-token',
    unit: t.billing === 'per-call' ? 'usd/call' : 'usd/1M',
    currency: 'USD',
    amounts,
    tiers: t.tiers ?? [],
    dynamic: t.dynamic ?? false,
    perCallUsd: t.perCallUsd ?? null,
    source,
    capturedAt: ctx.capturedAt,
    sourceUrl: null,
    note: t.note ?? null,
  };
}

export function refineModels(rawModels: RawModel[], ctx: RefineContext): RefineResult {
  const warnings: string[] = [];
  const entries: ModelEntry[] = [];

  for (const raw of rawModels) {
    const id = raw.id;
    const canonical = ctx.supplements.aliases[norm(id)] ?? id;
    const normId = norm(id);

    const override = ctx.supplements.overrides.find(
      (o) =>
        norm(o.id) === normId ||
        norm(o.id) === norm(canonical) ||
        (o.aliases ?? []).some((a) => norm(a) === normId),
    );
    const mirror = ctx.supplements.mirror.find(
      (m) => norm(m.id) === normId || norm(m.id) === norm(canonical) || (m.aliases ?? []).some((a) => norm(a) === normId),
    );
    const builtin = ctx.supplements.builtin.find(
      (b) => norm(b.id) === normId || norm(b.id) === norm(canonical) || (b.aliases ?? []).some((a) => norm(a) === normId),
    );

    let origin: EntryOrigin = 'api';
    if (override) origin = 'override';
    else if (mirror) origin = 'mirror';
    else if (builtin) origin = 'builtin';

    // ---- 上下文 / 最大输出：覆盖可替换，补充仅填空 ----
    let contextWindow: number | null = raw.contextWindow ?? null;
    let maxOutput: number | null = raw.maxOutput ?? null;
    if (override?.contextWindow !== undefined) contextWindow = override.contextWindow;
    if (override?.maxOutput !== undefined) maxOutput = override.maxOutput;
    if (contextWindow === null && mirror?.contextWindow !== undefined) contextWindow = mirror.contextWindow;
    if (maxOutput === null && mirror?.maxOutput !== undefined) maxOutput = mirror.maxOutput;
    if (contextWindow === null && builtin?.contextWindow !== undefined) contextWindow = builtin.contextWindow;
    if (maxOutput === null && builtin?.maxOutput !== undefined) maxOutput = builtin.maxOutput;

    // ---- 能力：覆盖逐字段替换（用户手动修正优先于主机声明）；补充仅填空 ----
    const capabilities: Capabilities = emptyCapabilities();
    for (const key of Object.keys(capabilities) as Array<keyof Capabilities>) {
      const overrideValue = override?.capabilities?.[key];
      if (overrideValue !== undefined) {
        capabilities[key] = overrideValue;
        continue;
      }
      const rawValue = raw.capabilities?.[key];
      if (rawValue !== undefined && rawValue !== null) {
        capabilities[key] = rawValue;
        continue;
      }
      const mirrorValue = mirror?.capabilities?.[key];
      if (mirrorValue !== undefined && mirrorValue !== null) {
        capabilities[key] = mirrorValue;
        continue;
      }
      const builtinValue = builtin?.capabilities?.[key];
      if (builtinValue !== undefined && builtinValue !== null) {
        capabilities[key] = builtinValue;
      }
    }

    // ---- 定价：覆盖为字段级合并（只替换配置到的价格项，其余来源的值保留）；
    //      镜像/内置表仅在主机完全无定价时兜底 ----
    let pricing: ModelPricing | null = null;
    let pricingKnown = false;
    if (raw.pricing !== undefined || raw.perCallUsd !== undefined) {
      pricing = {
        billing: raw.billing ?? 'per-token',
        unit: raw.billing === 'per-call' ? 'usd/call' : 'usd/1M',
        currency: 'USD',
        amounts: { ...EMPTY_AMOUNTS, ...(raw.pricing ?? {}) },
        tiers: raw.tiers ?? [],
        dynamic: raw.dynamic ?? false,
        perCallUsd: raw.perCallUsd ?? null,
        source: 'host',
        capturedAt: ctx.capturedAt,
        sourceUrl: raw.sourceUrl ?? null,
        note: raw.note ?? null,
      };
      pricingKnown = true;
    }
    if (
      override &&
      (override.pricing !== undefined || override.perCallUsd !== undefined || (override.tiers ?? []).length > 0)
    ) {
      // 基准 = 主机定价（若有）否则由覆盖自身构建（tiers 首档即基准价）
      const base = pricing ?? pricingFromSupplement(override, 'override', ctx);
      pricing = {
        ...base,
        amounts: { ...base.amounts, ...(override.pricing ?? {}) },
        billing: override.billing ?? base.billing,
        unit: override.billing === 'per-call' ? 'usd/call' : base.unit,
        tiers: override.tiers ?? base.tiers,
        dynamic: override.dynamic ?? base.dynamic,
        perCallUsd: override.perCallUsd ?? base.perCallUsd,
        note: override.note ?? base.note,
        source: 'override',
        capturedAt: ctx.capturedAt,
        sourceUrl: base.sourceUrl,
      };
      pricingKnown = true;
    }
    if (!pricingKnown) {
      if (mirror && (mirror.pricing !== undefined || mirror.perCallUsd !== undefined || (mirror.tiers ?? []).length > 0)) {
        pricing = pricingFromSupplement(mirror, 'mirror', ctx);
        pricingKnown = true;
      } else if (
        builtin &&
        (builtin.pricing !== undefined || builtin.perCallUsd !== undefined || (builtin.tiers ?? []).length > 0)
      ) {
        pricing = pricingFromSupplement(builtin, 'builtin', ctx);
        pricingKnown = true;
      }
    }
    if (!pricingKnown) {
      warnings.push(`模型 ${id} 未找到任何定价来源，价格标记为未知`);
    }

    // ---- 状态与别名 ----
    let status: EntryStatus = raw.status ?? 'unknown';
    if (override?.status !== undefined) status = override.status;
    if (mirror?.status !== undefined && status === 'unknown') status = mirror.status;
    if (builtin?.status !== undefined && status === 'unknown') status = builtin.status;
    const aliases: string[] = [];
    const supplement = override ?? mirror ?? builtin;
    if (supplement && norm(supplement.id) !== normId && norm(supplement.id) !== norm(canonical)) {
      aliases.push(supplement.id);
    }
    if (norm(canonical) !== normId && !aliases.includes(canonical)) {
      aliases.push(canonical);
    }
    for (const [alias, target] of Object.entries(ctx.supplements.aliases)) {
      if (norm(alias) === normId) continue; // 别名就是条目自身，无需重复
      if (norm(target) === normId || norm(target) === norm(canonical)) {
        if (!aliases.includes(alias)) aliases.push(alias);
      }
    }

    entries.push({
      id,
      provider: providerSlug(ctx.baseUrl),
      contextWindow,
      maxOutput,
      pricing,
      capabilities,
      aliases,
      status,
      origin,
      capturedAt: ctx.capturedAt,
      hostKind: ctx.hostKind,
      extra: { ...(raw.extra ?? {}) },
    });
  }

  return { entries, warnings };
}
