# omp-opencode-inference

OpenCode (`opencode.ai`) as an inference engine for [oh-my-pi (omp)](https://github.com/oh-my-pi/pi-ai).

Registers an `opencode` provider that dynamically scans OpenCode's free-tier models from `https://opencode.ai/inference/v1/models` and streams chat inference through OpenCode's OpenAI-compatible endpoints, spoofing the harness-detection headers the backend uses to recognize its own CLI.

## Install

```bash
omp plugin install github:AnimAIOS/omp-opencode-inference
```

Or load directly from a local path:

```bash
omp --extension /path/to/omp-opencode-inference.ts
```

## Usage

```bash
omp --model opencode/beam-free print
```

Free models are auto-discovered (`cost.text.input.price === 0 && cost.text.output.price === 0`) and reflected in `omp models` under the `opencode` provider.

## Auth

Set `OPENCODE_API_KEY` (obtainable via `opencode auth export`) or rely on the stored Console OAuth token. The free tier is gated server-side by account quota; once exhausted, requests surface `FreeUsageLimitError` until the quota resets.

## Files

- `opencode-inference.ts` — extension entry point (default factory exporting `registerProvider("opencode", …)`)
- `extensions/` — install locations for `~/.omp/agent/extensions/`
