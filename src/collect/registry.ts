/** 采集器注册表：主机类型 -> 采集器。 */
import type { HostKind, RawModel } from '../domain.js';
import { standardCollector } from './standard.js';
import { augmentedCollector } from './augmented.js';
import { quotaCollector } from './quota.js';
import { flagCollector } from './flag.js';
import { ollamaCollector } from './ollama.js';

export interface Collector {
  kind: HostKind;
  /** 该类型主机通常是否需要鉴权（影响无密钥时的探测策略）。 */
  needsAuth: boolean;
  collect(
    baseUrl: string,
    apiKey: string | null | undefined,
    opts: { timeoutMs?: number; concurrency?: number },
  ): Promise<RawModel[]>;
}

const registry: Record<string, Collector> = {
  bare: standardCollector,
  vllm: standardCollector,
  augmented: augmentedCollector,
  quota: quotaCollector,
  flag: flagCollector,
  ollama: ollamaCollector,
};

export function collectorFor(kind: HostKind): Collector {
  const collector = registry[kind];
  if (!collector) {
    throw new Error(`未知的主机类型：${kind}（请先完成主机识别）`);
  }
  return collector;
}
