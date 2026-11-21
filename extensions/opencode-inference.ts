import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCustomApi } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";

const MODELS_URL = "https://opencode.ai/inference/v1/models";
const PROVIDER_API = "opencode-inference";
const CLI_VERSION = "2.3.0.r371.g2002222";
const USER_AGENT = `opencode/latest/${CLI_VERSION}/cli`;
const BASE_URL = "https://opencode.ai/inference/openai/v1";

const SESSION_ID = (() => {
	const b62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let rand = "";
	for (const byte of crypto.getRandomValues(new Uint8Array(14))) rand += b62[byte % b62.length];
	const ts = BigInt.asUintN(48, ~(BigInt(Date.now()) * 0x1000n + 1n)).toString(16).padStart(12, "0");
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

interface OpenCodeAuth {
	token: string;
	orgID?: string;
	expiresAt: number;
}

/** Keep the Console credential and its organization together. */
let cachedAuth: OpenCodeAuth | undefined;
function resolveAuth(): OpenCodeAuth {
	const envKey = process.env.OPENCODE_API_KEY;
	if (envKey) return { token: envKey, expiresAt: Infinity };
	const now = Date.now();
	if (cachedAuth && now < cachedAuth.expiresAt - 60_000) return cachedAuth;
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
				value: { access?: string; key?: string; token?: string; expires?: number; metadata?: { orgID?: string } };
			}>;
			const cred =
				arr.find((c) => c.integrationID === "opencode" && c.active !== false) ??
				arr.find((c) => c.integrationID === "opencode");
			if (cred) {
				const tok = cred.value.access ?? cred.value.token ?? cred.value.key ?? "";
				if (tok) {
					cachedAuth = {
						token: tok,
						orgID: typeof cred.value.metadata?.orgID === "string" ? cred.value.metadata.orgID : undefined,
						expiresAt: typeof cred.value.expires === "number"
							? cred.value.expires
							: now + 24 * 3600 * 1000,
					};
					return cachedAuth;
				}
			}
		}
	} catch {}
	return { token: "public", expiresAt: 0 };
}

export default function (pi: ExtensionAPI) {
	const modelsById = new Map<string, FamilyApi>();

	const streamSimple = (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const spec = modelsById.get(model.id) ?? { api: PROVIDER_API, baseUrl: "" };
		// The native streamer supports custom API ids; assert only the request-local clone.
		const requestModel = {
			...model,
			baseUrl: spec.baseUrl || model.baseUrl || BASE_URL,
		} as Model<"openai-completions">;
		const auth = resolveAuth();
		const fetchImpl = options?.fetch ?? fetch;
		// OpenCode's inference gate expects its <env> system-prompt marker.
		const cwd = options?.cwd ?? process.cwd();
		const nativeContext: Context = {
			...context,
			systemPrompt: [...(context.systemPrompt ?? []), `<env>\n  Working directory: ${cwd}\n</env>`],
		};
		let retried = false;
		return streamOpenAICompletions(requestModel, nativeContext, {
			...options,
			apiKey: auth.token,
			maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
			omitStainlessTimeoutHeader: true,
			headers: {
				Authorization: `Bearer ${auth.token}`,
				...(auth.orgID ? { "x-opencode-org-id": auth.orgID } : {}),
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"x-opencode-client": "cli",
				"x-opencode-session-id": SESSION_ID,
				"x-session-affinity": SESSION_ID,
				"X-Session-Id": SESSION_ID,
				"x-opencode-project": "global",
				"x-opencode-session": SESSION_ID,
				...options?.headers,
			},
			fetch: async (input, init) => {
				const requestHeaders = new Headers(init?.headers);
				requestHeaders.delete("Accept");
				for (const [name, value] of Object.entries(options?.headers ?? {})) {
					requestHeaders.set(name, value);
				}
				const requestInit = { ...init, headers: requestHeaders };
				const resp = await fetchImpl(input, requestInit);
				if (!retried && (resp.status === 401 || resp.status === 403)) {
					retried = true;
					cachedAuth = undefined;
					await resp.body?.cancel();
					const retryAuth = resolveAuth();
					const headers = new Headers(requestInit.headers);
					headers.set("Authorization", `Bearer ${retryAuth.token}`);
					if (retryAuth.orgID) headers.set("x-opencode-org-id", retryAuth.orgID);
					else headers.delete("x-opencode-org-id");
					for (const [name, value] of Object.entries(options?.headers ?? {})) {
						headers.set(name, value);
					}
					return fetchImpl(input, { ...requestInit, headers });
				}
				return resp;
			},
		});
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
