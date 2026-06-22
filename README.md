# ApexMint Pro

**Production-grade, multi-tenant NFT minting SaaS.**  
Built for fairness — public access so the playing field is level for everyone.

---

## Philosophy

Most minting bots are kept private. A handful of operators quietly take the majority of supply, leaving genuine collectors with nothing. ApexMint Pro flips that model: the tool is **public**, so competition returns to the factors that should matter — gas price, RPC quality, and timing. When everyone has the same tools, it's a fair race.

**FCFS (First Come First Served) phases exist by design.** Projects that want guaranteed allocations use GTD phases or allowlists. Projects that run FCFS are explicitly inviting speed-based competition. If a project removes FCFS before launch, ApexMint respects that too.

**Antibot protections are always respected.** If a project deploys signature gates, commit-reveal, or other bot-prevention logic, ApexMint detects it, notifies the user, and stops. It never attempts to circumvent these measures.

---

## What's Fixed vs the Old Bot

| Issue (v26 audit) | Fix in ApexMint Pro |
|---|---|
| Silent promise rejections → ghost schedules | BullMQ persistence + DB-backed recovery on restart |
| `mintSigned` blindly used on every contract | Only used when explicitly requested or sole option |
| Shared global wallet — data leakage | Per-user AES-256-GCM encrypted vault, isolated DB rows |
| Plaintext private keys in JSON files | Keys never touch disk unencrypted; wiped from memory immediately post-sign |
| No real auth or user isolation | Argon2id-hashed access keys, session tokens, per-user DB partitioning |
| In-memory JSON schedules lost on restart | PostgreSQL + BullMQ; `recoverPendingSchedules()` on every worker boot |
| No gas escalation on retry | Exponential gas escalation per attempt |
| No phase/eligibility check before firing | Phase → antibot → price guard → balance → execute pipeline |
| No rug/honeypot detection | Full risk engine: ownership, proxy, withdraw, blacklist, supply manipulation |
| No RPC failover | Health-scored endpoint pool with circuit breakers |
| Single process, no queuing | BullMQ workers, configurable concurrency, dead-letter queue |

---

## Supported Chains

| Chain | ID | Notes |
|---|---|---|
| Ethereum | 1 | Flashbots relay available |
| Base | 8453 | |
| Arbitrum One | 42161 | |
| Optimism | 10 | |
| Polygon | 137 | |
| BNB Chain | 56 | |
| Blast | 81457 | |
| Linea | 59144 | |
| Zora | 7777777 | |
| Avalanche C | 43114 | |
| ApeChain | 33139 | |
| **Solana** | — | Candy Machine v2 + v3, Jito available |

Adding a new chain: add one entry to `packages/core/src/chains/registry.ts`. No other code changes needed.

---

## Quick Start

### 1. Prerequisites

- Node.js 20+
- Docker + Docker Compose
- An `.env` file (copy from `.env.example`)

### 2. Clone and install

```bash
git clone https://github.com/you/apex-mint-pro.git
cd apex-mint-pro
cp .env.example .env
# Fill in .env — at minimum: VAULT_MASTER_KEY, SESSION_SECRET, ARGON2_PEPPER, ADMIN_TOKEN, DATABASE_URL
npm install
```

### 3. Generate secrets

```bash
# VAULT_MASTER_KEY and ARGON2_PEPPER
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# SESSION_SECRET (run twice, use both outputs for key + pepper)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ADMIN_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Start services

```bash
# Development (hot reload)
docker compose up -d postgres redis
npm run db:migrate
npm run dev:api     # terminal 1
npm run dev:worker  # terminal 2

# Production
docker compose -f docker-compose.prod.yml up -d
```

### 5. Generate your first access key

```bash
export ADMIN_TOKEN=your_admin_token
export APEX_API_URL=http://localhost:3000/api/v1

npx ts-node packages/cli/src/index.ts generate-key \
  --tier PREMIUM \
  --days 30 \
  --label "my-key"
```

The raw key is shown **once**. Store it securely.

---

## Admin CLI

All commands require `ADMIN_TOKEN` and `APEX_API_URL` in your environment.

```bash
alias apexmint="npx ts-node packages/cli/src/index.ts"

# Generate a key
apexmint generate-key --tier PREMIUM --days 30 --label "user-alice"
apexmint generate-key --tier ENTERPRISE --days 90 --features "all-evm,solana,api"

# List keys
apexmint list-keys
apexmint list-keys --tier PREMIUM --status ACTIVE

# Revoke (kills session immediately)
apexmint revoke-key <keyId> --reason "user request"

# Platform stats
apexmint stats

# List users
apexmint users --limit 50

# RPC + API health
apexmint health
```

---

## Tiers

| Feature | BASIC | PREMIUM | ENTERPRISE |
|---|---|---|---|
| EVM minting | ✅ | ✅ | ✅ |
| Solana minting | ❌ | ✅ | ✅ |
| Max wallets | 3 | 50 | 500 |
| Concurrent schedules | 1 | 20 | 200 |
| Scheduling + phase-poll | ❌ | ✅ | ✅ |
| Portfolio sync | ❌ | ✅ | ✅ |
| Flashbots relay | ❌ | ✅ | ✅ |
| Custom RPC endpoints | ❌ | ❌ | ✅ |
| API key access | ❌ | ❌ | ✅ |
| Rate limit (req/min) | 30 | 120 | 600 |

---

## API Overview

Base URL: `http://localhost:3000/api/v1`

All protected endpoints require:
```
x-session-token: <your_session_token>
```
or the `apex_session` cookie.

### Authentication

```
POST /auth/login          { accessKey }  → sessionToken + profile
GET  /auth/me             → current user profile
PATCH /auth/me            { label?, preferences? }
POST /auth/logout
```

### Wallets

```
GET    /wallets                     → list your wallets (no private keys)
POST   /wallets                     { privateKey, chain, label?, chainIds?, spendLimitEth? }
PATCH  /wallets/:id                 { label?, chainIds?, spendLimitEth?, isActive? }
DELETE /wallets/:id
GET    /wallets/:id/balances        ?chainIds=1,8453
POST   /wallets/:id/fund            { toAddress, amountEth, chainId }
POST   /wallets/:id/withdraw        { toAddress, amountEth, chainId }
```

### Minting

```
POST /mint/preflight      Full safety report before spending gas
POST /mint/antibot-check  Is this contract bot-protected?
POST /mint/phase-check    What phase is the contract in?
POST /mint/risk-check     Rug score + ownership analysis
POST /mint/execute        Execute mint now
GET  /mint/history        Your mint history
GET  /mint/history/:id    Single record
```

#### Execute mint body

```jsonc
{
  "contractAddress": "0x...",
  "chainId": 8453,
  "mintPrice": 0.001,
  "quantity": 1,
  "walletIds": ["wallet_id_1"],

  // Optional
  "customFn": "publicMint",        // override function detection
  "gweiOverride": 5,               // manual gas price
  "merkleProof": ["0x..."],        // if you have your own proof
  "merkleApiUrl": "https://...",   // auto-fetch proof per wallet
  "eip712Sig": "0x...",            // for signature-gated phases
  "tokenId": 1,                    // ERC-1155 token ID
  "standard": "auto",              // auto | ERC721 | ERC1155
  "dryRun": false,                 // simulate without broadcasting
  "gasEscalatePercent": 10,        // gas bump per retry
  "useFlashbots": false            // Ethereum mainnet only
}
```

### Scheduling

```
GET    /schedules           ?status=PENDING|RUNNING|COMPLETED|FAILED|CANCELLED
POST   /schedules           Create a time-based or phase-polling schedule
DELETE /schedules/:id       Cancel a pending schedule
```

#### Schedule body

```jsonc
{
  "contractAddress": "0x...",
  "chainId": 1,
  "mintConfig": { /* same as execute body */ },
  "walletIds": ["wallet_id_1"],

  // Fire at exact time (ISO string):
  "mintTime": "2025-01-15T18:00:00.000Z",

  // Or poll until public phase opens:
  "waitForPhase": true,
  "phaseCheckIntervalMs": 5000,   // poll every 5s
  "phaseMaxWaitMs": 3600000       // give up after 1h
}
```

### Portfolio

```
GET  /portfolio             ?walletAddress=&chainId=&page=
GET  /portfolio/stats       Total NFTs, estimated value, by-chain breakdown
POST /portfolio/sync        Trigger background sync { walletAddresses?, chainIds? }
```

---

## Antibot Detection Behaviour

ApexMint Pro detects bot-protection patterns and **stops**, never circumvents.

| Pattern | What happens |
|---|---|
| OpenSea SeaDrop (`mintSigned` with OS signature) | Blocked — user notified to mint on opensea.io |
| EIP-712 backend signature required | Blocked — user told to obtain signature via project site |
| Commit-reveal scheme | Blocked — user told to mint manually (two-step not automated) |
| Explicit `botProtectionEnabled()` flag | Blocked — user notified |
| Allowlist-only (no public mint exists) | Proceeds if Merkle proof available; otherwise blocked |
| Per-block rate limiter | Proceeds — rate respected automatically |
| Cooldown between mints | Proceeds — cooldown respected automatically |

Detection runs as **step 1** of every mint and every scheduled job. If a project adds protection *after* you schedule, the job will detect it at fire time and notify rather than attempting the mint.

---

## Pre-flight Pipeline

Every `POST /mint/execute` runs in this order:

```
1. Antibot detection      → abort if bot protection active
2. Phase check            → abort if paused or sold out
3. Risk analysis          → abort if rug score CRITICAL (>65)
4. Price guard            → abort if on-chain price ≠ declared price
5. Spend limit check      → skip wallets over their limit
6. Balance validation     → skip wallets with insufficient ETH/SOL
7. Gas estimation         → dynamic EIP-1559 with buffer
8. callStatic simulation  → verify tx will succeed before broadcasting
9. Tenderly simulation    → optional deeper pre-flight (if configured)
10. Broadcast             → fire with retry + gas escalation
```

---

## Wallet Security

- Private keys are encrypted with **AES-256-GCM** before leaving memory
- A **two-layer HKDF** derives a unique key per wallet from the master secret
- The AAD (additional authenticated data) binds each ciphertext to its `userId:walletId` — swapping ciphertexts between users is cryptographically impossible
- Keys are **wiped from memory** immediately after signing
- `VAULT_MASTER_KEY` never touches the database
- Sessions are random 32-byte tokens stored hashed; no JWTs to forge

---

## Migration from Hermès Bot v26

### 1. Import wallets

Your existing private keys can be added via `POST /wallets`. They'll be immediately encrypted; the plaintext is never persisted.

### 2. Import schedules

Re-create schedules via `POST /schedules`. The new scheduler is persistent — it survives process restarts.

### 3. Key differences

- **No more shared `wallets.json`** — each user has isolated vault rows
- **No more in-memory schedule state** — all schedules are in Postgres + BullMQ
- **No `mintSigned` by default** — detected only when appropriate or explicitly requested
- **Gas escalation** is automatic on retry
- **Phase + antibot check** runs before every mint, not just on failure

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Clients (web / CLI / API keys)                                 │
└───────────────────────┬─────────────────────────────────────────┘
                        │ HTTPS
┌───────────────────────▼─────────────────────────────────────────┐
│  Fastify API  (packages/api)                                    │
│  Auth → Tier Gate → Route Handler → Service                     │
│  Audit log on every mutation                                    │
└────┬──────────────────────────────────────────────┬────────────┘
     │ Prisma                                        │ BullMQ
     ▼                                               ▼
┌──────────┐                               ┌──────────────────────┐
│ Postgres │                               │ Redis                │
│ Users    │                               │ Job queues           │
│ Wallets  │                               │ Rate limits          │
│ Schedules│                               │ Distributed locks    │
│ History  │                               │ Sessions             │
└──────────┘                               └────────┬─────────────┘
                                                    │
                               ┌────────────────────▼─────────────┐
                               │  Worker (packages/worker)         │
                               │  Mint processor                   │
                               │  Phase-poll processor             │
                               │  Portfolio sync processor         │
                               └────────────────────┬─────────────┘
                                                    │
                               ┌────────────────────▼─────────────┐
                               │  @apex/core engines               │
                               │  ├── EVM mint engine             │
                               │  ├── Solana mint engine          │
                               │  ├── Contract intelligence       │
                               │  ├── Antibot detector            │
                               │  ├── Risk engine                 │
                               │  ├── RPC manager (failover)      │
                               │  └── Wallet vault (AES-256-GCM)  │
                               └──────────────────────────────────┘
```

---

## Environment Variables

See `.env.example` for the full list. Minimum required:

```bash
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
VAULT_MASTER_KEY=<64-hex-chars>
SESSION_SECRET=<64-chars>
ARGON2_PEPPER=<64-hex-chars>
ADMIN_TOKEN=<strong-random-string>
RPC_1=https://eth-mainnet.g.alchemy.com/v2/KEY,...
```

---

## Security Checklist

- [ ] `VAULT_MASTER_KEY` stored in secrets manager (AWS Secrets Manager / Doppler), not in `.env` in production
- [ ] `ADMIN_TOKEN` is a strong random string (min 32 bytes), rotated regularly
- [ ] `ARGON2_PEPPER` backed up securely — losing it means all keys become unverifiable
- [ ] Postgres and Redis not exposed to public internet (firewall / VPC)
- [ ] API behind HTTPS reverse proxy (nginx / Caddy / Cloudflare)
- [ ] Docker containers run as non-root (built in)
- [ ] Log aggregation configured (no sensitive data logged — built in)
- [ ] Dependency audit: `npm audit` before every deploy

---

## Running Tests

```bash
npm test                    # all packages
npm test -w packages/core   # core only
```

---

## License

MIT — see LICENSE file.
