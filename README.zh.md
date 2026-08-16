[English](README.md)

# Model Catalog — 模型目录自动发现（dsh 插件）

本插件为 dsh（插件化 DeepSeek harness，一切皆是插件）生态设计：当你在 dsh 中配置了一个 OpenAI 兼容的 API 主机（官方 API、中转网关、本地推理服务等）后，插件自动从该主机的接口拉取模型信息——模型列表、定价（每百万 token 的输入/输出/缓存价）、推理参数（上下文长度、最大输出、能力标志：工具调用/结构化输出/视觉/并行工具等），归一化后生成可直接使用的模型配置，省去手工填写。

**核心价值**：
- 主机类型自动识别，无需配置协议细节；
- 全链路单位归一化（每 token 美元 / 每百万美元 / 倍率 / 按次）；
- 定价可溯源（captured_at + 来源端点），动态定价结构化表达；
- 能力缺失时可选轻量实测探测；
- 输出三种产物：完整目录、dsh 配置片段、人类可读报告。

---

## 功能特性

- **主机类型自动识别**：标准兼容（最小字段）/ 富元数据（/models 带定价与参数清单）/ 倍率计价网关（quota 体系）/ 能力标志代理（/model/info 能力布尔族）/ Ollama / vLLM，全部端点探测失败时报错并支持 `--kind` 手工指定。
- **归一化模型记录**：`id / 上下文窗口 / 最大输出 / 定价族（input、output、cache_read、cache_write、internal_reasoning，单位 USD/1M）/ 能力标志 / 来源溯源`。
- **定价来源链**：主机接口 → 用户覆盖配置 → 外部价格镜像 → 内置默认表 → 标注未知（产生告警）。
- **内置默认表**：官方 API（DeepSeek）的模型事实与定价兜底；动态定价（2026-08-16 起 peak/off-peak 分时计费）以结构化 tiers 表达。
- **能力探测验证**（可开关）：对元数据缺失的能力项（工具调用/结构化输出/流式）发送最小化请求实测，结果按 `(baseUrl, model)` 缓存。
- **缓存与并发安全**：分类/探测/镜像结果按 TTL 缓存；文件锁 + 原子写防止并发进程互相破坏；损坏缓存自动恢复。
- **交互式配置生成**：`pick` 命令列出模型与价格，选择后生成 dsh 配置片段。
- **自包含**：manifest + 入口工厂 + 工具/事件接口，harness 可直接加载（见 [接入说明](docs/integration.md)）。

## 工作原理

```
baseUrl + apiKey
   │
   ▼
① 主机识别（探测端点，结果缓存 1h）
   ├─ /models 富元数据        → augmented
   ├─ /v1/models              → ├─ /api/pricing → quota
   │                            ├─ /version     → vllm
   │                            ├─ /model/info  → flag
   │                            └─ 否则         → bare
   ├─ /api/tags               → ollama
   └─ 全部失败                → unknown（报错，可 --kind 指定）
   │
   ▼
② 采集（按类型解析模型列表/定价/能力）
   │
   ▼
③ 归一化（单位换算 + 来源链补全 + 别名解析）
   │
   ▼
④ 能力探测（可开关，仅补元数据缺失项）
   │
   ▼
⑤ 输出
   ├─ out/catalog.json     完整目录（schema: model-catalog/v1）
   ├─ out/dsh-models.json  dsh 配置片段（schema: dsh/models/v1）
   └─ out/report.md        人类可读报告
```

## 快速开始

要求：Node.js ≥ 21（无运行时依赖；构建仅需 typescript）。

```bash
npm install          # 安装开发依赖
npm run build        # 编译到 dist/

# 发现 DeepSeek 官方 API 的模型目录
export DEEPSEEK_API_KEY=sk-xxx
node dist/src/main.js discover --base-url https://api.deepseek.com

# 发现本地 Ollama
node dist/src/main.js discover --base-url http://127.0.0.1:11434 --probe always

# 中转网关（倍率计价）
node dist/src/main.js discover --base-url https://gateway.example.com --api-key-env GATEWAY_KEY

# 交互式选择模型并生成 dsh 配置片段（也可用管道一次性喂入回答：
#   第 1 行 baseUrl，第 2 行密钥环境变量名（空行=自动检测），第 3 行模型编号）
node dist/src/main.js pick --base-url https://api.deepseek.com
```

运行后在 `out/` 目录得到三份产物。把 `dsh-models.json` 交给 dsh harness 即完成模型配置（字段说明见 [接入说明](docs/integration.md)）。

## 主机类型

| 类型 | 识别依据 | 定价来源 | 说明 |
|---|---|---|---|
| `bare` 标准兼容 | `/v1/models` 仅最小字段 | 无 → 走兜底链 | OpenAI 兼容最基础形态；DeepSeek 官方 API 即此类，由内置默认表补齐 |
| `augmented` 富元数据 | `/models` 含 `context_length`/`pricing`/`supported_parameters` | 主机直接提供（每 token 美元字符串） | 少数网关实现 |
| `quota` 倍率计价网关 | `/api/pricing`（兼容旧式 map 形态） | 倍率 × $2.0 × 分组倍率 | 中转网关常用 quota 计价体系 |
| `flag` 能力标志代理 | `/model/info`（404 时回退 `/v1/model/info`） | 每 token 美元数字 | 返回能力布尔族与价格 |
| `ollama` | `/api/tags` | 无 → 走兜底链 | 本地服务，`/api/show` 提供能力与上下文 |
| `vllm` | `/v1/models` + `/version` | 无 → 走兜底链 | 本地推理服务，无需密钥 |

## 归一化与单位换算

目录内所有按量价格统一为 **每百万 token 美元（USD/1M）**，按次价格单独标注：

| 输入形态 | 换算 |
|---|---|
| 每 token 美元字符串（如 `"0.00000056"`、`"$0.00003"`） | ×1e6，四舍五入到 6 位小数 |
| 每 token 美元数字（如 `1.5e-7`） | ×1e6 |
| 倍率（quota 体系，`model_ratio`） | 输入 = `model_ratio × 2.0 × group_ratio`；输出 = `model_ratio × completion_ratio × 2.0 × group_ratio`（`completion_ratio`/`group_ratio` 缺省 1；`group_ratio` 为映射时取 default 组） |
| 按次（`quota_type=1`） | `单次美元 = model_price × group_ratio`，`billing: "per-call"` |

`augmented` 类型的定价字段映射：`prompt → input`、`completion → output`、`input_cache_read → cacheRead`、`input_cache_write → cacheWrite`、`internal_reasoning → internalReasoning`。

## 定价来源优先级

```
1. 主机接口（整体信任：主机给了部分价格就不再拼接其他来源）
2. 用户覆盖配置 data/overrides.json（替换语义：配置了哪个字段就覆盖哪个字段）
3. 外部价格镜像 --external-url（仅填充完全缺失的定价；结果缓存 1h）
4. 内置默认表 data/builtin-table.json（仅填充缺失；含 DeepSeek 官方模型事实）
5. 以上皆无 → pricing: null，报告与告警标注「未知」
```

能力字段与上下文/最大输出同样遵循「主机 > 覆盖 > 镜像 > 内置表」的优先级（覆盖为替换语义，其余仅填空）。

### 动态定价

DeepSeek 官方 API 自 2026-08-16 起按 **峰值/非峰值** 分时计费（峰值：01:00–04:00 与 06:00–10:00 UTC，其余时段半价）。目录中：

- `pricing.dynamic: true`；
- `pricing.amounts` 为基准档（首档 off-peak）价格；
- `pricing.tiers` 携带全部分档（label、UTC 时段、各档价格）；
- 报告（report.md）单独列出动态定价模型并提示按档位计费；
- 内置默认表收录当日官方价格，如与官方文档不一致请以官方文档为准并更新 `data/builtin-table.json`。

## 能力探测

对元数据**缺失**的能力项（工具调用 / 结构化输出 / 流式）发送最小化探测请求（`max_tokens` 极小、消息极短），实测主机是否支持：

- 工具调用：携带 `tools` + 强制 `tool_choice`；
- 结构化输出：`response_format: {type: "json_object"}`（消息含 "json" 字样，规避 JSON 模式的经典拒绝陷阱）；
- 流式：`stream: true`，实测响应必须为 SSE（含 `data:` 事件并收到 `[DONE]`），只回普通 JSON 判为不支持。

判读：`2xx` = 支持；`400/404/405/422` = 不支持（错误体摘要留证）；`401/403` = 中止全部探测并告警（避免无效消耗）；`5xx/网络/超时` = 保持未知并短时缓存错误。

- 模式：`auto`（默认，有密钥或本地主机才探测）/ `never` / `always`；
- 结果按 `(baseUrl, model, 能力)` 缓存 24 小时（错误类 30 分钟）；
- 视觉/并行工具等无法低成本实测的能力仅依赖元数据，不探测。

## 缓存与并发安全

- 缓存目录 `var/`（`vault.json`）：主机分类（1h）、探测结果（24h/30m）、外部镜像（1h）；
- 写入全部走「临时文件 + 原子 rename」；损坏的缓存文件自动重置，不影响运行；
- 跨进程文件锁（`var/.lock`）：陈旧锁（>5 分钟）自动接管，等待超时（10s）抛错；
- `cache --clear` 一键清空。

## 配置

配置文件 `catalog.config.json`（位于插件根目录，可 `--config FILE` 覆盖；所有字段可选）：

```json
{
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "probe": "auto",
  "externalUrl": "https://example.com/mirror.json",
  "outputDir": "out",
  "cacheDir": "var",
  "httpTimeoutMs": 10000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 无 | 主机地址；也可命令行 `--base-url` |
| `apiKeyEnv` | 自动 | 密钥环境变量名；自动检测 `MODELCAT_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` |
| `kindHint` | 无 | 强制主机类型（bare/augmented/quota/flag/ollama/vllm） |
| `probe` | `auto` | 能力探测模式 |
| `catalogTtlSec` | 900 | 目录新鲜度（插件工具 list 复用） |
| `probeTtlSec` | 86400 | 探测结果缓存 TTL |
| `detectTtlSec` | 3600 | 主机分类缓存 TTL |
| `externalUrl` | 无 | 外部价格镜像 URL（结构见 data/mirror.example.json） |
| `outputDir` / `cacheDir` | `out` / `var` | 输出与缓存目录 |
| `concurrency` | 4 | 采集并发数（Ollama /api/show 等） |
| `httpTimeoutMs` | 10000 | HTTP 超时 |

密钥只经环境变量传递（`--api-key` 仅限命令行临时使用），任何产物文件都不包含密钥明文。

## 数据文件

| 文件 | 作用 |
|---|---|
| `data/builtin-table.json` | 内置默认表（兜底）：DeepSeek 官方模型事实与分时定价 |
| `data/overrides.example.json` → 复制为 `data/overrides.json` | 用户手动覆盖：逐字段替换 |
| `data/aliases.example.json` → 复制为 `data/aliases.json` | 别名映射：旧名/别名 → 规范 id |
| `data/mirror.example.json` | 外部镜像格式示例（可自托管同构 JSON） |

## 输出物

| 文件 | 内容 |
|---|---|
| `out/catalog.json` | 完整目录（schema `model-catalog/v1`）：元信息、告警、全部归一化条目 |
| `out/dsh-models.json` | dsh 配置片段（schema `dsh/models/v1`）：harness 可直接消费 |
| `out/report.md` | 人类可读：目录表、未知定价清单、动态定价、告警 |

## CLI 一览

```
model-catalog discover [参数]          发现并输出模型目录（默认命令）
model-catalog pick [参数]              交互式选择模型并生成 dsh 配置片段
model-catalog probe --model ID [参数]  对单个模型执行能力探测
model-catalog cache --clear            清空缓存
model-catalog config                   查看生效配置

--base-url URL      --api-key-env NAME   --api-key KEY
--kind KIND         --probe MODE         --out DIR
--cache DIR         --external-url URL   --config FILE
--model ID          --help
```

## dsh 接入

插件自包含：`manifest.json` 声明入口与接口，`dist/src/plugin.js` 导出 `createPlugin()` 工厂，注册 5 个工具（`catalog.discover/list/refresh/select/probe`）与 2 个事件（`catalog.updated/catalog.failed`）。同时支持 dsh bundle 安装（`package.json` → `dsh.bundle` → `cordis.patch.yml`）：Cordis 入口 `dist/src/dsh.js` 导出 `name`/`inject`/`apply`，把同样的 5 个工具注册到 harness。harness 加载方式、工具参数与返回、事件载荷、配置片段消费方式详见 **[docs/integration.md](docs/integration.md)**。

## 限制与说明

- 视觉、并行工具等能力无法低成本实测，仅取元数据（缺失则未知）；
- 倍率网关的 `group_ratio` 若为映射且无 `default` 组，按 1 计——实际分组倍率可在覆盖配置中修正；
- 探测请求消耗少量 token（每模型最多 3 次、每次 1–16 token）；无密钥的标准主机在 `auto` 模式下不探测；
- 内置默认表的价格为兜底值，动态定价以官方文档与 tiers 为准。

## 开发

```bash
npm run build    # 编译 TypeScript
npm test         # 编译 + 运行全部测试（node:test，无外部测试依赖）
```

测试覆盖：单位换算、主机识别、各类型采集、归一化优先级链、能力探测判读与缓存、缓存仓（TTL/锁/损坏恢复）、输出产物、端到端流水线（本地 mock 主机）。
