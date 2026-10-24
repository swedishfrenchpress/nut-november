# Coco donation backend design

The donation endpoint follows one synchronous sequence:

1. Validate the amount/message and optional Nostr identity signature.
2. Create the mint quote and prepare its operation through Coco, which persists both.
3. Save the donation metadata with the operation ID in the app database.
4. Return the operation's payment request to the browser.

Each submission creates a new invoice. Creation failures return an error; the user can request a new invoice later. No request idempotency, resumable creation or application retry worker is needed. The invoice is exposed only after the donation metadata has been committed.

## Ownership

Use Bun with two SQLite files on one persistent volume. Coco owns `coco.sqlite`; Drizzle owns `app.sqlite`. Each has its own connection and migrations. The mint is `https://mint.minibits.cash/Bitcoin`, using fixed-amount BOLT11 quotes in sats.

The donations table stores exactly:

| Column | Purpose |
| --- | --- |
| `id` | Private, unpredictable payment-status reference. |
| `public_id` | Public feed ID, also usable for hiding a donation message. |
| `operation_id` | Unique association with Coco's persisted mint operation. |
| `message` | Donor's public message. |
| `donor_pubkey` | Optional pubkey obtained from a verified Nostr signature. |

Coco remains authoritative for amounts, payment requests, expiry, payment/collection state, errors and operation timestamps. The backend reads these through Coco's public interfaces; it neither mirrors payment state in Drizzle nor queries Coco's private SQL schema. The app database additionally stores request rate counters and the wallet seed fingerprint/mint binding.

The public feed joins donation metadata to locally persisted Coco operations. It contains only `finalized` operations without errors. Count and total are calculated from the same returned list. A missing Coco record causes a read failure rather than an apparently smaller donation total. The current wallet balance is not a donation total: later prize payouts must not remove earlier donations.

The campaign starts with a fresh ledger. No legacy receipts are imported. The frontend adds the 400,000-sat sponsorship and allocates it as 150,000 / 100,000 / 50,000 / 50,000 / 50,000 sats, plus `floor(donationTotal / 5)` per prize. Messages unlock above 1,000 sats, accept 280 UTF-16 code units, and display at most 256 Unicode code points.

## Verified Coco interface

Both `@cashu/coco-core` and `@cashu/coco-sqlite-bun` are pinned to **2.0.0**, with a committed Bun lockfile. Their installed implementation and tagged source were checked. The Bun adapter accepts a `bun:sqlite` connection. `initializeCoco()` initializes persistence, enables watchers/processors and runs recovery. The stable seed provider returns 64 bytes across restarts. [Coco release](https://github.com/cashubtc/coco/releases/tag/v2.0.0), [Bun adapter](https://github.com/cashubtc/coco/blob/v2.0.0/packages/sqlite-bun/README.md), [initialization](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/Manager.ts).

```ts
const quote = await manager.quotes.mint.create({
  mintUrl: 'https://mint.minibits.cash/Bitcoin',
  method: 'bolt11', unit: 'sat', amount, locked: true,
});
const operation = await manager.ops.mint.prepare({
  quote: { mintUrl: quote.mintUrl, quoteId: quote.quoteId, method: 'bolt11' },
  amount,
});
// Persist donor metadata and operation.id, then return operation.request.
```

`prepare()` persists an operation before returning it. The operation includes its amount, payment request, expiry, quote ID, state, errors and timestamps. Coco generates its operation ID; arbitrary donor metadata does not belong in this interface. [Quote interface](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/api/QuoteApi.ts), [mint operation interface](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/api/MintOpsApi.ts), [operation model](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/operations/mint/MintOperation.ts).

Read operations with `manager.ops.mint.get(id)` and quotes with `manager.quotes.mint.get({ mintUrl, quoteId })`. These are local persistence lookups. `refresh()` performs remote checks/recovery and is not used by browser-facing reads. Only explicit public fields are serialized: complete Coco records contain private wallet material. [Mint operation implementation](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/operations/mint/MintOperationService.ts).

## Watchers, events and failures

Coco's watchers observe payment and its processors issue/recover ecash automatically. Hybrid transport uses WebSockets with polling fallback. The API needs no event listeners because status and totals are derived from current persisted Coco state on each request. Events that occur before metadata insertion or while the app is offline cannot leave a separate app payment projection stale. [Watcher](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/services/watchers/MintOperationWatcherService.ts), [transport](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/infra/HybridTransport.ts).

A crash before metadata insertion may leave an unused Coco quote/operation. A lost response after insertion may leave an unused donation record. The browser has not obtained that response's invoice, and the next submission creates a new one. These are accepted outcomes; records are not reconstructed into application jobs. Once an invoice has been received, its private reference remains usable across page/server restarts.

Payment and collection remain distinct. Quote `amountPaid`/`amountIssued` establish payment observation; a successful finalized operation establishes collection. Coco 2.0.0 can finalize an already-issued operation with an error when proofs cannot be recovered. That yields `review`, contributes nothing to the public total, and tells the payer not to pay again. Pending-but-paid yields `paid`. Status labels are derived response fields, not stored application state. [Quote model](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/models/MintQuote.ts), [mint recovery branches](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/operations/mint/MintOperationService.ts).

Coco's automatic processing is not an unlimited retry guarantee. Stalled paid/executing operations or error-finalized operations need operator inspection through Coco. This application deliberately adds no second retry mechanism. Quote expiry is advisory for collection: hide expired payment controls while still allowing a late observed payment to complete. [Processor](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/services/watchers/MintOperationProcessor.ts), [claimability](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/models/MintQuoteClaimability.ts).

## Identity and HTTP

`POST /donate` accepts `{ amountSats, message? }` and returns 201 with a prepared invoice, private status reference, amount, expiry and derived status. It does not accept an idempotency key or return a resumable creation reference. `GET /donate/:id` reads a known donation's latest state. `GET /donations` returns confirmed donations plus donation-only count and sum.

Anonymous requests have no authorization. Attributed requests use the browser's NIP-07 signer to create a NIP-98 event for the configured public `POST /donate` URL, with a SHA-256 payload tag covering the exact amount/message body. Verify kind 27235, empty content, ID/signature, timestamp within 60 seconds, and the exact URL/method/body hash. Invalid supplied authorization returns 401. Store the verified pubkey only; no relay publication, signed-event archive or replay ledger is needed. Repeated valid requests within the signature window create separate invoices. A signature proves the request author, not the Lightning wallet that pays. [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md), [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md).

The browser never automatically retries invoice creation. It can poll status for an invoice it has already received, saving that reference in session storage for refreshes. Public totals refresh independently and retain a versioned stale snapshot during outages. Request failures allow a deliberate new submission. Donation-message hiding uses public feed IDs; private payment references and Coco operation/quote IDs stay out of the feed.

## Runtime and deployment

Invoice creation is serialized because Coco 2.0.0 allocates NUT-20 quote keys with a read/write sequence. The pending-quote cap reads Coco, including orphan quotes, inside that serialization. Per-client/global rate limits also bound requests. Run one wallet process with a stable seed and persistent volume. Never run active clones of the wallet database. [Key allocation](https://github.com/cashubtc/coco/blob/v2.0.0/packages/core/services/KeyRingService.ts), [storage responsibilities](https://github.com/cashubtc/coco/blob/v2.0.0/packages/docs/pages/storage-adapters.md).

Minibits advertised BOLT11/sat amounts from 1 to 1,000,000 sats, WebSocket quote subscriptions and NUT-20. Its active sat keyset checked on 2026-10-24 was compatible with Coco v2.0.0. A live unpaid-invoice smoke check exercised locked quote creation, preparation, shutdown and recovery of the same operation/invoice with Bun 1.3.14. No funds were sent. [Mint information](https://mint.minibits.cash/Bitcoin/v1/info), [keysets](https://mint.minibits.cash/Bitcoin/v1/keysets).

Deployment remains a separate Fly app at `api.nutnovember.org`, with `/data`, one active process and automatic stopping disabled. Preserve both databases and their SQLite journals together, plus separate seed recovery material. Read [server/README.md](../server/README.md) for provisioning, backup/restore and operator procedures. Production provisioning, a funded payment, WebSocket-fallback validation and a restoration rehearsal remain launch work. The frontend deploys on merges to `main`, so the API must be ready before merging its frontend cutover.
