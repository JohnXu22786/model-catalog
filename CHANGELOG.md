# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 精神，
版本语义遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 新增 dsh bundle 接入：`package.json` 声明 `dsh.bundle` 并指向 `cordis.patch.yml`，
  新增 Cordis 入口 `src/dsh.ts`（导出 `name`/`inject`/`apply`），把 5 个工具
  注册为 dsh 的 ToolDefinition，支持 `dsh plugin add` 安装与热重载卸载。
- `.gitignore` 补充编辑器/系统/打包残留（`.DS_Store`、`*.tgz`、`coverage/` 等）。

### Fixed

- CLI：`--probe` 传入非法值时不再静默透传，回退到默认/已配置模式（新增
  `coerceProbeMode` 纯函数，与配置解析语义一致）。
- `normalizeBaseUrl`：`//v1` 双重斜杠输入现在正确去掉尾部斜杠，不留残余。

### Docs

- `docs/integration.md`：修正 Node 版本要求不一致（≥20 → ≥21，与 engines/README 对齐），
  新增 Cordis bundle 入口说明；README en/zh 补充 bundle 安装说明。

## [1.0.0] - 2026-08-16

### Added

- 首个发布：模型目录自动发现插件。
  - 主机类型自动识别（bare/augmented/quota/flag/ollama/vllm），支持 `--kind` 强制指定；
  - 全链路单位归一化（每 token 美元 / 每百万美元 / 倍率 / 按次）与定价溯源；
  - 定价来源优先级链：主机 → 用户覆盖 → 外部镜像 → 内置默认表 → 未知；
  - 能力缺失时的轻量实测探测（工具调用/结构化输出/流式），结果按 TTL 缓存；
  - 缓存与并发安全（原子写、跨进程文件锁、损坏自动恢复）；
  - 三种输出：`out/catalog.json`、`out/dsh-models.json`、`out/report.md`；
  - 交互式 `pick` 命令与 `cache --clear`、`config` 命令。