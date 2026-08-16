#!/usr/bin/env node
/**
 * model-catalog CLI：模型目录自动发现命令行入口。
 *
 * 用法：
 *   model-catalog discover [--base-url URL] [--api-key-env NAME] [--api-key KEY]
 *                         [--kind bare|augmented|quota|flag|ollama|vllm]
 *                         [--probe auto|never|always] [--out DIR] [--cache DIR]
 *                         [--external-url URL] [--config FILE]
 *   model-catalog pick    [同 discover 参数]        交互式选择模型并生成 dsh 配置片段
 *   model-catalog probe --model ID [同 discover 参数] 对单个模型执行能力探测
 *   model-catalog cache clear                       清空缓存
 *   model-catalog config                             查看生效配置
 */
import { join } from 'node:path';
import { discover, pluginRoot } from './core/orchestrator.js';
import { writeSnippet } from './emit/snippet.js';
import { verifyCapabilities, type ProbeEvidence } from './probe/verifier.js';
import { Vault } from './storage/vault.js';
import { readJsonSafe } from './util/fsx.js';
import { PromptLineReader } from './util/asker.js';
import {
  loadSettingsFile,
  resolveApiKey,
  resolveApiKeyEnvName,
  type Settings,
} from './config/settings.js';
import { DEFAULT_SETTINGS } from './config/settings.js';
import type { ModelEntry } from './domain.js';
import { HOST_KIND_LABELS } from './domain.js';
import { capabilitySummary } from './probe/verifier.js';
import { parseFlags, flagStr, parseSelection, coerceProbeMode, type FlagMap } from './cli-parse.js';

async function loadSettings(flags: FlagMap): Promise<Settings> {
  const root = pluginRoot();
  const configFile = flagStr(flags, '--config') ?? join(root, 'catalog.config.json');
  const fileSettings = await loadSettingsFile(configFile);
  const settings: Settings = { ...DEFAULT_SETTINGS, ...fileSettings };
  settings.baseUrl = flagStr(flags, '--base-url') ?? settings.baseUrl;
  settings.apiKeyEnv = flagStr(flags, '--api-key-env') ?? settings.apiKeyEnv;
  settings.probe = coerceProbeMode(flagStr(flags, '--probe'), settings.probe);
  settings.outputDir = flagStr(flags, '--out') ?? settings.outputDir;
  settings.cacheDir = flagStr(flags, '--cache') ?? settings.cacheDir;
  settings.externalUrl = flagStr(flags, '--external-url') ?? settings.externalUrl;
  const kind = flagStr(flags, '--kind');
  if (kind && ['bare', 'augmented', 'quota', 'flag', 'ollama', 'vllm'].includes(kind)) {
    settings.kindHint = kind as Settings['kindHint'];
  }
  return settings;
}

function printSummaryTable(entries: ModelEntry[]): void {
  const header = ['#', '模型', '上下文', '最大输出', '输入价/1M', '输出价/1M', '价格来源', '能力'];
  const rows = entries.map((e, i) => {
    const p = e.pricing;
    return [
      String(i + 1),
      e.id,
      p === null ? '—' : String(e.contextWindow ?? '—'),
      String(e.maxOutput ?? '—'),
      p ? String(p.amounts.input ?? '—') : '—',
      p ? String(p.amounts.output ?? '—') : '—',
      p ? p.source : '未知',
      capabilitySummary(e.capabilities),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmtRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(fmtRow(header));
  console.log(fmtRow(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(fmtRow(row));
}

async function runDiscoverAndPrint(settings: Settings, apiKey: string | null): Promise<{ entries: ModelEntry[]; warnings: string[]; generatedAt: string }> {
  if (!settings.baseUrl) throw new Error('缺少主机地址：请提供 --base-url 或在 catalog.config.json 中配置 baseUrl');
  const vault = new Vault(settings.cacheDir);
  await vault.init();
  const result = await discover({ baseUrl: settings.baseUrl, apiKey, settings, vault });
  console.log(`主机类型：${HOST_KIND_LABELS[result.detection.kind]}（${result.detection.kind}）`);
  console.log(`发现模型：${result.entries.length} 个（生成时间 ${result.generatedAt}）`);
  console.log('');
  printSummaryTable(result.entries);
  console.log('');
  for (const w of result.warnings) console.log(`⚠ ${w}`);
  console.log('');
  console.log(`输出：${result.outputs.catalog}`);
  console.log(`      ${result.outputs.snippet}`);
  console.log(`      ${result.outputs.report}`);
  return result;
}

async function cmdDiscover(flags: FlagMap): Promise<void> {
  const settings = await loadSettings(flags);
  const apiKey = flagStr(flags, '--api-key') ?? resolveApiKey(settings);
  await runDiscoverAndPrint(settings, apiKey);
}

async function cmdPick(flags: FlagMap): Promise<void> {
  const settings = await loadSettings(flags);
  // 带缓冲的提问器：支持管道一次性喂入多行回答；EOF 时显式报错（readline 无法预读行，弃用）
  const asker = new PromptLineReader(process.stdin);

  if (!settings.baseUrl) {
    const answer = await asker.ask('主机 baseUrl（如 https://api.deepseek.com 或 http://127.0.0.1:11434）: ');
    if (!answer.trim()) {
      throw new Error('未提供主机地址');
    }
    settings.baseUrl = answer.trim();
  }
  const envName = settings.apiKeyEnv ?? resolveApiKeyEnvName(settings);
  if (!envName) {
    const answer = await asker.ask(
      '密钥环境变量名（直接回车=自动检测 MODELCAT_API_KEY/DEEPSEEK_API_KEY/OPENAI_API_KEY；无需密钥的主机也可回车）: ',
    );
    if (answer.trim()) settings.apiKeyEnv = answer.trim();
  }

  const apiKey = flagStr(flags, '--api-key') ?? resolveApiKey(settings);
  const result = await runDiscoverAndPrint(settings, apiKey);

  let selection: number[] = [];
  for (;;) {
    const answer = await asker.ask(`选择要生成配置的模型编号（可 1,3-5；直接回车=全部；输入 none 跳过）: `);
    try {
      selection = parseSelection(answer, result.entries.length);
      break;
    } catch (err) {
      console.log(`输入无效：${(err as Error).message}`);
    }
  }

  if (selection.length === 0) {
    console.log('未选择任何模型，跳过配置生成。');
    return;
  }
  const selected = selection.map((i) => result.entries[i]!).filter(Boolean);
  const file = await writeSnippet(settings.outputDir, {
    baseUrl: settings.baseUrl,
    hostKind: result.entries[0]!.hostKind,
    apiKeyEnvName: resolveApiKeyEnvName(settings),
    entries: selected,
    generatedAt: result.generatedAt,
  });
  console.log(`已生成配置片段（${selected.length} 个模型）：${file}`);
}

async function cmdProbe(flags: FlagMap): Promise<void> {
  const settings = await loadSettings(flags);
  const model = flagStr(flags, '--model');
  if (!model) throw new Error('请提供 --model 参数');
  const vault = new Vault(settings.cacheDir);
  await vault.init();

  let entries: ModelEntry[] | null = null;
  let hostBaseUrl: string | null = settings.baseUrl;
  const doc = (await readJsonSafe(join(settings.outputDir, 'catalog.json'))) as { models?: ModelEntry[]; host?: { baseUrl?: string } } | null;
  if (doc?.models && doc.models.length > 0) {
    entries = doc.models;
    if (doc.host?.baseUrl) hostBaseUrl = doc.host.baseUrl;
  }
  if (!entries && settings.baseUrl) {
    const apiKey = flagStr(flags, '--api-key') ?? resolveApiKey(settings);
    const result = await discover({ baseUrl: settings.baseUrl, apiKey, settings, vault });
    entries = result.entries;
  }
  if (!entries) throw new Error('没有可用目录：请先运行 discover，或提供 --base-url');

  const entry = entries.find((e) => e.id === model);
  if (!entry) throw new Error(`目录中不存在模型 ${model}`);
  if (!hostBaseUrl) throw new Error('缺少主机地址：请提供 --base-url 或先运行 discover');
  const result = await verifyCapabilities(
    [entry],
    { baseUrl: hostBaseUrl, kind: entry.hostKind },
    { mode: 'always', apiKey: flagStr(flags, '--api-key') ?? resolveApiKey(settings), timeoutMs: settings.httpTimeoutMs, probeTtlSec: settings.probeTtlSec },
    vault,
  );
  const evidence = (entry.extra['probe'] ?? {}) as Record<string, ProbeEvidence>;
  console.log(`模型：${entry.id}`);
  console.log(`能力：${capabilitySummary(entry.capabilities)}`);
  console.log('探测证据：');
  for (const [cap, ev] of Object.entries(evidence)) {
    const mark = ev.supported === true ? '✔' : ev.supported === false ? '✘' : '?';
    console.log(`  ${mark} ${cap}: ${ev.evidence}（${ev.at}）`);
  }
  for (const w of result.warnings) console.log(`⚠ ${w}`);
}

async function cmdCache(flags: FlagMap): Promise<void> {
  const settings = await loadSettings(flags);
  const vault = new Vault(settings.cacheDir);
  await vault.init();
  if (flags['--clear']) {
    await vault.clear();
    console.log(`已清空缓存：${settings.cacheDir}`);
  } else {
    console.log('用法：model-catalog cache --clear');
  }
}

async function cmdConfig(flags: FlagMap): Promise<void> {
  const settings = await loadSettings(flags);
  const out: Record<string, unknown> = { ...settings };
  out['apiKeyEnvResolved'] = resolveApiKeyEnvName(settings);
  out['apiKeyPresent'] = resolveApiKey(settings) !== null;
  out['pluginRoot'] = pluginRoot();
  console.log(JSON.stringify(out, null, 2));
}

function printHelp(): void {
  console.log(`model-catalog — 模型目录自动发现（dsh 插件）

用法：
  model-catalog discover [参数]         发现并输出模型目录（默认命令）
  model-catalog pick [参数]             交互式选择模型并生成 dsh 配置片段
  model-catalog probe --model ID [参数] 对单个模型执行能力探测
  model-catalog cache --clear           清空缓存
  model-catalog config                  查看生效配置

参数：
  --base-url URL     主机地址（OpenAI 兼容）
  --api-key-env NAME 密钥环境变量名（默认自动检测 MODELCAT_API_KEY/DEEPSEEK_API_KEY/OPENAI_API_KEY）
  --api-key KEY      直接传密钥（仅命令行临时使用，生产请用环境变量）
  --kind KIND        强制主机类型：bare/augmented/quota/flag/ollama/vllm
  --probe MODE       能力探测模式：auto（默认）/never/always
  --out DIR          输出目录（默认 out）
  --cache DIR        缓存目录（默认 var）
  --external-url URL 外部价格镜像 JSON 地址
  --config FILE      配置文件路径（默认 catalog.config.json）
  --model ID         配合 probe 命令使用
  --help             显示帮助

示例：
  model-catalog discover --base-url https://api.deepseek.com
  model-catalog discover --base-url http://127.0.0.1:11434 --kind ollama --probe always
  model-catalog pick --base-url https://api.deepseek.com
  model-catalog probe --model deepseek-v4-flash --base-url https://api.deepseek.com`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return;
  }
  const command = first ?? 'discover';
  const flags = parseFlags(args.slice(1));
  try {
    if (command === 'discover') await cmdDiscover(flags);
    else if (command === 'pick') await cmdPick(flags);
    else if (command === 'probe') await cmdProbe(flags);
    else if (command === 'cache') await cmdCache(flags);
    else if (command === 'config') await cmdConfig(flags);
    else {
      console.error(`未知命令：${command}`);
      printHelp();
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`错误：${(err as Error).message}`);
    process.exitCode = 1;
  }
}

void main();
