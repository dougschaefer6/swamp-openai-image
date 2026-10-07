import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_GENERATE_MODEL,
  KNOWN_IMAGE_MODELS,
  model,
  openaiError,
  resolveImageParams,
  RETIRED_IMAGE_MODELS,
} from "./image.ts";

// Fixed dates so lifecycle tests never become time bombs.
const BEFORE_SHUTDOWNS = "2026-10-07";
const AFTER_OCT_23 = "2026-10-24";
const AFTER_DEC_1 = "2026-12-02";

// A 1x1 transparent PNG, base64-encoded.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface Captured {
  url: string;
  init?: RequestInit;
}

/** Swap `globalThis.fetch` for a stub that records calls; returns a restore function. */
function mockFetch(
  calls: Captured[],
  status = 200,
  body = JSON.stringify({ data: [{ b64_json: PNG_B64 }] }),
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A fake method context rooted in a temp dir that records `writeResource` calls. */
function fakeContext(repoDir: string) {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: { apiKey: "test-key" },
    repoDir,
    logger: { info: () => {}, warning: () => {} },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name, specName: spec });
    },
  };
  return { ctx, writes };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

function parseArgs(method: string, input: Record<string, unknown>) {
  return methods[method].arguments.parse(input);
}

Deno.test("model version and per-method defaults", () => {
  assertEquals(model.version, "2026.10.06.1");
  assertEquals(DEFAULT_GENERATE_MODEL, "gpt-image-2.5-flare");
  assertEquals(DEFAULT_EDIT_MODEL, "gpt-image-2.5-sunburst");
  for (const m of [DEFAULT_GENERATE_MODEL, DEFAULT_EDIT_MODEL]) {
    assert(m in KNOWN_IMAGE_MODELS);
    assertEquals(KNOWN_IMAGE_MODELS[m].shutdown, undefined);
  }
  const gen = parseArgs("generate", { prompt: "x" });
  assertEquals(gen.model, DEFAULT_GENERATE_MODEL);
  assertEquals(gen.size, undefined);
  assertEquals(gen.quality, undefined);
  const edit = parseArgs("edit", { prompt: "x", imagePath: "/tmp/a.png" });
  assertEquals(edit.model, DEFAULT_EDIT_MODEL);
});

Deno.test("model argument accepts unknown identifiers", () => {
  const args = parseArgs("generate", {
    prompt: "x",
    model: "gpt-image-9-example",
  });
  assertEquals(args.model, "gpt-image-9-example");
});

Deno.test("resolveImageParams defaults known models and warns before a shutdown", () => {
  assertEquals(resolveImageParams("gpt-image-2.5-flare", "generate"), {
    size: "1536x1024",
    quality: "high",
    notice: undefined,
  });
  const old = resolveImageParams(
    "gpt-image-1",
    "generate",
    undefined,
    undefined,
    BEFORE_SHUTDOWNS,
  );
  assertEquals(old.size, "1536x1024");
  assert(old.notice?.includes("2026-10-23"));
});

Deno.test("resolveImageParams matches dated snapshots to their family", () => {
  const r = resolveImageParams(
    "gpt-image-2.5-sunburst-2026-09-08",
    "edit",
    undefined,
    "max",
  );
  assertEquals(r.quality, "max");
  assertEquals(r.size, "1536x1024");
});

Deno.test("resolveImageParams refuses shut-down and retired models locally", () => {
  assertThrows(
    () =>
      resolveImageParams(
        "gpt-image-1",
        "generate",
        undefined,
        undefined,
        AFTER_OCT_23,
      ),
    Error,
    "shut down by OpenAI on 2026-10-23",
  );
  assertThrows(
    () =>
      resolveImageParams(
        "gpt-image-1.5",
        "edit",
        undefined,
        undefined,
        AFTER_DEC_1,
      ),
    Error,
    "shut down by OpenAI on 2026-12-01",
  );
  for (const m of Object.keys(RETIRED_IMAGE_MODELS)) {
    assertThrows(
      () => resolveImageParams(m, "generate"),
      Error,
      "shut down by OpenAI",
    );
  }
});

Deno.test("resolveImageParams validates flexible sizes and 2.5-only qualities", () => {
  for (
    const ok of ["auto", "1536x864", "2560x1440", "3840x2160", "1024x3072"]
  ) {
    assertEquals(
      resolveImageParams("gpt-image-2.5-flare", "generate", ok).size,
      ok,
    );
  }
  for (const bad of ["1000x1000", "4096x2304", "1024x4096", "big"]) {
    assertThrows(
      () => resolveImageParams("gpt-image-2.5-flare", "generate", bad),
      Error,
      "not valid",
    );
  }
  assertThrows(
    () =>
      resolveImageParams(
        "gpt-image-1.5",
        "generate",
        "1536x864",
        undefined,
        BEFORE_SHUTDOWNS,
      ),
    Error,
    "not valid",
  );
  assertThrows(
    () => resolveImageParams("gpt-image-2", "generate", undefined, "max"),
    Error,
    "not valid",
  );
});

Deno.test("resolveImageParams passes unknown models through and omits unset fields", () => {
  assertEquals(resolveImageParams("gpt-image-9-example", "generate"), {
    size: undefined,
    quality: undefined,
  });
  assertEquals(
    resolveImageParams("gpt-image-9-example", "edit", "2048x2048", "ultra"),
    { size: "2048x2048", quality: "ultra" },
  );
});

Deno.test("generate sends the default model and never sends response_format", async () => {
  const repoDir = await Deno.makeTempDir();
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx, writes } = fakeContext(repoDir);
  try {
    await methods.generate.execute(
      parseArgs("generate", { prompt: "a test image" }),
      ctx,
    );
  } finally {
    restore();
    await Deno.remove(repoDir, { recursive: true });
  }
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.openai.com/v1/images/generations");
  const body = JSON.parse(calls[0].init?.body as string);
  assertEquals(body.model, DEFAULT_GENERATE_MODEL);
  assertEquals(body.size, "1536x1024");
  assertEquals(body.quality, "high");
  assert(!("response_format" in body));
  assertEquals(writes[0].data.model, DEFAULT_GENERATE_MODEL);
});

Deno.test("generate with an unknown model omits unset fields instead of sending null", async () => {
  const repoDir = await Deno.makeTempDir();
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx, writes } = fakeContext(repoDir);
  try {
    await methods.generate.execute(
      parseArgs("generate", { prompt: "x", model: "gpt-image-9-example" }),
      ctx,
    );
  } finally {
    restore();
    await Deno.remove(repoDir, { recursive: true });
  }
  const body = JSON.parse(calls[0].init?.body as string);
  assertEquals(Object.keys(body).sort(), ["model", "n", "prompt"]);
  assertEquals(writes[0].data.size, "default");
});

Deno.test("generate refuses a retired model and an invalid size before calling the API", async () => {
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx } = fakeContext("/nonexistent");
  try {
    await assertRejects(
      () =>
        methods.generate.execute(
          parseArgs("generate", { prompt: "x", model: "dall-e-3" }),
          ctx,
        ),
      Error,
      "shut down by OpenAI",
    );
    await assertRejects(
      () =>
        methods.generate.execute(
          parseArgs("generate", { prompt: "x", size: "1000x1000" }),
          ctx,
        ),
      Error,
      "not valid",
    );
  } finally {
    restore();
  }
  assertEquals(calls.length, 0);
});

Deno.test("generate surfaces API errors and a response with no base64 image", async () => {
  const repoDir = await Deno.makeTempDir();
  const { ctx } = fakeContext(repoDir);
  try {
    let restore = mockFetch([], 400, "model_not_found");
    try {
      await assertRejects(
        () =>
          methods.generate.execute(parseArgs("generate", { prompt: "x" }), ctx),
        Error,
        "OpenAI API error (400)",
      );
    } finally {
      restore();
    }
    restore = mockFetch(
      [],
      200,
      JSON.stringify({ data: [{ url: "https://example.com/a.png" }] }),
    );
    try {
      await assertRejects(
        () =>
          methods.generate.execute(parseArgs("generate", { prompt: "x" }), ctx),
        Error,
        "no base64 image data",
      );
    } finally {
      restore();
    }
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("edit defaults to sunburst and omits response_format", async () => {
  const repoDir = await Deno.makeTempDir();
  const imagePath = `${repoDir}/source.png`;
  await Deno.writeFile(
    imagePath,
    Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)),
  );
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx, writes } = fakeContext(repoDir);
  try {
    await methods.edit.execute(
      parseArgs("edit", {
        prompt: "make it blue",
        imagePath,
        quality: "xhigh",
      }),
      ctx,
    );
  } finally {
    restore();
    await Deno.remove(repoDir, { recursive: true });
  }
  assertEquals(calls[0].url, "https://api.openai.com/v1/images/edits");
  const form = calls[0].init?.body as FormData;
  assertEquals(form.get("model"), DEFAULT_EDIT_MODEL);
  assertEquals(form.get("size"), "1536x1024");
  assertEquals(form.get("quality"), "xhigh");
  assertEquals(form.get("response_format"), null);
  assertEquals(writes[0].data.model, DEFAULT_EDIT_MODEL);
});

Deno.test("shutdown applies on the date itself, to dated snapshots, and to chatgpt-image-latest", () => {
  assertThrows(
    () =>
      resolveImageParams(
        "gpt-image-1",
        "generate",
        undefined,
        undefined,
        "2026-10-23",
      ),
    Error,
    "shut down",
  );
  assertThrows(
    () =>
      resolveImageParams(
        "gpt-image-1.5-2025-12-16",
        "generate",
        undefined,
        undefined,
        AFTER_DEC_1,
      ),
    Error,
    "shut down",
  );
  assertThrows(
    () =>
      resolveImageParams(
        "chatgpt-image-latest",
        "edit",
        undefined,
        undefined,
        AFTER_DEC_1,
      ),
    Error,
    "shut down",
  );
  assert(
    resolveImageParams(
      "gpt-image-1",
      "generate",
      undefined,
      undefined,
      "2026-10-22",
    ).notice,
  );
});

Deno.test("degenerate flexible sizes are refused", () => {
  for (const bad of ["0x0", "0x1024", "16x0", "8x16"]) {
    assertThrows(
      () => resolveImageParams("gpt-image-2.5-flare", "generate", bad),
      Error,
      "not valid",
    );
  }
});

Deno.test("openaiError parses the message, masks key fragments, and flags retryable statuses", () => {
  const e401 = openaiError(
    401,
    JSON.stringify({
      error: {
        message: "Incorrect API key provided: sk-proj-****abcd.",
        code: "invalid_api_key",
      },
    }),
  );
  assert(e401.message.includes("Incorrect API key provided"));
  assert(!e401.message.includes("abcd"));
  assert(e401.message.includes("invalid_api_key"));
  assert(!e401.message.includes("Retryable"));
  const e503 = openaiError(
    503,
    "<html><body>Service Unavailable</body></html>",
  );
  assert(e503.message.includes("Service Unavailable"));
  assert(!e503.message.includes("<html>"));
  assert(e503.message.includes("Retryable"));
  assert(openaiError(429, "x".repeat(2000)).message.length < 600);
});

Deno.test("edit labels JPEG sources correctly and refuses unsupported file types", async () => {
  const repoDir = await Deno.makeTempDir();
  const jpg = `${repoDir}/source.jpg`;
  await Deno.writeFile(
    jpg,
    Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)),
  );
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx } = fakeContext(repoDir);
  try {
    await methods.edit.execute(
      parseArgs("edit", { prompt: "x", imagePath: jpg }),
      ctx,
    );
    const file = (calls[0].init?.body as FormData).get("image") as File;
    assertEquals(file.type, "image/jpeg");
    assertEquals(file.name, "image.jpg");
    await assertRejects(
      () =>
        methods.edit.execute(
          parseArgs("edit", {
            prompt: "x",
            imagePath: `${repoDir}/source.gif`,
          }),
          ctx,
        ),
      Error,
      "must be a .png, .jpg, .jpeg or .webp",
    );
  } finally {
    restore();
    await Deno.remove(repoDir, { recursive: true });
  }
  assertEquals(calls.length, 1);
});

Deno.test("the upgrade chain ends at the current version and keeps attributes", () => {
  // deno-lint-ignore no-explicit-any
  const upgrades = (model as any).upgrades as Array<{
    toVersion: string;
    upgradeAttributes: (o: Record<string, unknown>) => Record<string, unknown>;
  }>;
  assertEquals(upgrades.at(-1)?.toVersion, model.version);
  assertEquals(upgrades[0].upgradeAttributes({ apiKey: "k" }), { apiKey: "k" });
});

Deno.test("a timeout becomes a clear error that warns about billing", async () => {
  const repoDir = await Deno.makeTempDir();
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(
      new DOMException("The operation timed out.", "TimeoutError"),
    )) as typeof fetch;
  const { ctx } = fakeContext(repoDir);
  try {
    await assertRejects(
      () =>
        methods.generate.execute(parseArgs("generate", { prompt: "x" }), ctx),
      Error,
      "may still complete and be billed",
    );
  } finally {
    globalThis.fetch = original;
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("openaiError survives a non-string error message", () => {
  const e = openaiError(
    500,
    JSON.stringify({ error: { message: { nested: true } } }),
  );
  assert(e.message.startsWith("OpenAI API error (500)"));
});

Deno.test("edit accepts upper-case image extensions", async () => {
  const repoDir = await Deno.makeTempDir();
  const src = `${repoDir}/SOURCE.PNG`;
  await Deno.writeFile(
    src,
    Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)),
  );
  const calls: Captured[] = [];
  const restore = mockFetch(calls);
  const { ctx } = fakeContext(repoDir);
  try {
    await methods.edit.execute(
      parseArgs("edit", { prompt: "x", imagePath: src }),
      ctx,
    );
  } finally {
    restore();
    await Deno.remove(repoDir, { recursive: true });
  }
  assertEquals(
    ((calls[0].init?.body as FormData).get("image") as File).type,
    "image/png",
  );
});
