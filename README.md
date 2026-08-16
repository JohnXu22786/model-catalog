[简体中文](README.zh.md)

# Model Catalog — Model Catalog Auto-Discovery (dsh plugin)

This plugin is designed for the dsh ecosystem (a plugin-based DeepSeek harness where everything is a plugin): once you configure an OpenAI-compatible API host in dsh (official API, relay gateway, local inference service, etc.), the plugin automatically pulls model information from that host's endpoints — model listings, pricing (input/output/cache prices per million tokens), inference parameters (context length, max output, capability flags: tool calling / structured output / vision / parallel tools, etc.) — normalizes it, and generates ready-to-use model configs, saving you the manual work.

**Core value**:
- Host-type auto-detection, no protocol details to configure;
- End-to-end unit normalization (per-token USD / per-million USD / multipliers / per-call);
- Traceable pricing (captured_at + source endpoint), structured dynamic pricing;
- Optional lightweight live probing for missing capabilities;
- Three outputs: full catalog, dsh config fragment, human-readable report.

---

## Features

- **Host type auto-detection**: standard compatible (minimal fields) / rich metadata (`/models` with pricing and parameter lists) / multiplier-priced gateway (quota system) / capability-flag proxy (`/model/info` capability booleans) / Ollama / vLLM; fails with an error when all endpoint probes fail, and supports manual `--kind`.
- **Normalized model records**: `id / context window / max output / pricing family (input, output, cache_read, cache_write, internal_reasoning, in USD/1M) / capability flags / source provenance`.
- **Pricing source chain**: host endpoint → user override config → external price mirror → built-in default table → marked unknown (with warning).
- **Built-in default table**: model facts and pricing fallback for the official API (DeepSeek); dynamic pricing (peak/off-peak billing from 2026-08-16) expressed as structured tiers.
- **Capability probe verification** (switchable): sends minimal requests to live-test capabilities missing from metadata (tool calling / structured output / streaming), results cached per `(baseUrl, model)`.
- **Cache and concurrency safety**: classification/probe/mirror results cached with TTL; file locking + atomic writes prevent concurrent processes from corrupting each other; corrupted caches auto-recover.
- **Interactive config generation**: the `pick` command lists models and prices; select one to generate a dsh config fragment.
- **Self-contained**: manifest + entry factory + tool/event interfaces, directly loadable by the harness (see [integration docs](docs/integration.md)).

## How It Works

```
baseUrl + apiKey
   │
   ▼
① Host detection (probe endpoints, result cached 1h)
   ├─ /models rich metadata     → augmented
   ├─ /v1/models                → ├─ /api/pricing → quota
   │                              ├─ /version     → vllm
   │                              ├─ /model/info  → flag
   │                              └─ otherwise    → bare
   ├─ /api/tags                 → ollama
   └─ all failed                → unknown (error; override with --kind)
   │
   ▼
② Fetch (parse model listings/pricing/capabilities by type)
   │
   ▼
③ Normalize (unit conversion + source-chain completion + alias resolution)
   │
   ▼
④ Capability probing (optional; only fills gaps missing from metadata)
   │
   ▼
⑤ Output
   ├─ out/catalog.json     full catalog (schema: model-catalog/v1)
   ├─ out/dsh-models.json  dsh config fragment (schema: dsh/models/v1)
   └─ out/report.md        human-readable report
```

## Installing in DSH

```bash
dsh plugin --profile demo add github:JohnXu22786/model-catalog
```

Remove with:

```bash
dsh plugin --profile demo remove model-catalog
```

## Quick Start

Requirements: Node.js ≥ 21 (no runtime dependencies; only TypeScript needed to build).

```bash
npm install          # install dev dependencies
npm run build        # compile to dist/

# Discover the DeepSeek official API model catalog
export DEEPSEEK_API_KEY=sk-xxx
node dist/src/main.js discover --base-url https://api.deepseek.com

# Discover a local Ollama
node dist/src/main.js discover --base-url http://127.0.0.1:11434 --probe always

# Relay gateway (multiplier pricing)
node dist/src/main.js discover --base-url https://gateway.example.com --api-key-env GATEWAY_KEY

# Interactively pick models and generate a dsh config fragment (answers can be piped in one shot:
#   line 1 = baseUrl, line 2 = key env var name (blank = auto-detect), line 3 = model number)
node dist/src/main.js pick --base-url https://api.deepseek.com
```

After running, three artifacts land in the `out/` directory. Hand `dsh-models.json` to the dsh harness to complete model configuration (field docs in [integration docs](docs/integration.md)).

## Host Types

| Type | Detection | Pricing source | Notes |
|---|---|---|---|
| `bare` standard compatible | `/v1/models` with minimal fields only | none → fallback chain | The most basic OpenAI-compatible form; the DeepSeek official API is this type, completed by the built-in default table |
| `augmented` rich metadata | `/models` includes `context_length`/`pricing`/`supported_parameters` | provided directly by the host (USD-per-token strings) | Implemented by a few gateways |
| `quota` multiplier-priced gateway | `/api/pricing` (compatible with legacy map form) | multiplier × $2.0 × group multiplier | Common quota pricing system in relay gateways |
| `flag` capability-flag proxy | `/model/info` (falls back to `/v1/model/info` on 404) | per-token USD numbers | Returns capability booleans and prices |
| `ollama` | `/api/tags` | none → fallback chain | Local service; `/api/show` provides capabilities and context |
| `vllm` | `/v1/models` + `/version` | none → fallback chain | Local inference service, no key required |

## Normalization and Unit Conversion

All per-token prices in the catalog are normalized to **USD per million tokens (USD/1M)**; per-call prices are marked separately:

| Input form | Conversion |
|---|---|
| USD-per-token string (e.g. `"0.00000056"`, `"$0.00003"`) | ×1e6, rounded to 6 decimal places |
| USD-per-token number (e.g. `1.5e-7`) | ×1e6 |
| Multiplier (quota system, `model_ratio`) | input = `model_ratio × 2.0 × group_ratio`; output = `model_ratio × completion_ratio × 2.0 × group_ratio` (`completion_ratio`/`group_ratio` default 1; `group_ratio` uses the default group when it is a map) |
| Per-call (`quota_type=1`) | `per-call USD = model_price × group_ratio`, `billing: "per-call"` |

`augmented` pricing field mapping: `prompt → input`, `completion → output`, `input_cache_read → cacheRead`, `input_cache_write → cacheWrite`, `internal_reasoning → internalReasoning`.

## Pricing Source Priority

```
1. Host endpoint (full trust: if the host provides some prices, no other sources are consulted)
2. User override config data/overrides.json (replacement semantics: override only the fields configured)
3. External price mirror --external-url (only fills fully-missing pricing; result cached 1h)
4. Built-in default table data/builtin-table.json (only fills gaps; includes DeepSeek official model facts)
5. None of the above → pricing: null, marked "unknown" in the report with a warning
```

Capability fields, context and max output follow the same "host > override > mirror > built-in table" priority (override is replacement; the rest only fill gaps).

### Dynamic Pricing

The DeepSeek official API has billed by **peak/off-peak** time-of-day since 2026-08-16 (peak: 01:00–04:00 and 06:00–10:00 UTC; half price at other times). In the catalog:

- `pricing.dynamic: true`;
- `pricing.amounts` holds the baseline tier (first off-peak tier) prices;
- `pricing.tiers` carries all tiers (label, UTC window, per-tier prices);
- the report (report.md) lists dynamic-priced models separately with a note that billing is per-tier;
- the built-in default table records the official prices of the day; if they differ from the official docs, follow the docs and update `data/builtin-table.json`.

## Capability Probing

For capabilities **missing** from metadata (tool calling / structured output / streaming), sends minimal probe requests (`max_tokens` tiny, message very short) to live-test host support:

- Tool calling: sends `tools` + forced `tool_choice`;
- Structured output: `response_format: {type: "json_object"}` (message contains the word "json" to dodge the classic JSON-mode rejection trap);
- Streaming: `stream: true`; the response must actually be SSE (has `data:` events and a `[DONE]` terminator); a plain JSON body is judged unsupported.

Interpretation: `2xx` = supported; `400/404/405/422` = unsupported (error-body summary kept as evidence); `401/403` = abort all probing with a warning (avoid wasting quota); `5xx/network/timeout` = stays unknown with a short-lived error cache.

- Modes: `auto` (default; probes only with a key or a local host) / `never` / `always`;
- Results cached per `(baseUrl, model, capability)` for 24h (errors 30m);
- Capabilities that cannot be cheaply live-tested (vision, parallel tools) rely on metadata only; no probing.

## Cache and Concurrency Safety

- Cache directory `var/` (`vault.json`): host classification (1h), probe results (24h/30m), external mirror (1h);
- All writes go through "temp file + atomic rename"; corrupted cache files are reset automatically without affecting operation;
- Cross-process file lock (`var/.lock`): stale locks (>5 minutes) are taken over automatically; wait timeout (10s) raises an error;
- `cache --clear` wipes everything in one command.

## Configuration

Config file `catalog.config.json` (in the plugin root; overridable with `--config FILE`; all fields optional):

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

| Field | Default | Description |
|---|---|---|
| `baseUrl` | none | Host address; also `--base-url` on the CLI |
| `apiKeyEnv` | auto | Key environment variable name; auto-detects `MODELCAT_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` |
| `kindHint` | none | Force host type (bare/augmented/quota/flag/ollama/vllm) |
| `probe` | `auto` | Capability probe mode |
| `catalogTtlSec` | 900 | Catalog freshness (reused by the plugin `list` tool) |
| `probeTtlSec` | 86400 | Probe result cache TTL |
| `detectTtlSec` | 3600 | Host classification cache TTL |
| `externalUrl` | none | External price mirror URL (structure in data/mirror.example.json) |
| `outputDir` / `cacheDir` | `out` / `var` | Output and cache directories |
| `concurrency` | 4 | Fetch concurrency (e.g. Ollama `/api/show`) |
| `httpTimeoutMs` | 10000 | HTTP timeout |

Keys are only passed via environment variables (`--api-key` is for transient CLI use only); no artifact file ever contains a plaintext key.

## Data Files

| File | Purpose |
|---|---|
| `data/builtin-table.json` | Built-in default table (fallback): DeepSeek official model facts and time-of-day pricing |
| `data/overrides.example.json` → copy to `data/overrides.json` | Manual overrides: per-field replacement |
| `data/aliases.example.json` → copy to `data/aliases.json` | Alias mapping: old names/aliases → canonical ids |
| `data/mirror.example.json` | External mirror format example (self-hostable isomorphic JSON) |

## Outputs

| File | Content |
|---|---|
| `out/catalog.json` | Full catalog (schema `model-catalog/v1`): metadata, warnings, all normalized entries |
| `out/dsh-models.json` | dsh config fragment (schema `dsh/models/v1`): directly consumable by the harness |
| `out/report.md` | Human-readable: catalog tables, unknown-pricing list, dynamic pricing, warnings |

## CLI Overview

```
model-catalog discover [args]          discover and output the model catalog (default command)
model-catalog pick [args]              interactively pick models and generate a dsh config fragment
model-catalog probe --model ID [args]  run capability probing for a single model
model-catalog cache --clear            clear the cache
model-catalog config                   show effective config

--base-url URL      --api-key-env NAME   --api-key KEY
--kind KIND         --probe MODE         --out DIR
--cache DIR         --external-url URL   --config FILE
--model ID          --help
```

## dsh Integration

The plugin is self-contained: `manifest.json` declares the entry and interfaces, and `dist/src/plugin.js` exports a `createPlugin()` factory registering 5 tools (`catalog.discover/list/refresh/select/probe`) and 2 events (`catalog.updated/catalog.failed`). It is also installable via the dsh bundle (`package.json` → `dsh.bundle` → `cordis.patch.yml`): the Cordis entry `dist/src/dsh.js` exports `name`/`inject`/`apply` and registers the same 5 tools on the harness. Harness loading, tool parameters and returns, event payloads, and how config fragments are consumed are all covered in **[docs/integration.md](docs/integration.md)**.

## Limitations and Notes

- Capabilities like vision and parallel tools cannot be cheaply live-tested; they come from metadata only (unknown when missing);
- If a multiplier gateway's `group_ratio` is a map without a `default` group, it counts as 1 — actual group multipliers can be corrected in the override config;
- Probe requests consume a small number of tokens (at most 3 requests per model, 1–16 tokens each); keyless standard hosts are not probed in `auto` mode;
- Built-in default table prices are fallbacks; for dynamic pricing, follow the official docs and the tiers.

## Development

```bash
npm run build    # compile TypeScript
npm test         # compile + run all tests (node:test, no external test deps)
```

Test coverage: unit conversion, host detection, per-type fetching, normalization priority chain, probe interpretation and caching, cache store (TTL/locking/corruption recovery), output artifacts, and an end-to-end pipeline (local mock host).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 JohnXu22786.
