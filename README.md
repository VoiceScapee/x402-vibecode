# Vibecode x402

Pay-per-request AI page-builder API using the **x402** standard on **Hedera**.
Built for ETHOnline 2026 — Hedera's *x402 agentic payments* track.

`POST /vibecode` accepts `{ pageJson, instruction }` and returns the AI-edited
`{ pageJson }` (the Voicescape page-builder idea). Callers pay a tiny fixed fee
per request through the x402 402-handshake — **no API keys, no accounts** —
on either of two rails: native **HBAR** or **USDC**. Prices are quoted in USD
terms so both rails charge the same dollar price; the buyer picks its rail.
A buyer *agent* script demonstrates the full machine-to-machine flow.

The Hedera network is driven by **`HEDERA_NETWORK`** (see below):
`testnet` by default (safe for development), `mainnet` / `previewnet` when
configured. The 402 network id, the USDC token selection, the treasury 2%
forward, and the HCS audit feed all follow this one setting — there are no
hardcoded-network code paths left. An unrecognized value crashes the server
at startup rather than silently using the wrong network.

## Architecture

```
 ┌────────────┐   1. POST /vibecode (no payment)    ┌──────────────────────┐
 │            │ ─────────────────────────────────▶ │                      │
 │  BUYER     │   2. 402 + PAYMENT-REQUIRED header  │   VIBECODE SERVER    │
 │  AGENT     │ ◀───────────────────────────────── │   (Express +        │
 │            │     accepts: [                     │   @x402/express)     │
 │  - reads   │       {asset:"0.0.0" (HBAR)},      │                      │
 │    the 402 │       {asset:<USDC id for      │   3. verify+settle   │
 │  - picks   │        HEDERA_NETWORK> (USDC)} │      via Blocky402   │
 │    its     │                                    │      facilitator     │
 │    rail    │   4. POST + PAYMENT-SIGNATURE       │                      │
 │  - builds  │ ─────────────────────────────────▶ │   4b. settle BEFORE  │
 │    partial │     base64(paymentPayload)          │       handler runs   │
 │    Hedera  │                                    │       ("upfront"     │
 │    tx on   │   5. 200 + PAYMENT-RESPONSE         │       flow — the AI  │
 │    that    │ ◀───────────────────────────────── │       call is the    │
 │    rail    │     { pageJson: <AI-edited> }       │       expensive part)│
 │    (buyer  │                                    │                      │
 │    sig     │                                    │                      │
 │    only)   │                                    │                      │
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
npm run demo -- --dry-run              # pay on the HBAR rail
npm run demo -- --dry-run --rail usdc   # pay on the USDC rail
```

Spins up a **mock facilitator + mock resource server on localhost** (running the
*real* `@x402/express` middleware and the *real* `ExactHederaScheme`) and drives
the whole agent handshake: discovery → 402 (advertising both the HBAR and USDC
rails) → partially-signed Hedera tx on the chosen rail (signed locally with a
throwaway ECDSA key) → `PAYMENT-SIGNATURE` retry → settle → 200 with page JSON.
No keys, no network, no funds moved. The buyer selects its rail with `--rail`
(the x402 client picks the 402's `accepts` entry matching its spend controls).

### 2. Run the real server (configured network — testnet by default)

```bash
npm run dev   # or: npm run build && npm start
```

Needs `SELLER_ACCOUNT_ID` (account on `HEDERA_NETWORK` receiving payments)
and `ANTHROPIC_API_KEY`. The server syncs with the configured x402 facilitator
on boot (testnet: Blocky402; mainnet: our self-hosted facilitator — see
FACILITATOR_SHORTLIST.md) and logs the active network loudly at startup
(`x402 operator client: HEDERA_TESTNET`). Set `HEDERA_NETWORK=mainnet` for
production — an invalid value refuses to start rather than guessing.

### 3. Run the live buyer agent (spends real funds on the configured network)

In another terminal, with the server running:

```bash
# .env needs BUYER_ACCOUNT_ID + BUYER_PRIVATE_KEY (ECDSA/secp256k1 ONLY)
npm run demo
```

The agent: `GET /` (discovery) → unpaid `POST` (reads the 402, picks a rail) →
builds the transfer on that rail → pays via `@x402/fetch` → prints the settle
receipt (`PAYMENT-RESPONSE` header) and the AI-edited page JSON.

Cost per request: **1¢ USD** — `5,000,000 tinybars` (0.05 HBAR) at the default
`HBAR_USD_PRICE=0.20`, or `10,000` USDC base units (0.01 USDC) 1:1. The HBAR
amount is recomputed from the USD quote at the configured rate, rounding UP to
whole tinybars (see the math in `src/payment.ts`).

### 4. Tests

```bash
npm test        # node:test — 402 shapes, schema validation, full dry-run handshake
npm run typecheck
```

### 5. HCS audit feed (optional)

```bash
npm run audit:init   # needs AUDIT_OPERATOR_ID/KEY (any key type the account uses)
# put the printed topic id in .env as HCS_TOPIC_ID, restart the server
```

Every settled payment is then logged to the topic on the configured network.
Verify publicly:

```
https://testnet.mirrornode.hedera.com/api/v1/topics/<HCS_TOPIC_ID>/messages
# mainnet: https://mainnet.mirrornode.hedera.com/api/v1/topics/<HCS_TOPIC_ID>/messages
```

Each message is JSON: `{ txId, payer, payTo, amountBaseUnits, asset, network,
endpoint, settledAt, facilitator, operatorShareBaseUnits, treasuryShareBaseUnits,
treasuryAccountId, treasuryForwardTxId }`. Amounts are base units of the paid
asset (`asset` is `"0.0.0"` for HBAR, the USDC token id for the USDC rail).
Audit writes are best-effort — they can
never fail a paid request.

> Honest framing: the audit feed is **self-reported by this same server** — a
> public accounting log, not trustless proof. Each entry records the treasury
> forward tx id so you can verify the 2% on the ledger instead of taking the
> feed's word for it.

### 6. Platform economics: the 98/2 split (optional)

Voicescape takes a 2% platform share on platform-mediated payments; the
service operator keeps 98%. The x402 "exact" scheme settles a single
buyer → operator transfer, so after settlement the server forwards the 2%
on-chain to the treasury (`src/treasury.ts`) **in the asset that was paid**:
an HBAR transfer for the HBAR rail, an HTS token transfer for the USDC rail.

```bash
# in .env
TREASURY_ACCOUNT_ID=0.0.345678   # Voicescape treasury (receives the 2%)
SELLER_PRIVATE_KEY=<key>         # operator private key (any key type), forwards the 2% after each settlement
```

At the default price (1¢): on the HBAR rail the operator keeps 4,900,000
tinybars and the treasury receives 100,000; on the USDC rail the operator
keeps 9,800 base units and the treasury receives 200 — a second on-chain
transfer you can verify on HashScan. The split is computed with exact integer
math (treasury share rounds down; dust stays with the operator) and recorded
in every audit message. Like the audit feed, forwarding is best-effort and can
never fail a paid request. Unset `TREASURY_ACCOUNT_ID` to run without the split.

> Honest framing: the 2% forward is **best-effort revenue accounting, not a
> trustless guarantee**. The operator key is the platform's own server key —
> the platform paying itself. If a forward fails, the treasury (not the user)
> is short; the buyer already received the service and no user funds are
> custodied. And `SELLER_PRIVATE_KEY` is a **hot server key**: keep the
> operator account lean (sweep forwarded funds to cold storage regularly) so a
> server compromise can't drain much.

## API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /` | none | Service info: price (USD quote + both rails), payTo, network, facilitator |
| `GET /health` | none | Liveness + config summary |
| `POST /vibecode` | x402 payment (HBAR or USDC rail) | `{ pageJson, instruction }` → `{ pageJson }` |

`pageJson` must match the Voicescape page schema (`src/schema.ts`, copied from
the Voicescape repo so this project is standalone); invalid bodies get 400.
The model is constrained by a system prompt to output only valid page JSON,
and the result is re-validated before returning.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `FACILITATOR_URL` | yes on mainnet/previewnet | x402 facilitator URL. Testnet defaults to Blocky402's open testnet facilitator; other networks have NO default — the server **refuses to start** without an explicit URL so real payments can never silently verify/settle through the wrong network's facilitator. **Decision ($0): our own self-hosted facilitator on Vercel Hobby** (see `~/workspace/goals/build-and-launch-voicescape/files/FACILITATOR_SHORTLIST.md`) — e.g. `https://voicescape-facilitator.vercel.app`. Blocky402 hosted mainnet is fallback-only. |
| `FEE_PAYER_ACCOUNT` | yes on mainnet/previewnet | Fee-payer account the buyer's partial tx is frozen with (the facilitator adds its signature + submits). Testnet defaults to Blocky402's `0.0.7162784`; on mainnet set this to **the self-hosted facilitator's `HEDERA_FACILITATOR_ID`** (same account — it must match the facilitator you point at). |
| `FACILITATOR_API_KEY` | only for Blocky402 mainnet | API key sent as the `X-Api-Key` header on facilitator verify/settle/supported calls. **Leave empty for the self-hosted facilitator** (it needs no key — the standard contract has no auth). Only set this if you fall back to Blocky402 mainnet. |
| `HEDERA_NETWORK` | no | Which Hedera network to use: `mainnet` / `testnet` / `previewnet` (default `testnet`). **Strict** — anything else crashes at startup. Drives the 402 network id, the USDC token selection, the treasury 2% forward, and the HCS audit feed. |
| `SELLER_ACCOUNT_ID` | yes (server) | Account (on `HEDERA_NETWORK`) receiving payments |
| `ANTHROPIC_API_KEY` | yes (server, for AI) | Anthropic API key |
| `ANTHROPIC_MODEL` | no | Override (default `claude-sonnet-4-5-20250929`). **Price-floor coupling:** sonnet-class models price at $3/$15 per MTok, haiku-class at $1/$5; an unknown model with no explicit rate overrides **refuses to boot** — set `ANTHROPIC_INPUT_USD_PER_MTOK` + `ANTHROPIC_OUTPUT_USD_PER_MTOK` (USD per million tokens, both required). |
| `ANTHROPIC_INPUT_USD_PER_MTOK` / `ANTHROPIC_OUTPUT_USD_PER_MTOK` | no (yes for unknown models) | Explicit per-MTok rates (USD) for the configured model; override the built-in rate table. Set **both** or neither. |
| `MAX_INPUT_TOKENS` | no | Worst-case input tokens per request (default `20000` — system prompt ~4k + pageJson + instruction) |
| `MAX_OUTPUT_TOKENS` | no | Worst-case output tokens per request (default `4096` — matches the `max_tokens` param) |
| `OPERATOR_OVERHEAD_TINYBARS` | no | Per-request operator overhead in tinybars (default `1000000` = 0.01 HBAR): covers the settle tx fee (our self-hosted facilitator's fee payer), the treasury-forward tx fee, and the HCS audit tx fee |
| `FORWARD_FEE_TINYBARS` | no | Forward-tx fee budget in tinybars (default `500000` ≈ $0.001 at $0.20/HBAR). A 2% treasury share worth less than 2x this fee is **never forwarded** (reason `below-forward-fee`) — set `0` to disable the skip. |
| `BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` | yes (live demo) | Buyer account (on `HEDERA_NETWORK`) + **ECDSA** key |
| `PORT` | no | Server port (default 3000) |
| `PUBLIC_URL` | no | Public base URL, used as the x402 resource URL |
| `PRICE_USD_CENTS` | no | Price per request in USD cents (default `1`) — both rails charge the same dollar price |
| `HBAR_USD_PRICE` | no | Manual HBAR/USD rate override (default `0.20`). The server first tries the **live CoinGecko feed** (free, no key, 10-min cache, logged as `source=live`); this env var is the fallback when the API is unreachable, and `$0.20` is the last resort. Rounds UP to whole tinybars so the seller is never shorted. |
| `VIBECODE_URL` | no | Server URL for the buyer demo |
| `HCS_TOPIC_ID` | no | Audit topic (see above) |
| `AUDIT_OPERATOR_ID` / `AUDIT_OPERATOR_KEY` | no | Credentials that submit audit messages |
| `TREASURY_ACCOUNT_ID` | no | Voicescape treasury; enables the on-chain 98/2 split (see §6) |
| `SELLER_PRIVATE_KEY` | no (yes with treasury) | Operator private key (any key type); forwards the 2% treasury share after settlement. **Hot server key** — keep the operator account lean (sweep forwarded funds regularly) so a server compromise can't drain much. |

### Economics: the platform never loses money

Two rules are enforced **in code**, not by convention:

1. **Startup price floor.** `src/economics.ts` computes the break-even price
   per request from the configured model: worst-case AI cost
   (`MAX_INPUT_TOKENS` in × input rate + `MAX_OUTPUT_TOKENS` out × output
   rate) × **1.5 safety margin**, plus the operator per-request overhead
   (`OPERATOR_OVERHEAD_TINYBARS`, converted to USD cents at the active
   HBAR/USD rate, ceil). When `ANTHROPIC_API_KEY` is set and
   `PRICE_USD_CENTS` is below that floor, the server **refuses to start**
   with a loud error naming the model, the floor, and the fix (raise
   `PRICE_USD_CENTS` or use a cheaper model). At defaults (sonnet,
   $0.20/HBAR) the floor is **20¢** — the legacy `1¢` default price will not
   boot in real AI mode. Mock mode (`$0`, no `ANTHROPIC_API_KEY`) has no AI
   cost, so the floor does not apply.
2. **Treasury forward skip.** Forwarding the 2% share costs a chain
   transaction. When the share is worth less than 2x
   `FORWARD_FEE_TINYBARS`, the forward is skipped with
   `attempted=false, reason="below-forward-fee"` (the existing exact-0 dust
   skip is kept). The audit entry records the skip, and the 2% simply stays
   with the operator — never pay a fee to collect dust.

## Bounty-track fit

Hedera's ETHOnline x402 track asks for agentic payments via **Blocky402** —
this project is exactly that, end to end:

- **Real x402 v2** (`@x402/*@2.25.0`): 402 handshake, `PAYMENT-REQUIRED` /
  `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers, Blocky402 testnet
  facilitator with its `feePayer` (`0.0.7162784`).
- **HBAR-native** (`asset: "0.0.0"`, tinybars) — no token-association footguns —
  **plus a USDC rail** (`0.0.429274` on testnet, `0.0.456858` on mainnet,
  6 decimals) advertised in the same 402. Prices are quoted in USD so both
  rails charge the same; the buyer picks its rail.
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

- **Facilitator is per-network, fail-fast.** `FACILITATOR_URL` /
  `FEE_PAYER_ACCOUNT` are env-driven: testnet defaults to Blocky402, but on
  `mainnet` the server refuses to boot until you point it at a real mainnet
  facilitator + fee-payer account. (This closed a real bug where
  `HEDERA_NETWORK=mainnet` would have advertised mainnet in the 402 while
  verifying/settling through the testnet facilitator.)
- **$0 mode:** with no `ANTHROPIC_API_KEY`, the live server serves a clearly
  labeled mock edit (`{ mock: true }`) instead of failing after the buyer
  paid — the full x402 payment flow works end to end without spending anything.
- The live Blocky402 round-trip can't be verified without keys — the
  dry-run/mock paths cover everything else (`npm test`).
- `upfront` flow: payment settles before the AI runs. If the AI then errors,
  the buyer gets a clear 502 (the payment is not refunded) — documented
  trade-off of pay-per-compute.
- Buyer keys must be **ECDSA (secp256k1)**; the x402 Hedera tooling rejects
  ED25519. The buyer agent whitelists its chosen rail via spend controls with
  a per-payment cap at the rail's price (HBAR rail: 1 HBAR; USDC rail: the
  USDC base-unit price). For a live USDC payment the buyer account must be
  associated with the USDC token and hold a balance.
- Server also checks the payment payload's `resource.url` against the called
  endpoint (replay hygiene).
