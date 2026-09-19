/**
 * AI-backed "vibecode" engine (Anthropic or Groq — see aiBackend()).
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

// ---------------------------------------------------------------------------
// Groq backend ($0 free tier, OpenAI-compatible chat-completions API).
// Same system prompts and schema validation as the Anthropic path — only the
// HTTP envelope differs. Anthropic takes precedence when both keys are set.
// ---------------------------------------------------------------------------

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

export type AiBackend = "anthropic" | "groq";

/** Which AI backend is configured, or null when none is. Anthropic wins ties. */
export function aiBackend(): AiBackend | null {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GROQ_API_KEY) return "groq";
  return null;
}

interface ChatCall {
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
}

/** Raw text completion via the Anthropic Messages API. */
async function callAnthropic(call: ChatCall): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY as string;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

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
        max_tokens: call.maxTokens,
        system: call.systemPrompt,
        messages: [{ role: "user", content: call.userContent }],
      }),
    });
  } catch (e) {
    throw new Error(
      `Failed to reach Anthropic API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
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
  if (!raw) throw new Error("Anthropic returned no text content.");
  return raw;
}

/** Raw text completion via Groq's OpenAI-compatible chat-completions API. */
async function callGroq(call: ChatCall): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY as string;
  const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;

  let res: Response;
  try {
    res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: call.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: call.systemPrompt },
          { role: "user", content: call.userContent },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      `Failed to reach Groq API: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!raw) throw new Error("Groq returned no text content.");
  return raw;
}

/**
 * Run the chat completion against whichever AI backend is configured,
 * failing closed when none is. Provider errors are re-wrapped in the
 * caller's typed error so handlers keep their error contracts.
 */
async function runChat<TErr extends Error>(
  call: ChatCall,
  makeError: (message: string) => TErr,
): Promise<string> {
  const backend = aiBackend();
  if (!backend) {
    throw makeError(
      "No AI backend configured — set ANTHROPIC_API_KEY or GROQ_API_KEY.",
    );
  }
  try {
    return backend === "anthropic"
      ? await callAnthropic(call)
      : await callGroq(call);
  } catch (e) {
    throw makeError(e instanceof Error ? e.message : String(e));
  }
}

export class VibecodeError extends Error {}

/**
 * Structured blockpage copy review returned by reviewCopy().
 *
 * HONEST FRAMING: this is an AI-generated critique, not a human editor's
 * judgment. Scores are calibrated to be useful, not flattering — most
 * real pages land 4-7.
 */
export interface CopyReview {
  /** 2-3 sentence overall take. */
  summary: string;
  /** 1-10, calibrated: 5 = average, 8+ = genuinely strong. */
  score: number;
  /** What's already working. */
  strengths: string[];
  /** Actionable fixes, each naming the block it applies to. */
  suggestions: Array<{ block: string; issue: string; fix: string }>;
  /** A tighter draft of the bio block, when the page has one worth rewriting. */
  rewrittenBio?: string;
}

/** Structural check for a CopyReview. Pure and dependency-free. */
export function isValidCopyReview(input: unknown): input is CopyReview {
  if (typeof input !== "object" || input === null) return false;
  const r = input as Record<string, unknown>;
  if (typeof r.summary !== "string" || r.summary.length === 0) return false;
  if (typeof r.score !== "number" || !Number.isInteger(r.score) || r.score < 1 || r.score > 10)
    return false;
  if (
    !Array.isArray(r.strengths) ||
    !r.strengths.every((s) => typeof s === "string" && s.length > 0)
  )
    return false;
  if (
    !Array.isArray(r.suggestions) ||
    !r.suggestions.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>).block === "string" &&
        typeof (s as Record<string, unknown>).issue === "string" &&
        typeof (s as Record<string, unknown>).fix === "string",
    )
  )
    return false;
  if (r.rewrittenBio !== undefined && typeof r.rewrittenBio !== "string") return false;
  return true;
}

const COPY_REVIEW_SYSTEM_PROMPT = `You are Danny, the Voicescape liaison agent, reviewing a user's blockpage copy. Be genuinely useful: specific, honest, and kind. You are an AI reviewer — say so in the summary if relevant, never pretend to be human.

You must output ONLY a single JSON object. No markdown, no code fences, no explanation, no commentary.

The JSON must match this shape exactly:
{
  "summary": "2-3 sentence overall take on the page's copy",
  "score": "integer 1-10. Calibrate honestly: 5 = average, 8+ = genuinely strong. Most pages land 4-7.",
  "strengths": ["what's already working (be specific, quote short phrases)"],
  "suggestions": [
    { "block": "the block type this applies to, e.g. hero, bio, links, music",
      "issue": "what's weak, in one sentence",
      "fix": "the concrete rewrite or action, in one or two sentences" }
  ],
  "rewrittenBio": "optional: a tighter draft of the bio block, max 3 sentences. Omit if the page has no bio."
}

Rules:
- Score honestly — a page of placeholder text is a 2-3, not a 7.
- Every suggestion must name a real block from the page and give a concrete fix, not generic advice ("add more personality" is not a fix; "open with what you build, not what you are" is).
- Never invent usernames, real people, or URLs beyond what the page contains.
- Keep the whole review tight: summary + strengths + at most 5 suggestions.`;

export class CopyReviewError extends Error {}

/**
 * Review a blockpage's copy via the configured AI backend. The page is validated
 * by the caller (the x402 handler); this validates the MODEL's output
 * against the review shape before returning it.
 *
 * Token budget is deliberately smaller than vibecode's (2048 vs 4096 max
 * output): a critique is cheaper than a full page rewrite, so the global
 * startup price floor (computed on the larger budget) is conservative for
 * this endpoint — it can never lose money at a price vibecode accepts.
 */
export async function reviewCopy(
  pageJson: unknown,
  focus?: string,
): Promise<CopyReview> {
  const userContent =
    `Blockpage JSON to review:\n${JSON.stringify(pageJson)}\n\n` +
    (focus && focus.trim() ? `Reviewer focus requested: ${focus.trim()}\n\n` : "") +
    `Return the copy review JSON only.`;

  const raw = await runChat(
    { systemPrompt: COPY_REVIEW_SYSTEM_PROMPT, userContent, maxTokens: 2048 },
    (m) => new CopyReviewError(m),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CopyReviewError(
      "Model did not return valid JSON for the review.",
    );
  }

  if (!isValidCopyReview(parsed)) {
    throw new CopyReviewError(
      "Model returned JSON that does not match the review schema.",
    );
  }

  return parsed;
}

/**
 * Apply `instruction` to `pageJson` via the configured AI backend.
 * Throws VibecodeError with a human-readable message on any failure.
 */
export async function vibecode(
  pageJson: unknown,
  instruction: string,
): Promise<VoicescapePage> {
  const userContent =
    `Current page JSON:\n${JSON.stringify(pageJson)}\n\n` +
    `Requested change:\n${instruction}\n\n` +
    `Return the full updated page JSON only.`;

  const raw = await runChat(
    { systemPrompt: VIBECODE_SYSTEM_PROMPT, userContent, maxTokens: 4096 },
    (m) => new VibecodeError(m),
  );

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
