import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEvent, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import extension from "../opencode-inference";

const originalKey = process.env.OPENCODE_API_KEY;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
	fetchSpy?.mockRestore();
	spawnSpy?.mockRestore();
	if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
	else process.env.OPENCODE_API_KEY = originalKey;
});

function provider() {
	process.env.OPENCODE_API_KEY = "fixture-not-a-secret";
	let config: ProviderConfig | undefined;
	extension({
		registerProvider(name: string, value: ProviderConfig) {
			expect(name).toBe("opencode");
			config = value;
		},
	} as ExtensionAPI);
	if (!config) throw new Error("Provider was not registered");
	return config;
}

function capture(chunks: unknown[], newline = "\n") {
	const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return Response.json({ data: [{
				id: "beam-free", name: "Beam", recommended_api: "chat-completions",
				cost: { text: { input: { price: 0 }, output: { price: 0 } } },
				limit: { context: 128000, output: 8192 },
				api: { "chat-completions": { base_url: "https://fixture.invalid/v1" } },
			}] });
		}
		requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return new Response(
			chunks.map(chunk => `data: ${JSON.stringify(chunk)}${newline}${newline}`).join("")
				+ `data: [DONE]${newline}${newline}`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}, { preconnect: () => {} }));
	return requests;
}

async function run(config: ProviderConfig, context: Context, options?: SimpleStreamOptions) {
	const models = await config.fetchDynamicModels?.(undefined);
	if (!models?.[0] || !config.streamSimple) throw new Error("Missing provider model/stream");
	const model = buildModel({ ...models[0], provider: "opencode", api: config.api!, baseUrl: config.baseUrl! });
	const stream = config.streamSimple(model, context, { maxTokens: 50, ...options });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

describe("OMP inference contract", () => {
	test("omits SDK content negotiation unless the caller explicitly supplies it", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		await run(provider(), { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		expect(requests[0].headers.has("accept")).toBe(false);
		await run(provider(), { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, { headers: { Accept: "application/json" } });
		expect(requests[1].headers.get("accept")).toBe("application/json");
	});

	test("does not send the legacy image-danger header absent from native OpenCode requests", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		await run(provider(), { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		expect(requests[0].headers.has("typesafe-danger-zone-images")).toBe(false);
	});

	test("uses OpenCode's descending timestamp session-ID encoding", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		await run(provider(), { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		const sessionID = requests[0].headers.get("x-opencode-session-id")!;
		expect(sessionID).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		const timestamp = BigInt.asUintN(48, ~BigInt(`0x${sessionID.slice(4, 16)}`)) >> 12n;
		const period = 1n << 36n;
		const elapsed = (BigInt(Date.now()) - timestamp + period) % period;
		expect(elapsed < 10_000n).toBe(true);
	});

	test("includes the active OpenCode credential's organization in inference requests", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		const config = provider();
		delete process.env.OPENCODE_API_KEY;
		spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue({
			exitCode: 0,
			stdout: new TextEncoder().encode(JSON.stringify([{
				integrationID: "opencode", active: true,
				value: { type: "oauth", access: "fixture-not-a-secret", expires: 0, metadata: { orgID: "fixture-org" } },
			}])),
		} as ReturnType<typeof Bun.spawnSync>);
		await run(config, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		expect(requests[0].headers.get("x-opencode-org-id")).toBe("fixture-org");
	});

	test("re-reads rejected credentials without retaining the old organization", async () => {
		capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		const config = provider();
		delete process.env.OPENCODE_API_KEY;
		spawnSpy = spyOn(Bun, "spawnSync");
		for (const value of [
			{ access: "fixture-old", metadata: { orgID: "fixture-org" } },
			{ access: "fixture-new" },
		]) {
			spawnSpy.mockReturnValueOnce({
				exitCode: 0,
				stdout: new TextEncoder().encode(JSON.stringify([{
					integrationID: "opencode", active: true, value: { ...value, expires: 0 },
				}])),
			} as ReturnType<typeof Bun.spawnSync>);
		}
		const headers: Headers[] = [];
		const { result } = await run(config, { messages: [{ role: "user", content: "Hi", timestamp: 0 }] }, {
			headers: { "X-Fixture": "preserved" },
			fetch: async (input, init) => {
				headers.push(new Headers(init?.headers));
				return headers.length === 1 ? new Response("Rejected", { status: 401 }) : fetch(input, init);
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(spawnSpy).toHaveBeenCalledTimes(2);
		expect(headers).toHaveLength(2);
		expect(headers[0].get("authorization")).toBe("Bearer fixture-old");
		expect(headers[0].get("x-opencode-org-id")).toBe("fixture-org");
		expect(headers[1].get("authorization")).toBe("Bearer fixture-new");
		expect(headers[1].has("x-opencode-org-id")).toBe(false);
		expect(headers.every(value => value.get("x-fixture") === "preserved")).toBe(true);
	});

	test("keeps streamed text in the final message and emits done", async () => {
		capture([
			{ choices: [{ delta: { content: "Hello " } }] },
			{ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
		]);
		const { result, events } = await run(provider(), { messages: [{ role: "user", content: "Hi", timestamp: 0 }] });
		expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("sends system instructions and tool definitions", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		await run(provider(), {
			systemPrompt: ["Keep replies concise."],
			messages: [{ role: "user", content: "Hi", timestamp: 0 }],
			tools: [{ name: "read_file", description: "Read a file", parameters: type({ path: "string" }) }],
		});
		expect((requests[0].body.messages as Array<{ role: string; content: string }>)
			.some(m => m.role === "system" && m.content.includes("Keep replies concise."))).toBe(true);
		expect(requests[0].body.tools).toEqual([expect.objectContaining({
			type: "function", function: expect.objectContaining({ name: "read_file" }),
		})]);
	});

	test("includes OpenCode's env marker in the system prompt", async () => {
		const requests = capture([{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }]);
		await run(provider(), {
			systemPrompt: ["Keep replies concise."],
			messages: [{ role: "user", content: "Hi", timestamp: 0 }],
		}, { cwd: "/tmp/opencode/probe" });
		const system = (requests[0].body.messages as Array<{ role: string; content: string }>)
			.find(m => m.role === "system")?.content ?? "";
		expect(system).toContain("<env>\n  Working directory: /tmp/opencode/probe\n</env>");
	});

	test("assembles fragmented tool calls and usage across CRLF frames", async () => {
		capture([
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: "tool_calls" }] },
			{ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
		], "\r\n");
		const { result, events } = await run(provider(), { messages: [{ role: "user", content: "Read it", timestamp: 0 }] });
		// Native tool blocks also carry private parser metadata.
		expect(result.content).toMatchObject([{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } }]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.usage).toMatchObject({ input: 12, output: 4, totalTokens: 16 });
		expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(1);
	});
});
