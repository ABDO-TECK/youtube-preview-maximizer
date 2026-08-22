import assert from 'node:assert/strict';
import test from 'node:test';
import { createPayloadSession, sanitizePlayerResponse } from '../payload.js';
import { createMockPlayerResponse } from '../mock-network.js';

test('removes only configured ad branches and preserves normal fields', () => {
  const raw = createMockPlayerResponse('video-preroll', 'preroll');
  const original = JSON.stringify(raw);
  const result = sanitizePlayerResponse(raw, { generation: 1, videoId: 'video-preroll' });
  assert.deepEqual(result.removedPaths, ['adPlacements', 'playerAds', 'adSlots']);
  assert.equal(JSON.stringify(raw), original);
  assert.deepEqual(result.response.videoDetails, raw.videoDetails);
  assert.deepEqual(result.response.streamingData, raw.streamingData);
  assert.deepEqual(result.response.captions, raw.captions);
  assert.deepEqual(result.response.storyboards, raw.storyboards);
  assert.deepEqual(result.response.playbackTracking, raw.playbackTracking);
});

test('fails safe for mismatch and malformed responses', () => {
  const raw = createMockPlayerResponse('video-preroll', 'preroll');
  const mismatch = sanitizePlayerResponse(raw, { generation: 1, videoId: 'video-other' });
  assert.equal(mismatch.response, raw);
  const malformed = sanitizePlayerResponse({ adPlacements: [] }, { generation: 1, videoId: 'x' });
  assert.deepEqual(malformed.response, { adPlacements: [] });
});

test('new generation invalidates the old session', () => {
  const diagnostics = [];
  const session = createPayloadSession({ generation: 1, videoId: 'a', diagnostics });
  session.invalidate();
  const raw = createMockPlayerResponse('a', 'preroll');
  assert.equal(session.sanitize(raw, { generation: 1, videoId: 'a' }).response, raw);
  assert.equal(diagnostics.at(-1).event, 'payloadBypass');
});
