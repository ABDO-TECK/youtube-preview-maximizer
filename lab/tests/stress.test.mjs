import assert from 'node:assert/strict';
import test from 'node:test';
import { MockInlinePlayer } from '../mock-player.js';
import { createMockPlayerResponse } from '../mock-network.js';
import { AD_PATHS, createPayloadSession, sanitizePlayerResponse } from '../payload.js';

const sessionFor = ({ generation, videoId }) => createPayloadSession({ generation, videoId, loadId: `load-${generation}-${videoId}` });

test('sanitizer precedes consumption and nested paths are removed exactly', async () => {
  const events = [];
  const player = new MockInlinePlayer({ sanitizerFactory: sessionFor, onEvent: (event) => events.push(event) });
  const result = await player.loadVideoById('video-nested', { scenario: 'nested', generation: 1 });
  assert.deepEqual(result.removedPaths, ['adPlacements', 'auxiliary.playerAds', 'playbackContext.adSlots']);
  assert.equal(events.includes('ad-showing'), false);
  assert.equal(player.events.some((event) => event.event === 'responseConsumptionStarted'), true);
});

test('ad-like substring keys are preserved', () => {
  const raw = createMockPlayerResponse('video-nested', 'nested');
  const result = sanitizePlayerResponse(raw, { generation: 1, videoId: 'video-nested' });
  assert.deepEqual(result.response.metadata, raw.metadata);
  assert.deepEqual(AD_PATHS.map((path) => path.join('.')), ['adPlacements', 'playerAds', 'adSlots', 'auxiliary.playerAds', 'playbackContext.adSlots']);
});

test('delayed A cannot affect B', async () => {
  const player = new MockInlinePlayer({ sanitizerFactory: sessionFor });
  const a = player.loadVideoById('video-a', { scenario: 'preroll', generation: 1, delayMs: 40 });
  const b = player.loadVideoById('video-b', { scenario: 'clean', generation: 2, delayMs: 5 });
  const [aResult, bResult] = await Promise.all([a, b]);
  assert.equal(aResult.stale, true);
  assert.equal(bResult.videoId, 'video-b');
  assert.equal(player.videoId, 'video-b');
  assert.equal(player.lifecycleState, 'CONTENT_PLAYING');
});

test('stale ad state is cleared while reusing video and inner nodes', async () => {
  const player = new MockInlinePlayer({ sanitizer: (response) => ({ response, removedPaths: [] }) });
  const inner = player.preparePlayer();
  const video = inner.video;
  await player.loadVideoById('video-a', { scenario: 'preroll', generation: 1 });
  await player.loadVideoById('video-b', { scenario: 'clean', generation: 2 });
  await player.loadVideoById('video-c', { scenario: 'clean', generation: 3 });
  assert.equal(player.inner, inner);
  assert.equal(player.inner.video, video);
  assert.equal(player.inner.classes.size, 0);
  assert.equal(player.lifecycleState, 'CONTENT_PLAYING');
});

test('duplicate player response: first matching response wins', () => {
  const session = sessionFor({ generation: 4, videoId: 'video-dup' });
  const first = session.sanitize(createMockPlayerResponse('video-dup', 'preroll'), { generation: 4, videoId: 'video-dup' });
  const secondRaw = createMockPlayerResponse('video-dup', 'preroll');
  const second = session.sanitize(secondRaw, { generation: 4, videoId: 'video-dup' });
  assert.equal(first.consumed, true);
  assert.equal(second.response, secondRaw);
  assert.equal(second.reason, 'stale-generation');
  assert.equal(session.stats.sanitizedResponses, 1);
});

test('cancellation prevents content continuation', async () => {
  const player = new MockInlinePlayer({ sanitizerFactory: sessionFor });
  const pending = player.loadVideoById('video-a', { scenario: 'preroll', generation: 1, delayMs: 20 });
  player.cancel();
  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(player.lifecycleState, 'CANCELLED');
  assert.equal(player.events.some((event) => event.event === 'CONTENT_PLAYING'), false);
});

test('malformed partial payload fails safe before consumption', async () => {
  const player = new MockInlinePlayer({ sanitizerFactory: sessionFor });
  const result = await player.loadVideoById('video-malformed', { scenario: 'malformed', generation: 1 });
  assert.equal(result.error, 'malformed-response');
  assert.equal(player.lifecycleState, 'ERROR');
  assert.equal(player.events.some((event) => event.event === 'responseConsumptionStarted'), false);
});

test('deep-frozen input remains unchanged after cloning sanitizer', () => {
  const raw = createMockPlayerResponse('video-nested', 'nested');
  Object.freeze(raw.auxiliary.playerAds); Object.freeze(raw.auxiliary); Object.freeze(raw.playbackContext.adSlots); Object.freeze(raw.playbackContext); Object.freeze(raw);
  const result = sanitizePlayerResponse(raw, { generation: 1, videoId: 'video-nested' });
  assert.equal(result.sanitized, true);
  assert.ok(raw.auxiliary.playerAds);
});

test('sanitizer off control group enters mock ad lifecycle', async () => {
  const events = [];
  const player = new MockInlinePlayer({ sanitizer: (response) => ({ response, removedPaths: [] }), onEvent: (event) => events.push(event) });
  await player.loadVideoById('video-preroll', { scenario: 'preroll', generation: 1 });
  assert.deepEqual(events.filter((event) => event.startsWith('ad-')), ['ad-created', 'ad-showing', 'ad-interrupting']);
});
