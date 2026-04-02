import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiKey: z
    .string()
    .meta({ sensitive: true })
    .describe(
      "OpenAI API key. Use: ${{ vault.get('openai', 'api-key') }}",
    ),
});

async function openaiImageRequest(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ b64Json: string; revisedPrompt?: string }> {
  const response = await fetch(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const result = await response.json();
  const image = result.data[0];
  return {
    b64Json: image.b64_json,
    revisedPrompt: image.revised_prompt,
  };
}

async function openaiEditRequest(
  apiKey: string,
  formData: FormData,
): Promise<{ b64Json: string; revisedPrompt?: string }> {
  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const result = await response.json();
  const image = result.data[0];
  return {
    b64Json: image.b64_json,
    revisedPrompt: image.revised_prompt,
  };
}

export const model = {
  type: "@dougschaefer/openai-image",
  version: "2026.04.02.1",
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
  methods: {
    generate: {
      description:
        "Generate an image from a text prompt using OpenAI gpt-image-1.",
      arguments: z.object({
        prompt: z.string().describe(
          "Text description of the image to generate",
        ),
        model: z
          .enum(["gpt-image-1", "dall-e-3"])
          .default("gpt-image-1")
          .describe("OpenAI image model"),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536", "1792x1024", "auto"])
          .default("1536x1024")
          .describe(
            "Image dimensions (1792x1024 is dall-e-3 only, 1536x1024 is gpt-image-1 only)",
          ),
        quality: z
          .enum(["low", "medium", "high", "standard", "hd"])
          .default("high")
          .describe(
            "Image quality (low/medium/high for gpt-image-1, standard/hd for dall-e-3)",
          ),
        outputName: z
          .string()
          .default("generated")
          .describe("Name for the output data artifact"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const isDalle3 = args.model === "dall-e-3";

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
          size: args.size,
          quality: args.quality,
        };
        if (isDalle3) {
          body.response_format = "b64_json";
        }

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
            model: "gpt-image-1",
            size: args.size,
            filePath,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    edit: {
      description:
        "Edit an existing image using a text prompt. Send an image file and describe the changes.",
      arguments: z.object({
        prompt: z
          .string()
          .describe("Text description of the edits to make"),
        imagePath: z
          .string()
          .describe("Absolute path to the source image file"),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536", "auto"])
          .default("1536x1024")
          .describe("Output image dimensions"),
        quality: z
          .enum(["low", "medium", "high"])
          .default("high")
          .describe("Image quality"),
        outputName: z
          .string()
          .default("edited")
          .describe("Name for the output data artifact"),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;

        context.logger.info("Editing image {path}: {prompt}", {
          path: args.imagePath,
          prompt: args.prompt.length > 80
            ? args.prompt.substring(0, 80) + "..."
            : args.prompt,
        });

        const imageData = await Deno.readFile(args.imagePath);
        const imageBlob = new Blob([imageData], { type: "image/png" });

        const formData = new FormData();
        formData.append("image", imageBlob, "image.png");
        formData.append("prompt", args.prompt);
        formData.append("model", "gpt-image-1");
        formData.append("n", "1");
        formData.append("size", args.size);
        formData.append("quality", args.quality);
        formData.append("response_format", "b64_json");

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
            model: "gpt-image-1",
            size: args.size,
            filePath,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
