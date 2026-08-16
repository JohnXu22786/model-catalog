/**
 * 带行缓冲的交互提问器。
 *
 * 与 readline 的区别：到达的输入行先进入缓冲（可先于提问到达），按提问顺序交付——
 * 支持管道一次性喂入多行回答；EOF 后仍有未满足的提问时显式报错（而非静默挂起）。
 */
import type { Readable } from 'node:stream';

export class InputEndedError extends Error {
  constructor() {
    super('标准输入已结束（EOF）：提问无法继续。请逐行交互输入，或改用命令行参数非交互运行');
    this.name = 'InputEndedError';
  }
}

export class PromptLineReader {
  private buffer = '';
  private ended = false;
  private pendingLines: string[] = [];
  private pendingAsks: Array<(line: string) => void> = [];
  private pendingRejects: Array<(err: Error) => void> = [];

  constructor(
    private readonly stream: Readable,
    private readonly out: { write(s: string): void } = process.stdout,
  ) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    stream.on('end', () => {
      // 无换行结尾的残余内容也视为一行
      if (this.buffer !== '') {
        this.buffer += '\n';
        this.drain();
      }
      this.ended = true;
      this.failPending();
    });
  }

  /** 把缓冲中的完整行交付给等待的提问；无等待者则存入行缓冲。 */
  private drain(): void {
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const next = this.pendingAsks.shift();
      if (next) next(line);
      else this.pendingLines.push(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private failPending(): void {
    const rejects = this.pendingRejects;
    this.pendingRejects = [];
    this.pendingAsks = [];
    for (const reject of rejects) reject(new InputEndedError());
  }

  /** 输出提示并等待一行输入（可先到达缓冲）；EOF 时 reject InputEndedError。 */
  ask(prompt: string): Promise<string> {
    this.out.write(prompt);
    return new Promise<string>((resolve, reject) => {
      if (this.ended) {
        reject(new InputEndedError());
        return;
      }
      const buffered = this.pendingLines.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      this.pendingAsks.push(resolve);
      this.pendingRejects.push(reject);
    });
  }
}
