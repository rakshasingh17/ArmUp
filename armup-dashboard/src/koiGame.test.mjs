import test from 'node:test';
import assert from 'node:assert/strict';
import { pickKind, KINDS, MODES } from './koiGame.js';

test('first flowers are always pink, so a new patient starts easy', () => {
  for (const r of [0, 0.05, 0.2, 0.9]) assert.equal(pickKind(r, 0), 'pink');
  assert.equal(pickKind(0, 2), 'pink');
});

test('later flowers: gold is rarest, then purple, then pink', () => {
  assert.equal(pickKind(0.05, 5), 'gold');
  assert.equal(pickKind(0.2, 5), 'lilac');
  assert.equal(pickKind(0.6, 5), 'pink');
});

test('rarer flowers are worth more points', () => {
  assert.ok(KINDS.pink.pts < KINDS.lilac.pts && KINDS.lilac.pts < KINDS.gold.pts);
});

test('only Active mode has a rival and expiring gold; Calm has neither', () => {
  assert.equal(MODES.calm.rival, false);
  assert.equal(MODES.calm.expire, false);
  assert.equal(MODES.active.rival, true);
  assert.ok(MODES.active.buds >= MODES.calm.buds && MODES.calm.buds >= 2);
});
