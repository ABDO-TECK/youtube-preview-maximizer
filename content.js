(function () {
  'use strict';

  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model'
  ].join(', ');

  const AD_CARD_SELECTOR = [
    'ytd-ad-slot-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-ad-layout-renderer',
    'ytd-advertisement-renderer',
    'ytd-promoted-video-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-companion-slot-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    '[is-ad]',
    '[ad-placement]'
  ].join(', ');

  const THUMBNAIL_SELECTOR = [
    'ytd-thumbnail',
    'yt-thumbnail-view-model',
    '.yt-lockup-view-model__content-image',
    '.ytm-shorts-lockup-view-model__thumbnail',
    '[id="thumbnail"]',
    '.ytd-thumbnail'
  ].join(', ');

  const PROCESSED_ATTRIBUTE = 'data-ytpm-processed';
  const CARD_CLASS = 'ytpm-card--decorated';
  const THUMBNAIL_CLASS = 'ytpm-thumbnail-host';
  const BUTTON_CLASS = 'ytpm-maximize-button';
  const PREVIEW_HOST_CLASS = 'ytpm-preview-host';
  const HISTORY_FALLBACK_CLASS = 'ytpm-history-native-fallback-active';
  const PREVIEW_BUTTON_CLASS = 'ytpm-maximize-button--preview';
  const OVERLAY_CLASS = 'ytpm-overlay';
  const FRAME_CLASS = 'ytpm-overlay__frame';
  const CONTROLS_CLASS = 'ytpm-overlay__controls';
  const CONTROL_BUTTON_CLASS = 'ytpm-overlay__control-button';
  const SEEK_CLASS = 'ytpm-overlay__seek';
  const TIME_CLASS = 'ytpm-overlay__time';
  const TIMELINE_PREVIEW_CLASS = 'ytpm-overlay__timeline-preview';
  const TIMELINE_PREVIEW_IMAGE_CLASS = 'ytpm-overlay__timeline-preview-image';
  const TIMELINE_PREVIEW_TIME_CLASS = 'ytpm-overlay__timeline-preview-time';
  const QUALITY_CLASS = 'ytpm-overlay__quality';
  const QUALITY_MENU_CLASS = 'ytpm-overlay__quality-menu';
  const QUALITY_OPTION_CLASS = 'ytpm-overlay__quality-option';
  const QUALITY_OPTION_SELECTED_CLASS = 'ytpm-overlay__quality-option--selected';
  const VIDEO_CLASS = 'ytpm-overlay__video';
  const CLOSE_CLASS = 'ytpm-overlay__close';
  const PLACEHOLDER_CLASS = 'ytpm-video-placeholder';
  const NOTICE_CLASS = 'ytpm-notice';
  const NOTICE_VISIBLE_CLASS = 'ytpm-notice--visible';
  const LOCK_CLASS = 'ytpm-no-scroll';
  const CONTROLS_HIDDEN_CLASS = 'ytpm-controls-hidden';
  const SYNTHETIC_CAPTION_ATTRIBUTE = 'data-ytpm-caption-track';
  const PREVIEW_MESSAGE = 'Move the mouse over the thumbnail until the preview starts, then try again.';
  const PREVIEW_OPEN_ERROR_MESSAGE = 'The active preview could not be opened. Please try again.';
  const MEMBERS_ONLY_MESSAGE = 'This video is available to channel members only.';
  const MEMBERS_ONLY_BADGE_SELECTOR = [
    '.badge-style-type-members-only',
    '.badge-shape-wiz--members-only',
    '[badge-shape-wiz--members-only]',
    'ytd-thumbnail-overlay-time-status-renderer[overlay-style="MEMBERS_ONLY"]',
    '.yt-badge-shape-view-model--members-only',
    'yt-icon[badge-shape-wiz--members-only]'
  ].join(', ');
  const PREVIEW_LOOKUP_TIMEOUT_MS = 5000;
  const PREVIEW_RETRY_DELAY_MS = 80;
  const PLAYBACK_RETRY_DELAY_MS = 120;
  const PLAYBACK_RETRY_LIMIT = 18;
  const QUALITY_RETRY_DELAY_MS = 350;
  const QUALITY_RETRY_LIMIT = 6;
  const PAGE_BRIDGE_SOURCE = 'ytpm-page-bridge';
  const PAGE_BRIDGE_TIMEOUT_MS = 650;
  const CAPTION_SERVICE_SOURCE = 'ytpm-caption-service';
  const CAPTION_SERVICE_TIMEOUT_MS = 5000;
  const NATIVE_CAPTION_REQUEST_TIMEOUT_MS = 1000;
  const SEEK_CONFIRM_TIMEOUT_MS = 1200;
  const SEEK_CONFIRM_POLL_MS = 80;
  const SEEK_NOOP_EPSILON = 0.15;
  const SEEK_CONFIRM_TOLERANCE = 0.5;
  const SEEK_BUFFER_SAFETY_MARGIN = 0.05;
  const SEEK_PRECISION_TIMEOUT_MS = 1800;
  const CAPTION_TRANSITION_DURATION_MS = 140;
  const ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE = 'data-ytpm-active-video-association';
  const ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE = 'data-ytpm-active-player-association';
  const PREVIEW_AD_SESSION_ATTRIBUTE = 'data-ytpm-preview-ad-session';
  const PREVIEW_AD_VIDEO_ATTRIBUTE = 'data-ytpm-preview-ad-video-id';
  const HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE = 'data-ytpm-history-fence';
  const SEEK_MAX_SECONDS = 86400;
  const CONTROLS_HIDE_DELAY_MS = 5000;
  const BRIDGE_ID_PATTERN = /^request-\d{1,12}$/;
  // Production-safe debug gate. Enabled for localhost/dev testing, disabled on production YouTube domains.
  const DEBUG_LOGGING = typeof window !== 'undefined' && Boolean(window.location) &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || !window.location.hostname);
  const FORENSIC_LOG_LIMIT = 1500;
  const documentInitialPathname = window.location.pathname;
  const documentStartedAt = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  const captionUtils = globalThis.YTPMCaptionUtils || {};
  const previewAdGuardFactory = globalThis.YTPMPreviewAdGuard || null;

  let activeOverlay = null;
  let observer = null;
  let scanQueued = false;
  let scanFrame = 0;
  let noticeElement = null;
  let noticeTimer = 0;
  let previewAttemptId = 0;
  let lastHoveredCard = null;
  let previewButtonState = null;
  let historyNativeFallbackSession = null;
  let historyNativeFallbackPhase = 'entry';
  let historyNativeFallbackStartTimer = 0;
  let historyNativeFallbackIntentGeneration = 0;
  let historyNativeFallbackGeneration = 0;
  let homeYtActionProvenanceSession = null;
  let bridgeInjectionAttempted = false;
  let bridgeReady = false;
  let bridgeRequestCounter = 0;
  let pageBridgeNonce = '';
  let fullScanRequested = false;
  let previewSyncRequested = false;
  let initialized = false;
  let lifecycleListenersInstalled = false;
  const cardButtonMap = new WeakMap();
  const cardPreviewVideoMap = new WeakMap();
  const adCandidateReports = new WeakSet();
  const bridgeRequests = new Map();
  const bridgeReadyWaiters = [];
  const forensicLogBuffer = [];
  const captionWindowDebugIds = new WeakMap();
  const captionNodeDebugIds = new WeakMap();
  const captionRendererDebugIds = new WeakMap();
  let captionWindowDebugCounter = 0;
  let captionNodeDebugCounter = 0;
  let captionRendererDebugCounter = 0;
  let forensicHelpersInstalled = false;

  function reportError(operation, error) {
    if (!DEBUG_LOGGING) {
      return;
    }

    const errorName = error && error.name ? error.name : 'UnknownError';
    console.debug('[YTPM]', operation, errorName);
  }

  function getDebugUrl(value) {
    if (typeof value !== 'string' || !value) {
      return '';
    }

    try {
      const url = new URL(value, window.location.href);
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function debugLog(scope, message, details) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' ||
      typeof console.debug !== 'function') {
      return;
    }

    console.debug('[YTPM][' + scope + ']', message, details || {});
  }

  function forensicLog(scope, message, details) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' ||
      typeof console.debug !== 'function') {
      return;
    }

    let serializableDetails = {};
    try {
      serializableDetails = JSON.parse(JSON.stringify(details || {}));
    } catch (error) {
      serializableDetails = {
        serializationError: error && error.name ? error.name : 'SerializationError'
      };
    }
    const entry = {
      scope: scope,
      message: message,
      wallTime: new Date().toISOString(),
      timestamp: typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
      details: serializableDetails
    };
    forensicLogBuffer.push(entry);
    if (forensicLogBuffer.length > FORENSIC_LOG_LIMIT) {
      forensicLogBuffer.splice(0, forensicLogBuffer.length - FORENSIC_LOG_LIMIT);
    }
    console.debug('[YTPM][' + scope + ']', message, entry);
  }

  function serializeForensicBuffer() {
    const data = forensicLogBuffer.slice();
    return JSON.stringify(data, null, 2);
  }

  function getWeakDebugId(map, node, prefix, nextId) {
    if (!node || (typeof node !== 'object' && typeof node !== 'function')) {
      return '';
    }
    if (!map.has(node)) {
      map.set(node, prefix + String(nextId()));
    }
    return map.get(node);
  }

  function getCaptionWindowDebugId(node) {
    return getWeakDebugId(
      captionWindowDebugIds,
      node,
      'window-',
      function () {
        captionWindowDebugCounter += 1;
        return captionWindowDebugCounter;
      }
    );
  }

  function getCaptionNodeDebugId(node) {
    return getWeakDebugId(
      captionNodeDebugIds,
      node,
      'node-',
      function () {
        captionNodeDebugCounter += 1;
        return captionNodeDebugCounter;
      }
    );
  }

  function getCaptionRendererDebugId(node) {
    return getWeakDebugId(
      captionRendererDebugIds,
      node,
      'renderer-',
      function () {
        captionRendererDebugCounter += 1;
        return captionRendererDebugCounter;
      }
    );
  }

  function createBridgeNonce() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);

    return Array.from(bytes).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function markSeekAssociation(state) {
    state.seekAssociationId = createBridgeNonce();
    state.video.setAttribute(ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE, state.seekAssociationId);
    const player = state.playerApi && state.playerApi.nodeType === 1 ? state.playerApi : null;
    state.seekAssociatedPlayerElement = player;
    if (player) {
      player.setAttribute(ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE, state.seekAssociationId);
    }
  }

  function clearSeekAssociation(state) {
    if (state.video && state.video.getAttribute(ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE) ===
      state.seekAssociationId) {
      state.video.removeAttribute(ACTIVE_VIDEO_ASSOCIATION_ATTRIBUTE);
    }
    if (state.seekAssociatedPlayerElement &&
      state.seekAssociatedPlayerElement.getAttribute(ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE) ===
        state.seekAssociationId) {
      state.seekAssociatedPlayerElement.removeAttribute(ACTIVE_PLAYER_ASSOCIATION_ATTRIBUTE);
    }
  }

  function isBridgeEnvelope(data) {
    return Boolean(
      data &&
      data.source === PAGE_BRIDGE_SOURCE &&
        data.nonce === pageBridgeNonce &&
        (
          data.type === 'ready' ||
          data.type === 'response' &&
          typeof data.id === 'string' &&
          BRIDGE_ID_PATTERN.test(data.id)
        )
    );
  }

  function sanitizeQualityResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }

    const levels = Array.isArray(result.levels)
      ? Array.from(new Set(result.levels.filter(function (level) {
        return typeof level === 'string' && level.length <= 32;
      }).map(normalizeQualityLevel)))
      : [];
    const current = typeof result.current === 'string' && result.current.length <= 32
      ? normalizeQualityLevel(result.current)
      : 'auto';

    return {
      ok: result.ok === true,
      levels: levels,
      canSet: result.canSet === true,
      current: current
    };
  }

  function sanitizeCaptionResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }

    const available = result.available === true;
    return {
      ok: result.ok === true,
      available: available,
      enabled: available && result.enabled === true,
      buttonClicked: result.buttonClicked === true,
      setOptionUsed: result.setOptionUsed === true
    };
  }

  function sanitizeCaptionCatalogResult(result, videoId) {
    if (!captionUtils.sanitizeCaptionCatalog) {
      return null;
    }

    return captionUtils.sanitizeCaptionCatalog(
      result,
      window.location.origin,
      videoId
    );
  }

  function sanitizeCaptionFetchResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }

    const maxCues = captionUtils.MAX_CAPTION_CUES || 5000;
    const maxTextLength = captionUtils.MAX_CUE_TEXT_LENGTH || 8192;
    const cues = Array.isArray(result.cues)
      ? result.cues.slice(0, maxCues).map(function (cue) {
        if (!cue || typeof cue !== 'object') {
          return null;
        }

        const start = Number(cue.start);
        const duration = Number(cue.duration);
        const text = typeof cue.text === 'string'
          ? cue.text.slice(0, maxTextLength).trim()
          : '';
        return Number.isFinite(start) && start >= 0 &&
          Number.isFinite(duration) && duration > 0 && duration <= 86400 && text
          ? { start: start, duration: duration, text: text }
          : null;
      }).filter(Boolean)
      : [];
    const rawCaptionText = typeof result.rawCaptionText === 'string'
      ? result.rawCaptionText.slice(0, 1024 * 1024)
      : '';

    return {
      ok: result.ok === true,
      cues: cues,
      rawCaptionText: rawCaptionText,
      track: result.track && typeof result.track === 'object'
        ? {
          languageCode: typeof result.track.languageCode === 'string'
            ? result.track.languageCode.slice(0, 32)
            : 'und',
          label: typeof result.track.label === 'string'
            ? result.track.label.slice(0, 200)
            : 'Captions'
        }
        : null
    };
  }

  function sanitizeSeekResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return null;
    }

    const sanitizeTime = function (value) {
      const time = Number(value);
      return Number.isFinite(time) && time >= 0 && time <= SEEK_MAX_SECONDS
        ? time
        : null;
    };

    return {
      ok: result.ok === true,
      available: result.available === true,
      playerFound: result.playerFound === true,
      seekToAvailable: result.seekToAvailable === true,
      playerAssociated: result.playerAssociated === true,
      videoAssociated: result.videoAssociated === true,
      usedVideoFallback: result.usedVideoFallback === true,
      targetTime: sanitizeTime(result.targetTime),
      playerCurrentTimeBefore: sanitizeTime(result.playerCurrentTimeBefore),
      playerCurrentTimeAfter: sanitizeTime(result.playerCurrentTimeAfter),
      videoCurrentTimeBefore: sanitizeTime(result.videoCurrentTimeBefore),
      videoCurrentTimeAfter: sanitizeTime(result.videoCurrentTimeAfter)
    };
  }

  function sanitizeBridgeResult(command, result, request) {
    if (command === 'quality-info' || command === 'set-quality') {
      return sanitizeQualityResult(result);
    }

    if (command === 'caption-catalog') {
      return sanitizeCaptionCatalogResult(result, request && request.videoId);
    }

    if (command === 'fetch-captions') {
      return sanitizeCaptionFetchResult(result);
    }

    if (command === 'captions-info' || command === 'set-captions-enabled') {
      return sanitizeCaptionResult(result);
    }

    if (command === 'seek-preview') {
      return sanitizeSeekResult(result);
    }

    if (command === 'preview-ad-status') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
      }
      return {
        ok: result.ok === true,
        active: result.active === true,
        confidence: result.confidence === 'high' ? 'high' : 'none',
        reason: typeof result.reason === 'string' ? result.reason.slice(0, 80) : 'unknown',
        recovered: result.recovered === true,
        requestedVideoIdMatches: result.requestedVideoIdMatches === true,
        associationSource: typeof result.associationSource === 'string' ? result.associationSource.slice(0, 80) : 'unavailable',
        associationAvailable: result.associationAvailable === true,
        associationMatchesRequested: result.associationMatchesRequested === true,
        playerReportedVideoIdPresent: result.playerReportedVideoIdPresent === true,
        playerReportedVideoIdMatches: result.playerReportedVideoIdMatches === true,
        playerState: Number.isFinite(result.playerState) ? result.playerState : null,
        playerCurrentTime: Number.isFinite(result.playerCurrentTime) ? result.playerCurrentTime : null,
        playerDuration: Number.isFinite(result.playerDuration) ? result.playerDuration : null,
        loadedFraction: Number.isFinite(result.loadedFraction) ? result.loadedFraction : null,
        playerVideoIdPresent: result.playerVideoIdPresent === true,
        playerVideoIdMatchesRequested: result.playerVideoIdMatchesRequested === true,
        invoked: result.invoked === true,
        threw: result.threw === true,
        command: typeof result.command === 'string' ? result.command.slice(0, 40) : '',
        errorName: typeof result.errorName === 'string' ? result.errorName.slice(0, 80) : ''
      };
    }

    if (command === 'history-native-fallback-prepare' || command === 'history-native-fallback-load' || command === 'history-ad-hold-break-load') {
      return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
    }

    return null;
  }

  function resolveBridgeReady(value) {
    while (bridgeReadyWaiters.length) {
      const waiter = bridgeReadyWaiters.shift();
      window.clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  function handlePageBridgeMessage(event) {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      !isBridgeEnvelope(event.data)
    ) {
      return;
    }

    if (event.data.type === 'ready') {
      bridgeReady = true;
      resolveBridgeReady(true);
      return;
    }

    if (event.data.type !== 'response') {
      return;
    }

    const request = bridgeRequests.get(event.data.id);
    if (!request) {
      return;
    }

    bridgeRequests.delete(event.data.id);
    window.clearTimeout(request.timer);
    request.resolve(sanitizeBridgeResult(request.command, event.data.result, request));
  }

  function injectPageBridge() {
    if (bridgeInjectionAttempted) {
      return;
    }

    bridgeInjectionAttempted = true;
    window.addEventListener('message', handlePageBridgeMessage);

    try {
      pageBridgeNonce = createBridgeNonce();
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-bridge.js');
      script.async = false;
      script.dataset.ytpmPageBridge = 'true';
      script.dataset.ytpmPageBridgeNonce = pageBridgeNonce;
      script.addEventListener('load', function () {
        script.remove();
      }, { once: true });
      script.addEventListener('error', function () {
        script.remove();
        resolveBridgeReady(false);
      }, { once: true });

      const insertionPoint = document.head || document.documentElement;
      if (insertionPoint) {
        insertionPoint.appendChild(script);
      } else {
        resolveBridgeReady(false);
      }
    } catch (error) {
      reportError('bridge-injection', error);
      resolveBridgeReady(false);
    }
  }

  function waitForPageBridge() {
    injectPageBridge();

    if (bridgeReady) {
      return Promise.resolve(true);
    }

    return new Promise(function (resolve) {
      const timer = window.setTimeout(function () {
        const index = bridgeReadyWaiters.findIndex(function (waiter) {
          return waiter.resolve === resolve;
        });
        if (index >= 0) {
          bridgeReadyWaiters.splice(index, 1);
        }
        resolve(false);
      }, PAGE_BRIDGE_TIMEOUT_MS);
      bridgeReadyWaiters.push({ resolve: resolve, timer: timer });
    });
  }

  function requestPageBridge(command, payload, timeoutMs) {
    if (![
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
    ].includes(command)) {
      return Promise.resolve(null);
    }

    const requestTimeout = Number.isFinite(timeoutMs) ? timeoutMs : PAGE_BRIDGE_TIMEOUT_MS;

    return waitForPageBridge().then(function (ready) {
      if (!ready) {
        return null;
      }

      return new Promise(function (resolve) {
        const id = 'request-' + String(++bridgeRequestCounter);
        const timer = window.setTimeout(function () {
          bridgeRequests.delete(id);
          resolve(null);
        }, requestTimeout);

        bridgeRequests.set(id, {
          resolve: resolve,
          timer: timer,
          command: command,
          videoId: payload && payload.videoId
        });
        window.postMessage({
          source: PAGE_BRIDGE_SOURCE,
          nonce: pageBridgeNonce,
          type: 'request',
          id: id,
          command: command,
          payload: payload || {}
        }, window.location.origin);
      });
    });
  }

  function requestCaptionService(command, payload, timeoutMs) {
    if (command !== 'caption-tracks' && command !== 'fetch-captions') {
      return Promise.resolve(null);
    }

    const requestTimeout = Number.isFinite(timeoutMs)
      ? timeoutMs
      : CAPTION_SERVICE_TIMEOUT_MS;

    return new Promise(function (resolve) {
      let settled = false;
      const timer = window.setTimeout(function () {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, requestTimeout);

      try {
        chrome.runtime.sendMessage({
          source: CAPTION_SERVICE_SOURCE,
          command: command,
          payload: payload || {}
        }, function (response) {
          const runtimeError = chrome.runtime.lastError;
          if (settled) {
            return;
          }

          settled = true;
          window.clearTimeout(timer);

          if (runtimeError) {
            reportError('caption-service', runtimeError);
            resolve(null);
            return;
          }

          resolve(response || null);
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reportError('caption-service-send', error);
          resolve(null);
        }
      }
    });
  }

  function disposePageBridge() {
    window.removeEventListener('message', handlePageBridgeMessage);
    bridgeReady = false;
    resolveBridgeReady(false);
    bridgeRequests.forEach(function (request) {
      window.clearTimeout(request.timer);
      request.resolve(null);
    });
    bridgeRequests.clear();
  }

  function isElement(value) {
    return value && value.nodeType === 1;
  }

  function isTextInputElement(target) {
    if (!isElement(target)) {
      return false;
    }
    if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') {
      return true;
    }
    if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]')) {
      return true;
    }
    const tag = target.tagName;
    if (tag === 'TEXTAREA') {
      return true;
    }
    if (tag === 'INPUT') {
      const type = String(target.type || 'text').toLowerCase();
      return type === 'text' || type === 'search' || type === 'password' ||
        type === 'email' || type === 'number' || type === 'url' || type === 'tel';
    }
    return false;
  }

  function isAdCard(card) {
    if (!isElement(card)) {
      return false;
    }

    return card.matches(AD_CARD_SELECTOR) || Boolean(card.querySelector(AD_CARD_SELECTOR));
  }

  function detectCurrentSurface(pathname) {
    const path = typeof pathname === 'string'
      ? pathname
      : (typeof window !== 'undefined' && window.location ? window.location.pathname : '');

    if (path === '/' || path === '') {
      return 'HOME';
    }
    if (path.startsWith('/results')) {
      return 'SEARCH';
    }
    if (path.startsWith('/feed/history')) {
      return 'HISTORY';
    }
    if (path.startsWith('/watch')) {
      return 'WATCH';
    }
    if (path.startsWith('/@') || path.startsWith('/channel/') || path.startsWith('/c/') || path.startsWith('/user/')) {
      return 'CHANNEL';
    }
    return 'OTHER';
  }

  function isNativeFallbackSurface(pathname) {
    const surface = detectCurrentSurface(pathname);
    return surface === 'HISTORY' || surface === 'CHANNEL' || surface === 'WATCH';
  }

  function getSurfaceDiagnostics(trigger, details) {
    const surface = detectCurrentSurface();
    const cards = Array.from(collectCards(document));
    const tagCounts = {};
    const matchedSelectors = [];

    const individualSelectors = CARD_SELECTOR.split(',').map(function (s) { return s.trim(); });
    individualSelectors.forEach(function (sel) {
      if (document.querySelector(sel)) {
        matchedSelectors.push(sel);
      }
    });

    cards.forEach(function (card) {
      const tag = card.tagName ? card.tagName.toLowerCase() : 'unknown';
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });

    return Object.assign({
      surface: surface,
      pathname: typeof window !== 'undefined' && window.location ? window.location.pathname : '',
      trigger: trigger || 'scan',
      cardCount: cards.length,
      cardTagNames: tagCounts,
      matchedSelectors: matchedSelectors,
      buttonCount: document.querySelectorAll('.' + BUTTON_CLASS).length
    }, details || {});
  }

  function logSurfaceDiagnostics(trigger, details) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' || typeof console.debug !== 'function') {
      return;
    }

    console.debug('[YTPM][SurfaceDiagnostics]', getSurfaceDiagnostics(trigger, details));
  }

  function reportAdCandidateRejected(card) {
    if (!card || adCandidateReports.has(card)) {
      return;
    }
    adCandidateReports.add(card);
    console.debug('[YTPM][Ads]', 'ytpmAdCandidateRejected', {
      renderer: card.tagName ? card.tagName.toLowerCase() : 'unknown',
      surface: window.location.pathname === '/' ? 'home' : 'watch-or-other',
      reason: 'structural-ad-renderer'
    });
  }

  function collectCards(root) {
    const cards = new Set();

    if (isElement(root) && root.matches(CARD_SELECTOR)) {
      cards.add(root);
    }

    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
        cards.add(card);
      });
    }

    return cards;
  }

  function resolveThumbnailHost(candidate, card) {
    if (!candidate || !card.contains(candidate)) {
      return null;
    }

    if (candidate.tagName === 'A') {
      const parent = candidate.parentElement;
      if (parent && parent !== card && card.contains(parent)) {
        return parent;
      }
    }

    return candidate !== card ? candidate : null;
  }

  function findThumbnailHost(card) {
    const candidate = card.querySelector(THUMBNAIL_SELECTOR);
    const resolvedCandidate = resolveThumbnailHost(candidate, card);

    if (resolvedCandidate) {
      return resolvedCandidate;
    }

    const image = card.querySelector('img');
    if (image) {
      const imageContainer = image.closest(THUMBNAIL_SELECTOR);
      const resolvedImageContainer = resolveThumbnailHost(imageContainer, card);
      if (resolvedImageContainer) {
        return resolvedImageContainer;
      }

      const imageLink = image.closest('a');
      const resolvedImageLink = resolveThumbnailHost(imageLink, card);
      if (resolvedImageLink) {
        return resolvedImageLink;
      }
    }

    const watchLink = card.querySelector('a[href*="/watch"]');
    return resolveThumbnailHost(watchLink, card);
  }

  function isThumbnailHovered(card) {
    if (!card || !isElement(card)) {
      return false;
    }
    const thumbnailHost = findThumbnailHost(card);
    return Boolean(thumbnailHost && (
      thumbnailHost.matches(':hover') ||
      (typeof thumbnailHost.querySelector === 'function' && thumbnailHost.querySelector(':hover'))
    ));
  }

  const isHistoryThumbnailHovered = isThumbnailHovered;

  function isMembersOnlyCard(card) {
    if (!card || !isElement(card)) {
      return false;
    }

    if (card.querySelector(MEMBERS_ONLY_BADGE_SELECTOR)) {
      return true;
    }

    const titleOrThumbnail = card.querySelector('a#thumbnail, a#video-title-link, a#video-title, #video-title, yt-formatted-string#video-title');
    if (titleOrThumbnail) {
      const ariaLabel = titleOrThumbnail.getAttribute('aria-label') || '';
      const title = titleOrThumbnail.getAttribute('title') || titleOrThumbnail.textContent || '';
      if (/\bmembers[\s-]only\b/i.test(ariaLabel) || /\bmembers[\s-]only\b/i.test(title)) {
        return true;
      }
    }

    const badges = card.querySelectorAll('ytd-badge-supported-renderer, .badge, [aria-label*="Members only" i], [title*="Members only" i], .yt-badge-shape-view-model');
    for (let i = 0; i < badges.length; i += 1) {
      const b = badges[i];
      const text = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      if (/\bmembers[\s-]only\b/i.test(text)) {
        return true;
      }
    }

    return false;
  }

  function hasVideoSource(video) {
    return Boolean(video.currentSrc || video.src || video.srcObject);
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function getVideoKey(value) {
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin) {
        return null;
      }

      const watchId = url.searchParams.get('v');
      const normalizedWatchId = captionUtils.normalizeVideoId
        ? captionUtils.normalizeVideoId(watchId)
        : '';
      if (normalizedWatchId) {
        return 'watch:' + normalizedWatchId;
      }

      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) {
        const normalizedShortsId = captionUtils.normalizeVideoId
          ? captionUtils.normalizeVideoId(shortsMatch[1])
          : '';
        return normalizedShortsId ? 'shorts:' + normalizedShortsId : null;
      }

      const liveMatch = url.pathname.match(/^\/live\/([^/]+)/);
      if (!liveMatch) {
        return null;
      }

      const normalizedLiveId = captionUtils.normalizeVideoId
        ? captionUtils.normalizeVideoId(liveMatch[1])
        : '';
      return normalizedLiveId ? 'live:' + normalizedLiveId : null;
    } catch (error) {
      reportError('video-key', error);
      return null;
    }
  }

  function getCardVideoKey(card) {
    if (!isElement(card) || typeof card.querySelector !== 'function') {
      return null;
    }
    const link = card.querySelector('a#thumbnail, a[href*="/watch"], a[href*="/shorts/"]');
    return link ? getVideoKey(link.href || link.getAttribute('href')) : null;
  }

  function getVideoKeyFromPlayer(player) {
    if (!player || typeof player.getVideoData !== 'function') {
      return null;
    }

    try {
      const videoData = player.getVideoData();
      const videoId = captionUtils.normalizeVideoId
        ? captionUtils.normalizeVideoId(videoData && videoData.video_id)
        : '';
      return videoId ? 'watch:' + videoId : null;
    } catch (error) {
      reportError('player-video-key', error);
      return null;
    }
  }

  function getPlayerVideoKey(preview) {
    if (!preview) {
      return null;
    }

    const players = [];
    if (typeof preview.querySelectorAll === 'function') {
      preview.querySelectorAll('.html5-video-player').forEach(function (player) {
        players.push(player);
      });
    }

    const previewVideo = findVideoInPreview(preview);
    const videoPlayer = previewVideo && findComposedAncestor(
      previewVideo,
      '.html5-video-player'
    );
    if (videoPlayer && !players.includes(videoPlayer)) {
      players.push(videoPlayer);
    }

    return players.map(getVideoKeyFromPlayer).find(Boolean) || null;
  }

  function getVideoElementKey(video) {
    const player = findComposedAncestor(video, '.html5-video-player');
    return getVideoKeyFromPlayer(player);
  }

  function getPreviewVideoKey(preview) {
    if (!preview) {
      return null;
    }

    const playerKey = getPlayerVideoKey(preview);
    if (playerKey) {
      return playerKey;
    }

    const links = Array.from(preview.querySelectorAll(
      '#media-container-link[href], a[href*="/watch"], a[href*="/shorts/"], .ytp-title-link[href]'
    ));

    for (const link of links) {
      const key = getVideoKey(link.href || link.getAttribute('href'));
      if (key) {
        return key;
      }
    }

    return null;
  }

  function getVideoIdFromKey(key) {
    if (!key || typeof key !== 'string') {
      return null;
    }

    const separatorIndex = key.indexOf(':');
    const value = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
    return captionUtils.normalizeVideoId
      ? captionUtils.normalizeVideoId(value) || null
      : null;
  }

  function findVideoInCollection(videos) {
    return videos.find(function (video) {
      return isVisible(video) && isPreviewReady(video);
    }) || videos.find(isPreviewReady) || videos.find(function (video) {
      return isVisible(video) && hasVideoSource(video);
    }) || videos.find(isVisible) || videos.find(hasVideoSource) || videos[0] || null;
  }

  function findVideoInPreview(preview) {
    if (!preview) {
      return null;
    }

    const videos = new Set();
    if (typeof preview.querySelectorAll === 'function') {
      preview.querySelectorAll('video').forEach(function (video) {
        videos.add(video);
      });
    }
    if (preview.shadowRoot) {
      collectShadowPreviewVideos(preview.shadowRoot, videos, new Set());
    }

    return findVideoInCollection(Array.from(videos));
  }

  function collectShadowPreviewVideos(root, output, visitedRoots) {
    if (!root || visitedRoots.has(root)) {
      return;
    }

    visitedRoots.add(root);

    if (typeof root.querySelectorAll !== 'function') {
      return;
    }

    root.querySelectorAll('video').forEach(function (video) {
      output.add(video);
    });

    root.querySelectorAll(
      'ytd-video-preview, #inline-preview-player, ytd-player#inline-player, .html5-video-player'
    ).forEach(function (host) {
      if (host.shadowRoot) {
        collectShadowPreviewVideos(host.shadowRoot, output, visitedRoots);
      }
    });
  }

  function collectPreviewVideos() {
    const videos = new Set();
    const visitedRoots = new Set();

    document.querySelectorAll('video').forEach(function (video) {
      videos.add(video);
    });

    document.querySelectorAll(
      'ytd-video-preview, #inline-preview-player, ytd-player#inline-player, .html5-video-player'
    ).forEach(function (host) {
      if (host.shadowRoot) {
        collectShadowPreviewVideos(host.shadowRoot, videos, visitedRoots);
      }
    });

    return Array.from(videos);
  }

  function findComposedAncestor(element, selector) {
    let current = element;

    while (current) {
      if (typeof current.matches === 'function' && current.matches(selector)) {
        return current;
      }

      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }

      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      current = root && root.host ? root.host : null;
    }

    return null;
  }

  function getNativePreviewSourceScheme(video) {
    const source = video && (video.currentSrc || video.src || '');
    if (/^blob:/i.test(source)) {
      return 'blob:';
    }
    if (/^https:/i.test(source)) {
      return 'https:';
    }
    return source ? 'other:' : 'empty';
  }

  function getNativePreviewVideoId(player) {
    const key = getVideoKeyFromPlayer(player);
    return getVideoIdFromKey(key) || '';
  }

  function isPreviewAssociatedWithCard(card, preview) {
    if (!card || !preview) {
      return false;
    }

    const cardKey = getCardVideoKey(card);
    const previewKey = getPreviewVideoKey(preview);
    if (cardKey && previewKey) {
      return cardKey === previewKey;
    }

    if (previewButtonState && previewButtonState.card === card &&
      previewButtonState.preview === preview) {
      return true;
    }

    const activePreviews = Array.from(document.querySelectorAll('ytd-video-preview[active]'));
    return lastHoveredCard === card && activePreviews.length === 1 &&
      activePreviews[0] === preview;
  }

  function isVideoAssociatedWithCard(card, video, preview) {
    if (!card || !video) {
      return false;
    }

    if (findComposedAncestor(video, CARD_SELECTOR) === card) {
      return true;
    }

    const cardKey = getCardVideoKey(card);
    const previewKey = preview ? getPreviewVideoKey(preview) : null;
    if (cardKey && previewKey) {
      return cardKey === previewKey;
    }

    const videoKey = getVideoElementKey(video);
    if (cardKey && videoKey) {
      return cardKey === videoKey;
    }

    return isPreviewAssociatedWithCard(card, preview);
  }

  function isLikelyPreviewVideo(video) {
    if (!video) {
      return false;
    }

    const player = findComposedAncestor(video, '.html5-video-player');
    return Boolean(
      findComposedAncestor(video, 'ytd-video-preview') ||
      findComposedAncestor(video, '#inline-preview-player') ||
      findComposedAncestor(video, 'ytd-player#inline-player') ||
      (player && (
        player.id === 'inline-preview-player' ||
        player.classList.contains('ytp-hide-controls')
      ))
    );
  }

  function findGlobalPreviewVideo(card) {
    const previews = Array.from(document.querySelectorAll('ytd-video-preview'));
    const activePreviews = previews.filter(function (preview) {
      return preview.hasAttribute('active');
    });
    const cardKey = getCardVideoKey(card);

    if (cardKey) {
      const matchingPreviews = previews.filter(function (preview) {
        return getPreviewVideoKey(preview) === cardKey;
      });
      const matchingPreview = matchingPreviews.find(function (preview) {
        return preview.hasAttribute('active');
      }) || matchingPreviews[0];
      const matchingVideo = findVideoInPreview(matchingPreview);
      if (matchingVideo && isPreviewReady(matchingVideo) &&
        isVideoAssociatedWithCard(card, matchingVideo, matchingPreview)) {
        return matchingVideo;
      }
    }

    const rememberedPreview = previewButtonState && previewButtonState.card === card
      ? previewButtonState.preview
      : null;
    const rememberedVideo = rememberedPreview && findVideoInPreview(rememberedPreview);
    if (rememberedVideo && isPreviewReady(rememberedVideo) &&
      isVideoAssociatedWithCard(card, rememberedVideo, rememberedPreview)) {
      return rememberedVideo;
    }

    // When YouTube exposes no video id, only trust a single active preview that
    // belongs to the card currently under the pointer. Never choose an arbitrary
    // global preview from another suggested-video card.
    if (lastHoveredCard !== card || activePreviews.length !== 1) {
      return null;
    }

    const activePreview = activePreviews[0];
    const activeVideo = findVideoInPreview(activePreview);
    if (activeVideo && isPreviewReady(activeVideo) &&
      isVideoAssociatedWithCard(card, activeVideo, activePreview)) {
      return activeVideo;
    }

    const inlinePreviewVideo = findVideoInCollection(Array.from(document.querySelectorAll(
      '#inline-preview-player video, ytd-player#inline-player video'
    )));
    if (inlinePreviewVideo && isPreviewReady(inlinePreviewVideo) &&
      isVideoAssociatedWithCard(card, inlinePreviewVideo, activePreview)) {
      return inlinePreviewVideo;
    }

    const broadPreviewVideo = findVideoInCollection(
      collectPreviewVideos().filter(isLikelyPreviewVideo)
    );
    return broadPreviewVideo && isPreviewReady(broadPreviewVideo) &&
      isVideoAssociatedWithCard(card, broadPreviewVideo, activePreview)
      ? broadPreviewVideo
      : null;
  }

  function findPreviewVideo(card, preferredPreview, preferredVideoElement) {
    if (preferredVideoElement && isPreviewReady(preferredVideoElement) &&
      isVideoAssociatedWithCard(card, preferredVideoElement, preferredPreview)) {
      return preferredVideoElement;
    }

    const preferredPreviewVideo = findVideoInPreview(preferredPreview);
    if (preferredPreviewVideo && isPreviewReady(preferredPreviewVideo) &&
      isVideoAssociatedWithCard(card, preferredPreviewVideo, preferredPreview)) {
      return preferredPreviewVideo;
    }

    const cardVideo = findVideoInCollection(Array.from(card.querySelectorAll('video')));
    if (cardVideo && isPreviewReady(cardVideo)) {
      return cardVideo;
    }

    const rememberedVideo = cardPreviewVideoMap.get(card);
    if (rememberedVideo && isPreviewReady(rememberedVideo) &&
      isVideoAssociatedWithCard(card, rememberedVideo, preferredPreview)) {
      return rememberedVideo;
    }

    const globalVideo = findGlobalPreviewVideo(card);
    if (globalVideo && isPreviewReady(globalVideo)) {
      return globalVideo;
    }

    const fallbackPreferredVideo = preferredPreviewVideo && isVideoAssociatedWithCard(
      card,
      preferredPreviewVideo,
      preferredPreview
    )
      ? preferredPreviewVideo
      : null;
    return fallbackPreferredVideo || cardVideo || globalVideo;
  }

  function isPreviewReady(video) {
    if (!video || !video.isConnected || !hasVideoSource(video)) {
      return false;
    }

    // A YouTube MSE/blob preview can report readyState 0 for a short interval
    // even though playback has already started. Accept that active state and
    // let the normal playback retry handle the final media transition.
    return video.readyState >= 1 ||
      (video.paused === false && !video.ended) ||
      (Number.isFinite(video.currentTime) && video.currentTime > 0);
  }

  function createMaximizeButton(card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    const isMembersOnly = isMembersOnlyCard(card);
    button.setAttribute('aria-label', isMembersOnly
      ? 'Members-only video'
      : isNativeFallbackSurface(window.location.pathname)
        ? 'Open in YTPM'
        : 'Maximize YouTube preview');
    button.title = isMembersOnly
      ? 'Members-only video'
      : isNativeFallbackSurface(window.location.pathname)
        ? 'Open in YTPM'
        : 'Maximize YouTube preview';
    button.textContent = '⛶';

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (isMembersOnlyCard(card)) {
        showPreviewNotice(MEMBERS_ONLY_MESSAGE);
        return;
      }
      lastHoveredCard = card;
      const buttonState = previewButtonState && previewButtonState.card === card
        ? previewButtonState
        : null;
      const preferredPreview = button.closest('ytd-video-preview') ||
        (buttonState && buttonState.preview) ||
        null;
      const preferredVideo = (buttonState && buttonState.video) ||
        cardPreviewVideoMap.get(card) ||
        null;
      openPreviewOverlay(card, preferredPreview, preferredVideo);
    });

    return button;
  }

  function findButtonOwnedByCard(card) {
    const knownButton = cardButtonMap.get(card);
    if (knownButton && knownButton.isConnected) {
      return knownButton;
    }

    const existingButton = Array.from(card.querySelectorAll('.' + BUTTON_CLASS)).find(function (button) {
      return button.closest(CARD_SELECTOR) === card;
    }) || null;

    if (existingButton) {
      cardButtonMap.set(card, existingButton);
    }

    return existingButton;
  }

  function decorateCard(card) {
    if (!isElement(card)) {
      return;
    }

    if (isAdCard(card)) {
      const adButton = findButtonOwnedByCard(card);
      if (adButton) {
        adButton.remove();
      }
      card.removeAttribute(PROCESSED_ATTRIBUTE);
      card.classList.remove(CARD_CLASS);
      return;
    }

    const existingButton = findButtonOwnedByCard(card);
    if (existingButton) {
      card.setAttribute(PROCESSED_ATTRIBUTE, 'true');
      card.classList.add(CARD_CLASS);
      return;
    }

    card.removeAttribute(PROCESSED_ATTRIBUTE);

    const thumbnailHost = findThumbnailHost(card);
    const buttonHost = thumbnailHost;
    if (!buttonHost || buttonHost.querySelector('.' + BUTTON_CLASS)) {
      return;
    }

    if (thumbnailHost) {
      thumbnailHost.classList.add(THUMBNAIL_CLASS);
      thumbnailHost.dataset.ytpmThumbnailHost = 'true';
    }
    const button = createMaximizeButton(card);
    buttonHost.appendChild(button);
    cardButtonMap.set(card, button);

    card.classList.add(CARD_CLASS);
    card.setAttribute(PROCESSED_ATTRIBUTE, 'true');
  }

  function scanCards(root) {
    collectCards(root).forEach(decorateCard);
  }

  function findActivePreview(preferredCard) {
    const previews = Array.from(document.querySelectorAll('ytd-video-preview'));
    const activePreviews = previews.filter(function (preview) {
      return preview.hasAttribute('active');
    });
    const targetCard = preferredCard || lastHoveredCard;
    const targetKey = targetCard ? getCardVideoKey(targetCard) : null;

    if (targetKey) {
      const matchingPreviews = previews.filter(function (preview) {
        return getPreviewVideoKey(preview) === targetKey;
      });
      const matchingPreview = matchingPreviews.find(function (preview) {
        return preview.hasAttribute('active');
      }) || matchingPreviews[0];
      if (matchingPreview) {
        return matchingPreview;
      }
    }

    if (targetCard && lastHoveredCard === targetCard && activePreviews.length === 1 &&
      isPreviewAssociatedWithCard(targetCard, activePreviews[0])) {
      return activePreviews[0];
    }

    if (!targetCard) {
      return activePreviews[0] || previews.find(function (preview) {
        const video = findVideoInPreview(preview);
        return video && isPreviewReady(video) && isVisible(video);
      }) || null;
    }

    return null;
  }

  function findCardForPreview(preview) {
    const previewKey = getPreviewVideoKey(preview);
    const cards = Array.from(collectCards(document)).filter(function (card) {
      const adCard = isAdCard(card);
      if (adCard) {
        reportAdCandidateRejected(card);
      }
      return !adCard;
    });

    if (previewKey) {
      const matchingCard = cards.find(function (card) {
        return getCardVideoKey(card) === previewKey;
      });

      if (matchingCard) {
        return matchingCard;
      }
    }

    return lastHoveredCard && lastHoveredCard.isConnected ? lastHoveredCard : null;
  }

  function restoreButtonToCard() {
    if (!previewButtonState) {
      return;
    }

    const state = previewButtonState;
    previewButtonState = null;
    state.preview.classList.remove(PREVIEW_HOST_CLASS);
    state.button.classList.remove(PREVIEW_BUTTON_CLASS);

    if (!state.card.isConnected) {
      state.button.remove();
      return;
    }

    const buttonHost = findThumbnailHost(state.card);
    if (buttonHost) {
      buttonHost.classList.add(THUMBNAIL_CLASS);
      buttonHost.appendChild(state.button);
    } else {
      state.button.remove();
    }
  }

  function syncPreviewButton() {
    const activePreview = findActivePreview(lastHoveredCard);

    if (!activePreview) {
      restoreButtonToCard();
      return;
    }

    const card = findCardForPreview(activePreview);
    if (!card) {
      restoreButtonToCard();
      return;
    }

    if (previewButtonState &&
      (previewButtonState.card !== card || previewButtonState.preview !== activePreview)) {
      restoreButtonToCard();
    }

    let button = findButtonOwnedByCard(card);
    if (!button) {
      decorateCard(card);
      button = findButtonOwnedByCard(card);
    }

    if (!button) {
      return;
    }

    const previewVideo = findPreviewVideo(card, activePreview);
    if (previewVideo) {
      cardPreviewVideoMap.set(card, previewVideo);
    }

    if (window.location.pathname !== '/feed/history') {
      activePreview.classList.add(PREVIEW_HOST_CLASS);
      if (button.parentNode !== activePreview) {
        activePreview.appendChild(button);
      }
      button.classList.add(PREVIEW_BUTTON_CLASS);
    }
    previewButtonState = {
      card: card,
      preview: activePreview,
      button: button,
      video: previewVideo
    };
  }

  function logHistoryPreviewPrecursor(session, phase, details) {
    if (!session || historyPreviewPrecursorSession !== session) return;
    const fields = [
      'phase=' + phase,
      'generation=' + String(session.generation),
      'elapsedMs=' + String(Math.max(0, Math.round(performance.now() - session.startedAt)))
    ];
    const extra = details || {};
    if (phase === 'event') {
      fields.push('event=' + String(extra.event));
      if (extra.element) fields.push('element=' + extra.element);
      if (extra.attribute) fields.push('attribute=' + extra.attribute);
      if (typeof extra.active === 'boolean') fields.push('active=' + String(extra.active));
    } else if (phase === 'end') {
      fields.push(
        'reason=' + String(extra.reason || 'cleanup'),
        'sawYtAction=' + String(session.sawYtAction),
        'sawPreviewShell=' + String(session.previewShellAssociated),
        'attributeChangeCount=' + String(session.attributeChangeCount),
        'structuralChangeCount=' + String(session.structuralChangeCount)
      );
    }
    console.debug.apply(console, ['[YTPM][HistoryPreviewPrecursor]'].concat(fields));
  }

  function getHistoryPreviewPrecursorElementLabel(session, element) {
    if (element === session.card) return 'card';
    const thumbnailHost = session.thumbnailHost;
    if (element === thumbnailHost) return 'thumbnail-host';
    const lockupHost = session.card.matches('yt-lockup-view-model')
      ? session.card
      : session.card.querySelector('yt-lockup-view-model');
    if (element === lockupHost) return 'other-known-host';
    if (element && typeof element.closest === 'function' && element.closest('ytd-video-preview')) {
      return 'preview';
    }
    return '';
  }

  function getHistoryPreviewPrecursorStructuralLabel(session, mutation) {
    const directLabel = getHistoryPreviewPrecursorElementLabel(session, mutation.target);
    if (directLabel) return directLabel;
    const previewAdded = Array.from(mutation.addedNodes).some(function (node) {
      return isElement(node) && (node.matches('ytd-video-preview') || node.querySelector('ytd-video-preview'));
    });
    return previewAdded ? 'preview' : '';
  }

  function removeHistoryPreviewPrecursorListeners(session) {
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'yt-action'].forEach(function (type) {
      session.card.removeEventListener(type, session.eventListener, true);
    });
  }

  function captureHistoryPreviewPrecursor(session) {
    if (!session || historyPreviewPrecursorSession !== session) return false;
    const preview = findActivePreview(session.card);
    const associated = Boolean(preview && preview.isConnected &&
      isPreviewAssociatedWithCard(session.card, preview));
    if (associated && !session.previewShellAssociated) {
      const active = preview.hasAttribute('active');
      session.previewShellAssociated = true;
      session.previewActiveAtAssociation = active;
      logHistoryPreviewPrecursor(session, 'event', {
        event: 'preview-shell-associated', active: active
      });
    }
    return associated;
  }

  function stopHistoryPreviewPrecursor(session, reason) {
    if (!session || historyPreviewPrecursorSession !== session) return;
    if (session.hoverVerificationFrame) window.cancelAnimationFrame(session.hoverVerificationFrame);
    captureHistoryPreviewPrecursor(session);
    if (session.cardObserver) session.cardObserver.disconnect();
    removeHistoryPreviewPrecursorListeners(session);
    logHistoryPreviewPrecursor(session, 'end', { reason: reason });
    historyPreviewPrecursorSession = null;
  }

  function verifyHistoryPreviewPrecursorHover(session) {
    if (!session || historyPreviewPrecursorSession !== session || session.hoverVerificationFrame) return;
    session.hoverVerificationFrame = window.requestAnimationFrame(function () {
      session.hoverVerificationFrame = 0;
      if (!session.card.isConnected) stopHistoryPreviewPrecursor(session, 'card-disconnected');
      else if (!isHistoryThumbnailHovered(session.card)) {
        stopHistoryPreviewPrecursor(session, 'verified-hover-lost');
      }
    });
  }

  function refreshHistoryPreviewPrecursor(session) {
    const current = session || historyPreviewPrecursorSession;
    if (!current || historyPreviewPrecursorSession !== current) return;
    if (!current.card.isConnected) return stopHistoryPreviewPrecursor(current, 'card-disconnected');
    if (getCardVideoKey(current.card) !== current.videoKey) return stopHistoryPreviewPrecursor(current, 'intent-replaced');
    if (window.location.pathname !== '/feed/history') return stopHistoryPreviewPrecursor(current, 'navigation');
    if (!isHistoryThumbnailHovered(current.card)) return verifyHistoryPreviewPrecursorHover(current);
    captureHistoryPreviewPrecursor(current);
  }

  function startHistoryPreviewPrecursor(card, videoKey, intentGeneration) {
    if (window.location.pathname !== '/feed/history' || !card || !card.isConnected || !videoKey) return;
    stopHistoryPreviewPrecursor(historyPreviewPrecursorSession, 'intent-replaced');
    const session = {
      card: card,
      videoKey: videoKey,
      generation: intentGeneration,
      startedAt: performance.now(),
      cardObserver: null,
      eventListener: null,
      hoverVerificationFrame: 0,
      seenEvents: new Set(),
      seenAttributes: new Set(),
      previewShellAssociated: false,
      previewActiveAtAssociation: false,
      thumbnailHost: findThumbnailHost(card),
      sawYtAction: false,
      attributeChangeCount: 0,
      structuralChangeCount: 0
    };
    historyPreviewPrecursorSession = session;
    session.eventListener = function (event) {
      if (historyPreviewPrecursorSession !== session) return;
      const eventName = event.type === 'yt-action' ? 'yt-action' : event.type;
      if (event.type === 'yt-action') session.sawYtAction = true;
      if (!session.seenEvents.has(eventName)) {
        session.seenEvents.add(eventName);
        logHistoryPreviewPrecursor(session, 'event', { event: eventName });
      }
    };
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'yt-action'].forEach(function (type) {
      card.addEventListener(type, session.eventListener, { capture: true, passive: true });
    });
    logHistoryPreviewPrecursor(session, 'start');
    if (typeof MutationObserver === 'function') {
      session.cardObserver = new MutationObserver(function (mutations) {
        if (historyPreviewPrecursorSession !== session) return;
        mutations.forEach(function (mutation) {
          if (mutation.type === 'attributes') {
            const label = getHistoryPreviewPrecursorElementLabel(session, mutation.target);
            const key = label && label + ':' + mutation.attributeName;
            if (key && !session.seenAttributes.has(key)) {
              session.seenAttributes.add(key);
              session.attributeChangeCount += 1;
              logHistoryPreviewPrecursor(session, 'event', {
                event: 'attribute-change', element: label, attribute: mutation.attributeName
              });
            }
          } else if (mutation.type === 'childList' && session.structuralChangeCount < 5) {
            const label = getHistoryPreviewPrecursorStructuralLabel(session, mutation);
            if (label) {
              session.structuralChangeCount += 1;
              logHistoryPreviewPrecursor(session, 'event', {
                event: 'child-structure-change', element: label
              });
            }
          }
        });
        refreshHistoryPreviewPrecursor(session);
      });
      session.cardObserver.observe(card, { attributes: true, childList: true, subtree: true });
    }
    refreshHistoryPreviewPrecursor(session);
  }

  function getHomeYtActionProvenanceLabel(session, element) {
    if (!isElement(element)) return '';
    if (element === session.card) return 'card';
    if (element === session.thumbnailHost) return 'thumbnail-host';
    return element.tagName ? element.tagName.toLowerCase() : '';
  }

  function stopHomeYtActionProvenance(session, reason) {
    if (!session || homeYtActionProvenanceSession !== session) return;
    if (session.timeoutTimer) window.clearTimeout(session.timeoutTimer);
    if (session.hoverVerificationFrame) window.cancelAnimationFrame(session.hoverVerificationFrame);
    session.targets.forEach(function (target) {
      target.removeEventListener('yt-action', session.listener, true);
    });
    console.debug('[YTPM][HomeYtActionProvenance]',
      'phase=end',
      'generation=' + String(session.generation),
      'elapsedMs=' + String(Math.max(0, Math.round(performance.now() - session.startedAt))),
      'reason=' + reason);
    homeYtActionProvenanceSession = null;
  }

  function verifyHomeYtActionProvenanceHover(session) {
    if (!session || homeYtActionProvenanceSession !== session || session.hoverVerificationFrame) return;
    session.hoverVerificationFrame = window.requestAnimationFrame(function () {
      session.hoverVerificationFrame = 0;
      if (!session.card.isConnected) stopHomeYtActionProvenance(session, 'card-disconnected');
      else if (!(session.card.matches(':hover') || session.card.querySelector(':hover'))) {
        stopHomeYtActionProvenance(session, 'verified-hover-lost');
      }
    });
  }

  function startHomeYtActionProvenance(card) {
    if (window.location.pathname !== '/' || !card || !card.isConnected) return;
    stopHomeYtActionProvenance(homeYtActionProvenanceSession, 'replaced');
    const videoKey = getCardVideoKey(card);
    const thumbnailHost = findThumbnailHost(card);
    if (!videoKey || !thumbnailHost) return;
    const session = {
      card: card,
      videoKey: videoKey,
      thumbnailHost: thumbnailHost,
      generation: (startHomeYtActionProvenance.generation || 0) + 1,
      startedAt: performance.now(),
      listener: null,
      targets: [],
      seenEvents: new WeakSet(),
      timeoutTimer: 0,
      hoverVerificationFrame: 0
    };
    startHomeYtActionProvenance.generation = session.generation;
    homeYtActionProvenanceSession = session;
    session.listener = function (event) {
      if (homeYtActionProvenanceSession !== session || session.seenEvents.has(event)) return;
      session.seenEvents.add(event);
      const target = isElement(event.target) ? event.target : null;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const labels = [];
      for (let index = 0; index < path.length && labels.length < 8; index += 1) {
        const node = path[index];
        if (!isElement(node)) continue;
        const label = getHomeYtActionProvenanceLabel(session, node);
        if (label) labels.push(label);
        if (node === session.card) break;
      }
      const fields = [
        '[YTPM][HomeYtActionProvenance]', 'phase=event',
        'generation=' + String(session.generation),
        'elapsedMs=' + String(Math.max(0, Math.round(performance.now() - session.startedAt))),
        'event=yt-action',
        'target=' + String(getHomeYtActionProvenanceLabel(session, target) || 'unknown'),
        'targetInsideThumbnail=' + String(Boolean(target && session.thumbnailHost.contains(target))),
        'targetInsideCard=' + String(Boolean(target && session.card.contains(target))),
        'bubbles=' + String(Boolean(event.bubbles)),
        'composed=' + String(Boolean(event.composed)),
        'eventPhase=' + String(event.eventPhase),
        'path=' + labels.join('>')
      ];
      try {
        if (event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)) {
          const keys = Object.keys(event.detail).slice(0, 10).filter(function (key) { return key.length <= 80; });
          if (keys.length) fields.push('detailKeys=' + keys.join(','));
        }
      } catch (error) {}
      console.debug.apply(console, fields);
      stopHomeYtActionProvenance(session, 'yt-action-captured');
    };
    session.targets = [thumbnailHost, card].filter(function (target, index, targets) {
      return targets.indexOf(target) === index;
    });
    session.targets.forEach(function (target) {
      target.addEventListener('yt-action', session.listener, { capture: true, passive: true });
    });
    console.debug('[YTPM][HomeYtActionProvenance]', 'phase=start',
      'generation=' + String(session.generation), 'elapsedMs=0');
    session.timeoutTimer = window.setTimeout(function () {
      stopHomeYtActionProvenance(session, 'timeout');
    }, 250);
  }

  function stopHomeYtActionTargetLifecycle(session, reason) {
    if (!session || globalThis.__ytpmHomeTargetLifecycle !== session) return;
    if (session.timer) window.clearTimeout(session.timer);
    if (session.observer) session.observer.disconnect();
    if (session.frame) window.cancelAnimationFrame(session.frame);
    session.card.removeEventListener('yt-action', session.listener, true);
    console.debug('[YTPM][HomeYtActionTargetLifecycle]', 'phase=end',
      'generation=' + session.generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt),
      'reason=' + reason);
    globalThis.__ytpmHomeTargetLifecycle = null;
  }

  function startHomeYtActionTargetLifecycle(card) {
    if (window.location.pathname !== '/' || !card || !card.isConnected) return;
    stopHomeYtActionTargetLifecycle(globalThis.__ytpmHomeTargetLifecycle, 'replaced');
    const thumbnailHost = findThumbnailHost(card);
    const videoKey = getCardVideoKey(card);
    if (!thumbnailHost || !videoKey) return;
    const initial = new Set(Array.from(card.children));
    const session = {
      card: card, thumbnailHost: thumbnailHost, videoKey: videoKey,
      generation: (startHomeYtActionTargetLifecycle.generation || 0) + 1,
      startedAt: performance.now(), initial: initial, added: new Set(), removed: new Set(),
      addedLogs: 0, removedLogs: 0, listener: null, observer: null, timer: 0, frame: 0
    };
    startHomeYtActionTargetLifecycle.generation = session.generation;
    globalThis.__ytpmHomeTargetLifecycle = session;
    const log = function (event) {
      console.debug('[YTPM][HomeYtActionTargetLifecycle]', 'phase=event',
        'generation=' + session.generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'event=' + event);
    };
    console.debug('[YTPM][HomeYtActionTargetLifecycle]', 'phase=start',
      'generation=' + session.generation, 'elapsedMs=0', 'directElementChildCount=' + card.children.length);
    session.observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (isElement(node)) { session.added.add(node); if (session.addedLogs++ < 2) log('direct-child-added'); }
        });
        mutation.removedNodes.forEach(function (node) {
          if (isElement(node)) { session.removed.add(node); if (session.removedLogs++ < 2) log('direct-child-removed'); }
        });
      });
    });
    session.observer.observe(card, { childList: true });
    session.listener = function (event) {
      if (globalThis.__ytpmHomeTargetLifecycle !== session) return;
      const target = isElement(event.target) ? event.target : null;
      if (!target) return;
      const attributes = Array.from(target.attributes).map(function (attribute) { return attribute.name; }).sort().slice(0, 10);
      const index = Array.prototype.indexOf.call(card.children, target);
      console.debug('[YTPM][HomeYtActionTargetLifecycle]', 'phase=event',
        'generation=' + session.generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt),
        'event=yt-action-target', 'targetTag=' + target.tagName.toLowerCase(),
        'targetInsideCard=' + card.contains(target), 'targetInsideThumbnail=' + thumbnailHost.contains(target),
        'targetDirectChildOfCard=' + (target.parentElement === card), 'targetPresentAtStart=' + initial.has(target),
        'targetAddedDuringProbe=' + session.added.has(target), 'targetRemovedDuringProbe=' + session.removed.has(target),
        'targetElementIndex=' + index, 'targetContainsThumbnail=' + target.contains(thumbnailHost),
        'thumbnailContainsTarget=' + thumbnailHost.contains(target), 'childElementCount=' + target.children.length,
        'hasShadowRoot=' + Boolean(target.shadowRoot), 'attributeNames=' + attributes.join(','),
        'hasIdAttribute=' + target.hasAttribute('id'), 'hasClassAttribute=' + target.hasAttribute('class'));
      stopHomeYtActionTargetLifecycle(session, 'yt-action-target-captured');
    };
    card.addEventListener('yt-action', session.listener, { capture: true, passive: true });
    session.timer = window.setTimeout(function () { stopHomeYtActionTargetLifecycle(session, 'timeout'); }, 250);
  }

  function verifyHomeYtActionTargetLifecycleHover(session) {
    if (!session || globalThis.__ytpmHomeTargetLifecycle !== session || session.frame) return;
    session.frame = window.requestAnimationFrame(function () {
      session.frame = 0;
      if (!session.card.isConnected) stopHomeYtActionTargetLifecycle(session, 'card-disconnected');
      else if (!(session.card.matches(':hover') || session.card.querySelector(':hover'))) {
        stopHomeYtActionTargetLifecycle(session, 'verified-hover-lost');
      }
    });
  }

  function startHomeYtActionIdentity(card) {
    if (window.location.pathname !== '/' || !card || !card.isConnected) return;
    const thumbnailHost = findThumbnailHost(card);
    const candidates = thumbnailHost ? Array.from(card.children).filter(function (child) { return child.tagName === 'DIV' && child.contains(thumbnailHost); }) : [];
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const session = { card: card, target: target, startedAt: performance.now(), generation: (startHomeYtActionIdentity.generation || 0) + 1, timer: 0, listener: null };
    startHomeYtActionIdentity.generation = session.generation;
    console.debug('[YTPM][HomeYtActionIdentity]', 'phase=start', 'generation=' + session.generation, 'elapsedMs=0', 'candidateCount=1', 'targetElementIndex=' + Array.prototype.indexOf.call(card.children, target));
    const stop = function (reason, found) {
      if (session.timer) window.clearTimeout(session.timer);
      target.removeEventListener('yt-action', session.listener, true);
      console.debug('[YTPM][HomeYtActionIdentity]', 'phase=end', 'generation=' + session.generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'reason=' + reason, 'identityFound=' + Boolean(found));
    };
    session.listener = function (event) {
      const detail = event.detail;
      const fields = ['[YTPM][HomeYtActionIdentity]', 'phase=event', 'generation=' + session.generation,
        'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'event=yt-action-identity',
        'targetTag=' + target.tagName.toLowerCase(), 'targetElementIndex=' + Array.prototype.indexOf.call(card.children, target),
        'detailPresent=' + Boolean(detail), 'detailType=' + typeof detail];
      let found = false;
      try {
        if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
          const keys = Object.keys(detail).slice(0, 12);
          fields.push('detailKeys=' + keys.join(','));
          ['actionName', 'action', 'name', 'type', 'command', 'commandName', 'eventType'].forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(detail, key)) return;
            const value = detail[key];
            if (typeof value === 'string' && value.length <= 120 && !/^https?:\/\//i.test(value) && !/\/(watch|shorts)\b/i.test(value) && !/[A-Za-z0-9_-]{11}/.test(value)) {
              fields.push(key + '=' + value); found = true;
            } else if ((key === 'action' || key === 'command') && value && typeof value === 'object' && !Array.isArray(value)) {
              const nested = Object.keys(value).slice(0, 10);
              if (nested.length) fields.push(key + 'Keys=' + nested.join(','));
            }
          });
        }
      } catch (error) {}
      console.debug.apply(console, fields);
      stop(found ? 'identity-captured' : 'identity-unavailable', found);
    };
    target.addEventListener('yt-action', session.listener, { capture: true, passive: true });
    session.timer = window.setTimeout(function () { stop('timeout', false); }, 250);
  }

  function snapshotPreviewHandlerSurface(card, surface, generation) {
    const thumbnail = findThumbnailHost(card);
    const matches = thumbnail ? Array.from(card.children).filter(function (child) { return child.tagName === 'DIV' && child.contains(thumbnail); }) : [];
    const candidate = matches.length === 1 ? matches[0] : null;
    const keywords = /preview|hover|action|inline|player|open/i;
    const names = function (value, limit) { try { return Object.getOwnPropertyNames(value).filter(function (name) { return keywords.test(name); }).slice(0, limit); } catch (error) { return []; } };
    const methods = function (value, levels) { const output = []; let proto = Object.getPrototypeOf(value); for (let i = 0; proto && i < levels && proto !== HTMLElement.prototype; i += 1, proto = Object.getPrototypeOf(proto)) { const descriptors = Object.getOwnPropertyDescriptors(proto); Object.keys(descriptors).forEach(function (name) { if (keywords.test(name) && typeof descriptors[name].value === 'function' && output.indexOf(name) < 0) output.push(name); }); } return output.slice(0, 25); };
    const states = function (value) { const output = []; let proto = Object.getPrototypeOf(value); for (let i = 0; proto && i < 4 && proto !== HTMLElement.prototype; i += 1, proto = Object.getPrototypeOf(proto)) { const descriptors = Object.getOwnPropertyDescriptors(proto); Object.keys(descriptors).forEach(function (name) { if (keywords.test(name) && typeof descriptors[name].value !== 'function' && output.indexOf(name) < 0) output.push(name); }); } return output.slice(0, 20); };
    const attrs = function (element) { return element ? Array.from(element.attributes).map(function (attribute) { return attribute.name; }).sort().slice(0, 15) : []; };
    const custom = candidate ? Array.from(candidate.querySelectorAll('*')).filter(function (element) { return element.tagName.includes('-'); }).map(function (element) { return element.tagName.toLowerCase(); }).filter(function (tag, index, all) { return all.indexOf(tag) === index; }).slice(0, 12) : [];
    console.debug('[YTPM][PreviewHandlerSurface]', 'phase=snapshot', 'surface=' + surface, 'generation=' + generation,
      'cardTag=' + card.tagName.toLowerCase(), 'directElementChildCount=' + card.children.length, 'candidateCount=' + matches.length,
      'candidateElementIndex=' + (candidate ? Array.prototype.indexOf.call(card.children, candidate) : -1), 'candidateChildElementCount=' + (candidate ? candidate.children.length : 0),
      'candidateChildTags=' + (candidate ? Array.from(candidate.children).slice(0, 8).map(function (child) { return child.tagName.toLowerCase(); }).join(',') : ''),
      'candidateCustomTags=' + custom.join(','), 'thumbnailTag=' + (thumbnail ? thumbnail.tagName.toLowerCase() : ''),
      'cardAttributeNames=' + attrs(card).join(','), 'candidateAttributeNames=' + attrs(candidate).join(','), 'thumbnailAttributeNames=' + attrs(thumbnail).join(','),
      'cardRelevantOwnProps=' + names(card, 20).join(','), 'thumbnailRelevantOwnProps=' + names(thumbnail, 20).join(','),
      'cardRelevantMethods=' + methods(card, 4).join(','), 'thumbnailRelevantMethods=' + methods(thumbnail, 4).join(','),
      'cardRelevantStateNames=' + states(card).join(','), 'thumbnailRelevantStateNames=' + states(thumbnail).join(','));
    custom.slice(0, 6).forEach(function (tag) { const element = candidate.querySelector(tag); const found = methods(element, 3); if (found.length) console.debug('[YTPM][PreviewHandlerSurface]', 'phase=component', 'surface=' + surface, 'generation=' + generation, 'tag=' + tag, 'relevantMethods=' + found.join(',')); });
    console.debug('[YTPM][PreviewHandlerSurface]', 'phase=end', 'surface=' + surface, 'generation=' + generation, 'reason=snapshot-complete');
  }

  function snapshotPreviewEligibilityState(card, surface, generation) {
    const thumbnail = findThumbnailHost(card);
    const candidate = thumbnail && Array.from(card.children).filter(function (child) { return child.tagName === 'DIV' && child.contains(thumbnail); });
    const target = candidate && candidate.length === 1 ? candidate[0] : null;
    const safeTokens = function (element) { return element ? Array.from(element.classList).filter(function (token) { return token.length <= 80 && !/http|\/|\?|=|[A-Za-z0-9_-]{11}/i.test(token); }).sort().slice(0, 15) : []; };
    const attrs = function (element) { const out = {}; ['hidden', 'disabled', 'inert', 'tabindex', 'role', 'aria-disabled', 'aria-hidden'].forEach(function (name) { if (!element) return; const value = element.getAttribute(name); if (name === 'tabindex' && /^-?\d{1,3}$/.test(value || '')) out[name] = value; else if (name === 'role' && /^[a-z-]{1,32}$/.test(value || '')) out[name] = value; else if (/^aria-/.test(name) && /^(true|false)$/.test(value || '')) out[name] = value; else out[name] = element.hasAttribute(name); }); return Object.keys(out).map(function (key) { return key + '=' + out[key]; }).join(','); };
    const own = function (element) { try { return Object.getOwnPropertyNames(element).filter(function (name) { return !/ytpm/i.test(name); }).slice(0, 40); } catch (error) { return []; } };
    const datasets = function (element) { return element ? Object.keys(element.dataset).slice(0, 15) : []; };
    console.debug('[YTPM][PreviewEligibilityState]', 'phase=snapshot', 'surface=' + surface, 'generation=' + generation,
      'cardTag=' + card.tagName.toLowerCase(), 'candidateElementIndex=' + (target ? Array.prototype.indexOf.call(card.children, target) : -1),
      'cardClassTokens=' + safeTokens(card).join(','), 'candidateClassTokens=' + safeTokens(target).join(','), 'thumbnailClassTokens=' + safeTokens(thumbnail).join(','),
      'cardDatasetKeys=' + datasets(card).join(','), 'candidateDatasetKeys=' + datasets(target).join(','), 'thumbnailDatasetKeys=' + datasets(thumbnail).join(','),
      'cardOwnPropertyNames=' + own(card).join(','), 'thumbnailOwnPropertyNames=' + own(thumbnail).join(','),
      'cardOwnSymbolCount=' + Object.getOwnPropertySymbols(card).length, 'thumbnailOwnSymbolCount=' + Object.getOwnPropertySymbols(thumbnail).length,
      'hasProgressOverlay=' + Boolean(target && target.querySelector('yt-thumbnail-overlay-progress-bar-view-model')),
      'cardInteractionState=' + attrs(card), 'candidateInteractionState=' + attrs(target), 'thumbnailInteractionState=' + attrs(thumbnail));
    if (target) Array.from(target.children).slice(0, 3).forEach(function (child, index) { console.debug('[YTPM][PreviewEligibilityState]', 'phase=child', 'surface=' + surface, 'generation=' + generation, 'index=' + index, 'tag=' + child.tagName.toLowerCase(), 'classTokens=' + safeTokens(child).join(','), 'attributeNames=' + Array.from(child.attributes).map(function (attribute) { return attribute.name; }).sort().slice(0, 12).join(',')); });
    console.debug('[YTPM][PreviewEligibilityState]', 'phase=end', 'surface=' + surface, 'generation=' + generation, 'reason=snapshot-complete');
  }

  function resolveHistoryYtActionTargetCandidate(card, thumbnailHost) {
    const matches = Array.from(card.children).filter(function (child) {
      return child.tagName === 'DIV' && child.contains(thumbnailHost);
    });
    return { count: matches.length, candidate: matches.length === 1 ? matches[0] : null };
  }

  function stopHistoryYtActionTargetMirror(session, reason) {
    if (!session || globalThis.__ytpmHistoryTargetMirror !== session) return;
    if (session.observer) session.observer.disconnect();
    if (session.frame) window.cancelAnimationFrame(session.frame);
    if (session.candidate) ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'yt-action'].forEach(function (type) {
      session.candidate.removeEventListener(type, session.listener, true);
    });
    const end = resolveHistoryYtActionTargetCandidate(session.card, session.thumbnailHost);
    console.debug('[YTPM][HistoryYtActionTargetMirror]', 'phase=end', 'generation=' + session.generation,
      'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'reason=' + reason,
      'candidatePresentAtStart=' + Boolean(session.candidate), 'candidatePresentAtEnd=' + Boolean(end.candidate),
      'candidateCountAtEnd=' + end.count, 'sameCandidateAtEnd=' + Boolean(end.candidate && end.candidate === session.candidate),
      'sawCandidatePointerOrMouse=' + session.sawPointerOrMouse, 'sawCandidateYtAction=' + session.sawYtAction,
      'candidateElementIndexAtEnd=' + (end.candidate ? Array.prototype.indexOf.call(session.card.children, end.candidate) : -1),
      'candidateChildElementCountAtEnd=' + (end.candidate ? end.candidate.children.length : 0));
    globalThis.__ytpmHistoryTargetMirror = null;
  }

  function startHistoryYtActionTargetMirror(card, videoKey, generation) {
    if (window.location.pathname !== '/feed/history' || !card || !videoKey) return;
    stopHistoryYtActionTargetMirror(globalThis.__ytpmHistoryTargetMirror, 'intent-replaced');
    const thumbnailHost = findThumbnailHost(card);
    if (!thumbnailHost) return;
    const resolved = resolveHistoryYtActionTargetCandidate(card, thumbnailHost);
    const candidate = resolved.candidate;
    const session = { card: card, videoKey: videoKey, thumbnailHost: thumbnailHost, generation: generation,
      startedAt: performance.now(), candidate: candidate, observer: null, listener: null, frame: 0,
      seen: new Set(), sawPointerOrMouse: false, sawYtAction: false };
    globalThis.__ytpmHistoryTargetMirror = session;
    const attributes = candidate ? Array.from(candidate.attributes).map(function (attribute) { return attribute.name; }).sort().slice(0, 10) : [];
    console.debug('[YTPM][HistoryYtActionTargetMirror]', 'phase=start', 'generation=' + generation, 'elapsedMs=0',
      'directElementChildCount=' + card.children.length, 'candidateCount=' + resolved.count, 'candidatePresent=' + Boolean(candidate),
      'candidateTag=' + (candidate ? candidate.tagName.toLowerCase() : ''), 'candidateElementIndex=' + (candidate ? Array.prototype.indexOf.call(card.children, candidate) : -1),
      'candidateContainsThumbnail=' + Boolean(candidate && candidate.contains(thumbnailHost)), 'thumbnailContainsCandidate=' + Boolean(candidate && thumbnailHost.contains(candidate)),
      'candidateChildElementCount=' + (candidate ? candidate.children.length : 0), 'candidateHasShadowRoot=' + Boolean(candidate && candidate.shadowRoot),
      'candidateAttributeNames=' + attributes.join(','), 'candidateHasIdAttribute=' + Boolean(candidate && candidate.hasAttribute('id')),
      'candidateHasClassAttribute=' + Boolean(candidate && candidate.hasAttribute('class')));
    session.listener = function (event) {
      const name = 'candidate-' + event.type;
      if (globalThis.__ytpmHistoryTargetMirror !== session || session.seen.has(name)) return;
      session.seen.add(name); session.sawYtAction = session.sawYtAction || event.type === 'yt-action';
      session.sawPointerOrMouse = session.sawPointerOrMouse || event.type !== 'yt-action';
      console.debug('[YTPM][HistoryYtActionTargetMirror]', 'phase=event', 'generation=' + generation,
        'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'event=' + name);
    };
    if (candidate) ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'yt-action'].forEach(function (type) {
      candidate.addEventListener(type, session.listener, { capture: true, passive: true });
    });
    session.observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) { if (node === session.candidate) console.debug('[YTPM][HistoryYtActionTargetMirror]', 'phase=event', 'generation=' + generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'event=candidate-added'); });
        mutation.removedNodes.forEach(function (node) { if (node === session.candidate) console.debug('[YTPM][HistoryYtActionTargetMirror]', 'phase=event', 'generation=' + generation, 'elapsedMs=' + Math.round(performance.now() - session.startedAt), 'event=candidate-removed'); });
      });
    });
    session.observer.observe(card, { childList: true });
  }

  function handleCardHover(event) {
    const target = isElement(event.target) ? event.target : null;
    const card = target ? target.closest(CARD_SELECTOR) : null;
    if (!card || card === lastHoveredCard) {
      return;
    }

    if (isMembersOnlyCard(card)) {
      return;
    }

    if (isNativeFallbackSurface(window.location.pathname) && !isThumbnailHovered(card)) {
      return;
    }

    lastHoveredCard = card;
    if (DEBUG_LOGGING) {
      const preview = findActivePreview(card);
      const video = findPreviewVideo(card, preview);
      logSurfaceDiagnostics('hover', {
        hoveredCardTag: card.tagName ? card.tagName.toLowerCase() : '',
        buttonInjected: Boolean(findButtonOwnedByCard(card)),
        previewDetected: Boolean(preview),
        previewVideoDetected: Boolean(video && isPreviewReady(video))
      });
    }
    if (window.location.pathname === '/') { snapshotPreviewEligibilityState.generation = (snapshotPreviewEligibilityState.generation || 0) + 1; snapshotPreviewEligibilityState(card, 'home', snapshotPreviewEligibilityState.generation); }
    schedulePreviewSync();
    queueHistoryNativeFallback(card);
  }

  function getHistoryFallbackIdentityDiagnostics(videoId, scheduledCard) {
    const candidates = Array.from(collectCards(document)).filter(function (candidate) { return getVideoIdFromKey(getCardVideoKey(candidate)) === videoId; });
    return { sameVideoCandidateCount: candidates.length, sameVideoHoveredCandidateCount: candidates.filter(function (candidate) { return candidate.matches(':hover') || Boolean(candidate.querySelector(':hover')); }).length, candidates: candidates.slice(0, 5).map(function (candidate) { return { tagName: candidate.tagName, className: String(candidate.className || '').slice(0, 160), connected: Boolean(candidate.isConnected), hovered: Boolean(candidate.matches(':hover') || candidate.querySelector(':hover')), isScheduledCard: candidate === scheduledCard }; }) };
  }

  function logHistoryNativeFallback(eventName, details) {
    forensicLog('HistoryNativeFallback', eventName, details || {});
  }

  function logHistoryExplicitOverlay(eventName, details) {
    forensicLog('HistoryExplicitOverlay', eventName, Object.assign({
      pathname: window.location.pathname,
      timestamp: Date.now()
    }, details || {}));
  }

  function logAdGuardLifecycle(phase, state, reason) {
    console.debug('[YTPM][AdGuard]',
      'phase=' + phase,
      'generation=' + String(state && state.generation != null ? state.generation : ''),
      'surface=' + String(state && state.surface ? state.surface : 'unknown'),
      'videoId=' + String(state && state.videoId ? state.videoId : ''),
      reason ? 'reason=' + reason : '');
  }

  function cancelHistoryNativeFallbackIntent(reason) {
    if (historyNativeFallbackStartTimer) {
      window.clearTimeout(historyNativeFallbackStartTimer);
      historyNativeFallbackStartTimer = 0;
      logHistoryOwnershipEndCancel(historyNativeFallbackSession ? historyNativeFallbackSession.generation : 'none', historyNativeFallbackIntentGeneration, reason || 'intent-cancelled');
    }
    historyNativeFallbackIntentGeneration += 1;
  }

  function isPointInsideElement(element, point) {
    if (!element || !element.isConnected || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    return Boolean(rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  }

  function elementHovered(element) {
    return Boolean(element && element.isConnected && typeof element.matches === 'function' && (element.matches(':hover') || (typeof element.querySelector === 'function' && element.querySelector(':hover'))));
  }

  function getHistoryHoverEvidence(session) {
    const card = session && session.card;
    const thumbnail = card && findThumbnailHost(card);
    const candidate = card && thumbnail ? resolveHistoryYtActionTargetCandidate(card, thumbnail) : null;
    const preview = session && session.nativePreview;
    const overlay = session && session.overlay;
    const point = session && session.lastPointer;
    const ownershipValid = Boolean(session && historyNativeFallbackSession === session && session.generation === historyNativeFallbackGeneration && session.active && card && card.isConnected && preview && preview.isConnected);
    return {
      cardConnected: Boolean(card && card.isConnected), thumbnailConnected: Boolean(thumbnail && thumbnail.isConnected), candidateConnected: Boolean(candidate && candidate.isConnected), previewConnected: Boolean(preview && preview.isConnected),
      cardHovered: elementHovered(card), thumbnailHovered: elementHovered(thumbnail), candidateHovered: elementHovered(candidate), previewHovered: elementHovered(preview), overlayHovered: elementHovered(overlay),
      pointerInsideCardBounds: isPointInsideElement(card, point), pointerInsideThumbnailBounds: isPointInsideElement(thumbnail, point), pointerInsideOverlayBounds: isPointInsideElement(overlay, point),
      generationCurrent: Boolean(session && session.generation === historyNativeFallbackGeneration), sessionCurrent: Boolean(session && historyNativeFallbackSession === session), ownershipValid: ownershipValid
    };
  }

  function classifyHistoryHoverLoss(evidence) {
    if (!evidence.sessionCurrent || !evidence.generationCurrent) return 'SESSION_STALE';
    if (!evidence.ownershipValid) return 'OWNERSHIP_LOST';
    if (evidence.overlayHovered || evidence.pointerInsideOverlayBounds) return 'POINTER_INSIDE_OVERLAY';
    if (evidence.cardHovered || evidence.pointerInsideCardBounds) return 'CARD_STILL_HOVERED';
    if (!evidence.thumbnailConnected) return 'THUMBNAIL_REPLACED_SESSION_STILL_VALID';
    if (!evidence.candidateConnected) return 'CANDIDATE_REPLACED_SESSION_STILL_VALID';
    return 'REAL_POINTER_EXIT';
  }

  function logHistoryHoverLossCandidate(session) {
    const evidence = getHistoryHoverEvidence(session);
    const classification = classifyHistoryHoverLoss(evidence);
    console.debug('[YTPM][AdHover]', 'generation=' + String(session && session.generation), 'phase=loss-candidate', 'classification=' + classification, evidence);
    return classification;
  }

  function isHistoryFallbackInteractionValid(session) {
    const evidence = getHistoryHoverEvidence(session);
    return evidence.ownershipValid && (evidence.thumbnailHovered || evidence.cardHovered || evidence.overlayHovered || evidence.pointerInsideCardBounds || evidence.pointerInsideOverlayBounds);
  }

  let historyFallbackPendingCleanup = null;

  function logHistoryOwnershipEnd(session, reason, timerContext) {
    if (session && session.ownershipEndLogged) {
      return;
    }
    if (session) {
      session.ownershipEndLogged = true;
    }

    const card = session && session.card;
    const thumbnail = card && findThumbnailHost(card);
    const outer = session && (session.outer || document.querySelector('ytd-player#inline-player'));
    const inner = session && (session.inner || (outer && outer.querySelector('#inline-preview-player.html5-video-player')));
    const overlay = (session && session.overlay) || outer;
    const point = session && session.lastPointer;
    const pointerInOverlay = Boolean(isPointInsideElement(overlay, point) || elementHovered(overlay));
    const pointerInCard = Boolean(isPointInsideElement(card, point));
    const pointerInThumbnail = Boolean(isPointInsideElement(thumbnail, point));
    const sessionCurrent = Boolean(session && historyNativeFallbackSession === session);

    const parts = [
      'generation=' + String(session && session.generation != null ? session.generation : 'none'),
      'currentFallbackGeneration=' + String(historyNativeFallbackGeneration),
      'sessionStillCurrent=' + String(sessionCurrent),
      'cardConnected=' + String(Boolean(card && card.isConnected)),
      'thumbnailConnected=' + String(Boolean(thumbnail && thumbnail.isConnected)),
      'outerConnected=' + String(Boolean(outer && outer.isConnected)),
      'innerConnected=' + String(Boolean(inner && inner.isConnected)),
      'cardHovered=' + String(elementHovered(card)),
      'thumbnailHovered=' + String(elementHovered(thumbnail)),
      'pointerInsideOverlay=' + String(pointerInOverlay),
      'pointerInsideCardGeometry=' + String(pointerInCard),
      'pointerInsideThumbnailGeometry=' + String(pointerInThumbnail),
      'activeCardSame=' + String(Boolean(lastHoveredCard && card && lastHoveredCard === card)),
      'activeOuterSame=' + String(Boolean(outer && outer.isConnected && thumbnail && outer.parentNode === thumbnail)),
      'activeInnerSame=' + String(Boolean(inner && inner.isConnected && outer && inner.parentNode === outer)),
      'pendingCleanupPresent=' + String(Boolean(historyFallbackPendingCleanup && historyFallbackPendingCleanup.timer)),
      'cleanupOwnerGeneration=' + String(historyFallbackPendingCleanup ? historyFallbackPendingCleanup.ownerGeneration : 'none'),
      'reason=' + String(reason || 'fallback-ownership-ended')
    ];

    if (timerContext && typeof timerContext === 'object') {
      if (timerContext.callbackGeneration != null) {
        parts.push('callbackGeneration=' + String(timerContext.callbackGeneration));
      }
      parts.push('currentGeneration=' + String(timerContext.currentGeneration != null ? timerContext.currentGeneration : historyNativeFallbackGeneration));
      if (timerContext.scheduledAt != null) {
        parts.push('callbackAgeMs=' + String(Math.max(0, Math.round(Date.now() - timerContext.scheduledAt))));
      }
    }

    console.debug('[YTPM][HistoryOwnershipEnd]', parts.join(' '));
  }

  function logHistoryOwnershipEndSchedule(generation, callbackGeneration, delayMs, trigger, session) {
    const card = session && session.card;
    const outer = session && (session.outer || document.querySelector('ytd-player#inline-player'));
    const overlay = (session && session.overlay) || outer;
    const point = session && session.lastPointer;
    const pointerInOverlay = Boolean(isPointInsideElement(overlay, point) || elementHovered(overlay));
    const sessionCurrent = Boolean(session && historyNativeFallbackSession === session);

    const parts = [
      'generation=' + String(generation != null ? generation : 'none'),
      'callbackGeneration=' + String(callbackGeneration != null ? callbackGeneration : 'none'),
      'delayMs=' + String(delayMs != null ? delayMs : 0),
      'trigger=' + String(trigger || 'unknown'),
      'cardHovered=' + String(elementHovered(card)),
      'pointerInsideOverlay=' + String(pointerInOverlay),
      'sessionStillCurrent=' + String(sessionCurrent)
    ];

    console.debug('[YTPM][HistoryOwnershipEndSchedule]', parts.join(' '));
  }

  function logHistoryOwnershipEndCancel(generation, callbackGeneration, cancelReason) {
    const parts = [
      'generation=' + String(generation != null ? generation : 'none'),
      'callbackGeneration=' + String(callbackGeneration != null ? callbackGeneration : 'none'),
      'cancelReason=' + String(cancelReason || 'cancelled')
    ];

    console.debug('[YTPM][HistoryOwnershipEndCancel]', parts.join(' '));
  }

  function scheduleHistoryOwnershipEnd(session, delayMs, trigger) {
    cancelHistoryOwnershipEnd('rescheduled');
    const generation = session ? session.generation : historyNativeFallbackGeneration;
    const cleanup = {
      ownerGeneration: generation,
      scheduledAt: Date.now(),
      delayMs: delayMs,
      trigger: trigger || 'ownership-lost',
      timer: window.setTimeout(function () {
        if (historyFallbackPendingCleanup === cleanup) {
          historyFallbackPendingCleanup = null;
        }
        if (historyNativeFallbackSession === session) {
          logHistoryOwnershipEnd(session, 'fallback-ownership-ended', {
            callbackGeneration: generation,
            currentGeneration: historyNativeFallbackGeneration,
            scheduledAt: cleanup.scheduledAt
          });
          cleanupHistoryNativeFallback('fallback-ownership-ended');
        }
      }, delayMs)
    };
    historyFallbackPendingCleanup = cleanup;
    logHistoryOwnershipEndSchedule(generation, generation, delayMs, trigger, session);
    return cleanup;
  }

  function cancelHistoryOwnershipEnd(reason) {
    if (historyFallbackPendingCleanup && historyFallbackPendingCleanup.timer) {
      window.clearTimeout(historyFallbackPendingCleanup.timer);
      const ownerGen = historyFallbackPendingCleanup.ownerGeneration;
      historyFallbackPendingCleanup = null;
      logHistoryOwnershipEndCancel(historyNativeFallbackSession ? historyNativeFallbackSession.generation : ownerGen, ownerGen, reason || 'cancelled');
    }
  }

  function logAdExposureFenceFailure(invariant, session, fields) {
    if (!DEBUG_LOGGING || typeof console === 'undefined' || typeof console.debug !== 'function') return;
    const elapsedMs = session && session.startedAt ? Math.max(0, Math.round(Date.now() - session.startedAt)) : 0;
    const inner = session && session.outer && session.outer.querySelector('#inline-preview-player.html5-video-player');
    const video = inner && inner.querySelector('video');
    const adShowing = Boolean(inner && (inner.classList.contains('ad-showing') || inner.hasAttribute('ad-showing')));
    const adInterrupting = Boolean(inner && (inner.classList.contains('ad-interrupting') || inner.hasAttribute('ad-interrupting')));
    const fenceClosed = Boolean(session && session.fenceActive);
    const gateClosed = Boolean(session && session.outer && session.outer.getAttribute('data-ytpm-presentation-closed') === 'true');
    const parts = [
      'generation=' + String(session ? session.generation : ''),
      'phase=failure',
      'invariant=' + String(invariant),
      'elapsedMs=' + String(elapsedMs),
      'fenceClosed=' + String(fenceClosed),
      'presentationGateClosed=' + String(gateClosed),
      'playerPresented=' + String(Boolean(session && session.active)),
      'videoPresented=' + String(Boolean(video && video.isConnected)),
      'adShowing=' + String(adShowing),
      'adInterrupting=' + String(adInterrupting)
    ];
    if (fields) {
      Object.keys(fields).forEach(function (k) {
        parts.push(k + '=' + String(fields[k]));
      });
    }
    console.debug('[YTPM][AdExposureFence]', parts.join(' '));
  }

  function activateHistoryPrePresentationFence(session) {
    if (!session || session.fenceActive) return;
    session.fenceActive = true;
    session.fenceClosedAt = Date.now();
    const thumbnailHost = session.card && findThumbnailHost(session.card);
    if (thumbnailHost) {
      session.thumbnailHost = thumbnailHost;
      thumbnailHost.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
    }
    if (session.card && session.card.setAttribute) {
      session.card.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
    }
    if (session.preview && session.preview.setAttribute) {
      session.preview.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
    }
    if (session.outer && session.outer.setAttribute) {
      session.outer.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
    }
  }

  function releaseHistoryPrePresentationFence(session, reason) {
    if (!session || !session.fenceActive) return;
    if (reason === 'presentation-gate-authoritative') {
      const gateClosed = Boolean(session.outer && session.outer.getAttribute('data-ytpm-presentation-closed') === 'true');
      if (!gateClosed) {
        logAdExposureFenceFailure('PRESENTATION_GATE_NOT_CLOSED_BEFORE_HANDOFF', session, { reason: reason });
      }
    }
    session.fenceActive = false;
    if (session.thumbnailHost && session.thumbnailHost.removeAttribute) {
      session.thumbnailHost.removeAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE);
    }
    if (session.card && session.card.removeAttribute) {
      session.card.removeAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE);
    }
    if (session.preview && session.preview.removeAttribute) {
      session.preview.removeAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE);
    }
    if (session.outer && session.outer.removeAttribute) {
      session.outer.removeAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE);
    }
  }

  function cleanupHistoryNativeFallback(reason) {
    const session = historyNativeFallbackSession;
    if (!session) { return; }
    releaseHistoryPrePresentationFence(session, reason || 'history-cleanup');
    logHistoryOwnershipEnd(session, reason || 'history-cleanup');
    cancelHistoryOwnershipEnd('session-cleanup');
    disarmPreviewAdGuard(session, reason || 'history-cleanup');
    disposeFreshLoadFence(session, reason || 'history-cleanup');
    if (session.pollTimer) { window.clearTimeout(session.pollTimer); }
    if (session.monitorTimer) { window.clearInterval(session.monitorTimer); }
    if (session.mediaObserver) { session.mediaObserver.disconnect(); }
    if (session.hoverPointerListener) { document.removeEventListener('pointermove', session.hoverPointerListener, true); }
    if (session.outer && session.outer.isConnected && session.outer.parentNode === session.thumbnailHost && session.outerParent) {
      session.outerParent.insertBefore(session.outer, session.outerNextSibling && session.outerNextSibling.parentNode === session.outerParent ? session.outerNextSibling : null);
    }
    if (session.outer) { session.outer.classList.remove(HISTORY_FALLBACK_CLASS); session.outer.style.cssText = session.outerStyle || ''; }
    if (session.preview) { session.preview.classList.remove(HISTORY_FALLBACK_CLASS); }
    if (session.card) { session.card.classList.remove(HISTORY_FALLBACK_CLASS); }
    if (session.thumbnailHost) { session.thumbnailHost.classList.remove(HISTORY_FALLBACK_CLASS); }
    logHistoryNativeFallback('historyNativeFallbackCleanup', { reason: reason || 'explicit', videoId: session.videoId, generation: session.generation });
    historyNativeFallbackSession = null;
    schedulePreviewSync();
  }

  function historyNativeFallbackState(session) {
    const outer = session && session.outer;
    const inner = outer && outer.querySelector('#inline-preview-player.html5-video-player');
    const video = inner && inner.querySelector('video');
    return {
      videoId: session && session.videoId,
      generation: session && session.generation,
      cardConnected: Boolean(session && session.card && session.card.isConnected),
      previewConnected: Boolean(session && session.preview && session.preview.isConnected),
      innerConnected: Boolean(inner && inner.isConnected),
      sourceScheme: video ? (/^blob:/i.test(video.currentSrc || video.src || '') ? 'blob:' : (video.currentSrc || video.src) ? 'other:' : 'empty') : 'empty',
      readyState: video ? Number(video.readyState) : 0,
      paused: video ? Boolean(video.paused) : true,
      muted: video ? Boolean(video.muted) : null
    };
  }

  function presentHistoryNativeFallback(session) {
    const thumbnailHost = session.card && findThumbnailHost(session.card);
    if (!thumbnailHost || !session.outer || !session.outer.isConnected) { return false; }
    session.thumbnailHost = thumbnailHost;
    session.outerParent = session.outer.parentNode;
    session.outerNextSibling = session.outer.nextSibling;
    session.outerStyle = session.outer.getAttribute('style') || '';
    if (!document.getElementById('ytpm-history-native-fallback-style')) {
      const style = document.createElement('style');
      style.id = 'ytpm-history-native-fallback-style';
      style.textContent = '.ytpm-history-native-fallback-active animated-thumbnail-overlay-view-model{visibility:hidden!important;pointer-events:none!important;}';
      (document.head || document.documentElement).appendChild(style);
    }
    thumbnailHost.classList.add(HISTORY_FALLBACK_CLASS);
    session.card.classList.add(HISTORY_FALLBACK_CLASS);
    session.preview.classList.add(HISTORY_FALLBACK_CLASS);
    session.outer.classList.add(HISTORY_FALLBACK_CLASS);
    if (session.fenceActive) {
      thumbnailHost.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
      session.outer.setAttribute(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true');
    }
    thumbnailHost.appendChild(session.outer);
    session.outer.style.position = 'absolute';
    session.outer.style.inset = '0';
    session.outer.style.width = '100%';
    session.outer.style.height = '100%';
    session.outer.style.zIndex = '2';
    session.outer.style.pointerEvents = 'none';
    if (!session.fenceActive) {
      logAdExposureFenceFailure('FENCE_NOT_ACTIVE_BEFORE_PRESENT', session);
    }
    logHistoryNativeFallback('historyNativeFallbackPresented', historyNativeFallbackState(session));
    return true;
  }

  function findHistoryFallbackCard(videoId) {
    return Array.from(collectCards(document)).find(function (card) {
      return getVideoIdFromKey(getCardVideoKey(card)) === videoId;
    }) || null;
  }

  function requestHistoryNativeFallback(event, trigger) {
    const videoId = event && event.detail && typeof event.detail.videoId === 'string' ? event.detail.videoId : '';
    const capturedCard = event && event.detail && isElement(event.detail.card) ? event.detail.card : null;
    const requestTrigger = trigger || 'debug-command';
    logHistoryNativeFallback('historyNativeFallbackRequested', { videoId: String(videoId).slice(0, 32), trigger: requestTrigger });
    logHistoryNativeFallback('historyNativeFallbackEntered', { pathname: window.location.pathname, requestedVideoId: String(videoId).slice(0, 32) });
    try { return requestHistoryNativeFallbackInternal(videoId, requestTrigger, capturedCard); } catch (error) {
      logHistoryNativeFallback('historyNativeFallbackFailed', { phase: historyNativeFallbackPhase, reason: 'internal-error', errorName: error && error.name || 'Error' });
      cleanupHistoryNativeFallback('internal-error');
      return { ok: false, reason: 'internal-error' };
    }
  }

  function requestHistoryNativeFallbackInternal(videoId, trigger, capturedCard) {
    historyNativeFallbackPhase = 'validate';
    if (!isNativeFallbackSurface(window.location.pathname)) { logHistoryNativeFallback('historyNativeFallbackFailed', { reason: 'wrong-pathname' }); return; }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) { logHistoryNativeFallback('historyNativeFallbackFailed', { reason: 'invalid-video-id' }); return; }
    if (historyNativeFallbackSession) {
      logHistoryOwnershipEnd(historyNativeFallbackSession, 'replaced');
      cleanupHistoryNativeFallback('replaced');
    }
    const card = capturedCard || findHistoryFallbackCard(videoId);
    if (isMembersOnlyCard(card)) {
      logHistoryNativeFallback('historyNativeFallbackFailed', { reason: 'members-only-restricted', requestedVideoId: videoId });
      return;
    }
    const preview = document.querySelector('ytd-video-preview');
    const outer = document.querySelector('ytd-player#inline-player');
    if (preview && preview.hasAttribute('active') && isPreviewAssociatedWithCard(card, preview)) {
      const activeVideo = findVideoInPreview(preview);
      if (activeVideo && isPreviewReady(activeVideo)) {
        logHistoryNativeFallback('historyNativeFallbackFailed', { reason: 'natural-preview-already-active', requestedVideoId: videoId });
        return;
      }
    }
    const hovered = Boolean(card && (card.matches(':hover') || card.querySelector(':hover')));
    const thumbnailHovered = isThumbnailHovered(card);
    if (!card || !isElement(card) || !thumbnailHovered || !preview || !outer) {
      logHistoryNativeFallback('historyNativeFallbackFailed', { phase: 'validate', reason: !card ? 'target-card-not-found' : !thumbnailHovered ? 'thumbnail-not-hovered' : !preview ? 'preview-not-found' : 'outer-player-not-found', requestedVideoId: videoId, cardHovered: hovered, thumbnailHovered: thumbnailHovered });
      return;
    }
    const session = { videoId: videoId, card: card, preview: preview, outer: outer, startedAt: Date.now(), active: false, fenceActive: false, fenceClosedAt: 0, firstMediaActivityLogged: false, pollTimer: 0, generation: ++historyNativeFallbackGeneration, trigger: 'automatic-hover', surface: 'history-native-fallback', mediaStarted: false, adSessionId: '', adGuard: null, nativePreview: preview, nativePreviewPlayer: null, overlay: outer, video: null, isCurrent: function () { return historyNativeFallbackSession === session; } };
    historyNativeFallbackSession = session;
    activateHistoryPrePresentationFence(session);
    session.hoverPointerListener = function (event) {
      if (historyNativeFallbackSession === session && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        session.lastPointer = { x: Number(event.clientX), y: Number(event.clientY) };
      }
    };
    document.addEventListener('pointermove', session.hoverPointerListener, { capture: true, passive: true });
    historyNativeFallbackPhase = 'prepare';
    logHistoryNativeFallback('historyNativeFallbackPreparing', { videoId: videoId, trigger: trigger, generation: session.generation });
    const continueAfterPreparation = function () {
      const deadline = Date.now() + 2200;
      const waitForInner = function () {
        if (historyNativeFallbackSession !== session || session.generation !== historyNativeFallbackGeneration) { return; }
        const inner = outer.querySelector('#inline-preview-player.html5-video-player');
        if (inner && inner.isConnected) {
          session.inner = inner;
          session.nativePreviewPlayer = inner;
          session.video = inner.querySelector('video');
          logHistoryNativeFallback('historyNativeFallbackPrepared', { videoId: videoId, generation: session.generation });
          if (!presentHistoryNativeFallback(session)) { cleanupHistoryNativeFallback('presentation-unavailable'); return; }
          session.active = true;
          logHistoryNativeFallback('historyNativeFallbackOwned', { videoId: videoId, generation: session.generation });
          if (typeof MutationObserver === 'function') {
            session.mediaObserver = new MutationObserver(function () {
              const media = session.outer.querySelector('#inline-preview-player video, #inline-preview-player.html5-video-player video');
              if (media && historyNativeFallbackSession === session && (!activeOverlay || activeOverlay.video !== media)) {
                media.muted = true;
              }
            });
            session.mediaObserver.observe(session.outer, { childList: true, subtree: true });
          }
          armHistoryPreviewAdGuard(session);
          if (session.adGuard && typeof session.adGuard.noteLoadRequested === 'function') {
            session.adGuard.noteLoadRequested();
          }
          logHistoryNativeFallback('historyNativeFallbackLoadRequested', { videoId: videoId, generation: session.generation });
          requestPageBridge('history-native-fallback-load', {
            videoId: videoId,
            generation: session.generation
          }, 5000).then(function (result) {
            if (historyNativeFallbackSession !== session) { return; }
            logHistoryNativeFallback('historyNativeFallbackLoadBridgeResult', { videoId: videoId, generation: session.generation, ok: Boolean(result && result.ok), reason: result && result.reason || null, outerPresent: Boolean(result && result.outerPresent), innerPresent: Boolean(result && result.innerPresent), loadMethodPresent: Boolean(result && result.loadMethodPresent), loadInvoked: Boolean(result && result.loadInvoked), videoPresentBefore: Boolean(result && result.videoPresentBefore), videoPresentAfterImmediate: Boolean(result && result.videoPresentAfterImmediate), pausedAfterImmediate: result && typeof result.pausedAfterImmediate === 'boolean' ? result.pausedAfterImmediate : null, readyStateAfterImmediate: result && Number.isFinite(result.readyStateAfterImmediate) ? result.readyStateAfterImmediate : null });
            if (result && result.invoked) {
              logHistoryNativeFallback('historyNativeFallbackLoadInvoked', { videoId: videoId, generation: session.generation });
              session.monitorTimer = window.setInterval(function () {
                if (historyNativeFallbackSession !== session) { return; }
                if (!isNativeFallbackSurface(window.location.pathname) || !session.card.isConnected || lastHoveredCard !== session.card || !isHistoryFallbackInteractionValid(session)) {
                  logHistoryOwnershipEnd(session, 'fallback-ownership-ended', {
                    callbackGeneration: session.generation,
                    currentGeneration: historyNativeFallbackGeneration,
                    scheduledAt: session.startedAt
                  });
                  cleanupHistoryNativeFallback('fallback-ownership-ended');
                  return;
                }
                const state = historyNativeFallbackState(session);
                const media = session.outer.querySelector('#inline-preview-player video');
                if (media && (!activeOverlay || activeOverlay.video !== media)) {
                  media.muted = true;
                }
                if (!session.mediaStarted && state.sourceScheme !== 'empty' && state.paused === false) {
                  session.mediaStarted = true;
                  logHistoryNativeFallback('historyNativeFallbackMediaStarted', state);
                }
              }, 100);
            } else {
              logHistoryOwnershipEnd(session, 'load-not-invoked');
              cleanupHistoryNativeFallback('load-not-invoked');
              logHistoryNativeFallback('historyNativeFallbackFailed', { reason: result && result.reason || 'load-not-invoked' });
            }
          }).catch(function () {
            if (historyNativeFallbackSession === session) {
              logHistoryOwnershipEnd(session, 'load-bridge-rejected');
              cleanupHistoryNativeFallback('load-bridge-rejected');
            }
          });
          return;
        }
        if (Date.now() >= deadline) {
          logHistoryOwnershipEnd(session, 'inner-player-not-prepared', {
            callbackGeneration: session.generation,
            currentGeneration: historyNativeFallbackGeneration,
            scheduledAt: session.startedAt
          });
          cleanupHistoryNativeFallback('inner-player-not-prepared');
          return;
        }
        session.pollTimer = window.setTimeout(waitForInner, 25);
      };
      waitForInner();
    };
    const existingInner = outer.querySelector('#inline-preview-player.html5-video-player');
    const existingVideo = existingInner && existingInner.querySelector('video');
    const existingCold = existingInner && existingInner.isConnected && !(existingInner.getAttribute('video-id') || existingInner.videoId) && (!existingVideo || !(existingVideo.currentSrc || existingVideo.src));
    stopHistoryYtActionTargetMirror(globalThis.__ytpmHistoryTargetMirror, 'preparation-begin');
    if (existingInner && !existingCold && trigger !== 'automatic-hover') { cleanupHistoryNativeFallback('inner-player-not-cold'); }
    else if (existingInner) { continueAfterPreparation(); }
    else { requestPageBridge('history-native-fallback-prepare', { videoId: videoId }, 2600).then(continueAfterPreparation).catch(function () { cleanupHistoryNativeFallback('prepare-bridge-rejected'); }); }
  }

  function disposeFreshLoadFence(session, reason) {
    const fence = session && session.freshLoadFence;
    if (!fence) {
      return;
    }
    fence.dispose(reason || 'disposed');
    session.freshLoadFence = null;
  }

  function createFreshLoadFence(session, surface) {
    disposeFreshLoadFence(session, 'replaced');
    const fence = {
      evidence: false,
      eventName: '',
      evidenceVideo: null,
      disposed: false,
      observer: null,
      innerCleanups: [],
      inner: null,
      video: null,
      markLoadStarted: null,
      hasEvidence: function () { return fence.evidence === true; },
      getEventName: function () { return fence.eventName; },
      getEvidenceVideo: function () { return fence.evidenceVideo; },
      dispose: function (reason) {
        if (fence.disposed) {
          return;
        }
        fence.disposed = true;
        if (fence.observer) {
          fence.observer.disconnect();
          fence.observer = null;
        }
        fence.innerCleanups.forEach(function (cleanup) { cleanup(); });
        fence.innerCleanups = [];
        forensicLog('ExplicitFreshLoadFence', 'explicitFreshLoadFenceDisposed', {
          surface: surface,
          generation: session.generation,
          reason: reason || 'disposed'
        });
      }
    };
    session.freshLoadFence = fence;
    const isCurrent = function () {
      return typeof session.isCurrent === 'function' ? session.isCurrent() : true;
    };
    fence.markLoadStarted = function () {
      if (fence.disposed) {
        return;
      }
      session.loadRequestStarted = true;
      session.loadStartedAt = Date.now();
      forensicLog('ExplicitFreshLoadFence', 'explicitFreshLoadStarted', {
        surface: surface,
        generation: session.generation
      });
    };
    const observeVideo = function (inner) {
      if (!inner || !inner.isConnected || fence.disposed) {
        return;
      }
      fence.innerCleanups.forEach(function (cleanup) { cleanup(); });
      fence.innerCleanups = [];
      if (fence.video && fence.video !== video) {
        fence.evidence = false;
        fence.eventName = '';
        fence.evidenceVideo = null;
      }
      fence.inner = inner;
      fence.video = inner.querySelector('video');
      ['loadstart', 'emptied', 'loadedmetadata', 'canplay', 'playing'].forEach(function (eventName) {
        const handler = function (event) {
          const eventVideo = event.target && event.target.tagName === 'VIDEO' ? event.target : null;
          if (!eventVideo || !session.loadRequestStarted || fence.evidence || fence.disposed || !isCurrent()) {
            return;
          }
          fence.evidence = true;
          fence.eventName = eventName;
          fence.evidenceVideo = eventVideo;
          fence.video = eventVideo;
          if (typeof session.onFreshLoadEvidence === 'function') {
            session.onFreshLoadEvidence(eventName, eventVideo);
          }
          forensicLog('ExplicitFreshLoadFence', 'explicitFreshLoadEvidence', {
            surface: surface,
            generation: session.generation,
            eventName: eventName,
            reason: 'post-load-lifecycle'
          });
        };
        inner.addEventListener(eventName, handler, true);
        fence.innerCleanups.push(function () { inner.removeEventListener(eventName, handler, true); });
      });
    };
    const observeInner = function (inner) {
      if (!inner || !inner.isConnected || fence.disposed) {
        return;
      }
      if (fence.inner === inner && fence.innerCleanups.length && fence.video === inner.querySelector('video')) {
        return;
      }
      observeVideo(inner);
    };
    const outer = session.outer && session.outer.isConnected
      ? session.outer
      : document.querySelector('ytd-player#inline-player');
    observeInner(outer && outer.querySelector('#inline-preview-player.html5-video-player'));
    if (outer && typeof MutationObserver === 'function') {
      fence.observer = new MutationObserver(function () {
        observeInner(outer.querySelector('#inline-preview-player.html5-video-player'));
      });
      fence.observer.observe(outer, { childList: true, subtree: true });
    }
    forensicLog('ExplicitFreshLoadFence', 'explicitFreshLoadFenceArmed', {
      surface: surface,
      generation: session.generation
    });
    return fence;
  }

  function queueHistoryNativeFallback(card) {
    if (!isNativeFallbackSurface(window.location.pathname) || !card || !isElement(card) || isMembersOnlyCard(card)) {
      return;
    }
    if (historyNativeFallbackStartTimer) {
      window.clearTimeout(historyNativeFallbackStartTimer);
      logHistoryOwnershipEndCancel(historyNativeFallbackSession ? historyNativeFallbackSession.generation : 'none', historyNativeFallbackIntentGeneration, 'intent-rescheduled');
    }
    const videoId = getVideoIdFromKey(getCardVideoKey(card));
    if (!videoId) {
      return;
    }
    const intentGeneration = ++historyNativeFallbackIntentGeneration;
    const surfaceName = detectCurrentSurface(window.location.pathname).toLowerCase();
    snapshotPreviewEligibilityState(card, surfaceName, intentGeneration);
    startHistoryYtActionTargetMirror(card, getCardVideoKey(card), intentGeneration);
    forensicLog('HistoryNativeFallback', 'historyNativeFallbackTargetScheduled', Object.assign({ requestedVideoId: videoId, scheduledCardPresent: Boolean(card), scheduledCardConnected: Boolean(card && card.isConnected), scheduledCardTagName: card ? card.tagName : '', scheduledCardClassName: card ? String(card.className || '').slice(0, 160) : '', scheduledCardHovered: Boolean(card && (card.matches(':hover') || card.querySelector(':hover'))), scheduledThumbnailHovered: isThumbnailHovered(card), timestamp: performance.now() }, getHistoryFallbackIdentityDiagnostics(videoId, card)));
    logHistoryOwnershipEndSchedule(historyNativeFallbackSession ? historyNativeFallbackSession.generation : 'none', intentGeneration, 80, 'automatic-hover', historyNativeFallbackSession);
    historyNativeFallbackStartTimer = window.setTimeout(function () {
      historyNativeFallbackStartTimer = 0;
      const stillHovered = Boolean(card && (card.matches(':hover') || card.querySelector(':hover')));
      const stillThumbnailHovered = isThumbnailHovered(card);
      if (lastHoveredCard === card && intentGeneration === historyNativeFallbackIntentGeneration && card.isConnected && getVideoIdFromKey(getCardVideoKey(card)) === videoId && stillThumbnailHovered && videoId) {
        forensicLog('HistoryNativeFallback', 'historyNativeFallbackTargetValidated', Object.assign({ requestedVideoId: videoId, validatedSameObject: true, validatedCardConnected: true, validatedCardTagName: card.tagName, validatedCardClassName: String(card.className || '').slice(0, 160), validatedCardHovered: stillHovered, validatedThumbnailHovered: stillThumbnailHovered, timestamp: performance.now() }, getHistoryFallbackIdentityDiagnostics(videoId, card)));
        requestHistoryNativeFallback({ detail: { videoId: videoId, card: card } }, 'automatic-hover');
      } else if (videoId) {
        forensicLog('HistoryNativeFallback', 'historyNativeFallbackTargetValidated', Object.assign({ requestedVideoId: videoId, validatedSameObject: false, validatedCardConnected: Boolean(card && card.isConnected), validatedCardTagName: card ? card.tagName : '', validatedCardClassName: card ? String(card.className || '').slice(0, 160) : '', validatedCardHovered: stillHovered, validatedThumbnailHovered: stillThumbnailHovered, timestamp: performance.now() }, getHistoryFallbackIdentityDiagnostics(videoId, card)));
      }
    }, 80);
  }

  const queueNativePreviewFallback = queueHistoryNativeFallback;
  const requestNativePreviewFallback = requestHistoryNativeFallback;
  const cleanupNativePreviewFallback = cleanupHistoryNativeFallback;

  function handleCardHoverExit(event) {
    const target = isElement(event.target) ? event.target : null;
    const card = target ? target.closest(CARD_SELECTOR) : null;
    const related = isElement(event.relatedTarget) ? event.relatedTarget.closest(CARD_SELECTOR) : null;
    if (!card || card !== lastHoveredCard) {
      return;
    }
    if (isNativeFallbackSurface(window.location.pathname)) {
      const thumbnailHost = findThumbnailHost(card);
      const targetInThumbnail = Boolean(thumbnailHost && thumbnailHost.contains(event.target));
      const relatedInThumbnail = Boolean(thumbnailHost && isElement(event.relatedTarget) && thumbnailHost.contains(event.relatedTarget));
      if (!targetInThumbnail || relatedInThumbnail) {
        return;
      }
    } else if (related === card) {
      return;
    }
    cancelHistoryNativeFallbackIntent('card-hover-exit');
    if (historyNativeFallbackSession && historyNativeFallbackSession.card === card) {
      if (isNativeFallbackSurface(window.location.pathname)) {
        const classification = logHistoryHoverLossCandidate(historyNativeFallbackSession);
        if (classification === 'CARD_STILL_HOVERED' || classification === 'POINTER_INSIDE_OVERLAY' ||
          classification === 'THUMBNAIL_REPLACED_SESSION_STILL_VALID' || classification === 'CANDIDATE_REPLACED_SESSION_STILL_VALID') {
          return;
        }
      }
      const exitReason = isNativeFallbackSurface(window.location.pathname) ? 'thumbnail-no-longer-hovered' : 'target-card-no-longer-hovered';
      logHistoryOwnershipEnd(historyNativeFallbackSession, exitReason);
      cleanupHistoryNativeFallback(exitReason);
    }
    if (isNativeFallbackSurface(window.location.pathname)) {
      lastHoveredCard = null;
    }
    if (homeYtActionProvenanceSession && homeYtActionProvenanceSession.card === card) {
      verifyHomeYtActionProvenanceHover(homeYtActionProvenanceSession);
    }
    verifyHomeYtActionTargetLifecycleHover(globalThis.__ytpmHomeTargetLifecycle);
  }

  function isOverlayMediaConnected(state) {
    return Boolean(state && state.video && state.video.isConnected &&
      (!state.mediaRoot || state.mediaRoot.isConnected));
  }

  function queueFullScan() {
    fullScanRequested = true;
    schedulePreviewSync();
  }

  function nodeAffectsPreviewSync(node) {
    if (!isElement(node)) {
      return false;
    }

    return node.matches('ytd-video-preview, ytd-video-preview *') ||
      Boolean(node.querySelector('ytd-video-preview'));
  }

  function schedulePreviewSync(options) {
    if (!options || options.syncButton !== false) {
      previewSyncRequested = true;
    }

    if (scanQueued) {
      return;
    }

    scanQueued = true;
    scanFrame = window.requestAnimationFrame(function () {
      scanQueued = false;
      scanFrame = 0;

      if (fullScanRequested) {
        fullScanRequested = false;
        scanCards(document);
      }

      if (previewSyncRequested) {
        previewSyncRequested = false;
        syncPreviewButton();
      }

      if (activeOverlay && (!activeOverlay.card.isConnected ||
        !isOverlayMediaConnected(activeOverlay))) {
        closePreviewOverlay({ restoreFocus: false });
      }

      if (activeOverlay && !activeOverlay.overlay.isConnected) {
        closePreviewOverlay({ restoreFocus: false });
      }
    });
  }

  function createPlaceholder(video) {
    const placeholder = document.createElement('span');
    placeholder.className = PLACEHOLDER_CLASS;
    placeholder.setAttribute('aria-hidden', 'true');

    const rect = video.getBoundingClientRect();
    if (rect.width > 0) {
      placeholder.style.width = rect.width + 'px';
    }
    if (rect.height > 0) {
      placeholder.style.height = rect.height + 'px';
    }

    return placeholder;
  }

  function captureVideoState(video) {
    const state = {
      paused: video.paused,
      currentTime: video.currentTime,
      muted: video.muted,
      volume: video.volume,
      playbackRate: video.playbackRate,
      controls: video.controls,
      sourceUrl: video.currentSrc || video.getAttribute('src') || '',
      sourceObject: video.srcObject || null
    };

    return state;
  }

  function restoreVideoState(video, state, options) {
    try {
      video.muted = state.muted;
      video.volume = state.volume;
      video.playbackRate = state.playbackRate;
      video.controls = Boolean(state.controls);

      if (Number.isFinite(state.currentTime) && video.readyState > 0) {
        video.currentTime = state.currentTime;
      }

      if (!state.paused && !(options && options.skipPlayback)) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function (error) {
            reportError('restore-playback', error);
          });
        }
      }
    } catch (error) {
      reportError('restore-video-state', error);
    }
  }

  function restorePreviewSource(video, state) {
    if (hasVideoSource(video)) {
      return;
    }

    try {
      if (state.sourceObject) {
        video.srcObject = state.sourceObject;
      } else if (state.sourceUrl) {
        // Reuse only the already active preview source if YouTube cleared it.
        video.src = state.sourceUrl;
      }
    } catch (error) {
      reportError('restore-preview-source', error);
    }
  }

  function requestPreviewPlayback(state) {
    if (activeOverlay !== state || state.userPaused || !state.video.isConnected) {
      return;
    }

    const duration = Number(state.video.duration);
    const isAtPreviewEnd = Number.isFinite(duration) && duration > 0 &&
      Number.isFinite(state.video.currentTime) &&
      state.video.currentTime >= duration - 0.15;
    if (state.video.ended || isAtPreviewEnd) {
      try {
        state.video.currentTime = 0;
      } catch (error) {
        reportError('restart-preview-time', error);
      }
    }

    restorePreviewSource(state.video, state.videoState);

    try {
      const playPromise = state.video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function (error) {
          reportError('preview-playback-promise', error);
        });
      }
    } catch (error) {
      reportError('preview-playback', error);
    }
  }

  function schedulePreviewPlayback(state, remainingAttempts) {
    if (activeOverlay !== state || state.userPaused || !state.video.isConnected) {
      return;
    }

    if (state.playbackRetryTimer) {
      window.clearTimeout(state.playbackRetryTimer);
    }

    requestPreviewPlayback(state);

    if (remainingAttempts > 0 && activeOverlay === state) {
      state.playbackRetryTimer = window.setTimeout(function () {
        state.playbackRetryTimer = 0;
        schedulePreviewPlayback(state, remainingAttempts - 1);
      }, PLAYBACK_RETRY_DELAY_MS);
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createIconSvg(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ytpm-overlay__icon');

    const addSvgElement = function (tagName, attributes, text) {
      const element = document.createElementNS(SVG_NS, tagName);
      Object.keys(attributes || {}).forEach(function (attributeName) {
        element.setAttribute(attributeName, attributes[attributeName]);
      });
      if (text) {
        element.textContent = text;
      }
      svg.appendChild(element);
    };

    if (name === 'play') {
      addSvgElement('path', { d: 'M8 5v14l11-7z' });
    } else if (name === 'pause') {
      addSvgElement('path', { d: 'M6 5h4v14H6zm8 0h4v14h-4z' });
    } else if (name === 'volume') {
      addSvgElement('path', { d: 'M3 9v6h4l5 4V5L7 9H3z' });
      addSvgElement('path', { d: 'M16 8.5a5 5 0 0 1 0 7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' });
      addSvgElement('path', { d: 'M18.5 6a8.5 8.5 0 0 1 0 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' });
    } else if (name === 'muted') {
      addSvgElement('path', { d: 'M3 9v6h4l5 4V5L7 9H3z' });
      addSvgElement('path', { d: 'm16 9 5 6m0-6-5 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' });
    } else if (name === 'captions') {
      addSvgElement('rect', { x: '3', y: '6', width: '18', height: '12', rx: '1.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' });
      addSvgElement('text', { x: '4.1', y: '14.4', 'font-size': '7.2', 'font-family': 'Arial, sans-serif', 'font-weight': '700', fill: 'currentColor' }, 'CC');
    } else if (name === 'settings') {
      addSvgElement('path', { d: 'M19.43 12.98a7.9 7.9 0 0 0 .05-.98 7.9 7.9 0 0 0-.05-.98l2.11-1.65-2-3.46-2.49 1a7.4 7.4 0 0 0-1.69-.98L15 3.3h-4l-.37 2.63a7.4 7.4 0 0 0-1.69.98l-2.49-1-2 3.46 2.11 1.65a7.9 7.9 0 0 0-.05.98 7.9 7.9 0 0 0 .05.98l-2.11 1.65 2 3.46 2.49-1c.52.4 1.09.73 1.69.98L11 20.7h4l.37-2.63a7.4 7.4 0 0 0 1.69-.98l2.49 1 2-3.46-2.12-1.65zM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5z' });
    } else if (name === 'fullscreen') {
      addSvgElement('path', { d: 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z' });
    } else if (name === 'close') {
      addSvgElement('path', { d: 'm6 6 12 12M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
    }

    return svg;
  }

  function setButtonIcon(button, name) {
    button.replaceChildren(createIconSvg(name));
  }

  function createOverlayElements() {
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Expanded YouTube preview');
    overlay.tabIndex = -1;

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = CLOSE_CLASS;
    closeButton.setAttribute('aria-label', 'Close expanded preview');
    closeButton.title = 'Close expanded preview';
    setButtonIcon(closeButton, 'close');

    const frame = document.createElement('div');
    frame.className = FRAME_CLASS;
    frame.tabIndex = -1;
    frame.setAttribute('aria-label', 'Expanded preview player');

    const controls = document.createElement('div');
    controls.className = CONTROLS_CLASS;
    controls.setAttribute('role', 'toolbar');
    controls.setAttribute('aria-label', 'Preview controls');

    const leftControls = document.createElement('div');
    leftControls.className = 'ytpm-overlay__left-controls';

    const rightControls = document.createElement('div');
    rightControls.className = 'ytpm-overlay__right-controls';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = CONTROL_BUTTON_CLASS;
    playButton.setAttribute('aria-label', 'Play preview');
    playButton.title = 'Play preview';
    setButtonIcon(playButton, 'play');

    const muteButton = document.createElement('button');
    muteButton.type = 'button';
    muteButton.className = CONTROL_BUTTON_CLASS;
    muteButton.setAttribute('aria-label', 'Unmute preview');
    muteButton.title = 'Unmute preview';
    setButtonIcon(muteButton, 'muted');

    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.className = 'ytpm-overlay__volume';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.05';
    volumeInput.value = '1';
    volumeInput.setAttribute('aria-label', 'Preview volume');
    volumeInput.title = 'Preview volume';

    const volumeWrap = document.createElement('span');
    volumeWrap.className = 'ytpm-overlay__volume-wrap';
    volumeWrap.appendChild(muteButton);
    volumeWrap.appendChild(volumeInput);

    const captionsButton = document.createElement('button');
    captionsButton.type = 'button';
    captionsButton.className = CONTROL_BUTTON_CLASS + ' ytpm-overlay__captions-button';
    captionsButton.setAttribute('aria-label', 'Turn captions on');
    captionsButton.title = 'Turn captions on';
    captionsButton.setAttribute('aria-pressed', 'false');
    setButtonIcon(captionsButton, 'captions');

    const seekInput = document.createElement('input');
    seekInput.type = 'range';
    seekInput.className = SEEK_CLASS;
    seekInput.min = '0';
    seekInput.max = '1';
    seekInput.step = '0.1';
    seekInput.value = '0';
    seekInput.setAttribute('aria-label', 'Preview progress');

    const timeLabel = document.createElement('span');
    timeLabel.className = TIME_CLASS;
    timeLabel.textContent = '0:00 / 0:00';

    const timelinePreview = document.createElement('div');
    timelinePreview.className = TIMELINE_PREVIEW_CLASS;
    timelinePreview.hidden = true;
    timelinePreview.setAttribute('aria-hidden', 'true');

    const timelineImage = document.createElement('img');
    timelineImage.className = TIMELINE_PREVIEW_IMAGE_CLASS;
    timelineImage.alt = '';
    timelineImage.decoding = 'async';
    timelineImage.loading = 'eager';
    timelineImage.referrerPolicy = 'origin';
    timelineImage.draggable = false;

    const timelineTime = document.createElement('span');
    timelineTime.className = TIMELINE_PREVIEW_TIME_CLASS;
    timelineTime.textContent = '0:00';
    timelinePreview.appendChild(timelineImage);
    timelinePreview.appendChild(timelineTime);

    const captions = document.createElement('div');
    captions.className = 'ytpm-overlay__captions';
    captions.setAttribute('role', 'status');
    captions.setAttribute('aria-live', 'polite');
    captions.setAttribute('aria-atomic', 'true');
    captions.hidden = true;
    const captionViewport = document.createElement('div');
    captionViewport.className = 'ytpm-overlay__caption-viewport';
    const captionCurrent = document.createElement('div');
    captionCurrent.className = 'ytpm-overlay__caption-layer ytpm-overlay__caption-layer--current';
    const captionIncoming = document.createElement('div');
    captionIncoming.className = 'ytpm-overlay__caption-layer ytpm-overlay__caption-layer--incoming';
    captionViewport.appendChild(captionCurrent);
    captionViewport.appendChild(captionIncoming);
    captions.appendChild(captionViewport);

    const adShield = document.createElement('div');
    adShield.className = 'ytpm-overlay__ad-shield';
    adShield.setAttribute('aria-hidden', 'true');
    adShield.textContent = 'Preparing preview…';

    const qualityWrap = document.createElement('span');
    qualityWrap.className = QUALITY_CLASS;

    const qualityButton = document.createElement('button');
    qualityButton.type = 'button';
    qualityButton.className = CONTROL_BUTTON_CLASS;
    qualityButton.setAttribute('aria-label', 'Video quality');
    qualityButton.setAttribute('aria-haspopup', 'menu');
    qualityButton.setAttribute('aria-expanded', 'false');
    qualityButton.title = 'Video quality: Auto';
    setButtonIcon(qualityButton, 'settings');
    qualityButton.disabled = true;

    const qualityMenu = document.createElement('span');
    qualityMenu.className = QUALITY_MENU_CLASS;
    qualityMenu.setAttribute('role', 'menu');
    qualityMenu.hidden = true;
    qualityWrap.appendChild(qualityButton);
    qualityWrap.appendChild(qualityMenu);

    const fullscreenButton = document.createElement('button');
    fullscreenButton.type = 'button';
    fullscreenButton.className = CONTROL_BUTTON_CLASS;
    fullscreenButton.setAttribute('aria-label', 'Enter fullscreen');
    fullscreenButton.title = 'Enter fullscreen';
    setButtonIcon(fullscreenButton, 'fullscreen');

    leftControls.appendChild(playButton);
    leftControls.appendChild(volumeWrap);
    leftControls.appendChild(timeLabel);
    rightControls.appendChild(captionsButton);
    rightControls.appendChild(qualityWrap);
    rightControls.appendChild(fullscreenButton);
    controls.appendChild(leftControls);
    controls.appendChild(rightControls);

    overlay.appendChild(frame);
    frame.appendChild(closeButton);
    frame.appendChild(adShield);
    frame.appendChild(captions);
    frame.appendChild(timelinePreview);
    frame.appendChild(seekInput);
    frame.appendChild(controls);

    return {
      overlay: overlay,
      closeButton: closeButton,
      frame: frame,
      adShield: adShield,
      controls: {
        root: controls,
        leftControls: leftControls,
        rightControls: rightControls,
        playButton: playButton,
        muteButton: muteButton,
        captionsButton: captionsButton,
        volumeInput: volumeInput,
        seekInput: seekInput,
        timeLabel: timeLabel,
        captions: captions,
        captionViewport: captionViewport,
        captionCurrent: captionCurrent,
        captionIncoming: captionIncoming,
        timelinePreview: timelinePreview,
        timelineImage: timelineImage,
        timelineTime: timelineTime,
        qualityWrap: qualityWrap,
        qualityButton: qualityButton,
        qualityMenu: qualityMenu,
        fullscreenButton: fullscreenButton
      }
    };
  }

  function registerListener(cleanupList, target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanupList.push(function () {
      target.removeEventListener(type, handler, options);
    });
  }

  function hideOverlayControls(state) {
    if (activeOverlay !== state) {
      return;
    }

    if (
      !state.controls.qualityMenu.hidden ||
      state.seekDragging ||
      state.timelineHovering ||
      (state.overlay && state.overlay.contains(document.activeElement))
    ) {
      scheduleOverlayControlsHide(state);
      return;
    }

    state.elements.frame.classList.add(CONTROLS_HIDDEN_CLASS);
  }

  function scheduleOverlayControlsHide(state) {
    if (activeOverlay !== state) {
      return;
    }

    if (state.controlsHideTimer) {
      window.clearTimeout(state.controlsHideTimer);
    }
    state.controlsHideTimer = window.setTimeout(function () {
      state.controlsHideTimer = 0;
      hideOverlayControls(state);
    }, CONTROLS_HIDE_DELAY_MS);
  }

  function showOverlayControls(state) {
    if (activeOverlay !== state) {
      return;
    }

    state.elements.frame.classList.remove(CONTROLS_HIDDEN_CLASS);
    scheduleOverlayControlsHide(state);
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
    return minutes + ':' + remainingSeconds;
  }

  function clampSeekTimeValue(value, duration) {
    if (captionUtils.clampSeekTime) {
      return captionUtils.clampSeekTime(value, duration);
    }

    const safeDuration = Number(duration);
    const numericValue = Number(value);
    if (!Number.isFinite(safeDuration) || safeDuration <= 0 ||
      !Number.isFinite(numericValue)) {
      return 0;
    }

    return Math.max(0, Math.min(safeDuration, numericValue));
  }

  function getSeekDisplayTimeValue(actualTime, state, duration) {
    if (captionUtils.getSeekDisplayTime) {
      return captionUtils.getSeekDisplayTime(
        actualTime,
        state.pendingSeekTime,
        state.seekDragging,
        state.seekPending,
        duration
      );
    }

    return clampSeekTimeValue(
      state.seekDragging || state.seekPending
        ? state.pendingSeekTime
        : actualTime,
      duration
    );
  }

  function getPreviewDuration(state) {
    const metadataDuration = Number(state.duration);
    if (Number.isFinite(metadataDuration) && metadataDuration > 0) {
      return metadataDuration;
    }

    const videoDuration = Number(state.video && state.video.duration);
    return Number.isFinite(videoDuration) && videoDuration > 0
      ? videoDuration
      : 0;
  }

  function getCaptionTracks(video) {
    if (!video.textTracks) {
      return [];
    }

    return Array.from(video.textTracks).filter(function (track) {
      return track.kind === 'captions' || track.kind === 'subtitles';
    });
  }

  function getNativePreview(state) {
    const rememberedPreview = state.nativePreview;
    if (rememberedPreview && rememberedPreview.isConnected &&
      (!state.card || isPreviewAssociatedWithCard(state.card, rememberedPreview))) {
      return rememberedPreview;
    }

    const discoveredPreview = state.card && findActivePreview(state.card);
    if (discoveredPreview) {
      state.nativePreview = discoveredPreview;
      return discoveredPreview;
    }

    return null;
  }

  function getNativePreviewPlayer(preview) {
    if (!preview || typeof preview.querySelectorAll !== 'function') {
      return null;
    }

    const candidates = Array.from(preview.querySelectorAll(
      '#inline-preview-player, ytd-player#inline-player, .html5-video-player'
    ));
    return candidates.find(function (candidate) {
      return candidate.id === 'inline-preview-player' && isVisible(candidate);
    }) || candidates.find(isVisible) || candidates[0] || null;
  }

  function isCurrentPreviewAdSession(state) {
    if (!state || activeOverlay !== state || !state.card.isConnected ||
      !state.overlay.isConnected || !state.video.isConnected ||
      !state.nativePreview || !state.nativePreview.isConnected) {
      return false;
    }

    const liveCardVideoId = getVideoIdFromKey(getCardVideoKey(state.card));
    return (!liveCardVideoId || liveCardVideoId === state.videoId) &&
      state.nativePreview.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) ===
      state.adSessionId && state.nativePreview.getAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE) ===
      state.videoId;
  }

  function clearPreviewAdOwnership(state) {
    if (!state) {
      return;
    }

    const player = state.nativePreviewPlayer;
    if (state.nativePreview && state.nativePreview.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) ===
      state.adSessionId) {
      state.nativePreview.removeAttribute(PREVIEW_AD_SESSION_ATTRIBUTE);
      state.nativePreview.removeAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE);
    }
    if (player && player.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === state.adSessionId) {
      player.removeAttribute(PREVIEW_AD_SESSION_ATTRIBUTE);
      player.removeAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE);
    }
  }

  function armPreviewAdGuard(state) {
    logAdGuardLifecycle('arm-request', state);
    if (!previewAdGuardFactory) {
      logAdGuardLifecycle('arm-rejected', state, 'guard-api-unavailable');
      return;
    }
    if (activeOverlay !== state) {
      logAdGuardLifecycle('arm-rejected', state, 'no-active-overlay');
      return;
    }
    if (!state.card || !state.card.isConnected) {
      logAdGuardLifecycle('arm-rejected', state, 'no-card');
      return;
    }
    if (!state.videoId) {
      logAdGuardLifecycle('arm-rejected', state, 'no-video-id');
      return;
    }
    if (!state.nativePreview) {
      logAdGuardLifecycle('arm-rejected', state, 'no-preview');
      return;
    }
    if (!state.nativePreview.isConnected) {
      logAdGuardLifecycle('arm-rejected', state, 'preview-disconnected');
      return;
    }
    if (!state.video || !state.video.isConnected) {
      logAdGuardLifecycle('arm-rejected', state, 'no-media');
      return;
    }

    const player = getNativePreviewPlayer(state.nativePreview);
    if (!player || !player.isConnected) {
      logAdGuardLifecycle('arm-rejected', state, 'no-inner-player');
      return;
    }

    state.nativePreviewPlayer = player;
    state.nativePreview.setAttribute(PREVIEW_AD_SESSION_ATTRIBUTE, state.adSessionId);
    state.nativePreview.setAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE, state.videoId);
    player.setAttribute(PREVIEW_AD_SESSION_ATTRIBUTE, state.adSessionId);
    player.setAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE, state.videoId);
    state.adGuard = previewAdGuardFactory.create({
      generation: state.generation,
      sessionId: state.adSessionId,
      videoId: state.videoId,
      media: state.video,
      overlay: state.overlay,
      isCurrent: function () {
        return isCurrentPreviewAdSession(state);
      },
      getPlayer: function () {
        const livePlayer = getNativePreviewPlayer(state.nativePreview);
        return livePlayer && livePlayer.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) ===
          state.adSessionId ? livePlayer : null;
      },
      getRecoveryContext: function () {
        const inner = getNativePreviewPlayer(state.nativePreview);
        return {
          sessionCurrent: isCurrentPreviewAdSession(state),
          generationCurrent: state.generation === previewAttemptId,
          hoverValid: lastHoveredCard === state.card,
          preview: state.nativePreview,
          outer: findComposedAncestor(inner, 'ytd-player#inline-player') || inner,
          inner: inner,
          ownershipValid: Boolean(inner &&
            inner.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === state.adSessionId),
          requestedVideoIdMatches: getVideoIdFromKey(getCardVideoKey(state.card)) === state.videoId
        };
      },
      status: function () {
        return requestPageBridge('preview-ad-status', {
          videoId: state.videoId,
          sessionId: state.adSessionId
        });
      },
    });
    if (!state.adGuard.arm()) {
      logAdGuardLifecycle('arm-rejected', state, 'session-mismatch');
    }
  }

  function armHistoryPreviewAdGuard(session) {
    logAdGuardLifecycle('arm-request', session);
    if (!previewAdGuardFactory) {
      logAdGuardLifecycle('arm-rejected', session, 'guard-api-unavailable');
      return;
    }
    if (historyNativeFallbackSession !== session || !session.active) {
      logAdGuardLifecycle('arm-rejected', session, 'stale-generation');
      return;
    }
    if (!session.card || !session.card.isConnected) {
      logAdGuardLifecycle('arm-rejected', session, 'no-card');
      return;
    }
    if (!session.videoId) {
      logAdGuardLifecycle('arm-rejected', session, 'no-video-id');
      return;
    }
    if (!session.nativePreview) {
      logAdGuardLifecycle('arm-rejected', session, 'no-preview');
      return;
    }
    if (!session.nativePreview.isConnected) {
      logAdGuardLifecycle('arm-rejected', session, 'preview-disconnected');
      return;
    }
    if (!session.outer || !session.outer.isConnected) {
      logAdGuardLifecycle('arm-rejected', session, 'no-outer-player');
      return;
    }
    if (!session.inner || !session.inner.isConnected) {
      logAdGuardLifecycle('arm-rejected', session, 'no-inner-player');
      return;
    }
    session.adSessionId = createBridgeNonce();
    session.nativePreview.setAttribute(PREVIEW_AD_SESSION_ATTRIBUTE, session.adSessionId);
    session.nativePreview.setAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE, session.videoId);
    session.inner.setAttribute(PREVIEW_AD_SESSION_ATTRIBUTE, session.adSessionId);
    session.inner.setAttribute(PREVIEW_AD_VIDEO_ATTRIBUTE, session.videoId);
    session.adGuard = previewAdGuardFactory.create({
      generation: session.generation,
      sessionId: session.adSessionId,
      surface: session.surface,
      videoId: session.videoId,
      media: session.video,
      getMedia: function () {
        const liveMedia = session.inner && session.inner.querySelector('video');
        session.video = liveMedia || null;
        return liveMedia;
      },
      overlay: session.outer,
      isCurrent: function () {
        return historyNativeFallbackSession === session && session.active &&
          session.card.isConnected && session.nativePreview.isConnected &&
          session.inner.isConnected &&
          session.nativePreview.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === session.adSessionId;
      },
      getPlayer: function () {
        return session.inner.isConnected &&
          session.inner.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) === session.adSessionId
          ? session.inner
          : null;
      },
      getRecoveryContext: function () {
        const liveInner = session.outer && session.outer.querySelector(
          '#inline-preview-player.html5-video-player'
        );
        return {
          sessionCurrent: historyNativeFallbackSession === session && session.active,
          generationCurrent: session.generation === historyNativeFallbackGeneration,
          hoverValid: lastHoveredCard === session.card && isHistoryThumbnailHovered(session.card),
          card: session.card,
          thumbnailHost: session.thumbnailHost || findThumbnailHost(session.card),
          preview: session.nativePreview,
          outer: session.outer,
          inner: liveInner,
          ownershipValid: session.nativePreview.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) ===
            session.adSessionId && liveInner && liveInner.getAttribute(PREVIEW_AD_SESSION_ATTRIBUTE) ===
              session.adSessionId,
          requestedVideoIdMatches: getVideoIdFromKey(getCardVideoKey(session.card)) === session.videoId
        };
      },
      status: function () {
        return requestPageBridge('preview-ad-status', {
          videoId: session.videoId,
          sessionId: session.adSessionId
        });
      },
      holdBreakProbeEnabled: true,
      holdBreakProbe: function () {
        return requestPageBridge('history-ad-hold-break-load', { videoId: session.videoId, sessionId: session.adSessionId }, 1800);
      },
      contentReadyRecoveryEnabled: true,
      contentReadyRecovery: function () {
        return requestPageBridge('history-ad-hold-break-load', { videoId: session.videoId, sessionId: session.adSessionId }, 1800);
      },
    });
    if (session.adGuard && session.adGuard.arm()) {
      const gateAuthoritative = Boolean(
        session.outer &&
        session.outer.getAttribute('data-ytpm-preview-owned') === 'true' &&
        session.outer.getAttribute('data-ytpm-presentation-closed') === 'true' &&
        session.outer.getAttribute('data-ytpm-presentation-session') === session.adSessionId
      );
      if (gateAuthoritative) {
        releaseHistoryPrePresentationFence(session, 'presentation-gate-authoritative');
      }
    } else {
      logAdGuardLifecycle('arm-rejected', session, 'session-mismatch');
      cleanupHistoryNativeFallback('arm-rejected');
    }
  }

  function disarmPreviewAdGuard(state, reason) {
    if (state && state.adGuard) {
      state.adGuard.disarm(reason || 'session-ended');
      state.adGuard = null;
    }
    clearPreviewAdOwnership(state);
  }

  function getNativeCaptionControl(preview, player) {
    const roots = [];
    if (preview) {
      roots.push(preview);
    }
    if (player && !roots.includes(player)) {
      roots.push(player);
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

    return candidates.find(isVisible) || candidates[0] || null;
  }

  function getNativeCaptionRenderer(preview, player) {
    const roots = [];
    if (player) {
      roots.push(player);
    }
    if (preview && !roots.includes(preview)) {
      roots.push(preview);
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

  function getNativeCaptionControlState(button) {
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

  function isVisibleCaptionNode(node) {
    if (!node || !node.isConnected || node.hidden ||
      node.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' ||
      Number(style.opacity) === 0) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getCaptionWindows(renderer) {
    if (!renderer || !renderer.isConnected ||
      typeof renderer.querySelectorAll !== 'function') {
      return [];
    }

    const windows = [];
    if (renderer.matches && renderer.matches('.caption-window')) {
      windows.push(renderer);
    }
    renderer.querySelectorAll('.caption-window').forEach(function (captionWindow) {
      if (!windows.includes(captionWindow)) {
        windows.push(captionWindow);
      }
    });
    return windows;
  }

  function getCaptionEffectiveClipRect(captionWindow, renderer) {
    if (!captionWindow || !captionWindow.isConnected) {
      return null;
    }

    let clip = captionWindow.getBoundingClientRect();
    let ancestor = captionWindow.parentElement;
    while (ancestor) {
      const style = window.getComputedStyle(ancestor);
      const clipsContent = /(hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY) ||
        style.clip !== 'auto' || style.clipPath !== 'none' || style.webkitClipPath !== 'none';
      if (clipsContent) {
        clip = captionUtils.intersectCaptionRects
          ? captionUtils.intersectCaptionRects(clip, ancestor.getBoundingClientRect())
          : null;
      }
      if (!clip || ancestor === renderer) {
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (clip && renderer && renderer.isConnected && renderer !== captionWindow) {
      clip = captionUtils.intersectCaptionRects
        ? captionUtils.intersectCaptionRects(clip, renderer.getBoundingClientRect())
        : clip;
    }
    return clip;
  }

  function isPresentedCaptionSegment(segment, captionWindow, renderer) {
    if (!isVisibleCaptionNode(segment) || !captionUtils.getCaptionSegmentMirrorPlan) {
      return false;
    }
    return captionUtils.getCaptionSegmentMirrorPlan(
      segment.getBoundingClientRect(),
      getCaptionEffectiveClipRect(captionWindow, renderer),
      0.5
    ).shouldMirror;
  }

  function isRollupCaptionWindow(captionWindow) {
    return Boolean(captionWindow && /ytp-caption-window-rollup|ytp-rollup-mode/.test(
      captionWindow.className || ''
    ));
  }

  function readCaptionWindowText(captionWindow, renderer) {
    if (!isVisibleCaptionNode(captionWindow)) {
      return '';
    }

    const segments = [];
    const seenSegments = new Set();
    const candidates = [];
    if (captionWindow.matches && captionWindow.matches(
      '.ytp-caption-segment, [class*="caption-segment" i]'
    )) {
      candidates.push(captionWindow);
    }
    candidates.push.apply(candidates, captionWindow.querySelectorAll(
      '.ytp-caption-segment, [class*="caption-segment" i]'
    ));
    candidates.forEach(function (segment) {
      if (!seenSegments.has(segment) && isPresentedCaptionSegment(
        segment,
        captionWindow,
        renderer
      )) {
        seenSegments.add(segment);
        segments.push(segment);
      }
    });

    const values = candidates.length
      ? segments.map(function (segment) {
        return segment.textContent || '';
      })
      : [typeof captionWindow.innerText === 'string'
        ? captionWindow.innerText
        : captionWindow.textContent || ''];

    if (captionUtils.normalizeCaptionLines) {
      return captionUtils.normalizeCaptionLines(values).slice(0, 8192);
    }

    return values.map(function (value) {
      return String(value || '').replace(/[ \t]+/g, ' ').trim();
    }).filter(Boolean).join('\n').slice(0, 8192);
  }

  function readForensicClassName(node) {
    const element = node && node.nodeType === 1
      ? node
      : node && node.parentElement;
    if (!element) {
      return '';
    }

    return typeof element.className === 'string'
      ? element.className.slice(0, 1000)
      : element.getAttribute('class') || '';
  }

  function readForensicRect(node) {
    if (!node) {
      return null;
    }

    try {
      let rect = null;
      if (node.nodeType === 1 && typeof node.getBoundingClientRect === 'function') {
        rect = node.getBoundingClientRect();
      } else if (node.nodeType === 3 && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
      }
      if (!rect) {
        return null;
      }

      return {
        top: Number(rect.top),
        bottom: Number(rect.bottom),
        left: Number(rect.left),
        right: Number(rect.right),
        width: Number(rect.width),
        height: Number(rect.height)
      };
    } catch (error) {
      reportError('caption-forensics-rect', error);
      return null;
    }
  }

  function intersectForensicRects(first, second) {
    if (!first || !second) {
      return null;
    }

    const left = Math.max(first.left, second.left);
    const right = Math.min(first.right, second.right);
    const top = Math.max(first.top, second.top);
    const bottom = Math.min(first.bottom, second.bottom);
    if (right <= left || bottom <= top) {
      return null;
    }

    return {
      top: top,
      bottom: bottom,
      left: left,
      right: right,
      width: right - left,
      height: bottom - top
    };
  }

  function readCaptionForensicStyle(node) {
    const element = node && node.nodeType === 1
      ? node
      : node && node.parentElement;
    if (!element) {
      return null;
    }

    try {
      const style = window.getComputedStyle(element);
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        transform: style.transform,
        overflow: style.overflow,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        overflowClipMargin: style.overflowClipMargin || '',
        clip: style.clip,
        clipPath: style.clipPath,
        maskImage: style.maskImage || '',
        webkitMaskImage: style.webkitMaskImage || '',
        contain: style.contain || '',
        contentVisibility: style.contentVisibility || ''
      };
    } catch (error) {
      reportError('caption-forensics-style', error);
      return null;
    }
  }

  function isForensicClippingStyle(style) {
    if (!style) {
      return false;
    }

    const clipsOverflow = [style.overflow, style.overflowX, style.overflowY]
      .some(function (value) {
        return value === 'hidden' || value === 'clip' || value === 'scroll' ||
          value === 'auto';
      });
    return clipsOverflow ||
      (style.clip && style.clip !== 'auto') ||
      (style.clipPath && style.clipPath !== 'none') ||
      (style.maskImage && style.maskImage !== 'none') ||
      (style.webkitMaskImage && style.webkitMaskImage !== 'none');
  }

  function getCaptionClippingAncestors(node, renderer) {
    const ancestors = [];
    let current = node && node.nodeType === 1 ? node.parentElement : node && node.parentElement;

    while (current) {
      const style = readCaptionForensicStyle(current);
      if (isForensicClippingStyle(style)) {
        ancestors.push({
          nodeDebugId: current.matches && current.matches('.caption-window')
            ? getCaptionWindowDebugId(current)
            : getCaptionNodeDebugId(current),
          tagName: current.tagName ? current.tagName.toLowerCase() : '',
          className: readForensicClassName(current),
          rect: readForensicRect(current),
          style: style
        });
      }
      if (current === renderer) {
        break;
      }
      current = current.parentElement;
    }

    return ancestors;
  }

  function getCaptionGeometrySnapshot(node, captionWindow, renderer) {
    const rect = readForensicRect(node);
    const windowRect = readForensicRect(captionWindow);
    const rendererRect = readForensicRect(renderer);
    const clippingAncestors = getCaptionClippingAncestors(node, renderer);
    let effectiveClipRect = rect;

    clippingAncestors.forEach(function (ancestor) {
      effectiveClipRect = intersectForensicRects(effectiveClipRect, ancestor.rect);
    });

    return {
      rect: rect,
      captionWindowRect: windowRect,
      rendererRect: rendererRect,
      intersectionWithCaptionWindow: intersectForensicRects(rect, windowRect),
      intersectionWithRenderer: intersectForensicRects(rect, rendererRect),
      clippingAncestors: clippingAncestors,
      effectiveClipRect: effectiveClipRect,
      presentedByGeometry: Boolean(
        rect && rect.width > 0 && rect.height > 0 &&
        effectiveClipRect && effectiveClipRect.width > 0 && effectiveClipRect.height > 0
      )
    };
  }

  function getCaptionSegmentNodes(captionWindow) {
    const segments = [];
    const seen = new Set();
    const addSegment = function (segment) {
      if (segment && !seen.has(segment)) {
        seen.add(segment);
        segments.push(segment);
      }
    };

    if (captionWindow && captionWindow.matches && captionWindow.matches(
      '.ytp-caption-segment, [class*="caption-segment" i]'
    )) {
      addSegment(captionWindow);
    }
    if (captionWindow && captionWindow.querySelectorAll) {
      captionWindow.querySelectorAll(
        '.ytp-caption-segment, [class*="caption-segment" i]'
      ).forEach(addSegment);
    }

    return segments;
  }

  function getCaptionLineContainers(captionWindow, segments) {
    const containers = [];
    const seen = new Set();
    const addContainer = function (container) {
      if (!container || container === captionWindow || seen.has(container)) {
        return;
      }
      if (!String(container.textContent || '').trim()) {
        return;
      }
      seen.add(container);
      containers.push(container);
    };

    if (captionWindow && captionWindow.querySelectorAll) {
      captionWindow.querySelectorAll(
        '.caption-visual-line, .captions-text, ' +
        '[class*="caption-line" i], [class*="captions-text" i], ' +
        '[class*="visual-line" i]'
      ).forEach(addContainer);
    }
    (segments || []).forEach(function (segment) {
      let current = segment.parentElement;
      while (current && current !== captionWindow) {
        if (current === segment.parentElement ||
          /caption|line|text/i.test(readForensicClassName(current))) {
          addContainer(current);
        }
        current = current.parentElement;
      }
    });

    return containers;
  }

  function getCaptionMeaningfulTextNodes(captionWindow) {
    if (!captionWindow || !document.createTreeWalker) {
      return [];
    }

    const nodes = [];
    const walker = document.createTreeWalker(captionWindow, 4);
    let current = walker.nextNode();
    while (current) {
      if (String(current.nodeValue || '').trim()) {
        nodes.push(current);
      }
      current = walker.nextNode();
    }
    return nodes;
  }

  function getCaptionNodeSnapshot(node, captionWindow, renderer, domIndex, kind) {
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    return {
      segmentDebugId: getCaptionNodeDebugId(node),
      kind: kind,
      domIndex: domIndex,
      tagName: element && element.tagName ? element.tagName.toLowerCase() : '#text',
      className: readForensicClassName(node),
      ariaHidden: element ? element.getAttribute('aria-hidden') || '' : '',
      hidden: Boolean(element && element.hidden),
      text: String(node && (node.nodeValue || node.textContent) || '').slice(0, 8192),
      style: readCaptionForensicStyle(node),
      geometry: getCaptionGeometrySnapshot(node, captionWindow, renderer)
    };
  }

  function getCaptionRendererIdentifier(renderer) {
    return {
      rendererDebugId: getCaptionRendererDebugId(renderer),
      tagName: renderer && renderer.tagName ? renderer.tagName.toLowerCase() : '',
      id: renderer && renderer.id ? String(renderer.id).slice(0, 200) : '',
      className: readForensicClassName(renderer)
    };
  }

  function summarizeCaptionMutationNode(node, renderer) {
    if (!node) {
      return null;
    }

    const isElementNode = node.nodeType === 1;
    const descendantWindows = [];
    if (isElementNode && node.matches && node.matches('.caption-window')) {
      descendantWindows.push(getCaptionWindowDebugId(node));
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('.caption-window').forEach(function (captionWindow) {
        const debugId = getCaptionWindowDebugId(captionWindow);
        if (!descendantWindows.includes(debugId)) {
          descendantWindows.push(debugId);
        }
      });
    }
    const owner = getCaptionWindowOwnerFromNode(node, renderer, true);
    return {
      nodeDebugId: isElementNode && node.matches && node.matches('.caption-window')
        ? getCaptionWindowDebugId(node)
        : getCaptionNodeDebugId(node),
      nodeType: node.nodeType,
      tagName: isElementNode && node.tagName ? node.tagName.toLowerCase() : '#text',
      className: readForensicClassName(node),
      text: String(node.nodeValue || node.textContent || '').trim().slice(0, 1000),
      ownerCaptionWindowDebugId: owner ? getCaptionWindowDebugId(owner) : '',
      descendantCaptionWindowDebugIds: descendantWindows
    };
  }

  function getCaptionMutationSnapshots(mutations, renderer) {
    return Array.from(mutations || []).map(function (mutation) {
      const owner = getCaptionWindowOwnerFromNode(mutation.target, renderer, true);
      return {
        type: mutation.type,
        attributeName: mutation.attributeName || '',
        target: summarizeCaptionMutationNode(mutation.target, renderer),
        targetCaptionWindowDebugId: owner ? getCaptionWindowDebugId(owner) : '',
        addedNodes: Array.from(mutation.addedNodes || []).map(function (node) {
          return summarizeCaptionMutationNode(node, renderer);
        }),
        removedNodes: Array.from(mutation.removedNodes || []).map(function (node) {
          return summarizeCaptionMutationNode(node, renderer);
        })
      };
    });
  }

  function buildCaptionForensicSnapshot(state, renderer, mutations, phase) {
    if (!DEBUG_LOGGING || !renderer) {
      return null;
    }

    const currentWindows = getCaptionWindows(renderer);
    const activeWindows = Array.from(state && state.captionActiveWindows || [])
      .filter(function (captionWindow) {
        return currentWindows.includes(captionWindow);
      });
    const rendererStyle = readCaptionForensicStyle(renderer);
    const rendererSnapshot = Object.assign(
      getCaptionRendererIdentifier(renderer),
      {
        rect: readForensicRect(renderer),
        style: rendererStyle,
        ariaHidden: renderer.getAttribute('aria-hidden') || '',
        hidden: Boolean(renderer.hidden),
        innerText: String(
          typeof renderer.innerText === 'string'
            ? renderer.innerText
            : renderer.textContent || ''
        ).slice(0, 8192)
      }
    );

    const windows = currentWindows.map(function (captionWindow, windowIndex) {
      const segments = getCaptionSegmentNodes(captionWindow);
      const lineContainers = getCaptionLineContainers(captionWindow, segments);
      const textNodes = getCaptionMeaningfulTextNodes(captionWindow);
      const extractedText = readCaptionWindowText(captionWindow, renderer);
      return {
        windowDebugId: getCaptionWindowDebugId(captionWindow),
        domIndex: windowIndex,
        tagName: captionWindow.tagName ? captionWindow.tagName.toLowerCase() : '',
        className: readForensicClassName(captionWindow),
        ariaHidden: captionWindow.getAttribute('aria-hidden') || '',
        hidden: Boolean(captionWindow.hidden),
        style: readCaptionForensicStyle(captionWindow),
        rect: readForensicRect(captionWindow),
        geometry: getCaptionGeometrySnapshot(captionWindow, captionWindow, renderer),
        innerText: String(
          typeof captionWindow.innerText === 'string'
            ? captionWindow.innerText
            : captionWindow.textContent || ''
        ).slice(0, 8192),
        isActiveForExtension: activeWindows.includes(captionWindow),
        extensionGeneration: state && state.captionWindowGenerations
          ? state.captionWindowGenerations.get(captionWindow) || 0
          : 0,
        extensionExtractedText: extractedText,
        extensionExtractedLines: extractedText ? extractedText.split('\n') : [],
        segments: segments.map(function (segment, index) {
          return getCaptionNodeSnapshot(
            segment,
            captionWindow,
            renderer,
            index,
            'segment'
          );
        }),
        lineContainers: lineContainers.map(function (container, index) {
          return getCaptionNodeSnapshot(
            container,
            captionWindow,
            renderer,
            index,
            'line-container'
          );
        }),
        textNodes: textNodes.map(function (textNode, index) {
          return getCaptionNodeSnapshot(
            textNode,
            captionWindow,
            renderer,
            index,
            'text-node'
          );
        })
      };
    });

    return {
      phase: phase || 'snapshot',
      generation: state ? state.captionGeneration : 0,
      timestamp: typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
      videoId: state && state.videoId ? state.videoId : '',
      renderer: rendererSnapshot,
      mutations: getCaptionMutationSnapshots(mutations, renderer),
      activeWindowDebugIds: activeWindows.map(getCaptionWindowDebugId),
      extensionExtractedLines: activeWindows.map(function (captionWindow) {
        return readCaptionWindowText(captionWindow, renderer);
      })
        .filter(Boolean),
      finalMirroredCaptionText: readNativeCaptionText(state, renderer),
      overlayCaptionText: state && state.controls && state.controls.captions
        ? state.controls.captions.textContent || ''
        : '',
      overlayAnimation: state && state.controls
        ? {
          authoritativeCaption: state.captionCommittedText || state.nativeCaptionText || '',
          visibleOverlayCaption: state.controls.captions.textContent || '',
          animationToken: state.captionTransitionToken || 0,
          animationPhase: state.captionTransition ? 'incoming-only-entry' : 'idle',
          outgoingLayerVisible: Boolean(state.controls.captionCurrent &&
            state.controls.captionCurrent.textContent && state.captionTransition)
        }
        : null,
      windows: windows
    };
  }

  function readNativeCaptionText(state, renderer) {
    if (!renderer || !renderer.isConnected) {
      return '';
    }

    const captionWindows = getCaptionWindows(renderer);
    const hasGeneration = Boolean(
      state &&
      state.captionGeneration > 0 &&
      state.captionActiveWindows
    );
    const activeWindows = hasGeneration
      ? Array.from(state.captionActiveWindows).filter(function (captionWindow) {
        return captionWindows.includes(captionWindow);
      })
      : captionWindows.filter(isVisibleCaptionNode);

    if (hasGeneration && !activeWindows.length) {
      return '';
    }
    if (!activeWindows.length) {
      if (captionWindows.length || !isVisible(renderer)) {
        return '';
      }
      const rendererValue = typeof renderer.innerText === 'string'
        ? renderer.innerText
        : renderer.textContent || '';
      return captionUtils.normalizeCaptionLines
        ? captionUtils.normalizeCaptionLines([rendererValue]).slice(0, 8192)
        : String(rendererValue).replace(/[ \t]+/g, ' ').trim().slice(0, 8192);
    }

    const values = activeWindows.map(function (captionWindow) {
      return readCaptionWindowText(captionWindow, renderer);
    }).filter(Boolean);
    if (captionUtils.normalizeCaptionLines) {
      return captionUtils.normalizeCaptionLines(values).slice(0, 8192);
    }

    return values.join('\n').slice(0, 8192);
  }

  function readNativeCaptionState(state) {
    const preview = getNativePreview(state);
    const player = getNativePreviewPlayer(preview);
    const button = getNativeCaptionControl(preview, player);
    const renderer = getNativeCaptionRenderer(preview, player);
    const controlState = getNativeCaptionControlState(button);
    const text = readNativeCaptionText(state, renderer);
    const tracks = getCaptionTracks(state.video);
    const syntheticTrack = state.captionTrackElement && state.captionTrackElement.track;
    const nativeTracks = state.captionTrackElement
      ? syntheticTrack
        ? tracks.filter(function (track) {
          return track !== syntheticTrack;
        })
        : []
      : tracks;
    const available = Boolean(
      button ||
      nativeTracks.length ||
      state.playerApi && typeof state.playerApi.setOption === 'function'
    );

    return {
      preview: preview,
      player: player,
      button: button,
      renderer: renderer,
      text: text,
      available: available,
      enabled: captionUtils.resolveCaptionEnabledState
        ? captionUtils.resolveCaptionEnabledState(
          controlState,
          nativeTracks.some(function (track) {
            return track.mode === 'showing';
          }),
          text.length > 0
        )
        : controlState === true ||
          (controlState !== false && (
            text.length > 0 ||
            nativeTracks.some(function (track) {
              return track.mode === 'showing';
            })
          ))
    };
  }

  function scheduleNativeCaptionMirrorUpdate(state) {
    if (activeOverlay !== state || state.nativeCaptionSyncTimer) {
      return;
    }

    state.nativeCaptionSyncTimer = window.setTimeout(function () {
      state.nativeCaptionSyncTimer = 0;
      updateNativeCaptionMirror(state);
    }, 0);
  }

  function isCaptionWindowInRenderer(captionWindow, renderer, allowDetached) {
    return Boolean(
      captionWindow &&
      (allowDetached || captionWindow === renderer || renderer.contains(captionWindow))
    );
  }

  function getCaptionWindowOwnerFromNode(node, renderer, allowDetached) {
    if (!node) {
      return null;
    }

    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) {
      return null;
    }

    const owner = element.matches && element.matches('.caption-window')
      ? element
      : element.closest && element.closest('.caption-window');
    return isCaptionWindowInRenderer(owner, renderer, allowDetached)
      ? owner
      : null;
  }

  function collectCaptionWindowsFromAddedNode(node, renderer, collection, allowDetached) {
    if (!node) {
      return;
    }

    if (node.nodeType === 1 && node.matches && node.matches('.caption-window') &&
      isCaptionWindowInRenderer(node, renderer, allowDetached)) {
      collection.add(node);
    }
    if (!node.querySelectorAll) {
      return;
    }

    node.querySelectorAll('.caption-window').forEach(function (captionWindow) {
      if (isCaptionWindowInRenderer(captionWindow, renderer, allowDetached)) {
        collection.add(captionWindow);
      }
    });
  }

  function getCaptionMutationOwnershipPlan(mutations, renderer) {
    const normalizedMutations = [];

    mutations.forEach(function (mutation) {
      if (mutation.type === 'childList') {
        const addedWindows = new Set();
        const removedWindows = new Set();
        Array.from(mutation.addedNodes || []).forEach(function (node) {
          collectCaptionWindowsFromAddedNode(node, renderer, addedWindows, false);
        });
        Array.from(mutation.removedNodes || []).forEach(function (node) {
          collectCaptionWindowsFromAddedNode(node, renderer, removedWindows, true);
        });
        normalizedMutations.push({
          type: mutation.type,
          targetWindow: getCaptionWindowOwnerFromNode(
            mutation.target,
            renderer,
            false
          ),
          addedNodes: [{ windows: Array.from(addedWindows) }],
          removedNodes: [{ windows: Array.from(removedWindows) }]
        });
        return;
      }

      if (mutation.type === 'characterData') {
        normalizedMutations.push({
          type: mutation.type,
          targetWindow: getCaptionWindowOwnerFromNode(
            mutation.target,
            renderer,
            false
          )
        });
        return;
      }

      if (mutation.type === 'attributes' && mutation.attributeName === 'aria-hidden') {
        const activationWindow = getCaptionWindowOwnerFromNode(
          mutation.target,
          renderer,
          false
        );
        normalizedMutations.push({
          type: mutation.type,
          attributeName: mutation.attributeName,
          activationWindow: activationWindow,
          targetWindow: activationWindow
        });
      }
    });

    if (captionUtils.getCaptionMutationOwnershipPlan) {
      return captionUtils.getCaptionMutationOwnershipPlan(normalizedMutations);
    }

    const contentTouched = new Set();
    const activationTouched = new Set();
    const removedWindows = new Set();
    normalizedMutations.forEach(function (mutation) {
      if (mutation.targetWindow) {
        if (mutation.type === 'attributes') {
          activationTouched.add(mutation.targetWindow);
        } else {
          contentTouched.add(mutation.targetWindow);
        }
      }
      Array.from(mutation.addedNodes || []).forEach(function (node) {
        Array.from(node.windows || []).forEach(function (captionWindow) {
          contentTouched.add(captionWindow);
        });
      });
      Array.from(mutation.removedNodes || []).forEach(function (node) {
        Array.from(node.windows || []).forEach(function (captionWindow) {
          removedWindows.add(captionWindow);
        });
      });
    });
    return {
      contentTouched: Array.from(contentTouched),
      activationTouched: Array.from(activationTouched),
      removedWindows: Array.from(removedWindows)
    };
  }

  function handleCaptionMutationBatch(state, renderer, mutations) {
    if (activeOverlay !== state || state.nativeCaptionRenderer !== renderer) {
      return;
    }

    const ownershipPlan = getCaptionMutationOwnershipPlan(mutations, renderer);
    const contentTouched = new Set(ownershipPlan.contentTouched);
    const activationTouched = new Set(ownershipPlan.activationTouched);
    const removedWindows = new Set(ownershipPlan.removedWindows);

    const currentWindows = getCaptionWindows(renderer);
    const previousActiveWindows = Array.from(state.captionActiveWindows || [])
      .filter(function (captionWindow) {
        return currentWindows.includes(captionWindow) && !removedWindows.has(captionWindow);
      });
    const touchedWindows = contentTouched.size
      ? Array.from(contentTouched)
      : activationTouched.size
        ? Array.from(activationTouched)
        : previousActiveWindows;
    const activeWindows = captionUtils.selectCaptionWindowGeneration
      ? captionUtils.selectCaptionWindowGeneration(
        previousActiveWindows,
        touchedWindows,
        currentWindows
      )
      : touchedWindows.filter(function (captionWindow) {
        return currentWindows.includes(captionWindow);
      });

    state.captionGeneration += 1;
    state.captionActiveWindows = new Set(activeWindows);
    activeWindows.forEach(function (captionWindow) {
      state.captionWindowGenerations.set(captionWindow, state.captionGeneration);
    });

    const windowDebug = currentWindows.map(function (captionWindow, index) {
      const computedStyle = window.getComputedStyle(captionWindow);
      return {
        windowIndex: index,
        windowText: readCaptionWindowText(captionWindow, renderer),
        visible: isVisibleCaptionNode(captionWindow),
        opacity: computedStyle.opacity,
        ariaHidden: captionWindow.getAttribute('aria-hidden') || '',
        isActiveGeneration: state.captionActiveWindows.has(captionWindow),
        generation: state.captionWindowGenerations.get(captionWindow) || 0
      };
    });
    const getWindowIndexes = function (windows) {
      return windows.map(function (captionWindow) {
        return currentWindows.indexOf(captionWindow);
      }).filter(function (index) {
        return index >= 0;
      });
    };
    const batchDebug = {
      generation: state.captionGeneration,
      mutationCount: mutations.length,
      contentTouched: getWindowIndexes(Array.from(contentTouched)),
      activationTouched: getWindowIndexes(Array.from(activationTouched)),
      previousActiveWindows: getWindowIndexes(previousActiveWindows),
      removedWindows: getWindowIndexes(Array.from(removedWindows)),
      touchedWindows: getWindowIndexes(touchedWindows),
      activeWindows: getWindowIndexes(activeWindows),
      windowDebug: windowDebug,
      finalMirroredLines: 0
    };
    state.captionLastMutationDebug = batchDebug;
    debugLog('Captions', 'mutationBatch', batchDebug);
    const forensicSnapshot = buildCaptionForensicSnapshot(
      state,
      renderer,
      mutations,
      'mutation-callback'
    );
    state.captionLastForensicSnapshot = forensicSnapshot;
    forensicLog('CaptionForensics', 'mutationBatch', forensicSnapshot);
  }

  function connectNativeCaptionObservers(state, info) {
    if (state.nativeCaptionRenderer !== info.renderer) {
      cancelCaptionTransition(state, 'caption-renderer-changed');
      if (state.nativeCaptionObserver) {
        state.nativeCaptionObserver.disconnect();
        state.nativeCaptionObserver = null;
      }
      state.nativeCaptionRenderer = info.renderer || null;
      resetRollupCaptionHistory(state, 'caption-renderer-changed');
      state.captionGeneration = 0;
      state.captionActiveWindows = new Set();
      state.captionWindowGenerations = new Map();
      state.captionLastMutationDebug = null;
      state.captionLastForensicSnapshot = null;

      if (info.renderer && typeof MutationObserver === 'function') {
        state.nativeCaptionObserver = new MutationObserver(function (mutations) {
          handleCaptionMutationBatch(state, info.renderer, mutations);
          debugLog('Captions', 'captionMutation', {
            videoId: state.videoId,
            generation: state.captionGeneration,
            mutationCount: mutations.length,
            playerFound: Boolean(info.player),
            captionButtonFound: Boolean(info.button),
            captionRendererFound: true,
            captionEnabled: Boolean(state.nativeCaptionState && state.nativeCaptionState.enabled),
            fallbackUsed: false
          });
          // MutationObserver callbacks run after the whole native batch has applied.
          // Resolve its final DOM once, so partial construction records cannot publish.
          updateNativeCaptionMirror(state);
        });
        state.nativeCaptionObserver.observe(info.renderer, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-hidden']
        });
        debugLog('Captions', 'captionObserver', {
          videoId: state.videoId,
          playerFound: Boolean(info.player),
          captionButtonFound: Boolean(info.button),
          captionRendererFound: true,
          observerActive: Boolean(state.nativeCaptionObserver),
          fallbackUsed: false
        });
        forensicLog(
          'CaptionForensics',
          'observerConnected',
          buildCaptionForensicSnapshot(state, info.renderer, [], 'observer-connected')
        );
      }
    }

    if (state.nativePreviewObserved !== info.preview) {
      if (state.nativePreviewObserver) {
        state.nativePreviewObserver.disconnect();
        state.nativePreviewObserver = null;
      }
      state.nativePreviewObserved = info.preview || null;

      if (info.preview && typeof MutationObserver === 'function') {
        state.nativePreviewObserver = new MutationObserver(function () {
          scheduleNativeCaptionMirrorUpdate(state);
        });
        state.nativePreviewObserver.observe(info.preview, {
          subtree: true,
          childList: true
        });
      }
    }
  }

  function getCaptionLineList(text) {
    if (captionUtils.getNormalizedCaptionLineList) {
      return captionUtils.getNormalizedCaptionLineList(text);
    }
    return String(text || '').split('\n').map(function (line) {
      return line.replace(/[ \t]+/g, ' ').trim();
    }).filter(Boolean);
  }

  function getCaptionPaintCandidate(element) {
    if (!element) {
      return null;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const pseudo = ['::before', '::after'].map(function (selector) {
      const pseudoStyle = window.getComputedStyle(element, selector);
      return {
        selector: selector,
        content: pseudoStyle.content,
        display: pseudoStyle.display,
        visibility: pseudoStyle.visibility,
        opacity: pseudoStyle.opacity,
        backgroundColor: pseudoStyle.backgroundColor,
        backgroundImage: pseudoStyle.backgroundImage,
        width: pseudoStyle.width,
        height: pseudoStyle.height
      };
    });
    return {
      tagName: element.tagName ? element.tagName.toLowerCase() : '',
      className: typeof element.className === 'string' ? element.className : '',
      text: String(element.textContent || '').slice(0, 1000),
      childCount: element.childElementCount,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      padding: style.padding,
      minHeight: style.minHeight,
      height: style.height,
      boxShadow: style.boxShadow,
      border: style.border,
      overflow: style.overflow,
      pseudo: pseudo
    };
  }

  function logCaptionPaintForensics(state, reason, nativeText) {
    if (!DEBUG_LOGGING || !state.controls) {
      return;
    }
    const nativeCandidates = Array.from(document.querySelectorAll(
      '.caption-window, .captions-text, .ytp-caption-segment'
    )).slice(0, 100).map(getCaptionPaintCandidate).filter(Boolean);
    const extensionCandidates = [
      state.controls.captions,
      state.controls.captionViewport,
      state.controls.captionCurrent,
      state.controls.captionIncoming
    ].map(getCaptionPaintCandidate).filter(Boolean);
    forensicLog('CaptionForensics', 'captionPaintForensics', {
      reason: reason,
      visibleOverlayCaption: state.captionVisualText || '',
      authoritativeCaption: state.captionCommittedText || '',
      finalMirroredCaptionText: nativeText || '',
      activeWindowCount: state.captionActiveWindows ? state.captionActiveWindows.size : 0,
      extensionBlackPaintCandidates: extensionCandidates,
      nativeBlackPaintCandidates: nativeCandidates
    });
  }

  function logCaptionVisualClear(state, phase, reason, nativeText) {
    forensicLog('CaptionForensics', 'captionVisualClear' + phase, {
      generation: state.captionGeneration,
      videoCurrentTime: readVideoCurrentTime(state),
      authoritativeCaption: state.captionCommittedText || '',
      visibleOverlayCaption: state.captionVisualText || '',
      renderedDomText: state.controls.captions.textContent || '',
      finalMirroredCaptionText: nativeText || '',
      activeNativeCaptionWindowCount: state.captionActiveWindows ? state.captionActiveWindows.size : 0,
      clearReason: reason,
      source: 'commitMirroredCaptionText',
      previewToken: state.captionPreviewToken,
      animationToken: state.captionTransitionToken,
      atomicContext: state.rollupAtomicContext
        ? { predecessorLines: state.rollupAtomicContext.predecessorLines, expectedSuccessorLines: state.rollupAtomicContext.expectedSuccessorLines }
        : null
    });
  }

  function getCaptionLifecycleDetails(state, nativeText) {
    const renderer = state.nativeCaptionRenderer;
    const windows = getCaptionWindows(renderer);
    return {
      generation: state.captionGeneration,
      videoCurrentTime: readVideoCurrentTime(state),
      authoritativeCaption: state.captionCommittedText || '',
      visibleOverlayCaption: state.captionVisualText || '',
      renderedDomText: state.controls.captions.textContent || '',
      nativeExtractedText: nativeText || state.nativeCaptionText || '',
      previewToken: state.captionPreviewToken,
      animationToken: state.captionTransitionToken,
      nativeWindowCount: windows.length,
      activeNativeWindowDebugIds: Array.from(state.captionActiveWindows || [])
        .filter(function (captionWindow) {
          return windows.includes(captionWindow);
        })
        .map(getCaptionWindowDebugId)
    };
  }

  function logCaptionTransitionForensics(state, event, transition, reason) {
    const details = Object.assign(getCaptionLifecycleDetails(state, transition.nativeCandidate), {
      committedParagraph: transition.currentText,
      incomingParagraph: transition.incomingText,
      transitionToken: transition.token,
      previewOnly: transition.previewOnly === true,
      reason: reason
    });
    debugLog('Captions', event, details);
    forensicLog('CaptionForensics', event, details);
  }

  function logFirstNonEmptyCaptionWriteAfterClear(state, previousVisualText, newVisualText, nativeText) {
    const lastClear = state.captionLastVisualClear;
    if (!lastClear || !newVisualText) {
      return;
    }
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    forensicLog('CaptionForensics', 'firstNonEmptyCaptionWriteAfterClear', Object.assign(
      getCaptionLifecycleDetails(state, nativeText),
      {
        previousVisualText: previousVisualText || '',
        visualTextBeforeClear: lastClear.visualTextBeforeClear || '',
        newVisualText: newVisualText,
        deltaMsFromLastClear: now - lastClear.timestamp
      }
    ));
    state.captionLastVisualClear = null;
  }

  function getTransientCaptionEmptyPlan(state, renderer, requestedText) {
    if (!renderer || !renderer.isConnected || !state.captionVisualText ||
      !captionUtils.getTransientCaptionEmptyPlan) {
      return { shouldSuppress: false, matchingWindowIndex: -1, windows: [], rendererRawText: '' };
    }

    const windows = getCaptionWindows(renderer);
    const rendererRawText = typeof renderer.innerText === 'string'
      ? renderer.innerText
      : renderer.textContent || '';
    const windowDetails = windows.map(function (captionWindow) {
      return {
        rawText: typeof captionWindow.innerText === 'string'
          ? captionWindow.innerText
          : captionWindow.textContent || '',
        extractedText: readCaptionWindowText(captionWindow, renderer)
      };
    });
    const plan = captionUtils.getTransientCaptionEmptyPlan(
      requestedText,
      state.captionVisualText,
      rendererRawText,
      windowDetails
    );
    return Object.assign(plan, {
      windows: windows,
      windowDetails: windowDetails,
      rendererRawText: rendererRawText
    });
  }

  function logCaptionTransientEmptySuppressed(state, plan, requestedText) {
    const matchingWindow = plan.windows[plan.matchingWindowIndex];
    const matchingWindowDetails = plan.windowDetails[plan.matchingWindowIndex];
    forensicLog('CaptionForensics', 'captionTransientEmptySuppressed', {
      generation: state.captionGeneration,
      videoCurrentTime: readVideoCurrentTime(state),
      visibleOverlayCaption: state.captionVisualText || '',
      authoritativeCaption: state.captionCommittedText || '',
      finalMirroredCaptionText: requestedText || '',
      physicalCaptionWindowCount: plan.windows.length,
      activeCaptionWindowCount: state.captionActiveWindows ? state.captionActiveWindows.size : 0,
      rendererRawText: String(plan.rendererRawText || '').slice(0, 8192),
      matchingWindowDebugId: matchingWindow ? getCaptionWindowDebugId(matchingWindow) : '',
      matchingWindowExtractedText: matchingWindowDetails
        ? matchingWindowDetails.extractedText
        : '',
      reason: 'physical-window-complete-visible-paragraph-match'
    });
  }

  function commitMirroredCaptionText(state, text, options) {
    const previousVisualText = state.captionVisualText || '';
    const nativeEmpty = !text;
    const canSuppressTransientEmpty = nativeEmpty && options &&
      options.allowTransientEmptySuppression === true;
    const transientEmptyPlan = canSuppressTransientEmpty
      ? getTransientCaptionEmptyPlan(state, options.renderer, text)
      : null;
    if (transientEmptyPlan && transientEmptyPlan.shouldSuppress) {
      logCaptionTransientEmptySuppressed(state, transientEmptyPlan, text);
      return false;
    }
    if (nativeEmpty) {
      logCaptionVisualClear(state, 'Requested', 'native-empty', text);
      logCaptionPaintForensics(state, 'before-native-empty-clear', text);
    }
    cancelCaptionTransition(state, 'direct-commit');
    state.nativeCaptionText = text;
    state.captionCommittedText = text;
    state.captionVisualText = text;
    state.captionIncomingText = '';
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--rolling');
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--incoming-ready');
    state.controls.captionCurrent.textContent = text;
    state.controls.captionIncoming.textContent = '';
    state.controls.captions.hidden = !text;
    if (nativeEmpty) {
      logCaptionVisualClear(state, 'Applied', 'native-empty', text);
      logCaptionPaintForensics(state, 'after-native-empty-clear', text);
      state.captionLastVisualClear = {
        timestamp: typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now(),
        visualTextBeforeClear: previousVisualText
      };
    } else {
      logFirstNonEmptyCaptionWriteAfterClear(state, previousVisualText, text, text);
    }
    return true;
  }

  function getRollupGeometrySnapshot(state, renderer) {
    const windows = Array.from(state.captionActiveWindows || []).filter(function (captionWindow) {
      return captionWindow && renderer && renderer.contains(captionWindow) &&
        isRollupCaptionWindow(captionWindow);
    });
    return windows.flatMap(function (captionWindow) {
      return Array.from(captionWindow.querySelectorAll('.captions-text')).map(function (container) {
        const rect = container.getBoundingClientRect();
        return {
          container: container,
          window: captionWindow,
          top: rect.top,
          bottom: rect.bottom,
          transform: window.getComputedStyle(container).transform || 'none',
          lineRects: Array.from(container.querySelectorAll('.caption-visual-line')).map(function (line) {
            const lineRect = line.getBoundingClientRect();
            return { top: lineRect.top, bottom: lineRect.bottom };
          })
        };
      });
    });
  }

  function getTransformTranslateY(value) {
    const matrix = String(value || '').match(/^matrix\(([^)]+)\)$/);
    if (matrix) {
      const values = matrix[1].split(',').map(Number);
      return Number.isFinite(values[5]) ? values[5] : 0;
    }
    const translate = String(value || '').match(/translateY\(([-\d.]+)px\)/);
    return translate && Number.isFinite(Number(translate[1])) ? Number(translate[1]) : 0;
  }

  function hasRollupGeometryMovedUpward(previous, current) {
    return current.some(function (entry) {
      const prior = previous.find(function (candidate) {
        return candidate.container === entry.container;
      });
      if (!prior) {
        return false;
      }
      return entry.top < prior.top - 0.25 ||
        getTransformTranslateY(entry.transform) < getTransformTranslateY(prior.transform) - 0.25;
    });
  }

  function cancelCaptionTransition(state, reason) {
    const transition = state.captionTransition;
    if (!transition) {
      return;
    }
    if (state.captionTransitionTimer) {
      window.clearTimeout(state.captionTransitionTimer);
      state.captionTransitionTimer = 0;
    }
    if (state.captionTransitionRaf) {
      window.cancelAnimationFrame(state.captionTransitionRaf);
      state.captionTransitionRaf = 0;
    }
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--rolling');
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--incoming-ready');
    state.captionTransition = null;
    state.captionTransitionToken += 1;
    logCaptionTransitionForensics(state, 'captionTransitionCancelled', transition, reason);
    if (transition.previewOnly) {
      logCaptionTransitionForensics(state, 'rollupVisualPreviewCancelled', transition, reason);
    }
  }

  function completeCaptionTransition(state, transition, reason) {
    if (activeOverlay !== state || state.captionTransition !== transition ||
      (captionUtils.isCaptionTransitionCurrent
        ? !captionUtils.isCaptionTransitionCurrent(transition.token, state.captionTransitionToken)
        : state.captionTransitionToken !== transition.token)) {
      return;
    }
    if (state.captionTransitionTimer) {
      window.clearTimeout(state.captionTransitionTimer);
      state.captionTransitionTimer = 0;
    }
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--rolling');
    state.controls.captionCurrent.textContent = transition.incomingText;
    state.controls.captionIncoming.textContent = '';
    if (!transition.previewOnly) {
      state.nativeCaptionText = transition.incomingText;
      state.captionCommittedText = transition.incomingText;
    }
    state.captionVisualText = transition.incomingText;
    state.captionIncomingText = '';
    state.captionTransition = null;
    logCaptionTransitionForensics(state, 'captionTransitionCompleted', transition, reason);
  }

  function startCaptionTransition(state, currentText, incomingText, nativeCandidate, reason, previewOnly) {
    if (!incomingText || incomingText === currentText) {
      commitMirroredCaptionText(state, incomingText || currentText);
      return;
    }
    if (state.captionTransition && state.captionTransition.incomingText === incomingText) {
      return;
    }
    if (state.captionTransition) {
      cancelCaptionTransition(state, 'retargeted');
    }
    const token = ++state.captionTransitionToken;
    const renderPlan = captionUtils.getIncomingOnlyCaptionRenderPlan
      ? captionUtils.getIncomingOnlyCaptionRenderPlan(incomingText)
      : { visibleText: incomingText, outgoingVisible: false, animationPhase: 'incoming-only-entry' };
    const transition = {
      token: token,
      currentText: currentText,
      incomingText: renderPlan.visibleText,
      nativeCandidate: nativeCandidate,
      previewOnly: previewOnly === true
    };
    state.captionTransition = transition;
    if (!previewOnly) {
      state.captionPreviousText = currentText;
      state.nativeCaptionText = renderPlan.visibleText;
      state.captionCommittedText = renderPlan.visibleText;
    }
    state.captionVisualText = renderPlan.visibleText;
    state.captionIncomingText = renderPlan.visibleText;
    state.controls.captionCurrent.textContent = '';
    state.controls.captionIncoming.textContent = renderPlan.visibleText;
    state.controls.captions.hidden = false;
    logFirstNonEmptyCaptionWriteAfterClear(
      state,
      currentText,
      renderPlan.visibleText,
      nativeCandidate
    );
    const transitionHeight = Math.max(
      state.controls.captionIncoming.offsetHeight
    );
    state.controls.captionViewport.style.setProperty(
      '--ytpm-caption-transition-height',
      Math.max(1, transitionHeight) + 'px'
    );
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--rolling');
    state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--incoming-ready');
    state.controls.captionViewport.classList.add('ytpm-overlay__caption-viewport--incoming-ready');
    state.captionTransitionRaf = window.requestAnimationFrame(function () {
      if (activeOverlay !== state || state.captionTransition !== transition ||
        state.captionTransitionToken !== token) {
        return;
      }
      state.captionTransitionRaf = 0;
      state.controls.captionViewport.classList.remove('ytpm-overlay__caption-viewport--incoming-ready');
      state.controls.captionViewport.classList.add('ytpm-overlay__caption-viewport--rolling');
    });
    logCaptionTransitionForensics(state, 'captionTransitionStarted', transition, reason);
    if (transition.previewOnly) {
      logCaptionTransitionForensics(state, 'rollupVisualPreviewStarted', transition, reason);
    }
    state.captionTransitionTimer = window.setTimeout(function () {
      completeCaptionTransition(state, transition, 'animation-fallback');
    }, CAPTION_TRANSITION_DURATION_MS + 80);
  }

  function resetRollupCaptionHistory(state, reason) {
    if (!state.captionPreviousText && !state.captionCommittedText && !state.rollupAtomicContext) {
      return;
    }
    state.captionPreviousText = '';
    state.captionPreviewToken += 1;
    if (state.captionPreviewRaf) {
      window.cancelAnimationFrame(state.captionPreviewRaf);
      state.captionPreviewRaf = 0;
    }
    clearRollupAtomicContext(state, reason);
    debugLog('Captions', 'rollupHistoryReset', {
      videoId: state.videoId,
      reason: reason
    });
  }

  function getRawRollupCaptionText(state, renderer) {
    const windows = Array.from(state.captionActiveWindows || []).filter(function (captionWindow) {
      return captionWindow && renderer && renderer.contains(captionWindow) &&
        isRollupCaptionWindow(captionWindow);
    });
    const values = windows.map(function (captionWindow) {
      return typeof captionWindow.innerText === 'string'
        ? captionWindow.innerText
        : captionWindow.textContent || '';
    });
    return captionUtils.normalizeCaptionLines
      ? captionUtils.normalizeCaptionLines(values)
      : values.join('\n');
  }

  function clearRollupAtomicContext(state, reason) {
    if (!state.rollupAtomicContext) {
      return;
    }
    logRollupAtomicEvent(state, 'rollupAtomicContextCleared', {
      predecessorLines: state.rollupAtomicContext.predecessorLines,
      expectedSuccessorLines: state.rollupAtomicContext.expectedSuccessorLines,
      generation: state.captionGeneration,
      reason: reason
    });
    state.rollupAtomicContext = null;
  }

  function logRollupAtomicEvent(state, event, details) {
    const payload = Object.assign({
      generation: state.captionGeneration,
      videoId: state.videoId,
      videoCurrentTime: readVideoCurrentTime(state)
    }, details || {});
    debugLog('Captions', event, payload);
    forensicLog('CaptionForensics', event, payload);
  }

  function updateRollupAtomicContext(state, committedText, rawRollupText) {
    const expectedSuccessorLines = captionUtils.deriveTrailingRollupSuccessor
      ? captionUtils.deriveTrailingRollupSuccessor(rawRollupText, committedText)
      : [];
    if (!expectedSuccessorLines.length) {
      clearRollupAtomicContext(state, 'no-compatible-raw-successor');
      return null;
    }
    const context = state.rollupAtomicContext;
    const samePredecessor = context && context.predecessorText === committedText;
    if (!samePredecessor) {
      state.rollupAtomicContext = {
        predecessorText: committedText,
        predecessorLines: getCaptionLineList(committedText),
        expectedSuccessorLines: expectedSuccessorLines
      };
      logRollupAtomicEvent(state, 'rollupAtomicContextStarted', {
        predecessorLines: state.rollupAtomicContext.predecessorLines,
        expectedSuccessorLines: expectedSuccessorLines,
        rawRollupLines: getCaptionLineList(rawRollupText),
        generation: state.captionGeneration
      });
    } else if (expectedSuccessorLines.join('\n') !== context.expectedSuccessorLines.join('\n')) {
      context.expectedSuccessorLines = expectedSuccessorLines;
      logRollupAtomicEvent(state, 'rollupExpectedSuccessorUpdated', {
        predecessorLines: context.predecessorLines,
        expectedSuccessorLines: expectedSuccessorLines,
        rawRollupLines: getCaptionLineList(rawRollupText),
        generation: state.captionGeneration
      });
    }
    return state.rollupAtomicContext;
  }

  function getRollupVisualPreviewEntryEvidence(renderer, expectedText) {
    const physicalWindows = getCaptionWindows(renderer).filter(function (captionWindow) {
      return isRollupCaptionWindow(captionWindow);
    });
    const expected = captionUtils.normalizeCaptionLines
      ? captionUtils.normalizeCaptionLines(expectedText)
      : String(expectedText || '').trim();
    let matchingNativeLine = '';
    let geometryEntryEvidence = null;

    physicalWindows.some(function (captionWindow) {
      const candidates = getCaptionSegmentNodes(captionWindow)
        .concat(getCaptionLineContainers(captionWindow));
      return candidates.some(function (candidate) {
        const candidateText = captionUtils.normalizeCaptionLines
          ? captionUtils.normalizeCaptionLines(candidate.textContent || '')
          : String(candidate.textContent || '').trim();
        if (!candidate.isConnected || candidateText !== expected ||
          !isVisibleCaptionNode(candidate)) {
          return false;
        }
        const entryPlan = captionUtils.getCaptionGeometryEntryPlan
          ? captionUtils.getCaptionGeometryEntryPlan(
            candidate.getBoundingClientRect(),
            getCaptionEffectiveClipRect(captionWindow, renderer)
          )
          : { hasGeometryEntry: false, visibleHeightRatio: 0, visibleRect: null };
        if (!entryPlan.hasGeometryEntry) {
          return false;
        }
        matchingNativeLine = candidateText;
        geometryEntryEvidence = entryPlan;
        return true;
      });
    });

    return {
      matchingNativeLine: matchingNativeLine,
      physicalWindowCount: physicalWindows.length,
      geometryEntryEvidence: geometryEntryEvidence || {
        hasGeometryEntry: false,
        visibleHeightRatio: 0,
        visibleRect: null
      },
      hasRollupMotion: physicalWindows.length > 0
    };
  }

  function logRollupVisualPreviewForensics(state, event, context, rawRollupText, details) {
    const previewDetails = details || {};
    const payload = {
      generation: state.captionGeneration,
      videoCurrentTime: readVideoCurrentTime(state),
      authoritativeCaption: state.captionCommittedText || '',
      visibleOverlayCaption: state.captionVisualText || '',
      predecessorLines: context.predecessorLines,
      expectedSuccessorLines: context.expectedSuccessorLines,
      rawRollupLines: getCaptionLineList(rawRollupText),
      expectedSuccessorLineCount: context.expectedSuccessorLines.length,
      matchingNativeLine: previewDetails.matchingNativeLine || '',
      physicalWindowCount: previewDetails.physicalWindowCount || 0,
      geometryEntryEvidence: previewDetails.geometryEntryEvidence || null,
      movedUpward: previewDetails.movedUpward === true,
      previewToken: previewDetails.previewToken || 0,
      decisionReason: previewDetails.decisionReason || ''
    };
    debugLog('Captions', event, payload);
    forensicLog('CaptionForensics', event, payload);
  }

  function scheduleRollupVisualPreview(state, rawRollupText, renderer, movedUpward) {
    const context = state.rollupAtomicContext;
    if (!context) {
      return;
    }
    if (state.captionVisualText === context.expectedSuccessorLines.join('\n')) {
      logRollupVisualPreviewForensics(state, 'rollupVisualPreviewRejected', context, rawRollupText, {
        movedUpward: movedUpward,
        previewToken: state.captionPreviewToken,
        decisionReason: 'already-authoritative'
      });
      return;
    }
    const token = ++state.captionPreviewToken;
    const expectedText = context.expectedSuccessorLines.join('\n');
    logRollupVisualPreviewForensics(state, 'rollupVisualPreviewScheduled', context, rawRollupText, {
      movedUpward: movedUpward,
      previewToken: token,
      decisionReason: 'scheduled-for-structural-validation'
    });
    if (state.captionPreviewRaf) {
      logRollupVisualPreviewForensics(state, 'rollupVisualPreviewCancelled', context, rawRollupText, {
        movedUpward: movedUpward,
        previewToken: token - 1,
        decisionReason: 'superseded-before-preview-write'
      });
      window.cancelAnimationFrame(state.captionPreviewRaf);
    }
    state.captionPreviewRaf = window.requestAnimationFrame(function () {
      state.captionPreviewRaf = 0;
      const latest = state.rollupAtomicContext;
      if (activeOverlay !== state || token !== state.captionPreviewToken || !latest ||
        latest.predecessorText !== context.predecessorText ||
        latest.expectedSuccessorLines.join('\n') !== expectedText) {
        logRollupVisualPreviewForensics(state, 'rollupVisualPreviewRejected', context, rawRollupText, {
          movedUpward: movedUpward,
          previewToken: token,
          decisionReason: 'stale-preview-token'
        });
        return;
      }
      const entryEvidence = getRollupVisualPreviewEntryEvidence(renderer, expectedText);
      const previewPlan = captionUtils.getRollupVisualPreviewPlan
        ? captionUtils.getRollupVisualPreviewPlan(
          latest.expectedSuccessorLines,
          entryEvidence.geometryEntryEvidence,
          movedUpward || entryEvidence.hasRollupMotion
        )
        : { shouldStart: true, reason: 'multiline-existing-preview-policy' };
      const previewForensics = {
        matchingNativeLine: entryEvidence.matchingNativeLine,
        physicalWindowCount: entryEvidence.physicalWindowCount,
        geometryEntryEvidence: entryEvidence.geometryEntryEvidence,
        movedUpward: movedUpward,
        previewToken: token,
        decisionReason: previewPlan.reason
      };
      if (!previewPlan.shouldStart) {
        logRollupVisualPreviewForensics(
          state,
          'rollupVisualPreviewRejected',
          latest,
          rawRollupText,
          previewForensics
        );
        return;
      }
      logRollupVisualPreviewForensics(
        state,
        'rollupVisualPreviewAllowed',
        latest,
        rawRollupText,
        previewForensics
      );
      startCaptionTransition(
        state,
        state.captionCommittedText,
        expectedText,
        rawRollupText,
        'rollup-visual-preview',
        true
      );
    });
  }

  function updateNativeCaptionMirror(state) {
    if (activeOverlay !== state || !state.elements || !state.controls.captions) {
      return null;
    }

    const info = readNativeCaptionState(state);
    connectNativeCaptionObservers(state, info);
    state.nativeCaptionState = {
      available: info.available,
      enabled: info.enabled
    };

    if (info.available) {
      state.captionInfo = {
        available: true,
        enabled: info.enabled
      };
      applyCaptionControl(state, state.captionInfo);
    }

    const text = info.enabled ? info.text : '';
    const previousText = state.captionCommittedText || state.nativeCaptionText;
    const geometry = getRollupGeometrySnapshot(state, info.renderer);
    const movedUpward = hasRollupGeometryMovedUpward(state.rollupLastGeometry || [], geometry);
    state.rollupLastGeometry = geometry;
    const rollup = geometry.length > 0;
    if (!text) {
      const committed = commitMirroredCaptionText(state, '', {
        renderer: info.renderer,
        allowTransientEmptySuppression: info.enabled === true && !state.seekPending &&
          !state.seekDragging
      });
      if (committed) {
        resetRollupCaptionHistory(state, 'empty-caption');
      }
      return info;
    }
    const rawRollupText = rollup ? getRawRollupCaptionText(state, info.renderer) : '';
    if (rollup && captionUtils.isRollupCaptionRollback &&
      captionUtils.isRollupCaptionRollback(
        text,
        previousText,
        state.captionPreviousText,
        rawRollupText
      )) {
      logRollupAtomicEvent(state, 'rollupRollbackRejected', {
        candidateCaption: text,
        currentCommittedCaption: previousText,
        previousSupersededCaption: state.captionPreviousText,
        rawRollupLines: getCaptionLineList(rawRollupText),
        rawRollupText: rawRollupText,
        windowDebugId: Array.from(state.captionActiveWindows || []).map(getCaptionWindowDebugId),
        videoId: state.videoId,
        reason: 'previous-before-current-in-raw-rollup-context'
      });
      return info;
    }
    const atomicContext = rollup
      ? updateRollupAtomicContext(state, previousText, rawRollupText)
      : null;
    if (atomicContext) {
      scheduleRollupVisualPreview(state, rawRollupText, info.renderer, movedUpward);
      const candidateIsCompleteSuccessor = captionUtils.isExactCaptionLineSequence &&
        captionUtils.isExactCaptionLineSequence(text, atomicContext.expectedSuccessorLines);
      const candidateIsPartialPredecessor = captionUtils.isCaptionLineFragment &&
        captionUtils.isCaptionLineFragment(text, atomicContext.predecessorText);
      const candidateIsPartialSuccessor = !candidateIsCompleteSuccessor &&
        atomicContext.expectedSuccessorLines.length > 0 &&
        getCaptionLineList(text).length > 0;
      if (candidateIsPartialPredecessor || candidateIsPartialSuccessor) {
        logRollupAtomicEvent(state, 'rollupFragmentRejected', {
          candidateLines: getCaptionLineList(text),
          committedLines: getCaptionLineList(previousText),
          predecessorLines: atomicContext.predecessorLines,
          expectedSuccessorLines: atomicContext.expectedSuccessorLines,
          rawRollupLines: getCaptionLineList(rawRollupText),
          geometryQualifiedRawLines: getCaptionLineList(text),
          rejectionReason: candidateIsPartialPredecessor
            ? 'partial-predecessor'
            : 'partial-successor',
          generation: state.captionGeneration,
          windowDebugId: Array.from(state.captionActiveWindows || []).map(getCaptionWindowDebugId),
          animationToken: state.captionTransitionToken
        });
        return info;
      }
      if (candidateIsCompleteSuccessor) {
        logRollupAtomicEvent(state, 'rollupAtomicSuccessorCommitted', {
          oldCompleteParagraph: previousText,
          newCompleteParagraph: text,
          rawRollupLines: getCaptionLineList(rawRollupText),
          committedLines: getCaptionLineList(previousText),
          expectedSuccessorLines: atomicContext.expectedSuccessorLines,
          geometryCandidateLines: getCaptionLineList(text),
          decision: 'accept',
          reason: 'complete-successor-geometry-authoritative'
        });
        clearRollupAtomicContext(state, 'successor-committed');
        if (state.captionVisualText === text) {
          state.nativeCaptionText = text;
          state.captionCommittedText = text;
          state.captionPreviousText = previousText;
          const previewReconciledDetails = {
            authoritativeCaption: text,
            visualCaption: text,
            previewToken: state.captionPreviewToken,
            generation: state.captionGeneration,
            reason: 'authoritative-successor-matches-preview'
          };
          debugLog('Captions', 'rollupVisualPreviewReconciled', previewReconciledDetails);
          forensicLog(
            'CaptionForensics',
            'rollupVisualPreviewReconciled',
            Object.assign(
              getCaptionLifecycleDetails(state, text),
              previewReconciledDetails
            )
          );
          return info;
        }
      }
    }
    if (text === previousText || (state.captionTransition &&
      text === state.captionTransition.incomingText)) {
      return info;
    }
    const transitionPlan = captionUtils.getRollupCaptionTransitionPlan
      ? captionUtils.getRollupCaptionTransitionPlan(
        previousText,
        text,
        rollup,
        movedUpward
      )
      : {
        transientSuperset: false,
        incomingText: text
      };
    const isTransientSuperset = transitionPlan.transientSuperset === true;
    const incomingText = transitionPlan.incomingText || text;
    debugLog('Captions', 'captionTransitionDetected', {
      committedParagraph: previousText,
      nativeCandidate: text,
      incomingParagraph: incomingText,
      transitionToken: state.captionTransitionToken + 1,
      reason: isTransientSuperset ? 'rollup-moving-superset' : 'caption-replacement',
      rollup: rollup
    });
    if (rollup && previousText) {
      startCaptionTransition(
        state,
        previousText,
        incomingText,
        text,
        isTransientSuperset ? 'rollup-moving-superset' : 'rollup-replacement'
      );
      return info;
    }
    const mirrorReplaced = state.nativeCaptionText !== text;
    commitMirroredCaptionText(state, text);
    if (state.captionLastMutationDebug) {
      state.captionLastMutationDebug.finalMirroredLines = text
        ? text.split('\n').length
        : 0;
      debugLog('Captions', 'mutationBatchFinal', state.captionLastMutationDebug);
      state.captionLastMutationDebug = null;
    }
    if (state.captionLastForensicSnapshot) {
      forensicLog(
        'CaptionForensics',
        'mirrorUpdated',
        buildCaptionForensicSnapshot(
          state,
          info.renderer,
          [],
          'mirror-updated'
        )
      );
      state.captionLastForensicSnapshot = null;
    }
    debugLog('Captions', 'mirrorTextUpdated', {
      videoId: state.videoId,
      playerFound: Boolean(info.player),
      captionButtonFound: Boolean(info.button),
      captionRendererFound: Boolean(info.renderer),
      captionEnabled: Boolean(info.enabled),
      mirrorTextUpdated: Boolean(text),
      mirrorReplaced: mirrorReplaced,
      visibleLines: text ? text.split('\n').length : 0,
      finalMirroredLines: text ? text.split('\n').length : 0,
      generation: state.captionGeneration,
      textLength: text.length,
      fallbackUsed: false
    });
    return info;
  }

  function disposeNativeCaptionMirror(state) {
    if (state.controls && state.controls.captions) {
      logCaptionVisualClear(state, 'Requested', 'caption-mirror-disposed', '');
      logCaptionPaintForensics(state, 'before-caption-mirror-disposed', '');
    }
    cancelCaptionTransition(state, 'caption-mirror-disposed');
    state.captionPreviewToken += 1;
    if (state.captionPreviewRaf) {
      window.cancelAnimationFrame(state.captionPreviewRaf);
      state.captionPreviewRaf = 0;
    }
    if (state.nativeCaptionObserver) {
      state.nativeCaptionObserver.disconnect();
      state.nativeCaptionObserver = null;
    }
    if (state.nativePreviewObserver) {
      state.nativePreviewObserver.disconnect();
      state.nativePreviewObserver = null;
    }
    if (state.nativeCaptionSyncTimer) {
      window.clearTimeout(state.nativeCaptionSyncTimer);
      state.nativeCaptionSyncTimer = 0;
    }
    state.nativeCaptionRenderer = null;
    state.nativePreviewObserved = null;
    state.nativeCaptionState = null;
    state.nativeCaptionText = '';
    state.captionCommittedText = '';
    state.captionPreviousText = '';
    state.rollupAtomicContext = null;
    state.captionIncomingText = '';
    state.captionGeneration = 0;
    state.captionActiveWindows = new Set();
    state.captionWindowGenerations = new Map();
    state.captionLastMutationDebug = null;
    state.captionLastForensicSnapshot = null;
    state.captionLastVisualClear = null;
    if (state.controls && state.controls.captions) {
      state.controls.captionCurrent.textContent = '';
      state.controls.captionIncoming.textContent = '';
      state.controls.captions.hidden = true;
      logCaptionVisualClear(state, 'Applied', 'caption-mirror-disposed', '');
      logCaptionPaintForensics(state, 'after-caption-mirror-disposed', '');
    }
  }

  function formatCaptionTimestamp(seconds) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const milliseconds = Math.floor((safeSeconds % 1) * 1000);
    const totalSeconds = Math.floor(safeSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    return String(hours).padStart(2, '0') + ':' +
      String(minutes).padStart(2, '0') + ':' +
      String(remainingSeconds).padStart(2, '0') + '.' +
      String(milliseconds).padStart(3, '0');
  }

  function removeSyntheticCaptionTrack(state) {
    const trackElement = state.captionTrackElement;
    if (trackElement && state.captionTrackLoadHandler) {
      trackElement.removeEventListener('load', state.captionTrackLoadHandler);
    }
    if (trackElement) {
      trackElement.remove();
    }
    const objectUrl = state.captionObjectUrl;
    if (objectUrl) {
      window.setTimeout(function () {
        URL.revokeObjectURL(objectUrl);
      }, 0);
    }

    state.captionTrackElement = null;
    state.captionTrackLoadHandler = null;
    state.captionObjectUrl = '';
    state.captionTrackInfo = null;
  }

  function installSyntheticCaptionTrack(state, captionData, trackInfo) {
    if (!state.video || !state.video.isConnected ||
      !Array.isArray(captionData) || !captionData.length ||
      typeof Blob !== 'function' || !window.URL || typeof URL.createObjectURL !== 'function') {
      return false;
    }

    const safeTrackInfo = trackInfo || {};
    const safeLabel = String(safeTrackInfo.label || 'Captions').slice(0, 200);
    const safeLanguage = captionUtils.normalizeLanguage
      ? captionUtils.normalizeLanguage(safeTrackInfo.languageCode) || 'und'
      : 'und';
    removeSyntheticCaptionTrack(state);
    const vttLines = ['WEBVTT', ''];
    const maxCues = captionUtils.MAX_CAPTION_CUES || 5000;
    const maxTextLength = captionUtils.MAX_CUE_TEXT_LENGTH || 8192;
    captionData.slice(0, maxCues).forEach(function (cue, index) {
      const start = Number(cue.start);
      const end = start + Number(cue.duration);
      const text = String(cue.text || '').slice(0, maxTextLength).trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
        return;
      }

      vttLines.push(String(index + 1));
      vttLines.push(formatCaptionTimestamp(start) + ' --> ' + formatCaptionTimestamp(end));
      vttLines.push(text.replace(/\r?\n/g, '\n'));
      vttLines.push('');
    });

    if (vttLines.length <= 2) {
      return false;
    }

    const objectUrl = URL.createObjectURL(new Blob([vttLines.join('\n')], {
      type: 'text/vtt'
    }));
    const trackElement = document.createElement('track');
    trackElement.kind = 'captions';
    trackElement.label = safeLabel;
    trackElement.srclang = safeLanguage;
    trackElement.src = objectUrl;
    trackElement.default = true;
    trackElement.setAttribute(SYNTHETIC_CAPTION_ATTRIBUTE, 'true');

    const activateTrack = function () {
      if (activeOverlay !== state || !trackElement.track) {
        return;
      }
      trackElement.track.mode = 'showing';
      state.captionInfo = { available: true, enabled: true };
      applyCaptionControl(state, state.captionInfo);
    };

    state.captionTrackElement = trackElement;
    state.captionTrackLoadHandler = activateTrack;
    state.captionObjectUrl = objectUrl;
    state.captionTrackInfo = safeTrackInfo;
    trackElement.addEventListener('load', activateTrack);
    try {
      state.video.appendChild(trackElement);
    } catch (error) {
      reportError('caption-track-attach', error);
      removeSyntheticCaptionTrack(state);
      return false;
    }
    window.setTimeout(activateTrack, 120);
    return true;
  }

  function getYoutubePlayerApi(video) {
    const candidates = [];
    const directPlayer = findComposedAncestor(video, '.html5-video-player');
    const playerHost = findComposedAncestor(video, 'ytd-player');

    if (directPlayer) {
      candidates.push(directPlayer);
    }
    if (playerHost) {
      candidates.push(playerHost);
      const nestedPlayer = playerHost.querySelector('.html5-video-player');
      if (nestedPlayer) {
        candidates.push(nestedPlayer);
      }
    }

    return candidates.find(function (candidate) {
      return typeof candidate.getAvailableQualityLevels === 'function' ||
        typeof candidate.setPlaybackQuality === 'function' ||
        typeof candidate.setPlaybackQualityRange === 'function' ||
        typeof candidate.getVideoData === 'function' ||
        typeof candidate.seekTo === 'function' ||
        typeof candidate.getCurrentTime === 'function';
    }) || null;
  }

  function getQualityLevels(state) {
    if (!state.playerApi) {
      state.playerApi = getYoutubePlayerApi(state.video);
    }

    if (!state.playerApi || typeof state.playerApi.getAvailableQualityLevels !== 'function') {
      return [];
    }

    try {
      const levels = state.playerApi.getAvailableQualityLevels();
      return Array.from(new Set(
        (Array.isArray(levels) ? levels : [])
          .filter(function (level) {
            return typeof level === 'string' && level.length <= 32;
          })
          .map(normalizeQualityLevel)
          .filter(Boolean)
      ));
    } catch (error) {
      reportError('quality-read-levels', error);
      return [];
    }
  }

  function qualityLabel(level) {
    const labels = {
      auto: 'Auto',
      default: 'Auto',
      tiny: '144p',
      small: '240p',
      medium: '360p',
      large: '480p',
      hd720: '720p',
      hd1080: '1080p',
      hd1440: '1440p',
      hd2160: '2160p',
      highres: '4320p'
    };

    return labels[level] || String(level || 'Auto');
  }

  function normalizeQualityLevel(level) {
    const value = String(level || 'auto').toLowerCase();
    return value === 'default' ? 'auto' : value;
  }

  function isSameQualityLevel(firstLevel, secondLevel) {
    return normalizeQualityLevel(firstLevel) === normalizeQualityLevel(secondLevel);
  }

  function applyCaptionControl(state, info) {
    const available = info && info.available !== false;
    const pressedValue = String(Boolean(info && info.enabled));
    const enabled = captionUtils.isCaptionButtonPressed
      ? captionUtils.isCaptionButtonPressed(pressedValue)
      : pressedValue === 'true';

    state.controls.captionsButton.disabled = !available;
    state.controls.captionsButton.setAttribute('aria-pressed', pressedValue);
    state.controls.captionsButton.setAttribute(
      'aria-label',
      enabled ? 'Turn captions off' : 'Turn captions on'
    );
    state.controls.captionsButton.title = available
      ? enabled ? 'Turn captions off' : 'Turn captions on'
      : 'Captions are unavailable for this preview';
  }

  function updateCaptionControl(state) {
    const nativeInfo = updateNativeCaptionMirror(state);
    if (nativeInfo && nativeInfo.available) {
      return;
    }

    const tracks = getCaptionTracks(state.video);
    if (tracks.length) {
      const directInfo = {
        available: true,
        enabled: tracks.some(function (track) {
          return track.mode === 'showing';
        })
      };
      state.captionInfo = directInfo;
      applyCaptionControl(state, directInfo);
      return;
    }

    applyCaptionControl(state, state.captionInfo || { available: false, enabled: false });
  }

  function hasCaptionTracks(catalog) {
    return Boolean(
      catalog &&
      Array.isArray(catalog.tracks) &&
      catalog.tracks.length
    );
  }

  function mergeCaptionCatalogs(primary, secondary) {
    if (!primary && !secondary) {
      return null;
    }

    const first = primary || {};
    const second = secondary || {};
    const tracks = hasCaptionTracks(first) ? first.tracks : second.tracks || [];
    const translationLanguages = Array.isArray(first.translationLanguages) &&
      first.translationLanguages.length
      ? first.translationLanguages
      : second.translationLanguages || [];
    const duration = Number(first.duration) > 0
      ? Number(first.duration)
      : Number(second.duration) > 0
        ? Number(second.duration)
        : 0;

    return {
      available: Boolean(first.available || second.available || tracks.length),
      tracks: tracks,
      translationLanguages: translationLanguages,
      videoId: first.videoId || second.videoId || '',
      duration: duration,
      storyboard: first.storyboard || second.storyboard || null
    };
  }

  function logStoryboardForensics(state, event, details, mappingKey) {
    debugLog('Storyboard', event, details);
    if (event === 'frameMapped' && mappingKey) {
      if (state.timelineLastForensicFrameKey === mappingKey) {
        return;
      }
      state.timelineLastForensicFrameKey = mappingKey;
    }
    forensicLog('StoryboardForensics', event, details);
  }

  function debugStoryboardMetadata(state, storyboard) {
    const duration = state.duration || (storyboard && storyboard.duration) || 0;
    const temporalDiagnostics = captionUtils.getStoryboardTemporalDiagnostics
      ? captionUtils.getStoryboardTemporalDiagnostics(storyboard, 0, duration)
      : null;
    const format = temporalDiagnostics && temporalDiagnostics.formats.find(function (candidate) {
      return candidate.isRecommended;
    }) || null;

    logStoryboardForensics(state, 'metadata', {
      videoId: state.videoId,
      duration: duration,
      storyboardSpecFound: Boolean(storyboard),
      storyboardLevel: format ? format.level : null,
      frameCount: format ? format.count : 0,
      columns: format ? format.columns : 0,
      rows: format ? format.rows : 0,
      framesPerSprite: format ? format.framesPerSprite : 0,
      spriteCount: format ? format.spriteCount : 0,
      storyboardUrl: format ? getDebugUrl(storyboard.template) : '',
      templateUrl: format ? getDebugUrl(storyboard.template) : '',
      formats: temporalDiagnostics ? temporalDiagnostics.formats.map(function (candidate) {
        return Object.assign({}, candidate, {
          selected: candidate.isRecommended === true
        });
      }) : []
    });
  }

  async function requestCaptionCatalog(state) {
    if (state.captionCatalogLoaded && state.captionCatalog) {
      return state.captionCatalog;
    }

    if (state.captionCatalogRequest) {
      return state.captionCatalogRequest;
    }

    const request = (async function () {
      const pageCatalog = await requestPageBridge('caption-catalog', {
        videoId: state.videoId
      });
      if (pageCatalog && pageCatalog.videoId && !state.videoId) {
        state.videoId = pageCatalog.videoId;
      }

      let catalog = pageCatalog;
      if (!catalog || !hasCaptionTracks(catalog) || !catalog.storyboard) {
        const serviceResult = await requestCaptionService('caption-tracks', {
          videoId: state.videoId
        }, CAPTION_SERVICE_TIMEOUT_MS);
        const serviceCatalog = serviceResult && captionUtils.sanitizeCaptionCatalog
          ? captionUtils.sanitizeCaptionCatalog(
            serviceResult,
            window.location.origin,
            state.videoId
          )
          : null;
        catalog = mergeCaptionCatalogs(catalog, serviceCatalog);
      }

      if (catalog && catalog.videoId) {
        state.videoId = catalog.videoId;
      }
      if (catalog && Number.isFinite(Number(catalog.duration)) &&
        Number(catalog.duration) > 0) {
        state.duration = Number(catalog.duration);
      }
      if (catalog && activeOverlay === state) {
        state.captionCatalog = catalog;
        state.storyboard = catalog.storyboard || null;
        state.captionCatalogLoaded = true;
        debugStoryboardMetadata(state, state.storyboard);
        scheduleVideoControlUpdate(state);
      }

      return catalog;
    })();

    state.captionCatalogRequest = request;
    try {
      return await request;
    } finally {
      if (state.captionCatalogRequest === request) {
        state.captionCatalogRequest = null;
      }
    }
  }

  function refreshCaptionControl(state) {
    const nativeInfo = updateNativeCaptionMirror(state);
    if (nativeInfo && nativeInfo.available) {
      debugLog('Captions', 'native renderer state', {
        videoId: state.videoId,
        playerFound: Boolean(nativeInfo.player),
        captionButtonFound: Boolean(nativeInfo.button),
        setOptionAvailable: Boolean(state.playerApi &&
          typeof state.playerApi.setOption === 'function'),
        captionRendererFound: Boolean(nativeInfo.renderer),
        captionState: nativeInfo.enabled ? 'enabled' : 'disabled',
        captionEnabled: Boolean(nativeInfo.enabled),
        fallbackUsed: false,
        timedTextFallbackUsed: false
      });
      return;
    }

    const tracks = getCaptionTracks(state.video);
    if (tracks.length) {
      updateCaptionControl(state);
      return;
    }

    const requestId = ++state.captionRequestId;
    requestPageBridge('captions-info', { videoId: state.videoId }, NATIVE_CAPTION_REQUEST_TIMEOUT_MS)
      .then(function (nativeBridgeInfo) {
        if (activeOverlay !== state || requestId !== state.captionRequestId) {
          return null;
        }

        if (nativeBridgeInfo && nativeBridgeInfo.available === true) {
          state.captionInfo = {
            available: true,
            enabled: Boolean(nativeBridgeInfo.enabled)
          };
          applyCaptionControl(state, state.captionInfo);
          const updatedNativeInfo = updateNativeCaptionMirror(state);
          debugLog('Captions', 'page-native renderer state', {
            videoId: state.videoId,
            playerFound: Boolean(updatedNativeInfo && updatedNativeInfo.player),
            captionButtonFound: Boolean(updatedNativeInfo && updatedNativeInfo.button),
            setOptionAvailable: Boolean(state.playerApi &&
              typeof state.playerApi.setOption === 'function'),
            captionRendererFound: Boolean(updatedNativeInfo && updatedNativeInfo.renderer),
            captionState: state.captionInfo.enabled ? 'enabled' : 'disabled',
            captionEnabled: Boolean(state.captionInfo.enabled),
            fallbackUsed: false,
            timedTextFallbackUsed: false
          });
          return null;
        }

        return requestCaptionCatalog(state);
      }).then(function (catalog) {
        if (activeOverlay !== state || requestId !== state.captionRequestId) {
          return;
        }

        if (!catalog) {
          state.captionInfo = { available: false, enabled: false };
          applyCaptionControl(state, state.captionInfo);
          return;
        }

        if (hasCaptionTracks(catalog)) {
          state.captionInfo = { available: true, enabled: false };
          applyCaptionControl(state, state.captionInfo);
        }
      }).catch(function (error) {
        reportError('caption-control-refresh', error);
      });
  }

  function chooseCaptionSelection(catalog) {
    const browserLanguage = String(navigator.language || '').toLowerCase();
    const browserBaseLanguage = browserLanguage.split('-')[0];
    const tracks = Array.isArray(catalog.tracks) ? catalog.tracks : [];
    const translations = Array.isArray(catalog.translationLanguages)
      ? catalog.translationLanguages
      : [];
    const directTrack = tracks.find(function (track) {
      const languageCode = String(track.languageCode || '').toLowerCase();
      return languageCode === browserLanguage ||
        languageCode.split('-')[0] === browserBaseLanguage;
    });
    const track = directTrack || tracks[0];
    const translatedLanguage = !directTrack && translations.find(function (language) {
      const languageCode = String(language.languageCode || '').toLowerCase();
      return languageCode === browserLanguage ||
        languageCode.split('-')[0] === browserBaseLanguage;
    });

    if (!track) {
      return null;
    }

    return {
      trackId: track.id,
      track: track,
      targetLanguage: translatedLanguage ? translatedLanguage.languageCode : null,
      languageCode: translatedLanguage ? translatedLanguage.languageCode : track.languageCode,
      label: translatedLanguage
        ? String(track.label || 'Captions') + ' · ' +
          translatedLanguage.languageCode.toUpperCase()
        : String(track.label || 'Captions')
    };
  }

  async function toggleNativeCaptions(state) {
    const initial = updateNativeCaptionMirror(state);
    let current = initial;

    if (!current || !current.available) {
      const bridgeInfo = await requestPageBridge(
        'captions-info',
        { videoId: state.videoId },
        NATIVE_CAPTION_REQUEST_TIMEOUT_MS
      );
      if (activeOverlay !== state) {
        return null;
      }
      if (bridgeInfo && bridgeInfo.available === true) {
        current = {
          available: true,
          enabled: Boolean(bridgeInfo.enabled)
        };
      }
    }

    if (!current || !current.available) {
      return null;
    }

    const desiredEnabled = !current.enabled;
    const bridgeResult = await requestPageBridge(
      'set-captions-enabled',
      { videoId: state.videoId, desiredEnabled: desiredEnabled },
      NATIVE_CAPTION_REQUEST_TIMEOUT_MS
    );

    if (activeOverlay !== state) {
      return null;
    }

    if (bridgeResult && bridgeResult.available === true) {
      state.captionInfo = {
        available: true,
        enabled: Boolean(bridgeResult.enabled)
      };
      applyCaptionControl(state, state.captionInfo);
      const updatedNativeInfo = updateNativeCaptionMirror(state);
      debugLog('Captions', 'native toggle result', {
        videoId: state.videoId,
        desiredEnabled: desiredEnabled,
        nativeEnabledBefore: current.enabled,
        nativeEnabledAfter: Boolean(bridgeResult.enabled),
        nativeButtonClicked: bridgeResult.buttonClicked === true,
        playerFound: Boolean(updatedNativeInfo && updatedNativeInfo.player),
        captionButtonFound: Boolean(updatedNativeInfo && updatedNativeInfo.button),
        setOptionAvailable: Boolean(state.playerApi &&
          typeof state.playerApi.setOption === 'function'),
        setOptionUsed: bridgeResult.setOptionUsed === true,
        captionRendererFound: Boolean(updatedNativeInfo && updatedNativeInfo.renderer),
        captionState: state.captionInfo.enabled ? 'enabled' : 'disabled',
        captionEnabled: Boolean(state.captionInfo.enabled),
        fallbackUsed: false,
        timedTextFallbackUsed: false
      });
      return bridgeResult;
    }

    state.captionInfo = {
      available: true,
      enabled: current.enabled
    };
    applyCaptionControl(state, state.captionInfo);
    debugLog('Captions', 'native toggle failed', {
      videoId: state.videoId,
      desiredEnabled: desiredEnabled,
      nativeEnabledBefore: current.enabled,
      nativeEnabledAfter: current.enabled,
      nativeButtonClicked: Boolean(bridgeResult && bridgeResult.buttonClicked),
      setOptionUsed: Boolean(bridgeResult && bridgeResult.setOptionUsed),
      fallbackUsed: false
    });
    return {
      ok: false,
      available: true,
      enabled: current.enabled,
      buttonClicked: Boolean(bridgeResult && bridgeResult.buttonClicked),
      setOptionUsed: Boolean(bridgeResult && bridgeResult.setOptionUsed)
    };
  }

  async function loadPreviewCaptions(state) {
    if (state.captionLoadPending) {
      return;
    }

    state.captionLoadPending = true;
    state.controls.captionsButton.disabled = true;
    state.controls.captionsButton.title = 'Loading captions…';

    try {
      const catalog = await requestCaptionCatalog(state);
      if (activeOverlay !== state) {
        return;
      }

      if (catalog && catalog.available && Array.isArray(catalog.tracks) && catalog.tracks.length) {
        state.captionCatalog = catalog;
        const selection = chooseCaptionSelection(catalog);
        let captionResult = null;
        if (selection) {
          const captionPayload = {
            videoId: state.videoId,
            trackId: selection.trackId,
            track: selection.track,
            targetLanguage: selection.targetLanguage
          };
          const pageCaptionResult = await requestPageBridge(
            'fetch-captions',
            captionPayload,
            CAPTION_SERVICE_TIMEOUT_MS
          );
          const pageHasCaptionData = pageCaptionResult && (
            Array.isArray(pageCaptionResult.cues) && pageCaptionResult.cues.length ||
            typeof pageCaptionResult.rawCaptionText === 'string' &&
            pageCaptionResult.rawCaptionText.length
          );
          captionResult = pageHasCaptionData
            ? pageCaptionResult
            : await requestCaptionService(
              'fetch-captions',
              captionPayload,
              CAPTION_SERVICE_TIMEOUT_MS
            );
        }

        const captionCues = captionResult && Array.isArray(captionResult.cues)
          ? captionResult.cues
          : captionResult && typeof captionResult.rawCaptionText === 'string'
            ? captionUtils.parseJsonCaptionCues
              ? captionUtils.parseJsonCaptionCues(captionResult.rawCaptionText)
              : []
            : [];
        const fallbackCaptionCues = captionCues.length
          ? captionCues
          : captionResult && typeof captionResult.rawCaptionText === 'string' &&
            captionUtils.parseXmlCaptionCues
            ? captionUtils.parseXmlCaptionCues(captionResult.rawCaptionText)
            : [];

        if (captionResult && fallbackCaptionCues.length && installSyntheticCaptionTrack(
          state,
          fallbackCaptionCues,
          {
            label: selection.label,
            languageCode: selection.languageCode
          }
        )) {
          state.captionInfo = { available: true, enabled: true };
          applyCaptionControl(state, state.captionInfo);
          debugLog('Captions', 'timed-text fallback enabled', {
            videoId: state.videoId,
            fallbackUsed: true,
            timedTextFallbackUsed: true
          });
          return;
        }
      }

      state.captionInfo = { available: false, enabled: false };
      applyCaptionControl(state, state.captionInfo);
      debugLog('Captions', 'timed-text fallback unavailable', {
        videoId: state.videoId,
        fallbackUsed: true,
        timedTextFallbackUsed: true
      });
      showPreviewNotice('YouTube did not provide captions for this preview.');
    } catch (error) {
      reportError('caption-load', error);
      if (activeOverlay === state) {
        state.captionInfo = { available: false, enabled: false };
        applyCaptionControl(state, state.captionInfo);
        showPreviewNotice('Captions could not be loaded for this preview.');
      }
    } finally {
      state.captionLoadPending = false;
      if (activeOverlay === state) {
        updateCaptionControl(state);
      }
    }
  }

  function toggleSyntheticCaptionTracks(state, tracks) {
    const enabled = tracks.some(function (track) {
      return track.mode === 'showing';
    });

    tracks.forEach(function (track, index) {
      track.mode = enabled ? 'disabled' : index === 0 ? 'showing' : 'disabled';
    });
    state.captionInfo = { available: true, enabled: !enabled };
    applyCaptionControl(state, state.captionInfo);
  }

  function setVideoPropertySafely(state, property, value) {
    if (
      activeOverlay !== state ||
      !state.video ||
      !state.video.isConnected
    ) {
      return false;
    }

    try {
      state.video[property] = value;
      if (state.videoState && (property === 'muted' || property === 'volume' || property === 'playbackRate')) {
        state.videoState[property] = value;
      }
      return true;
    } catch (error) {
      reportError('set-video-' + property, error);
      return false;
    }
  }

  function pauseVideoSafely(state) {
    if (!state.video || !state.video.isConnected) {
      return;
    }

    try {
      state.video.pause();
    } catch (error) {
      reportError('pause-video', error);
    }
  }

  function scheduleVideoControlUpdate(state) {
    if (state.controlsFrame) {
      return;
    }

    state.controlsFrame = window.requestAnimationFrame(function () {
      state.controlsFrame = 0;
      if (activeOverlay === state) {
        updateVideoControls(state);
      }
    });
  }

  function updateFullscreenControl(state) {
    const snapshot = state.controlSnapshot || (state.controlSnapshot = {});
    const isFullscreen = document.fullscreenElement === state.elements.frame;

    if (snapshot.fullscreen === isFullscreen) {
      return;
    }

    snapshot.fullscreen = isFullscreen;
    setButtonIcon(state.controls.fullscreenButton, 'fullscreen');
    state.controls.fullscreenButton.setAttribute(
      'aria-label',
      isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'
    );
    state.controls.fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
  }

  function updateVideoControls(state) {
    const video = state.video;
    const controls = state.controls;
    if (!video || !video.isConnected) {
      return;
    }

    const snapshot = state.controlSnapshot || (state.controlSnapshot = {});
    const duration = getPreviewDuration(state);
    const currentTime = Number.isFinite(video.currentTime) && video.currentTime >= 0
      ? video.currentTime
      : 0;
    const displayTime = getSeekDisplayTimeValue(currentTime, state, duration);
    const isPlaying = !video.paused && !video.ended;

    const volume = Number.isFinite(video.volume) ? video.volume : 1;

    const isMuted = video.muted || video.volume === 0;
    if (snapshot.playing !== isPlaying) {
      snapshot.playing = isPlaying;
      controls.playButton.setAttribute('aria-label', isPlaying ? 'Pause preview' : 'Play preview');
      controls.playButton.title = isPlaying ? 'Pause preview' : 'Play preview';
      setButtonIcon(controls.playButton, isPlaying ? 'pause' : 'play');
    }

    if (snapshot.muted !== isMuted) {
      snapshot.muted = isMuted;
      controls.muteButton.setAttribute(
        'aria-label',
        isMuted ? 'Unmute preview' : 'Mute preview'
      );
      controls.muteButton.title = isMuted ? 'Unmute preview' : 'Mute preview';
      setButtonIcon(controls.muteButton, isMuted ? 'muted' : 'volume');
    }
    if (controls.volumeInput) {
      if (document.activeElement !== controls.volumeInput) {
        controls.volumeInput.value = String(volume);
      }
      controls.volumeInput.style.setProperty('--ytpm-volume-progress', (volume * 100) + '%');
    }

    controls.seekInput.disabled = duration === 0;
    controls.seekInput.max = String(duration || 1);
    const seekRangeValueBeforeSync = controls.seekInput.value;
    controls.seekInput.value = String(displayTime);
    controls.seekInput.style.setProperty(
      '--ytpm-seek-progress',
      (duration ? Math.min(100, (displayTime / duration) * 100) : 0) + '%'
    );
    controls.timeLabel.textContent = formatTime(displayTime) + ' / ' + formatTime(duration);
    if (DEBUG_LOGGING && seekRangeValueBeforeSync !== controls.seekInput.value) {
      forensicLog('SeekForensics', 'uiSynchronization', {
        rangeValueBefore: seekRangeValueBeforeSync,
        rangeValueAfter: controls.seekInput.value,
        displayTime: displayTime,
        videoCurrentTime: currentTime,
        playerCurrentTime: readPlayerCurrentTime(state),
        duration: duration,
        state: getSeekInteractionStateSnapshot(state),
        reason: state.seekDragging || state.seekPending
          ? 'pending-time-preserved'
          : 'playback-time-applied'
      });
    }

    updateCaptionControl(state);
    updateFullscreenControl(state);
  }

  function getTimelineHoverPosition(state, clientX) {
    const duration = getPreviewDuration(state);
    if (!duration) {
      return null;
    }

    const rect = state.controls.seekInput.getBoundingClientRect();
    const frameRect = state.elements.frame.getBoundingClientRect();
    let percent;
    if (Number.isFinite(clientX) && rect.width > 0) {
      const pointerPosition = captionUtils.getTimelinePointerPosition &&
        captionUtils.getTimelinePointerPosition(clientX, rect.left, rect.width, duration);
      percent = pointerPosition ? pointerPosition.percent : (clientX - rect.left) / rect.width;
    } else {
      const currentValue = Number(state.controls.seekInput.value);
      percent = currentValue / duration;
    }

    percent = Math.max(0, Math.min(1, Number.isFinite(percent) ? percent : 0));
    const frameWidth = frameRect.width > 0 ? frameRect.width : rect.width;
    const frameLeft = frameRect.width > 0 ? frameRect.left : rect.left;
    const trackX = rect.left + (rect.width * percent);

    return {
      percent: percent,
      seconds: percent * duration,
      leftPx: Math.max(0, Math.min(frameWidth, trackX - frameLeft))
    };
  }

  function hideTimelinePreview(state) {
    state.timelineHovering = false;
    state.timelineHoverToken += 1;
    state.timelineDesiredUrl = '';
    state.controls.timelinePreview.hidden = true;
  }

  function getTimelineImageUrl(image) {
    return image && typeof image.src === 'string' ? image.src : '';
  }

  function getTimelineRequestState(state) {
    return {
      active: activeOverlay === state,
      hovering: state.timelineHovering,
      token: state.timelineHoverToken,
      desiredUrl: state.timelineDesiredUrl,
      displayedUrl: state.timelineDisplayedUrl
    };
  }

  function isCurrentTimelineFrame(state, token, url) {
    const requestState = getTimelineRequestState(state);
    return captionUtils.isStoryboardFrameCurrent
      ? captionUtils.isStoryboardFrameCurrent(requestState, token, url)
      : requestState.active && requestState.hovering &&
        requestState.token === token && requestState.desiredUrl === url;
  }

  function canApplyTimelineFrame(state, token, url, image) {
    const requestState = getTimelineRequestState(state);
    const stateMatches = captionUtils.canApplyStoryboardFrame
      ? captionUtils.canApplyStoryboardFrame(requestState, token, url)
      : isCurrentTimelineFrame(state, token, url) &&
        requestState.displayedUrl === url;
    return stateMatches && getTimelineImageUrl(image) === url;
  }

  function logStaleTimelineFrame(state, frame, position, token, displayedUrl, reason) {
    logStoryboardForensics(state, 'frameIgnored', {
      token: token,
      timestamp: position.seconds,
      videoId: state.videoId,
      frameIndex: frame.frameIndex,
      spriteIndex: frame.spriteIndex,
      cellIndex: frame.cellIndex,
      requestedUrl: getDebugUrl(frame.url),
      displayedUrl: getDebugUrl(displayedUrl),
      ignoredAsStale: true,
      reason: reason
    });
  }

  function applyTimelineFrame(state, frame, position, token, imageLoadResult) {
    const image = state.controls.timelineImage;
    const displayedUrl = getTimelineImageUrl(image);
    if (!canApplyTimelineFrame(state, token, frame.url, image)) {
      logStaleTimelineFrame(state, frame, position, token, displayedUrl, 'commit-check');
      return;
    }

    const preview = state.controls.timelinePreview;
    preview.style.setProperty('--ytpm-timeline-preview-left', position.leftPx + 'px');
    preview.style.width = frame.width + 'px';
    preview.style.height = (frame.height + 18) + 'px';
    preview.style.setProperty(
      'transform',
      position.percent < 0.1
        ? 'translateX(0)'
        : position.percent > 0.9
          ? 'translateX(-100%)'
          : 'translateX(-50%)',
      'important'
    );
    image.style.width = frame.sheetWidth + 'px';
    image.style.height = frame.sheetHeight + 'px';
    image.style.transform = 'translate(-' + frame.x + 'px, -' + frame.y + 'px)';
    state.controls.timelineTime.textContent = formatTime(position.seconds);
    preview.hidden = false;
    logStoryboardForensics(state, 'frameApplied', {
      token: token,
      timestamp: position.seconds,
      videoId: state.videoId,
      frameIndex: frame.frameIndex,
      framesPerSprite: frame.framesPerSprite,
      spriteIndex: frame.spriteIndex,
      cellIndex: frame.cellIndex,
      x: frame.x,
      y: frame.y,
      requestedUrl: getDebugUrl(frame.url),
      displayedUrl: getDebugUrl(displayedUrl),
      imageLoadResult: imageLoadResult || 'applied',
      applied: true,
      ignoredAsStale: false
    });
  }

  function loadTimelineFrame(state, frame, position, token) {
    if (!frame || typeof frame.url !== 'string' ||
      !frame.url.startsWith('https://i.ytimg.com/')) {
      hideTimelinePreview(state);
      return;
    }

    const image = state.controls.timelineImage;
    const requestedUrl = frame.url;
    const displayedUrl = getTimelineImageUrl(image);
    const sameSpriteReady = state.timelineDisplayedUrl === requestedUrl &&
      displayedUrl === requestedUrl && image.complete && image.naturalWidth > 0;
    logStoryboardForensics(state, 'frameRequested', {
      token: token,
      timestamp: position.seconds,
      videoId: state.videoId,
      frameIndex: frame.frameIndex,
      framesPerSprite: frame.framesPerSprite,
      spriteIndex: frame.spriteIndex,
      cellIndex: frame.cellIndex,
      x: frame.x,
      y: frame.y,
      requestedUrl: getDebugUrl(requestedUrl),
      displayedUrl: getDebugUrl(displayedUrl),
      cacheHit: sameSpriteReady,
      loadStarted: !sameSpriteReady
    });

    if (sameSpriteReady) {
      applyTimelineFrame(state, frame, position, token, 'same-sprite');
      return;
    }

    state.controls.timelinePreview.hidden = true;
    if (typeof Image !== 'function') {
      logStoryboardForensics(state, 'frameFailed', {
        token: token,
        timestamp: position.seconds,
        videoId: state.videoId,
        frameIndex: frame.frameIndex,
        framesPerSprite: frame.framesPerSprite,
        spriteIndex: frame.spriteIndex,
        cellIndex: frame.cellIndex,
        x: frame.x,
        y: frame.y,
        requestedUrl: getDebugUrl(requestedUrl),
        displayedUrl: getDebugUrl(displayedUrl),
        imageLoadResult: 'unavailable',
        loadCompleted: false
      });
      return;
    }

    const loader = new Image();
    let settled = false;
    const ignoreIfStale = function (reason) {
      logStaleTimelineFrame(state, frame, position, token, getTimelineImageUrl(image), reason);
    };
    const commitLoadedSprite = function (imageLoadResult) {
      if (settled) {
        return;
      }
      settled = true;

      const loaderUrl = getTimelineImageUrl(loader);
      if (!loader.complete || loader.naturalWidth <= 0 || loaderUrl !== requestedUrl) {
        logStoryboardForensics(state, 'frameIgnored', {
          token: token,
          timestamp: position.seconds,
          requestedUrl: getDebugUrl(requestedUrl),
          displayedUrl: getDebugUrl(getTimelineImageUrl(image)),
          ignoredAsStale: true,
          reason: 'loader-not-ready'
        });
        return;
      }
      if (!isCurrentTimelineFrame(state, token, requestedUrl)) {
        ignoreIfStale('request-check');
        return;
      }

      image.src = requestedUrl;
      const nextDisplayedUrl = getTimelineImageUrl(image);
      if (nextDisplayedUrl !== requestedUrl) {
        ignoreIfStale('visible-source-mismatch');
        return;
      }

      state.timelineDisplayedUrl = nextDisplayedUrl;
      applyTimelineFrame(state, frame, position, token, imageLoadResult);
    };

    loader.onload = function () {
      logStoryboardForensics(state, 'loadCompleted', {
        token: token,
        timestamp: position.seconds,
        requestedUrl: getDebugUrl(requestedUrl),
        displayedUrl: getDebugUrl(getTimelineImageUrl(image)),
        loadCompleted: true
      });
      commitLoadedSprite('loaded');
    };
    loader.onerror = function (error) {
      if (settled) {
        return;
      }
      settled = true;
      reportError('timeline-preview-image', error);
      logStoryboardForensics(state, 'frameFailed', {
        token: token,
        timestamp: position.seconds,
        videoId: state.videoId,
        frameIndex: frame.frameIndex,
        framesPerSprite: frame.framesPerSprite,
        spriteIndex: frame.spriteIndex,
        cellIndex: frame.cellIndex,
        x: frame.x,
        y: frame.y,
        requestedUrl: getDebugUrl(requestedUrl),
        displayedUrl: getDebugUrl(getTimelineImageUrl(image)),
        imageLoadResult: 'error',
        loadCompleted: false
      });
    };
    logStoryboardForensics(state, 'loadStarted', {
      token: token,
      timestamp: position.seconds,
      requestedUrl: getDebugUrl(requestedUrl),
      displayedUrl: getDebugUrl(getTimelineImageUrl(image))
    });
    loader.src = requestedUrl;
    if (loader.complete && loader.naturalWidth > 0) {
      commitLoadedSprite('already-complete');
    }
  }

  function renderTimelinePreview(state, position, storyboard, token) {
    if (!captionUtils.getStoryboardFrame) {
      hideTimelinePreview(state);
      return;
    }

    const frame = captionUtils.getStoryboardFrame(
      storyboard,
      position.seconds,
      getPreviewDuration(state)
    );
    if (!frame) {
      state.timelineDesiredUrl = '';
      hideTimelinePreview(state);
      return;
    }

    state.timelineDesiredUrl = frame.url;
    const temporalDiagnostics = captionUtils.getStoryboardTemporalDiagnostics
      ? captionUtils.getStoryboardTemporalDiagnostics(
        storyboard,
        position.seconds,
        getPreviewDuration(state)
      )
      : null;
    const mappedDetails = {
      token: token,
      timestamp: position.seconds,
      videoId: state.videoId,
      duration: getPreviewDuration(state),
      frameIndex: frame.frameIndex,
      framesPerSprite: frame.framesPerSprite,
      spriteIndex: frame.spriteIndex,
      cellIndex: frame.cellIndex,
      x: frame.x,
      y: frame.y,
      requestedUrl: getDebugUrl(frame.url),
      requestedSeconds: position.seconds,
      normalizedTimelinePosition: position.percent,
      selectedLevel: temporalDiagnostics ? temporalDiagnostics.selectedLevel : null,
      selectedFrameCount: temporalDiagnostics ? temporalDiagnostics.selectedFrameCount : 0,
      estimatedSecondsPerFrame: temporalDiagnostics
        ? temporalDiagnostics.estimatedSecondsPerFrame
        : 0,
      bucketStartSeconds: temporalDiagnostics ? temporalDiagnostics.bucketStartSeconds : 0,
      bucketEndSeconds: temporalDiagnostics ? temporalDiagnostics.bucketEndSeconds : 0,
      bucketCenterSeconds: temporalDiagnostics ? temporalDiagnostics.bucketCenterSeconds : 0,
      alternativeFormats: temporalDiagnostics ? temporalDiagnostics.alternativeFormats : []
    };
    logStoryboardForensics(
      state,
      'frameMapped',
      mappedDetails,
      String(frame.url) + '|' + frame.frameIndex
    );
    loadTimelineFrame(state, frame, position, token);
  }

  function updateTimelinePreview(state, clientX) {
    if (!state.video || !state.video.isConnected) {
      hideTimelinePreview(state);
      return;
    }

    state.timelineHovering = true;
    state.timelineHoverClientX = Number.isFinite(clientX) ? clientX : null;

    if (!getPreviewDuration(state)) {
      state.timelineHoverPosition = null;
      state.timelineDesiredUrl = '';
      state.controls.timelinePreview.hidden = true;
      if (!state.captionCatalogLoaded && !state.timelineMetadataRequest) {
        const metadataRequest = requestCaptionCatalog(state);
        state.timelineMetadataRequest = metadataRequest;
        metadataRequest.then(function () {
          if (activeOverlay === state && state.timelineHovering) {
            updateTimelinePreview(state, state.timelineHoverClientX);
          }
        }).catch(function (error) {
          reportError('timeline-preview-metadata', error);
        }).finally(function () {
          if (state.timelineMetadataRequest === metadataRequest) {
            state.timelineMetadataRequest = null;
          }
        });
      }
      return;
    }

    const position = getTimelineHoverPosition(state, clientX);
    if (!position) {
      hideTimelinePreview(state);
      return;
    }

    state.timelineHoverPosition = position;
    const token = ++state.timelineHoverToken;
    state.controls.timelineTime.textContent = formatTime(position.seconds);
    state.controls.timelinePreview.style.setProperty(
      '--ytpm-timeline-preview-left',
      position.leftPx + 'px'
    );

    const storyboard = state.storyboard ||
      state.captionCatalog && state.captionCatalog.storyboard;
    if (storyboard) {
      renderTimelinePreview(state, position, storyboard, token);
      return;
    }

    state.timelineDesiredUrl = '';
    state.controls.timelinePreview.hidden = false;
    requestCaptionCatalog(state).then(function (catalog) {
      if (activeOverlay !== state || !state.timelineHovering) {
        return;
      }

      const latestPosition = getTimelineHoverPosition(state, state.timelineHoverClientX) ||
        state.timelineHoverPosition;
      const latestStoryboard = state.storyboard || catalog && catalog.storyboard;
      if (latestStoryboard && latestPosition) {
        renderTimelinePreview(
          state,
          latestPosition,
          latestStoryboard,
          state.timelineHoverToken
        );
      } else {
        hideTimelinePreview(state);
      }
    }).catch(function (error) {
      reportError('timeline-preview-metadata', error);
      if (activeOverlay === state && token === state.timelineHoverToken) {
        state.controls.timelinePreview.hidden = true;
      }
    });
  }

  function readVideoCurrentTime(state) {
    const value = Number(state.video && state.video.currentTime);
    return Number.isFinite(value) && value >= 0 && value <= SEEK_MAX_SECONDS
      ? value
      : null;
  }

  function readPlayerCurrentTime(state) {
    if (!state.playerApi) {
      state.playerApi = getYoutubePlayerApi(state.video);
    }

    if (!state.playerApi || typeof state.playerApi.getCurrentTime !== 'function') {
      return null;
    }

    try {
      const value = Number(state.playerApi.getCurrentTime());
      return Number.isFinite(value) && value >= 0 && value <= SEEK_MAX_SECONDS
        ? value
        : null;
    } catch (error) {
      reportError('seek-player-current-time', error);
      return null;
    }
  }

  function readBufferedRanges(video) {
    const ranges = [];
    if (!video || !video.buffered) {
      return ranges;
    }

    try {
      for (let index = 0; index < video.buffered.length && index < 100; index += 1) {
        const start = Number(video.buffered.start(index));
        const end = Number(video.buffered.end(index));
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
          ranges.push({ start: start, end: end });
        }
      }
    } catch (error) {
      reportError('seek-buffered-ranges', error);
    }

    return ranges;
  }

  function getSeekSnapshot(state) {
    const videoDuration = Number(state.video && state.video.duration);
    const metadataDuration = Number(state.duration);
    const playerCurrentTime = readPlayerCurrentTime(state);
    const videoCurrentTime = readVideoCurrentTime(state);

    return {
      videoCurrentTime: videoCurrentTime,
      playerCurrentTime: playerCurrentTime,
      playerFound: Boolean(state.playerApi),
      playerSeekToAvailable: Boolean(
        state.playerApi && typeof state.playerApi.seekTo === 'function'
      ),
      videoDuration: Number.isFinite(videoDuration) && videoDuration >= 0
        ? videoDuration
        : null,
      metadataDuration: Number.isFinite(metadataDuration) && metadataDuration > 0
        ? metadataDuration
        : null,
      bufferedRanges: readBufferedRanges(state.video)
    };
  }

  function getSeekRangeSnapshot(state) {
    const range = state && state.controls && state.controls.seekInput;
    if (!range) {
      return null;
    }

    const rect = readForensicRect(range);
    let valueAsNumber = null;
    try {
      valueAsNumber = Number.isFinite(range.valueAsNumber)
        ? range.valueAsNumber
        : null;
    } catch (error) {
      reportError('seek-forensics-value-as-number', error);
    }
    return {
      value: range.value,
      valueAsNumber: valueAsNumber,
      min: range.min,
      max: range.max,
      step: range.step,
      disabled: range.disabled,
      rect: rect
    };
  }

  function getSeekInteractionStateSnapshot(state) {
    const pendingSeekTime = state && state.pendingSeekTime !== null &&
      state.pendingSeekTime !== undefined && state.pendingSeekTime !== '' &&
      Number.isFinite(Number(state.pendingSeekTime))
      ? Number(state.pendingSeekTime)
      : null;
    const seekPointerId = state && state.seekPointerId !== null &&
      state.seekPointerId !== undefined && state.seekPointerId !== '' &&
      Number.isFinite(Number(state.seekPointerId))
      ? Number(state.seekPointerId)
      : null;
    return {
      seekDragging: Boolean(state && state.seekDragging),
      seekPending: Boolean(state && state.seekPending),
      pendingSeekTime: pendingSeekTime,
      seekRequestId: state ? state.seekRequestId : 0,
      seekInteractionId: state ? state.seekInteractionId : 0,
      seekCommittedInteractionId: state ? state.seekCommittedInteractionId : 0,
      seekPointerId: seekPointerId,
      lastCommitSource: state && state.seekLastCommitSource
        ? state.seekLastCommitSource
        : ''
    };
  }

  function getSeekPointerSnapshot(event, rangeSnapshot, duration) {
    const clientX = event && Number.isFinite(Number(event.clientX))
      ? Number(event.clientX)
      : null;
    const rect = rangeSnapshot && rangeSnapshot.rect;
    let ratio = null;
    let requestedTime = null;
    if (clientX !== null && rect && rect.width > 0) {
      ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      requestedTime = ratio * duration;
    }

    return {
      clientX: clientX,
      pageX: event && Number.isFinite(Number(event.pageX))
        ? Number(event.pageX)
        : null,
      button: event && Number.isFinite(Number(event.button))
        ? Number(event.button)
        : null,
      buttons: event && Number.isFinite(Number(event.buttons))
        ? Number(event.buttons)
        : null,
      pointerId: event && Number.isFinite(Number(event.pointerId))
        ? Number(event.pointerId)
        : null,
      pointerType: event && typeof event.pointerType === 'string'
        ? event.pointerType
        : '',
      ratio: ratio,
      requestedTimeFromGeometry: requestedTime
    };
  }

  function getSeekForensicEventSequence(state, event) {
    if (!state.seekForensicEventIds) {
      state.seekForensicEventIds = new WeakMap();
    }
    if (!event || (typeof event !== 'object' && typeof event !== 'function')) {
      state.seekForensicEventSequence += 1;
      return state.seekForensicEventSequence;
    }
    if (!state.seekForensicEventIds.has(event)) {
      state.seekForensicEventSequence += 1;
      state.seekForensicEventIds.set(event, state.seekForensicEventSequence);
    }
    return state.seekForensicEventIds.get(event);
  }

  function buildSeekForensicEventSnapshot(state, event, phase) {
    const range = getSeekRangeSnapshot(state);
    const duration = getPreviewDuration(state);
    const media = getSeekSnapshot(state);
    return {
      phase: phase,
      eventSequence: getSeekForensicEventSequence(state, event),
      eventType: event && event.type ? event.type : 'synthetic',
      eventTimeStamp: event && Number.isFinite(Number(event.timeStamp))
        ? Number(event.timeStamp)
        : null,
      isTrusted: Boolean(event && event.isTrusted),
      defaultPrevented: Boolean(event && event.defaultPrevented),
      targetTagName: event && event.target && event.target.tagName
        ? event.target.tagName.toLowerCase()
        : '',
      targetClassName: readForensicClassName(event && event.target),
      range: range,
      pointer: getSeekPointerSnapshot(event, range, duration),
      state: getSeekInteractionStateSnapshot(state),
      video: {
        currentTime: media.videoCurrentTime,
        duration: media.videoDuration,
        paused: Boolean(state.video && state.video.paused),
        seeking: Boolean(state.video && state.video.seeking),
        readyState: state.video ? state.video.readyState : null
      },
      player: {
        currentTime: media.playerCurrentTime,
        found: media.playerFound,
        seekToAvailable: media.playerSeekToAvailable
      },
      bufferedRanges: media.bufferedRanges
    };
  }

  function captureSeekForensicEvent(state, event) {
    if (!DEBUG_LOGGING || !event) {
      return;
    }
    if (!state.seekForensicCapturedEvents) {
      state.seekForensicCapturedEvents = new WeakSet();
    }
    if (state.seekForensicCapturedEvents.has(event)) {
      return;
    }

    state.seekForensicCapturedEvents.add(event);
    const snapshot = buildSeekForensicEventSnapshot(state, event, 'before-handler');
    if (!state.seekForensicEventBefore) {
      state.seekForensicEventBefore = new WeakMap();
    }
    state.seekForensicEventBefore.set(event, snapshot);
    forensicLog('SeekForensics', 'event', snapshot);
    const eventSequence = snapshot.eventSequence;
    const eventType = snapshot.eventType;
    Promise.resolve().then(function () {
      if (activeOverlay !== state) {
        return;
      }
      forensicLog('SeekForensics', 'eventDispatchCompleted', {
        eventSequence: eventSequence,
        eventType: eventType,
        stateBeforeHandler: snapshot.state,
        rangeBeforeHandler: snapshot.range,
        stateAfterDispatch: getSeekInteractionStateSnapshot(state),
        rangeAfterDispatch: getSeekRangeSnapshot(state),
        mediaAfterDispatch: getSeekSnapshot(state)
      });
    });
  }

  function logSeekForensicAction(state, event, action, details) {
    if (!DEBUG_LOGGING) {
      return;
    }

    const before = event && state.seekForensicEventBefore
      ? state.seekForensicEventBefore.get(event) || null
      : null;
    forensicLog('SeekForensics', 'handlerAction', {
      eventSequence: getSeekForensicEventSequence(state, event),
      eventType: event && event.type ? event.type : 'synthetic',
      action: action,
      details: details || {},
      stateBeforeHandler: before ? before.state : null,
      rangeBeforeHandler: before ? before.range : null,
      stateAfterHandler: getSeekInteractionStateSnapshot(state),
      rangeAfterHandler: getSeekRangeSnapshot(state),
      mediaAfterHandler: getSeekSnapshot(state)
    });
  }

  function installSeekEventForensics(state) {
    if (!DEBUG_LOGGING) {
      return;
    }

    const range = state.controls.seekInput;
    const eventTypes = [
      'pointerdown',
      'mousedown',
      'input',
      'change',
      'pointerup',
      'mouseup',
      'click',
      'pointercancel',
      'lostpointercapture',
      'keydown'
    ];
    eventTypes.forEach(function (eventType) {
      registerListener(
        state.controlCleanup,
        document,
        eventType,
        function (event) {
          const path = typeof event.composedPath === 'function'
            ? event.composedPath()
            : [];
          const targetsRange = event.target === range || path.includes(range);
          const closesActivePointer = (state.seekDragging ||
            state.seekForensicGestureActive) && [
            'pointerup',
            'mouseup',
            'pointercancel',
            'lostpointercapture'
          ].includes(eventType);
          if (targetsRange || closesActivePointer) {
            captureSeekForensicEvent(state, event);
          }
          if (eventType === 'mouseup' && state.seekForensicGestureActive) {
            window.setTimeout(function () {
              state.seekForensicGestureActive = false;
            }, 0);
          } else if (eventType === 'click' || eventType === 'pointercancel') {
            state.seekForensicGestureActive = false;
          }
        },
        true
      );
    });
  }

  function getManualSeekForensicSnapshot(label) {
    const state = activeOverlay;
    if (!state) {
      const unavailable = {
        label: String(label || '').slice(0, 200),
        activeOverlay: false
      };
      forensicLog('SeekForensics', 'manualSnapshotUnavailable', unavailable);
      return unavailable;
    }

    const snapshot = {
      label: String(label || '').slice(0, 200),
      activeOverlay: true,
      videoId: state.videoId || '',
      range: getSeekRangeSnapshot(state),
      state: getSeekInteractionStateSnapshot(state),
      media: getSeekSnapshot(state),
      activeRequest: state.seekActiveForensicRequest || null
    };
    forensicLog('SeekForensics', 'manualSnapshot', snapshot);
    return snapshot;
  }

  function isCurrentSeekRequest(state, requestId) {
    if (captionUtils.isSeekRequestCurrent) {
      return captionUtils.isSeekRequestCurrent({
        active: activeOverlay === state,
        requestId: state.seekRequestId
      }, requestId);
    }

    return activeOverlay === state && state.seekRequestId === requestId;
  }

  function isSeekWithinToleranceValue(actualTime, requestedTime, tolerance) {
    if (captionUtils.isSeekWithinTolerance) {
      return captionUtils.isSeekWithinTolerance(
        actualTime,
        requestedTime,
        Number.isFinite(Number(tolerance)) ? Number(tolerance) : SEEK_CONFIRM_TOLERANCE
      );
    }

    if (actualTime === null || actualTime === undefined ||
      requestedTime === null || requestedTime === undefined) {
      return false;
    }

    const actual = Number(actualTime);
    const requested = Number(requestedTime);
    return Number.isFinite(actual) && Number.isFinite(requested) &&
      Math.abs(actual - requested) <= (
        Number.isFinite(Number(tolerance)) ? Number(tolerance) : SEEK_CONFIRM_TOLERANCE
      );
  }

  function isSeekNoOpValue(actualTime, requestedTime) {
    if (captionUtils.isSeekNoOp) {
      return captionUtils.isSeekNoOp(
        actualTime,
        requestedTime,
        SEEK_NOOP_EPSILON
      );
    }

    return isSeekWithinToleranceValue(actualTime, requestedTime, SEEK_NOOP_EPSILON);
  }

  function isTimeBufferedValue(bufferedRanges, seconds) {
    if (captionUtils.isTimeBuffered) {
      return captionUtils.isTimeBuffered(
        bufferedRanges,
        seconds,
        SEEK_BUFFER_SAFETY_MARGIN
      );
    }

    return false;
  }

  function clearSeekConfirmationTimer(state) {
    if (state.seekConfirmationTimer) {
      window.clearTimeout(state.seekConfirmationTimer);
      state.seekConfirmationTimer = 0;
    }
  }

  function getSeekConfirmationStatus(state, request, snapshot) {
    const current = snapshot || getSeekSnapshot(state);
    const visibleVideoAtTarget = isSeekWithinToleranceValue(
      current.videoCurrentTime,
      request.targetTime,
      SEEK_CONFIRM_TOLERANCE
    );
    if (visibleVideoAtTarget) {
      request.visibleVideoReachedTarget = true;
    }
    if (captionUtils.getSeekConfirmationPlan) {
      return captionUtils.getSeekConfirmationPlan(
        request.playerControlled === true,
        current.playerCurrentTime,
        current.videoCurrentTime,
        request.targetTime,
        SEEK_CONFIRM_TOLERANCE,
        {
          visibleVideoReachedTarget: request.visibleVideoReachedTarget === true,
          preSeekVideoTime: request.before.videoCurrentTime
        }
      );
    }

    const playerConfirmed = isSeekWithinToleranceValue(
      current.playerCurrentTime,
      request.targetTime,
      SEEK_CONFIRM_TOLERANCE
    );
    const videoConfirmed = isSeekWithinToleranceValue(
      current.videoCurrentTime,
      request.targetTime,
      SEEK_CONFIRM_TOLERANCE
    );
    const videoAvailable = current.videoCurrentTime !== null;
    return {
      playerConfirmed: playerConfirmed,
      videoConfirmed: videoConfirmed,
      visibleVideoReachedTarget: request.visibleVideoReachedTarget === true || videoConfirmed,
      snapback: false,
      confirmed: request.playerControlled === true
        ? playerConfirmed && (!videoAvailable || videoConfirmed)
        : videoAvailable
          ? videoConfirmed
          : playerConfirmed
    };
  }

  function getSeekDebugDetails(state, request, snapshot, details) {
    const current = snapshot || getSeekSnapshot(state);
    const confirmation = getSeekConfirmationStatus(state, request, current);
    const bridgeResult = request.bridgeResult;
    const playerStateKnown = request.seekCallCount > 0;
    const output = {
      rangeValue: request.rangeValue,
      requestedTime: request.targetTime,
      targetTime: request.targetTime,
      buffered: request.targetBuffered === true,
      playerFound: playerStateKnown
        ? request.playerFound === true
        : request.playerFound === true ||
          Boolean(bridgeResult && bridgeResult.playerFound === true) ||
          current.playerFound,
      playerSeekToAvailable: playerStateKnown
        ? request.playerSeekToAvailable === true
        : request.playerSeekToAvailable === true ||
          Boolean(bridgeResult && bridgeResult.seekToAvailable === true) ||
          current.playerSeekToAvailable,
      playerAssociated: Boolean(bridgeResult && bridgeResult.playerAssociated === true),
      videoAssociated: Boolean(bridgeResult && bridgeResult.videoAssociated === true),
      usedVideoFallback: Boolean(bridgeResult && bridgeResult.usedVideoFallback === true),
      stage: request.stage || 'pending',
      allowSeekAhead: typeof request.allowSeekAhead === 'boolean'
        ? request.allowSeekAhead
        : null,
      videoCurrentTimeBefore: request.before.videoCurrentTime,
      videoCurrentTimeAfter: current.videoCurrentTime,
      bridgeVideoCurrentTimeBefore: bridgeResult
        ? bridgeResult.videoCurrentTimeBefore
        : null,
      bridgeVideoCurrentTimeAfter: bridgeResult
        ? bridgeResult.videoCurrentTimeAfter
        : null,
      playerCurrentTimeBefore: request.before.playerCurrentTime,
      playerCurrentTimeAfter: current.playerCurrentTime,
      videoDuration: current.videoDuration,
      metadataDuration: current.metadataDuration,
      bufferedRanges: current.bufferedRanges,
      requestId: request.requestId,
      source: request.source || 'unknown',
      sourceEventSequence: request.sourceEventSequence || null,
      interactionId: request.interactionId || 0,
      authoritativeCommitIndex: request.authoritativeCommitIndex || 0,
      controller: request.controller,
      playerConfirmed: confirmation.playerConfirmed,
      videoConfirmed: confirmation.videoConfirmed,
      visibleVideoReachedTarget: confirmation.visibleVideoReachedTarget,
      confirmed: confirmation.confirmed,
      pendingCleared: state.seekPending === false,
      timeout: false,
      snapbackDetected: false
    };
    return Object.assign(output, details || {});
  }

  function isPlayerSeekUsable(result) {
    return Boolean(result && result.ok === true && result.seekToAvailable === true &&
      result.playerAssociated === true);
  }

  function canFallbackToVideoSeek(result) {
    return !result || result.playerAssociated !== true || result.ok !== true;
  }

  function invokeDirectPlayerSeek(state, request, allowSeekAhead, stage) {
    if (!state.playerApi) {
      state.playerApi = getYoutubePlayerApi(state.video);
    }
    if (!state.playerApi || typeof state.playerApi.seekTo !== 'function') {
      return null;
    }

    const playerCurrentTimeBefore = readPlayerCurrentTime(state);
    try {
      forensicLog('SeekForensics', 'directPlayerSeekCall', {
        requestId: request.requestId,
        source: request.source,
        target: request.targetTime,
        stage: stage,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: playerCurrentTimeBefore,
        videoCurrentTimeBefore: readVideoCurrentTime(state)
      });
      state.playerApi.seekTo(request.targetTime, allowSeekAhead === true);
      const result = {
        ok: true,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        targetTime: request.targetTime,
        playerCurrentTimeBefore: playerCurrentTimeBefore,
        playerCurrentTimeAfter: readPlayerCurrentTime(state),
        direct: true,
        stage: stage
      };
      forensicLog('SeekForensics', 'directPlayerSeekReturn', {
        requestId: request.requestId,
        source: request.source,
        target: request.targetTime,
        stage: stage,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: playerCurrentTimeBefore,
        playerCurrentTimeAfter: result.playerCurrentTimeAfter,
        videoCurrentTimeAfter: readVideoCurrentTime(state),
        ok: true
      });
      return result;
    } catch (error) {
      reportError('seek-player-direct', error);
      const failedResult = {
        ok: false,
        available: true,
        playerFound: true,
        seekToAvailable: true,
        targetTime: request.targetTime,
        playerCurrentTimeBefore: playerCurrentTimeBefore,
        playerCurrentTimeAfter: readPlayerCurrentTime(state),
        direct: true,
        stage: stage
      };
      forensicLog('SeekForensics', 'directPlayerSeekReturn', {
        requestId: request.requestId,
        source: request.source,
        target: request.targetTime,
        stage: stage,
        allowSeekAhead: allowSeekAhead === true,
        playerCurrentTimeBefore: playerCurrentTimeBefore,
        playerCurrentTimeAfter: failedResult.playerCurrentTimeAfter,
        videoCurrentTimeAfter: readVideoCurrentTime(state),
        ok: false,
        errorName: error && error.name ? error.name : 'UnknownError'
      });
      return failedResult;
    }
  }

  function requestPlayerSeek(state, request, allowSeekAhead, stage) {
    request.stage = stage;
    request.allowSeekAhead = allowSeekAhead === true;
    const payload = {
      videoId: state.videoId,
      videoAssociationId: state.seekAssociationId,
      seconds: request.targetTime,
      allowSeekAhead: request.allowSeekAhead
    };
    if (DEBUG_LOGGING) {
      payload.debugRequestId = request.requestId;
      payload.debugSource = request.source;
      payload.debugStage = stage;
    }

    debugLog('Seek', 'playerSeekRequest', getSeekDebugDetails(
      state,
      request,
      getSeekSnapshot(state),
      {
        bridgeOk: false,
        seekCallIndex: request.seekCallCount + 1
      }
    ));
    forensicLog('SeekForensics', 'bridgeSeekSent', getSeekDebugDetails(
      state,
      request,
      getSeekSnapshot(state),
      {
        bridgeOk: false,
        seekCallIndex: request.seekCallCount + 1
      }
    ));

    return requestPageBridge('seek-preview', payload, PAGE_BRIDGE_TIMEOUT_MS)
      .catch(function (error) {
        reportError('seek-bridge', error);
        return null;
      })
      .then(function (result) {
        if (!isCurrentSeekRequest(state, request.requestId)) {
          forensicLog('SeekForensics', 'bridgeResponseIgnored', {
            requestId: request.requestId,
            source: request.source,
            target: request.targetTime,
            stage: stage,
            reason: 'superseded-or-overlay-closed',
            activeSeekRequestId: state.seekRequestId
          });
          return null;
        }
        forensicLog('SeekForensics', 'bridgeResponseReceived', {
          requestId: request.requestId,
          source: request.source,
          target: request.targetTime,
          stage: stage,
          allowSeekAhead: allowSeekAhead === true,
          responsePresent: Boolean(result),
          bridgeOk: Boolean(result && result.ok === true),
          playerFound: Boolean(result && result.playerFound === true),
          seekToAvailable: Boolean(result && result.seekToAvailable === true),
          bridgeTargetTime: result ? result.targetTime : null,
          bridgePlayerCurrentTimeBefore: result
            ? result.playerCurrentTimeBefore
            : null,
          bridgePlayerCurrentTimeAfter: result
            ? result.playerCurrentTimeAfter
            : null,
          mediaAtReceipt: getSeekSnapshot(state)
        });
        request.seekCallCount += 1;
        request.bridgeResult = result;
        request.playerFound = Boolean(result && result.playerFound === true);
        request.playerSeekToAvailable = Boolean(
          result && result.seekToAvailable === true
        );
        const after = getSeekSnapshot(state);
        debugLog('Seek', 'playerSeekResult', getSeekDebugDetails(
          state,
          request,
          after,
          {
            bridgeOk: Boolean(result && result.ok === true),
            seekCallIndex: request.seekCallCount,
            bridgePlayerCurrentTimeBefore: result
              ? result.playerCurrentTimeBefore
              : null,
            bridgePlayerCurrentTimeAfter: result
              ? result.playerCurrentTimeAfter
              : null
          }
        ));
        forensicLog('SeekForensics', 'bridgeSeekResult', getSeekDebugDetails(
          state,
          request,
          after,
          {
            bridgeOk: Boolean(result && result.ok === true),
            bridgeResponsePresent: Boolean(result),
            seekCallIndex: request.seekCallCount,
            bridgePlayerCurrentTimeBefore: result
              ? result.playerCurrentTimeBefore
              : null,
            bridgePlayerCurrentTimeAfter: result
              ? result.playerCurrentTimeAfter
              : null
          }
        ));
        return result;
      });
  }

  function restoreSeekPlaybackState(state, wasPaused) {
    if (wasPaused) {
      if (!state.video.paused) {
        pauseVideoSafely(state);
      }
      return;
    }

    if (state.video.paused && !state.video.ended && !state.userPaused) {
      schedulePreviewPlayback(state, 0);
    }
  }

  function finishSeekRequest(state, request, confirmed, reason) {
    if (!isCurrentSeekRequest(state, request.requestId)) {
      return;
    }

    clearSeekConfirmationTimer(state);
    const after = getSeekSnapshot(state);
    const confirmation = getSeekConfirmationStatus(state, request, after);
    const finalConfirmed = confirmation.confirmed;
    const snapbackDetected = confirmation.snapback === true;
    state.seekPending = false;
    state.seekDragging = false;
    state.pendingSeekTime = null;
    state.seekConfirmationCheck = null;
    debugLog('Seek', 'confirmation', getSeekDebugDetails(
      state,
      request,
      after,
      {
        confirmed: finalConfirmed,
        reason: reason,
        pendingCleared: true,
        timeout: /timeout$/.test(String(reason || '')),
        snapbackDetected: snapbackDetected
      }
    ));
    forensicLog('SeekForensics', 'pendingCleared', getSeekDebugDetails(
      state,
      request,
      after,
      {
        confirmedArgument: confirmed === true,
        confirmed: finalConfirmed,
        reason: reason,
        pendingCleared: true,
        timeout: /timeout$/.test(String(reason || '')),
        snapbackDetected: snapbackDetected
      }
    ));
    state.seekActiveForensicRequest = null;
    scheduleVideoControlUpdate(state);

    if (finalConfirmed && request.restorePlayback !== false) {
      restoreSeekPlaybackState(state, request.wasPaused);
    }
  }

  function applyVideoFallbackSeek(state, request, reason) {
    if (request.videoFallbackIssued) {
      return request.videoFallbackApplied === true;
    }
    if (request.playerControlled === true) {
      return false;
    }

    request.videoFallbackIssued = true;
    const applied = setVideoPropertySafely(
      state,
      'currentTime',
      request.targetTime
    );
    request.videoFallbackApplied = applied;
    debugLog('Seek', 'videoFallback', getSeekDebugDetails(
      state,
      request,
      getSeekSnapshot(state),
      {
        correctionReason: reason,
        applied: applied,
        videoFallbackIssued: request.videoFallbackIssued,
        pendingCleared: false
      }
    ));
    forensicLog('SeekForensics', 'videoFallback', getSeekDebugDetails(
      state,
      request,
      getSeekSnapshot(state),
      {
        correctionReason: reason,
        applied: applied,
        videoFallbackIssued: request.videoFallbackIssued,
        pendingCleared: false
      }
    ));
    return applied;
  }

  function confirmSeekRequest(state, request) {
    const deadline = Date.now() + SEEK_CONFIRM_TIMEOUT_MS;

    const check = function () {
      if (!isCurrentSeekRequest(state, request.requestId)) {
        return;
      }
      clearSeekConfirmationTimer(state);

      const current = getSeekSnapshot(state);
      const confirmation = getSeekConfirmationStatus(state, request, current);
      const currentConfirmed = confirmation.confirmed;
      debugLog('Seek', 'confirmationPoll', getSeekDebugDetails(
        state,
        request,
        current,
        {
          pendingCleared: false,
          timeout: false,
          snapbackDetected: confirmation.snapback === true
        }
      ));
      forensicLog('SeekForensics', 'confirmationPoll', getSeekDebugDetails(
        state,
        request,
        current,
        {
          pendingCleared: false,
          timeout: false,
          snapbackDetected: confirmation.snapback === true
        }
      ));
      if (confirmation.snapback || currentConfirmed || Date.now() >= deadline) {
        finishSeekRequest(
          state,
          request,
          currentConfirmed,
          confirmation.snapback
            ? 'snapback'
            : currentConfirmed
            ? 'confirmed'
            : 'timeout'
        );
        return;
      }

      state.seekConfirmationTimer = window.setTimeout(check, SEEK_CONFIRM_POLL_MS);
    };

    state.seekConfirmationCheck = check;
    check();
  }

  function waitForSeekPrecision(state, request) {
    const deadline = Date.now() + SEEK_PRECISION_TIMEOUT_MS;

    const check = function () {
      if (!isCurrentSeekRequest(state, request.requestId)) {
        return;
      }
      clearSeekConfirmationTimer(state);
      const snapshot = getSeekSnapshot(state);
      const targetBuffered = isTimeBufferedValue(
        snapshot.bufferedRanges,
        request.targetTime
      );
      debugLog('Seek', 'precisionStage', getSeekDebugDetails(
        state,
        request,
        snapshot,
        {
          buffered: targetBuffered,
          targetBuffered: targetBuffered,
          precisionSeekIssued: request.precisionSeekIssued,
          pendingCleared: false
        }
      ));
      forensicLog('SeekForensics', 'precisionStagePoll', getSeekDebugDetails(
        state,
        request,
        snapshot,
        {
          buffered: targetBuffered,
          targetBuffered: targetBuffered,
          precisionSeekIssued: request.precisionSeekIssued,
          pendingCleared: false
        }
      ));

      if (targetBuffered) {
        if (request.precisionSeekIssued) {
          return;
        }
        request.precisionSeekIssued = true;
        request.controller = 'player-precision';
        const precisionPlan = captionUtils.getSeekExecutionPlan
          ? captionUtils.getSeekExecutionPlan(false, true)[1]
          : { stage: 'precision-player-seek', allowSeekAhead: false };
        requestPlayerSeek(
          state,
          request,
          precisionPlan.allowSeekAhead,
          precisionPlan.stage
        )
          .then(function (result) {
            if (!isCurrentSeekRequest(state, request.requestId)) {
              return;
            }

            if (!isPlayerSeekUsable(result)) {
              finishSeekRequest(
                state,
                request,
                false,
                result && result.playerFound === true &&
                  result.seekToAvailable === true
                  ? 'precision-player-seek-failed'
                  : 'precision-player-unavailable'
              );
              return;
            }

            request.precisionCorrectionApplied = true;
            debugLog('Seek', 'precisionCommit', getSeekDebugDetails(
              state,
              request,
              getSeekSnapshot(state),
              {
                bridgeOk: true,
                precisionSeekIssued: request.precisionSeekIssued,
                precisionCorrectionApplied: request.precisionCorrectionApplied,
                pendingCleared: false
              }
            ));
            forensicLog('SeekForensics', 'precisionCommit', getSeekDebugDetails(
              state,
              request,
              getSeekSnapshot(state),
              {
                bridgeOk: true,
                precisionSeekIssued: request.precisionSeekIssued,
                precisionCorrectionApplied: request.precisionCorrectionApplied,
                pendingCleared: false
              }
            ));
            confirmSeekRequest(state, request);
          })
          .catch(function (error) {
            if (!isCurrentSeekRequest(state, request.requestId)) {
              return;
            }
            reportError('seek-precision-player', error);
            finishSeekRequest(state, request, false, 'precision-player-error');
          });
        return;
      }

      if (Date.now() >= deadline) {
        finishSeekRequest(state, request, false, 'precision-timeout');
        return;
      }

      state.seekConfirmationTimer = window.setTimeout(check, SEEK_CONFIRM_POLL_MS);
    };

    state.seekConfirmationCheck = check;
    check();
  }

  function seekPreviewTo(state, requestedTime, options) {
    if (!state.video || !state.video.isConnected) {
      return false;
    }

    const duration = getPreviewDuration(state);
    if (!duration) {
      return false;
    }

    const numericTime = Number(requestedTime);
    const before = getSeekSnapshot(state);
    const currentTimeForPlan = before.videoCurrentTime !== null
      ? before.videoCurrentTime
      : before.playerCurrentTime;
    const seekPlan = captionUtils.getSeekCommitPlan
      ? captionUtils.getSeekCommitPlan(
        currentTimeForPlan,
        numericTime,
        duration,
        SEEK_NOOP_EPSILON
      )
      : {
        targetTime: clampSeekTimeValue(numericTime, duration),
        shouldSeek: !isSeekNoOpValue(currentTimeForPlan, numericTime)
      };
    const targetTime = seekPlan.targetTime;
    const rangeValue = options && options.rangeValue !== undefined
      ? options.rangeValue
      : numericTime;
    const source = options && typeof options.source === 'string'
      ? options.source.slice(0, 80)
      : 'unknown';
    const wasPaused = state.video.paused || state.video.ended;
    const requestId = ++state.seekRequestId;
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekDragging = false;
    state.seekPending = true;
    state.pendingSeekTime = targetTime;
    const request = {
      requestId: requestId,
      source: source,
      sourceEventSequence: options && Number.isFinite(Number(options.eventSequence))
        ? Number(options.eventSequence)
        : null,
      interactionId: options && Number.isFinite(Number(options.interactionId))
        ? Number(options.interactionId)
        : state.seekInteractionId,
      authoritativeCommitIndex: ++state.seekAuthoritativeCommitCount,
      rangeValue: Number.isFinite(Number(rangeValue)) ? Number(rangeValue) : null,
      targetTime: targetTime,
      before: before,
      wasPaused: wasPaused,
      controller: 'pending',
      bridgeResult: null,
      playerControlled: false,
      playerFound: before.playerFound,
      playerSeekToAvailable: before.playerSeekToAvailable,
      seekCallCount: 0,
      targetBuffered: isTimeBufferedValue(before.bufferedRanges, targetTime),
      stage: 'pending',
      allowSeekAhead: null,
      precisionSeekIssued: false,
      precisionCorrectionApplied: false,
      videoFallbackIssued: false,
      videoFallbackApplied: false,
      visibleVideoReachedTarget: false,
      restorePlayback: true
    };
    state.seekLastCommitSource = source;
    state.seekActiveForensicRequest = request;

    scheduleVideoControlUpdate(state);
    forensicLog('SeekForensics', 'authoritativeCommitCreated', getSeekDebugDetails(
      state,
      request,
      before,
      {
        inputRequestedTime: numericTime,
        shouldSeek: seekPlan.shouldSeek,
        pendingCleared: false
      }
    ));

    if (!seekPlan.shouldSeek || isSeekNoOpValue(currentTimeForPlan, targetTime)) {
      request.restorePlayback = false;
      finishSeekRequest(state, request, true, 'no-op');
      return true;
    }

    debugLog('Seek', 'request', getSeekDebugDetails(
      state,
      request,
      before,
      { pendingCleared: false }
    ));
    forensicLog('SeekForensics', 'requestLifecycleStarted', getSeekDebugDetails(
      state,
      request,
      before,
      { pendingCleared: false }
    ));

    const playerExecutionPlan = captionUtils.getSeekExecutionPlan
      ? captionUtils.getSeekExecutionPlan(request.targetBuffered, true)
      : [{
        stage: request.targetBuffered
          ? 'buffered-player-seek'
          : 'unbuffered-load-seek',
        allowSeekAhead: !request.targetBuffered
      }];
    const initialPlayerStage = playerExecutionPlan[0];
    requestPlayerSeek(
      state,
      request,
      initialPlayerStage.allowSeekAhead,
      initialPlayerStage.stage
    )
      .then(function (result) {
        if (!isCurrentSeekRequest(state, requestId)) {
          return;
        }

        if (result && result.ok === true && result.usedVideoFallback === true &&
          result.videoAssociated === true) {
          request.controller = 'video-associated-fallback';
          confirmSeekRequest(state, request);
          return;
        }

        if (isPlayerSeekUsable(result)) {
          request.playerControlled = true;
          request.controller = request.targetBuffered
            ? 'player-buffered'
            : 'player-load';
          debugLog('Seek', 'commit', getSeekDebugDetails(
            state,
            request,
            getSeekSnapshot(state),
            {
              bridgeOk: true,
              pendingCleared: false
            }
          ));
          forensicLog('SeekForensics', 'playerCommitAccepted', getSeekDebugDetails(
            state,
            request,
            getSeekSnapshot(state),
            {
              bridgeOk: true,
              pendingCleared: false
            }
          ));
          if (!request.targetBuffered) {
            waitForSeekPrecision(state, request);
          } else {
            confirmSeekRequest(state, request);
          }
          return;
        }

        if (!canFallbackToVideoSeek(result)) {
          request.controller = 'player-failed';
          finishSeekRequest(state, request, false, 'player-seek-failed');
          return;
        }

        request.controller = request.targetBuffered
          ? 'video-fallback-buffered'
          : 'video-fallback';
        const applied = applyVideoFallbackSeek(state, request, result
          ? 'player-unavailable'
          : 'bridge-unavailable');
        debugLog('Seek', 'commit', getSeekDebugDetails(
          state,
          request,
          getSeekSnapshot(state),
          {
            bridgeOk: false,
            applied: applied,
            pendingCleared: false
          }
        ));
        forensicLog('SeekForensics', 'videoFallbackCommit', getSeekDebugDetails(
          state,
          request,
          getSeekSnapshot(state),
          {
            bridgeOk: false,
            applied: applied,
            pendingCleared: false
          }
        ));
        if (!applied) {
          finishSeekRequest(state, request, false, 'apply-failed');
          return;
        }
        confirmSeekRequest(state, request);
      })
      .catch(function (error) {
        if (!isCurrentSeekRequest(state, requestId)) {
          return;
        }

        reportError('seek-player-request', error);
        request.controller = 'video-fallback';
        const applied = applyVideoFallbackSeek(state, request, 'player-request-error');
        if (!applied) {
          finishSeekRequest(state, request, false, 'apply-failed');
          return;
        }
        confirmSeekRequest(state, request);
      });

    return true;
  }

  function readSeekInputTarget(state) {
    return clampSeekTimeValue(
      Number(state.controls.seekInput.value),
      getPreviewDuration(state)
    );
  }

  function updatePointerSeekTarget(state, event) {
    if (!state.seekDragging || !event || !Number.isFinite(Number(event.clientX))) {
      return null;
    }
    if (state.seekPointerId !== null && Number.isFinite(event.pointerId) &&
      event.pointerId !== state.seekPointerId) {
      return null;
    }
    const position = getTimelineHoverPosition(state, Number(event.clientX));
    if (!position || !Number.isFinite(position.seconds)) {
      return null;
    }
    state.seekPointerTarget = position.seconds;
    state.pendingSeekTime = position.seconds;
    return position;
  }

  function beginSeekInteraction(state, event, source) {
    const previousState = getSeekInteractionStateSnapshot(state);
    if (state.seekActiveForensicRequest) {
      forensicLog('SeekForensics', 'requestSuperseded', {
        requestId: state.seekActiveForensicRequest.requestId,
        source: state.seekActiveForensicRequest.source,
        target: state.seekActiveForensicRequest.targetTime,
        reason: 'new-seek-interaction',
        stateBeforeClear: previousState
      });
      state.seekActiveForensicRequest = null;
    }
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekRequestId += 1;
    state.seekInteractionId += 1;
    state.seekCommittedInteractionId = 0;
    state.seekDragging = true;
    state.seekPending = true;
    state.seekPointerTarget = null;
    state.pendingSeekTime = readSeekInputTarget(state);
    state.seekPointerId = event && Number.isFinite(event.pointerId)
      ? event.pointerId
      : null;
    state.seekLastInteractionSource = String(source || 'unknown').slice(0, 80);
    if (event && event.type === 'pointerdown') {
      state.seekForensicGestureActive = true;
      updatePointerSeekTarget(state, event);
    }
    scheduleVideoControlUpdate(state);
    forensicLog('SeekForensics', 'interactionBegan', {
      source: state.seekLastInteractionSource,
      eventSequence: getSeekForensicEventSequence(state, event),
      eventType: event && event.type ? event.type : 'synthetic',
      range: getSeekRangeSnapshot(state),
      previousState: previousState,
      state: getSeekInteractionStateSnapshot(state),
      media: getSeekSnapshot(state)
    });
  }

  function commitSeekInteraction(state, event, source) {
    const commitSource = String(source || 'unknown').slice(0, 80);
    if (!state.seekDragging && !state.seekPending) {
      beginSeekInteraction(state, event || null, commitSource + '-implicit-begin');
    }

    const inputPlan = captionUtils.getPointerSeekInputPlan
      ? captionUtils.getPointerSeekInputPlan(
        state.seekPointerId !== null,
        state.seekPointerTarget,
        readSeekInputTarget(state)
      )
      : { targetTime: state.pendingSeekTime, source: 'pending' };
    const targetTime = Number.isFinite(Number(inputPlan.targetTime))
      ? inputPlan.targetTime
      : readSeekInputTarget(state);
    state.pendingSeekTime = targetTime;
    state.seekDragging = false;
    const shouldCommit = captionUtils.shouldCommitSeekInteraction
      ? captionUtils.shouldCommitSeekInteraction(
        state.seekInteractionId,
        state.seekCommittedInteractionId
      )
      : state.seekCommittedInteractionId !== state.seekInteractionId;
    if (!shouldCommit) {
      state.seekPointerId = null;
      logSeekForensicAction(state, event, 'ignored-duplicate-commit', {
        source: commitSource,
        target: targetTime,
        interactionId: state.seekInteractionId
      });
      return;
    }

    state.seekCommittedInteractionId = state.seekInteractionId;
    state.seekPointerId = null;
    state.seekPointerTarget = null;
    logSeekForensicAction(state, event, 'authoritative-commit-requested', {
      source: commitSource,
      target: targetTime,
      targetSource: inputPlan.source,
      interactionId: state.seekInteractionId
    });
    seekPreviewTo(state, targetTime, {
      rangeValue: targetTime,
      source: commitSource,
      eventSequence: getSeekForensicEventSequence(state, event),
      interactionId: state.seekInteractionId
    });
  }

  function cancelSeekInteraction(state, event, source) {
    const previousState = getSeekInteractionStateSnapshot(state);
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekRequestId += 1;
    state.seekDragging = false;
    state.seekPending = false;
    state.pendingSeekTime = null;
    state.seekConfirmationCheck = null;
    state.seekPointerId = null;
    state.seekPointerTarget = null;
    state.seekActiveForensicRequest = null;
    scheduleVideoControlUpdate(state);
    logSeekForensicAction(state, event, 'interaction-cancelled', {
      source: String(source || 'unknown').slice(0, 80),
      previousState: previousState
    });
    forensicLog('SeekForensics', 'pendingCleared', {
      requestId: previousState.seekRequestId,
      source: String(source || 'unknown').slice(0, 80),
      target: previousState.pendingSeekTime,
      reason: 'cancelled',
      pendingCleared: true,
      stateBeforeClear: previousState,
      stateAfterClear: getSeekInteractionStateSnapshot(state),
      mediaAfterClear: getSeekSnapshot(state)
    });
  }

  function seekVideoBy(state, amount, options) {
    if (!state.video || !state.video.isConnected) {
      return;
    }

    const duration = getPreviewDuration(state);
    if (!duration) {
      return;
    }

    const playerTime = readPlayerCurrentTime(state);
    const videoTime = readVideoCurrentTime(state);
    const currentTime = playerTime !== null ? playerTime : videoTime;
    if (currentTime === null) {
      return;
    }

    seekPreviewTo(state, currentTime + Number(amount || 0), {
      rangeValue: currentTime + Number(amount || 0),
      source: options && options.source ? options.source : 'overlay-keyboard',
      eventSequence: options && options.event
        ? getSeekForensicEventSequence(state, options.event)
        : null,
      interactionId: state.seekInteractionId
    });
  }

  function togglePreviewPlayback(state) {
    if (!state.video || !state.video.isConnected) {
      return;
    }

    if (state.video.paused || state.video.ended) {
      state.userPaused = false;
      if (state.video.ended) {
        setVideoPropertySafely(state, 'currentTime', 0);
      }
      schedulePreviewPlayback(state, 4);
    } else {
      state.userPaused = true;
      if (state.playbackRetryTimer) {
        window.clearTimeout(state.playbackRetryTimer);
        state.playbackRetryTimer = 0;
      }
      pauseVideoSafely(state);
      updateVideoControls(state);
    }
  }

  function togglePreviewMute(state) {
    if (!state.video || !state.video.isConnected) {
      return;
    }

    const isMuted = state.video.muted || state.video.volume === 0;
    if (isMuted) {
      setVideoPropertySafely(state, 'muted', false);
      if (state.video.volume === 0) {
        setVideoPropertySafely(
          state,
          'volume',
          state.videoState.volume > 0 ? state.videoState.volume : 1
        );
      }
    } else {
      setVideoPropertySafely(state, 'muted', true);
    }
    updateVideoControls(state);
  }

  function togglePreviewCaptions(state) {
    const tracks = getCaptionTracks(state.video);
    if (state.captionTrackElement && tracks.length) {
      toggleSyntheticCaptionTracks(state, tracks);
      return;
    }

    if (state.captionTogglePending) {
      return;
    }
    state.captionTogglePending = true;

    void toggleNativeCaptions(state).then(function (nativeResult) {
      if (activeOverlay !== state || nativeResult) {
        if (activeOverlay === state && nativeResult && nativeResult.ok !== true) {
          showPreviewNotice('YouTube captions could not be toggled.');
        }
        return;
      }

      return loadPreviewCaptions(state);
    }).catch(function (error) {
      reportError('caption-toggle', error);
    }).finally(function () {
      state.captionTogglePending = false;
    });
  }

  function clearQualityOptions(state) {
    state.qualityOptionCleanup.forEach(function (cleanup) {
      cleanup();
    });
    state.qualityOptionCleanup = [];

    while (state.controls.qualityMenu.firstChild) {
      state.controls.qualityMenu.removeChild(state.controls.qualityMenu.firstChild);
    }
    state.controls.qualityMenu.hidden = true;
    state.controls.qualityButton.setAttribute('aria-expanded', 'false');
  }

  async function setPreviewQuality(state, level) {
    const requestedLevel = normalizeQualityLevel(level);
    if (!/^[a-z0-9_-]{1,32}$/.test(requestedLevel)) {
      return;
    }

    const availableLevels = state.qualityInfo && Array.isArray(state.qualityInfo.levels)
      ? state.qualityInfo.levels.map(normalizeQualityLevel)
      : [];
    if (requestedLevel !== 'auto' && availableLevels.length &&
      !availableLevels.includes(requestedLevel) &&
      normalizeQualityLevel(state.qualityInfo.current) !== requestedLevel) {
      return;
    }

    const bridgeResult = await requestPageBridge('set-quality', {
      videoId: state.videoId,
      level: requestedLevel
    });

    if (activeOverlay !== state) {
      return;
    }

    if (bridgeResult && bridgeResult.ok) {
      state.qualityInfo = Object.assign({}, state.qualityInfo || {}, {
        current: normalizeQualityLevel(bridgeResult.current || requestedLevel)
      });
      state.controls.qualityButton.title = 'Video quality: ' + qualityLabel(requestedLevel);
      setButtonIcon(state.controls.qualityButton, 'settings');
      state.controls.qualityMenu.hidden = true;
      state.controls.qualityButton.setAttribute('aria-expanded', 'false');
      window.setTimeout(function () {
        if (activeOverlay === state) {
          void refreshQualityMenu(state, 0).catch(function (error) {
            reportError('quality-refresh-after-set', error);
          });
        }
      }, 350);
      return;
    }

    const api = state.playerApi || getYoutubePlayerApi(state.video);
    state.playerApi = api;

    if (!api || (typeof api.setPlaybackQualityRange !== 'function' &&
      typeof api.setPlaybackQuality !== 'function')) {
      showPreviewNotice('Quality control is unavailable for this preview.');
      return;
    }

    try {
      const apiLevel = requestedLevel === 'auto' ? 'default' : requestedLevel;
      if (typeof api.setPlaybackQualityRange === 'function') {
        api.setPlaybackQualityRange(apiLevel);
      }
      if (typeof api.setPlaybackQuality === 'function') {
        api.setPlaybackQuality(apiLevel);
      }
      state.controls.qualityButton.title = 'Video quality: ' + qualityLabel(requestedLevel);
      setButtonIcon(state.controls.qualityButton, 'settings');
      state.controls.qualityMenu.hidden = true;
      state.controls.qualityButton.setAttribute('aria-expanded', 'false');
      state.qualityInfo = Object.assign({}, state.qualityInfo || {}, {
        current: requestedLevel
      });
      window.setTimeout(function () {
        if (activeOverlay === state) {
          void refreshQualityMenu(state, 0).catch(function (error) {
            reportError('quality-refresh-after-direct-set', error);
          });
        }
      }, 350);
    } catch (error) {
      reportError('quality-set', error);
      showPreviewNotice('Quality control is unavailable for this preview.');
    }
  }

  async function refreshQualityMenu(state, remainingAttempts) {
    if (activeOverlay !== state) {
      return;
    }

    const bridgeInfo = await requestPageBridge('quality-info', { videoId: state.videoId });
    if (activeOverlay !== state) {
      return;
    }

    const directLevels = getQualityLevels(state);
    const directCanSet = state.playerApi &&
      (typeof state.playerApi.setPlaybackQualityRange === 'function' ||
        typeof state.playerApi.setPlaybackQuality === 'function');
    const bridgeCanSet = bridgeInfo && bridgeInfo.canSet !== false &&
      Array.isArray(bridgeInfo.levels);
    const levels = bridgeCanSet && bridgeInfo.levels.length
      ? bridgeInfo.levels
      : directLevels;
    const canSetQuality = bridgeCanSet && bridgeInfo.levels.length
      ? Boolean(bridgeInfo.canSet)
      : Boolean(directCanSet);

    if (!levels.length || !canSetQuality) {
      state.controls.qualityButton.disabled = true;
      state.controls.qualityButton.title = 'Quality control is unavailable for this preview';

      if (remainingAttempts > 0) {
        state.qualityRetryTimer = window.setTimeout(function () {
          state.qualityRetryTimer = 0;
          void refreshQualityMenu(state, remainingAttempts - 1).catch(function (error) {
            reportError('quality-retry', error);
          });
        }, QUALITY_RETRY_DELAY_MS);
      }
      return;
    }

    state.qualityInfo = bridgeCanSet && bridgeInfo.levels.length
      ? bridgeInfo
      : { levels: levels, canSet: canSetQuality, current: 'auto' };

    let currentLevel = state.qualityInfo.current || 'auto';
    if (!bridgeCanSet || !bridgeInfo.levels.length) {
      try {
        if (state.playerApi && typeof state.playerApi.getPlaybackQuality === 'function') {
          currentLevel = state.playerApi.getPlaybackQuality() || 'auto';
        }
      } catch (error) {
        reportError('quality-read-current', error);
      }
    }
    currentLevel = normalizeQualityLevel(currentLevel);
    state.qualityInfo.current = currentLevel;

    clearQualityOptions(state);
    const orderedLevels = Array.from(new Set(['auto'].concat(levels, currentLevel))).filter(function (level, index, all) {
      return level !== 'default' || !all.includes('auto');
    });
    orderedLevels.forEach(function (level) {
      const option = document.createElement('button');
      option.type = 'button';
      const selected = isSameQualityLevel(level, currentLevel);
      option.className = QUALITY_OPTION_CLASS + (selected
        ? ' ' + QUALITY_OPTION_SELECTED_CLASS
        : '');
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(selected));
      option.dataset.qualityLevel = normalizeQualityLevel(level);
      const optionLabel = document.createElement('span');
      optionLabel.className = 'ytpm-overlay__quality-label';
      optionLabel.textContent = qualityLabel(level);
      const checkmark = document.createElement('span');
      checkmark.className = 'ytpm-overlay__quality-check';
      checkmark.setAttribute('aria-hidden', 'true');
      checkmark.textContent = '✓';
      option.appendChild(optionLabel);
      option.appendChild(checkmark);
      option.setAttribute('aria-label', 'Use ' + qualityLabel(level) + ' quality');
      registerListener(state.qualityOptionCleanup, option, 'click', function () {
        void setPreviewQuality(state, level).catch(function (error) {
          reportError('quality-option', error);
          if (activeOverlay === state) {
            showPreviewNotice('Quality control is unavailable for this preview.');
          }
        });
      });
      state.controls.qualityMenu.appendChild(option);
    });

    state.controls.qualityButton.disabled = false;
    state.controls.qualityButton.title = 'Video quality: ' + qualityLabel(currentLevel);
    setButtonIcon(state.controls.qualityButton, 'settings');
  }

  function togglePreviewFullscreen(state) {
    if (document.fullscreenElement) {
      try {
        const exitPromise = document.exitFullscreen && document.exitFullscreen();
        if (exitPromise && typeof exitPromise.catch === 'function') {
          exitPromise.catch(function () {});
        }
      } catch (error) {
        showPreviewNotice('Fullscreen is unavailable in this browser.');
      }
      return;
    }

    if (typeof state.elements.frame.requestFullscreen !== 'function') {
      showPreviewNotice('Fullscreen is unavailable in this browser.');
      return;
    }

    try {
      const fullscreenPromise = state.elements.frame.requestFullscreen();
      if (fullscreenPromise && typeof fullscreenPromise.catch === 'function') {
        fullscreenPromise.catch(function () {
          showPreviewNotice('Fullscreen is unavailable in this browser.');
        });
      }
    } catch (error) {
      showPreviewNotice('Fullscreen is unavailable in this browser.');
    }
  }

  function bindVideoControls(state) {
    const videoEvents = [
      'play',
      'pause',
      'timeupdate',
      'seeking',
      'seeked',
      'durationchange',
      'loadedmetadata',
      'progress',
      'volumechange',
      'ended'
    ];

    videoEvents.forEach(function (eventName) {
      registerListener(state.videoControlCleanup, state.video, eventName, function (event) {
        const traceSeekMediaEvent = DEBUG_LOGGING && (
          state.seekPending || state.seekDragging ||
          eventName === 'seeking' || eventName === 'seeked'
        );
        if (traceSeekMediaEvent) {
          captureSeekForensicEvent(state, event);
        }
        if (eventName === 'seeking') {
          resetRollupCaptionHistory(state, 'video-seeking');
        }
        scheduleVideoControlUpdate(state);
        let confirmationCheckInvoked = false;
        if (state.seekPending && state.seekConfirmationCheck &&
          (eventName === 'timeupdate' || eventName === 'seeking' ||
            eventName === 'seeked')) {
          confirmationCheckInvoked = true;
          state.seekConfirmationCheck();
        }
        if (eventName === 'timeupdate' || eventName === 'seeking' ||
          eventName === 'seeked' || eventName === 'durationchange' ||
          eventName === 'loadedmetadata') {
          scheduleNativeCaptionMirrorUpdate(state);
        }
        if ((eventName === 'durationchange' || eventName === 'loadedmetadata') &&
          state.timelineHovering) {
          updateTimelinePreview(state, state.timelineHoverClientX);
        }
        if (traceSeekMediaEvent) {
          logSeekForensicAction(state, event, 'media-event-processed', {
            eventName: eventName,
            uiUpdateScheduled: true,
            confirmationCheckInvoked: confirmationCheckInvoked
          });
        }
      });
    });

    installSeekEventForensics(state);

    ['pointermove', 'mousemove', 'pointerenter', 'mouseenter', 'pointerdown', 'touchstart', 'focusin'].forEach(function (eventName) {
      registerListener(state.controlCleanup, state.elements.overlay, eventName, function () {
        showOverlayControls(state);
      });
      registerListener(state.controlCleanup, state.elements.frame, eventName, function () {
        showOverlayControls(state);
      });
    });
    registerListener(state.controlCleanup, state.elements.overlay, 'pointerleave', function () {
      scheduleOverlayControlsHide(state);
    });
    registerListener(state.controlCleanup, state.elements.frame, 'pointerleave', function () {
      scheduleOverlayControlsHide(state);
    });

    registerListener(state.controlCleanup, state.controls.playButton, 'click', function () {
      togglePreviewPlayback(state);
    });
    registerListener(state.controlCleanup, state.controls.muteButton, 'click', function () {
      togglePreviewMute(state);
    });
    registerListener(state.controlCleanup, state.controls.volumeInput, 'input', function () {
      const value = Number(state.controls.volumeInput.value);
      if (!Number.isFinite(value)) {
        return;
      }

      setVideoPropertySafely(state, 'volume', Math.max(0, Math.min(1, value)));
      setVideoPropertySafely(state, 'muted', value === 0);
      if (value > 0) {
        state.userPaused = false;
      }
      scheduleVideoControlUpdate(state);
    });
    registerListener(state.controlCleanup, state.controls.captionsButton, 'click', function () {
      togglePreviewCaptions(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointerenter', function (event) {
      updateTimelinePreview(state, event.clientX);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointermove', function (event) {
      updatePointerSeekTarget(state, event);
      updateTimelinePreview(state, event.clientX);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointerdown', function (event) {
      captureSeekForensicEvent(state, event);
      beginSeekInteraction(state, event, 'pointerdown');
      updateTimelinePreview(state, event.clientX);
      logSeekForensicAction(state, event, 'pending-stored', {
        source: 'pointerdown',
        target: state.pendingSeekTime,
        uiOnly: true
      });
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointerleave', function () {
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'focus', function () {
      updateTimelinePreview(state, null);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'blur', function (event) {
      captureSeekForensicEvent(state, event);
      if (state.seekDragging) {
        commitSeekInteraction(state, event, 'range-blur');
      } else {
        logSeekForensicAction(state, event, 'no-seek-action', {
          source: 'range-blur',
          reason: 'not-dragging'
        });
      }
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'input', function (event) {
      captureSeekForensicEvent(state, event);
      const previousPendingSeekTime = state.pendingSeekTime;
      if (!state.seekDragging) {
        beginSeekInteraction(state, event, 'range-input');
      }

      if (state.seekPointerId === null ||
        !Number.isFinite(Number(state.seekPointerTarget))) {
        state.pendingSeekTime = readSeekInputTarget(state);
      }
      state.seekPending = true;
      updateTimelinePreview(state, state.timelineHoverClientX);
      scheduleVideoControlUpdate(state);
      logSeekForensicAction(state, event, 'ui-preview-only', {
        source: 'range-input',
        previousPendingSeekTime: previousPendingSeekTime !== null &&
          previousPendingSeekTime !== undefined && previousPendingSeekTime !== '' &&
          Number.isFinite(Number(previousPendingSeekTime))
          ? Number(previousPendingSeekTime)
          : null,
        pendingSeekTime: state.pendingSeekTime,
        commitRequested: false
      });
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'change', function (event) {
      captureSeekForensicEvent(state, event);
      commitSeekInteraction(state, event, 'range-change');
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointercancel', function (event) {
      captureSeekForensicEvent(state, event);
      cancelSeekInteraction(state, event, 'pointercancel');
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, document, 'pointerup', function (event) {
      const eventPath = typeof event.composedPath === 'function'
        ? event.composedPath()
        : [];
      const targetsRange = event.target === state.controls.seekInput ||
        eventPath.includes(state.controls.seekInput);
      if (!state.seekDragging && !targetsRange) {
        return;
      }
      captureSeekForensicEvent(state, event);
      if (!state.seekDragging ||
        (state.seekPointerId !== null && Number.isFinite(event.pointerId) &&
          event.pointerId !== state.seekPointerId)) {
        logSeekForensicAction(state, event, 'pointerup-ignored', {
          source: 'pointerup',
          reason: !state.seekDragging ? 'not-dragging' : 'pointer-id-mismatch'
        });
        return;
      }
      updatePointerSeekTarget(state, event);
      commitSeekInteraction(state, event, 'pointerup');
    });
    registerListener(state.controlCleanup, state.controls.qualityButton, 'click', function () {
      showOverlayControls(state);
      if (!state.controls.qualityButton.disabled) {
        state.controls.qualityMenu.hidden = !state.controls.qualityMenu.hidden;
        state.controls.qualityButton.setAttribute(
          'aria-expanded',
          String(!state.controls.qualityMenu.hidden)
        );
      }
    });
      registerListener(state.controlCleanup, state.controls.fullscreenButton, 'click', function () {
        togglePreviewFullscreen(state);
      });
    registerListener(state.controlCleanup, document, 'fullscreenchange', function () {
      updateFullscreenControl(state);
    });

    if (state.video.textTracks && typeof state.video.textTracks.addEventListener === 'function') {
      registerListener(state.videoControlCleanup, state.video.textTracks, 'addtrack', function () {
        scheduleNativeCaptionMirrorUpdate(state);
        updateCaptionControl(state);
      });
      registerListener(state.videoControlCleanup, state.video.textTracks, 'change', function () {
        scheduleNativeCaptionMirrorUpdate(state);
        updateCaptionControl(state);
      });
    }

    updateVideoControls(state);
    showOverlayControls(state);
    refreshCaptionControl(state);
    void refreshQualityMenu(state, QUALITY_RETRY_LIMIT).catch(function (error) {
      reportError('quality-refresh', error);
    });
  }

  function lockPageScroll() {
    document.documentElement.classList.add(LOCK_CLASS);
    if (document.body) {
      document.body.classList.add(LOCK_CLASS);
    }
  }

  function unlockPageScroll() {
    document.documentElement.classList.remove(LOCK_CLASS);
    if (document.body) {
      document.body.classList.remove(LOCK_CLASS);
    }
  }

  function setPageInert(state) {
    if (!document.body) {
      return;
    }

    state.inertedElements = [];
    Array.from(document.body.children).forEach(function (element) {
      if (element === state.overlay) {
        return;
      }

      state.inertedElements.push({
        element: element,
        wasInert: Boolean(element.inert)
      });
      element.inert = true;
    });
  }

  function restorePageInert(state) {
    (state.inertedElements || []).forEach(function (entry) {
      if (entry.element && entry.element.isConnected) {
        entry.element.inert = entry.wasInert;
      }
    });
    state.inertedElements = [];
  }

  function restoreVideoToOrigin(state) {
    const video = state.video;
    const mediaRoot = state.mediaRoot || video;
    video.classList.remove(VIDEO_CLASS);

    if (!state.card.isConnected || !state.originParent || !state.originParent.isConnected) {
      try {
        video.pause();
      } catch (error) {
        reportError('restore-detached-video', error);
      }
      mediaRoot.remove();
      return false;
    }

    try {
      if (state.placeholder.isConnected) {
        state.placeholder.replaceWith(mediaRoot);
      } else {
        const nextSibling = state.originNextSibling &&
          state.originNextSibling.parentNode === state.originParent
          ? state.originNextSibling
          : null;
        state.originParent.insertBefore(mediaRoot, nextSibling);
      }

      restoreVideoState(video, state.videoState, { skipPlayback: true });
      return true;
    } catch (error) {
      reportError('restore-video-origin', error);
      mediaRoot.remove();
      return false;
    }
  }

  function closePreviewOverlay(options) {
    if (!activeOverlay) {
      return;
    }

    const settings = Object.assign({ restoreFocus: true }, options);
    const state = activeOverlay;
    disarmPreviewAdGuard(state, 'overlay-closed');
    const seekStateBeforeClose = getSeekInteractionStateSnapshot(state);
    const seekRequestBeforeClose = state.seekActiveForensicRequest;
    activeOverlay = null;

    window.removeEventListener('keydown', state.handleKeydown, true);
    state.overlay.removeEventListener('click', state.handleBackdropClick);
    state.closeButton.removeEventListener('click', state.handleCloseClick);
    if (state.video) {
      state.video.removeEventListener('pause', state.handleVideoInterruption);
      state.video.removeEventListener('emptied', state.handleVideoInterruption);
      state.video.removeEventListener('loadedmetadata', state.handleVideoInterruption);
    }

    if (state.playbackRetryTimer) {
      window.clearTimeout(state.playbackRetryTimer);
      state.playbackRetryTimer = 0;
    }

    if (state.qualityRetryTimer) {
      window.clearTimeout(state.qualityRetryTimer);
      state.qualityRetryTimer = 0;
    }

    if (state.controlsHideTimer) {
      window.clearTimeout(state.controlsHideTimer);
      state.controlsHideTimer = 0;
    }

    if (state.controlsFrame) {
      window.cancelAnimationFrame(state.controlsFrame);
      state.controlsFrame = 0;
    }

    state.seekRequestId += 1;
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekDragging = false;
    state.seekPending = false;
    state.pendingSeekTime = null;
    state.seekPointerId = null;
    state.seekPointerTarget = null;
    state.seekActiveForensicRequest = null;
    clearSeekAssociation(state);
    if (DEBUG_LOGGING && (
      seekStateBeforeClose.seekPending || seekStateBeforeClose.seekDragging ||
      seekRequestBeforeClose
    )) {
      forensicLog('SeekForensics', 'pendingCleared', {
        requestId: seekRequestBeforeClose
          ? seekRequestBeforeClose.requestId
          : seekStateBeforeClose.seekRequestId,
        source: seekRequestBeforeClose
          ? seekRequestBeforeClose.source
          : state.seekLastInteractionSource,
        target: seekRequestBeforeClose
          ? seekRequestBeforeClose.targetTime
          : seekStateBeforeClose.pendingSeekTime,
        reason: 'overlay-closed',
        pendingCleared: true,
        stateBeforeClear: seekStateBeforeClose,
        stateAfterClear: getSeekInteractionStateSnapshot(state),
        mediaAfterClear: getSeekSnapshot(state)
      });
    }
    hideTimelinePreview(state);
    state.captionRequestId += 1;
    disposeNativeCaptionMirror(state);
    state.controls.timelineImage.onload = null;
    state.controls.timelineImage.onerror = null;
    state.controls.timelineImage.removeAttribute('src');
    state.timelineDesiredUrl = '';
    state.timelineDisplayedUrl = '';

    state.controlCleanup.forEach(function (cleanup) {
      cleanup();
    });
    state.videoControlCleanup.forEach(function (cleanup) {
      cleanup();
    });
    clearQualityOptions(state);
    removeSyntheticCaptionTrack(state);

    const isPreviewFullscreen = document.fullscreenElement === state.elements.frame;
    if (isPreviewFullscreen &&
      typeof document.exitFullscreen === 'function') {
      try {
        const exitPromise = document.exitFullscreen();
        if (exitPromise && typeof exitPromise.catch === 'function') {
          exitPromise.catch(function () {});
        }
      } catch (error) {
        reportError('exit-fullscreen', error);
      }
    }

    // Stop the preview before returning it to YouTube. This prevents the
    // restored video from continuing to emit audio after the overlay closes.
    pauseVideoSafely(state);
    state.userPaused = true;

    if (state.video.isConnected) {
      state.videoState.currentTime = Number.isFinite(state.video.currentTime)
        ? state.video.currentTime
        : state.videoState.currentTime;
      state.videoState.muted = state.video.muted;
      state.videoState.volume = state.video.volume;
      state.videoState.playbackRate = state.video.playbackRate;
      state.videoState.paused = state.userPaused ||
        (state.video.paused && state.videoState.paused);
    }

    restoreVideoToOrigin(state);
    state.placeholder.remove();
    restorePageInert(state);
    state.overlay.remove();
    unlockPageScroll();

    if (historyNativeFallbackSession && historyNativeFallbackSession.card === state.card) {
      const fallbackCard = historyNativeFallbackSession.card;
      cleanupHistoryNativeFallback('overlay-closed');
      if (isNativeFallbackSurface(window.location.pathname) && fallbackCard.isConnected &&
        isThumbnailHovered(fallbackCard)) {
        lastHoveredCard = fallbackCard;
        queueHistoryNativeFallback(fallbackCard);
      }
    }

    if (settings.restoreFocus && state.previousFocus && state.previousFocus.isConnected) {
      try {
        state.previousFocus.focus({ preventScroll: true });
      } catch (error) {
        state.previousFocus.focus();
      }
    }
  }

  function openPreviewOverlay(card, preferredPreview, preferredVideo) {
    if (activeOverlay) {
      closePreviewOverlay({ restoreFocus: false });
    }

    const attemptId = ++previewAttemptId;

    const buttonPreview = previewButtonState && previewButtonState.card === card
      ? previewButtonState.preview
      : null;
    const discoveredPreview = findActivePreview(card);
    const previewHost = preferredPreview && preferredPreview.isConnected
      ? preferredPreview
      : buttonPreview && buttonPreview.isConnected
        ? buttonPreview
        : discoveredPreview && discoveredPreview.isConnected
          ? discoveredPreview
          : null;

    tryOpenPreview(
      card,
      attemptId,
      Date.now() + PREVIEW_LOOKUP_TIMEOUT_MS,
      previewHost,
      preferredVideo
    );
  }

  function tryOpenPreview(card, attemptId, deadline, preferredPreview, preferredVideo) {
    if (attemptId !== previewAttemptId || !card.isConnected) {
      return;
    }

    const video = findPreviewVideo(card, preferredPreview, preferredVideo);
    if (!isPreviewReady(video) || !video.parentNode) {
      if (Date.now() < deadline) {
        window.setTimeout(function () {
          tryOpenPreview(card, attemptId, deadline, preferredPreview, preferredVideo);
        }, PREVIEW_RETRY_DELAY_MS);
      } else {
        showPreviewNotice();
      }
      return;
    }

    mountPreviewOverlay(card, video);
  }

  function mountPreviewOverlay(card, video) {
    const previousFocus = document.activeElement && document.activeElement.isConnected
      ? document.activeElement
      : null;
    const mediaRoot = video;
    const originParent = mediaRoot.parentNode;
    const originNextSibling = mediaRoot.nextSibling;
    const placeholder = createPlaceholder(mediaRoot);
    const videoState = captureVideoState(video);
    const playerApi = getYoutubePlayerApi(video);
    const cardVideoKey = getCardVideoKey(card);
    const activePreview = findActivePreview(card) ||
      findComposedAncestor(video, 'ytd-video-preview');
    const previewVideoKey = activePreview ? getPreviewVideoKey(activePreview) : null;
    const elements = createOverlayElements();

    const state = {
      card: card,
      video: video,
      mediaRoot: mediaRoot,
      videoState: videoState,
      originParent: originParent,
      originNextSibling: originNextSibling,
      placeholder: placeholder,
      overlay: elements.overlay,
      closeButton: elements.closeButton,
      previousFocus: previousFocus,
      videoId: getVideoIdFromKey(cardVideoKey || previewVideoKey),
      generation: previewAttemptId,
      surface: 'overlay',
      adSessionId: createBridgeNonce(),
      adGuard: null,
      nativePreviewPlayer: null,
      elements: elements,
      controls: elements.controls,
      handleKeydown: null,
      handleBackdropClick: null,
      handleCloseClick: null,
      handleVideoInterruption: null,
      playbackRetryTimer: 0,
      qualityRetryTimer: 0,
      controlCleanup: [],
      videoControlCleanup: [],
      qualityOptionCleanup: [],
      playerApi: playerApi,
      seekAssociationId: '',
      seekAssociatedPlayerElement: null,
      nativePreview: activePreview,
      nativeCaptionObserver: null,
      nativePreviewObserver: null,
      nativePreviewObserved: null,
      nativeCaptionRenderer: null,
      nativeCaptionSyncTimer: 0,
      rollupLastGeometry: [],
      rollupAtomicContext: null,
      captionCommittedText: '',
      captionVisualText: '',
      captionPreviousText: '',
      captionIncomingText: '',
      captionTransitionToken: 0,
      captionTransitionRaf: 0,
      captionTransitionTimer: 0,
      captionTransition: null,
      captionPreviewToken: 0,
      captionPreviewRaf: 0,
      nativeCaptionState: null,
      nativeCaptionText: '',
      captionGeneration: 0,
      captionActiveWindows: new Set(),
      captionWindowGenerations: new Map(),
      captionLastMutationDebug: null,
      captionLastForensicSnapshot: null,
      captionLastVisualClear: null,
      captionInfo: null,
      captionCatalog: null,
      captionCatalogLoaded: false,
      captionCatalogRequest: null,
      duration: 0,
      storyboard: null,
      captionRequestId: 0,
      captionTogglePending: false,
      captionLoadPending: false,
      captionTrackElement: null,
      captionTrackLoadHandler: null,
      captionObjectUrl: '',
      captionTrackInfo: null,
      controlsHideTimer: 0,
      controlsFrame: 0,
      controlSnapshot: {
        playing: null,
        muted: null,
        fullscreen: null
      },
      timelineHovering: false,
      timelineHoverClientX: null,
      timelineHoverPosition: null,
      timelineHoverToken: 0,
      timelineMetadataRequest: null,
      timelineDesiredUrl: '',
      timelineDisplayedUrl: '',
      seekDragging: false,
      seekPending: false,
      pendingSeekTime: null,
      seekRequestId: 0,
      seekConfirmationTimer: 0,
      seekConfirmationCheck: null,
      seekInteractionId: 0,
      seekCommittedInteractionId: 0,
      seekPointerId: null,
      seekPointerTarget: null,
      seekAuthoritativeCommitCount: 0,
      seekLastInteractionSource: '',
      seekLastCommitSource: '',
      seekActiveForensicRequest: null,
      seekForensicEventSequence: 0,
      seekForensicEventIds: new WeakMap(),
      seekForensicCapturedEvents: new WeakSet(),
      seekForensicEventBefore: new WeakMap(),
      seekForensicGestureActive: false,
      inertedElements: [],
      userPaused: false
    };

    state.handleKeydown = function (event) {
      showOverlayControls(state);
      const key = String(event.key || '').toLowerCase();
      const code = String(event.code || '');
      const isEscape = event.key === 'Escape' || code === 'Escape';
      const isSpace = event.key === ' ' || event.key === 'Spacebar' || code === 'Space';
      const isArrowLeft = event.key === 'ArrowLeft' || code === 'ArrowLeft';
      const isArrowRight = event.key === 'ArrowRight' || code === 'ArrowRight';

      if (event.key === 'Tab') {
        const focusable = Array.from(state.overlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled])'
        ));

        if (!focusable.length) {
          event.preventDefault();
          return;
        }

        const currentIndex = focusable.indexOf(document.activeElement);
        if (currentIndex < 0) {
          event.preventDefault();
          (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
          return;
        }

        if (event.shiftKey && currentIndex === 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
          return;
        }

        if (!event.shiftKey && currentIndex === focusable.length - 1) {
          event.preventDefault();
          focusable[0].focus();
          return;
        }
      }

      if (isEscape) {
        event.preventDefault();
        event.stopPropagation();
        closePreviewOverlay();
        return;
      }

      if (isTextInputElement(event.target)) {
        return;
      }

      const isElementTarget = isElement(event.target);
      const isCloseTarget = isElementTarget && event.target.closest('.' + CLOSE_CLASS);
      const isActivationKey = isSpace || key === 'enter';
      if (isCloseTarget && isActivationKey) {
        return;
      }

      const isVolumeControl = event.target === state.controls.volumeInput;
      if (isVolumeControl && (isArrowLeft || isArrowRight)) {
        return;
      }

      if (isArrowLeft || isArrowRight) {
        event.preventDefault();
        event.stopPropagation();
        seekVideoBy(state, isArrowLeft ? -5 : 5, {
          source: 'overlay-keyboard',
          event: event
        });
      } else if (isSpace || key === 'k' || code === 'KeyK') {
        event.preventDefault();
        event.stopPropagation();
        togglePreviewPlayback(state);
      } else if (key === 'm' || code === 'KeyM') {
        event.preventDefault();
        event.stopPropagation();
        togglePreviewMute(state);
      } else if (key === 'c' || code === 'KeyC') {
        event.preventDefault();
        event.stopPropagation();
        togglePreviewCaptions(state);
      } else if (key === 'f' || code === 'KeyF') {
        event.preventDefault();
        event.stopPropagation();
        togglePreviewFullscreen(state);
      }
    };

    state.handleBackdropClick = function (event) {
      if (event.target === state.overlay) {
        closePreviewOverlay();
      }
    };

    state.handleCloseClick = function () {
      closePreviewOverlay();
    };

    state.handleVideoInterruption = function () {
      if (activeOverlay === state && !state.userPaused && !state.video.ended) {
        schedulePreviewPlayback(state, 4);
      }
    };

    try {
      markSeekAssociation(state);
      originParent.insertBefore(placeholder, mediaRoot);
      document.body.appendChild(elements.overlay);
      video.classList.add(VIDEO_CLASS);
      video.controls = false;
      elements.frame.insertBefore(video, elements.frame.firstChild);
      elements.closeButton.addEventListener('click', state.handleCloseClick);
      elements.overlay.addEventListener('click', state.handleBackdropClick);
      window.addEventListener('keydown', state.handleKeydown, true);
      video.addEventListener('pause', state.handleVideoInterruption);
      video.addEventListener('emptied', state.handleVideoInterruption);
      video.addEventListener('loadedmetadata', state.handleVideoInterruption);
      activeOverlay = state;
      debugLog('Preview', 'overlay mounted', {
        videoId: state.videoId,
        videoElementFound: Boolean(state.video),
        nativePreviewFound: Boolean(state.nativePreview),
        playerFound: Boolean(getNativePreviewPlayer(state.nativePreview)),
        nativePlayerFound: Boolean(getNativePreviewPlayer(state.nativePreview))
      });
      lockPageScroll();
      setPageInert(state);
      bindVideoControls(state);
      armPreviewAdGuard(state);
      schedulePreviewPlayback(state, PLAYBACK_RETRY_LIMIT);

      window.requestAnimationFrame(function () {
        if (activeOverlay === state) {
          elements.frame.focus({ preventScroll: true });
        }
      });
    } catch (error) {
      reportError('mount-overlay', error);
      if (activeOverlay === state) {
        closePreviewOverlay({ restoreFocus: false });
      } else {
        window.removeEventListener('keydown', state.handleKeydown, true);
        disarmPreviewAdGuard(state, 'overlay-mount-failed');
        clearSeekAssociation(state);
        if (state.placeholder.isConnected) {
          state.placeholder.replaceWith(mediaRoot);
        } else if (mediaRoot.parentNode !== originParent && originParent.isConnected) {
          originParent.insertBefore(mediaRoot, originNextSibling && originNextSibling.parentNode === originParent
            ? originNextSibling
            : null);
        }
        elements.overlay.remove();
        video.classList.remove(VIDEO_CLASS);
      }
      showPreviewNotice(PREVIEW_OPEN_ERROR_MESSAGE);
    }
  }

  function removePreviewNotice() {
    if (noticeTimer) {
      window.clearTimeout(noticeTimer);
      noticeTimer = 0;
    }

    if (noticeElement) {
      noticeElement.remove();
      noticeElement = null;
    }
  }

  function showPreviewNotice(message) {
    removePreviewNotice();

    noticeElement = document.createElement('div');
    noticeElement.className = NOTICE_CLASS;
    noticeElement.setAttribute('role', 'status');
    noticeElement.textContent = message || PREVIEW_MESSAGE;
    document.body.appendChild(noticeElement);

    window.requestAnimationFrame(function () {
      if (noticeElement) {
        noticeElement.classList.add(NOTICE_VISIBLE_CLASS);
      }
    });

    noticeTimer = window.setTimeout(removePreviewNotice, 3600);
  }

  function handleNavigation() {
    previewAttemptId += 1;
    stopHomeYtActionProvenance(homeYtActionProvenanceSession, 'navigation');
    stopHomeYtActionTargetLifecycle(globalThis.__ytpmHomeTargetLifecycle, 'navigation');
    removePreviewNotice();
    closePreviewOverlay({ restoreFocus: false });
    cancelHistoryNativeFallbackIntent();
    restoreButtonToCard();
    logSurfaceDiagnostics('navigation');
    queueFullScan();
  }

  function startObserver() {
    observer = new MutationObserver(function (mutations) {
      let shouldSyncButton = false;

      mutations.forEach(function (mutation) {
        if (nodeAffectsPreviewSync(mutation.target)) {
          shouldSyncButton = true;
        }

        mutation.addedNodes.forEach(function (node) {
          if (isElement(node)) {
            scanCards(node);
            shouldSyncButton = shouldSyncButton || nodeAffectsPreviewSync(node);
          }
        });
      });

      schedulePreviewSync({ syncButton: shouldSyncButton });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['active']
    });
  }

  function handlePageHide(event) {
    previewAttemptId += 1;
    stopHomeYtActionProvenance(homeYtActionProvenanceSession, 'navigation');
    stopHomeYtActionTargetLifecycle(globalThis.__ytpmHomeTargetLifecycle, 'navigation');
    closePreviewOverlay({ restoreFocus: false });
    cancelHistoryNativeFallbackIntent();
    restoreButtonToCard();
    removePreviewNotice();

    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanFrame) {
      window.cancelAnimationFrame(scanFrame);
    }
    scanFrame = 0;
    scanQueued = false;
    fullScanRequested = false;
    previewSyncRequested = false;

    document.removeEventListener('mouseover', handleCardHover, true);
    document.removeEventListener('mouseout', handleCardHoverExit, true);
    document.removeEventListener('yt-navigate-start', handleNavigation);
    document.removeEventListener('yt-navigate-finish', handleNavigation);
    window.removeEventListener('popstate', handleNavigation);

    disposePageBridge();
    bridgeInjectionAttempted = false;
    pageBridgeNonce = '';
    lastHoveredCard = null;
    initialized = false;

    // A persisted page is reinitialized from pageshow; a non-persisted page is
    // unloading and needs no further work.
    if (!event || !event.persisted) {
      lifecycleListenersInstalled = false;
    }
  }

  function handlePageShow(event) {
    if (event && event.persisted) {
      initialize();
    }
  }

  function getManualCaptionForensicSnapshot(label) {
    const state = activeOverlay;
    const info = state ? readNativeCaptionState(state) : null;
    const renderer = state && state.nativeCaptionRenderer || info && info.renderer;
    if (!state || !renderer) {
      const unavailable = {
        label: String(label || '').slice(0, 200),
        activeOverlay: Boolean(state),
        captionRendererFound: Boolean(renderer)
      };
      forensicLog('CaptionForensics', 'manualSnapshotUnavailable', unavailable);
      return unavailable;
    }

    const snapshot = buildCaptionForensicSnapshot(
      state,
      renderer,
      [],
      'manual-' + String(label || 'snapshot').slice(0, 80)
    );
    forensicLog('CaptionForensics', 'manualSnapshot', snapshot);
    return snapshot;
  }

  function installForensicDebugHelpers() {
    if (!DEBUG_LOGGING || forensicHelpersInstalled) {
      return;
    }

    forensicHelpersInstalled = true;
    const readLabel = function (event) {
      try {
        return event && event.detail && typeof event.detail.label === 'string'
          ? event.detail.label.slice(0, 200)
          : '';
      } catch (error) {
        return '';
      }
    };

    const helpers = Object.freeze({
      captionSnapshot: getManualCaptionForensicSnapshot,
      seekSnapshot: getManualSeekForensicSnapshot,
      logHistoryOwnershipEnd: logHistoryOwnershipEnd,
      logHistoryOwnershipEndSchedule: logHistoryOwnershipEndSchedule,
      logHistoryOwnershipEndCancel: logHistoryOwnershipEndCancel,
      scheduleHistoryOwnershipEnd: scheduleHistoryOwnershipEnd,
      cancelHistoryOwnershipEnd: cancelHistoryOwnershipEnd,
      detectCurrentSurface: detectCurrentSurface,
      isNativeFallbackSurface: isNativeFallbackSurface,
      isThumbnailHovered: isThumbnailHovered,
      isMembersOnlyCard: isMembersOnlyCard,
      MEMBERS_ONLY_MESSAGE: MEMBERS_ONLY_MESSAGE,
      decorateCard: decorateCard,
      getSurfaceDiagnostics: getSurfaceDiagnostics,
      logSurfaceDiagnostics: logSurfaceDiagnostics,
      requestNativePreviewFallback: requestNativePreviewFallback,
      cleanupNativePreviewFallback: cleanupNativePreviewFallback,
      queueNativePreviewFallback: queueNativePreviewFallback,
      openPreviewOverlay: openPreviewOverlay,
      closePreviewOverlay: closePreviewOverlay,
      getActiveOverlay: function () {
        return activeOverlay;
      },
      showOverlayControls: showOverlayControls,
      hideOverlayControls: hideOverlayControls,
      isTextInputElement: isTextInputElement,
      export: function () {
        return forensicLogBuffer.slice();
      },
      exportJson: function () {
        return serializeForensicBuffer();
      },
      clear: function () {
        forensicLogBuffer.splice(0, forensicLogBuffer.length);
      }
    });

    try {
      Object.defineProperty(globalThis, '__YTPMForensics', {
        configurable: true,
        enumerable: false,
        value: helpers
      });
    } catch (error) {
      reportError('forensics-helper-install', error);
    }

    window.addEventListener('ytpm-debug-caption-snapshot', function (event) {
      getManualCaptionForensicSnapshot(readLabel(event));
    });
    window.addEventListener('ytpm-debug-seek-snapshot', function (event) {
      getManualSeekForensicSnapshot(readLabel(event));
    });
    window.addEventListener('ytpm-debug-history-native-fallback', function (event) {
      requestHistoryNativeFallback(event);
    });
    window.addEventListener('ytpm-debug-native-preview-fallback', function (event) {
      requestNativePreviewFallback(event);
    });
    window.addEventListener('ytpm-debug-surface-diagnostics', function () {
      logSurfaceDiagnostics('manual-event');
    });
    window.addEventListener('ytpm-debug-dump', function () {
      const data = forensicLogBuffer.slice();
      console.debug('[YTPM][ForensicsJSON]\n' + JSON.stringify(data, null, 2));
    });
    window.addEventListener('ytpm-debug-clear', function () {
      forensicLogBuffer.splice(0, forensicLogBuffer.length);
      if (historyNativeFallbackSession) {
        cleanupHistoryNativeFallback('debug-clear');
      }
      console.debug('[YTPM][ForensicsDump]', 'cleared');
    });
    forensicLog('Forensics', 'helpersReady', {
      extensionContextHelper: '__YTPMForensics',
      pageContextEvents: [
        'ytpm-debug-caption-snapshot',
        'ytpm-debug-seek-snapshot',
        'ytpm-debug-history-native-fallback',
        'ytpm-debug-native-preview-fallback',
        'ytpm-debug-surface-diagnostics',
        'ytpm-debug-dump',
        'ytpm-debug-clear'
      ]
    });
  }

  function initialize() {
    if (initialized) {
      return;
    }

    initialized = true;
    installForensicDebugHelpers();
    injectPageBridge();
    scanCards(document);
    logSurfaceDiagnostics('init');
    startObserver();

    document.addEventListener('mouseover', handleCardHover, true);
    document.addEventListener('mouseout', handleCardHoverExit, true);
    document.addEventListener('yt-navigate-start', handleNavigation);
    document.addEventListener('yt-navigate-finish', handleNavigation);
    window.addEventListener('popstate', handleNavigation);

    if (!lifecycleListenersInstalled) {
      window.addEventListener('pagehide', handlePageHide);
      window.addEventListener('pageshow', handlePageShow);
      lifecycleListenersInstalled = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
