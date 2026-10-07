import { z } from "npm:zod@4.3.6";

const GlobalArgsSchema = z.object({
  apiKey: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "OpenAI API key. Use: ${{ vault.get('openai', 'api-key') }}",
    ),
});

const GPT_QUALITIES = ["low", "medium", "high", "auto"] as const;
const GPT_25_QUALITIES = [...GPT_QUALITIES, "xhigh", "max"] as const;
const STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;

interface KnownImageModel {
  /** Standard sizes, or "flexible" for any valid WIDTHxHEIGHT. */
  sizes: readonly string[] | "flexible";
  qualities: readonly string[];
  defaultSize: string;
  defaultQuality: string;
  supportsEdit: boolean;
  /** Shutdown date (YYYY-MM-DD) from OpenAI's deprecations page, if announced. */
  shutdown?: string;
  replacement?: string;
}

/**
 * Size, quality and lifecycle facts for the image models this extension
 * knows about, from the OpenAI spec and deprecations page (checked
 * 2026-10-07). The `model` argument is a free string: a model listed here
 * (or a dated snapshot of one, e.g. `gpt-image-2.5-flare-2026-09-08`) is
 * validated and defaulted locally; any other identifier passes through so
 * the API does the validation. Update this table as OpenAI announces
 * shutdowns: https://developers.openai.com/api/docs/deprecations
 */
export const KNOWN_IMAGE_MODELS: Record<string, KnownImageModel> = {
  "gpt-image-2.5-flare": {
    sizes: "flexible",
    qualities: GPT_25_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
  },
  "gpt-image-2.5-sunburst": {
    sizes: "flexible",
    qualities: GPT_25_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
  },
  "gpt-image-2": {
    sizes: "flexible",
    qualities: GPT_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
  },
  "gpt-image-1.5": {
    sizes: STANDARD_SIZES,
    qualities: GPT_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
    shutdown: "2026-12-01",
    replacement: "gpt-image-2.5-sunburst or gpt-image-2.5-flare",
  },
  "gpt-image-1-mini": {
    sizes: STANDARD_SIZES,
    qualities: GPT_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
    shutdown: "2026-12-01",
    replacement: "gpt-image-2.5-sunburst or gpt-image-2.5-flare",
  },
  "chatgpt-image-latest": {
    sizes: STANDARD_SIZES,
    qualities: GPT_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
    shutdown: "2026-12-01",
    replacement: "gpt-image-2.5-sunburst or gpt-image-2.5-flare",
  },
  "gpt-image-1": {
    sizes: STANDARD_SIZES,
    qualities: GPT_QUALITIES,
    defaultSize: "1536x1024",
    defaultQuality: "high",
    supportsEdit: true,
    shutdown: "2026-10-23",
    replacement: "gpt-image-2.5-sunburst or gpt-image-2.5-flare",
  },
};

/** Models OpenAI has already shut down; requests fail locally, before billing. */
export const RETIRED_IMAGE_MODELS: Record<string, string> = {
  "dall-e-2": "2026-05-12",
  "dall-e-3": "2026-05-12",
};

/** Fast everyday generation; same price as sunburst. */
export const DEFAULT_GENERATE_MODEL = "gpt-image-2.5-flare";
/** OpenAI's recommendation where editing precision matters most. */
export const DEFAULT_EDIT_MODEL = "gpt-image-2.5-sunburst";

/** Known entry for a model id, matching dated snapshots to their family. */
function lookupModel(model: string): KnownImageModel | undefined {
  return KNOWN_IMAGE_MODELS[model] ??
    KNOWN_IMAGE_MODELS[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
}

/**
 * Flexible-size models accept WIDTHxHEIGHT with both edges divisible by 16,
 * an aspect ratio between 1:3 and 3:1, and at most 3840x2160 (spec, 2026-10).
 */
function validFlexibleSize(size: string): boolean {
  if (size === "auto") return true;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 16 || h < 16 || w % 16 !== 0 || h % 16 !== 0) return false;
  if (w / h > 3 || h / w > 3) return false;
  return Math.max(w, h) <= 3840 && w * h <= 3840 * 2160;
}

/**
 * Resolve the size/quality fields to send for a model, refusing retired and
 * shut-down models before any request is made. Known models are validated
 * and defaulted; unknown models get only the fields the caller set (unset
 * fields are omitted, never sent as null). `notice` carries an upcoming
 * shutdown warning for the caller to log. `response_format` is never sent:
 * OpenAI deprecated it, and GPT image models always return base64.
 */
export function resolveImageParams(
  model: string,
  method: "generate" | "edit",
  size?: string,
  quality?: string,
  today: string = new Date().toISOString().slice(0, 10),
): { size?: string; quality?: string; notice?: string } {
  const retired = RETIRED_IMAGE_MODELS[model] ??
    RETIRED_IMAGE_MODELS[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (retired) {
    throw new Error(
      `${model} was shut down by OpenAI on ${retired}. Use ${DEFAULT_GENERATE_MODEL} or ${DEFAULT_EDIT_MODEL}.`,
    );
  }
  const known = lookupModel(model);
  if (!known) return { size, quality };

  if (known.shutdown && today >= known.shutdown) {
    throw new Error(
      `${model} was shut down by OpenAI on ${known.shutdown}. Use ${known.replacement}.`,
    );
  }
  if (method === "edit" && !known.supportsEdit) {
    throw new Error(`Model ${model} does not support image edits.`);
  }
  const resolvedSize = size ?? known.defaultSize;
  const sizeOk = known.sizes === "flexible"
    ? validFlexibleSize(resolvedSize)
    : known.sizes.includes(resolvedSize);
  if (!sizeOk) {
    throw new Error(
      known.sizes === "flexible"
        ? `Size ${resolvedSize} is not valid for ${model}: use auto or WIDTHxHEIGHT with both edges divisible by 16, aspect ratio between 1:3 and 3:1, at most 3840x2160.`
        : `Size ${resolvedSize} is not valid for ${model}. Valid sizes: ${
          known.sizes.join(", ")
        }`,
    );
  }
  const resolvedQuality = quality ?? known.defaultQuality;
  if (!known.qualities.includes(resolvedQuality)) {
    throw new Error(
      `Quality ${resolvedQuality} is not valid for ${model}. Valid qualities: ${
        known.qualities.join(", ")
      }`,
    );
  }
  return {
    size: resolvedSize,
    quality: resolvedQuality,
    notice: known.shutdown
      ? `${model} shuts down on ${known.shutdown}; switch to ${known.replacement}.`
      : undefined,
  };
}

const modelArg = (fallback: string) =>
  z
    .string()
    .min(1)
    .default(fallback)
    .describe(
      `OpenAI image model (default ${fallback}). Known: ${
        Object.keys(KNOWN_IMAGE_MODELS).join(", ")
      }. Dated snapshots of these are accepted; other identifiers pass through to the API unvalidated. Retired models (${
        Object.keys(RETIRED_IMAGE_MODELS).join(", ")
      }) are refused.`,
    );

const SizeArg = z
  .string()
  .optional()
  .describe(
    "Image size. gpt-image-2 and the 2.5 models: auto or any WIDTHxHEIGHT with both edges divisible by 16, aspect ratio 1:3 to 3:1, up to 3840x2160 (default 1536x1024). Older GPT image models: 1024x1024, 1536x1024, 1024x1536, auto. Omitted for unknown models when unset.",
  );

const QualityArg = z
  .string()
  .optional()
  .describe(
    "Image quality: low, medium, high, auto (default high). The 2.5 models also take xhigh and max. Omitted for unknown models when unset.",
  );

const GenerateArgsSchema = z.object({
  prompt: z.string().describe(
    "Text description of the image to generate",
  ),
  model: modelArg(DEFAULT_GENERATE_MODEL),
  size: SizeArg,
  quality: QualityArg,
  outputName: z
    .string()
    .default("generated")
    .describe("Name for the output data artifact"),
});

const EditArgsSchema = z.object({
  prompt: z
    .string()
    .describe("Text description of the edits to make"),
  imagePath: z
    .string()
    .describe("Absolute path to the source image file"),
  model: modelArg(DEFAULT_EDIT_MODEL),
  size: SizeArg,
  quality: QualityArg,
  outputName: z
    .string()
    .default("edited")
    .describe("Name for the output data artifact"),
});

interface MethodContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  repoDir: string;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Large or max-quality images can take minutes, and OpenAI bills a request
 * even if the client gives up waiting, so the timeout only guards against a
 * truly hung connection; a premature abort would mean paying twice on retry.
 */
const REQUEST_TIMEOUT_MS = 600_000;

/** fetch with the image timeout, turning an abort into a clear, honest error. */
async function timedFetch(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `OpenAI ${what} timed out after ${
          REQUEST_TIMEOUT_MS / 1000
        }s. It may still complete and be billed; check usage before retrying.`,
      );
    }
    throw err;
  }
}

/**
 * Turn an OpenAI error response into a short, safe message: the parsed
 * error message and code (never the raw body, which can be an HTML page),
 * any API-key fragment masked, truncated, with 429/5xx marked retryable.
 */
export function openaiError(status: number, body: string): Error {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string };
    };
    if (typeof parsed.error?.message === "string") {
      detail = parsed.error.code
        ? `${parsed.error.message} (${parsed.error.code})`
        : parsed.error.message;
    }
  } catch {
    detail = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  detail = detail.replace(/sk-[A-Za-z0-9_*\-]+/g, "sk-…").slice(0, 500);
  const retry = status === 429 || status >= 500
    ? " Retryable: try again shortly."
    : "";
  return new Error(`OpenAI API error (${status}): ${detail}${retry}`);
}

async function openaiImageRequest(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ b64Json: string; revisedPrompt?: string }> {
  const response = await timedFetch(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    `image generation (${body.model})`,
  );

  if (!response.ok) {
    throw openaiError(response.status, await response.text());
  }

  const result = await response.json();
  const image = result?.data?.[0];
  if (!image?.b64_json) {
    // GPT image models always return base64; a URL-only response means a
    // model this extension cannot store. Fail clearly rather than at atob().
    throw new Error(
      "OpenAI returned no base64 image data (b64_json). Use a GPT image model.",
    );
  }
  return {
    b64Json: image.b64_json,
    revisedPrompt: image.revised_prompt,
  };
}

async function openaiEditRequest(
  apiKey: string,
  formData: FormData,
): Promise<{ b64Json: string; revisedPrompt?: string }> {
  const response = await timedFetch(
    "https://api.openai.com/v1/images/edits",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
    `image edit (${formData.get("model")})`,
  );

  if (!response.ok) {
    throw openaiError(response.status, await response.text());
  }

  const result = await response.json();
  const image = result?.data?.[0];
  if (!image?.b64_json) {
    // GPT image models always return base64; a URL-only response means a
    // model this extension cannot store. Fail clearly rather than at atob().
    throw new Error(
      "OpenAI returned no base64 image data (b64_json). Use a GPT image model.",
    );
  }
  return {
    b64Json: image.b64_json,
    revisedPrompt: image.revised_prompt,
  };
}

/**
 * `@dougschaefer/openai-image` model — image generation and editing via
 * OpenAI's image endpoints (gpt-image-2.5-flare for generation and
 * gpt-image-2.5-sunburst for edits by default; any image model identifier
 * is accepted, see KNOWN_IMAGE_MODELS). Generate produces an image from a
 * text prompt with size and quality controls. Edit takes one source image
 * (PNG, JPEG or WebP) plus a prompt and returns a modified image. The API
 * key comes from globalArguments (vault-resolved). Each result is saved as
 * a PNG under .swamp/generated-images/ and recorded as an `image` data
 * artifact pointing at that file.
 */
export const model = {
  type: "@dougschaefer/openai-image",
  version: "2026.10.06.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    image: {
      description: "Generated or edited image",
      schema: z.object({
        prompt: z.string(),
        revisedPrompt: z.string().optional(),
        model: z.string(),
        size: z.string(),
        filePath: z.string(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  // globalArguments are unchanged across versions, so every upgrade is a
  // no-op; swamp still needs the chain so existing instances are not stranded.
  upgrades: [
    {
      toVersion: "2026.10.06.1",
      description:
        "Model selection rework (2.5 defaults, shutdown handling); globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  methods: {
    generate: {
      description:
        "Generate an image from a text prompt using an OpenAI image model (default gpt-image-2.5-flare).",
      labels: ["live"],
      arguments: GenerateArgsSchema,
      execute: async (
        args: z.infer<typeof GenerateArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const params = resolveImageParams(
          args.model,
          "generate",
          args.size,
          args.quality,
        );

        if (params.notice) {
          context.logger.info("{notice}", { notice: params.notice });
        }
        context.logger.info("Generating image with {model}: {prompt}", {
          model: args.model,
          prompt: args.prompt.length > 80
            ? args.prompt.substring(0, 80) + "..."
            : args.prompt,
        });

        const body: Record<string, unknown> = {
          model: args.model,
          prompt: args.prompt,
          n: 1,
        };
        if (params.size) body.size = params.size;
        if (params.quality) body.quality = params.quality;

        const result = await openaiImageRequest(g.apiKey, body);

        const imageBytes = Uint8Array.from(
          atob(result.b64Json),
          (c) => c.charCodeAt(0),
        );

        const outputDir = `${context.repoDir}/.swamp/generated-images`;
        await Deno.mkdir(outputDir, { recursive: true });
        const fileName = `${args.outputName}-${Date.now()}.png`;
        const filePath = `${outputDir}/${fileName}`;
        await Deno.writeFile(filePath, imageBytes);

        context.logger.info("Image saved to {path} ({size} bytes)", {
          path: filePath,
          size: imageBytes.length,
        });

        if (result.revisedPrompt) {
          context.logger.info("Revised prompt: {revised}", {
            revised: result.revisedPrompt,
          });
        }

        const handle = await context.writeResource(
          "image",
          args.outputName,
          {
            prompt: args.prompt,
            revisedPrompt: result.revisedPrompt ?? "",
            model: args.model,
            size: params.size ?? "default",
            filePath,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    edit: {
      description:
        "Edit an existing image using a text prompt (default gpt-image-2.5-sunburst). Send an image file and describe the changes.",
      labels: ["live"],
      arguments: EditArgsSchema,
      execute: async (
        args: z.infer<typeof EditArgsSchema>,
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const params = resolveImageParams(
          args.model,
          "edit",
          args.size,
          args.quality,
        );

        if (params.notice) {
          context.logger.info("{notice}", { notice: params.notice });
        }
        context.logger.info("Editing image {path} with {model}: {prompt}", {
          model: args.model,
          path: args.imagePath,
          prompt: args.prompt.length > 80
            ? args.prompt.substring(0, 80) + "..."
            : args.prompt,
        });

        const ext = args.imagePath.toLowerCase().match(/\.(png|jpe?g|webp)$/)
          ?.[1];
        if (!ext) {
          throw new Error(
            `Source image must be a .png, .jpg, .jpeg or .webp file: ${args.imagePath}`,
          );
        }
        const mime = ext === "png"
          ? "image/png"
          : ext === "webp"
          ? "image/webp"
          : "image/jpeg";
        const imageData = await Deno.readFile(args.imagePath);
        const imageBlob = new Blob([imageData], { type: mime });

        const formData = new FormData();
        formData.append("image", imageBlob, `image.${ext}`);
        formData.append("prompt", args.prompt);
        formData.append("model", args.model);
        formData.append("n", "1");
        if (params.size) formData.append("size", params.size);
        if (params.quality) formData.append("quality", params.quality);

        const result = await openaiEditRequest(g.apiKey, formData);

        const imageBytes = Uint8Array.from(
          atob(result.b64Json),
          (c) => c.charCodeAt(0),
        );

        const outputDir = `${context.repoDir}/.swamp/generated-images`;
        await Deno.mkdir(outputDir, { recursive: true });
        const fileName = `${args.outputName}-${Date.now()}.png`;
        const filePath = `${outputDir}/${fileName}`;
        await Deno.writeFile(filePath, imageBytes);

        context.logger.info("Edited image saved to {path} ({size} bytes)", {
          path: filePath,
          size: imageBytes.length,
        });

        const handle = await context.writeResource(
          "image",
          args.outputName,
          {
            prompt: args.prompt,
            revisedPrompt: result.revisedPrompt ?? "",
            model: args.model,
            size: params.size ?? "default",
            filePath,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },

  checks: {
    "openai-reachable": {
      description:
        "Verify the OpenAI API key is valid and the images endpoint is reachable before generating or editing.",
      labels: ["live"],
      appliesTo: ["generate", "edit"],
      execute: async (
        context: { globalArgs: z.infer<typeof GlobalArgsSchema> },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        try {
          const resp = await fetch("https://api.openai.com/v1/models", {
            headers: {
              Authorization: `Bearer ${context.globalArgs.apiKey}`,
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!resp.ok) {
            return {
              pass: false,
              errors: [openaiError(resp.status, await resp.text()).message],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [`OpenAI API unreachable: ${String(err)}`],
          };
        }
      },
    },
  },
};
