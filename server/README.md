# Nut November API

Bun 1.3.14, Hono 4.13.13, Coco 2.0.0, and Drizzle/SQLite. Run exactly one API process against one persistent data directory. `coco.sqlite` contains wallet state, deterministic keys and bearer proofs. `app.sqlite` contains donor metadata, operation associations, the confirmed donation feed cache and private project submissions. Each library owns its connection and migrations; no transaction spans the two databases.

## HTTP contract

| Route | Behavior |
| --- | --- |
| `POST /donate` | Create a Lightning invoice or Cashu payment request and save donor metadata. |
| `POST /donate/:requestId/cashu` | Receive a NUT-18 payment payload through Coco. |
| `GET /donate/limits` | Read the mint’s BOLT11/sat donation bounds through Coco. |
| `GET /donate/:id` | Read payment status and invoice/request by Coco operation ID. |
| `GET /donations` | Read the confirmed donation feed, count and sum from app SQLite. |
| `POST /submissions` | Validate and save a private project submission, then return its ID. |
| `GET /healthz` | HTTP health check, available after startup completes. |

Example anonymous request:

```json
{"amountSats":2100,"message":"Go nuts!","paymentMethod":"bolt11"}
```

Every donation request creates a new payment request, including identical requests after an error or a lost response. Creation has no idempotency key, resumable creation, or automatic retry. `paymentMethod` is `bolt11` (the default when omitted) or `cashu`; each donation accepts only its chosen method. Inputs are positive whole safe-integer sats; Lightning uses the mint’s advertised BOLT11/sat minting bounds, while Cashu has a minimum of one sat and no application amount maximum; messages are accepted up to 280 JavaScript characters and included only above 1,000 sats. Public previews are limited to 256 Unicode code points.

`GET /donate/limits` returns `{ minSats, maxSats }`. The backend reads these bounds through Coco’s payment-method capability API on startup, limit reads and invoice validation, leaving mint-info caching and refresh to Coco. An absent or zero minimum becomes one sat; an absent maximum is returned as null. Amounts must be JavaScript safe integers. The frontend loads these bounds before enabling invoice requests and disables presets outside the range. Unsupported minting or an unusable range prevents startup.

For an attributed donation, include `Authorization: Nostr <base64 JSON event>`. The NIP-98 event must have kind 27235, empty content, a valid ID/signature, a timestamp within 60 seconds, and exactly one each of `u`, `method`, and `payload`. They must equal the configured public `/donate` URL, `POST`, and SHA-256 of the exact request bytes. The pubkey comes only from the verified signature. No authorization means anonymous; invalid authorization returns 401. The signature proves the request author, independently of which wallet pays.

Creation awaits Coco quote creation and operation preparation, commits the donation metadata, and checks the locally stored operation once before returning 201. This catches a finalization event that arrived before the donation row existed. On failure it returns an error; the user may request a new invoice. A failure before the app insert can leave an unused Coco operation. A lost response after the insert can leave an unused donation record. Neither invoice is shown by this client. Such records are excluded from public totals unless the associated operation actually completes successfully.

The response has `id`, `paymentMethod`, `amountSats`, `expiresAt`, `status`, and `paymentReceived`, plus `invoice` for Lightning or `paymentRequest` for Cashu. `id` is Coco's mint-operation ID for Lightning or incoming-request-operation ID for Cashu, an opaque string also used in the public feed and for status lookups. Child receive-operation IDs stay internal. Anyone with this ID can read the invoice/request and payment status; the mint quote ID stays internal. `expiresAt` is Unix milliseconds or null. The browser keeps the current payment reference in memory and polls its status while the invoice is displayed. Reloading the page returns to the donation form. Coco continues tracking and collecting issued invoices independently of the browser.

The response states `pending`, `paid`, `confirmed`, `review`, and `failed` are derived from Coco on each read. `paid` means payment was observed while collection is unfinished. Only successfully collected operations become `confirmed` and count toward totals. An exceptional finalization goes to `review`; the payer is told not to pay again. Local expiry hides payment controls but does not discard the record or prevent late payment recovery.

The public feed is `{ donations, donationCount, donationTotal }`. Each entry contains `id`, `amount`, `content`, `createdAt` (Unix seconds), and nullable `donorPubkey`. Totals contain collected donations only, with no sponsor commitment or legacy Nostr receipts. There is no legacy import.

## Cashu payment delivery

Create with `paymentMethod: "cashu"`. Coco persists a single-use incoming payment request restricted to `https://mint.minibits.cash/Bitcoin` and unit `sat`. The API returns its `creqA` encoding for QR/copy; the frontend does not assume a Cashu wallet URI scheme. Cashu requests have no automatic expiry. No mint quote or Lightning invoice is created.

The request includes a random payment ID (`i`) and a `post` transport targeting `${PUBLIC_API_URL}/donate/<requestId>/cashu`. A small Coco plugin registers this transport before startup recovery; Hono owns the parameterized HTTP route. The app commits donor metadata before exposing the request.

Wallets POST `application/json` containing the matching `id`, exact configured `mint`, `unit: "sat"`, and `proofs`, plus an optional `memo` up to 280 characters. The endpoint needs no Nostr signature. It accepts external wallet origins, including preflight, while the creation/status/feed routes retain the configured origin restrictions. A payer memo never replaces the message or identity stored at creation.

The first version requires the exact requested amount and assumes Minibits charges zero input fees. Partial payments, overpayments, repeated proof secrets, malformed proofs, wrong units and other mint URLs are rejected before receiving. The callback permits at most 128 proofs in a 128 KiB body. The server-wide body ceiling is 128 KiB; creation retains its separate 4 KiB ceiling. Delivery has independent limits of 30 attempts/IP/minute, 120 globally/minute, and eight active receives. These limits allow redelivery without consuming donation creation slots. Cashu request creation shares the existing creation rate limits; `MAX_PENDING_DONATIONS` remains a Lightning quote limit.

Coco validates and swaps the supplied proofs and persists fresh wallet proofs. HTTP 200 returns `{ id, status: "confirmed" }` only after collection is confirmed. Identical completed deliveries return success without counting again; a different payment for an already completed single-use request is rejected. Definite proof rejection returns 400; competing/in-flight claims return 409; unresolved collection or unavailable capacity returns 503. Rate limits return 429 and expose `Retry-After`. Error responses and logs do not include bearer proofs.

Retries must deliver the same payment payload. A network error is not an instruction to construct a new token. During an active or ambiguous receive, the current process reports `review` and hides payment controls. This review marker is in memory. Coco's persisted attempts, proofs and recovery are authoritative; startup recovery runs before serving, followed by a local reconciliation of completed requests into the donation feed. Recovery is best effort: unresolved operations can require private operator inspection, and there is no extra recovery worker or transaction spanning the two databases. An unresolved review marker does not survive a restart if Coco cannot finish recovery.

## Persistence and limits

The donations table stores primary key `operation_id`, `payment_method`, nullable unique `cashu_request_id`, `message`, nullable `donor_pubkey`, and two nullable feed fields: `amount_sats` and `confirmed_at` (Unix seconds). Both feed fields start null. A successful `mint-op:finalized` or donation-associated `receive-op:finalized` event copies the collected amount and timestamp into the matching row. Updates only affect rows without a confirmation, so duplicate events do not change totals or timestamps. Unknown operations, pending payments, failures and error-finalized operations never enter the public feed.

`GET /donations` reads confirmed rows exclusively from app SQLite and calculates its count and sum from those entries. It performs no Coco operation or quote lookups. Coco remains the source of payment state; `GET /donate/:id` reads its local operation/quote records for invoice/status information. Cached confirmed donations remain available even if a wallet lookup later fails.

Coco's default watchers/processors observe the mint and collect paid quotes; its startup recovery resumes persisted operations. The app subscribes to finalization events, then checks only donations that have no cached confirmation before opening the HTTP listener. This catches finalizations during Coco startup recovery or a crash between the Coco commit and the app update. No mint requests or app payment retries are involved in this catch-up pass.

Coco isolates event-listener errors. If a feed update fails, the app logs the failure and returns 503 for the public feed until restart catches up; invoice/status reads and Coco payment collection continue. No stale authoritative totals are served. Paid operations that remain stalled or finalize with an error require operator investigation through Coco. Browser status polling never calls the mint.

`src/index.ts` initializes app persistence, opens Coco's database, awaits `initializeCoco()`, configures the mint, validates its capabilities and starts donation feed synchronization sequentially before starting the HTTP server. It passes the manager directly to the donation service. There is no separate readiness state or endpoint: initialization failures prevent the listener from starting. The donation module contains the creation/capacity checks and public response mapping. Shutdown stops the HTTP server, drains request creation and active Cashu deliveries, disposes Coco, removes the feed listener and closes both databases; no wallet wrapper owns its lifecycle.

Quote/operation creation is serialized to avoid concurrent NUT-20 key allocation in Coco 2.0.0 and enforce the capacity check. Hono handles routing, CORS, body limits and error dispatch. `hono-rate-limiter` 0.5.4 applies two independent memory stores after request validation and identity verification: 3 attempts per client IP per 10 minutes, followed by 50 globally per minute. Windows start with the first request for a key and counters reset on API restart. No rate-limit counters are stored in SQLite.

A limited request returns HTTP 429 with the existing JSON error and `Retry-After`; CORS exposes that header to the frontend. Failed invoice creation still consumes slots. A per-IP rejection does not reach the global limiter; a global rejection consumes an IP slot. On Fly, the client IP still comes from Fly's proxy header; elsewhere it is the socket address. Public reads, health checks and preflight requests do not consume slots.

Migration `0005_cashu_payment_requests.sql` adds the payment method and unique Cashu request association. Existing records default to Lightning and retain their IDs, confirmations, messages and wallet binding.

Migration `0001_drop_rate_limits.sql` removes the obsolete counter table without touching donation records or wallet binding.

Migration `0003_donation_feed_cache.sql` adds the two nullable confirmed-feed fields. Existing successful donations are populated by the startup catch-up pass.

Migration `0002_operation_id_primary_key.sql` retains each operation ID, message and donor pubkey while removing the redundant donation/public ID columns. Wallet binding and Coco's database remain intact. Previous app-generated IDs stop resolving; reload the donation page to use the new API, and use operation IDs for any message-hiding entries.

`MAX_PENDING_DONATIONS` defaults to 1,000 pending BOLT11 quotes at Minibits, counted from Coco. This includes abandoned quotes that have no donation row. Unpaid expired quotes remain pending because expiry does not prove non-payment. Monitor this count: enough abandoned invoices intentionally stop new invoice admission. Do not delete wallet records to free capacity; investigate and adjust the bound deliberately.

This draft has not been deployed. Development instances using the previous five-column schema upgrade automatically. Drafts predating that schema need a fresh development data directory and seed; retain an earlier wallet if it contains funds.

## Project submissions

`POST /submissions` accepts the existing form fields without a Nostr account or signature:

```json
{"projectName":"My nut","firstContribution":"yes","description":"What we built","githubRepo":"https://github.com/example/project","demoLink":"","contactInfo":"builder@example.com"}
```

The API returns `201 {"id":"..."}` only after the database insert succeeds. The table stores these six fields, a server-generated ID and a creation timestamp in Unix milliseconds. Inputs are trimmed; `firstContribution` must be `yes` or `no`. Project names are limited to 120 characters, descriptions to 5,000, each URL to 2,048, and contact information to 500. Code and demo links must use HTTP(S) without embedded credentials; the demo link may be empty or omitted. Unknown fields, malformed JSON and invalid types are rejected. Frontend and backend share validation and the submission deadline: Nov 28, 2026 at 00:00 UTC. Submissions are accepted before the hackathon starts on Nov 1. Request bodies are limited to 64 KiB for submissions; donations retain their 4 KiB limit.

Submissions have their own Hono rate-limiter instances: 3 attempts per IP per 10 minutes and 50 globally per minute, with `Retry-After` on HTTP 429. Their memory stores are independent of donations. Windows start with the first request and counters reset on API restart. A global rejection consumes an IP slot. Each accepted request creates a new entry, including deliberate resubmission after a lost response. The browser keeps the form's answers after failures and does not retry automatically.

Entries and contact details are private to organizers with server access. There is no public listing, read, update or delete endpoint, and submission contents are not logged or sent to Nostr. No legacy Nostr submissions are imported. Nostr signing for verified donors is unchanged.

From the `server` directory on the API machine, or against a consistent private copy of its app database:

```sh
umask 077
DATA_DIR=/data bun run --silent submissions:export > /secure/submissions.json
```

Set `DATA_DIR` to the actual data directory and use an existing private output directory. The command opens `app.sqlite` read-only, emits a JSON array ordered by creation time and ID, and requires neither the wallet seed nor a running mint. It does not run migrations. This export contains contact information; keep the file private.

The additive `0004_submissions.sql` migration runs at API startup and preserves the existing donation tables. It also preserves entries from the earlier submissions draft; the preceding donation migrations retain operation IDs and add the confirmed feed cache. Deploy the updated API before the frontend switch. Existing app database backups now also cover submissions. Rolling back the frontend returns new entries to the old Nostr flow; retain and export entries already saved in SQLite.

## Configuration

The mint is fixed to `https://mint.minibits.cash/Bitcoin` in `src/config.ts`. Lightning amount limits come from its BOLT11/sat minting capabilities. Cashu accepts positive safe-integer sats independently of those bounds. `MINT_URL`, `MIN_DONATION_SATS` and `MAX_DONATION_SATS` environment overrides are no longer read; remove them from existing environment files. `MAX_PENDING_DONATIONS` remains configurable.

Start from [.env.example](.env.example). `COCO_SEED_HEX` is required and must be exactly 128 hex characters (64 bytes). Keep it stable, backed up separately from the databases, and out of logs/source control. Startup validates mint capabilities and stores the seed fingerprint and mint URL in the app database. A changed seed/mint, a wallet without its app identity, or a missing wallet alongside existing donations stops startup. These checks catch common configuration errors; restoration still requires the matching database pair.

The service uses WAL, restrictive data-directory/file permissions, and graceful SIGTERM/SIGINT shutdown. Coco recovery runs on startup before serving donations. Changing the fixed mint requires a code change and a wallet migration.

## Fly deployment

[fly.toml](fly.toml) defines a separate `nut-november-api` app in `ams`, a `/data` volume, TLS, a `/healthz` check, and no automatic stopping. [Dockerfile](Dockerfile) must be built with the repository root as its context:

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

Follow the certificate command's DNS instructions and verify HTTPS at `/healthz` and `/donations`. Confirm there is one active machine and the intended volume, secret and allowed origins. Avoid blue/green deployments, cloning the wallet to live replicas, or running a second process against either database. An immediate deployment accepts brief downtime while preserving one wallet writer.

The manual [API workflow](../.github/workflows/api-deploy.yml) uses the GitHub environment `donation-api`; configure its `FLY_API_TOKEN` with an app-scoped token for this API. Keep it separate from the existing frontend deployment token. The workflow type-checks/tests the backend before deployment. Provision the volume/seed/DNS first. Do not merge the frontend switch until the API is reachable: the frontend's existing workflow deploys `main` automatically.

Before accepting normal donations, make one controlled payment and verify that it progresses to confirmed, appears exactly once, survives restart, and increases the frontend pool by that amount over 400,000 sats. Repeat with a signed identity, and rehearse a restore. Live payment/issuance and WebSocket-fallback behavior still need this operational rehearsal; the implementation check created and recovered an unpaid Minibits invoice without sending funds.

Implementation verification on 2026-10-24 passed 18 backend tests, seven frontend store tests, type checks, lint, and the Next.js production build. Browser checks covered anonymous/signed requests, fresh invoices after lost responses, paid/confirmed states, totals, expiry, signature rejection, and an outage after payment. The complete API also passed live Minibits startup, readiness, graceful shutdown and restart checks with temporary empty databases. The container image was not built locally because Docker was unavailable; production provisioning and a funded payment test have not been performed.

## Backup, restore and operations

Back up both databases as one generation, along with the deployed version and mint URL. Store encrypted copies outside the running machine; keep the seed recovery material separately. A seed alone does not restore donation metadata or all operational associations. Fly's scheduled volume snapshots are useful recovery points, not a substitute for an independently retained backup and a tested restore.

For a portable filesystem backup, stop the API gracefully and verify it has exited, then archive the entire data directory, including any remaining `-wal` and `-shm` files. Restart only after the copy finishes. Never copy just live SQLite main files: uncheckpointed WAL entries can contain funds or donation associations. A consistent snapshot of the entire stopped volume is also suitable. On Fly, disable proxy autostart during planned backup/restore maintenance so a request cannot restart the writer, wait for the machine to be stopped, and snapshot its whole volume before resuming it. Use the provider's volume snapshot/export facilities for the off-machine copy.

Restore into a separate, private environment with the same pinned packages, mint and original seed. Stop the original writer before starting a restored wallet: never run two active copies. Restore the complete pair/WAL files to an empty data directory, run SQLite `PRAGMA integrity_check` on each, then start the service. Confirm `/healthz`, the public total/count, known operation IDs through the status endpoint, and Coco's recovered balance/operations before switching traffic. Restore testing must not publish a second donation endpoint. Never discard a current wallet database merely to make a fingerprint check pass.

For app-level triage, query the metadata database through a private shell with a read-only SQLite connection. This prints counts of stored requests and attributed donors, including unpaid invoices. Payment totals and states must be inspected through Coco or the HTTP read endpoints:

```sh
bun -e '
import { Database } from "bun:sqlite";
const db = new Database(`${process.env.DATA_DIR ?? "./data"}/app.sqlite`, { readonly: true });
console.log(db.query("SELECT count(*) AS requests, count(donor_pubkey) AS attributed FROM donations").all());
db.close();
'
```

Alert on sustained `paid` or `review` operations, rising pending quote counts, failing HTTP health checks, low disk space, and stale backups. Request failures are logged without raw wallet objects. A `review` state needs private inspection of Coco's operation and quote. Do not count an error-finalized operation solely because the mint says issued.

Wallet balance inspection and eventual prize transfers belong to a private operator session using Coco's API and the same seed/database, with the public service stopped and a fresh backup retained. There is no public spending endpoint. Do not publish raw Coco operations or proofs in logs or support tickets. Keep that wallet under a single operator/writer during payout, then restart the service so Coco's watchers can resume.

If the frontend is rolled back, keep this API and wallet watching already-issued invoices. The legacy donation path has a separate ledger; its payments will not appear in this API's totals. Do not roll back a database across an incompatible migration; restore/rehearse the appropriate version and matching data together.

Earlier Lightning verification passed 30 tests, including feed reads without Coco lookups, duplicate finalization events, missed-event catch-up, finalization before metadata insertion, cache-write failure recovery, operation IDs shared across responses, internal quote IDs, mint-supplied amount bounds, Hono middleware behavior, exact-byte NIP-98 verification and schema migration preservation. Eight frontend tests cover opaque Coco operation IDs and donation totals. Type checks, lint and the production build also pass. Browser checks cover loading/retrying limits, invalid responses, disabled presets, boundary validation, amounts above the old app cap, an absent maximum and mobile layout with mocked API responses. In-memory rate limits intentionally reset on restart; they assume the existing single API process.

Cashu integration verification on 2026-10-26 passed 54 backend tests, nine frontend tests, both TypeScript checks, lint and the production build. The Cashu tests use the real Coco 2.0.0 manager and Bun SQLite repositories against an intercepted test mint with real proof signing and swapping. They cover encoding, duplicates, spent/forged proofs, callback validation, concurrent delivery, lost responses, startup recovery, origin rules, body/rate limits, attributed donations and migration of previously confirmed records. Browser checks against mocked API responses covered Cashu selection and independent bounds, QR/copy controls, mobile layout, review/confirmed states and the Lightning wallet link, with no page errors. No funded Minibits payment or external wallet interoperability check was performed.
