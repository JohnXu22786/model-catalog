/**
 * dsh 插件入口：向 harness 暴露统一的工具接口与事件接口。
 *
 * 加载契约（详见 docs/integration.md）：
 *   manifest.json 声明 entry.module = dist/src/plugin.js、factory = createPlugin；
 *   harness import 后调用 createPlugin() 得到插件句柄，再调用 register(ctx) 完成注册。
 *
 * 工具接口（ctx.tools.register）：
 *   catalog.discover / catalog.list / catalog.refresh / catalog.select / catalog.probe
 * 事件接口（ctx.events.emit）：
 *   catalog.updated / catalog.failed
 */
import { join } from 'node:path';
import { discover, pluginRoot, type DiscoverResult } from './core/orchestrator.js';
import { loadSettingsFile, resolveApiKey, resolveApiKeyEnvName, type Settings } from './config/settings.js';
import { DEFAULT_SETTINGS } from './config/settings.js';
import { Vault } from './storage/vault.js';
import { readJsonSafe } from './util/fsx.js';
import type { ModelEntry } from './domain.js';
import { verifyCapabilities } from './probe/verifier.js';

export const PLUGIN_ID = 'dsh.model-catalog';
export const PLUGIN_VERSION = '1.0.0';

export interface DshEventBus {
  emit(name: string, payload: Record<string, unknown>): void;
}

export interface DshLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DshConfig {
  get(key: string, fallback?: unknown): unknown;
}

export interface PluginToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type PluginToolHandler = (params: Record<string, unknown>) => Promise<PluginToolResult>;

export interface DshContext {
  config: DshConfig;
  events: DshEventBus;
  log: DshLogger;
  tools: { register(name: string, handler: PluginToolHandler): void };
}

export interface PluginHandle {
  id: string;
  version: string;
  register(ctx: DshContext): Promise<void>;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function createPlugin(): PluginHandle {
  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    async register(ctx: DshContext): Promise<void> {
      const root = pluginRoot();

      /** 组装设置：manifest 配置键（catalog.*）-> 配置文件 -> 默认值。 */
      const resolveSettings = async (params: Record<string, unknown>): Promise<Settings> => {
        const fileSettings = await loadSettingsFile(join(root, 'catalog.config.json'));
        const fromCtx = (key: string): unknown => ctx.config.get(key, null);
        const baseUrl =
          asString(params.baseUrl) ??
          asString(fromCtx('catalog.baseUrl')) ??
          fileSettings.baseUrl ??
          null;
        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          ...fileSettings,
          baseUrl,
          apiKeyEnv:
            asString(params.apiKeyEnv) ??
            asString(fromCtx('catalog.apiKeyEnv')) ??
            fileSettings.apiKeyEnv ??
            null,
          kindHint: fileSettings.kindHint ?? null,
        };
        // 其余配置键支持 harness 注入（类型宽松校验，非法值忽略）
        const probe = asString(params.probe) ?? asString(fromCtx('catalog.probe'));
        if (probe === 'auto' || probe === 'never' || probe === 'always') settings.probe = probe;
        const externalUrl = asString(fromCtx('catalog.externalUrl'));
        if (externalUrl) settings.externalUrl = externalUrl;
        const outputDir = asString(fromCtx('catalog.outputDir'));
        if (outputDir) settings.outputDir = outputDir;
        const cacheDir = asString(fromCtx('catalog.cacheDir'));
        if (cacheDir) settings.cacheDir = cacheDir;
        return settings;
      };

      const runDiscover = async (params: Record<string, unknown>): Promise<DiscoverResult> => {
        const settings = await resolveSettings(params);
        if (!settings.baseUrl) {
          throw new Error('缺少主机地址：请通过参数 baseUrl、配置 catalog.baseUrl 或配置文件指定');
        }
        const vault = new Vault(settings.cacheDir);
        await vault.init();
        const apiKey = asString(params.apiKey) ?? resolveApiKey(settings);
        return discover({ baseUrl: settings.baseUrl, apiKey, settings, vault });
      };

      ctx.tools.register('catalog.discover', async (params) => {
        try {
          const result = await runDiscover(params);
          ctx.events.emit('catalog.updated', {
            baseUrl: result.baseUrl,
            kind: result.detection.kind,
            modelCount: result.entries.length,
            generatedAt: result.generatedAt,
            warnings: result.warnings,
          });
          return {
            ok: true,
            data: {
              baseUrl: result.baseUrl,
              kind: result.detection.kind,
              modelCount: result.entries.length,
              generatedAt: result.generatedAt,
              outputs: result.outputs,
              warnings: result.warnings,
            },
          };
        } catch (err) {
          ctx.events.emit('catalog.failed', {
            baseUrl: null,
            error: (err as Error).message,
            at: new Date().toISOString(),
          });
          return { ok: false, error: (err as Error).message };
        }
      });

      const loadCatalogDoc = async (
        params: Record<string, unknown>,
      ): Promise<{ settings: Settings; entries: ModelEntry[]; generatedAt: string } | null> => {
        const settings = await resolveSettings(params);
        if (!settings.baseUrl) return null;
        const file = join(settings.outputDir, 'catalog.json');
        const doc = (await readJsonSafe(file)) as { models?: ModelEntry[]; generatedAt?: string } | null;
        if (!doc || !Array.isArray(doc.models) || doc.models.length === 0) return null;
        // 新鲜度：generatedAt 超过 catalogTtlSec 视为过期，强制重新发现
        const generatedAt = typeof doc.generatedAt === 'string' ? doc.generatedAt : '';
        if (generatedAt) {
          const ageMs = Date.now() - Date.parse(generatedAt);
          if (Number.isFinite(ageMs) && ageMs > settings.catalogTtlSec * 1000) return null;
        }
        return { settings, entries: doc.models, generatedAt };
      };

      ctx.tools.register('catalog.list', async (params) => {
        try {
          const cached = await loadCatalogDoc(params);
          if (cached && cached.entries.length > 0) {
            return { ok: true, data: { source: 'cache', generatedAt: cached.generatedAt, models: cached.entries } };
          }
          const result = await runDiscover(params);
          return { ok: true, data: { source: 'fresh', generatedAt: result.generatedAt, models: result.entries } };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      ctx.tools.register('catalog.refresh', async (params) => {
        try {
          const result = await runDiscover(params);
          return { ok: true, data: { generatedAt: result.generatedAt, modelCount: result.entries.length, outputs: result.outputs } };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      ctx.tools.register('catalog.select', async (params) => {
        try {
          const cached = await loadCatalogDoc(params);
          if (!cached) return { ok: false, error: '尚无目录，请先运行 catalog.discover' };
          const ids = Array.isArray(params.ids) ? params.ids.map(String) : asString(params.ids)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
          const selected = ids.length === 0 ? cached.entries : cached.entries.filter((e) => ids.includes(e.id));
          if (selected.length === 0) return { ok: false, error: '所选模型 id 均不在目录中' };
          const { writeSnippet } = await import('./emit/snippet.js');
          const file = await writeSnippet(cached.settings.outputDir, {
            baseUrl: cached.settings.baseUrl!,
            hostKind: cached.entries[0]!.hostKind,
            apiKeyEnvName: resolveApiKeyEnvName(cached.settings),
            entries: selected,
            generatedAt: new Date().toISOString(),
          });
          return { ok: true, data: { file, modelCount: selected.length, models: selected.map((e) => e.id) } };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      ctx.tools.register('catalog.probe', async (params) => {
        try {
          const cached = await loadCatalogDoc(params);
          const model = asString(params.model);
          if (!cached || !model) return { ok: false, error: '需要已生成的目录与 model 参数' };
          const entry = cached.entries.find((e) => e.id === model);
          if (!entry) return { ok: false, error: `目录中不存在模型 ${model}` };
          const vault = new Vault(cached.settings.cacheDir);
          await vault.init();
          const result = await verifyCapabilities(
            [entry],
            { baseUrl: cached.settings.baseUrl!, kind: entry.hostKind },
            { mode: 'always', apiKey: resolveApiKey(cached.settings), timeoutMs: cached.settings.httpTimeoutMs, probeTtlSec: cached.settings.probeTtlSec },
            vault,
          );
          return { ok: true, data: { model, capabilities: entry.capabilities, evidence: entry.extra['probe'] ?? null, warnings: result.warnings } };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      ctx.log.info(`${PLUGIN_ID} v${PLUGIN_VERSION} 已注册（工具：catalog.discover/list/refresh/select/probe）`);
    },
  };
}
