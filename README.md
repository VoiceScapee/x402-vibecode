# Vibecode x402

Pay-per-request AI page-builder API using the **x402** standard on **Hedera testnet**.
Built for ETHOnline 2026 — Hedera's *x402 agentic payments* track.

`POST /vibecode` accepts `{ pageJson, instruction }` and returns the AI-edited
`{ pageJson }` (the Voicescape page-builder idea). Callers pay a tiny fixed HBAR
fee per request through the x402 402-handshake — **no API keys, no accounts**.
A buyer *agent* script demonstrates the full machine-to-machine flow.

## Architecture

```
 ┌────────────┐   1. POST /vibecode (no payment)    ┌──────────────────────┐
 │            │ ─────────────────────────────────▶ │                      │
 │  BUYER     │   2. 402 + PAYMENT-REQUIRED header  │   VIBECODE SERVER    │
 │  AGENT     │ ◀───────────────────────────────── │   (Express +        │
 │            │     {scheme:"exact", network:       │   @x402/express)     │
 │  - builds  │      "hedera:testnet", amount,     │                      │
 │    partial │      asset:"0.0.0", payTo,          │   3. verify+settle   │
 │    HBAR tx │      extra:{feePayer}}              │      via Blocky402   │
 │    (buyer  │                                    │      facilitator     │
 │    sig     │   4. POST + PAYMENT-SIGNATURE       │                      │
 │    only)   │ ─────────────────────────────────▶ │   4b. settle BEFORE  │
 │            │     base64(paymentPayload)          │       handler runs   │
 │  - retries │                                    │       ("upfront"     │
 │    with    │   5. 200 + PAYMENT-RESPONSE         │       flow — the AI  │
 │    @x402/  │ ◀───────────────────────────────── │       call is the    │
 │    fetch   │     { pageJson: <AI-edited> }       │       expensive part)│
 └────────────┘                                    └────────┬─────────────┘
                                                            │ 6. audit msg
                                                            ▼
                                                   ┌──────────────────────┐
                                                   │ Hedera Consensus     │
                                                   │ Service topic (one   │
                                                   │ msg per settled      │
                                                   │ payment) — readable  │
                                                   │ via mirror node REST │
                                                   └──────────────────────┘
```

Payment path detail: the buyer signs a Hedera `TransferTransaction`
(buyer → seller, HBAR) with **only its own signature**, frozen with Blocky402's
`feePayer` (`0.0.7162784`) as the transaction payer. The
[Blocky402](https://api.testnet.blocky402.com) testnet facilitator verifies the
payload, adds the fee-payer signature, and submits to Hedera testnet. The
server only runs the Anthropic call **after** on-chain settlement (x402
`paymentFlow: "upfront"` — in this flow the facilitator's settle *is* the
verification, so `/verify` isn't called separately).

## Quickstart

```bash
cd x402-vibecode
npm install
cp .env.example .env   # then fill in SELLER_ACCOUNT_ID + ANTHROPIC_API_KEY
```

### 1. Try it with zero keys — dry-run demo

```bash
npm run demo -- --dry-run
```

Spins up a **mock facilitator + mock resource server on localhost** (running the
*real* `@x402/express` middleware and the *real* `ExactHederaScheme`) and drives
the whole agent handshake: discovery → 402 → partially-signed HBAR tx (signed
locally with a throwaway ECDSA key) → `PAYMENT-SIGNATURE` retry → settle →
200 with page JSON. No keys, no network, no HBAR moved.

### 2. Run the real server (Hedera testnet)

```bash
npm run dev   # or: npm run build && npm start
```

Needs `SELLER_ACCOUNT_ID` (testnet account receiving payments) and
`ANTHROPIC_API_KEY`. The server syncs with the Blocky402 facilitator on boot.

### 3. Run the live buyer agent (spends real testnet HBAR)

In another terminal, with the server running:

```bash
# .env needs BUYER_ACCOUNT_ID + BUYER_PRIVATE_KEY (ECDSA/secp256k1 ONLY)
npm run demo
```

The agent: `GET /` (discovery) → unpaid `POST` (reads the 402) → builds the
HBAR transfer → pays via `@x402/fetch` → prints the settle receipt
(`PAYMENT-RESPONSE` header) and the AI-edited page JSON.

Cost per request: **5,000,000 tinybars = 0.05 HBAR** (~$0.01 at ~$0.20/HBAR;
see the math comment in `src/payment.ts`, override with `PRICE_TINYBARS`).

### 4. Tests

```bash
npm test        # node:test — 402 shapes, schema validation, full dry-run handshake
npm run typecheck
```

### 5. HCS audit feed (optional)

```bash
npm run audit:init   # needs AUDIT_OPERATOR_ID/KEY (testnet ECDSA account)
# put the printed topic id in .env as HCS_TOPIC_ID, restart the server
```

Every settled payment is then logged to the topic. Verify publicly:

```
https://testnet.mirrornode.hedera.com/api/v1/topics/<HCS_TOPIC_ID>/messages
```

Each message is JSON: `{ txId, payer, payTo, amountTinybars, asset, network,
endpoint, settledAt, facilitator, operatorShareTinybars, treasuryShareTinybars,
treasuryAccountId, treasuryForwardTxId }`. Audit writes are best-effort — they can
never fail a paid request.

### 6. Platform economics: the 98/2 split (optional)

Voicescape takes a 2% platform share on platform-mediated payments; the
service operator keeps 98%. The x402 "exact" scheme settles a single
buyer → operator transfer, so after settlement the server forwards the 2%
on-chain to the treasury (`src/treasury.ts`):

```bash
# in .env
TREASURY_ACCOUNT_ID=0.0.345678   # Voicescape treasury (receives the 2%)
SELLER_PRIVATE_KEY=<ECDSA key>    # operator key, forwards the 2% after each settlement
```

At the default price (5,000,000 tinybars): operator keeps 4,900,000,
treasury receives 100,000 — a second on-chain transfer you can verify on
HashScan. The split is computed with exact integer math (treasury share
rounds down; dust stays with the operator) and recorded in every audit
message. Like the audit feed, forwarding is best-effort and can never fail
a paid request. Unset `TREASURY_ACCOUNT_ID` to run without the split.

## API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /` | none | Service info: price, payTo, network, facilitator |
| `GET /health` | none | Liveness + config summary |
| `POST /vibecode` | x402 HBAR payment | `{ pageJson, instruction }` → `{ pageJson }` |

`pageJson` must match the Voicescape page schema (`src/schema.ts`, copied from
the Voicescape repo so this project is standalone); invalid bodies get 400.
The model is constrained by a system prompt to output only valid page JSON,
and the result is re-validated before returning.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `SELLER_ACCOUNT_ID` | yes (server) | Testnet account receiving payments |
| `ANTHROPIC_API_KEY` | yes (server, for AI) | Anthropic API key |
| `ANTHROPIC_MODEL` | no | Override (default `claude-sonnet-4-5-20250929`) |
| `BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` | yes (live demo) | Buyer testnet account + **ECDSA** key |
| `PORT` | no | Server port (default 3000) |
| `PUBLIC_URL` | no | Public base URL, used as the x402 resource URL |
| `PRICE_TINYBARS` | no | Price per request (default `5000000`) |
| `VIBECODE_URL` | no | Server URL for the buyer demo |
| `HCS_TOPIC_ID` | no | Audit topic (see above) |
| `AUDIT_OPERATOR_ID` / `AUDIT_OPERATOR_KEY` | no | Credentials that submit audit messages |
| `TREASURY_ACCOUNT_ID` | no | Voicescape treasury; enables the on-chain 98/2 split (see §6) |
| `SELLER_PRIVATE_KEY` | no (yes with treasury) | Operator ECDSA key; forwards the 2% treasury share after settlement |

## Bounty-track fit

Hedera's ETHOnline x402 track asks for agentic payments via **Blocky402** —
this project is exactly that, end to end:

- **Real x402 v2** (`@x402/*@2.25.0`): 402 handshake, `PAYMENT-REQUIRED` /
  `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers, Blocky402 testnet
  facilitator with its `feePayer` (`0.0.7162784`).
- **HBAR-native** (`asset: "0.0.0"`, tinybars) — no token-association footguns.
- **Agentic buyer**: the demo script is an autonomous agent loop
  (discover → read 402 → construct payment → retry → consume), no human in the
  loop, no API keys.
- **Real economic primitive**: pay-per-inference for an AI service, with
  settle-before-compute so the seller never eats LLM costs unpaid — plus the
  Voicescape **98/2 platform split** forwarded on-chain after every settlement
  (operator keeps 98%, treasury takes 2%).
- **Public auditability**: every settled payment lands on an HCS topic,
  verifiable through the free mirror node — including both sides of the
  98/2 split and the treasury forward tx id.

## Notes & limitations

- **Testnet only.** No mainnet code paths exist.
- The Anthropic call and the live Blocky402 round-trip can't be verified
  without keys — the dry-run/mock paths cover everything else (`npm test`).
- `upfront` flow: payment settles before the AI runs. If the AI then errors,
  the buyer gets a clear 502 (the payment is not refunded) — documented
  trade-off of pay-per-compute.
- Buyer keys must be **ECDSA (secp256k1)**; the x402 Hedera tooling rejects
  ED25519. The buyer agent whitelists HBAR via spend controls with a 1 HBAR
  per-payment cap.
- Server also checks the payment payload's `resource.url` against the called
  endpoint (replay hygiene).
