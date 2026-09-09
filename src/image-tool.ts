import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sanitizeErrorMessage } from "./account.ts";
import { imageArtifactPath, saveImageArtifact } from "./image-artifact.ts";
import { localImageDataUrls, recentImageDataUrls } from "./image-input.ts";
import {
	DEFAULT_IMAGE_MODEL,
	IMAGE_MODELS,
	IMAGE_RESOURCE_ID,
	ImageRequestError,
	type GeneratedImage,
	type ImageModel,
	type ImagesClient,
} from "./images-client.ts";
import type { AccountOperationFailure, RingRouter } from "./router.ts";

const ImageToolParameters = Type.Object(
	{
		prompt: Type.String({
			description: "A detailed description of the image to generate or the edits to make.",
		}),
		model: Type.Optional(StringEnum(IMAGE_MODELS, {
			description: "Image model. Omit for gpt-image-2.5-flare-2026-09-08, the fast default for most work. Use gpt-image-2.5-sunburst-2026-09-08 for maximum generation and editing precision. Select gpt-image-2-2026-04-21 when explicitly requested.",
			default: DEFAULT_IMAGE_MODEL,
		})),
		referenced_image_paths: Type.Optional(Type.Array(Type.String(), {
			description: "Absolute paths to up to five local images to edit. Omit when generating a new image or using recent conversation images.",
			maxItems: 5,
		})),
		num_last_images_to_include: Type.Optional(Type.Integer({
			description: "Use the last N images from the active conversation as edit inputs. Do not combine with referenced_image_paths.",
			minimum: 1,
			maximum: 5,
		})),
	},
	{ additionalProperties: false },
);

export interface ImageToolDetails {
	savedPath?: string;
	saveWarning?: string;
	submittedPrompt: string;
	operation: "generate" | "edit";
	model: ImageModel;
	referencedImageCount: number;
	background?: "transparent" | "opaque" | "auto";
	quality?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
	size?: string;
	requestId?: string;
}

const USAGE_CODES = new Set([
	"usage_limit_reached",
	"insufficient_quota",
	"quota_exceeded",
	"go_usage_limit_error",
	"free_usage_limit_error",
]);
const AUTH_CODES = new Set([
	"authentication_error",
	"invalid_api_key",
	"invalid_token",
	"oauth_token_invalid",
	"unauthorized",
]);

function normalized(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export function classifyImageFailure(error: unknown): AccountOperationFailure {
	if (!(error instanceof ImageRequestError) || error.kind !== "http" || !error.captured) {
		return { kind: "other" };
	}
	const captured = error.captured;
	const code = normalized(captured.code || captured.type);
	const type = normalized(captured.type);
	const reason = sanitizeErrorMessage(captured.message ?? error.message);
	const limitId = captured.activeLimit;
	if (code === "usage_not_included" || type === "usage_not_included") {
		return {
			kind: "usage_not_included",
			limitId: limitId ?? IMAGE_RESOURCE_ID,
			reason,
		};
	}
	if (USAGE_CODES.has(code) || USAGE_CODES.has(type)) {
		return {
			kind: "usage_limit",
			limitId: limitId ?? IMAGE_RESOURCE_ID,
			...(captured.resetAt !== undefined ? { resetAt: captured.resetAt } : {}),
			reason,
		};
	}
	if (captured.status === 401 || (captured.status === 403 && (AUTH_CODES.has(code) || AUTH_CODES.has(type)))) {
		return { kind: "auth", reason };
	}
	return { kind: "other" };
}

function resultText(path: string | undefined, warning: string | undefined): string {
	if (path) {
		return `Generated image saved to ${path}. The image is already displayed; do not add a redundant Markdown image.`;
	}
	return `The generated image is displayed, but it could not be saved: ${warning ?? "unknown save error"}`;
}

export function createImageTool(
	router: RingRouter,
	client: ImagesClient,
	agentDir: string,
): ToolDefinition<typeof ImageToolParameters, ImageToolDetails> {
	return defineTool({
		name: "image_gen",
		label: "Image generation",
		description: "Generate a new image or edit existing images with OpenAI image generation. The optional model defaults to Flare; select Sunburst for maximum precision or GPT Image 2 when explicitly requested. To generate a new image, omit both image selectors. To edit local files, provide referenced_image_paths with up to five absolute paths. To edit recent conversation images, provide num_last_images_to_include. Never combine the two selectors. Prefer absolute paths when stable files exist. For multiple assets or variants, call image_gen once per image. Generated PNGs are returned inline and saved automatically; there is no output-path argument.",
		promptSnippet: "Generate or edit raster images with selectable OpenAI image models",
		promptGuidelines: [
			"Use image_gen for requested raster image generation and editing; omit both image selectors for a new image.",
			"For image_gen, omit model to use gpt-image-2.5-flare-2026-09-08 for most work; select gpt-image-2.5-sunburst-2026-09-08 when maximum generation or editing precision matters, and honor explicit requests for gpt-image-2-2026-04-21.",
			"For image_gen edits, use referenced_image_paths for stable absolute paths, or num_last_images_to_include for recent pathless images, but never both.",
			"Use one image_gen call per requested asset or variant, and do not reconfirm unless a required image is missing.",
		],
		parameters: ImageToolParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const model = params.model ?? DEFAULT_IMAGE_MODEL;
			const paths = params.referenced_image_paths ?? [];
			if (paths.length > 0 && params.num_last_images_to_include !== undefined) {
				throw new Error("provide only one of `referenced_image_paths` or `num_last_images_to_include`");
			}
			let images: string[] | undefined;
			if (paths.length > 0) images = await localImageDataUrls(paths);
			else if (params.num_last_images_to_include !== undefined) {
				images = await recentImageDataUrls(
					ctx.sessionManager.buildContextEntries(),
					params.num_last_images_to_include,
				);
			}

			const generated = await router.runAccountOperation<GeneratedImage>({
				resourceId: IMAGE_RESOURCE_ID,
				...(signal ? { signal } : {}),
				execute: (account, baseUrl, operationSignal) => client.request(
					account,
					baseUrl,
					{
						prompt: params.prompt,
						model,
						...(images ? { images } : {}),
					},
					operationSignal,
				),
				classify: classifyImageFailure,
				observation: (result) => result.observation,
			});

			const destination = imageArtifactPath(
				agentDir,
				ctx.sessionManager.getCwd(),
				ctx.sessionManager.getSessionId(),
				toolCallId,
			);
			let savedPath: string | undefined;
			let saveWarning: string | undefined;
			try {
				await saveImageArtifact(destination, generated.bytes);
				savedPath = destination;
			} catch (error) {
				saveWarning = sanitizeErrorMessage(error);
				if (ctx.hasUI) ctx.ui.notify(`Generated image could not be saved: ${saveWarning}`, "warning");
			}

			const details: ImageToolDetails = {
				submittedPrompt: params.prompt,
				operation: images ? "edit" : "generate",
				model,
				referencedImageCount: images?.length ?? 0,
				...(savedPath ? { savedPath } : {}),
				...(saveWarning ? { saveWarning } : {}),
				...generated.metadata,
			};
			return {
				content: [
					{ type: "image", data: generated.base64, mimeType: "image/png" },
					{ type: "text", text: resultText(savedPath, saveWarning) },
				],
				details,
			};
		},
	});
}

export function registerImageTool(
	pi: ExtensionAPI,
	router: RingRouter,
	client: ImagesClient,
	agentDir: string,
): void {
	pi.registerTool(createImageTool(router, client, agentDir));
}
