(function () {
  'use strict';

  const MESSAGE_SOURCE = 'ytpm-page-bridge';
  const REQUEST_ID_PATTERN = /^request-\d{1,12}$/;
  const ALLOWED_COMMANDS = new Set([
    'quality-info',
    'set-quality',
    'caption-catalog',
    'fetch-captions',
    'captions-info',
    'set-captions-enabled',
    'seek-preview'
  ]);
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const PREVIEW_SELECTOR = 'ytd-video-preview';
  const PREVIEW_PLAYER_SELECTOR = [
    '#inline-preview-player',
    '.html5-video-player',
    'ytd-player#inline-player'
  ].join(', ');
  const MAX_CAPTION_RESPONSE_BYTES = 1024 * 1024;
  const CAPTION_REQUEST_TIMEOUT_MS = 4500;
  const CAPTION_STATE_TIMEOUT_MS = 450;
  const CAPTION_STATE_POLL_MS = 50;
  const MAX_SEEK_SECONDS = 86400;
  const DEBUG_LOGGING = false;
  const captionTrackMemory = new WeakMap();

  const currentScript = document.currentScript;
  const BRIDGE_NONCE = currentScript && currentScript.dataset
    ? currentScript.dataset.ytpmPageBridgeNonce
    : '';

  if (!BRIDGE_NONCE) {
    return;
  }

  function debugLog(scope, message, details) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' ||
      typeof console.debug !== 'function') {
      return;
    }

    console.debug('[YTPM][' + scope + ']', message, details || {});
  }

  function isRequest(data) {
    return Boolean(
      data &&
      data.source === MESSAGE_SOURCE &&
      data.nonce === BRIDGE_NONCE &&
      data.type === 'request' &&
      typeof data.id === 'string' &&
      REQUEST_ID_PATTERN.test(data.id) &&
      typeof data.command === 'string' &&
      ALLOWED_COMMANDS.has(data.command)
    );
  }

  function postBridgeMessage(message) {
    window.postMessage(Object.assign({
      source: MESSAGE_SOURCE,
      nonce: BRIDGE_NONCE
    }, message), window.location.origin);
  }

  function getVideoData(player) {
    if (!player || typeof player.getVideoData !== 'function') {
      return null;
    }

    try {
      const data = player.getVideoData();
      return data && typeof data === 'object' ? data : null;
    } catch (error) {
      return null;
    }
  }

  function getApiPlayer(candidate) {
    if (!candidate) {
      return null;
    }

    if (typeof candidate.getAvailableQualityLevels === 'function' ||
      typeof candidate.setPlaybackQuality === 'function' ||
      typeof candidate.setPlaybackQualityRange === 'function' ||
      typeof candidate.getOption === 'function' ||
      typeof candidate.setOption === 'function' ||
      typeof candidate.getPlayerResponse === 'function' ||
      typeof candidate.getPlayerResponseData === 'function' ||
      typeof candidate.seekTo === 'function' ||
      typeof candidate.getCurrentTime === 'function') {
      return candidate;
    }

    const nestedPlayer = candidate.querySelector &&
      candidate.querySelector('.html5-video-player');
    return nestedPlayer || null;
  }

  function normalizeVideoId(value) {
    const normalized = String(value || '')
      .replace(/^(watch|shorts|live):/, '');

    return VIDEO_ID_PATTERN.test(normalized) ? normalized : '';
  }

  function getVideoIdFromUrl(value) {
    if (typeof value !== 'string' || !value) {
      return '';
    }

    try {
      const url = new URL(value, window.location.href);
      const watchId = normalizeVideoId(url.searchParams.get('v'));
      if (watchId) {
        return watchId;
      }

      const match = url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/);
      return match ? normalizeVideoId(match[1]) : '';
    } catch (error) {
      return '';
    }
  }

  function getPreviewVideoId(preview) {
    if (!preview || typeof preview.querySelectorAll !== 'function') {
      return '';
    }

    const links = preview.querySelectorAll(
      '#media-container-link[href], a[href*="/watch"], a[href*="/shorts/"], a[href*="/live/"]'
    );
    for (const link of links) {
      const videoId = getVideoIdFromUrl(link.href || link.getAttribute('href'));
      if (videoId) {
        return videoId;
      }
    }

    const players = preview.querySelectorAll(PREVIEW_PLAYER_SELECTOR);
    for (const player of players) {
      const data = getVideoData(player) || getVideoData(getApiPlayer(player));
      const videoId = normalizeVideoId(data && data.video_id);
      if (videoId) {
        return videoId;
      }
    }

    return '';
  }

  function getPreviewContext(videoId) {
    const normalizedVideoId = normalizeVideoId(videoId);
    const previews = Array.from(document.querySelectorAll(PREVIEW_SELECTOR));
    const activePreviews = previews.filter(function (preview) {
      return preview.hasAttribute('active');
    });
    const matchingPreviews = normalizedVideoId
      ? previews.filter(function (preview) {
        return getPreviewVideoId(preview) === normalizedVideoId;
      })
      : [];
    const preview = matchingPreviews.find(function (candidate) {
      return candidate.hasAttribute('active');
    }) || matchingPreviews[0] || (
      activePreviews.length === 1 &&
      (!normalizedVideoId || !getPreviewVideoId(activePreviews[0]))
        ? activePreviews[0]
        : null
    );

    if (!preview) {
      return null;
    }

    const player = preview.querySelector(PREVIEW_PLAYER_SELECTOR) || preview;
    return {
      preview: preview,
      player: getApiPlayer(player) || player
    };
  }

  function readPlayerCurrentTime(player) {
    if (!player || typeof player.getCurrentTime !== 'function') {
      return null;
    }

    try {
      const value = Number(player.getCurrentTime());
      return Number.isFinite(value) && value >= 0 && value <= MAX_SEEK_SECONDS
        ? value
        : null;
    } catch (error) {
      return null;
    }
  }

  function seekPreview(player, context, seconds, allowSeekAhead) {
    const targetTime = Math.max(0, Math.min(MAX_SEEK_SECONDS, Number(seconds)));
    const playerFound = Boolean(context && player);
    const before = readPlayerCurrentTime(player);
    if (!playerFound || typeof player.seekTo !== 'function') {
      return {
        ok: false,
        available: playerFound,
        playerFound: playerFound,
        seekToAvailable: false,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: before
      };
    }

    try {
      player.seekTo(targetTime, allowSeekAhead === true);
      const after = readPlayerCurrentTime(player);
      debugLog('Seek', 'player seekTo', {
        requestedTime: targetTime,
        playerFound: true,
        playerSeekToAvailable: true,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: after,
        allowSeekAhead: allowSeekAhead === true
      });
      return {
        ok: true,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: after
      };
    } catch (error) {
      debugLog('Seek', 'player seekTo failed', {
        requestedTime: targetTime,
        playerFound: true,
        playerSeekToAvailable: true,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: readPlayerCurrentTime(player),
        allowSeekAhead: allowSeekAhead === true
      });
      return {
        ok: false,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: readPlayerCurrentTime(player)
      };
    }
  }

  function getPlayerResponse(player) {
    const candidates = [];

    if (player) {
      ['getPlayerResponse', 'getPlayerResponseData'].some(function (methodName) {
        if (typeof player[methodName] !== 'function') {
          return false;
        }

        try {
          const response = player[methodName]();
          if (response) {
            candidates.push(response);
            return true;
          }
        } catch (error) {
          // Try the next available page-world source.
        }
        return false;
      });
    }

    candidates.push(window.ytInitialPlayerResponse);
    if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      candidates.push(window.ytplayer.config.args.player_response);
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (typeof candidate === 'string') {
        if (candidate.length > 2 * 1024 * 1024) {
          continue;
        }

        try {
          return JSON.parse(candidate);
        } catch (error) {
          continue;
        }
      }

      if (typeof candidate === 'object') {
        return candidate;
      }
    }

    return null;
  }

  function readCaptionText(value) {
    if (typeof value === 'string') {
      return value.slice(0, 200);
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    if (typeof value.simpleText === 'string') {
      return value.simpleText.slice(0, 200);
    }

    if (Array.isArray(value.runs)) {
      return value.runs.map(function (run) {
        return run && typeof run.text === 'string' ? run.text : '';
      }).join('').slice(0, 200);
    }

    return '';
  }

  function getSafeCaptionUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length > 4096) {
      return '';
    }

    try {
      const url = new URL(rawUrl, window.location.origin);
      if (
        url.protocol !== 'https:' ||
        url.origin !== window.location.origin ||
        url.pathname !== '/api/timedtext' ||
        url.username ||
        url.password
      ) {
        return '';
      }
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function normalizeCaptionLanguage(value) {
    const language = String(value || '').trim().toLowerCase();
    return /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(language)
      ? language
      : 'und';
  }

  function getApiCaptionCatalogTracks(player) {
    return getCaptionTrackList(player).map(function (track, index) {
      const baseUrl = getSafeCaptionUrl(track.baseUrl);
      if (!baseUrl) {
        return null;
      }

      const languageCode = normalizeCaptionLanguage(track.languageCode);
      return {
        id: String(index),
        baseUrl: baseUrl,
        languageCode: languageCode,
        label: readCaptionText(track.name) || languageCode,
        kind: typeof track.kind === 'string' ? track.kind.slice(0, 32) : ''
      };
    }).filter(Boolean);
  }

  function getCaptionCatalog(player, requestedVideoId) {
    const response = getPlayerResponse(player);
    if (!response || typeof response !== 'object') {
      const apiTracks = getApiCaptionCatalogTracks(player);
      const fallbackVideoId = normalizeVideoId(requestedVideoId);
      return {
        ok: Boolean(apiTracks.length),
        available: apiTracks.length > 0,
        tracks: apiTracks,
        translationLanguages: [],
        videoId: fallbackVideoId,
        duration: 0,
        storyboard: null
      };
    }

    const requestedId = normalizeVideoId(requestedVideoId);
    const responseId = normalizeVideoId(
      response.videoDetails && response.videoDetails.videoId
    );
    if (requestedId && responseId && requestedId !== responseId) {
      return {
        ok: false,
        available: false,
        tracks: [],
        translationLanguages: [],
        videoId: '',
        duration: 0,
        storyboard: null
      };
    }

    const videoId = requestedId || responseId;
    const renderer = response.captions &&
      response.captions.playerCaptionsTracklistRenderer;
    const rawTracks = renderer && Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks.slice(0, 100)
      : [];
    let tracks = rawTracks.map(function (track, index) {
      if (!track || typeof track !== 'object') {
        return null;
      }

      const baseUrl = getSafeCaptionUrl(track.baseUrl);
      if (!baseUrl) {
        return null;
      }

      return {
        id: String(index),
        baseUrl: baseUrl,
        languageCode: normalizeCaptionLanguage(track.languageCode),
        label: readCaptionText(track.name) || normalizeCaptionLanguage(track.languageCode),
        kind: typeof track.kind === 'string' ? track.kind.slice(0, 32) : ''
      };
    }).filter(Boolean);
    if (!tracks.length) {
      tracks = getApiCaptionCatalogTracks(player);
    }
    const translationLanguages = renderer && Array.isArray(renderer.translationLanguages)
      ? renderer.translationLanguages.slice(0, 100).map(function (language) {
        if (!language || typeof language !== 'object') {
          return null;
        }

        const languageCode = normalizeCaptionLanguage(language.languageCode);
        return languageCode === 'und'
          ? null
          : {
            languageCode: languageCode,
            label: readCaptionText(language.languageName) || languageCode
          };
      }).filter(Boolean)
      : [];
    const storyboardRenderer = response.storyboards &&
      response.storyboards.playerStoryboardSpecRenderer;
    const storyboard = storyboardRenderer && typeof storyboardRenderer.spec === 'string'
      ? {
        spec: storyboardRenderer.spec.slice(0, 8192),
        recommendedLevel: Number(storyboardRenderer.recommendedLevel)
      }
      : null;

    return {
      ok: Boolean(tracks.length || storyboard),
      available: tracks.length > 0,
      tracks: tracks,
      translationLanguages: translationLanguages,
      videoId: videoId,
      duration: Number(response.videoDetails && response.videoDetails.lengthSeconds),
      storyboard: storyboard
    };
  }

  function normalizeCaptionTrackForFetch(track, fallbackId) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const baseUrl = getSafeCaptionUrl(track.baseUrl);
    if (!baseUrl) {
      return null;
    }

    return {
      id: String(track.id || fallbackId).slice(0, 32),
      baseUrl: baseUrl,
      languageCode: normalizeCaptionLanguage(track.languageCode),
      label: readCaptionText(track.label || track.name) || 'Captions'
    };
  }

  async function readCaptionResponseWithLimit(response) {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTION_RESPONSE_BYTES) {
      throw new Error('Caption response exceeds size limit');
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      if (text.length > MAX_CAPTION_RESPONSE_BYTES) {
        throw new Error('Caption response exceeds size limit');
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
        if (totalBytes > MAX_CAPTION_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Caption response exceeds size limit');
        }

        chunks.push(decoder.decode(result.value, { stream: true }));
      }

      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock();
    }
  }

  async function fetchCaptionCues(videoId, trackId, targetLanguage, providedTrack, player) {
    const normalizedVideoId = normalizeVideoId(videoId);
    if (!normalizedVideoId || typeof fetch !== 'function') {
      return { ok: false, cues: [], rawCaptionText: '' };
    }

    let track = normalizeCaptionTrackForFetch(providedTrack, trackId);
    if (!track) {
      const catalog = getCaptionCatalog(player, normalizedVideoId);
      track = catalog && catalog.tracks.find(function (candidate) {
        return candidate.id === String(trackId || '').slice(0, 32);
      });
    }

    if (!track) {
      return { ok: false, cues: [], rawCaptionText: '' };
    }

    const captionUrl = new URL(track.baseUrl);
    const urlVideoId = normalizeVideoId(captionUrl.searchParams.get('v'));
    if (urlVideoId !== normalizedVideoId) {
      return { ok: false, cues: [], rawCaptionText: '' };
    }

    const language = normalizeCaptionLanguage(targetLanguage);
    captionUrl.searchParams.set('fmt', 'json3');
    if (language !== 'und' && language !== track.languageCode) {
      captionUrl.searchParams.set('tlang', language);
    }

    const controller = typeof AbortController === 'function'
      ? new AbortController()
      : null;
    const timeoutId = controller
      ? window.setTimeout(function () {
        controller.abort();
      }, CAPTION_REQUEST_TIMEOUT_MS)
      : 0;

    try {
      const response = await fetch(captionUrl.href, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) {
        return { ok: false, cues: [], rawCaptionText: '' };
      }

      const rawCaptionText = await readCaptionResponseWithLimit(response);
      return {
        ok: rawCaptionText.length > 0,
        cues: [],
        rawCaptionText: rawCaptionText,
        track: {
          languageCode: language !== 'und' ? language : track.languageCode,
          label: track.label
        }
      };
    } catch (error) {
      return { ok: false, cues: [], rawCaptionText: '' };
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function normalizeQualityLevel(level) {
    const value = String(level || 'auto').toLowerCase();
    return value === 'default' ? 'auto' : value;
  }

  function getQualityInfo(player) {
    if (!player || typeof player.getAvailableQualityLevels !== 'function') {
      return { ok: false, levels: [], canSet: false, current: 'auto' };
    }

    let levels = [];
    let current = 'auto';

    try {
      const availableLevels = player.getAvailableQualityLevels();
      levels = Array.from(new Set(
        (Array.isArray(availableLevels) ? availableLevels : [])
          .filter(function (level) {
            return typeof level === 'string' && level.length <= 32;
          })
          .map(normalizeQualityLevel)
          .filter(Boolean)
      ));
    } catch (error) {
      levels = [];
    }

    try {
      if (typeof player.getPlaybackQuality === 'function') {
        current = normalizeQualityLevel(player.getPlaybackQuality() || 'auto');
      }
    } catch (error) {
      current = 'auto';
    }

    const canSet = typeof player.setPlaybackQualityRange === 'function' ||
      typeof player.setPlaybackQuality === 'function';

    return {
      ok: Boolean(levels.length && canSet),
      levels: levels,
      canSet: canSet,
      current: current
    };
  }

  function setQuality(player, level) {
    if (!player) {
      return { ok: false, levels: [], canSet: false, current: 'auto' };
    }

    const info = getQualityInfo(player);
    const requestedLevel = normalizeQualityLevel(level);
    const isAllowed = requestedLevel === 'auto' ||
      info.levels.includes(requestedLevel);

    if (!isAllowed) {
      return {
        ok: false,
        levels: info.levels,
        canSet: info.canSet,
        current: info.current
      };
    }

    const apiLevel = requestedLevel === 'auto' ? 'default' : requestedLevel;
    let called = false;

    try {
      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(apiLevel);
        called = true;
      }
    } catch (error) {
      // The single-method fallback below may still be supported.
    }

    try {
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(apiLevel);
        called = true;
      }
    } catch (error) {
      // Keep the successful method when the other one is available.
    }

    const updated = getQualityInfo(player);
    return {
      ok: called,
      levels: updated.levels,
      canSet: updated.canSet,
      current: updated.current
    };
  }

  function getOption(player, moduleName, optionName) {
    if (!player || typeof player.getOption !== 'function') {
      return null;
    }

    try {
      return player.getOption(moduleName, optionName);
    } catch (error) {
      return null;
    }
  }

  function toArray(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value.length === 'number') {
      try {
        return Array.from(value);
      } catch (error) {
        return [];
      }
    }

    if (value && Array.isArray(value.tracks)) {
      return value.tracks;
    }

    return [];
  }

  function getCaptionTrackList(player) {
    let availableCaptionTracks = null;
    try {
      availableCaptionTracks = player &&
        typeof player.getAvailableCaptionTracks === 'function'
        ? player.getAvailableCaptionTracks()
        : null;
    } catch (error) {
      availableCaptionTracks = null;
    }

    const candidates = [
      getOption(player, 'captions', 'tracklist'),
      getOption(player, 'captions', 'tracks'),
      availableCaptionTracks
    ];

    for (const candidate of candidates) {
      const tracks = toArray(candidate).filter(function (track) {
        return track && typeof track === 'object';
      }).slice(0, 100);

      if (tracks.length) {
        return tracks;
      }
    }

    return [];
  }

  function isVisibleNode(node) {
    if (!node || !node.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      rect.width > 0 && rect.height > 0;
  }

  function getCaptionControlCandidates(context) {
    const roots = [];
    if (context && context.preview) {
      roots.push(context.preview);
    }
    if (context && context.player && !roots.includes(context.player)) {
      roots.push(context.player);
    }
    if (!roots.length && context && typeof context.querySelectorAll === 'function') {
      roots.push(context);
    }

    const selectors = [
      '.ytmClosedCaptioningButtonButton',
      '.ytp-subtitles-button',
      '[role="button"][aria-label*="caption" i]',
      '[role="button"][aria-label*="subtitle" i]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="subtitle" i]'
    ];
    const seen = new Set();
    const candidates = [];

    roots.forEach(function (root) {
      selectors.forEach(function (selector) {
        root.querySelectorAll(selector).forEach(function (candidate) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            candidates.push(candidate);
          }
        });
      });
    });

    return candidates;
  }

  function findCaptionControl(context) {
    const candidates = getCaptionControlCandidates(context);
    return candidates.find(isVisibleNode) || candidates[0] || null;
  }

  function findCaptionRenderer(context) {
    const roots = [];
    if (context && context.player) {
      roots.push(context.player);
    }
    if (context && context.preview && !roots.includes(context.preview)) {
      roots.push(context.preview);
    }

    for (const root of roots) {
      const renderer = root.querySelector(
        '.ytp-caption-window-container, ' +
        '#ytp-caption-window-container, ' +
        '[class*="caption-window" i]'
      );
      if (renderer) {
        return renderer;
      }
    }

    return null;
  }

  function readVisibleCaptionText(renderer) {
    if (!renderer || !renderer.isConnected) {
      return '';
    }

    const captionWindows = Array.from(renderer.querySelectorAll('.caption-window'))
      .filter(isVisibleNode);
    if (!captionWindows.length && !isVisibleNode(renderer)) {
      return '';
    }
    const roots = captionWindows.length ? captionWindows : [renderer];
    const seenSegments = new Set();
    const segmentText = [];
    roots.forEach(function (root) {
      const candidates = [];
      if (root.matches && root.matches('.ytp-caption-segment, [class*="caption-segment" i]')) {
        candidates.push(root);
      }
      candidates.push.apply(candidates, root.querySelectorAll(
        '.ytp-caption-segment, [class*="caption-segment" i]'
      ));
      candidates.forEach(function (segment) {
        if (seenSegments.has(segment) || !isVisibleNode(segment)) {
          return;
        }
        seenSegments.add(segment);
        const text = String(segment.textContent || '').replace(/[ \t]+/g, ' ').trim();
        if (text) {
          segmentText.push(text);
        }
      });
    });
    const text = segmentText.length
      ? segmentText.join('\n')
      : roots.filter(isVisibleNode).map(function (root) {
        return String(root.innerText || root.textContent || '');
      }).join('\n');

    return text.replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      return line.replace(/[ \t]+/g, ' ').trim();
    }).filter(function (line, index, lines) {
      return line && (index === 0 || line !== lines[index - 1]);
    }).join('\n').slice(0, 8192);
  }

  function resolveCaptionEnabledState(controlState, hasShowingTextTrack, hasVisibleRendererText) {
    if (controlState === true) {
      return true;
    }
    if (controlState === false) {
      return false;
    }
    return Boolean(hasShowingTextTrack || hasVisibleRendererText);
  }

  function findPlayerVideos(player) {
    const seen = new Set();
    const videos = [];

    if (player && typeof player.querySelectorAll === 'function') {
      player.querySelectorAll('video').forEach(function (video) {
        seen.add(video);
        videos.push(video);
      });
    }

    document.querySelectorAll('video.ytpm-overlay__video, ytd-video-preview[active] video')
      .forEach(function (video) {
        if (!seen.has(video)) {
          seen.add(video);
          videos.push(video);
        }
      });

    return videos;
  }

  function hasShowingTextTrack(player) {
    return findPlayerVideos(player).some(function (video) {
      return video.textTracks && Array.from(video.textTracks).some(function (track) {
        return (track.kind === 'captions' || track.kind === 'subtitles') &&
          track.mode === 'showing';
      });
    });
  }

  function hasTextTracks(player) {
    return findPlayerVideos(player).some(function (video) {
      return video.textTracks && Array.from(video.textTracks).some(function (track) {
        return track.kind === 'captions' || track.kind === 'subtitles';
      });
    });
  }

  function getCaptionControlState(button) {
    if (!button) {
      return null;
    }

    if (button.getAttribute('aria-pressed') === 'true' ||
      button.classList.contains('ytp-button-active')) {
      return true;
    }

    if (button.getAttribute('aria-pressed') === 'false') {
      return false;
    }

    const label = [
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || ''
    ].join(' ');
    if (/turned off|turn on|enable|show/i.test(label)) {
      return false;
    }
    if (/turned on|turn off|disable|hide/i.test(label)) {
      return true;
    }
    return null;
  }

  function getCaptionInfo(player, context) {
    const button = findCaptionControl(context || player);
    const trackList = getCaptionTrackList(player);
    const selectedTrack = getOption(player, 'captions', 'track');
    const controlState = getCaptionControlState(button);
    const rendererText = readVisibleCaptionText(findCaptionRenderer(context || player));
    const safeSelectedTrack = safeTrackValue(selectedTrack);
    if (player && (typeof player === 'object' || typeof player === 'function') &&
      safeSelectedTrack) {
      captionTrackMemory.set(player, safeSelectedTrack);
    }
    const available = Boolean(
      button ||
      trackList.length ||
      hasTextTracks(player) ||
      selectedTrack ||
      (player && typeof player.setOption === 'function')
    );

    return {
      available: available,
      enabled: resolveCaptionEnabledState(
        controlState,
        hasShowingTextTrack(player),
        Boolean(rendererText)
      ),
      buttonState: controlState
    };
  }

  function safeTrackValue(track) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const value = {};
    ['languageCode', 'vssId', 'kind', 'name'].forEach(function (property) {
      if (typeof track[property] === 'string' && track[property].length <= 200) {
        value[property] = track[property];
      }
    });
    return Object.keys(value).length ? value : null;
  }

  async function waitForCaptionState(player, context, desiredEnabled) {
    const deadline = Date.now() + CAPTION_STATE_TIMEOUT_MS;
    let latest = getCaptionInfo(player, context);

    while (Date.now() < deadline) {
      if (latest.enabled === desiredEnabled) {
        return latest;
      }
      await new Promise(function (resolve) {
        window.setTimeout(resolve, CAPTION_STATE_POLL_MS);
      });
      latest = getCaptionInfo(player, context);
    }

    return latest;
  }

  async function setCaptionsEnabled(player, context, desiredEnabled) {
    const desired = desiredEnabled === true;
    const info = getCaptionInfo(player, context);
    if (!info.available) {
      return { ok: false, available: false, enabled: false };
    }

    if (info.enabled === desired) {
      debugLog('Captions', 'desired state already active', {
        desiredEnabled: desired,
        nativeEnabledBefore: info.enabled,
        nativeEnabledAfter: info.enabled,
        nativeButtonClicked: false,
        setOptionUsed: false
      });
      return {
        ok: true,
        available: true,
        enabled: info.enabled,
        buttonClicked: false,
        setOptionUsed: false
      };
    }

    const button = findCaptionControl(context);
    if (button && typeof button.click === 'function') {
      try {
        button.click();
        const updated = await waitForCaptionState(player, context, desired);
        const result = {
          ok: updated.enabled === desired,
          available: updated.available,
          enabled: updated.enabled,
          buttonClicked: true,
          setOptionUsed: false
        };
        debugLog('Captions', 'native button result', {
          desiredEnabled: desired,
          nativeEnabledBefore: info.enabled,
          nativeEnabledAfter: updated.enabled,
          nativeButtonClicked: true,
          setOptionUsed: false,
          ok: result.ok
        });
        return result;
      } catch (error) {
        const latest = getCaptionInfo(player, context);
        debugLog('Captions', 'native button failed', {
          desiredEnabled: desired,
          nativeEnabledBefore: info.enabled,
          nativeEnabledAfter: latest.enabled,
          nativeButtonClicked: true,
          setOptionUsed: false,
          ok: false
        });
        return {
          ok: false,
          available: latest.available,
          enabled: latest.enabled,
          buttonClicked: true,
          setOptionUsed: false
        };
      }
    }

    if (player && typeof player.setOption === 'function') {
      let value = null;
      if (desired) {
        const selectedTrack = safeTrackValue(getOption(player, 'captions', 'track')) ||
          captionTrackMemory.get(player) ||
          safeTrackValue(getCaptionTrackList(player)[0]);
        value = selectedTrack;
      }

      try {
        player.setOption('captions', 'track', value || {});
        const apiUpdated = await waitForCaptionState(player, context, desired);
        const result = {
          ok: apiUpdated.enabled === desired,
          available: apiUpdated.available,
          enabled: apiUpdated.enabled,
          buttonClicked: false,
          setOptionUsed: true
        };
        debugLog('Captions', 'setOption result', {
          desiredEnabled: desired,
          nativeEnabledBefore: info.enabled,
          nativeEnabledAfter: apiUpdated.enabled,
          nativeButtonClicked: false,
          setOptionUsed: true,
          ok: result.ok
        });
        return result;
      } catch (error) {
        const latest = getCaptionInfo(player, context);
        debugLog('Captions', 'setOption failed', {
          desiredEnabled: desired,
          nativeEnabledBefore: info.enabled,
          nativeEnabledAfter: latest.enabled,
          nativeButtonClicked: false,
          setOptionUsed: true,
          ok: false
        });
        return {
          ok: false,
          available: latest.available,
          enabled: latest.enabled,
          buttonClicked: false,
          setOptionUsed: true
        };
      }
    }

    return {
      ok: false,
      available: info.available,
      enabled: info.enabled,
      buttonClicked: false,
      setOptionUsed: false
    };
  }

  function handleRequest(command, payload) {
    if (!ALLOWED_COMMANDS.has(command)) {
      return { ok: false, error: 'Unknown command' };
    }

    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};
    const context = getPreviewContext(data.videoId);
    const player = context ? context.player : null;

    if (command === 'quality-info') {
      return getQualityInfo(player);
    }

    if (command === 'set-quality') {
      return setQuality(player, data.level);
    }

    if (command === 'seek-preview') {
      const requestedVideoId = normalizeVideoId(data.videoId);
      const seconds = Number(data.seconds);
      if (
        !requestedVideoId ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > MAX_SEEK_SECONDS ||
        typeof data.allowSeekAhead !== 'boolean'
      ) {
        return {
          ok: false,
          available: false,
          playerFound: false,
          seekToAvailable: false
        };
      }
      return seekPreview(player, context, seconds, data.allowSeekAhead);
    }

    if (command === 'caption-catalog') {
      return getCaptionCatalog(player, data.videoId);
    }

    if (command === 'fetch-captions') {
      return fetchCaptionCues(
        data.videoId,
        data.trackId,
        data.targetLanguage,
        data.track,
        player
      );
    }

    if (command === 'captions-info') {
      const info = getCaptionInfo(player, context);
      return { ok: info.available, available: info.available, enabled: info.enabled };
    }

    if (command === 'set-captions-enabled') {
      if (typeof data.desiredEnabled !== 'boolean') {
        return { ok: false, available: false, enabled: false };
      }
      return setCaptionsEnabled(player, context, data.desiredEnabled);
    }

    return { ok: false, available: false, enabled: false };
  }

  window.addEventListener('message', function (event) {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !isRequest(event.data)
    ) {
      return;
    }

    Promise.resolve().then(function () {
      return handleRequest(event.data.command, event.data.payload);
    }).catch(function () {
      return { ok: false, error: 'Bridge operation failed' };
    }).then(function (result) {
      postBridgeMessage({
        type: 'response',
        id: event.data.id,
        result: result
      });
    });
  });

  postBridgeMessage({ type: 'ready' });
})();
