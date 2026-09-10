/** Schema validation unit tests. No keys needed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStarterPage, isValidPage } from "../src/schema.js";

describe("isValidPage", () => {
  it("accepts a well-formed page", () => {
    assert.equal(isValidPage(createStarterPage("agent")), true);
  });

  it("rejects non-objects and wrong versions", () => {
    assert.equal(isValidPage(null), false);
    assert.equal(isValidPage("nope"), false);
    assert.equal(isValidPage({ ...createStarterPage("a"), version: 2 }), false);
  });

  it("rejects pages with a missing theme field", () => {
    const p = createStarterPage("a") as unknown as Record<string, unknown>;
    const theme = { ...(p.theme as Record<string, unknown>) };
    delete theme.accent;
    assert.equal(isValidPage({ ...p, theme }), false);
  });

  it("rejects unknown block types", () => {
    const p = createStarterPage("a");
    assert.equal(
      isValidPage({ ...p, blocks: [{ type: "evil" }] }),
      false,
    );
  });

  it("rejects non-array blocks", () => {
    const p = createStarterPage("a");
    assert.equal(isValidPage({ ...p, blocks: "nope" }), false);
  });
});
