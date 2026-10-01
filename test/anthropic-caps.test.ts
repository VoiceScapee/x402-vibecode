/**
 * Prompt-compression helper tests — pure, no network, no keys.
 *
 * Covers the input-budget caps (assertVibecodeInputBounds) and the dynamic
 * output cap (vibecodeMaxTokens) from src/anthropic.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_INSTRUCTION_CHARS,
  MAX_PAGE_JSON_CHARS,
  assertVibecodeInputBounds,
  vibecodeMaxTokens,
  VibecodeError,
} from "../src/anthropic.js";

describe("vibecodeMaxTokens (dynamic output cap)", () => {
  it("floors at 1024 for a tiny page", () => {
    // 100 chars ≈ 25 tokens → 25×2+256 = 306 → clamped to 1024.
    assert.equal(vibecodeMaxTokens({ version: 1, username: "x" }), 1024);
  });

  it("scales with page size in the middle", () => {
    // 4000 chars ≈ 1000 tokens → 1000×2+256 = 2256.
    const page = { version: 1, username: "x", pad: "y".repeat(3960) };
    assert.equal(vibecodeMaxTokens(page), 2256);
  });

  it("caps at 4096 for a huge page", () => {
    const page = { version: 1, username: "x", pad: "y".repeat(30000) };
    assert.equal(vibecodeMaxTokens(page), 4096);
  });
});

describe("assertVibecodeInputBounds (input budget caps)", () => {
  it("passes for normal inputs", () => {
    assert.doesNotThrow(() =>
      assertVibecodeInputBounds({ version: 1 }, "make it blue"),
    );
  });

  it("rejects an oversized pageJson with VibecodeError", () => {
    const big = { version: 1, pad: "y".repeat(MAX_PAGE_JSON_CHARS) };
    assert.throws(
      () => assertVibecodeInputBounds(big, "make it blue"),
      (e: unknown) => e instanceof VibecodeError && /too large/.test(String((e as Error).message)),
    );
  });

  it("rejects an oversized instruction with VibecodeError", () => {
    assert.throws(
      () =>
        assertVibecodeInputBounds({ version: 1 }, "z".repeat(MAX_INSTRUCTION_CHARS + 1)),
      (e: unknown) => e instanceof VibecodeError && /too long/.test(String((e as Error).message)),
    );
  });

  it("honors a custom error factory (copy-review keeps its error contract)", () => {
    class CustomError extends Error {}
    const big = { version: 1, pad: "y".repeat(MAX_PAGE_JSON_CHARS) };
    assert.throws(
      () => assertVibecodeInputBounds(big, "x", (m) => new CustomError(m)),
      (e: unknown) => e instanceof CustomError,
    );
  });
});
