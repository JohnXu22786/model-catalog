/**
 * dsh（DeepSeek Harness）插件入口 —— Cordis bundle 约定。
 *
 * 通过 package.json 的 `dsh.bundle.patch` 指向 cordis.patch.yml，安装插件行时，
 * dsh 会以 Cordis 插件的方式加载本模块：
 *   导出 name（插件行引用的包名）、inject（需要的服务）、apply(ctx, rowConfig)。
 *
 * 本模块不重复实现逻辑：把 dsh 的 Context 适配成 plugin.ts 期望的 DshContext
 * （配置键 / 事件 / 日志 / 工具注册），复用 createPlugin() 注册的 5 个工具
 * （catalog.discover / list / refresh / select / probe）并转换为 dsh 的
 * ToolDefinition 形态，卸载时回收全部注册。
 */

import { createPlugin, PLUGIN_ID, PLUGIN_VERSION } from './plugin.js';
import type { PluginToolHandler, PluginToolResult } from './plugin.js';

export const name = 'model-catalog';

/** 依赖 dsh 提供的工具注册服务（无 tools 时插件不加载）。 */
export const inject = ['tools'];

/** dsh ToolDefinition 的松散形态（与 command-scout 等插件一致）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

/** dsh 的 Cordis Context 所需字段的松散形态。 */
export interface HarnessContext {
  tools?: { register(def: ToolDefinition): unknown };
  logger?: { info?(msg: string): void; warn?(msg: string): void; error?(msg: string): void };
  emit?(name: string, payload: unknown): void;
  effect?(fn: () => void): void;
}

interface ToolMeta {
  description: string;
  parameters: Record<string, unknown>;
}

const TOOL_META: Record<string, ToolMeta | undefined> = {
  'catalog.discover': {
    description:
      '从 OpenAI 兼容主机发现模型目录：自动识别主机类型、拉取模型列表与定价、归一化并写出目录/片段/报告三份产物。',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: '主机地址（如 https://api.deepseek.com）' },
        apiKeyEnv: { type: 'string', description: '密钥环境变量名' },
        apiKey: { type: 'string', description: '临时密钥（优先于环境变量）' },
        probe: { type: 'string', enum: ['auto', 'never', 'always'], description: '能力探测模式' },
      },
    },
  },
  'catalog.list': {
    description:
      '列出模型目录：优先读取本地缓存的目录（未过期），否则重新发现；返回按主机归一化后的模型列表。',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: '主机地址' },
        apiKeyEnv: { type: 'string' },
        apiKey: { type: 'string' },
        probe: { type: 'string', enum: ['auto', 'never', 'always'] },
      },
    },
  },
  'catalog.refresh': {
    description: '强制重新发现模型目录并覆盖写回产物，返回生成时间与模型数量。',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: '主机地址' },
        apiKeyEnv: { type: 'string' },
        apiKey: { type: 'string' },
        probe: { type: 'string', enum: ['auto', 'never', 'always'] },
      },
    },
  },
  'catalog.select': {
    description:
      '从已生成的目录中选择一个或多个模型，生成 dsh 可直接使用的模型配置片段（dsh-models.json）。',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要选择的模型 id 列表（缺省选择全部）',
        },
      },
    },
  },
  'catalog.probe': {
    description: '对单个模型做一次轻量能力探测（工具调用/结构化输出/流式），返回能力证据。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id' },
      },
    },
  },
};

/** 从配置对象按“直接键 → 点分路径”取值；取不到返回 fallback。 */
function lookup(
  obj: unknown,
  key: string,
  fallback: unknown,
): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return fallback;
  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];
  const path = key.split('.');
  let cur: unknown = obj;
  for (const part of path) {
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return fallback;
    }
  }
  return cur === undefined ? fallback : cur;
}

export function apply(ctx: HarnessContext, rowConfig: unknown = {}): () => void {
  const disposers: Array<() => void> = [];
  const log = (
    level: 'info' | 'warn' | 'error',
    msg: string,
  ): void => {
    const target = ctx.logger?.[level];
    if (typeof target === 'function') target(`[model-catalog] ${msg}`);
    else if (level === 'info' || level === 'warn') console.log(`[model-catalog] ${msg}`);
    else console.error(`[model-catalog] ${msg}`);
  };

  const harness = {
    config: {
      get: (key: string, fallback: unknown = null): unknown => lookup(rowConfig, key, fallback),
    },
    events: {
      emit: (eventName: string, payload: Record<string, unknown>): void => {
        if (typeof ctx.emit === 'function') ctx.emit(eventName, payload);
      },
    },
    log: {
      info: (msg: string): void => log('info', msg),
      warn: (msg: string): void => log('warn', msg),
      error: (msg: string): void => log('error', msg),
    },
    tools: {
      register: (toolName: string, handler: PluginToolHandler): void => {
        const meta = TOOL_META[toolName];
        const def: ToolDefinition = {
          name: toolName,
          description: meta?.description ?? `model-catalog 工具：${toolName}`,
          parameters: meta?.parameters ?? {
            type: 'object',
            properties: {},
          },
          output: { schema: { type: 'object', additionalProperties: true } },
          execute: async (params: Record<string, unknown>): Promise<PluginToolResult> => {
            try {
              return await handler((params ?? {}) as Record<string, unknown>);
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
        };
        const ret = ctx.tools?.register(def);
        if (typeof ret === 'function') disposers.push(ret as () => void);
      },
    },
  };

  void createPlugin()
    .register(harness)
    .catch((err: unknown) => {
      log('error', `注册失败：${err instanceof Error ? err.message : String(err)}`);
    });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      for (const dispose of disposers) dispose();
    });
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}