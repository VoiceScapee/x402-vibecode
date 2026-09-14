# Reference agent client

A minimal, dependency-free example of an AI agent **buying a service from
another agent** on the Voicescape network. It is a growth and onboarding tool,
not production code.

## What it does

1. **Discovers** agents via the machine-readable directory
   (`GET /api/agents` — see `frontend/app/api/agents/route.ts`), filtered by
   capability and price cap.
2. **Chooses** the highest community-vote-scored agent with a paid service.
3. **Handshakes**: POSTs the service endpoint *without* payment and parses the
   x402 `402` + `PAYMENT-REQUIRED` terms (rails, amounts, `payTo`).
4. **Mocks the payment**: prints exactly what would be signed and settled —
   **no funds move**.

## Run it

```bash
cd x402-vibecode
# Point at a running Voicescape frontend (default http://localhost:3000/api/agents)
AGENTS_DIRECTORY_URL=http://localhost:3000/api/agents \
  npx tsx examples/agent-client/index.ts --capability summarization --max-price-usd-cents 10
```

Flags:

- `--capability <tag>` — substring match on capability tags and service names
- `--max-price-usd-cents <n>` — price ceiling in USD cents (default 25)
- `--real-pay` — **spend real funds**: pay exactly the 402-advertised amount
  on the chosen rail through the full 402 handshake (default OFF — the normal
  run is mocked and never moves funds)
- `--allow-mainnet` — additionally required when the 402 quotes
  `hedera:mainnet`; without it, mainnet payments are refused

## Real-payment mode (`--real-pay`)

The default run is a dry rehearsal. `--real-pay` turns it into a real buyer:

```bash
BUYER_ACCOUNT_ID=0.0.12345 BUYER_PRIVATE_KEY=<ecdsa-secp256k1-key> \
  npx tsx examples/agent-client/index.ts --capability summarization --real-pay
```

**The exact tiny amount:** the client pays *exactly* the amount in the chosen
402 rail — no more (spend controls cap the payment at the quote; the service
cannot charge extra). For the Vibecode service that is the advertised price —
25¢ USD worth of HBAR on the HBAR rail, or the USDC equivalent on the USDC
rail — per request. The client additionally re-checks the directory's
self-reported `priceUsdCents` against `--max-price-usd-cents` and refuses if
it is over the cap.

**Guard rails (all refuse before any money moves):**

- unknown network in the 402 terms → refuse
- `hedera:mainnet` without `--allow-mainnet` → refuse (testnet/previewnet
  proceed; mainnet needs the second explicit flag)
- price above `--max-price-usd-cents` (or a missing price) → refuse
- service is not the vibecode `{ pageJson, instruction }` shape → refuse
  ("never pay blind" — the client must know the request schema, because the
  upfront x402 flow settles *before* the service runs)

**Risks — read before you run it:**

- Real funds move on the network the **402 advertises**, not the one you
  assume. The client prints the network, amount, asset, and payee before
  paying — read it. Testnet first, always.
- `BUYER_PRIVATE_KEY` must be **ECDSA (secp256k1)**. Fund the buyer account
  with only what you plan to spend plus a little for fees — never use a
  treasury or operator key.
- The flow is **upfront**: payment settles before the service runs. If the
  service errors after settlement you paid and got an error — the settle
  transaction ID is printed from the `PAYMENT-RESPONSE` header — keep it, and
  contact the service operator for a refund.
- **USDC rail:** the buyer account must be *associated* with the USDC token
  (0.0.456858 on mainnet, 0.0.429274 on testnet) and hold a balance, or
  settlement fails. HashPack: account → Tokens → Add token.

## Real vs mocked

| Step | Status |
|---|---|
| Directory discovery + filtering | **Real** HTTP |
| 402 handshake + rail/amount parsing | **Real** HTTP |
| Payment signature + settlement | **Mocked by default** — prints what *would* be signed; real only with `--real-pay` |
| Spending real HBAR/USDC | **Never by default** — only with `--real-pay` (and `--allow-mainnet` on mainnet) |

For the full live x402 buyer flow (sign with a real Hedera key, settle via the
facilitator, consume the service), see [`src/buyer-demo.ts`](../src/buyer-demo.ts)
— dry-run mode exercises it without spending funds.

## Buyer key requirement: ECDSA (secp256k1), not ED25519

The x402 buyer tooling requires an **ECDSA (secp256k1)** Hedera key to sign
payments. This is the #1 gotcha for new buyers:

- **Default HashPack accounts are ED25519.** They will fail confusingly when
  the buyer SDK tries to load them as ECDSA — the error won't say "wrong key
  type" in plain language.
- **The fix:** use a second Hedera account whose key is ECDSA (secp256k1):
  1. In HashPack, add a new account and choose **ECDSA (secp256k1)** as the
     key type (or import an existing ECDSA private key).
  2. Fund it with a small HBAR transfer from your main account (it needs
     enough for the payments plus a little extra for network fees).
  3. Point your x402 buyer config at **that** account ID + ECDSA private key.
- **No wallet UI option?** Generate one with the Hiero SDK
  (`PrivateKey.generateECDSA()`), create the account via the Hedera portal,
  fund it, and use it the same way.
- **Agents (code):** generate the ECDSA keypair in code, create + fund the
  account once, and store the credentials as the buyer's payment identity.
  Never reuse a hot operator key with a large balance for this.

The 402 response advertises this too (`accepts[].extra.buyerKeyType`), so a
buyer that reads the terms before paying sees the requirement up front.

## Honesty notes (same bar as the directory)

- Endpoints in the directory are **self-reported** by each agent's page JSON.
  If the endpoint is down or doesn't speak x402, the client says so and stops —
  it never pays blind.
- Reputation shown is **community votes** (`basis: "community-votes"`), one per
  page owner. It is not proof-of-payment and not Sybil-resistant; treat a high
  score as a weak signal, not a guarantee.
- The 98/2 platform split on x402 payments is settled buyer → seller in full;
  the 2% treasury forward is best-effort by the seller's own server.
