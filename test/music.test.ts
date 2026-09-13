/**
 * Music block tests. No keys, no network — the upload path is mocked.
 *
 * The URL-parsing implementation is canonical in
 * voicescape/frontend/lib/music.ts (single source of truth; the stale-schema
 * bug taught us not to duplicate). These tests import it cross-project.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// NOTE: the frontend package is CommonJS-typed (no "type": "module"), so
// tsx loads its .ts files as CJS — named ESM imports fail at link time.
// Default-import interop gives us module.exports, which is the same object.
// The implementation stays canonical in frontend/lib (single source of
// truth); only the import shape differs.
import musicLib from "../../voicescape/frontend/lib/music.js";
import ipfsLib from "../../voicescape/frontend/lib/ipfs.js";
import {
  createStarterPage,
  isValidMusicTrack,
  isValidPage,
  isValidProfileSongRef,
} from "../src/schema.js";

const {
  MUSIC_SOURCE_LABELS,
  parseMusicUrl,
  trackEmbedHeight,
  trackEmbedUrl,
  trackOpenUrl,
} = musicLib as typeof import("../../voicescape/frontend/lib/music.js");
const { audioGatewayUrl, pinAudioFile } =
  ipfsLib as typeof import("../../voicescape/frontend/lib/ipfs.js");

describe("parseMusicUrl — Spotify", () => {
  it("parses a track link", () => {
    const t = parseMusicUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ");
    assert.deepEqual(t, {
      source: "spotify",
      kind: "track",
      id: "4uLU6hMCjMI75M1A2tKUQ",
      url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ",
    });
  });

  it("parses album / playlist / episode links and strips query params", () => {
    assert.equal(parseMusicUrl("https://open.spotify.com/album/1A2B3C?si=xyz")?.kind, "album");
    assert.equal(parseMusicUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")?.kind, "playlist");
    assert.equal(parseMusicUrl("https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ")?.kind, "episode");
    assert.equal(parseMusicUrl("https://open.spotify.com/track/abc123?si=noise")?.id, "abc123");
  });

  it("parses spotify: URIs", () => {
    const t = parseMusicUrl("spotify:track:4uLU6hMCjMI75M1A2tKUQ");
    assert.equal(t?.source, "spotify");
    assert.equal(t?.kind, "track");
    assert.equal(t?.id, "4uLU6hMCjMI75M1A2tKUQ");
  });

  it("rejects unknown spotify kinds", () => {
    assert.equal(parseMusicUrl("https://open.spotify.com/user/someone"), null);
  });
});

describe("parseMusicUrl — YouTube", () => {
  it("parses watch, youtu.be, embed, shorts, and music.youtube.com links", () => {
    const cases: Array<[string, string]> = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ];
    for (const [url, id] of cases) {
      const t = parseMusicUrl(url);
      assert.equal(t?.source, "youtube", url);
      assert.equal(t?.kind, "video", url);
      assert.equal(t?.id, id, url);
    }
  });

  it("parses playlist links", () => {
    const t = parseMusicUrl("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGS");
    assert.equal(t?.source, "youtube");
    assert.equal(t?.kind, "playlist");
    assert.equal(t?.id, "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGS");
  });

  it("rejects bare youtube homepages", () => {
    assert.equal(parseMusicUrl("https://www.youtube.com/"), null);
  });
});

describe("parseMusicUrl — SoundCloud", () => {
  it("parses artist/track links", () => {
    const t = parseMusicUrl("https://soundcloud.com/peggy-gou/star-nana");
    assert.deepEqual(t, {
      source: "soundcloud",
      kind: "track",
      id: "peggy-gou/star-nana",
      url: "https://soundcloud.com/peggy-gou/star-nana",
    });
  });

  it("detects sets as playlists", () => {
    const t = parseMusicUrl("https://soundcloud.com/peggy-gou/sets/dj-kicks");
    assert.equal(t?.kind, "playlist");
  });

  it("rejects unresolvable short links and bare profiles", () => {
    assert.equal(parseMusicUrl("https://on.soundcloud.com/abcXYZ"), null);
    assert.equal(parseMusicUrl("https://soundcloud.com/peggy-gou"), null);
  });
});

describe("parseMusicUrl — rejects junk", () => {
  it("returns null for non-music URLs and garbage", () => {
    for (const junk of ["", "   ", "not a url", "https://example.com", "ftp://x/y"]) {
      assert.equal(parseMusicUrl(junk), null, JSON.stringify(junk));
    }
  });
});

describe("trackEmbedUrl / trackOpenUrl / trackEmbedHeight", () => {
  it("builds platform embeds", () => {
    assert.equal(
      trackEmbedUrl({ source: "spotify", kind: "track", id: "abc" }),
      "https://open.spotify.com/embed/track/abc?utm_source=generator",
    );
    assert.equal(
      trackEmbedUrl({ source: "spotify", kind: "album", id: "abc" }),
      "https://open.spotify.com/embed/album/abc?utm_source=generator",
    );
    assert.equal(
      trackEmbedUrl({ source: "youtube", kind: "video", id: "xyz" }),
      "https://www.youtube.com/embed/xyz?rel=0",
    );
    assert.equal(
      trackEmbedUrl({ source: "youtube", kind: "playlist", id: "PL1" }),
      "https://www.youtube.com/embed/videoseries?list=PL1",
    );
    const sc = trackEmbedUrl({ source: "soundcloud", id: "a/b" });
    assert.ok(sc?.startsWith("https://w.soundcloud.com/player/?url="));
    assert.ok(sc?.includes(encodeURIComponent("https://soundcloud.com/a/b")));
    assert.ok(sc?.includes("auto_play=false"));
  });

  it("returns null embed for ipfs tracks (native audio instead)", () => {
    assert.equal(trackEmbedUrl({ source: "ipfs", id: "QmX" }), null);
  });

  it("prefers the original URL for open-in-app, else reconstructs", () => {
    assert.equal(
      trackOpenUrl({ source: "spotify", id: "a", url: "https://open.spotify.com/track/a?si=z" }),
      "https://open.spotify.com/track/a?si=z",
    );
    assert.equal(
      trackOpenUrl({ source: "youtube", kind: "video", id: "xyz" }),
      "https://youtu.be/xyz",
    );
    assert.equal(trackOpenUrl({ source: "ipfs", id: "QmX" }), null);
  });

  it("suggests embed heights per platform", () => {
    assert.equal(trackEmbedHeight({ source: "spotify", kind: "track", id: "a" }), 152);
    assert.equal(trackEmbedHeight({ source: "spotify", kind: "album", id: "a" }), 352);
    assert.equal(trackEmbedHeight({ source: "spotify", kind: "playlist", id: "a" }), 352);
    assert.equal(trackEmbedHeight({ source: "soundcloud", id: "a/b" }), 166);
    assert.equal(trackEmbedHeight({ source: "youtube", kind: "video", id: "x" }), 0);
  });

  it("labels every source", () => {
    assert.deepEqual(Object.keys(MUSIC_SOURCE_LABELS).sort(), [
      "ipfs",
      "soundcloud",
      "spotify",
      "youtube",
    ]);
  });
});

describe("music schema validation", () => {
  const goodTrack = {
    source: "spotify",
    kind: "track",
    id: "4uLU6hMCjMI75M1A2tKUQ",
    url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ",
    title: "Star",
    artist: "Someone",
  };

  it("accepts well-formed tracks", () => {
    assert.equal(isValidMusicTrack(goodTrack), true);
    assert.equal(isValidMusicTrack({ source: "ipfs", id: "QmX" }), true);
  });

  it("rejects malformed tracks", () => {
    assert.equal(isValidMusicTrack({ source: "bandcamp", id: "x" }), false);
    assert.equal(isValidMusicTrack({ source: "spotify", id: "" }), false);
    assert.equal(isValidMusicTrack({ source: "spotify" }), false);
    assert.equal(isValidMusicTrack({ source: "youtube", id: "x", title: 42 }), false);
    assert.equal(isValidMusicTrack(null), false);
  });

  it("accepts profile-song refs and rejects bad ones", () => {
    assert.equal(isValidProfileSongRef({ blockIndex: 2, trackIndex: 0 }), true);
    assert.equal(isValidProfileSongRef({ blockIndex: -1, trackIndex: 0 }), false);
    assert.equal(isValidProfileSongRef({ blockIndex: "2", trackIndex: 0 }), false);
    assert.equal(isValidProfileSongRef(null), false);
  });

  function pageWithMusic(musicBlock: unknown, profileSong?: unknown) {
    const p = createStarterPage("dj") as unknown as Record<string, unknown>;
    return { ...p, blocks: [...(p.blocks as unknown[]), musicBlock], ...(profileSong !== undefined ? { profileSong } : {}) };
  }

  it("accepts a page with real music tracks and a profile song", () => {
    const page = pageWithMusic(
      { type: "music", title: "My music", tracks: [goodTrack, { source: "ipfs", id: "QmY" }] },
      { blockIndex: 4, trackIndex: 1 },
    );
    assert.equal(isValidPage(page), true);
  });

  it("still accepts legacy music blocks without tracks", () => {
    assert.equal(
      isValidPage(pageWithMusic({ type: "music", title: "Old", note: "🎧" })),
      true,
    );
  });

  it("rejects music blocks with malformed tracks", () => {
    assert.equal(
      isValidPage(pageWithMusic({ type: "music", tracks: [{ source: "napster", id: "x" }] })),
      false,
    );
    assert.equal(
      isValidPage(pageWithMusic({ type: "music", tracks: "nope" })),
      false,
    );
  });

  it("rejects malformed page-level profile songs", () => {
    assert.equal(
      isValidPage(pageWithMusic({ type: "music", tracks: [] }, { blockIndex: -1, trackIndex: 0 })),
      false,
    );
  });
});

describe("pinAudioFile (mocked /api/pin)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(handler: (url: unknown, init: unknown) => unknown) {
    globalThis.fetch = (async (url: unknown, init: unknown) => handler(url, init)) as typeof fetch;
  }

  it("posts multipart audio and returns the CID", async () => {
    let seenUrl: unknown;
    let seenBody: unknown;
    mockFetch((url, init) => {
      seenUrl = url;
      seenBody = (init as { body?: unknown }).body;
      return {
        ok: true,
        json: async () => ({ cid: "QmAudio123", provider: "pinata" }),
      };
    });
    const file = new Blob(["fake-mp3-bytes"], { type: "audio/mpeg" });
    const cid = await pinAudioFile(file, "mysong.mp3");
    assert.equal(cid, "QmAudio123");
    assert.equal(seenUrl, "/api/pin");
    assert.ok(seenBody instanceof FormData);
    assert.equal((seenBody as FormData).get("file") instanceof Blob, true);
  });

  it("rejects non-audio files client-side", async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return { ok: true, json: async () => ({ cid: "QmX" }) };
    });
    await assert.rejects(
      pinAudioFile(new Blob(["x"], { type: "text/plain" }), "note.txt"),
      /Not an audio file/,
    );
    assert.equal(called, false);
  });

  it("rejects oversized files client-side", async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return { ok: true, json: async () => ({ cid: "QmX" }) };
    });
    const big = new Blob(["x"], { type: "audio/mpeg" });
    Object.defineProperty(big, "size", { value: 30 * 1024 * 1024 });
    await assert.rejects(pinAudioFile(big, "big.mp3"), /too large/);
    assert.equal(called, false);
  });

  it("surfaces server errors", async () => {
    mockFetch(() => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "Pinata exploded" }),
    }));
    await assert.rejects(
      pinAudioFile(new Blob(["x"], { type: "audio/mpeg" }), "a.mp3"),
      /Pinata exploded/,
    );
  });

  it("builds gateway URLs for audio CIDs", () => {
    assert.ok(audioGatewayUrl("QmAudio123").endsWith("/QmAudio123"));
  });
});
