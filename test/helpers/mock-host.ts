/**
 * 测试辅助：可编程的本地 HTTP 主机。
 * 用于模拟各种 OpenAI 兼容主机（最小字段 / 富元数据 / 倍率网关 / 能力标志 / Ollama / vLLM）。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockResponse {
  status: number;
  body?: unknown; // object 序列化为 JSON；string 原样输出（用于 SSE 等）
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type MockHandler = (
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
) => MockResponse;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class MockHost {
  private server: Server | null = null;
  readonly requests: RecordedRequest[] = [];

  constructor(private handler: MockHandler) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const raw = await readBody(req);
      let body: unknown = raw;
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const record: RecordedRequest = {
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0] ?? '/',
        body,
        headers: req.headers as Record<string, string>,
      };
      this.requests.push(record);

      let response: MockResponse;
      try {
        response = this.handler(record.method, record.path, body, record.headers);
      } catch (err) {
        response = { status: 500, body: { error: { message: String(err) } } };
      }
      const status = response.status;
      const resHeaders: Record<string, string> = { ...(response.headers ?? {}) };
      let payload = '';
      if (response.body !== undefined) {
        if (typeof response.body === 'string') {
          payload = response.body;
          resHeaders['content-type'] ??= 'text/plain; charset=utf-8';
        } else {
          payload = JSON.stringify(response.body);
          resHeaders['content-type'] ??= 'application/json; charset=utf-8';
        }
      }
      res.writeHead(status, resHeaders);
      res.end(payload);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
  }

  get url(): string {
    if (!this.server) throw new Error('MockHost 未启动');
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // 主动断开 keep-alive 连接，避免 server.close 等待挂起
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 统计满足条件的请求数。 */
  count(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }

  /** 最后一次匹配请求的 body（已解析 JSON 或原始文本）。 */
  lastBody(method: string, path: string): unknown {
    const matches = this.requests.filter((r) => r.method === method && r.path === path);
    return matches.length ? matches[matches.length - 1]!.body : undefined;
  }
}

/** 简易路由表：key 为 "METHOD /path"，值缺省 404。 */
export function routeTable(
  routes: Record<string, MockResponse>,
  fallback: MockResponse = { status: 404, body: { error: { message: 'not found' } } },
): MockHandler {
  return (method, path) => routes[`${method} ${path}`] ?? fallback;
}
