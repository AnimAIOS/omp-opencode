import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createAssistantMessageEventStream, registerCustomApi } from "@oh-my-pi/pi-ai";

const MODELS_URL = "https://opencode.ai/inference/v1/models";
const PROVIDER_API = "opencode-inference";
const CLI_VERSION = "2.3.0.r371.g2002222";
const USER_AGENT = `opencode/latest/${CLI_VERSION}/cli`;
const BASE_URL = "https://opencode.ai/inference/openai/v1";

const SESSION_ID = (() => {
	const b62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let rand = "";
	for (let i = 0; i < 14; i++) rand += b62[Math.floor(Math.random() * b62.length)];
	const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
	return `ses_${ts}${rand}`;
})();

interface OpencodeModel {
	id: string;
	name?: string;
	recommended_api: string;
	cost?: {
		text?: {
			input?: { price?: number };
			output?: { price?: number };
		};
	};
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
	capabilities?: { reasoning?: { supported?: boolean } };
	api?: Record<string, { base_url?: string }>;
}

interface FamilyApi {
	api: string;
	baseUrl: string;
}

function isFreeChatModel(m: unknown): m is OpencodeModel {
	const model = m as OpencodeModel | undefined;
	if (!model || model.recommended_api !== "chat-completions") return false;
	const t = model.cost?.text;
	if (!t) return false;
	return Number(t.input?.price ?? 1) === 0 && Number(t.output?.price ?? 1) === 0;
}

function mapInput(mods: string[] | undefined): ("text" | "image")[] {
	const out = new Set<"text" | "image">();
	for (const m of mods || []) {
		if (m === "text") out.add("text");
		else if (m.startsWith("image/")) out.add("image");
	}
	if (out.size === 0) out.add("text");
	return [...out];
}

function familyApis(model: OpencodeModel): Record<string, FamilyApi> {
	const out: Record<string, FamilyApi> = {};
	for (const [family, entry] of Object.entries(model.api || {})) {
		out[family] = { api: family, baseUrl: String(entry.base_url ?? "") };
	}
	return out;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function baseMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface OpenAIStreamChoice {
	index?: number;
	delta?: OpenAIStreamDelta;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
	finish_reason?: string | null;
}

interface OpenAIStreamDelta {
	role?: string;
	content?: string | null;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface OpenAIStreamChunk {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	system_fingerprint?: string;
	choices: OpenAIStreamChoice[];
}

function parseStreamChunk(raw: unknown): OpenAIStreamChunk | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const choices = obj.choices;
	if (!Array.isArray(choices)) return undefined;
	const out: OpenAIStreamChunk = { choices: [] };
	for (const c of choices) {
		if (!c || typeof c !== "object") continue;
		const choice = c as Record<string, unknown>;
		const delta = choice.delta;
		let deltaOut: OpenAIStreamDelta | undefined;
		if (delta && typeof delta === "object") {
			const d = delta as Record<string, unknown>;
			deltaOut = {};
			if (typeof d.role === "string") deltaOut.role = d.role;
			if (typeof d.content === "string") deltaOut.content = d.content;
			if (Array.isArray(d.tool_calls)) {
				deltaOut.tool_calls = [];
				for (const t of d.tool_calls) {
					if (!t || typeof t !== "object") continue;
					const tt = t as Record<string, unknown>;
					const fn = tt.function;
					let fnOut: { name?: string; arguments?: string } | undefined;
					if (fn && typeof fn === "object") {
						const f = fn as Record<string, unknown>;
						if (typeof f.name === "string") fnOut = { name: f.name };
						if (typeof f.arguments === "string") {
							if (!fnOut) fnOut = {};
							fnOut.arguments = f.arguments;
						}
					}
					deltaOut.tool_calls.push({
						index: typeof tt.index === "number" ? tt.index : undefined,
						id: typeof tt.id === "string" ? tt.id : undefined,
						type: typeof tt.type === "string" ? tt.type : undefined,
						function: fnOut,
					});
				}
			}
		}
		const toolCalls = choice.tool_calls;
		let toolCallsOut: OpenAIStreamChoice["tool_calls"] | undefined;
		if (Array.isArray(toolCalls)) {
			toolCallsOut = [];
			for (const t of toolCalls) {
				if (!t || typeof t !== "object") continue;
				const tt = t as Record<string, unknown>;
				const fn = tt.function;
				let fnOut: { name?: string; arguments?: string } | undefined;
				if (fn && typeof fn === "object") {
					const f = fn as Record<string, unknown>;
					if (typeof f.name === "string") fnOut = { name: f.name };
					if (typeof f.arguments === "string") {
						if (!fnOut) fnOut = {};
						fnOut.arguments = f.arguments;
					}
				}
				toolCallsOut.push({
					index: typeof tt.index === "number" ? tt.index : undefined,
					id: typeof tt.id === "string" ? tt.id : undefined,
					type: typeof tt.type === "string" ? tt.type : undefined,
					function: fnOut,
				});
			}
		}
		out.choices.push({
			index: typeof choice.index === "number" ? choice.index : undefined,
			delta: deltaOut,
			tool_calls: toolCallsOut,
			finish_reason:
				typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
		});
	}
	return out;
}

function toolCallFrom(
	entry: { id?: string; function?: { name?: string; arguments?: string } },
): { id: string; name: string; arguments: Record<string, unknown> } {
	const id = entry.id ?? crypto.randomUUID();
	const name = entry.function?.name ?? "";
	let args: Record<string, unknown> = {};
	if (entry.function?.arguments) {
		try {
			const parsed = JSON.parse(entry.function.arguments);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				args = parsed as Record<string, unknown>;
			}
		} catch {
			args = {};
		}
	}
	return { id, name, arguments: args };
}

function deltaArgsString(call: { arguments: Record<string, unknown> }): string {
	try {
		return JSON.stringify(call.arguments);
	} catch {
		return "";
	}
}

/** Resolve the OpenCode bearer token: OPENCODE_API_KEY env first, else `opencode auth export`, else "public". */
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
function resolveToken(): string {
	const envKey = process.env.OPENCODE_API_KEY;
	if (envKey && envKey !== "") return envKey;
	const now = Date.now();
	if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
	try {
		const out = Bun.spawnSync(["opencode", "auth", "export"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (out.exitCode === 0 && out.stdout) {
			const arr = JSON.parse(
				new TextDecoder().decode(out.stdout),
			) as Array<{
				integrationID: string;
				active?: boolean;
				value: { access?: string; key?: string; token?: string; expires?: number };
			}>;
			const cred =
				arr.find((c) => c.integrationID === "opencode" && c.active !== false) ??
				arr.find((c) => c.integrationID === "opencode");
			if (cred) {
				const tok = cred.value.access ?? cred.value.token ?? cred.value.key ?? "";
				if (tok) {
					cachedToken = tok;
					tokenExpiresAt =
						typeof cred.value.expires === "number"
							? cred.value.expires
							: now + 24 * 3600 * 1000;
					return tok;
				}
			}
		}
	} catch {}
	return "public";
}

export default function (pi: ExtensionAPI) {
	const modelsById = new Map<string, FamilyApi>();

	const streamSimple = (
		_model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const model = _model;
		const stream = createAssistantMessageEventStream();
		const spec = modelsById.get(model.id) ?? { api: PROVIDER_API, baseUrl: "" };
		const url = (spec.baseUrl || BASE_URL) + "/chat/completions";
		const messages = context.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));
		const body = {
			model: model.id,
			messages,
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: options?.maxTokens ?? model.maxTokens,
			temperature: options?.temperature,
			top_p: options?.topP,
		};
		const doFetch = async (token: string, retried: boolean): Promise<void> => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"x-opencode-client": "cli",
				"x-opencode-session-id": SESSION_ID,
				"x-session-affinity": SESSION_ID,
				"X-Session-Id": SESSION_ID,
				"x-opencode-project": "global",
				"x-opencode-session": SESSION_ID,
				"TypeSafe-Danger-Zone-Images": "true",
				...options?.headers,
			};
			const resp = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			if (!retried && (resp.status === 401 || resp.status === 403)) {
				cachedToken = null;
				tokenExpiresAt = 0;
				await resp.body?.cancel();
				return doFetch(resolveToken(), true);
			}
				if (!resp.ok || !resp.body) {
					let text = "";
					try {
						text = await resp.text();
					} catch {}
					stream.fail(new Error(`opencode: ${resp.status} ${text}`));
					return;
				}
				const reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				let done = false;
				const pump = (): Promise<void> => {
					if (done) return Promise.resolve();
					if (options?.signal?.aborted) {
						void reader.cancel();
						stream.fail(new Error("aborted"));
						return Promise.resolve();
					}
					return reader.read().then(({ done: d, value }: { done: boolean; value: Uint8Array }) => {
						if (d) {
							done = true;
							buf += decoder.decode();
							if (options?.signal?.aborted) {
								stream.fail(new Error("aborted"));
								return;
							}
							stream.end({ ...baseMessage(model), stopReason: "stop" });
							return;
						}
						buf += decoder.decode(value, { stream: true });
						let idx: number;
						while ((idx = buf.indexOf("\n\n")) >= 0) {
							const line = buf.slice(0, idx);
							buf = buf.slice(idx + 2);
							if (!line.startsWith("data: ")) continue;
							const payload = line.slice(6).trim();
							if (payload === "[DONE]") continue;
							let parsed: unknown;
							try {
								parsed = JSON.parse(payload);
							} catch {
								continue;
							}
							const chunk = parseStreamChunk(parsed);
							if (!chunk) continue;
							const choice = chunk.choices?.[0];
							if (!choice) continue;
							const delta = choice.delta;
							if (delta && typeof delta.content === "string" && delta.content) {
								const partial = {
									...baseMessage(model),
									content: [{ type: "text", text: delta.content }],
								};
								stream.push({
									type: "text_delta",
									contentIndex: 0,
									delta: delta.content,
									partial,
								} as AssistantMessageEvent);
							}
							const calls = delta?.tool_calls ?? choice.tool_calls ?? [];
							for (const c of calls) {
								const call = toolCallFrom({
									id: c.id,
									function: c.function,
								});
								stream.push({
									type: "toolcall_start",
									contentIndex: 0,
									partial: { ...baseMessage(model), content: [] },
								} as AssistantMessageEvent);
								stream.push({
									type: "toolcall_delta",
									contentIndex: 0,
									delta: deltaArgsString(call),
									partial: { ...baseMessage(model), content: [] },
								} as AssistantMessageEvent);
								stream.push({
									type: "toolcall_end",
									contentIndex: 0,
									toolCall: {
										type: "toolCall",
										id: call.id,
										name: call.name,
										arguments: call.arguments,
									},
									partial: { ...baseMessage(model), content: [] },
								} as AssistantMessageEvent);
							}
						}
						return pump();
					});
				};
				pump().catch((err: unknown) => stream.fail(err));
		};
		void doFetch(resolveToken(), false).catch((err: unknown) => stream.fail(err));
		return stream;
	};

	registerCustomApi(PROVIDER_API, streamSimple);

	pi.registerProvider("opencode", {
		baseUrl: BASE_URL,
		api: PROVIDER_API,
		apiKey: "public",
		fetchDynamicModels: async (apiKey) => {
			const res = await fetch(MODELS_URL, {
				headers: {
					Authorization: `Bearer ${apiKey && apiKey !== "" ? apiKey : "public"}`,
				},
			});
			if (!res.ok) throw new Error(`opencode models fetch failed: ${res.status}`);
			const json = (await res.json()) as { data?: unknown[] };
			const rows = json.data || [];
			return rows
				.filter(isFreeChatModel)
				.map((model) => {
					const apis = familyApis(model);
					const fam = model.recommended_api;
					const famApi =
						apis[fam] ?? apis["chat-completions"] ?? { api: PROVIDER_API, baseUrl: "" };
					modelsById.set(model.id, famApi);
					const limit = model.limit ?? {};
					const reasoning = Boolean(model.capabilities?.reasoning?.supported);
					return {
						id: model.id,
						name: model.name ?? model.id,
						api: PROVIDER_API,
						baseUrl: famApi.baseUrl || BASE_URL,
						reasoning,
						input: mapInput(model.modalities?.input),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: Number(limit.context ?? 128000),
						maxTokens: Number(limit.output ?? 8192),
					};
				});
		},
		streamSimple,
	});
}