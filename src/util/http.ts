/** 最小 HTTP 客户端：JSON 读写 + 超时 + 有限重试。 */

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

export interface HttpOptions {
  apiKey?: string | null;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly json: unknown;
  constructor(status: number, body: string, json: unknown) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
    this.json = json;
  }
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  opts: HttpOptions,
): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 1;
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      const result: HttpResult = { status: res.status, text, json };
      if (res.status >= 400) {
        throw new HttpError(res.status, text, json);
      }
      return result;
    } catch (err) {
      // HTTP 错误不重试（状态码已是确定的答复）；仅网络层错误重试。
      if (err instanceof HttpError) throw err;
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getJson(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  return request('GET', url, undefined, opts);
}

export function postJson(url: string, body: unknown, opts: HttpOptions = {}): Promise<HttpResult> {
  return request('POST', url, body, opts);
}

/** 宽容的 GET：网络错误返回 null，HTTP 错误返回 {status, json}。用于探测阶段。 */
export async function tryGetJson(
  url: string,
  apiKey: string | null | undefined,
  timeoutMs: number,
): Promise<{ status: number; json: unknown } | null> {
  try {
    const r = await getJson(url, { apiKey, timeoutMs, retries: 0 });
    return { status: r.status, json: r.json };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, json: err.json };
    return null;
  }
}
