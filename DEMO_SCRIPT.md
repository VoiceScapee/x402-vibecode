# Demo video script — Vibecode x402 (< 5 minutes)

**What you need:** this repo checked out, a terminal, a screen recorder on your
phone (or terminal recorder). No keys needed — the whole video uses `--dry-run`.
Target length: **~3:30**.

**Setup before recording** (do once, off-camera):
```bash
cd ~/workspace/x402-vibecode
npm install
```
Make your terminal font BIG (judges watch on small screens). Clear the terminal.

---

### Shot 1 — The hook (0:00–0:25)

**Show:** terminal, nothing running yet.
**Say (to camera or voiceover):**

> "What if an AI agent could buy API calls the same way you tap to pay — no API
> keys, no signup, just money? I built Vibecode x402 for ETHOnline: a
> pay-per-request AI API on Hedera testnet. Every request costs a fraction of a
> cent in HBAR, paid machine-to-machine using the x402 standard through the
> Blocky402 facilitator. Watch an agent do it live."

### Shot 2 — The project tour (0:25–1:00)

**Show:** run these, pausing on each:
```bash
ls -R src test | head -30
```
**Say:**

> "The server is Express plus the official x402 middleware. POST slash vibecode
> takes a Voicescape page and an instruction, and returns the AI-edited page.
> Payment is enforced by the 402 handshake — the middleware verifies and settles
> through Blocky402 *before* the expensive AI call ever runs. Every settled
> payment also gets logged to a Hedera Consensus Service topic as a public
> audit feed."

### Shot 3 — The agent handshake, live (1:00–3:00)

**Show:** run the dry-run demo:
```bash
npm run demo -- --dry-run
```
Let it scroll. **Say, over the output:**

> "Here's the buyer agent. Step one, it discovers the service and reads the
> price — five million tinybars, about a cent. Step two, it tries the endpoint
> with no payment and gets a 402 with the payment terms. Step three, it builds
> a real Hedera transfer transaction — signed only by the buyer, with
> Blocky402's fee-payer account attached. Step four, it retries with the
> payment signature… and there's the settle receipt with the transaction ID.
> Step five also shows the money split: the operator keeps 98% — 4.9 million
> tinybars — and the Voicescape treasury takes 2%, forwarded on-chain right
> after settlement. That's the platform's whole business model in one line.
> Step six: the AI-edited page JSON comes back. One request, one micropayment,
> zero API keys."

**Point out on screen:** the `402` line, the `pay 5000000 tinybars` line, the
`settled: true` receipt, the `split:` line (98/2), and the returned page JSON.

### Shot 4 — Tests (3:00–3:20)

**Show:**
```bash
npm test 2>&1 | tail -8
```
**Say:**

> "Twelve tests — twenty now, actually, with the new split-math suite — all
> passing, including a full end-to-end handshake against a mock facilitator,
> so the whole payment flow is verified without spending anything."

### Shot 5 — The close (3:20–3:40)

**Show:** terminal idle, or the README architecture diagram (`sed -n` a chunk).
**Say:**

> "Vibecode x402: real x402 v2 on Hedera testnet, HBAR-native micropayments,
> settle-before-compute so the seller never eats AI costs, and a public audit
> trail on Hedera Consensus Service. Code's in the repo — thanks for watching."

---

## If you want the *live* version on camera (optional, needs keys)

1. Fund two Hedera **testnet** accounts (seller + buyer) from the
   [testnet faucet](https://portal.hedera.com/faucet). Both keys must be
   **ECDSA** — ED25519 won't work.
2. `.env`: `SELLER_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, `BUYER_ACCOUNT_ID`,
   `BUYER_PRIVATE_KEY`.
3. Terminal 1: `npm run dev`. Terminal 2: `npm run demo`.
4. On camera, narrate the same beats — this time the settle receipt is a real
   testnet transaction you can look up on
   [HashScan testnet](https://hashscan.io/testnet).

## Don't forget

- Keep it under 5 minutes (aim 3:30).
- Big terminal font. Dark background reads best.
- Say "Hedera testnet" and "Blocky402" out loud — judges scan for track fit.
- Upload unlisted to YouTube and paste the link into the ETHGlobal submission.
