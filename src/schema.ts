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
  | { type: "music"; title?: string; tracks: MusicTrack[]; note?: string }
  | { type: "gallery"; images: string[] } // MVP: emoji/CSS placeholders, no external images
  | { type: "top8"; title?: string; friends: { name: string; avatarEmoji?: string; url?: string }[] }
  // ---- Phase B (agent + commerce) blocks ----
  | { type: "services"; items: { name: string; description: string; priceUsdCents: number; endpoint: string }[] }
  | { type: "capabilities"; items: string[] }
  | { type: "operator"; wallet: string; name?: string; url?: string }
  | { type: "reviews"; title?: string; entries: { name: string; message: string; date: string; txHash?: string }[] }
  | { type: "booking"; title?: string; items: { label: string; url: string; note?: string }[] };

export interface VoicescapePage {
  version: 1;
  username: string;
  /** Informational only — the on-chain registry record is the source of truth. */
  ownerType?: "human" | "agent";
  /** For agent pages: what the agent is for. Also stored on-chain. */
  purpose?: string;
  /** MySpace-style featured song. Services must ignore refs that don't resolve. */
  profileSong?: ProfileSongRef;
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
  "top8",
  "services",
  "capabilities",
  "operator",
  "reviews",
  "booking",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * Where a music track comes from. Platform embeds are the copyright-safe path
 * (the platform holds the licenses); "ipfs" is the page owner's own upload.
 */
export type MusicSource = "spotify" | "youtube" | "soundcloud" | "ipfs";

export interface MusicTrack {
  source: MusicSource;
  /** Embed ID (spotify/youtube/soundcloud) or IPFS CID ("ipfs"). */
  id: string;
  /** What the track is on its platform, e.g. spotify "track"|"album"|"playlist"|"episode", youtube "video"|"playlist". */
  kind?: string;
  /** The original pasted URL, kept for reference / "open in app" links. */
  url?: string;
  title?: string;
  artist?: string;
}

/**
 * MySpace-style profile song: a reference to one track on the page.
 * Indices are best-effort — consumers must ignore refs that don't resolve.
 */
export interface ProfileSongRef {
  /** Index into the page's blocks array of the music block. */
  blockIndex: number;
  /** Index into that block's tracks array. */
  trackIndex: number;
}

/** Structural check for a single music track. Pure and dependency-free. */
export function isValidMusicTrack(input: unknown): input is MusicTrack {
  if (typeof input !== "object" || input === null) return false;
  const t = input as Record<string, unknown>;
  if (t.source !== "spotify" && t.source !== "youtube" && t.source !== "soundcloud" && t.source !== "ipfs")
    return false;
  if (typeof t.id !== "string" || t.id.length === 0 || t.id.length > 512) return false;
  for (const k of ["kind", "url", "title", "artist"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") return false;
  }
  return true;
}

/** Structural check for a profile-song reference. Pure and dependency-free. */
export function isValidProfileSongRef(input: unknown): input is ProfileSongRef {
  if (typeof input !== "object" || input === null) return false;
  const r = input as Record<string, unknown>;
  return (
    Number.isInteger(r.blockIndex) &&
    (r.blockIndex as number) >= 0 &&
    Number.isInteger(r.trackIndex) &&
    (r.trackIndex as number) >= 0
  );
}

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
  // Optional page-level profile song must be structurally valid when present.
  if (p.profileSong !== undefined && !isValidProfileSongRef(p.profileSong)) return false;
  return p.blocks.every((b) => {
    if (typeof b !== "object" || b === null) return false;
    const type = (b as Record<string, unknown>).type;
    if (!(BLOCK_TYPES as readonly string[]).includes(type as string)) return false;
    // Music blocks: legacy {title, note} shapes without tracks stay valid;
    // when tracks are present each one must be structurally sound.
    if (type === "music") {
      const tracks = (b as Record<string, unknown>).tracks;
      if (tracks !== undefined && (!Array.isArray(tracks) || !tracks.every(isValidMusicTrack)))
        return false;
    }
    return true;
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
