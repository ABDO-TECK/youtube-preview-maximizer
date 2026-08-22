import assert from 'node:assert/strict';
import test from 'node:test';
import { MockInlinePlayer } from '../mock-player.js';
import { createPayloadSession } from '../payload.js';

test('prepares an inline player and loads clean content', async () => {
  const events = [];
  const player = new MockInlinePlayer({ onEvent: (event) => events.push(event) });
  player.preparePlayer();
  const result = await player.loadVideoById('video-clean', { scenario: 'clean', generation: 1 });
  assert.equal(result.rawHadAds, false);
  assert.equal(events.includes('ad-showing'), false);
  assert.equal(events.at(-1), 'content-playing');
});

test('reuses the same inner player and resets prior ad state', async () => {
  const player = new MockInlinePlayer();
  player.preparePlayer();
  const inner = player.inner;
  await player.loadVideoById('video-preroll', { scenario: 'preroll', generation: 1 });
  await player.loadVideoById('video-clean', { scenario: 'clean', generation: 2 });
  assert.equal(player.inner, inner);
  assert.equal(player.inner.classes.size, 0);
  assert.equal(player.state, 'content-playing');
});

test('sanitized pre-roll reaches content without entering ad lifecycle', async () => {
  const events = [];
  const session = createPayloadSession({ generation: 3, videoId: 'video-preroll' });
  const player = new MockInlinePlayer({
    sanitizer: (response, context) => session.sanitize(response, context),
    onEvent: (event) => events.push(event)
  });
  const result = await player.loadVideoById('video-preroll', { scenario: 'preroll', generation: 3 });
  assert.deepEqual(result.removedPaths, ['adPlacements', 'playerAds', 'adSlots']);
  assert.equal(events.includes('ad-showing'), false);
  assert.equal(player.state, 'content-playing');
});
