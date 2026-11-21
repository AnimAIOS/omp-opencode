# omp-opencode

OpenCode (`opencode.ai`) as an inference engine for [oh-my-pi (omp)](https://github.com/oh-my-pi/pi-ai).

Registers an `opencode` provider that discovers zero-cost chat models from `https://opencode.ai/inference/v1/models`. OMP's native OpenAI-compatible streamer handles conversation history, system instructions, tools, streaming responses, and token usage.

## Install

```bash
omp plugin install github:AnimAIOS/omp-opencode
```

Or load directly from a local path:

```bash
omp --extension /path/to/omp-opencode.ts
```

## Usage

```bash
omp --model opencode/hy4-flash-free print
```

Free models are auto-discovered (`cost.text.input.price === 0 && cost.text.output.price === 0`) and reflected in `omp models` under the `opencode` provider.

## Auth

The bearer credential is resolved in this order:

1. `OPENCODE_API_KEY` environment variable (if non-empty)
2. `opencode auth export` — the stored `opencode` credential's access token or API key
3. `"public"` fallback

Stored credentials are cached until shortly before their recorded expiry. A 401/403 triggers one credential re-read; this is not an OAuth refresh.

This extension calls OpenCode's inference API directly; OpenCode gates free-model access on its client fingerprint, reproduced here (resolved bearer credential + OpenCode's `<env>` system-prompt marker); worked model is `opencode/hy4-flash-free`.

## Development

```bash
bun install --ignore-scripts
bun test
bun run check
```

Tests use local HTTP fixtures and do not make inference requests.

## Files

- `opencode.ts` — extension entry point (default factory exporting `registerProvider("opencode", …)`)
- `extensions/` — install locations for `~/.omp/agent/extensions/`
