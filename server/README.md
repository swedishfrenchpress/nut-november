# Donation API

Bun 1.3.14, Hono 4.13.13, Coco 2.0.0, and Drizzle/SQLite. Run exactly one API process against one persistent data directory. `coco.sqlite` contains wallet state, deterministic keys and bearer proofs. `app.sqlite` contains donor metadata and operation associations. Each library owns its connection and migrations; no transaction spans the two databases.

## HTTP contract

| Route | Behavior |
| --- | --- |
| `POST /donate` | Create a Coco quote/operation, save donor metadata, then return its invoice. |
| `GET /donate/:id` | Read private payment status from local persistence. |
| `GET /donations` | Read the current confirmed donation list, count and sum. |
| `GET /healthz` | Process liveness. |
| `GET /readyz` | Ready after Coco initialization and its startup recovery. |

Example anonymous request:

```json
{"amountSats":2100,"message":"Go nuts!"}
```

Every submission requests a new invoice, including identical submissions after an error or a lost response. There is no request ID, deduplication, resumable creation, or automatic creation retry. Inputs are whole sats from 1 to 1,000,000, using the same fixed limits as the frontend in `shared/donations.ts`; messages are accepted up to 280 JavaScript characters and included only above 1,000 sats. Public previews are limited to 256 Unicode code points.

For an attributed donation, include `Authorization: Nostr <base64 JSON event>`. The NIP-98 event must have kind 27235, empty content, a valid ID/signature, a timestamp within 60 seconds, and exactly one each of `u`, `method`, and `payload`. They must equal the configured public `/donate` URL, `POST`, and SHA-256 of the exact request bytes. The pubkey comes only from the verified signature. No authorization means anonymous; invalid authorization returns 401. The signature proves the request author, independently of which Lightning wallet pays.

Creation awaits Coco quote creation and operation preparation, then commits the donation metadata before returning 201. On failure it returns an error; the user may request a new invoice. A failure before the app insert can leave an unused Coco operation. A lost response after the insert can leave an unused donation record. Neither invoice is shown by this client. Such records are excluded from public totals unless the associated operation actually completes successfully.

The response has `id`, `amountSats`, `invoice`, `expiresAt`, `status`, and `paymentReceived`. The invoice is always present in a successful response. `expiresAt` is Unix milliseconds or null. The unpredictable `id` grants access to status and the invoice: keep it private. Public feed IDs are separate. The browser keeps the current payment reference in memory and polls its status while the invoice is displayed. Reloading the page returns to the donation form. Coco continues tracking and collecting issued invoices independently of the browser.

The response states `pending`, `paid`, `confirmed`, `review`, and `failed` are derived from Coco on each read. `paid` means payment was observed while collection is unfinished. Only `finalized` operations without an error become `confirmed` and count toward totals. An exceptional finalization goes to `review`; the payer is told not to pay again. Local expiry hides payment controls but does not discard the record or prevent late payment recovery.

The public feed is `{ donations, donationCount, donationTotal }`. Each entry contains `id`, `amount`, `content`, `createdAt` (Unix seconds), and nullable `donorPubkey`. Totals contain collected donations only, with no sponsor commitment or legacy Nostr receipts. There is no legacy import.

## Persistence and limits

The donations table has five columns: private `id`, `public_id`, `operation_id`, `message`, and nullable `donor_pubkey`. Coco owns the invoice, amount, expiry, payment state, errors and timestamps. Status and feed requests use Coco's local operation/quote lookups. The public feed is built from successful linked operations, with its count and sum calculated from the returned entries. Missing wallet records fail the read instead of silently reducing totals.

Coco's default watchers/processors observe the mint and collect paid quotes; its startup recovery resumes persisted operations. There is no application payment projection, event-replay requirement, reconciliation worker or retry queue. Paid operations that remain stalled or finalize with an error require operator investigation through Coco. Browser polling never calls the mint.

`src/index.ts` opens Coco's database, awaits `initializeCoco()`, configures the mint and passes the manager directly to the donation service. The donation module contains the creation/capacity checks and public response mapping. Shutdown drains invoice creation, disposes Coco and closes both databases; no wallet wrapper owns its lifecycle.

Quote/operation creation is serialized to avoid concurrent NUT-20 key allocation in Coco 2.0.0 and enforce the capacity check. Hono handles routing, CORS, body limits and error dispatch. `hono-rate-limiter` 0.5.4 applies two independent memory stores after request validation and identity verification: 3 attempts per client IP per 10 minutes, followed by 50 globally per minute. Windows start with the first request for a key and counters reset on API restart. No rate-limit counters are stored in SQLite.

A limited request returns HTTP 429 with the existing JSON error and `Retry-After`; CORS exposes that header to the frontend. Failed invoice creation still consumes slots. A per-IP rejection does not reach the global limiter; a global rejection consumes an IP slot. On Fly, the client IP still comes from Fly's proxy header; elsewhere it is the socket address. Public reads, health checks and preflight requests do not consume slots.

Migration `0001_drop_rate_limits.sql` removes the obsolete counter table without touching donation records or wallet binding.

`MAX_PENDING_DONATIONS` defaults to 1,000 pending BOLT11 quotes at the configured mint, counted from Coco. This includes abandoned quotes that have no donation row. Unpaid expired quotes remain pending because expiry does not prove non-payment. Monitor this count: enough abandoned invoices intentionally stop new invoice admission. Do not delete wallet records to free capacity; investigate and adjust the bound deliberately.

This draft has not been deployed, so its initial migration was regenerated for the five-column schema. If you ran an earlier draft locally, use a fresh development data directory and seed; retain the earlier wallet if it contains funds.

## Configuration

Donation amount limits come from `shared/donations.ts`. The former `MIN_DONATION_SATS` and `MAX_DONATION_SATS` environment overrides are no longer read; remove them from existing environment files. `MAX_PENDING_DONATIONS` remains configurable.

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

Implementation verification on 2026-10-24 passed 18 backend tests, seven frontend store tests, type checks, lint, and the Next.js production build. Browser checks covered anonymous/signed requests, fresh invoices after lost responses, paid/confirmed states, totals, expiry, signature rejection, and an outage after payment. The complete API also passed live Minibits startup, readiness, graceful shutdown and restart checks with temporary empty databases. The container image was not built locally because Docker was unavailable; production provisioning and a funded payment test have not been performed.

## Backup, restore and operations

Back up both databases as one generation, along with the deployed version and mint URL. Store encrypted copies outside the running machine; keep the seed recovery material separately. A seed alone does not restore donation metadata or all operational associations. Fly's scheduled volume snapshots are useful recovery points, not a substitute for an independently retained backup and a tested restore.

For a portable filesystem backup, stop the API gracefully and verify it has exited, then archive the entire data directory, including any remaining `-wal` and `-shm` files. Restart only after the copy finishes. Never copy just live SQLite main files: uncheckpointed WAL entries can contain funds or donation associations. A consistent snapshot of the entire stopped volume is also suitable. On Fly, disable proxy autostart during planned backup/restore maintenance so a request cannot restart the writer, wait for the machine to be stopped, and snapshot its whole volume before resuming it. Use the provider's volume snapshot/export facilities for the off-machine copy.

Restore into a separate, private environment with the same pinned packages, mint and original seed. Stop the original writer before starting a restored wallet: never run two active copies. Restore the complete pair/WAL files to an empty data directory, run SQLite `PRAGMA integrity_check` on each, then start the service. Confirm `/readyz`, the public total/count, known private status references, and Coco's recovered balance/operations before switching traffic. Restore testing must not publish a second donation endpoint. Never discard a current wallet database merely to make a fingerprint check pass.

For app-level triage, query the metadata database through a private shell with a read-only SQLite connection. This prints counts of stored requests and attributed donors, including unpaid invoices. Payment totals and states must be inspected through Coco or the HTTP read endpoints:

```sh
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(`${process.env.DATA_DIR ?? "./data"}/app.sqlite`, { readonly: true });
console.log(db.query("SELECT count(*) AS requests, count(donor_pubkey) AS attributed FROM donations").all());
db.close();
'
```

Alert on sustained `paid` or `review` operations, rising pending quote counts, unhealthy readiness, low disk space, and stale backups. Request failures are logged without raw wallet objects. A `review` state needs private inspection of Coco's operation and quote. Do not count an error-finalized operation solely because the mint says issued.

Wallet balance inspection and eventual prize transfers belong to a private operator session using Coco's API and the same seed/database, with the public service stopped and a fresh backup retained. There is no public spending endpoint. Do not publish raw Coco operations or proofs in logs or support tickets. Keep that wallet under a single operator/writer during payout, then restart the service so Coco's watchers can resume.

If the frontend is rolled back, keep this API and wallet watching already-issued invoices. The legacy donation path has a separate ledger; its payments will not appear in this API's totals. Do not roll back a database across an incompatible migration; restore/rehearse the appropriate version and matching data together.

The Hono refactor passes 21 backend tests, including the new middleware behavior, exact-byte NIP-98 verification and migration from the previous donation schema. In-memory limits intentionally reset on restart; they assume the existing single API process.
