'use strict';

importScripts('caption-utils.js');

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const MAX_PLAYER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTION_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 4500;
const CATALOG_CACHE_TTL_MS = 30000;
const CUE_CACHE_TTL_MS = 30000;
const MAX_CACHE_ENTRIES = 16;
const MAX_IN_FLIGHT_REQUESTS = 2;
const SERVICE_SOURCE = 'ytpm-caption-service';

const utils = globalThis.YTPMCaptionUtils;
const catalogCache = new Map();
const cueCache = new Map();
const pendingCatalogs = new Map();
const pendingCues = new Map();
let inFlightRequests = 0;

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(cache, key, value, ttl) {
  cache.delete(key);
  cache.set(key, { value: value, expiresAt: Date.now() + ttl });

  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

async function readTextWithLimit(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Response exceeds size limit');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    if (!Number.isFinite(declaredLength)) {
      throw new Error('Response cannot be bounded');
    }

    const text = await response.text();
    if (new Blob([text]).size > maxBytes) {
      throw new Error('Response exceeds size limit');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('Response exceeds size limit');
      }

      chunks.push(decoder.decode(result.value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function fetchPlayerResponse(videoId) {
  const normalizedVideoId = utils.normalizeVideoId(videoId);
  if (!normalizedVideoId) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const url = new URL('/watch', YOUTUBE_ORIGIN);
    url.searchParams.set('v', normalizedVideoId);

    const response = await fetch(url.href, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const html = await readTextWithLimit(response, MAX_PLAYER_RESPONSE_BYTES);
    return utils.extractJsonObject(html, 'ytInitialPlayerResponse');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCaptionCatalog(videoId) {
  const normalizedVideoId = utils.normalizeVideoId(videoId);
  if (!normalizedVideoId) {
    return {
      available: false,
      tracks: [],
      translationLanguages: [],
      videoId: '',
      duration: 0,
      storyboard: null
    };
  }

  const cached = cacheGet(catalogCache, normalizedVideoId);
  if (cached) {
    return cached;
  }

  const pending = pendingCatalogs.get(normalizedVideoId);
  if (pending) {
    return pending;
  }

  const request = fetchPlayerResponse(normalizedVideoId)
    .then(function (response) {
      const catalog = utils.buildCaptionCatalog(response, YOUTUBE_ORIGIN, normalizedVideoId);
      cacheSet(catalogCache, normalizedVideoId, catalog, CATALOG_CACHE_TTL_MS);
      return catalog;
    });

  pendingCatalogs.set(normalizedVideoId, request);

  try {
    return await request;
  } finally {
    pendingCatalogs.delete(normalizedVideoId);
  }
}

function normalizeProvidedCaptionTrack(track) {
  return utils.normalizeCaptionTrack(track, YOUTUBE_ORIGIN, 0);
}

async function fetchCaptionCues(videoId, trackId, targetLanguage, providedTrack) {
  const normalizedVideoId = utils.normalizeVideoId(videoId);
  if (!normalizedVideoId) {
    return { ok: false, cues: [] };
  }

  let track = normalizeProvidedCaptionTrack(providedTrack);

  if (!track) {
    const catalog = await getCaptionCatalog(normalizedVideoId);
    track = catalog.tracks.find(function (candidate) {
      return candidate.id === String(trackId || '').slice(0, 20);
    });
  }

  if (!track) {
    return { ok: false, cues: [] };
  }

  const language = utils.normalizeLanguage(targetLanguage).toLowerCase();
  const cacheKey = [normalizedVideoId, track.baseUrl, language].join(':');
  const cached = cacheGet(cueCache, cacheKey);
  if (cached) {
    return cached;
  }

  const pending = pendingCues.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = (async function () {
    const captionUrl = utils.getSafeCaptionUrl(track.baseUrl, YOUTUBE_ORIGIN);
    if (!captionUrl) {
      return { ok: false, cues: [] };
    }

    captionUrl.searchParams.set('fmt', 'json3');
    if (language && language !== track.languageCode) {
      captionUrl.searchParams.set('tlang', language);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(captionUrl.href, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      });

      if (!response.ok) {
        return { ok: false, cues: [] };
      }

      const text = await readTextWithLimit(
        response,
        MAX_CAPTION_RESPONSE_BYTES
      );
      const cues = utils.parseJsonCaptionCues(text);
      const result = {
        ok: cues.length > 0,
        cues: cues,
        rawCaptionText: cues.length ? '' : text,
        track: {
          languageCode: language || track.languageCode,
          label: track.label
        }
      };

      cacheSet(cueCache, cacheKey, result, CUE_CACHE_TTL_MS);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  pendingCues.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingCues.delete(cacheKey);
  }
}

function isAuthorizedSender(sender) {
  const tabUrl = sender && sender.tab && sender.tab.url;
  if (typeof tabUrl !== 'string' || !sender || sender.frameId !== 0) {
    return false;
  }

  try {
    return new URL(tabUrl).origin === YOUTUBE_ORIGIN;
  } catch (error) {
    return false;
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (
    !message ||
    message.source !== SERVICE_SOURCE ||
    !isAuthorizedSender(sender)
  ) {
    return false;
  }

  const command = message.command;
  if (command !== 'caption-tracks' && command !== 'fetch-captions') {
    sendResponse({ ok: false, error: 'Unknown command' });
    return false;
  }

  if (inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
    sendResponse({ ok: false, error: 'Caption service busy' });
    return false;
  }

  inFlightRequests += 1;
  const payload = message.payload && typeof message.payload === 'object' &&
    !Array.isArray(message.payload)
    ? message.payload
    : {};

  Promise.resolve().then(function () {
    if (command === 'caption-tracks') {
      return getCaptionCatalog(payload.videoId);
    }

    return fetchCaptionCues(
      payload.videoId,
      payload.trackId,
      payload.targetLanguage,
      payload.track
    );
  }).then(function (result) {
    sendResponse(result);
  }).catch(function () {
    sendResponse({ ok: false, error: 'Caption service failed' });
  }).finally(function () {
    inFlightRequests -= 1;
  });

  return true;
});
