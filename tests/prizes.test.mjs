import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Prizes from '../src/app/components/Prizes.tsx';

test('all six prizes share the same loading state before hydration', () => {
  const html = renderToStaticMarkup(createElement(Prizes));
  const cards = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match => match[1]);
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.ok(!card.includes('prize-card-scene'), 'a prize rendered before the shared loading boundary');
    assert.ok(card.includes('aria-hidden="true"'), 'a prize is missing its loading placeholder');
  }
});
