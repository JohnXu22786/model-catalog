/**
 * 编排器：把「识别 -> 采集 -> 归一化 -> 探测 -> 输出」串成一次发现流程。
 * 所有产物写入 outputDir：catalog.json / dsh-models.json / report.md。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ModelEntry, RawModel } from '../domain.js';
import { normalizeBaseUrl } from '../domain.js';
import { classifyHost, type Detection } from './classifier.js';
import { collectorFor } from '../collect/registry.js';
import { refineModels, type SupplementModel } from './refiner.js';
import { verifyCapabilities } from '../probe/verifier.js';
import { writeCatalog, writeSnippet, writeReport } from '../emit/index.js';
import { getJson } from '../util/http.js';
import { readJsonSafe } from '../util/fsx.js';
import type { Settings } from '../config/settings.js';
import { resolveApiKeyEnvName } from '../config/settings.js';
import type { Vault } from '../storage/vault.js';

export interface DiscoverOptions {
  baseUrl: string;
  apiKey: string | null;
  settings: Settings;
  vault: Vault;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
}

export interface DiscoverResult {
  detection: Detection;
  /** 规整后的主机地址（去尾斜杠、去 /v1）。 */
  baseUrl: string;
  entries: ModelEntry[];
  warnings: string[];
  generatedAt: string;
  outputs: { catalog: string; snippet: string; report: string };
}

/** 插件根目录（dist/src/core/orchestrator.js 上溯四级 -> 包根）。 */
export function pluginRoot(): string {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

/** 过滤并规整补充来源表：元素必须是带字符串 id 的对象，其余一律丢弃。 */
function sanitizeTable(list: unknown): SupplementModel[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (x): x is SupplementModel => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string',
  );
}

/** 过滤别名映射：只保留键与值均为非空字符串的条目。 */
function sanitizeAliases(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && key.trim() !== '' && typeof value === 'string' && value.trim() !== '') {
      out[key] = value;
    }
  }
  return out;
}

async function loadSupplements(
  settings: Settings,
  vault: Vault,
): Promise<{ builtin: SupplementModel[]; overrides: SupplementModel[]; mirror: SupplementModel[]; aliases: Record<string, string>; warnings: string[] }> {
  const root = pluginRoot();
  const warnings: string[] = [];

  const builtinDoc = (await readJsonSafe(join(root, 'data', 'builtin-table.json'))) as
    | { models?: unknown }
    | null;
  const builtin = sanitizeTable(builtinDoc?.models);

  const overridesDoc = (await readJsonSafe(join(root, 'data', 'overrides.json'))) as { models?: unknown } | null;
  const overrides = sanitizeTable(overridesDoc?.models);

  const aliasesDoc = (await readJsonSafe(join(root, 'data', 'aliases.json'))) as { aliases?: unknown } | null;
  const aliases = sanitizeAliases(aliasesDoc?.aliases);

  let mirror: SupplementModel[] = [];
  if (settings.externalUrl) {
    const cacheKey = `mirror::${settings.externalUrl}`;
    const cached = vault.read<SupplementModel[]>(cacheKey, 3600 * 1000);
    if (cached) {
      mirror = cached;
    } else {
      try {
        const res = await getJson(settings.externalUrl, { timeoutMs: settings.httpTimeoutMs });
        const doc = res.json as { models?: unknown } | unknown[];
        const list = Array.isArray(doc)
          ? doc
          : Array.isArray((doc as { models?: unknown }).models)
            ? ((doc as { models: unknown[] }).models)
            : null;
        if (list) {
          mirror = sanitizeTable(list);
          vault.write(cacheKey, mirror, 3600 * 1000);
        } else {
          warnings.push(`外部镜像 ${settings.externalUrl} 结构无法识别，已忽略`);
        }
      } catch (err) {
        warnings.push(`外部镜像拉取失败（${(err as Error).message}），已回退到内置默认表`);
      }
    }
  }

  return { builtin, overrides, mirror, aliases, warnings };
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const now = opts.now ?? Date.now;
  const generatedAt = new Date(now()).toISOString();
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const settings = opts.settings;
  const warnings: string[] = [];

  const detection: Detection =
    settings.kindHint && settings.kindHint !== 'unknown'
      ? { kind: settings.kindHint, probes: ['强制指定（--kind）'] }
      : await classifyHost(baseUrl, opts.apiKey, opts.vault, {
          timeoutMs: settings.httpTimeoutMs,
          detectTtlSec: settings.detectTtlSec,
        });
  if (detection.kind === 'unknown') {
    throw new Error(`无法识别主机类型：${baseUrl}\n已探测端点：${detection.probes.join('；')}\n可尝试 --kind 手工指定（bare/augmented/quota/flag/ollama/vllm）。`);
  }

  const collector = collectorFor(detection.kind);
  const raw: RawModel[] = await collector.collect(baseUrl, opts.apiKey, {
    timeoutMs: settings.httpTimeoutMs,
    concurrency: settings.concurrency,
  });
  if (raw.length === 0) {
    throw new Error(`主机 ${baseUrl} 未返回任何模型`);
  }

  const supplements = await loadSupplements(settings, opts.vault);
  warnings.push(...supplements.warnings);

  const apiKeyEnvName = resolveApiKeyEnvName(settings);
  const refined = refineModels(raw, {
    baseUrl,
    hostKind: detection.kind,
    capturedAt: generatedAt,
    apiKeyEnvName,
    supplements,
  });
  warnings.push(...refined.warnings);

  const verified = await verifyCapabilities(
    refined.entries,
    { baseUrl, kind: detection.kind },
    { mode: settings.probe, apiKey: opts.apiKey, timeoutMs: settings.httpTimeoutMs, probeTtlSec: settings.probeTtlSec },
    opts.vault,
  );
  warnings.push(...verified.warnings);

  await opts.vault.withLock(async () => {
    // 输出层在锁内写入，避免与并发运行的 CLI 互相覆盖
    await Promise.all([
      writeCatalog(settings.outputDir, { host: { baseUrl, kind: detection.kind }, entries: refined.entries, warnings, generatedAt }),
      writeSnippet(settings.outputDir, { baseUrl, hostKind: detection.kind, apiKeyEnvName, entries: refined.entries, generatedAt }),
      writeReport(settings.outputDir, { host: { baseUrl, kind: detection.kind }, entries: refined.entries, warnings, generatedAt }),
    ]);
  });

  return {
    detection,
    baseUrl,
    entries: refined.entries,
    warnings,
    generatedAt,
    outputs: {
      catalog: join(settings.outputDir, 'catalog.json'),
      snippet: join(settings.outputDir, 'dsh-models.json'),
      report: join(settings.outputDir, 'report.md'),
    },
  };
}
