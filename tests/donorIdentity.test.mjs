import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nip19 } from 'nostr-tools';
import DonorIdentity from '../src/app/donations/DonorIdentity.tsx';

const pubkey = 'a'.repeat(64);
const npub = nip19.npubEncode(pubkey);
const profile = { name: 'Squirrel', picture: 'https://example.com/avatar.png' };
const render = (props) => renderToStaticMarkup(createElement(DonorIdentity, props));

test('identified donations show their cached name, avatar and profile link', () => {
  const html = render({ pubkey, profile });
  assert.ok(html.includes('Squirrel'));
  assert.ok(html.includes(profile.picture));
  assert.ok(html.includes(`https://primal.net/p/${npub}`));
  assert.ok(html.includes('referrerPolicy="no-referrer"'));
});

test('anonymous donations never display a supplied profile', () => {
  const html = render({ pubkey: null, profile });
  assert.ok(html.includes('Anonymous'));
  assert.ok(!html.includes('Squirrel'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<a'));
});

test('missing metadata falls back to a placeholder and shortened npub', () => {
  const html = render({ pubkey });
  assert.ok(html.includes(`${npub.slice(0, 12)}…${npub.slice(-6)}`));
  assert.ok(html.includes('?'));
  assert.ok(!html.includes('<img'));
});

test('hiding one donation suppresses its profile without changing other donations by that author', () => {
  const hidden = render({ pubkey, profile, hidden: true });
  assert.ok(!hidden.includes(profile.name));
  assert.ok(!hidden.includes(profile.picture));
  assert.ok(!hidden.includes('<img'));
  assert.ok(hidden.includes('?'));
  assert.ok(hidden.includes(`${npub.slice(0, 12)}…${npub.slice(-6)}`));
  assert.ok(render({ pubkey, profile }).includes(profile.name));
});
