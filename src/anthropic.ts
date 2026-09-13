/**
 * Anthropic-backed "vibecode" engine.
 *
 * Reuses the Voicescape system prompt (copied from
 * voicescape/frontend/app/api/vibecode/route.ts) that constrains the model
 * to output ONLY valid page JSON, then validates the result against the
 * schema before returning it.
 */

import { isValidPage, VoicescapePage } from "./schema.js";

const VIBECODE_SYSTEM_PROMPT = `You are the Voicescape page builder AI. The user describes changes to their personal page, and you return the FULL updated page as JSON.

You must output ONLY a single JSON object. No markdown, no code fences, no explanation, no commentary.

The JSON must match this schema exactly:
{
  "version": 1,
  "username": "string (lowercase letters, numbers, hyphens; never change the username unless the user explicitly asks)",
  "theme": {
    "background": "CSS color string",
    "foreground": "CSS color string",
    "accent": "CSS color string",
    "fontFamily": "CSS font-family string"
  },
  "blocks": [
    { "type": "hero", "title": "string", "subtitle": "string (optional)", "avatarEmoji": "single emoji (optional)" },
    { "type": "bio", "text": "string", "note": "string (optional)" },
    { "type": "links", "items": [ { "label": "string", "url": "string" } ] },
    { "type": "tipJar", "message": "string (optional)" },
    { "type": "guestbook", "entries": [ { "name": "string", "message": "string", "date": "YYYY-MM-DD string" } ] },
    { "type": "music", "title": "string (optional)", "tracks": [ { "source": "spotify|youtube|soundcloud|ipfs", "id": "embed ID or IPFS CID", "kind": "track|album|playlist|episode|video (optional)", "url": "original URL (optional)", "title": "string (optional)", "artist": "string (optional)" } ], "note": "string (optional, legacy)" },
    { "type": "gallery", "images": ["emoji strings as placeholders"] }
  ]
}

Rules:
- "version" must be 1. "type" must be one of: hero, bio, links, tipJar, guestbook, music, gallery.
- Apply ONLY the change the user asked for; preserve everything else from the current page JSON.
- For "gallery" blocks use emoji placeholders only — never real URLs or embeds.
- "music" blocks use real tracks: "source" is one of spotify|youtube|soundcloud|ipfs, "id" is the platform embed ID (or IPFS CID for the owner's own upload). Never invent track IDs — only use links the user provided.
- Never invent usernames, real people, or external URLs beyond what the user provided.
- Keep text concise and in the spirit of the request.`;

export { VIBECODE_SYSTEM_PROMPT };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export class VibecodeError extends Error {}

/**
 * Apply `instruction` to `pageJson` via the Anthropic API.
 * Throws VibecodeError with a human-readable message on any failure.
 */
export async function vibecode(
  pageJson: unknown,
  instruction: string,
): Promise<VoicescapePage> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new VibecodeError(
      "ANTHROPIC_API_KEY is not set. Add it to the environment to enable the vibecode AI.",
    );
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const userContent =
    `Current page JSON:\n${JSON.stringify(pageJson)}\n\n` +
    `Requested change:\n${instruction}\n\n` +
    `Return the full updated page JSON only.`;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: VIBECODE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (e) {
    throw new VibecodeError(
      `Failed to reach Anthropic API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VibecodeError(
      `Anthropic API error (${res.status}): ${text.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as {
    content?: { type?: string; text?: string }[];
  };
  const textBlock = data.content?.find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  const raw = (textBlock?.text ?? "").trim();
  if (!raw) throw new VibecodeError("Anthropic returned no text content.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VibecodeError(
      "Model did not return valid JSON. Try rephrasing your instruction.",
    );
  }

  if (!isValidPage(parsed)) {
    throw new VibecodeError(
      "Model returned JSON that does not match the page schema. Try rephrasing your instruction.",
    );
  }

  return parsed;
}
