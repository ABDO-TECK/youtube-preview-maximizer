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
    'seek-preview',
    'preview-ad-status',
    'history-native-fallback-prepare',
    'history-native-fallback-load',
    'history-ad-hold-break-load',
  ]);
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const PREVIEW_SELECTOR = 'ytd-video-preview';
  const HISTORY_FALLBACK_CLASS = 'ytpm-history-native-fallback-active';
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
  const VIDEO_ASSOCIATION_PATTERN = /^[a-f0-9]{32}$/;
  const ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE = 'data-ytpm-active-video-association';
  const ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE = 'data-ytpm-active-player-association';
  const PREVIEW_AD_SESSION_ATTRIBUTE = 'data-ytpm-preview-ad-session';
  const PREVIEW_AD_VIDEO_ATTRIBUTE = 'data-ytpm-preview-ad-video-id';
  const PREVIEW_AD_SESSION_PATTERN = /^[a-f0-9]{32}$/;
  const PLAYER_VIDEO_SYNC_TOLERANCE = 1.5;
  // Temporary runtime-forensics switch. This mirrors the content-script gate.
  const DEBUG_LOGGING = true;
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

  function seekForensicsLog(message, details) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' ||
      typeof console.debug !== 'function') {
      return;
    }

    console.debug('[YTPM][SeekForensics]', message, {
      wallTime: new Date().toISOString(),
      timestamp: typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
      details: details || {}
    });
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

  function getHistoryFallbackCard(videoId) {
    const cards = Array.from(document.querySelectorAll('ytd-rich-item-renderer,ytd-video-renderer,ytd-grid-video-renderer,ytd-compact-video-renderer,ytd-playlist-video-renderer,ytd-reel-item-renderer,yt-lockup-view-model')).filter(function (card) {
      const link = card.querySelector('a#thumbnail,a[href*="/watch"],a[href*="/shorts/"]');
      return link && getVideoIdFromUrl(link.href || link.getAttribute('href')) === videoId;
    });
    return cards.find(function (card) { return card.classList.contains(HISTORY_FALLBACK_CLASS); }) ||
      cards.find(function (card) { return card.matches(':hover') || card.querySelector(':hover'); }) || cards[0] || null;
  }

  function getHistoryFallbackPrepareState(videoId, card, outer, preview) {
    const inner = outer && outer.querySelector('.html5-video-player#inline-preview-player');
    return { requestedVideoId: videoId, cardPresent: Boolean(card), previewPresent: Boolean(preview), previewActive: Boolean(preview && preview.hasAttribute('active')), naturallyHovered: Boolean(card && (card.matches(':hover') || card.querySelector(':hover'))), trueInnerPlayerPresent: Boolean(inner), trueInnerPlayerConnected: Boolean(inner && inner.isConnected), trueInnerPlayerVisible: Boolean(inner && isVisibleNode(inner)) };
  }

  function prepareHistoryFallbackPlayer(videoId) {
    const requestedVideoId = normalizeVideoId(videoId);
    if (window.location.pathname !== '/feed/history' || !requestedVideoId) {
      return { ok: false, reason: window.location.pathname !== '/feed/history' ? 'history-only' : 'invalid-video-id' };
    }
    const card = getHistoryFallbackCard(requestedVideoId);
    const preview = document.querySelector(PREVIEW_SELECTOR);
    const outer = document.querySelector('ytd-player#inline-player');
    const inner = outer && outer.querySelector('.html5-video-player#inline-preview-player');
    const before = getHistoryFallbackPrepareState(requestedVideoId, card, outer, preview);
    const preparePlayer = outer && outer.preparePlayer;
    if (!card || !preview || before.previewActive || !before.naturallyHovered || !outer || inner || typeof preparePlayer !== 'function') {
      const reason = !card ? 'target-card-not-found' : !preview ? 'preview-not-found' : before.previewActive ? 'preview-already-active' : !before.naturallyHovered ? 'target-not-naturally-hovered' : !outer ? 'outer-player-not-found' : inner ? 'inner-player-already-present' : 'prepare-player-unavailable';
      return { ok: false, reason: reason };
    }
    try {
      preparePlayer.call(outer);
      return { ok: true, invoked: true };
    } catch (error) {
      return { ok: false, reason: 'prepare-player-threw' };
    }
  }
  function loadHistoryFallbackVideo(videoId, generation) {
    const requestedVideoId = normalizeVideoId(videoId);
    if (window.location.pathname !== '/feed/history' || !requestedVideoId) {
      return { ok: false, reason: window.location.pathname !== '/feed/history' ? 'wrong-pathname' : 'invalid-video-id', generation: generation, outerPresent: false, innerPresent: false, loadMethodPresent: false, loadInvoked: false, videoPresentBefore: false, videoPresentAfterImmediate: false, pausedAfterImmediate: null, readyStateAfterImmediate: null };
    }
    const card = getHistoryFallbackCard(requestedVideoId);
    const preview = document.querySelector(PREVIEW_SELECTOR);
    const outer = document.querySelector('ytd-player#inline-player');
    const inner = outer && outer.querySelector('.html5-video-player#inline-preview-player');
    const cardStillHovered = Boolean(card && (card.matches(':hover') || card.querySelector(':hover')));
    if (!card || !cardStillHovered) {
      return { ok: false, reason: !card ? 'target-card-not-found' : 'target-card-not-hovered', generation: generation, outerPresent: Boolean(outer), innerPresent: Boolean(inner), loadMethodPresent: Boolean(inner && typeof inner.loadVideoById === 'function'), loadInvoked: false, videoPresentBefore: Boolean(inner && inner.querySelector('video')), videoPresentAfterImmediate: false, pausedAfterImmediate: null, readyStateAfterImmediate: null };
    }
    if (!preview || !outer || !inner || !inner.isConnected || !inner.loadVideoById) {
      return { ok: false, reason: !preview ? 'preview-not-found' : !outer ? 'outer-player-not-found' : !inner ? 'inner-player-not-found' : !outer.isConnected ? 'outer-player-disconnected' : !inner.isConnected ? 'inner-player-disconnected' : 'load-video-by-id-unavailable', generation: generation, outerPresent: Boolean(outer), innerPresent: Boolean(inner), loadMethodPresent: Boolean(inner && typeof inner.loadVideoById === 'function'), loadInvoked: false, videoPresentBefore: Boolean(inner && inner.querySelector('video')), videoPresentAfterImmediate: false, pausedAfterImmediate: null, readyStateAfterImmediate: null };
    }
    const videoBefore = inner.querySelector('video');
    const baseResult = { ok: false, reason: '', generation: generation, outerPresent: true, innerPresent: true, loadMethodPresent: true, loadInvoked: false, videoPresentBefore: Boolean(videoBefore), videoPresentAfterImmediate: false, pausedAfterImmediate: null, readyStateAfterImmediate: null };
    try {
      inner.loadVideoById(requestedVideoId);
      const videoAfter = inner.querySelector('video');
      baseResult.ok = true;
      baseResult.reason = null;
      baseResult.loadInvoked = true;
      baseResult.videoPresentAfterImmediate = Boolean(videoAfter);
      baseResult.pausedAfterImmediate = videoAfter ? Boolean(videoAfter.paused) : null;
      baseResult.readyStateAfterImmediate = videoAfter ? Number(videoAfter.readyState) : null;
      return Object.assign({ invoked: true }, baseResult);
    } catch (error) {
      baseResult.reason = 'load-video-by-id-threw';
      baseResult.errorName = error && error.name ? String(error.name).slice(0, 80) : 'Error';
      return baseResult;
    }
  }

  function loadOwnedHistoryHoldBreakVideo(videoId, sessionId) {
    const context = getOwnedPreviewAdContext(videoId, sessionId);
    const player = context && context.player;
    if (window.location.pathname !== '/feed/history' || !context || !context.playerElement || !context.playerElement.isConnected || !player || typeof player.loadVideoById !== 'function') {
      return { ok: false, loadInvoked: false, loadThrew: false };
    }
    try { player.loadVideoById(normalizeVideoId(videoId)); return { ok: true, loadInvoked: true, loadThrew: false }; }
    catch (error) { return { ok: false, loadInvoked: false, loadThrew: true }; }
  }

  function logHistoryLoadFailure(result) {
    if (!result || result.ok === true || result.reason === 'target-card-not-hovered' || typeof console === 'undefined' || typeof console.debug !== 'function') return;
    console.debug('[YTPM][HistoryLoadFailure]', 'generation=' + String(result.generation == null ? '' : result.generation), 'reason=' + String(result.reason || 'unknown'), 'outerPresent=' + String(result.outerPresent === true), 'innerPresent=' + String(result.innerPresent === true), 'loadMethodPresent=' + String(result.loadMethodPresent === true), 'loadInvoked=' + String(result.loadInvoked === true));
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

  function getOwnedPreviewAdContext(videoId, sessionId) {
    const requestedVideoId = normalizeVideoId(videoId);
    if (!requestedVideoId || typeof sessionId !== 'string' ||
      !PREVIEW_AD_SESSION_PATTERN.test(sessionId)) {
      return null;
    }

    const previews = Array.from(document.querySelectorAll(PREVIEW_SELECTOR)).filter(function (preview) {
      return preview.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === sessionId &&
        preview.getAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE) === requestedVideoId;
    });
    if (previews.length !== 1) {
      return null;
    }

    // History fallback intentionally moves the owned outer player into the
    // hovered thumbnail. Resolve by the unguessable session attribute rather
    // than assuming the player remains a descendant of its preview shell.
    const playerElements = Array.from(document.querySelectorAll(
      '[' + PREVIEW_AD_SESSION_ATTRIBUTE + ']'
    )).filter(function (candidate) {
      return candidate.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === sessionId &&
        candidate.getAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE) === requestedVideoId &&
        candidate.matches('.html5-video-player, #inline-preview-player, ytd-player#inline-player');
    });
    if (playerElements.length !== 1 || !playerElements[0].isConnected) {
      return null;
    }

    return {
      preview: previews[0],
      playerElement: playerElements[0],
      player: getApiPlayer(playerElements[0]) || playerElements[0]
    };
  }

  function getPreviewAdStatus(context) {
    if (!context || !context.playerElement || !context.playerElement.isConnected) {
      return { ok: false, active: false, confidence: 'none', reason: 'player-unavailable', requestedVideoIdMatches: false };
    }

    const player = context.playerElement;
    const reportedVideoId = normalizeVideoId(getVideoData(context.player) && getVideoData(context.player).video_id);
    const requestedVideoId = normalizeVideoId(context.preview.getAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE));
    const association = {
      associationSource: 'owned-player-getVideoData',
      associationAvailable: Boolean(reportedVideoId),
      associationMatchesRequested: Boolean(reportedVideoId && requestedVideoId && reportedVideoId === requestedVideoId),
      playerReportedVideoIdPresent: Boolean(reportedVideoId),
      playerReportedVideoIdMatches: Boolean(reportedVideoId && requestedVideoId && reportedVideoId === requestedVideoId)
    };
    const controller = { playerState: null, playerCurrentTime: null, playerDuration: null, loadedFraction: null, playerVideoIdPresent: Boolean(reportedVideoId), playerVideoIdMatchesRequested: Boolean(reportedVideoId && requestedVideoId && reportedVideoId === requestedVideoId) };
    try { const value = Number(context.player && context.player.getPlayerState && context.player.getPlayerState()); controller.playerState = Number.isFinite(value) ? value : null; } catch (error) {}
    try { const value = Number(context.player && context.player.getCurrentTime && context.player.getCurrentTime()); controller.playerCurrentTime = Number.isFinite(value) && value >= 0 ? value : null; } catch (error) {}
    try { const value = Number(context.player && context.player.getDuration && context.player.getDuration()); controller.playerDuration = Number.isFinite(value) && value >= 0 ? value : null; } catch (error) {}
    try { const value = Number(context.player && context.player.getVideoLoadedFraction && context.player.getVideoLoadedFraction()); controller.loadedFraction = Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; } catch (error) {}
    const playerNodes = [player].concat(Array.from(player.querySelectorAll('.html5-video-player')));
    for (const playerNode of playerNodes) {
      const classReason = ['ad-showing', 'ad-interrupting', 'ad-created'].find(function (className) {
        return playerNode.classList.contains(className) || playerNode.hasAttribute(className) ||
          playerNode.getAttribute('data-' + className) === 'true';
      });
      if (classReason) {
        return Object.assign({ ok: true, active: true, confidence: 'high', reason: classReason,
          requestedVideoIdMatches: association.associationMatchesRequested }, association, controller);
      }
    }

    const activeAdUi = player.querySelector(
      '.ytp-ad-player-overlay,.ytp-ad-text,.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-ad-module,.ytp-ad-overlay-container'
    );
    if (activeAdUi && isVisibleNode(activeAdUi)) {
      return Object.assign({ ok: true, active: true, confidence: 'high', reason: 'active-ad-ui', requestedVideoIdMatches: false }, association, controller);
    }

    return Object.assign({ ok: true, active: false, confidence: 'high', reason: 'content', requestedVideoIdMatches: association.associationMatchesRequested }, association, controller);
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

  function readVideoCurrentTime(video) {
    const value = video ? Number(video.currentTime) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= MAX_SEEK_SECONDS
      ? value
      : null;
  }

  function getAssociatedSeekContext(associationId) {
    if (typeof associationId !== 'string' || !VIDEO_ASSOCIATION_PATTERN.test(associationId)) {
      return { video: null, player: null, videoAssociated: false, playerAssociated: false };
    }
    const video = Array.from(document.querySelectorAll('video')).find(function (candidate) {
      return candidate.getAttribute(ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE) === associationId;
    }) || null;
    const playerElement = Array.from(document.querySelectorAll(
      '[' + ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE + ']'
    )).find(function (candidate) {
      return candidate.getAttribute(ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE) === associationId;
    }) || null;
    const candidatePlayer = getApiPlayer(playerElement);
    const playerTime = readPlayerCurrentTime(candidatePlayer);
    const videoTime = readVideoCurrentTime(video);
    const playerAssociated = Boolean(candidatePlayer &&
      typeof candidatePlayer.seekTo === 'function' &&
      playerTime !== null && videoTime !== null &&
      Math.abs(playerTime - videoTime) <= PLAYER_VIDEO_SYNC_TOLERANCE);
    return {
      video: video,
      player: playerAssociated ? candidatePlayer : null,
      videoAssociated: Boolean(video),
      playerFound: Boolean(candidatePlayer),
      playerAssociated: playerAssociated,
      playerCurrentTimeBefore: playerTime,
      videoCurrentTimeBefore: videoTime
    };
  }

  function readSeekDebugContext(data) {
    if (!DEBUG_LOGGING || !data || typeof data !== 'object') {
      return {
        requestId: null,
        source: 'unknown',
        stage: 'unknown'
      };
    }

    const requestId = Number(data.debugRequestId);
    const sanitizeLabel = function (value, fallback) {
      const label = typeof value === 'string' ? value.slice(0, 80) : '';
      return /^[A-Za-z0-9_-]{1,80}$/.test(label) ? label : fallback;
    };
    return {
      requestId: Number.isInteger(requestId) && requestId >= 0
        ? requestId
        : null,
      source: sanitizeLabel(data.debugSource, 'unknown'),
      stage: sanitizeLabel(data.debugStage, 'unknown')
    };
  }

  function seekPreview(context, seconds, allowSeekAhead, debugContext) {
    const targetTime = Math.max(0, Math.min(MAX_SEEK_SECONDS, Number(seconds)));
    const player = context && context.player;
    const video = context && context.video;
    const playerFound = Boolean(context && context.playerFound);
    const before = context ? context.playerCurrentTimeBefore : null;
    const videoBefore = context ? context.videoCurrentTimeBefore : null;
    const trace = debugContext || {
      requestId: null,
      source: 'unknown',
      stage: 'unknown'
    };
    seekForensicsLog('bridgeSeekReceived', {
      requestId: trace.requestId,
      source: trace.source,
      stage: trace.stage,
      target: targetTime,
      allowSeekAhead: allowSeekAhead === true,
      playerFound: playerFound,
      seekToAvailable: Boolean(player && typeof player.seekTo === 'function'),
      playerAssociated: Boolean(context && context.playerAssociated),
      videoAssociated: Boolean(context && context.videoAssociated),
      playerCurrentTimeBefore: before,
      videoCurrentTimeBefore: videoBefore
    });
    if (!video) {
      const unavailableResult = {
        ok: false,
        available: false,
        playerFound: playerFound,
        seekToAvailable: false,
        playerAssociated: false,
        videoAssociated: false,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: before,
        videoCurrentTimeBefore: videoBefore,
        videoCurrentTimeAfter: null
      };
      seekForensicsLog('bridgeSeekReturned', {
        requestId: trace.requestId,
        source: trace.source,
        stage: trace.stage,
        target: targetTime,
        allowSeekAhead: allowSeekAhead === true,
        playerFound: playerFound,
        seekToAvailable: false,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: before,
        ok: false
      });
      return unavailableResult;
    }

    if (!player || typeof player.seekTo !== 'function') {
      try {
        video.currentTime = targetTime;
        return {
          ok: true,
          available: true,
          playerFound: playerFound,
          seekToAvailable: false,
          playerAssociated: false,
          videoAssociated: true,
          usedVideoFallback: true,
          targetTime: targetTime,
          playerCurrentTimeBefore: before,
          playerCurrentTimeAfter: before,
          videoCurrentTimeBefore: videoBefore,
          videoCurrentTimeAfter: readVideoCurrentTime(video)
        };
      } catch (error) {
        return {
          ok: false, available: true, playerFound: playerFound, seekToAvailable: false,
          playerAssociated: false, videoAssociated: true, targetTime: targetTime,
          playerCurrentTimeBefore: before, playerCurrentTimeAfter: before,
          videoCurrentTimeBefore: videoBefore, videoCurrentTimeAfter: readVideoCurrentTime(video)
        };
      }
    }

    try {
      seekForensicsLog('playerSeekToCall', {
        requestId: trace.requestId,
        source: trace.source,
        stage: trace.stage,
        target: targetTime,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: before
      });
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
      const result = {
        ok: true,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        playerAssociated: true,
        videoAssociated: true,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: after,
        videoCurrentTimeBefore: videoBefore,
        videoCurrentTimeAfter: readVideoCurrentTime(video)
      };
      seekForensicsLog('playerSeekToReturn', {
        requestId: trace.requestId,
        source: trace.source,
        stage: trace.stage,
        target: targetTime,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: after,
        ok: true
      });
      return result;
    } catch (error) {
      debugLog('Seek', 'player seekTo failed', {
        requestedTime: targetTime,
        playerFound: true,
        playerSeekToAvailable: true,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: readPlayerCurrentTime(player),
        allowSeekAhead: allowSeekAhead === true
      });
      const failedResult = {
        ok: false,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        playerAssociated: true,
        videoAssociated: true,
        targetTime: targetTime,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: readPlayerCurrentTime(player),
        videoCurrentTimeBefore: videoBefore,
        videoCurrentTimeAfter: readVideoCurrentTime(video)
      };
      seekForensicsLog('playerSeekToReturn', {
        requestId: trace.requestId,
        source: trace.source,
        stage: trace.stage,
        target: targetTime,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: before,
        playerCurrentTimeAfter: failedResult.playerCurrentTimeAfter,
        ok: false,
        errorName: error && error.name ? error.name : 'UnknownError'
      });
      return failedResult;
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
    if (command === 'history-native-fallback-prepare') {
      return prepareHistoryFallbackPlayer(data.videoId);
    }
    if (command === 'history-native-fallback-load') {
      const result = loadHistoryFallbackVideo(data.videoId, data.generation);
      logHistoryLoadFailure(result);
      return result;
    }
    if (command === 'history-ad-hold-break-load') {
      return loadOwnedHistoryHoldBreakVideo(data.videoId, data.sessionId);
    }
    if (command === 'preview-ad-status') {
      return getPreviewAdStatus(getOwnedPreviewAdContext(data.videoId, data.sessionId));
    }
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
        typeof data.videoAssociationId !== 'string' ||
        !VIDEO_ASSOCIATION_PATTERN.test(data.videoAssociationId) ||
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
      return seekPreview(
        getAssociatedSeekContext(data.videoAssociationId),
        seconds,
        data.allowSeekAhead,
        readSeekDebugContext(data)
      );
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
