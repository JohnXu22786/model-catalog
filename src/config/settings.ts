/**
 * 配置：默认值 + 配置文件（catalog.config.json）+ 环境变量 + 命令行参数逐层覆盖。
 */
import { join } from 'node:path';
import { readJsonSafe } from '../util/fsx.js';
import type { HostKind } from '../domain.js';
import type { ProbeMode } from '../probe/verifier.js';

export interface Settings {
  baseUrl: string | null;
  /** 密钥所在环境变量名；null 表示自动探测（MODELCAT_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY）。 */
  apiKeyEnv: string | null;
  /** 强制指定主机类型（跳过自动识别），一般无需设置。 */
  kindHint: HostKind | null;
  probe: ProbeMode;
  catalogTtlSec: number;
  probeTtlSec: number;
  detectTtlSec: number;
  /** 外部价格镜像 URL（可选）：与 catalog.json 的 models 数组同构的 JSON。 */
  externalUrl: string | null;
  outputDir: string;
  cacheDir: string;
  concurrency: number;
  httpTimeoutMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: null,
  apiKeyEnv: null,
  kindHint: null,
  probe: 'auto',
  catalogTtlSec: 900,
  probeTtlSec: 24 * 3600,
  detectTtlSec: 3600,
  externalUrl: null,
  outputDir: 'out',
  cacheDir: 'var',
  concurrency: 4,
  httpTimeoutMs: 10_000,
};

const KNOWN_KEYS: Record<Exclude<keyof Settings, 'kindHint'>, 'string' | 'number' | 'enum'> = {
  baseUrl: 'string',
  apiKeyEnv: 'string',
  probe: 'enum',
  catalogTtlSec: 'number',
  probeTtlSec: 'number',
  detectTtlSec: 'number',
  externalUrl: 'string',
  outputDir: 'string',
  cacheDir: 'string',
  concurrency: 'number',
  httpTimeoutMs: 'number',
};

const PROBE_MODES = new Set(['auto', 'never', 'always'] as ProbeMode[]);
const HOST_KINDS = new Set(['bare', 'augmented', 'quota', 'flag', 'ollama', 'vllm'] as HostKind[]);

/** 读取配置文件（宽松校验：非法字段忽略，不阻断启动）。 */
export async function loadSettingsFile(configFile: string): Promise<Partial<Settings>> {
  const raw = await readJsonSafe(configFile);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const [key, type] of Object.entries(KNOWN_KEYS)) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key as keyof Settings] = value as never;
    } else if (type === 'string') {
      if (typeof value === 'string' && value.trim() !== '') out[key as keyof Settings] = value as never;
    } else if (type === 'enum') {
      if (PROBE_MODES.has(value as ProbeMode)) out[key as keyof Settings] = value as never;
    }
  }
  // kindHint 单独校验（不在 KNOWN_KEYS 通用分支内）
  const kind = src.kindHint;
  if (typeof kind === 'string' && HOST_KINDS.has(kind as HostKind)) out.kindHint = kind as HostKind;
  return out;
}

/** 解析最终使用的密钥环境变量名；返回 null 表示未配置任何密钥来源。 */
export function resolveApiKeyEnvName(s: Settings): string | null {
  if (s.apiKeyEnv) return s.apiKeyEnv;
  const candidates = ['MODELCAT_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'];
  for (const name of candidates) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return name;
  }
  return null;
}

export function resolveApiKey(s: Settings): string | null {
  const name = resolveApiKeyEnvName(s);
  if (!name) return null;
  const v = process.env[name];
  return v && v !== '' ? v : null;
}

/** 插件默认配置路径（与插件根目录相对）。 */
export function pluginConfigPath(rootDir: string): string {
  return join(rootDir, 'catalog.config.json');
}
