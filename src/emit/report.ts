/** 人类可读报告：out/report.md。 */
import { join } from 'node:path';
import { writeFileAtomic } from '../util/fsx.js';
import type { HostKind, ModelEntry } from '../domain.js';
import { HOST_KIND_LABELS } from '../domain.js';
import { capabilitySummary } from '../probe/verifier.js';

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

function fmtPrice(n: number | null): string {
  return n === null ? '—' : `$${n}`;
}

export async function writeReport(
  dir: string,
  meta: { host: { baseUrl: string; kind: HostKind }; entries: ModelEntry[]; warnings: string[]; generatedAt: string },
): Promise<string> {
  const lines: string[] = [];
  lines.push('# 模型目录报告', '');
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 主机：${meta.host.baseUrl}`);
  lines.push(`- 主机类型：${HOST_KIND_LABELS[meta.host.kind]}（${meta.host.kind}）`);
  lines.push(`- 模型数量：${meta.entries.length}`);
  lines.push('');

  lines.push('## 模型目录', '');
  lines.push('| 模型 | 上下文 | 最大输出 | 输入价/1M | 输出价/1M | 缓存读/1M | 计费 | 价格来源 | 能力 | 状态 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const e of meta.entries) {
    const p = e.pricing;
    const priceCols = p
      ? [
          fmtPrice(p.amounts.input),
          fmtPrice(p.amounts.output),
          fmtPrice(p.amounts.cacheRead),
          p.billing === 'per-call' ? `${fmtPrice(p.perCallUsd)}/次` : '按量',
        ]
      : ['—', '—', '—', '未知'];
    lines.push(
      `| ${e.id} | ${fmt(e.contextWindow)} | ${fmt(e.maxOutput)} | ${priceCols[0]} | ${priceCols[1]} | ${priceCols[2]} | ${priceCols[3]} | ${p ? p.source : '—'} | ${capabilitySummary(e.capabilities)} | ${e.status} |`,
    );
  }
  lines.push('');

  const unknownPricing = meta.entries.filter((e) => e.pricing === null);
  if (unknownPricing.length > 0) {
    lines.push('## 未找到定价的模型', '');
    lines.push(
      '以下模型在主机接口、覆盖配置、外部镜像与内置默认表中均未找到定价，价格标记为未知。可在覆盖配置中手工补充：',
      '',
    );
    for (const e of unknownPricing) lines.push(`- \`${e.id}\``);
    lines.push('');
  }

  const dynamic = meta.entries.filter((e) => e.pricing?.dynamic);
  if (dynamic.length > 0) {
    lines.push('## 动态定价模型', '');
    lines.push('以下模型存在按时间/上下文分档的定价（tiers），目录中的金额为基准档（首档），使用时请按实际档位计费：', '');
    for (const e of dynamic) {
      const p = e.pricing!;
      const tierNames = p.tiers.map((t) => `${t.label}${t.windows ? `（${t.windows.map((w) => `${w[0]}–${w[1]} UTC`).join('、')}）` : ''}`).join('，');
      lines.push(`- \`${e.id}\`：${tierNames}${p.note ? `（${p.note}）` : ''}`);
    }
    lines.push('');
  }

  if (meta.warnings.length > 0) {
    lines.push('## 告警', '');
    for (const w of meta.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('## 说明', '');
  lines.push('- 价格统一为每百万 token 美元（USD/1M）；按次计费模型单独标注。');
  lines.push('- `catalog.json` 为完整目录；`dsh-models.json` 为 dsh 可直接消费的配置片段。');
  lines.push('');

  const file = join(dir, 'report.md');
  await writeFileAtomic(file, lines.join('\n'));
  return file;
}
