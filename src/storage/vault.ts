/**
 * 磁盘缓存仓（vault）：单文件 JSON 存储 + TTL + 跨进程文件锁。
 *
 * 设计要点：
 *  - 全部写入走「临时文件 + 原子 rename」，避免并发进程读到半截文件；
 *  - 缓存文件损坏时自动重置为空仓，不影响后续写入；
 *  - 锁文件采用独占创建（'wx'），带过期时间（陈旧锁可接管）与等待超时。
 */
import { promises as fsp, openSync, writeSync, closeSync, statSync, rmSync, unlinkSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../util/async.js';
import { ensureDir } from '../util/fsx.js';

export class LockTimeoutError extends Error {
  constructor(lockFile: string, waitedMs: number) {
    super(`等待锁超时（${waitedMs}ms）：${lockFile}`);
    this.name = 'LockTimeoutError';
  }
}

interface VaultEntry {
  v: unknown;
  at: number;
  /** 可选：条目自身 TTL（毫秒），与读取时的 ttlMs 取更严格者。 */
  exp?: number;
}

export interface VaultOptions {
  /** 可注入时钟（测试用），默认 Date.now。 */
  now?: () => number;
  /** 锁视为过期的毫秒数，默认 5 分钟。 */
  lockStaleMs?: number;
  /** 获取锁的最大等待毫秒数，默认 10 秒。 */
  lockWaitMs?: number;
  pollMs?: number;
}

export class Vault {
  private readonly dataFile: string;
  private readonly lockFile: string;
  private readonly now: () => number;
  private readonly lockStaleMs: number;
  private readonly lockWaitMs: number;
  private readonly pollMs: number;
  private store: Record<string, VaultEntry> = {};
  private loaded = false;

  constructor(
    private readonly dir: string,
    opts: VaultOptions = {},
  ) {
    this.dataFile = join(dir, 'vault.json');
    this.lockFile = join(dir, '.lock');
    this.now = opts.now ?? Date.now;
    this.lockStaleMs = opts.lockStaleMs ?? 5 * 60 * 1000;
    this.lockWaitMs = opts.lockWaitMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 100;
  }

  /** 加载缓存（可重复调用；损坏文件自动重置）。 */
  async init(): Promise<void> {
    if (this.loaded) return;
    await ensureDir(this.dir);
    try {
      const text = await fsp.readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(text) as Record<string, VaultEntry>;
      if (parsed && typeof parsed === 'object') this.store = parsed;
    } catch {
      this.store = {};
    }
    this.loaded = true;
  }

  /** 读取条目；超过有效 TTL 视为不存在。写入时可带条目自身 TTL（exp）。 */
  read<T>(key: string, ttlMs?: number): T | null {
    const entry = this.store[key];
    if (!entry) return null;
    let effectiveTtl = ttlMs ?? Number.POSITIVE_INFINITY;
    if (entry.exp !== undefined) effectiveTtl = Math.min(effectiveTtl, entry.exp);
    if (this.now() - entry.at > effectiveTtl) return null;
    return entry.v as T;
  }

  write<T>(key: string, value: T, ttlMs?: number): void {
    this.store[key] = { v: value, at: this.now(), exp: ttlMs };
    this.persistSync();
  }

  remove(key: string): void {
    if (key in this.store) {
      delete this.store[key];
      this.persistSync();
    }
  }

  async clear(): Promise<void> {
    this.store = {};
    await this.persist();
  }

  /** 在跨进程锁内执行任务；锁等待超时抛 LockTimeoutError。 */
  async withLock<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private persistSync(): void {
    // 同步原子写：写入路径短、文件小，避免异步竞态。
    try {
      // 写前合并磁盘快照（尽力而为）：减少无锁方案下其他进程写入被旧快照覆盖的窗口；
      // 极端交错下仍可能整文件覆盖（缓存丢失后重新探测即可，属可接受代价）
      try {
        const disk = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Record<string, VaultEntry>;
        if (disk && typeof disk === 'object') this.store = { ...disk, ...this.store };
      } catch {
        // 磁盘文件不存在或损坏：以内存为准
      }
      const tmp = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, JSON.stringify(this.store));
      } finally {
        closeSync(fd);
      }
      // Node 的 rename 在 Windows 上可覆盖已存在文件（MoveFileEx 语义），无需先删旧文件
      renameSync(tmp, this.dataFile);
    } catch {
      // 写入失败不阻断主流程：下次写入会重试。
    }
  }

  private async persist(): Promise<void> {
    const { writeFileAtomic } = await import('../util/fsx.js');
    await writeFileAtomic(this.dataFile, JSON.stringify(this.store));
  }

  private acquire(): Promise<void> {
    // 等待超时使用真实时钟（锁竞争是真实时间过程；注入时钟仅用于缓存 TTL 与陈旧判定）
    const deadline = Date.now() + this.lockWaitMs;
    const attempt = async (): Promise<void> => {
      try {
        const fd = openSync(this.lockFile, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }));
        closeSync(fd);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // 锁已存在：检查是否过期
        try {
          const st = statSync(this.lockFile);
          if (st.mtimeMs < this.now() - this.lockStaleMs) {
            unlinkSync(this.lockFile);
            return attempt();
          }
        } catch {
          // 锁文件恰好被删除（stat 失败），重试获取
          return attempt();
        }
        if (Date.now() >= deadline) throw new LockTimeoutError(this.lockFile, this.lockWaitMs);
        await sleep(this.pollMs);
        return attempt();
      }
    };
    return attempt();
  }

  private release(): void {
    try {
      if (!existsSync(this.lockFile)) return;
      // 只删除自己持有的锁：陈旧接管后原持有者不得删除新持有者的锁
      const content = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: number };
      if (content.pid !== process.pid) return;
      unlinkSync(this.lockFile);
    } catch {
      // 释放失败可忽略：锁带过期时间，最终会被接管。
    }
  }
}
