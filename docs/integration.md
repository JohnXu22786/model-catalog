# dsh 接入说明

本文档说明插件化 harness（dsh）如何加载本插件、插件暴露的工具/事件接口，以及如何把发现的模型目录消费为 dsh 可用的模型配置。

## 1. 插件清单

`manifest.json`（插件根目录）声明了加载所需的全部信息：

| 字段 | 值 | 说明 |
|---|---|---|
| `id` | `dsh.model-catalog` | 插件唯一标识 |
| `kind` | `plugin` | 插件类型 |
| `entry.module` | `./dist/src/plugin.js` | 入口模块（ESM） |
| `entry.factory` | `createPlugin` | 入口导出的工厂函数名 |
| `entry.cli` | `./dist/src/main.js` | 独立 CLI（可脱离 harness 运行） |
| `requires.dsh` | `>=0.1.0` | 所需的 harness 版本 |
| `interfaces.tools` | `catalog.discover` 等 5 个 | 本插件注册的工具名 |
| `interfaces.events` | `catalog.updated` / `catalog.failed` | 本插件发出的事件名 |
| `interfaces.config` | `catalog.config.json` 与配置键 | 配置文件与键清单 |
| `permissions` | `network` / `fs:read` / `fs:write` | 需要的权限声明 |
| `resources` | data/*、out/* | 依赖与产物清单 |

构建要求：插件以 TypeScript 源码形式分发，需先执行 `npm install && npm run build` 生成 `dist/`（或由 harness 构建系统执行）。运行时仅依赖 Node.js ≥ 21 内置能力（见 `package.json` 的 engines 与 README），无第三方依赖。

### 1.1 Cordis bundle 入口（`dsh plugin add` 的加载方式）

除 manifest 工厂外，插件还声明了 `dsh.bundle`（`package.json` 指向 `cordis.patch.yml`）：
安装插件行后，dsh 以 Cordis 插件方式加载 `dist/src/dsh.js`，该模块导出：

```ts
export const name = 'model-catalog';          // 插件行引用的包名
export const inject = ['tools'];               // 依赖 dsh 的工具注册服务
export function apply(ctx, rowConfig) { ... } // 加载时执行
```

`apply` 把 dsh 的 Context 适配为 `createPlugin().register()` 期望的接口，注册 5 个工具
（`catalog.discover` / `list` / `refresh` / `select` / `probe`）并转换为 dsh 的
ToolDefinition 形态；卸载（热重载）时回收全部注册。工具参数与返回与第 3 节完全一致；
配置键（`catalog.baseUrl`、`catalog.apiKeyEnv` 等）可从插件行的 `config` 提供，
未提供时回落到 `catalog.config.json` 与默认值。

## 2. 加载流程

```
1. harness 读取 manifest.json（id/version/entry）
2. import entry.module（ESM，NodeNext 解析）
3. const plugin = module[entry.factory]()        // createPlugin()
4. await plugin.register(ctx)                    // 注册工具与事件订阅
5. 之后 harness 可按 interfaces.tools 直接调用已注册工具
```

`register(ctx)` 接收的上下文接口（`src/plugin.ts` 中定义）：

```ts
interface DshContext {
  config: { get(key: string, fallback?: unknown): unknown };   // harness 配置读取
  events: { emit(name: string, payload: Record<string, unknown>): void }; // 事件总线
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  tools: { register(name: string, handler: PluginToolHandler): void };
}
```

配置键：harness 可通过 `ctx.config.get('catalog.baseUrl')` 等键提供配置（`catalog.baseUrl`、`catalog.apiKeyEnv`、`catalog.probe`、`catalog.externalUrl`、`catalog.outputDir`、`catalog.cacheDir`）；未提供时插件回落到 `catalog.config.json` 文件与默认值。插件会在注册完成时通过 `log.info` 输出确认信息。

## 3. 工具接口

所有工具均为异步函数：`handler(params) => Promise<{ ok: true, data } | { ok: false, error }>`。

### catalog.discover

对目标主机执行完整发现流程（识别 → 采集 → 归一化 → 探测 → 写出产物）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `baseUrl` | string | 主机地址（也可走配置 `catalog.baseUrl`） |
| `apiKeyEnv` | string? | 密钥环境变量名（默认自动检测） |
| `apiKey` | string? | 临时直接传密钥（不推荐，仅调试） |
| `probe` | string? | 探测模式覆盖：`auto`/`never`/`always` |

返回 `data`：`{ baseUrl, kind, modelCount, generatedAt, outputs: { catalog, snippet, report }, warnings }`。

成功后发出事件 `catalog.updated`。

### catalog.list

返回模型目录。优先读取已生成的 `out/catalog.json`（由 `catalogTtlSec` 控制新鲜度），过期或缺失时自动重新发现。

返回 `data`：`{ source: 'cache' | 'fresh', generatedAt, models: ModelEntry[] }`。

### catalog.refresh

强制重新发现（忽略目录缓存；探测/分类结果仍走自身 TTL 缓存），返回与 `catalog.discover` 相同的 `data`。

### catalog.select

从当前目录中选出指定模型，生成 dsh 配置片段。

| 参数 | 类型 | 说明 |
|---|---|---|
| `ids` | string[] 或逗号分隔字符串 | 模型 id 列表；缺省 = 全部 |

返回 `data`：`{ file, modelCount, models: string[] }`（文件为 `out/dsh-models.json`，schema `dsh/models/v1`）。

### catalog.probe

对单个模型执行能力探测（工具调用/结构化输出/流式），结果写入缓存。

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 目录中的模型 id |

返回 `data`：`{ model, capabilities, evidence, warnings }`，其中 `evidence` 为逐能力探测证据（supported/evidence/at）。

## 4. 事件接口

| 事件 | 触发时机 | 载荷 |
|---|---|---|
| `catalog.updated` | `catalog.discover` 成功 | `{ baseUrl, kind, modelCount, generatedAt, warnings }` |
| `catalog.failed` | 发现流程抛错 | `{ baseUrl, error, at }` |

harness 可订阅事件刷新自身的模型/价格缓存，或在失败时通知用户。

## 5. 消费模型目录

`out/dsh-models.json`（schema `dsh/models/v1`）是 harness 可直接消费的配置：

```jsonc
{
  "schema": "dsh/models/v1",
  "generatedAt": "2026-08-16T04:41:37.371Z",
  "source": { "baseUrl": "https://api.deepseek.com", "kind": "bare" },
  "models": [
    {
      "id": "deepseek-v4-flash",
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "auth": { "kind": "env", "name": "DEEPSEEK_API_KEY" },   // 密钥仅环境变量引用
      "contextWindow": 1048576,
      "maxOutput": 393216,
      "pricing": {
        "billing": "per-token",          // 或 per-call
        "unit": "usd/1M",
        "currency": "USD",
        "amounts": { "input": 0.22, "output": 0.66, "cacheRead": 0.007, "cacheWrite": null, "internalReasoning": null },
        "tiers": [
          { "label": "off-peak", "amounts": { "input": 0.22, "output": 0.66, "cacheRead": 0.007, "cacheWrite": null, "internalReasoning": null } },
          { "label": "peak", "windows": [["01:00","04:00"],["06:00","10:00"]], "amounts": { "input": 0.44, "output": 1.32, "cacheRead": 0.014, "cacheWrite": null, "internalReasoning": null } }
        ],
        "dynamic": true,
        "perCallUsd": null,
        "source": "builtin",             // host | override | mirror | builtin | unknown
        "capturedAt": "2026-08-16T04:41:37.371Z",
        "note": "2026-08-16 起按峰值/非峰值动态计费…"
      },
      "capabilities": {
        "toolCalling": true, "structuredOutput": true, "streaming": true,
        "vision": false, "parallelToolCalls": true, "reasoning": true, "responsesApi": true
      },
      "aliases": [],
      "status": "active"
    }
  ]
}
```

消费建议：

- **路由与鉴权**：`baseUrl` + `auth`（环境变量名）即构成模型客户端所需的端点与凭据；`auth` 为 `null` 表示该主机无需鉴权（如本地 Ollama）。
- **请求预算**：`contextWindow`/`maxOutput` 用于限流与上下文管理；`maxOutput` 为模型允许的最大输出（部分主机可进一步以 `/chat/completions` 的 `max_tokens` 约束）。
- **能力路由**：`capabilities.toolCalling` 决定是否启用工具调用路径；`structuredOutput` 决定是否使用 `response_format`；`streaming` 决定流式输出；`vision` 决定是否允许图像输入；`reasoning` 决定推理模式与 `include_reasoning` 相关参数；`responsesApi` 表示支持 Responses 风格接口。
- **成本核算**：`pricing.amounts` 为当前基准价（USD/1M，`dynamic: true` 时为 off-peak 档），结合 usage 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 按 `cacheRead`/`input` 分档计费；`dynamic` 模型应结合 `tiers[].windows`（UTC）在消费端换算当前档位。
- **模型选择 UI**：可用 `status`（`deprecated` 模型建议置灰提示迁移）与 `aliases` 做名称归一。

`out/catalog.json`（schema `model-catalog/v1`）为完整目录（含告警与全部归一化字段），适合需要全量信息的场景；`out/report.md` 供人工阅读。

## 6. 独立使用

不经过 harness 时，可直接运行 CLI（`entry.cli`）：

```bash
node dist/src/main.js discover --base-url https://api.deepseek.com
node dist/src/main.js pick --base-url https://api.deepseek.com
```

CLI 与工具接口共享同一套发现流水线与缓存，产物完全一致。
