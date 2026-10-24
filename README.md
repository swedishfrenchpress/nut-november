# Nut November

Next.js frontend and a separate Bun donation API. Coco owns the Cashu wallet at the Minibits mint; Drizzle owns the donation records in a second SQLite database. Anonymous donations and Nostr-verified donor identity are supported. Only successfully collected donations enter the public feed. The frontend adds the 400,000-sat sponsor commitment.

## Development

Use Node 22 and Bun 1.3.14. From the repository root:

```sh
npm ci
bun install --cwd server --frozen-lockfile
cp .env.example .env.local
cp server/.env.example server/.env
```

Generate a seed for a **new development wallet** without printing it. Keep this file and the wallet databases across restarts; never regenerate the seed for an existing wallet.

```sh
bun -e '
const path = "server/.env";
const text = await Bun.file(path).text();
if (!/^COCO_SEED_HEX=$/m.test(text)) throw new Error("Seed already configured");
const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("hex");
await Bun.write(path, text.replace(/^COCO_SEED_HEX=$/m, `COCO_SEED_HEX=${seed}`));
'
chmod 600 server/.env
```

Run `npm run api:dev` and `npm run dev` in separate terminals. Open <http://localhost:3000>. The API runs at <http://localhost:3001>; migrations run on startup. The default mint is the real Minibits mint, so paying a development invoice sends real sats to the development wallet. Automated tests use an in-process wallet fake and temporary databases.

## Checks

```sh
npm test
npm run api:test
npm run api:typecheck
npx tsc --noEmit
npm run lint
npm run build
```

The frontend uses `NEXT_PUBLIC_DONATION_API_URL` at build time. Development defaults to `http://localhost:3001`; production defaults to `https://api.nutnovember.org`. Configure the API's `PUBLIC_API_URL` and exact `CORS_ORIGINS` accordingly. Signed requests bind to that public URL.

See [API, deployment and recovery](server/README.md) and the [design investigation](docs/coco-donation-research.md). The existing frontend deploys on pushes to `main`; provision the API before merging the frontend cutover. API deployment is a separate manual workflow.
