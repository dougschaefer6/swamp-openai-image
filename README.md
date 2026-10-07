# OpenAI Image Extension for Swamp

A swamp extension that generates and edits images through the OpenAI API, using
OpenAI's GPT image models (gpt-image-2.5-flare for generation and
gpt-image-2.5-sunburst for edits by default). It runs locally, stores
credentials in a swamp vault, and writes output images to disk as standard PNG
files that other swamp models and workflows can reference.

The extension covers two operations: generating images from text prompts and
editing existing images by sending a reference image alongside a text
description of the changes you want. Both methods support model selection,
configurable output dimensions, and quality tiers. Generated images are saved to
`.swamp/generated-images/` and tracked as swamp data artifacts with full version
history.

## Prerequisites

- An OpenAI API account with credits
  ([platform.openai.com](https://platform.openai.com))
- An API key with image generation permissions
- Swamp installed and a repository initialized

The gpt-image models may require organization verification or a minimum usage
tier on your OpenAI account. New accounts may need to wait a few minutes after
adding credits for rate limits to propagate.

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

The `put` command will prompt for the key value with hidden input. You can also
pipe it from stdin for scripts:

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

The image is saved to `.swamp/generated-images/` and the file path is recorded
in the data artifact. You can retrieve the path and metadata with:

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

The source image can be PNG, JPEG or WebP. The edited image is saved as a new
PNG under `.swamp/generated-images/`; the original is not modified.

### Model Selection

Both methods accept a `model` parameter, which is a free-form model identifier
rather than a fixed list. `generate` defaults to `gpt-image-2.5-flare`, OpenAI's
fastest high-quality model, and `edit` defaults to `gpt-image-2.5-sunburst`,
which OpenAI recommends where editing precision matters most. The two cost the
same. The extension keeps a small table of models it knows the size, quality and
lifecycle of; for those it fills in defaults and rejects invalid combinations
before any request is sent, and dated snapshots (for example
`gpt-image-2.5-flare-2026-09-08`) are matched to their family. Any other
identifier is passed straight through to the API, which does the validation; for
those models `size` and `quality` are only sent when you set them.

| Model                    | Sizes    | Qualities                                       | Shutdown       |
| ------------------------ | -------- | ----------------------------------------------- | -------------- |
| `gpt-image-2.5-flare`    | flexible | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | none announced |
| `gpt-image-2.5-sunburst` | flexible | `low`, `medium`, `high`, `xhigh`, `max`, `auto` | none announced |
| `gpt-image-2`            | flexible | `low`, `medium`, `high`, `auto`                 | none announced |
| `gpt-image-1.5`          | standard | `low`, `medium`, `high`, `auto`                 | 2026-12-01     |
| `gpt-image-1-mini`       | standard | `low`, `medium`, `high`, `auto`                 | 2026-12-01     |
| `chatgpt-image-latest`   | standard | `low`, `medium`, `high`, `auto`                 | 2026-12-01     |
| `gpt-image-1`            | standard | `low`, `medium`, `high`, `auto`                 | 2026-10-23     |

_Flexible_ sizes are `auto` or any `WIDTHxHEIGHT` with both edges divisible by
16, an aspect ratio between 1:3 and 3:1, and at most `3840x2160` (above
`2560x1440` is experimental). _Standard_ sizes are `1024x1024`, `1536x1024`,
`1024x1536` and `auto`. Every known model defaults to `1536x1024` at `high`.

A model with an announced shutdown logs a warning naming its replacement until
the shutdown date, and is refused locally after it, so a request is never billed
against a model that no longer exists. DALL-E 2 and DALL-E 3 were shut down on
2026-05-12 and are always refused. The extension never sends `response_format`:
OpenAI deprecated it, and GPT image models always return base64. Check the
[deprecations page](https://developers.openai.com/api/docs/deprecations) before
each release and update the table.

```bash
swamp model method run image-gen generate --input '{
  "prompt": "...",
  "model": "gpt-image-2.5-sunburst",
  "size": "2560x1440",
  "quality": "max"
}'
```

The `model` and `size` fields recorded in the data artifact are the values
actually sent. When an unknown model is used without a `size`, the artifact
records `default`.

## Methods

| Method     | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `generate` | Create an image from a text prompt                               |
| `edit`     | Modify an existing image using a text prompt and reference image |

## Cost

OpenAI charges per image, and the price depends on the model, size, and quality
you choose. `high` quality at `1536x1024` (the default for the gpt-image models)
is the most expensive of the standard options, and `xhigh`, `max` and larger
flexible sizes on the 2.5 models cost more again; `low` and `medium` cost far
less. Prices change often, so check
[openai.com/api/pricing](https://openai.com/api/pricing) before running large
batches rather than relying on figures here.

## Quality and Testing

This extension has been tested against the OpenAI API in a production
integration lab. The maintainer is solely responsible for this integration.
OpenAI does not provide direct support for third-party swamp extensions.

## License

MIT. See [LICENSE](LICENSE.txt) for details.
