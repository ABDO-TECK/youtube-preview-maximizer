const AD_PATHS = Object.freeze([
  Object.freeze(['adPlacements']),
  Object.freeze(['playerAds']),
  Object.freeze(['adSlots']),
  Object.freeze(['auxiliary', 'playerAds']),
  Object.freeze(['playbackContext', 'adSlots'])
]);

const pathName = (path) => path.join('.');
const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
const hasPath = (value, path) => {
  const parent = path.slice(0, -1).reduce((node, key) => node && node[key], value);
  return Boolean(parent && Object.prototype.hasOwnProperty.call(parent, path.at(-1)));
};
const removePath = (value, path) => {
  const parent = path.slice(0, -1).reduce((node, key) => node[key], value);
  if (parent && Object.prototype.hasOwnProperty.call(parent, path.at(-1))) delete parent[path.at(-1)];
};
const validResponse = (response) => Boolean(response && typeof response === 'object' && !Array.isArray(response) &&
  response.videoDetails && typeof response.videoDetails === 'object' &&
  response.streamingData && typeof response.streamingData === 'object');

export function createPayloadSession({ generation, videoId, loadId = `load-${generation}`, diagnostics = [], mode = 'single-player-response' }) {
  const current = { generation, videoId, loadId, active: true, matchedResponses: 0, sanitizedResponses: 0, consumed: false };
  const log = (event, details = {}) => diagnostics.push({ event, generation, videoId, loadId, elapsedMs: 0, ...details });
  log('sessionCreated');
  const bypass = (response, reason) => { log('payloadBypass', { reason }); return { response, removedPaths: [], sanitized: false, consumed: false, reason }; };
  return {
    get stats() { return { generation, videoId, loadId, matchedResponses: current.matchedResponses, sanitizedResponses: current.sanitizedResponses, consumed: current.consumed }; },
    invalidate(reason = 'stale-generation') { current.active = false; log('sessionInvalidated', { reason }); },
    cancel() { current.active = false; log('sessionInvalidated', { reason: 'cancelled' }); },
    sanitize(response, context = {}) {
      if (!current.active || context.generation !== generation) return bypass(response, 'stale-generation');
      if (context.videoId !== videoId) return bypass(response, 'video-mismatch');
      if (context.requestType && context.requestType !== 'player') return bypass(response, 'non-player-response');
      if (current.consumed || (mode === 'single-player-response' && current.sanitizedResponses > 0)) return bypass(response, 'session-consumed');
      if (!validResponse(response)) return bypass(response, 'malformed-response');
      if (response.videoDetails.videoId !== videoId) return bypass(response, 'response-video-mismatch');
      current.matchedResponses += 1;
      log('sanitizerMatched');
      const sanitized = clone(response);
      const removedPaths = AD_PATHS.filter((path) => hasPath(sanitized, path));
      removedPaths.forEach((path) => removePath(sanitized, path));
      current.sanitizedResponses += 1;
      current.consumed = true;
      current.active = false;
      log('sanitizerRemovedPaths', { paths: removedPaths.map(pathName) });
      return { response: sanitized, removedPaths: removedPaths.map(pathName), sanitized: true, consumed: true };
    }
  };
}

export function sanitizePlayerResponse(response, context = {}) {
  const diagnostics = [];
  const session = createPayloadSession({ ...context, diagnostics });
  return { ...session.sanitize(response, context), diagnostics, sessionStats: session.stats };
}

export { AD_PATHS };
