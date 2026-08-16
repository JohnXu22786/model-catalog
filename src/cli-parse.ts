/** CLI 纯函数：参数解析与选择解析（无副作用，可单测）。 */

export type FlagMap = Record<string, string | true>;

export function parseFlags(args: string[]): FlagMap {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[arg] = next;
        i += 1;
      } else {
        flags[arg] = true;
      }
    }
  }
  return flags;
}

export function flagStr(flags: FlagMap, name: string): string | null {
  const v = flags[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * 解析交互式选择输入为条目下标（0 基）：
 *   "" / "all"  -> 全部；"none" / "n" -> 空；"1,3-5" -> 0,2,3,4；
 *   越界编号静默过滤；非法 token / 逆序范围抛错。
 */
export function parseSelection(input: string, count: number): number[] {
  const raw = input.trim();
  if (raw === '' || raw === 'all') return Array.from({ length: count }, (_, i) => i);
  if (raw === 'none' || raw === 'n') return [];
  const selected = new Set<number>();
  for (const token of raw.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(token);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) throw new Error(`无效范围：${token}`);
      for (let i = a; i <= b; i += 1) selected.add(i);
    } else if (/^\s*\d+\s*$/.test(token)) {
      selected.add(Number(token));
    } else {
      throw new Error(`无法解析：${token}`);
    }
  }
  // 用户编号从 1 开始，转 0 基下标；越界过滤
  return [...selected]
    .map((i) => i - 1)
    .filter((i) => i >= 0 && i < count)
    .sort((a, b) => a - b);
}
