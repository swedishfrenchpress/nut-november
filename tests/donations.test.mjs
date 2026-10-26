import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDonationStore, parseDonationFeed } from '../src/app/lib/donations.ts';
import { getDonationMessagePreview, isDonationPayment } from '../shared/donations.ts';

const item = (amount = 1001, id = 'one') => ({ id, amount, content: 'LFG!', createdAt: 1790000000, donorPubkey: null });
const feed = (...donations) => ({ donations, donationCount: donations.length, donationTotal: donations.reduce((sum, d) => sum + d.amount, 0) });

test('payment responses accept opaque Coco operation IDs instead of requiring UUIDs', () => {
  const payment = { id: 'zY1pQ_t7Vf-A3k2mX9nL4w', amountSats: 21, invoice: 'lnbc-test', expiresAt: null, status: 'pending', paymentReceived: false };
  assert.equal(isDonationPayment(payment), true);
  assert.equal(parseDonationFeed(feed(item(21, payment.id))).donations[0].id, payment.id);
  for (const id of ['', null, undefined, 42]) assert.equal(isDonationPayment({ ...payment, id }), false);
});

function harness({ cached = null, unavailable = false } = {}) {
  let raw = JSON.stringify(cached);
  let handlers;
  let closes = 0;
  let connections = 0;
  const options = {
    cacheKey: 'api-donations-test',
    getStorage() {
      if (unavailable) throw new Error('Storage denied');
      return { getItem: () => raw, setItem: (_, value) => { raw = value; } };
    },
    connect(value) { connections++; handlers = value; return () => { closes++; }; },
  };
  const store = createDonationStore(options);
  return { store, options, get handlers() { return handlers; }, get closes() { return closes; }, get connections() { return connections; } };
}

test('empty backend contributes zero; frontend adds sponsorship exactly once', () => {
  const h = harness();
  const stop = h.store.subscribe(() => {});
  h.handlers.snapshot(feed());
  const value = h.store.getSnapshot();
  assert.equal(value.donationTotal, 0);
  assert.equal(value.donationCount, 0);
  assert.equal(value.total, 400000);
  assert.deepEqual(value.prizes, { golden: 150000, hardest: 100000, nuttiest: 50000, design: 50000, fresh: 50000 });
  stop();
});

test('hydrates cached API snapshots before connecting, then replaces them with authoritative corrections', () => {
  const h = harness({ cached: feed(item()) });
  assert.equal(h.store.getServerSnapshot().donations.length, 0);
  const initial = h.store.getSnapshot();
  assert.equal(initial.total, 401001);
  assert.equal(initial.isStale, true);
  assert.equal(h.connections, 0);
  assert.equal(h.store.getSnapshot(), initial);
  const stop = h.store.subscribe(() => {});
  h.handlers.snapshot(feed(item(21, 'new')));
  assert.deepEqual(h.store.getSnapshot().donations.map(d => d.id), ['new']);
  assert.equal(h.store.getSnapshot().total, 400021);
  assert.equal(h.store.getSnapshot().isStale, false);
  h.handlers.snapshot(feed());
  assert.equal(h.store.getSnapshot().total, 400000);
  stop();
});

test('all consumers share one connection and repeated snapshots never double count', () => {
  const h = harness();
  const stopProvider = h.store.subscribe(() => {});
  let hero, history;
  const stopHero = h.store.subscribe(() => { hero = h.store.getSnapshot(); });
  const stopHistory = h.store.subscribe(() => { history = h.store.getSnapshot(); });
  assert.equal(h.connections, 1);
  h.handlers.snapshot(feed(item(), item(21000, 'two')));
  h.handlers.snapshot(feed(item(), item(21000, 'two')));
  assert.equal(hero, history);
  assert.equal(hero.total, 422001);
  assert.equal(hero.prizes.golden, 154400);
  assert.deepEqual(hero.donations.map(d => d.amount), [21000, 1001]);
  stopHero(); stopHistory();
  assert.equal(h.closes, 0);
  stopProvider();
  assert.equal(h.closes, 1);
});

test('network failure retains saved totals, marks them stale, and clears on recovery', () => {
  const h = harness({ cached: feed(item()) });
  const stop = h.store.subscribe(() => {});
  h.handlers.error();
  assert.equal(h.store.getSnapshot().donationTotal, 1001);
  assert.equal(h.store.getSnapshot().isStale, true);
  assert.ok(h.store.getSnapshot().error);
  h.handlers.snapshot(feed(item(21)));
  assert.equal(h.store.getSnapshot().error, null);
  stop();
});

test('invalid aggregates, repeated IDs, malformed identity and old receipt arrays are rejected', () => {
  for (const value of [null, {}, [{ kind: 9735 }], { ...feed(item()), donationTotal: 999999 },
    feed(item(), item()), feed({ ...item(), amount: Infinity }), feed({ ...item(), donorPubkey: 'bad' })]) {
    assert.equal(parseDonationFeed(value), null);
  }
  const h = harness({ cached: [{ kind: 9735 }] });
  assert.equal(h.store.getSnapshot().donationCount, 0);
});

test('missing or corrupt storage does not prevent updates; late callbacks after unmount are ignored', () => {
  const h = harness({ unavailable: true });
  const stop = h.store.subscribe(() => {});
  h.handlers.snapshot(feed(item()));
  const stale = h.handlers;
  stop();
  const stopAgain = h.store.subscribe(() => {});
  stale.snapshot(feed(item(9999)));
  assert.equal(h.store.getSnapshot().donationTotal, 1001);
  h.handlers.snapshot(feed(item(21)));
  assert.equal(h.store.getSnapshot().donationTotal, 21);
  stopAgain();
});

test('messages unlock strictly above 1000 sats and preserve Unicode characters', () => {
  assert.equal(getDonationMessagePreview(1000, 'hidden'), '');
  assert.equal(getDonationMessagePreview(1001, ' hello '), 'hello');
  assert.equal(Array.from(getDonationMessagePreview(1001, '🌰'.repeat(300))).length, 256);
});
