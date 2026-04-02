# OpenAI Image Extension for Swamp

A swamp extension that generates and edits images through the OpenAI API, supporting both gpt-image-1 and DALL-E 3. It runs locally, stores credentials in a swamp vault, and writes output images to disk as standard PNG files that other swamp models and workflows can reference.

The extension covers two operations: generating images from text prompts and editing existing images by sending a reference image alongside a text description of the changes you want. Both methods support model selection, configurable output dimensions, and quality tiers. Generated images are saved to `.swamp/generated-images/` and tracked as swamp data artifacts with full version history.

## Prerequisites

- An OpenAI API account with credits ([platform.openai.com](https://platform.openai.com))
- An API key with image generation permissions
- Swamp installed and a repository initialized

gpt-image-1 requires your OpenAI account to be at Tier 1 or above. New accounts may need to wait a few minutes after adding credits for rate limits to propagate. DALL-E 3 is available at all tiers but produces lower quality results, particularly for text rendering within images.

## Installation

```bash
swamp extension pull @dougschaefer/openai-image
```

## Setup

Create a vault and store your API key:

```bash
swamp vault create local_encryption openai
swamp vault put openai api-key
```

The `put` command will prompt for the key value with hidden input. You can also pipe it from stdin for scripts:

```bash
echo "$OPENAI_API_KEY" | swamp vault put openai api-key
```

Create a model instance wired to the vault:

```bash
swamp model create @dougschaefer/openai-image image-gen \
  --global-arg 'apiKey=${{ vault.get("openai", "api-key") }}'
```

## Usage

### Generate an Image

```bash
swamp model method run image-gen generate --input '{
  "prompt": "A clean corporate blog header with abstract geometric shapes in dark blue and teal, no text",
  "size": "1536x1024",
  "quality": "high"
}'
```

The image is saved to `.swamp/generated-images/` and the file path is recorded in the data artifact. You can retrieve the path and metadata with:

```bash
swamp data get image-gen generated --json
```

### Edit an Existing Image

Send a reference image and describe the changes:

```bash
swamp model method run image-gen edit --input '{
  "prompt": "Change the background color to dark navy blue",
  "imagePath": "/absolute/path/to/source.png"
}'
```

The edited image is written as a new file alongside the original.

### Model Selection

Both methods accept a `model` parameter. gpt-image-1 is the default and produces significantly better results for text rendering, prompt adherence, and photorealistic output. DALL-E 3 is available as a fallback for accounts that have not yet reached the rate limit tier required for gpt-image-1.

```bash
swamp model method run image-gen generate --input '{
  "prompt": "...",
  "model": "dall-e-3",
  "size": "1792x1024",
  "quality": "hd"
}'
```

Note that the `size` and `quality` enums differ between models. gpt-image-1 accepts `low`, `medium`, and `high` quality with sizes up to `1536x1024`. DALL-E 3 accepts `standard` and `hd` quality with a maximum of `1792x1024`.

## Methods

| Method | Description |
|--------|-------------|
| `generate` | Create an image from a text prompt |
| `edit` | Modify an existing image using a text prompt and reference image |

## Cost

OpenAI charges per image generated. At the time of writing, gpt-image-1 costs approximately $0.17 per 1024x1024 image and $0.19 per 1536x1024 image. DALL-E 3 is slightly less. A $5 credit balance will cover several dozen generations. Current pricing is at [openai.com/api/pricing](https://openai.com/api/pricing).

## Quality and Testing

This extension has been tested against the OpenAI API in the American Sound integration lab. American Sound is solely responsible for this integration. OpenAI does not provide direct support for third-party swamp extensions.

## License

MIT. See [LICENSE](LICENSE) for details.
