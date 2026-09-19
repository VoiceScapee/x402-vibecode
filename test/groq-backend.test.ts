/**
 * Groq AI backend tests ($0 free tier, OpenAI-compatible chat completions).
 *
 *   - aiBackend(): selection matrix — null / groq / anthropic / anthropic-wins
 *   - vibecode() + reviewCopy() through the Groq envelope (mocked fetch):
 *     Bearer auth, system+user messages, response_format json_object,
 *     OpenAI-format response parsing, schema validation
 *   - fail-closed with no keys; provider errors surface as typed errors
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createStarterPage } from "../src/schema.js";
import {
  aiBackend,
  DEFAULT_GROQ_MODEL,
  reviewCopy,
  vibecode,
  CopyReviewError,
  VibecodeError,
  type CopyReview,
} from "../src/anthropic.js";

const AI_KEYS = ["ANTHROPIC_API_KEY", "GROQ_API_KEY"];

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function mockFetch(
  handler: (url: unknown, init: { headers?: unknown; body?: unknown }) => unknown,
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) =>
    handler(url, (init ?? {}) as { headers?: unknown; body?: unknown })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const okJson = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const errJson = (status: number, payload: unknown = { error: "boom" }) => ({
  ok: false,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

function groqCompletion(content: string) {
  return okJson({ choices: [{ message: { role: "assistant", content } }] });
}

function validReview(): CopyReview {
  return {
    summary: "Tight hero, thin bio. Reads like a real person.",
    score: 6,
    strengths: ["hero title is specific"],
    suggestions: [{ block: "bio", issue: "too short", fix: "add one concrete detail" }],
  };
}

describe("aiBackend() selection", () => {
  it("null when no keys are set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, () => {
      assert.equal(aiBackend(), null);
    });
  });

  it("groq when only GROQ_API_KEY is set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, () => {
      assert.equal(aiBackend(), "groq");
    });
  });

  it("anthropic when only ANTHROPIC_API_KEY is set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "sk-test", GROQ_API_KEY: undefined }, () => {
      assert.equal(aiBackend(), "anthropic");
    });
  });

  it("anthropic wins when both keys are set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "sk-test", GROQ_API_KEY: "gsk-test" }, () => {
      assert.equal(aiBackend(), "anthropic");
    });
  });
});

describe("vibecode() via Groq", () => {
  it("sends the OpenAI-compatible envelope and parses the page", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, async () => {
      const page = createStarterPage("groqtest");
      let seenUrl: unknown;
      let seenInit: { headers?: Record<string, string>; body?: string } = {};
      const restore = mockFetch((url, init) => {
        seenUrl = url;
        seenInit = init as { headers?: Record<string, string>; body?: string };
        return groqCompletion(JSON.stringify(page));
      });
      try {
        const out = await vibecode(page, "make the bio funnier");
        assert.deepEqual(out, page);
        assert.equal(seenUrl, "https://api.groq.com/openai/v1/chat/completions");
        assert.equal(seenInit.headers?.["authorization"], "Bearer gsk-test");
        const body = JSON.parse(seenInit.body!);
        assert.equal(body.model, DEFAULT_GROQ_MODEL);
        assert.equal(body.response_format?.type, "json_object");
        assert.equal(body.messages?.[0]?.role, "system");
        assert.ok(
          typeof body.messages?.[0]?.content === "string" &&
            body.messages[0].content.includes("Voicescape page builder AI"),
        );
        assert.equal(body.messages?.[1]?.role, "user");
      } finally {
        restore();
      }
    });
  });

  it("honors GROQ_MODEL override", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test", GROQ_MODEL: "llama-test" },
      async () => {
        const page = createStarterPage("groqtest");
        let model: unknown;
        const restore = mockFetch((_url, init) => {
          model = JSON.parse((init.body as string) ?? "{}").model;
          return groqCompletion(JSON.stringify(page));
        });
        try {
          await vibecode(page, "hi");
          assert.equal(model, "llama-test");
        } finally {
          restore();
        }
      },
    );
  });

  it("fails closed with no AI keys (never silently)", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
      await assert.rejects(
        () => vibecode(createStarterPage("groqtest"), "hi"),
        (e: unknown) =>
          e instanceof VibecodeError && /GROQ_API_KEY/.test(e.message),
      );
    });
  });

  it("wraps Groq HTTP errors as VibecodeError", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, async () => {
      const restore = mockFetch(() => errJson(429));
      try {
        await assert.rejects(
          () => vibecode(createStarterPage("groqtest"), "hi"),
          (e: unknown) =>
            e instanceof VibecodeError && /Groq API error \(429\)/.test(e.message),
        );
      } finally {
        restore();
      }
    });
  });

  it("rejects non-JSON model output", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, async () => {
      const restore = mockFetch(() => groqCompletion("not json at all"));
      try {
        await assert.rejects(
          () => vibecode(createStarterPage("groqtest"), "hi"),
          /did not return valid JSON/,
        );
      } finally {
        restore();
      }
    });
  });

  it("uses Anthropic (not Groq) when both keys are set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "sk-test", GROQ_API_KEY: "gsk-test" }, async () => {
      const page = createStarterPage("groqtest");
      let seenUrl: unknown;
      let seenHeaders: Record<string, string> = {};
      const restore = mockFetch((url, init) => {
        seenUrl = url;
        seenHeaders = (init.headers ?? {}) as Record<string, string>;
        return okJson({
          content: [{ type: "text", text: JSON.stringify(page) }],
        });
      });
      try {
        await vibecode(page, "hi");
        assert.equal(seenUrl, "https://api.anthropic.com/v1/messages");
        assert.equal(seenHeaders["x-api-key"], "sk-test");
      } finally {
        restore();
      }
    });
  });
});

describe("reviewCopy() via Groq", () => {
  it("parses a valid review from the OpenAI-format response", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, async () => {
      const restore = mockFetch(() => groqCompletion(JSON.stringify(validReview())));
      try {
        const out = await reviewCopy(createStarterPage("groqtest"));
        assert.deepEqual(out, validReview());
      } finally {
        restore();
      }
    });
  });

  it("fails closed with no AI keys", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: undefined }, async () => {
      await assert.rejects(
        () => reviewCopy(createStarterPage("groqtest")),
        (e: unknown) =>
          e instanceof CopyReviewError && /ANTHROPIC_API_KEY/.test(e.message),
      );
    });
  });

  it("wraps Groq HTTP errors as CopyReviewError", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GROQ_API_KEY: "gsk-test" }, async () => {
      const restore = mockFetch(() => errJson(500));
      try {
        await assert.rejects(
          () => reviewCopy(createStarterPage("groqtest")),
          (e: unknown) =>
            e instanceof CopyReviewError && /Groq API error \(500\)/.test(e.message),
        );
      } finally {
        restore();
      }
    });
  });
});

afterEach(() => {
  for (const k of [...AI_KEYS, "GROQ_MODEL"]) {
    // never leak test keys into other files' env reads
    if (process.env[k] === "gsk-test" || process.env[k] === "sk-test" || process.env[k] === "llama-test") {
      delete process.env[k];
    }
  }
});
