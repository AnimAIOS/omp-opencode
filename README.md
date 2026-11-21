# omp-opencode

OpenCode (`opencode.ai`) as an inference engine for [oh-my-pi (omp)](https://github.com/oh-my-pi/pi-ai).

Registers an `opencode` provider that dynamically scans OpenCode's free-tier models from `https://opencode.ai/inference/v1/models` and streams chat inference through OpenCode's OpenAI-compatible endpoints, spoofing the harness-detection headers the backend uses to recognize its own CLI.

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
omp --model opencode/beam-free print
```

Free models are auto-discovered (`cost.text.input.price === 0 && cost.text.output.price === 0`) and reflected in `omp models` under the `opencode` provider.

## Auth

Inference uses your OpenCode Console OAuth token so the backend recognizes a real CLI session. The token is resolved in this order:

1. `OPENCODE_API_KEY` environment variable (if non-empty)
2. `opencode auth export` — the active `integrationID: "opencode"` credential's `value.access` (cached until expiry; refreshed automatically on a 401/403 response)
3. `"public"` fallback (free-tier only)

Run `opencode auth login` if no credential is stored. The free tier is gated server-side by account quota; once exhausted, requests surface `FreeUsageLimitError` until the quota resets.

## Files

- `opencode.ts` — extension entry point (default factory exporting `registerProvider("opencode", …)`)
- `extensions/` — install locations for `~/.omp/agent/extensions/`
