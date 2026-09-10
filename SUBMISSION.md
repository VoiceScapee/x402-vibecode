# ETHGlobal ETHOnline 2026 — Submission checklist

**Project:** Vibecode x402
**Track:** Hedera — x402 agentic payments ($6K pool)
**Deadline:** September 16, 2026

## Submission fields

- **Track:** Hedera x402 agentic payments
- **Repo:** <PASTE PUBLIC GITHUB URL HERE> (must be public)
- **Demo video:** <PASTE YOUTUBE/LOOM LINK HERE> (must be < 5 minutes;
  follow `DEMO_SCRIPT.md` — the `--dry-run` path needs no keys)
- **Project description (draft):**

> Vibecode x402 is a pay-per-request AI API on Hedera testnet using the x402
> standard. POST /vibecode takes a Voicescape page plus an instruction and
> returns the AI-edited page — each call paid with a tiny HBAR micropayment
> through the 402 handshake, no API keys or accounts. Payments settle via the
> Blocky402 testnet facilitator *before* the AI runs, so the seller never eats
> compute costs unpaid, and every settled payment is logged to a public Hedera
> Consensus Service topic verifiable via the mirror node. A buyer-agent demo
> script shows the full autonomous loop: discover → read 402 → build
> partially-signed transfer → pay → consume.

## Requirements checklist

- [ ] **Public repo** — push `x402-vibecode/` to GitHub, public visibility.
  Double-check no `.env` file is committed (only `.env.example`).
- [ ] **Demo video < 5 min** — record per `DEMO_SCRIPT.md`, upload
  (YouTube unlisted is fine), paste link into the submission form.
- [ ] **Deployed on / using testnet** — the project targets Hedera **testnet**
  only (`hedera:testnet`, no mainnet code paths). The video demo uses the
  `--dry-run` mock stack; the live path uses testnet HBAR via Blocky402.
- [ ] **Uses the Blocky402 facilitator** — server points at
      `https://api.testnet.blocky402.com` with `feePayer 0.0.7162784`
      (see `src/payment.ts`); do NOT list x402.org's facilitator.
- [ ] **Project description + track fit** — the README's "Bounty-track fit"
      section covers why this matches the Hedera x402 agentic-payments track.
- [ ] **Submitted before Sept 16, 2026** on the ETHGlobal ETHOnline 2026 page.

### Feature notes for the submission form

- **98/2 platform split, on-chain**: after every x402 settlement the server
  forwards 2% of the price to the Voicescape treasury (`src/treasury.ts`).
  Exact integer math (treasury share rounds down), best-effort so it can never
  fail a paid request, and every split is recorded in the HCS audit feed.
  Verified by the `test/treasury.test.ts` suite (8 tests) and exercised in the
  `--dry-run` demo.

## Before you hit submit

1. `npx tsc --noEmit` clean, `npm test` 20/20 passing.
2. `git status` shows no `.env`, no keys, no `node_modules`.
3. README renders (architecture diagram intact).
4. Video link opens without login (unlisted, not private).
