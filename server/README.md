# Donation API

Bun 1.3.14, Coco 2.0.0, and Drizzle/SQLite. Run exactly one API process against one persistent data directory. `coco.sqlite` contains wallet state, deterministic keys and bearer proofs. `app.sqlite` contains donation associations, verified identity evidence, idempotency and admission limits. Each library owns its connection and migrations; no transaction spans the two databases.

## HTTP contract

| Route | Behavior |
| --- | --- |
| `POST /donate` | Reserve a donation and prepare a recoverable BOLT11 invoice. |
| `GET /donate/:id` | Read private payment status from local persistence. |
| `GET /donations` | Read the current confirmed donation list, count and sum. |
| `GET /healthz` | Process liveness. |
| `GET /readyz` | Ready after wallet initialization and initial reconciliation. |

Example anonymous request:

```json
{"requestId":"64ef5347-e606-4865-af41-95297ec67281","amountSats":2100,"message":"Go nuts!"}
```

`requestId` is a client-generated UUID v4. Retain it for retries of the same donation. Reusing it with a different amount, normalized message or verified pubkey returns 409. Creating a second intentional donation requires a new ID. Inputs are whole sats from 1 to 1,000,000 by default; messages are accepted up to 280 JavaScript characters and included only above 1,000 sats. Public previews are limited to 256 Unicode code points.

For an attributed donation, include `Authorization: Nostr <base64 JSON event>`. The NIP-98 event must have kind 27235, empty content, a valid ID/signature, a timestamp within 60 seconds, and exactly one each of `u`, `method`, and `payload`. They must equal the configured public `/donate` URL, `POST`, and SHA-256 of the exact request bytes. The pubkey comes only from the verified signature. No authorization means anonymous; invalid authorization returns 401. The signature proves the request author, independently of which Lightning wallet pays.

Creation returns 201 for a newly prepared invoice, 200 for a retry, or 202 while preparation continues. The response has `id`, `amountSats`, `invoice`, `expiresAt`, `status`, and `paymentReceived`. The invoice remains null until its operation association is durable. `expiresAt` is Unix milliseconds or null. The unpredictable `id` grants access to status and the invoice: keep it private. Public feed IDs are separate.

States are `creating`, `pending`, `paid`, `confirmed`, `review`, and `failed`. `paid` means payment was observed while collection is unfinished. Only `finalized` operations without an error become `confirmed` and count toward totals. An exceptional finalization goes to `review`; the payer is told not to pay again. Local expiry hides payment controls but does not discard the record or prevent late payment recovery.

The public feed is `{ donations, donationCount, donationTotal }`. Each entry contains `id`, `amount`, `content`, `createdAt` (Unix seconds), and nullable `donorPubkey`. Totals contain collected donations only, with no sponsor commitment or legacy Nostr receipts. There is no legacy import.

## Reconciliation and limits

Coco's default watchers/processors observe the mint and collect paid quotes. Global listeners enqueue local state projection; they never await a donation job inside Coco's emitter. Startup and periodic reconciliation repair missed notifications. The periodic sweep also retries stalled paid/executing operations. Browser polling never calls the mint.

Quote creation is serialized to avoid concurrent NUT-20 key allocation in Coco 2.0.0. Work on each donation is coalesced; failures use persisted backoff up to five minutes. A crash between quote creation and persisting its association can leave an unpaid orphan quote, but the browser has not yet received that invoice. Recovery searches for an already-created operation before preparing another.

New invoice requests are limited to 10 per client IP and 60 globally per fixed minute. `MAX_PENDING_DONATIONS` defaults to 1,000 unresolved records. Idempotent retries do not consume these limits. On Fly, the client IP is taken from Fly's proxy header; elsewhere it is the socket address. Unpaid expired quotes remain unresolved because expiry does not prove non-payment. Monitor this count: enough abandoned invoices will intentionally stop new invoice admission. Do not delete wallet records or silently mark expired invoices failed to free capacity; investigate and adjust the bound deliberately. Stronger edge abuse controls can be added if needed.

## Configuration

Start from [.env.example](.env.example). `COCO_SEED_HEX` is required and must be exactly 128 hex characters (64 bytes). Keep it stable, backed up separately from the databases, and out of logs/source control. Startup validates mint capabilities and stores the seed fingerprint and mint URL in the app database. A changed seed/mint, a wallet without its app identity, or a missing wallet alongside existing donations stops startup. These checks catch common configuration errors; restoration still requires the matching database pair.

The service uses WAL, restrictive data-directory/file permissions, and graceful SIGTERM/SIGINT shutdown. Coco recovery runs on startup before serving donations. The mint is `https://mint.minibits.cash/Bitcoin` by default. Changing it is a wallet migration, not a routine configuration edit.

## Fly deployment

[fly.toml](fly.toml) defines a separate `nut-november-api` app in `ams`, a `/data` volume, TLS, a readiness check, and no automatic stopping. [Dockerfile](Dockerfile) must be built with the repository root as its context:

```sh
docker build -f server/Dockerfile -t nut-november-api .
```

Provision from the repository root, using your intended Fly organization:

```sh
fly apps create nut-november-api --org YOUR_ORG
fly volumes create donation_data --app nut-november-api --region ams --size 1 --snapshot-retention 14
fly secrets import --app nut-november-api --stage < /secure/nut-november-production.env
fly deploy --config server/fly.toml --ha=false --strategy immediate
fly scale count 1 --app nut-november-api
fly certs add api.nutnovember.org --app nut-november-api
```

The private secrets file must contain the production `COCO_SEED_HEX=...` value. Store a recovery copy securely before accepting donations. `fly secrets import` accepts name/value pairs on stdin. Volume creation enables scheduled snapshots by default; retention is explicitly configured above. [Secrets command](https://docs.fly.io/flyctl/cmd/fly_secrets_import), [volume options](https://docs.fly.io/flyctl/cmd/fly_volumes_create).

Follow the certificate command's DNS instructions and verify HTTPS at `/readyz` and `/donations`. Confirm there is one active machine and the intended volume, secret and allowed origins. Avoid blue/green deployments, cloning the wallet to live replicas, or running a second process against either database. An immediate deployment accepts brief downtime while preserving one wallet writer.

The manual [API workflow](../.github/workflows/api-deploy.yml) uses the GitHub environment `donation-api`; configure its `FLY_API_TOKEN` with an app-scoped token for this API. Keep it separate from the existing frontend deployment token. The workflow type-checks/tests the backend before deployment. Provision the volume/seed/DNS first. Do not merge the frontend switch until the API is reachable: the frontend's existing workflow deploys `main` automatically.

Before accepting normal donations, make one controlled payment and verify that it progresses to confirmed, appears exactly once, survives restart, and increases the frontend pool by that amount over 400,000 sats. Repeat with a signed identity, and rehearse a restore. Live payment/issuance and WebSocket-fallback behavior still need this operational rehearsal; the implementation check created and recovered an unpaid Minibits invoice without sending funds.

Implementation verification on 2026-10-24 passed 16 backend tests, seven frontend store tests, type checks, lint, and the Next.js production build. Browser checks covered anonymous/signed requests, lost-response retries, reload recovery, paid/confirmed states, totals, expiry, signature rejection, and an outage after payment. The complete API also passed live Minibits startup, readiness, graceful shutdown and restart checks with temporary empty databases. The container image was not built locally because Docker was unavailable; production provisioning and a funded payment test have not been performed.

## Backup, restore and operations

Back up both databases as one generation, along with the deployed version and mint URL. Store encrypted copies outside the running machine; keep the seed recovery material separately. A seed alone does not restore donation metadata or all operational associations. Fly's scheduled volume snapshots are useful recovery points, not a substitute for an independently retained backup and a tested restore.

For a portable filesystem backup, stop the API gracefully and verify it has exited, then archive the entire data directory, including any remaining `-wal` and `-shm` files. Restart only after the copy finishes. Never copy just live SQLite main files: uncheckpointed WAL entries can contain funds or donation associations. A consistent snapshot of the entire stopped volume is also suitable. On Fly, disable proxy autostart during planned backup/restore maintenance so a request cannot restart the writer, wait for the machine to be stopped, and snapshot its whole volume before resuming it. Use the provider's volume snapshot/export facilities for the off-machine copy.

Restore into a separate, private environment with the same pinned packages, mint and original seed. Stop the original writer before starting a restored wallet: never run two active copies. Restore the complete pair/WAL files to an empty data directory, run SQLite `PRAGMA integrity_check` on each, then start the service. Confirm `/readyz`, the public total/count, known private status references, and Coco's recovered balance/operations before switching traffic. Restore testing must not publish a second donation endpoint. Never discard a current wallet database merely to make a fingerprint check pass.

For app-level triage, query the app database through a private shell with a read-only SQLite connection. This example prints only aggregate status counts and amounts, not keys, invoices or private references:

```sh
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(`${process.env.DATA_DIR ?? "./data"}/app.sqlite`, { readonly: true });
console.log(db.query("SELECT status, count(*) AS count, sum(amount_sats) AS sats FROM donations GROUP BY status").all());
db.close();
'
```

Alert on sustained `paid` or `review` records, rising reconciliation failures/unresolved count, unhealthy readiness, low disk space, and stale backups. Logs deliberately contain public donation IDs and sanitized failure codes. A `review` record needs private inspection of Coco's operation and quote before any accounting correction. Do not count an error-finalized operation solely because the mint says issued.

Wallet balance inspection and eventual prize transfers belong to a private operator session using Coco's API and the same seed/database, with the public service stopped and a fresh backup retained. There is no public spending endpoint. Do not publish raw Coco operations or proofs in logs or support tickets. Keep that wallet under a single operator/writer during payout, then restart this service so its reconciliation can finish.

If the frontend is rolled back, keep this API and wallet watching already-issued invoices. The legacy donation path has a separate ledger; its payments will not appear in this API's totals. Do not roll back a database across an incompatible migration; restore/rehearse the appropriate version and matching data together.
