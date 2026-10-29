import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { decodeKittyPrintable, getCapabilities, Image, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";

const EXTENSION_NAME = "image-gen";
const CONFIG_FILE = join(getAgentDir(), "image-gen.json");
const DEFAULT_BASE_URL = "http://<api-host>:<port>";
const DEFAULT_MODEL = "gpt-image-2.5-flare";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "auto";
const DEFAULT_BACKGROUND = "auto";
const DEFAULT_OUTPUT_FORMAT: ImageOutputFormat = "png";
const DEFAULT_OUTPUT_DIR = ".image-gen";
const DEFAULT_MAX_CONCURRENCY = 1;
const MAX_CONFIGURABLE_CONCURRENCY = 8;
const MAX_REQUEST_PARAM_FALLBACKS = 3;
const MAX_IMAGES_PER_REQUEST = 10;
const IMAGE2_GENERATE_PATH = "/v1/images/generations";
const IMAGE2_EDIT_PATH = "/v1/images/edits";
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const IMAGE_SIZE_VALUES = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2560x1440", "3840x2160"] as const;
const IMAGE_QUALITY_VALUES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const IMAGE_BACKGROUND_VALUES = ["auto", "opaque", "transparent"] as const;
const IMAGE_OUTPUT_FORMAT_VALUES = ["png", "jpeg", "webp"] as const;

type ImageSize = string;
type ImageQuality = string;
type ImageBackground = string;
type ImageOutputFormat = "png" | "jpeg" | "webp";
type Action = "generate" | "edit";
type ToolAction = "help" | "generate" | "edit" | "status";

interface ImageGenConfig {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	size?: ImageSize;
	quality?: ImageQuality;
	background?: ImageBackground;
	outputFormat?: ImageOutputFormat;
	outputDir?: string;
	maxConcurrency?: number;
}

interface ResolvedConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	size: string;
	quality: string;
	background: string;
	outputFormat: ImageOutputFormat;
	outputDir: string;
	maxConcurrency: number;
}

interface ImageRequestOptions {
	action: Action;
	prompt: string;
	image?: string;
	mask?: string;
	outputName?: string;
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
	n?: number;
	model?: string;
}

interface ImageApiResponse {
	data?: Array<{
		b64_json?: string;
		url?: string;
	}>;
	output_format?: string;
	error?: {
		message?: string;
		param?: string;
	};
}

interface ModelListResponse {
	data?: Array<{
		id?: string;
	}>;
	error?: {
		message?: string;
	};
}

interface ImageResult {
	file?: string;
	url?: string;
	responseFile?: string;
	files?: string[];
	b64?: string;
	mimeType?: string;
	images?: Array<{ file: string; b64: string; mimeType: string }>;
	ignoredParams?: string[];
}

interface EditImageInput {
	buffer: Buffer;
	filename: string;
	mimeType: string;
}

interface MultipartField {
	name: string;
	value: string | Buffer;
	filename?: string;
	contentType?: string;
}

interface ImageGenToolDetails extends ImageResult {
	action: ToolAction;
	configured?: boolean;
	configPath?: string;
	model?: string;
	size?: string;
	quality?: string;
	background?: string;
	outputFormat?: string;
	outputDir?: string;
	maxConcurrency?: number;
}

const IMAGE_GEN_TOOL_PARAMS = Type.Object({
	action: StringEnum(["help", "generate", "edit", "status"] as const, {
		description: "help=查看完整能力；generate=文生图；edit=图生图；status=配置状态。",
		default: "help",
	}),
	prompt: Type.Optional(Type.String({ description: "生图/编辑提示词。generate/edit 必填。" })),
	image: Type.Optional(Type.String({ description: "edit 输入图：本地路径、URL、data URL 或 base64。" })),
	mask: Type.Optional(Type.String({ description: "edit 局部重绘遮罩（透明区域被重绘）：本地路径、URL、data URL 或 base64。" })),
	output_name: Type.Optional(Type.String({ description: "输出文件名；留空自动生成。" })),
	size: Type.Optional(Type.String({ description: "可选尺寸覆盖，如 1024x1024。" })),
	quality: Type.Optional(StringEnum(IMAGE_QUALITY_VALUES, { description: "可选质量覆盖：auto/low/medium/high/xhigh/max。" })),
	background: Type.Optional(StringEnum(IMAGE_BACKGROUND_VALUES, { description: "可选背景覆盖：auto/opaque/transparent（transparent 需 png 或 webp）。" })),
	output_format: Type.Optional(StringEnum(IMAGE_OUTPUT_FORMAT_VALUES, { description: "可选输出格式覆盖：png/jpeg/webp。" })),
	n: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_IMAGES_PER_REQUEST, description: "生成张数 1-10，默认 1。" })),
	model: Type.Optional(Type.String({ description: "可选模型覆盖，默认 gpt-image-2.5-flare。" })),
});

type ImageGenToolParams = Static<typeof IMAGE_GEN_TOOL_PARAMS>;

const IMAGE_GEN_PROMPT_SNIPPET = "Generate or edit an image from a text prompt and optional source image.";

export default function imageGenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "image_gen",
		label: "Image Gen",
		description: "Generate images from text or edit a supplied image with GPT Image models. It supports general artwork, product and concept images, background or style changes, and visual assets or references for interface work. Use action=help for full input and output details; if unconfigured, direct the user to /image-gen config and do not request credentials through tool parameters.",
		promptSnippet: IMAGE_GEN_PROMPT_SNIPPET,
		parameters: IMAGE_GEN_TOOL_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeImageGenTool(params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "help";
			return new Text(theme.fg("toolTitle", theme.bold("image_gen")) + " " + theme.fg("muted", action), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncConfig(pi, ctx);
	});

	pi.registerCommand("image-gen", {
		description: "图像 API 图片生成 / 图生图 / 配置",
		handler: async (args, ctx) => {
			await handleImageGenCommand(pi, args, ctx);
		},
	});
}

async function handleImageGenCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);

	if (parsed.action === "generate") {
		await generateFlow(ctx, parsed.rest);
		return;
	}

	if (parsed.action === "edit") {
		await editFlow(ctx, parsed.rest);
		return;
	}

	if (parsed.action === "config") {
		await configFlow(pi, ctx);
		return;
	}

	if (parsed.action === "status") {
		await showStatus(ctx);
		return;
	}

	if (parsed.action === "help") {
		showHelp(ctx);
		return;
	}

	if (args.trim()) {
		await generateFlow(ctx, args.trim());
		return;
	}

	if (!ctx.hasUI) {
		showHelp(ctx);
		return;
	}

	const choice = await ctx.ui.select("Image Gen", [
		"文生图",
		"图生图 / 编辑",
		"配置图像 API",
		"查看状态",
	]);

	if (choice === "文生图") await generateFlow(ctx, "");
	if (choice === "图生图 / 编辑") await editFlow(ctx, "");
	if (choice === "配置图像 API") await configFlow(pi, ctx);
	if (choice === "查看状态") await showStatus(ctx);
}

function syncConfig(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "ui">): void {
	const config = { reviewToolEnabled: true }; // dummy
	applyConfigActive(pi, ctx, true);
}

function applyConfigActive(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "ui">, enabled: boolean): void {
	// no review
	ctx.ui.setStatus("image-gen", undefined);
}

function parseArgs(args: string): { action?: "generate" | "edit" | "config" | "status" | "help"; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };

	const [head = "", ...tail] = trimmed.split(/\s+/);
	const rest = tail.join(" ").trim();
	const normalized = head.toLowerCase();

	if (["generate", "gen", "text", "txt2img", "文生图"].includes(normalized)) return { action: "generate", rest };
	if (["edit", "image", "img2img", "图生图", "编辑"].includes(normalized)) return { action: "edit", rest };
	if (["config", "cfg", "setup", "配置"].includes(normalized)) return { action: "config", rest };
	if (["status", "show", "状态"].includes(normalized)) return { action: "status", rest };
	if (["help", "-h", "--help", "帮助"].includes(normalized)) return { action: "help", rest };

	return { rest: trimmed };
}

async function executeImageGenTool(
	params: ImageGenToolParams,
	signal: AbortSignal | undefined,
	onUpdate: ((partialResult: AgentToolResult<ImageGenToolDetails>) => void) | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ImageGenToolDetails>> {
	const action = params.action || "help";

	if (action === "help") {
		return toolTextResult("help", buildToolHelp(), { configPath: CONFIG_FILE });
	}

	if (action === "status") {
		return toolTextResult("status", await buildToolStatus(), await buildToolStatusDetails());
	}

	const prompt = params.prompt?.trim();
	if (!prompt) {
		return toolTextResult(action, "缺少 prompt。先调用 action=help 查看参数，或补充明确的生图提示词。", { configPath: CONFIG_FILE });
	}

	if (action === "edit" && !params.image?.trim()) {
		return toolTextResult("edit", "缺少 image。edit 需要本地路径、URL、data URL 或 base64 输入图。", { configPath: CONFIG_FILE });
	}

	onUpdate?.({
		content: [{ type: "text", text: `image_gen ${action}: requesting image model...` }],
		details: { action },
	});

	const result = await requestImage(ctx, {
		action,
		prompt,
		image: params.image?.trim(),
		mask: params.mask?.trim() || undefined,
		outputName: params.output_name?.trim() || undefined,
		size: params.size?.trim() || undefined,
		quality: params.quality,
		background: params.background,
		outputFormat: params.output_format,
		n: params.n,
		model: params.model?.trim() || undefined,
	}, signal);

	const details: ImageGenToolDetails = {
		action,
		file: result.file,
		files: result.files,
		url: result.url,
		responseFile: result.responseFile,
		mimeType: result.mimeType,
		ignoredParams: result.ignoredParams,
		model: params.model?.trim() || undefined,
		size: params.size?.trim() || undefined,
		quality: params.quality,
		background: params.background,
		outputFormat: params.output_format,
	};
	const content: AgentToolResult<ImageGenToolDetails>["content"] = [{ type: "text", text: formatSuccess(result) }];
	for (const image of result.images ?? []) {
		content.push({ type: "image", data: image.b64, mimeType: image.mimeType });
	}
	if (content.length === 1 && result.b64 && result.mimeType) {
		content.push({ type: "image", data: result.b64, mimeType: result.mimeType });
	}
	return { content, details };
}

function toolTextResult(
	action: ToolAction,
	text: string,
	details: Partial<ImageGenToolDetails> = {},
): AgentToolResult<ImageGenToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { action, ...details },
	};
}

function buildToolHelp(): string {
	return [
		"image_gen 使用说明：",
		"1. 文生图：action=generate，prompt=图片描述。",
		"2. 图生图/编辑：action=edit，image=输入图，prompt=修改要求。",
		"3. 局部重绘：action=edit，image=输入图，mask=遮罩图，prompt=重绘内容（mask 透明处会被重绘）。",
		"4. 可生成页面参考图、图标、插画、商品图、空状态图、背景图等视觉素材。",
		"5. 也支持概念图、产品图、换背景、风格变体等通用场景。",
		"6. prompt 建议写清：主体、风格、比例/尺寸、色彩、用途、是否透明背景。",
		"7. 可选参数：output_name、size、quality、background、output_format、n、model。",
		"8. 未配置时请让用户运行 /image-gen config，不要在工具参数里索要密钥。",
		"支持 image/mask：本地路径、HTTP URL、data:image/...、裸 base64。",
		"模型固定返回 base64（gpt-image-2.5 起不再支持 response_format:url），图片会保存到输出目录；返回多张时会全部保存。",
		"size 支持标准尺寸或任意 WIDTHxHEIGHT（需为 16 的倍数，比例 1:3~3:1，最大 3840x2160）。",
	].join("\n");
}

async function buildToolStatus(): Promise<string> {
	const details = await buildToolStatusDetails();
	return [
		"image_gen 状态：",
		`configured: ${details.configured ? "yes" : "no"}`,
		`config: ${details.configPath}`,
		`model: ${details.model}`,
		`size: ${details.size}`,
		`quality: ${details.quality}`,
		`background: ${details.background}`,
		`output format: ${details.outputFormat}`,
		`output: ${details.outputDir}`,
		`max concurrency: ${details.maxConcurrency}`,
		details.configured ? "可直接 generate/edit。" : "未配置，请运行 /image-gen config。",
	].join("\n");
}

async function buildToolStatusDetails(): Promise<ImageGenToolDetails> {
	const config = await resolveConfig();
	return {
		action: "status",
		configured: Boolean(config.baseUrl && config.baseUrl !== DEFAULT_BASE_URL && config.apiKey && config.model),
		configPath: CONFIG_FILE,
		model: config.model,
		size: config.size,
		quality: config.quality,
		background: config.background,
		outputFormat: config.outputFormat,
		outputDir: config.outputDir,
		maxConcurrency: config.maxConcurrency,
	};
}

async function generateFlow(ctx: ExtensionCommandContext, initialPrompt: string): Promise<void> {
	const prompt = await resolvePrompt(ctx, "文生图 Prompt", initialPrompt);
	if (!prompt) return;

	const outputName = ctx.hasUI
		? await ctx.ui.input("输出文件名", "留空自动生成；例如 cat.png")
		: undefined;

	await runWithStatus(ctx, "image-gen: generating", async () => {
		const result = await requestImage(ctx, {
			action: "generate",
			prompt,
			outputName: outputName?.trim() || undefined,
		});
		await showResult(ctx, result);
	});
}

async function editFlow(ctx: ExtensionCommandContext, initialPrompt: string): Promise<void> {
	let image = "";
	let mask = "";
	let prompt = initialPrompt;

	if (initialPrompt) {
		const parsed = parseEditInlineArgs(initialPrompt);
		image = parsed.image;
		mask = parsed.mask || "";
		prompt = parsed.prompt;
	}

	if (!image) {
		const value = await ctx.ui.input("输入图片", "本地路径、http(s) URL、data:image/... 或裸 base64");
		if (!value?.trim()) return;
		image = value.trim();
	}

	const resolvedPrompt = await resolvePrompt(ctx, "图生图 / 编辑 Prompt", prompt);
	if (!resolvedPrompt) return;

	const outputName = ctx.hasUI
		? await ctx.ui.input("输出文件名", "留空自动生成；例如 edited.png")
		: undefined;

	await runWithStatus(ctx, "image-gen: editing", async () => {
		const result = await requestImage(ctx, {
			action: "edit",
			prompt: resolvedPrompt,
			image,
			mask: mask.trim() || undefined,
			outputName: outputName?.trim() || undefined,
		});
		await showResult(ctx, result);
	});
}

function parseEditInlineArgs(value: string): { image: string; mask?: string; prompt: string } {
	const trimmed = value.trim();
	const match = trimmed.match(/^(?:--image|-i)\s+(\S+)\s+(?:--mask\s+(\S+)\s+)?([\s\S]+)$/);
	if (match) return { image: match[1], mask: match[2], prompt: match[3].trim() };

	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (looksLikeImageInput(first) && rest.length > 0) {
		return { image: first, prompt: rest.join(" ").trim() };
	}

	return { image: "", prompt: trimmed };
}

async function resolvePrompt(ctx: ExtensionCommandContext, title: string, initial: string): Promise<string | undefined> {
	if (initial.trim()) return initial.trim();
	if (!ctx.hasUI) {
		ctx.ui.notify(`缺少 prompt。用法: /image-gen generate <prompt>`, "error");
		return undefined;
	}
	const prompt = await ctx.ui.editor(title, "");
	return prompt?.trim() || undefined;
}

async function configFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const config = await loadConfig();
		await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
		const choice = await ctx.ui.select("图像 API 配置", [
			"查看当前配置",
			"设置 API Base URL",
			"设置 API Key",
			"设置模型",
			"设置尺寸",
			"设置质量",
			"设置背景",
			"设置输出格式",
			"设置输出目录",
			`设置最大并行数 (${normalizeMaxConcurrency(config.maxConcurrency)})`,
			"测试连接",
		]);

		if (!choice) return;

		if (choice === "查看当前配置") {
			await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
			ctx.ui.notify(formatConfig(config), "info");
			continue;
		}

		if (choice === "设置 API Base URL") {
			const value = await ctx.ui.input("API Base URL", config.baseUrl || DEFAULT_BASE_URL);
			if (value?.trim()) await saveConfig({ ...config, baseUrl: trimTrailingSlash(value.trim()) });
			continue;
		}

		if (choice === "设置 API Key") {
			const value = await ctx.ui.input("API Key", "留空取消；输入 - 清除已保存 key");
			if (value === undefined || value === "") continue;
			const next = { ...config };
			if (value.trim() === "-") delete next.apiKey;
			else next.apiKey = value.trim();
			await saveConfig(next);
			continue;
		}

		if (choice === "设置模型") {
			await chooseModelFlow(ctx, config);
			continue;
		}

		if (choice === "设置尺寸") {
			const selected = await ctx.ui.select("图片尺寸", [...IMAGE_SIZE_VALUES, "自定义"]);
			if (!selected) continue;
			if (selected === "自定义") {
				const custom = await ctx.ui.input("自定义尺寸", config.size || DEFAULT_SIZE);
				if (custom?.trim()) await saveConfig({ ...config, size: custom.trim() });
			} else {
				await saveConfig({ ...config, size: selected });
			}
			continue;
		}

		if (choice === "设置质量") {
			const selected = await ctx.ui.select("图片质量", [...IMAGE_QUALITY_VALUES]);
			if (selected) await saveConfig({ ...config, quality: selected });
			continue;
		}

		if (choice === "设置背景") {
			const selected = await ctx.ui.select("背景", [...IMAGE_BACKGROUND_VALUES, "自定义"]);
			if (!selected) continue;
			if (selected === "自定义") {
				const custom = await ctx.ui.input("自定义背景", config.background || DEFAULT_BACKGROUND);
				if (custom?.trim()) await saveConfig({ ...config, background: custom.trim() });
			} else {
				await saveConfig({ ...config, background: selected });
			}
			continue;
		}

		if (choice === "设置输出格式") {
			const selected = await ctx.ui.select("输出格式", [...IMAGE_OUTPUT_FORMAT_VALUES, "自定义"]);
			if (!selected) continue;
			if (selected === "自定义") {
				const custom = await ctx.ui.input("自定义输出格式", config.outputFormat || DEFAULT_OUTPUT_FORMAT);
				if (custom?.trim()) await saveConfig({ ...config, outputFormat: normalizeOutputFormat(custom.trim()) });
			} else {
				await saveConfig({ ...config, outputFormat: normalizeOutputFormat(selected) });
			}
			continue;
		}

		if (choice === "设置输出目录") {
			const value = await ctx.ui.input("输出目录", config.outputDir || DEFAULT_OUTPUT_DIR);
			if (value?.trim()) {
				await saveConfig({ ...config, outputDir: value.trim() });
				await ensureOutputDir(ctx.cwd, value.trim());
			}
			continue;
		}

		if (choice.startsWith("设置最大并行数")) {
			const value = await ctx.ui.input("最大并行数", `1-${MAX_CONFIGURABLE_CONCURRENCY}，当前 ${normalizeMaxConcurrency(config.maxConcurrency)}`);
			if (value?.trim()) await saveConfig({ ...config, maxConcurrency: normalizeMaxConcurrency(value.trim()) });
			continue;
		}

		if (choice === "测试连接") {
			await testConnection(ctx);
		}
	}
}

async function chooseModelFlow(ctx: ExtensionCommandContext, config: ImageGenConfig): Promise<void> {
	const resolved = await resolveConfig();
	let models: string[] = [];

	if (resolved.baseUrl && resolved.baseUrl !== DEFAULT_BASE_URL && resolved.apiKey) {
		ctx.ui.setStatus(EXTENSION_NAME, "image-gen: loading models");
		try {
			models = await fetchModels(resolved);
		} catch (error) {
			ctx.ui.notify(`获取模型列表失败，改为手动输入：${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			ctx.ui.setStatus(EXTENSION_NAME, undefined);
		}
	} else {
		ctx.ui.notify("先配置 API Base URL 和 API Key，才能自动获取模型列表。", "warning");
	}

	const current = resolved.model || DEFAULT_MODEL;
	if (models.length > 0) {
		const options = [...new Set([current, ...models]), "手动输入"];
		const selected = await ctx.ui.select("选择模型", options);
		if (!selected) return;
		if (selected !== "手动输入") {
			await saveConfig({ ...config, model: selected });
			return;
		}
	}

	const value = await ctx.ui.input("模型 ID", current);
	if (value?.trim()) await saveConfig({ ...config, model: value.trim() });
}

async function fetchModels(config: ResolvedConfig): Promise<string[]> {
	const response = await fetch(apiUrl(config.baseUrl, "/v1/models"), {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);

	let json: ModelListResponse;
	try {
		json = JSON.parse(text) as ModelListResponse;
	} catch {
		throw new Error(`返回非 JSON：${text.slice(0, 120)}`);
	}
	if (json.error?.message) throw new Error(json.error.message);

	const models = (json.data || [])
		.map((item) => item.id)
		.filter((id): id is string => Boolean(id?.trim()))
		.sort((a, b) => a.localeCompare(b));
	if (models.length === 0) throw new Error("/v1/models 未返回可用模型 ID");
	return models;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	await ensureOutputDir(ctx.cwd, (await resolveConfig()).outputDir);
	ctx.ui.notify(formatConfig(await loadConfig()), "info");
}

function showHelp(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		[
			"/image-gen 用法：",
			"  /image-gen                         打开 TUI 菜单",
			"  /image-gen generate <prompt>       文生图",
			"  /image-gen edit <image> <prompt>   图生图 / 编辑",
			"  /image-gen edit --image a.png --mask m.png <prompt>   局部重绘",
			"  /image-gen config                  配置图像 API",
			"  /image-gen status                  查看状态",
			"",
			"命令只有一层子动作；TUI 菜单最多进入一层表单。",
		].join("\n"),
		"info",
	);
}

class ImageRequestLimiter {
	private active = 0;
	private queue: Array<{ limit: number; start: () => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];

	async run<T>(limit: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
		await this.acquire(limit, signal);
		try {
			return await work();
		} finally {
			this.active = Math.max(0, this.active - 1);
			this.drain();
		}
	}

	private acquire(limit: number, signal: AbortSignal | undefined): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError());
		if (this.active < limit && this.queue.length === 0) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				limit,
				start: () => {
					signal?.removeEventListener("abort", onAbort);
					this.active += 1;
					resolve();
				},
				reject,
				signal,
			};
			const onAbort = () => {
				const index = this.queue.indexOf(waiter);
				if (index >= 0) this.queue.splice(index, 1);
				reject(abortError());
				this.drain();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(waiter);
			this.drain();
		});
	}

	private drain(): void {
		while (this.queue.length > 0) {
			const waiter = this.queue[0];
			if (!waiter || this.active >= waiter.limit) return;
			this.queue.shift();
			if (waiter.signal?.aborted) {
				waiter.reject(abortError());
				continue;
			}
			waiter.start();
		}
	}
}

const imageRequestLimiter = new ImageRequestLimiter();

function abortError(): Error {
	return new Error("image_gen 已取消");
}

async function requestImage(ctx: { cwd: string }, options: ImageRequestOptions, signal?: AbortSignal): Promise<ImageResult> {
	const config = await resolveConfig();
	validateConfig(config);
	let image: EditImageInput | undefined;
	let mask: EditImageInput | undefined;
	if (options.action === "edit") {
		if (!options.image) throw new Error("图生图需要 image 输入");
		image = await normalizeEditImageInput(options.image, ctx.cwd);
		if (options.mask) {
			mask = await normalizeEditImageInput(options.mask, ctx.cwd);
			if (mask.buffer.length === 0) throw new Error("遮罩图不能为空");
		}
	}
	return imageRequestLimiter.run(config.maxConcurrency, signal, () => requestImageUnlocked(ctx, options, config, image, mask, signal));
}

interface RequestAttempt {
	omitBackground?: boolean;
	omitQuality?: boolean;
	omitOutputFormat?: boolean;
	omitCount?: boolean;
}

function buildRequestPayload(options: ImageRequestOptions, config: ResolvedConfig, attempt: RequestAttempt): Record<string, string> {
	const payload: Record<string, string> = {
		model: options.model || config.model,
		prompt: options.prompt,
	};
	const size = options.size || config.size;
	if (size) payload.size = size;
	const quality = options.quality || config.quality;
	if (quality && !attempt.omitQuality) payload.quality = quality;
	const background = options.background || config.background;
	if (background && !attempt.omitBackground) payload.background = background;
	const outputFormat = normalizeOutputFormat(options.outputFormat || config.outputFormat);
	if (!attempt.omitOutputFormat) payload.output_format = outputFormat;
	const n = normalizeImageCount(options.n);
	if (n > 1 && !attempt.omitCount) payload.n = String(n);
	return payload;
}

type FallbackParam = "quality" | "background" | "output_format" | "n";

function fallbackParam(failure: { message: string; param?: string }, payload: Record<string, string>): FallbackParam | undefined {
	const candidates: FallbackParam[] = ["quality", "background", "output_format", "n"];
	const hint = `${failure.param || ""} ${failure.message}`.toLowerCase();
	for (const candidate of candidates) {
		if (!payload[candidate]) continue;
		if (hint.includes(candidate)) return candidate;
	}
	return undefined;
}

function markOmitted(attempt: RequestAttempt, param: FallbackParam): void {
	if (param === "quality") attempt.omitQuality = true;
	else if (param === "background") attempt.omitBackground = true;
	else if (param === "output_format") attempt.omitOutputFormat = true;
	else attempt.omitCount = true;
}

async function requestImageUnlocked(
	ctx: { cwd: string },
	options: ImageRequestOptions,
	config: ResolvedConfig,
	image: EditImageInput | undefined,
	mask: EditImageInput | undefined,
	signal?: AbortSignal,
): Promise<ImageResult> {
	const attempt: RequestAttempt = {};
	const ignoredParams: string[] = [];

	for (let round = 0; round <= MAX_REQUEST_PARAM_FALLBACKS; round += 1) {
		const payload = buildRequestPayload(options, config, attempt);
		const { response, text } = await sendImageRequest(config, options.action, payload, image, mask, signal);
		const failure = await describeImageFailure(response, text);

		if (failure && round < MAX_REQUEST_PARAM_FALLBACKS) {
			const param = fallbackParam(failure, payload);
			if (param) {
				markOmitted(attempt, param);
				ignoredParams.push(`${param}=${payload[param]}`);
				continue;
			}
		}

		if (failure) throw new Error(failure.message);

		let json: ImageApiResponse;
		try {
			json = JSON.parse(text) as ImageApiResponse;
		} catch {
			throw new Error(`图像 API 返回非 JSON：${text.slice(0, 300)}`);
		}

		const result = await saveImagesResponse(ctx.cwd, options, config, json);
		return ignoredParams.length > 0 ? { ...result, ignoredParams } : result;
	}

	throw new Error("图像 API 请求失败：参数回退次数超限");
}

async function sendImageRequest(
	config: ResolvedConfig,
	action: Action,
	payload: Record<string, string>,
	image: EditImageInput | undefined,
	mask: EditImageInput | undefined,
	signal?: AbortSignal,
): Promise<{ response: Response; text: string }> {
	if (action === "edit") {
		if (!image) throw new Error("图生图需要 image 输入");
		const fields: MultipartField[] = [
			{ name: "model", value: payload.model ?? "" },
			{ name: "prompt", value: payload.prompt ?? "" },
		];
		for (const [name, value] of Object.entries(payload)) {
			if (name === "model" || name === "prompt") continue;
			fields.push({ name, value });
		}
		fields.push({ name: "image[]", value: image.buffer, filename: image.filename, contentType: image.mimeType });
		if (mask) fields.push({ name: "mask", value: mask.buffer, filename: mask.filename, contentType: mask.mimeType });

		const multipart = encodeMultipartForm(fields);
		const response = await fetch(apiUrl(config.baseUrl, IMAGE2_EDIT_PATH), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": multipart.contentType,
			},
			body: new Uint8Array(multipart.body),
			signal,
		});
		return { response, text: await response.text() };
	}

	const response = await fetch(apiUrl(config.baseUrl, IMAGE2_GENERATE_PATH), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal,
	});
	return { response, text: await response.text() };
}

async function describeImageFailure(response: Response, text: string): Promise<{ message: string; param?: string } | undefined> {
	if (response.ok) {
		try {
			const parsed = JSON.parse(text) as ImageApiResponse;
			if (parsed.error?.message) return { message: parsed.error.message, param: parsed.error.param };
		} catch {
			// 非 JSON 响应交给调用方处理
		}
		return undefined;
	}

	let message = `图像 API HTTP ${response.status}: ${text.slice(0, 800)}`;
	let param: string | undefined;
	try {
		const parsed = JSON.parse(text) as ImageApiResponse & { message?: string };
		const error = parsed.error;
		if (error?.message) {
			message = error.message;
			param = error.param;
		} else if (typeof parsed.message === "string") {
			message = parsed.message;
		}
	} catch {
		// 保留原始文本错误
	}
	return { message, param };
}

async function saveImagesResponse(cwd: string, options: ImageRequestOptions, config: ResolvedConfig, json: ImageApiResponse): Promise<ImageResult> {
	const entries = (json.data || []).filter((item) => Boolean(item?.b64_json || item?.url));
	if (entries.length === 0) throw new Error("图像 API 未返回 data[0]");

	const outputDir = await ensureOutputDir(cwd, config.outputDir);
	const images: Array<{ file: string; b64: string; mimeType: string }> = [];
	const files: string[] = [];
	let responseFile: string | undefined;
	let remoteUrl: string | undefined;

	for (const [index, entry] of entries.entries()) {
		const outputName = imageOutputName(options.outputName, index, entries.length);

		if (entry.b64_json) {
			const mimeType = detectImageMime(Buffer.from(entry.b64_json.slice(0, 32), "base64")) ||
				outputFormatToMime(json.output_format || options.outputFormat || config.outputFormat);
			const file = resolveOutputFile(outputDir, outputName, extensionFromMime(mimeType));
			await writeFile(file, Buffer.from(entry.b64_json, "base64"));
			files.push(file);
			images.push({ file, b64: entry.b64_json, mimeType });
			continue;
		}

		if (entry.url?.startsWith("data:")) {
			const parsed = parseDataUrl(entry.url);
			const file = resolveOutputFile(outputDir, outputName, extensionFromMime(parsed.mimeType));
			await writeFile(file, Buffer.from(parsed.data, "base64"));
			files.push(file);
			images.push({ file, b64: parsed.data, mimeType: parsed.mimeType });
			continue;
		}

		if (entry.url) {
			remoteUrl ||= entry.url;
			responseFile ||= resolveOutputFile(outputDir, responseOutputName(options.outputName || "image-url"), "json");
			if (/^https?:\/\//i.test(entry.url)) {
				const downloaded = await downloadImageResult(entry.url);
				if (downloaded) {
					const file = resolveOutputFile(outputDir, outputName || basename(new URL(entry.url).pathname), extensionFromMime(downloaded.mimeType));
					await writeFile(file, downloaded.buffer);
					files.push(file);
					images.push({ file, b64: downloaded.buffer.toString("base64"), mimeType: downloaded.mimeType });
				}
			}
		}
	}

	const first = images[0] ?? images.at(-1);
	if (images.length === 0) {
		const fallbackFile = responseFile || resolveOutputFile(outputDir, options.outputName || "image-response", "json");
		await writeFile(fallbackFile, JSON.stringify(json, null, 2), "utf8");
		return { url: remoteUrl, responseFile: fallbackFile };
	}

	if (responseFile) await writeFile(responseFile, JSON.stringify(json, null, 2), "utf8");

	return {
		file: first?.file,
		files,
		images,
		url: remoteUrl,
		responseFile,
		b64: first?.b64,
		mimeType: first?.mimeType,
	};
}

async function testConnection(ctx: ExtensionCommandContext): Promise<void> {
	try {
		const config = await resolveConfig();
		validateConfig(config);
		const response = await fetch(apiUrl(config.baseUrl, "/v1/models"), {
			headers: { Authorization: `Bearer ${config.apiKey}` },
		});
		if (!response.ok) {
			ctx.ui.notify(`连接失败：HTTP ${response.status}`, "warning");
			return;
		}

		const text = await response.text();
		let models: string[] = [];
		try {
			const json = JSON.parse(text) as ModelListResponse;
			models = (json.data || []).map((item) => item.id).filter((id): id is string => Boolean(id?.trim()));
		} catch {
			// /v1/models 返回非 JSON 时只报告连通性
		}

		const lines = ["连接正常：/v1/models 可访问"];
		const model = config.model;
		if (models.length > 0) {
			if (!models.includes(model)) {
				lines.push(`⚠️ 当前模型 ${model} 不在可用列表：${models.join(", ")}`);
			} else {
				lines.push(`模型 ${model} 可用。`);
			}
		}
		lines.push("提示：gpt-image-2.5 系列不再支持 response_format，固定返回 base64。");
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runWithStatus(ctx: ExtensionCommandContext, status: string, work: () => Promise<void>): Promise<void> {
	ctx.ui.setStatus(EXTENSION_NAME, status);
	try {
		await work();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	} finally {
		ctx.ui.setStatus(EXTENSION_NAME, undefined);
	}
}

async function loadConfig(): Promise<ImageGenConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as ImageGenConfig;
	} catch {
		return {};
	}
}

async function saveConfig(config: ImageGenConfig): Promise<void> {
	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

async function resolveConfig(): Promise<ResolvedConfig> {
	const config = await loadConfig();
	const baseUrl = process.env.IMAGE2_BASE_URL || process.env.BASE_URL || config.baseUrl || "";
	const apiKey = process.env.IMAGE2_API_KEY || process.env.API_KEY || config.apiKey || "";
	return {
		baseUrl: trimTrailingSlash(baseUrl),
		apiKey,
		model: process.env.IMAGE2_MODEL || process.env.IMAGE_MODEL || config.model || DEFAULT_MODEL,
		size: process.env.IMAGE2_SIZE || process.env.IMAGE_SIZE || config.size || DEFAULT_SIZE,
		quality: process.env.IMAGE2_QUALITY || process.env.IMAGE_QUALITY || config.quality || DEFAULT_QUALITY,
		background: process.env.IMAGE2_BACKGROUND || process.env.IMAGE_BACKGROUND || config.background || DEFAULT_BACKGROUND,
		outputFormat: normalizeOutputFormat(process.env.IMAGE2_OUTPUT_FORMAT || process.env.IMAGE_OUTPUT_FORMAT || config.outputFormat),
		outputDir: process.env.IMAGE2_OUTPUT_DIR || process.env.IMAGE_OUTPUT_DIR || config.outputDir || DEFAULT_OUTPUT_DIR,
		maxConcurrency: normalizeMaxConcurrency(process.env.IMAGE2_MAX_CONCURRENCY || process.env.IMAGE_MAX_CONCURRENCY || config.maxConcurrency),
	};
}

function normalizeMaxConcurrency(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENCY;
	return Math.max(1, Math.min(MAX_CONFIGURABLE_CONCURRENCY, Math.floor(parsed)));
}

function validateConfig(config: ResolvedConfig): void {
	if (!config.baseUrl || config.baseUrl === DEFAULT_BASE_URL) throw new Error("图像 API Base URL 未配置，请运行 /image-gen config");
	if (!config.apiKey) throw new Error("图像 API Key 未配置，请运行 /image-gen config");
	if (!config.model) throw new Error("图像 API 模型未配置，请运行 /image-gen config");
}

function normalizeOutputFormat(value: unknown): ImageOutputFormat {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "jpg") return "jpeg";
	if (normalized === "jpeg" || normalized === "webp") return normalized;
	return DEFAULT_OUTPUT_FORMAT;
}

function normalizeImageCount(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return 1;
	return Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, Math.floor(parsed)));
}

function outputFormatToMime(value: unknown): string {
	const format = normalizeOutputFormat(value);
	if (format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function imageOutputName(requested: string | undefined, index: number, total: number): string | undefined {
	if (!requested) return undefined;
	if (total <= 1) return requested;
	return indexedOutputName(requested, index);
}

function indexedOutputName(name: string, index: number): string {
	const extension = extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;
	return `${stem}-${index + 1}${extension}`;
}
function formatConfig(config: ImageGenConfig): string {
	const envBaseUrl = process.env.IMAGE2_BASE_URL || process.env.BASE_URL;
	const envApiKey = process.env.IMAGE2_API_KEY || process.env.API_KEY;
	const envMaxConcurrency = process.env.IMAGE2_MAX_CONCURRENCY || process.env.IMAGE_MAX_CONCURRENCY;
	return [
		"图像 API 配置",
		`配置文件: ${CONFIG_FILE}`,
		`Base URL: ${envBaseUrl || config.baseUrl || "未配置"}${envBaseUrl ? " (env)" : ""}`,
		`API Key: ${envApiKey ? maskSecret(envApiKey) + " (env)" : maskSecret(config.apiKey)}`,
		`Model: ${process.env.IMAGE2_MODEL || process.env.IMAGE_MODEL || config.model || DEFAULT_MODEL}`,
		`Size: ${process.env.IMAGE2_SIZE || process.env.IMAGE_SIZE || config.size || DEFAULT_SIZE}`,
		`Quality: ${process.env.IMAGE2_QUALITY || process.env.IMAGE_QUALITY || config.quality || DEFAULT_QUALITY}`,
		`Background: ${process.env.IMAGE2_BACKGROUND || process.env.IMAGE_BACKGROUND || config.background || DEFAULT_BACKGROUND}`,
		`Output format: ${normalizeOutputFormat(process.env.IMAGE2_OUTPUT_FORMAT || process.env.IMAGE_OUTPUT_FORMAT || config.outputFormat)}`,
		`Output: ${process.env.IMAGE2_OUTPUT_DIR || process.env.IMAGE_OUTPUT_DIR || config.outputDir || DEFAULT_OUTPUT_DIR}`,
		`Max concurrency: ${normalizeMaxConcurrency(envMaxConcurrency || config.maxConcurrency)}${envMaxConcurrency ? " (env)" : ""}`,
	].join("\n");
}

function maskSecret(value: string | undefined): string {
	if (!value) return "未配置";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function encodeMultipartForm(fields: MultipartField[]): { body: Buffer; contentType: string } {
	const boundary = `----pi-image-gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const chunks: Buffer[] = [];
	for (const field of fields) {
		chunks.push(Buffer.from(`--${boundary}\r\n`));
		if (Buffer.isBuffer(field.value)) {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(field.name)}"; filename="${escapeMultipartName(field.filename || "image.png")}"\r\n`));
			chunks.push(Buffer.from(`Content-Type: ${field.contentType || "application/octet-stream"}\r\n\r\n`));
			chunks.push(field.value, Buffer.from("\r\n"));
		} else {
			chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartName(field.name)}"\r\n\r\n${field.value}\r\n`));
		}
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeMultipartName(value: string): string {
	return value.replace(/["\r\n]/g, "_");
}

async function downloadImageResult(url: string): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
	try {
		const downloaded = await fetchImage(url);
		const mimeType = detectImageMime(downloaded.buffer) || downloaded.mimeType;
		return mimeType ? { buffer: downloaded.buffer, mimeType } : undefined;
	} catch {
		return undefined;
	}
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; mimeType: string | undefined }> {
	const parsed = validatePublicHttpUrl(url);
	const response = await fetch(parsed, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS), redirect: "follow" });
	if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);

	const finalUrl = new URL(response.url || parsed.href);
	validatePublicHttpUrl(finalUrl.href);

	const length = Number(response.headers.get("content-length") || "0");
	if (length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error(`图片过大：最大支持 ${MAX_IMAGE_DOWNLOAD_BYTES} bytes`);

	const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error(`图片过大：最大支持 ${MAX_IMAGE_DOWNLOAD_BYTES} bytes`);

	const mimeType = detectImageMime(buffer) || (isSupportedImageMime(contentType) ? contentType : undefined);
	if (!mimeType) throw new Error("下载内容不是支持的图片类型");
	return { buffer, mimeType };
}

function validatePublicHttpUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 http/https 图片 URL");
	if (isPrivateHostname(url.hostname)) throw new Error("不允许下载 localhost 或内网地址图片");
	return url;
}

function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const ipVersion = isIP(host);
	if (ipVersion === 4) {
		const parts = host.split(".").map(Number);
		return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			(parts[0] === 169 && parts[1] === 254);
	}
	if (ipVersion === 6) {
		return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
	}
	return false;
}

function responseOutputName(name: string): string {
	const extension = extname(name);
	const stem = extension ? name.slice(0, -extension.length) : name;
	return `${stem}-response.json`;
}

async function normalizeEditImageInput(input: string, cwd: string): Promise<EditImageInput> {
	const trimmed = input.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		const downloaded = await fetchImage(trimmed);
		return buildEditImageInput(downloaded.buffer, downloaded.mimeType, basename(new URL(trimmed).pathname), trimmed);
	}
	if (trimmed.startsWith("data:image/")) {
		const parsed = parseDataUrl(trimmed);
		const buffer = Buffer.from(parsed.data, "base64");
		return buildEditImageInput(buffer, parsed.mimeType, "input", "data URL");
	}
	if (looksLikeBase64(trimmed)) {
		const buffer = Buffer.from(trimmed, "base64");
		return buildEditImageInput(buffer, undefined, "input", "base64 image");
	}

	const file = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	const data = await readFile(file);
	return buildEditImageInput(data, mimeFromPath(file), basename(file), file);
}

function buildEditImageInput(buffer: Buffer, hintedMimeType: string | undefined, filename: string, label: string): EditImageInput {
	const detectedMimeType = detectImageMime(buffer);
	const mimeType = detectedMimeType || (isSupportedImageMime(hintedMimeType) ? hintedMimeType : undefined);
	if (!mimeType) {
		const head = buffer.subarray(0, 16).toString("hex") || "empty";
		throw new Error(`输入图不是有效图片：${label}。仅支持 jpeg/png/gif/webp；文件头=${head}`);
	}
	const safeName = filename && extname(filename) ? filename : `input.${extensionFromMime(mimeType)}`;
	return {
		buffer,
		filename: safeName,
		mimeType,
	};
}

function detectImageMime(buffer: Buffer): string | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6) {
		const gifHeader = buffer.subarray(0, 6).toString("ascii");
		if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
	}
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

function isSupportedImageMime(value: string | undefined): value is string {
	return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

function looksLikeImageInput(value: string): boolean {
	if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) return true;
	return /\.(png|jpe?g|webp|gif)$/i.test(value) || existsSync(value);
}

function looksLikeBase64(value: string): boolean {
	return value.length > 80 && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function mimeFromPath(file: string): string {
	const extension = extname(file).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".webp") return "image/webp";
	if (extension === ".gif") return "image/gif";
	return "image/png";
}

function parseDataUrl(value: string): { mimeType: string; data: string } {
	const match = value.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) throw new Error("无效 data URL 图片响应");
	return { mimeType: match[1], data: match[2] };
}

function extensionFromMime(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
}

async function ensureOutputDir(cwd: string, outputDir: string): Promise<string> {
	const dir = resolveOutputDir(cwd, outputDir);
	await mkdir(dir, { recursive: true });
	return dir;
}

function resolveOutputDir(cwd: string, outputDir: string): string {
	return isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);
}

function resolveOutputFile(outputDir: string, requestedName: string | undefined, fallbackExtension: string): string {
	const safeName = requestedName?.trim();
	if (safeName) {
		const resolved = isAbsolute(safeName) ? safeName : resolve(outputDir, safeName);
		return extname(resolved) ? resolved : `${resolved}.${fallbackExtension}`;
	}
	return join(outputDir, `image-${timestamp()}-${nextOutputSequence()}.${fallbackExtension}`);
}

let outputSequence = 0;

function nextOutputSequence(): string {
	outputSequence = (outputSequence + 1) % 100000;
	return outputSequence.toString().padStart(5, "0");
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function apiUrl(baseUrl: string, path: string): string {
	const base = trimTrailingSlash(baseUrl);
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) return `${base}${normalizedPath.slice(3)}`;
	return `${base}${normalizedPath}`;
}

async function showResult(ctx: ExtensionCommandContext, result: ImageResult): Promise<void> {
	ctx.ui.notify(formatSuccess(result), "info");
	const files = result.files && result.files.length > 0 ? result.files : result.file ? [result.file] : [];
	for (const file of files) {
		// non-blocking push to system viewer
		openImageWithDefaultViewer(file).catch(() => {});
	}
}

function formatSuccess(result: { file?: string; files?: string[]; url?: string; responseFile?: string; ignoredParams?: string[] }): string {
	const lines: string[] = [];
	if (result.files && result.files.length > 1) {
		lines.push(`✅ 已保存 ${result.files.length} 张图片：`);
		for (const file of result.files) lines.push(`  ${file}`);
	} else if (result.file) {
		lines.push(`✅ 图片已保存：${result.file}`);
	} else if (result.url) {
		lines.push(`✅ 图片 URL：${result.url}`);
		lines.push(`响应已保存：${result.responseFile}`);
	} else {
		lines.push(`✅ 响应已保存：${result.responseFile}`);
	}
	if (result.ignoredParams?.length) {
		lines.push(`⚠️ 接口不支持，已忽略参数：${result.ignoredParams.join(", ")}`);
	}
	return lines.join("\n");
}

async function openImageWithDefaultViewer(file: string): Promise<void> {
	const command = defaultOpenCommand(file);
	if (!command) return;
	try {
		const child = spawn(command.command, command.args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// non-blocking, ignore
	}
}

function defaultOpenCommand(file: string): { command: string; args: string[] } | undefined {
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", file] };
	if (process.platform === "darwin") return { command: "open", args: [file] };
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return { command: "wslview", args: [file] };
	if (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
		return { command: "xdg-open", args: [file] };
	}
	return undefined;
}
