import assert from 'node:assert/strict';
import { afterEach, jest, test } from 'bun:test';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { createDonationStore } from '../src/app/lib/donations.ts';
import { createDonorProfileStore, parseDonorProfile } from '../src/app/lib/donorProfiles.ts';

const senderKey = new Uint8Array(32).fill(2);
const otherKey = new Uint8Array(32).fill(4);
const thirdKey = new Uint8Array(32).fill(5);
const sender = getPublicKey(senderKey);
const other = getPublicKey(otherKey);
const third = getPublicKey(thirdKey);
const item = (donorPubkey = sender, id = 'one') => ({ id, amount: 1001, content: 'Go nuts!', createdAt: 100, donorPubkey });
const feed = (...donations) => ({ donations, donationCount: donations.length, donationTotal: donations.reduce((sum, d) => sum + d.amount, 0) });

function profile({ key = senderKey, createdAt = 100, metadata = { name: 'squirrel', display_name: 'Squirrel', picture: 'https://example.com/avatar.png' }, content = JSON.stringify(metadata), kind = 0 } = {}) {
  return finalizeEvent({ kind, created_at: createdAt, content, tags: [] }, key);
}

const cleanups = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((stop) => stop());
  jest.useRealTimers();
});

function harness({ cached = '[]', unavailable = false, full = false, donations: cachedDonations = null, immediateFeed } = {}) {
  let donationHandlers;
  let donationConnections = 0;
  let donationCloses = 0;
  const donations = createDonationStore({
    cacheKey: 'test-donations',
    getStorage: () => ({ getItem: () => JSON.stringify(cachedDonations), setItem() {} }),
    connect(handlers) {
      donationConnections++;
      donationHandlers = handlers;
      if (immediateFeed) handlers.snapshot(immediateFeed);
      return () => { donationCloses++; };
    },
  });
  let raw = cached;
  let writes = 0;
  const connections = [];
  const store = createDonorProfileStore({
    donations,
    getStorage() {
      if (unavailable) throw new Error('Storage denied');
      return {
        getItem: () => raw,
        setItem: (key, value) => {
          assert.equal(key, 'nutnovember:donor-profiles:v1');
          if (full) throw new Error('Storage full');
          raw = value;
          writes++;
        },
      };
    },
    connect(authors, handlers) {
      const connection = { authors, handlers, closes: 0 };
      connections.push(connection);
      return () => { connection.closes++; };
    },
  });
  function subscribe(listener = () => {}) {
    const stop = store.subscribe(listener);
    cleanups.push(stop);
    return stop;
  }
  return { store, donations, subscribe, connections, get handlers() { return donationHandlers; },
    get raw() { return raw; }, get writes() { return writes; },
    get donationConnections() { return donationConnections; }, get donationCloses() { return donationCloses; } };
}

test('first snapshot reads verified cached profiles without connecting or writing', () => {
  const valid = profile();
  const h = harness({ cached: JSON.stringify([valid, valid, { ...valid, content: 'tampered' }, null]) });
  assert.equal(h.store.getServerSnapshot().size, 0);
  const snapshot = h.store.getSnapshot();
  assert.equal(snapshot.size, 1);
  assert.equal(snapshot.get(sender).name, 'Squirrel');
  assert.equal(h.store.getSnapshot(), snapshot);
  assert.equal(h.connections.length, 0);
  assert.equal(h.donationConnections, 0);
  assert.equal(h.writes, 0);
});

test('cached donor keys sync immediately and independently of API availability', () => {
  const h = harness({ donations: feed(item(), item(sender, 'repeat'), item(other, 'other'), item(null, 'anon')),
    cached: JSON.stringify([profile()]) });
  h.subscribe();
  assert.equal(h.donations.getSnapshot().isStale, true);
  assert.equal(h.store.getSnapshot().get(sender).name, 'Squirrel');
  assert.equal(h.connections.length, 1);
  assert.deepEqual(h.connections[0].authors.sort(), [sender, other].sort());
  h.handlers.error();
  assert.equal(h.connections.length, 1);
  h.connections[0].handlers.onevent(profile({ createdAt: 200, metadata: { name: 'Fresh' } }));
  assert.equal(h.store.getSnapshot().get(sender).name, 'Fresh');
  assert.equal(h.donations.getSnapshot().donationTotal, 4004);
});

test('API snapshots batch unique authors and repeated polls never refetch missing profiles', () => {
  jest.useFakeTimers();
  const h = harness();
  h.subscribe();
  assert.equal(h.connections.length, 0);
  h.handlers.snapshot(feed(item(), item(null, 'anon')));
  h.handlers.snapshot(feed(item(), item(other, 'other'), item(null, 'anon')));
  jest.advanceTimersByTime(999);
  assert.equal(h.connections.length, 0);
  jest.advanceTimersByTime(1);
  assert.equal(h.connections.length, 1);
  assert.deepEqual(h.connections[0].authors.sort(), [sender, other].sort());
  h.connections[0].handlers.onclose(); // Neither donor has metadata on these relays.
  h.handlers.snapshot(feed(item(), item(other, 'other')));
  h.handlers.error();
  jest.advanceTimersByTime(20_000);
  assert.equal(h.connections.length, 1);
  h.handlers.snapshot(feed(item(), item(other, 'other'), item(third, 'new')));
  jest.advanceTimersByTime(1000);
  assert.equal(h.connections.length, 2);
  assert.deepEqual(h.connections[1].authors, [third]);
});

test('empty, anonymous and removed donations never produce unrestricted or obsolete queries', () => {
  jest.useFakeTimers();
  const h = harness();
  h.subscribe();
  h.handlers.snapshot(feed());
  h.handlers.snapshot(feed(item(null)));
  jest.advanceTimersByTime(1000);
  assert.equal(h.connections.length, 0);
  h.handlers.snapshot(feed(item()));
  h.handlers.snapshot(feed());
  jest.advanceTimersByTime(1000);
  assert.equal(h.connections.length, 0);
});

test('large feeds split authors across bounded filters without losing or duplicating keys', () => {
  const authors = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(64, '0'));
  const h = harness({ donations: feed(...authors.map((author, i) => item(author, String(i)))) });
  h.subscribe();
  assert.deepEqual(h.connections.map(({ authors }) => authors.length), [100, 100, 5]);
  assert.deepEqual(h.connections.flatMap(({ authors }) => authors).sort(), authors.sort());
});

test('only requested authors with valid signatures update and persist the latest metadata', () => {
  const old = profile();
  const newest = profile({ createdAt: 200, metadata: { name: 'New name' } });
  const h = harness({ cached: JSON.stringify([old]), donations: feed(item()) });
  let notifications = 0;
  h.subscribe(() => { notifications++; });
  const snapshot = h.store.getSnapshot();
  const { onevent } = h.connections[0].handlers;
  onevent(profile({ key: otherKey }));
  onevent({ ...JSON.parse(JSON.stringify(newest)), content: 'tampered' });
  onevent(profile({ kind: 1 }));
  assert.equal(h.store.getSnapshot(), snapshot);
  onevent(newest);
  onevent(old);
  onevent(newest);
  assert.equal(h.store.getSnapshot().size, 1);
  assert.deepEqual(h.store.getSnapshot().get(sender), { name: 'New name', picture: undefined });
  assert.equal(notifications, 1);
  assert.equal(h.writes, 1);
  assert.deepEqual(JSON.parse(h.raw), [JSON.parse(JSON.stringify(newest))]);
  const reloaded = harness({ cached: h.raw });
  assert.equal(reloaded.store.getSnapshot().get(sender).name, 'New name');
});

test('equal timestamps keep the lowest event id regardless of arrival order', () => {
  const events = [profile(), profile({ metadata: { name: 'Another name' } })].sort((a, b) => a.id.localeCompare(b.id));
  for (const ordered of [events, [...events].reverse()]) {
    const h = harness({ cached: JSON.stringify(ordered) });
    assert.equal(h.store.getSnapshot().get(sender).name, parseDonorProfile(events[0]).name);
  }
});

test('metadata validates JSON shape, name fallbacks and avatar URL protocols', () => {
  for (const content of ['null', '[]', '42', '"name"', '{broken']) {
    assert.equal(parseDonorProfile(profile({ content })), null);
  }
  for (const picture of ['javascript:alert(1)', 'data:image/svg+xml,test', '/relative.png', 123]) {
    assert.deepEqual(parseDonorProfile(profile({ metadata: { display_name: ' ', name: '  squirrel  ', picture } })), { name: 'squirrel', picture: undefined });
  }
  assert.deepEqual(parseDonorProfile(profile({ metadata: { name: {}, display_name: 42 } })), { name: undefined, picture: undefined });
  assert.equal(parseDonorProfile(profile({ createdAt: -1 })), null);
  assert.equal(parseDonorProfile(null), null);
});

test('corrupt, unavailable or full storage never blocks profiles or donation totals', () => {
  for (const options of [{ cached: '{broken' }, { cached: 'null' }, { unavailable: true }, { full: true }]) {
    const h = harness({ ...options, donations: feed(item()) });
    h.subscribe();
    h.connections[0].handlers.onevent(profile());
    assert.equal(h.store.getSnapshot().get(sender).name, 'Squirrel');
    assert.equal(h.donations.getSnapshot().donationTotal, 1001);
  }
});

test('provider and page share one sync; final cleanup cancels batches, timers and stale callbacks', () => {
  jest.useFakeTimers();
  const h = harness({ donations: feed(item()) });
  const stopProvider = h.subscribe();
  const stopPage = h.subscribe();
  assert.equal(h.donationConnections, 1);
  assert.equal(h.connections.length, 1);
  h.connections[0].handlers.onevent(profile());
  stopPage();
  const stopNextPage = h.subscribe();
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].closes, 0);
  h.handlers.snapshot(feed(item(), item(other, 'other')));
  stopNextPage();
  stopProvider();
  assert.equal(h.connections[0].closes, 1);
  assert.equal(h.donationCloses, 1);
  jest.advanceTimersByTime(1000);
  assert.equal(h.connections.length, 1);
  const snapshot = h.store.getSnapshot();
  h.connections[0].handlers.onevent(profile({ createdAt: 300 }));
  assert.equal(h.store.getSnapshot(), snapshot);
  h.subscribe();
  assert.equal(h.connections.length, 2);
  h.connections[0].handlers.onevent(profile({ createdAt: 400 }));
  assert.equal(h.store.getSnapshot(), snapshot);
});

test('closed batch callbacks are ignored and a synchronous donation response starts only one batch', () => {
  jest.useFakeTimers();
  const h = harness({ immediateFeed: feed(item()) });
  h.subscribe();
  assert.equal(h.connections.length, 1);
  jest.advanceTimersByTime(1000);
  assert.equal(h.connections.length, 1);
  h.connections[0].handlers.onclose();
  h.connections[0].handlers.onevent(profile());
  assert.equal(h.store.getSnapshot().size, 0);
});
