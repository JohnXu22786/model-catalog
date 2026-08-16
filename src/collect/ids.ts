/** 共享 id 提取：/v1/models 列表项 -> 模型 id。 */
export function pickId(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const m = item as Record<string, unknown>;
  const id = m.id ?? m.model;
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed === '' ? null : trimmed;
}
