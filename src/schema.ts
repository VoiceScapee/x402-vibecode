/**
 * Voicescape page schema — copied verbatim from
 * voicescape/frontend/lib/schema.ts so this project stays standalone.
 *
 * Keep in sync with the Voicescape repo if the schema evolves.
 */

export type Block =
  | { type: "hero"; title: string; subtitle?: string; avatarEmoji?: string }
  | { type: "bio"; text: string }
  | { type: "links"; items: { label: string; url: string }[] }
  | { type: "tipJar"; message?: string }
  | { type: "guestbook"; entries: { name: string; message: string; date: string }[] }
  | { type: "music"; title?: string; note?: string } // MVP: no real embeds, styled placeholder only
  | { type: "gallery"; images: string[] }; // MVP: emoji/CSS placeholders, no external images

export interface VoicescapePage {
  version: 1;
  username: string;
  theme: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  };
  blocks: Block[];
}

export const BLOCK_TYPES = [
  "hero",
  "bio",
  "links",
  "tipJar",
  "guestbook",
  "music",
  "gallery",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** Lightweight runtime validation so the API can reject junk. */
export function isValidPage(input: unknown): input is VoicescapePage {
  if (typeof input !== "object" || input === null) return false;
  const p = input as Record<string, unknown>;
  if (p.version !== 1) return false;
  if (typeof p.username !== "string") return false;
  if (typeof p.theme !== "object" || p.theme === null) return false;
  const t = p.theme as Record<string, unknown>;
  for (const k of ["background", "foreground", "accent", "fontFamily"]) {
    if (typeof t[k] !== "string") return false;
  }
  if (!Array.isArray(p.blocks)) return false;
  return p.blocks.every((b) => {
    if (typeof b !== "object" || b === null) return false;
    const type = (b as Record<string, unknown>).type;
    return (BLOCK_TYPES as readonly string[]).includes(type as string);
  });
}

/** A minimal starter page used by the demo as the "current page". */
export function createStarterPage(username: string): VoicescapePage {
  return {
    version: 1,
    username,
    theme: {
      background: "#0f0c29",
      foreground: "#f5f3ff",
      accent: "#8b5cf6",
      fontFamily: "system-ui, sans-serif",
    },
    blocks: [
      { type: "hero", title: username, subtitle: "My corner of the internet", avatarEmoji: "👋" },
      { type: "bio", text: "A short bio about you." },
      { type: "links", items: [{ label: "My link", url: "https://example.com" }] },
      { type: "tipJar", message: "Support my work with a tip!" },
    ],
  };
}
