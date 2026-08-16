/** 文件系统小工具：目录、原子写入、宽容读取。 */
import { promises as fsp, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = join(dirname(file), `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2));
}

/** 读取 JSON 文件；不存在或损坏时返回 null（不抛错）。 */
export async function readJsonSafe(file: string): Promise<unknown | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
