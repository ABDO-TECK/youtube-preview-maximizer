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
  const SEEK_MAX_SECONDS = 86400;
  const CONTROLS_HIDE_DELAY_MS = 5000;
  const BRIDGE_ID_PATTERN = /^request-\d{1,12}$/;
  const DEBUG_LOGGING = false;
  const captionUtils = globalThis.YTPMCaptionUtils || {};

  let activeOverlay = null;
  let observer = null;
  let scanQueued = false;
  let scanFrame = 0;
  let noticeElement = null;
  let noticeTimer = 0;
  let previewAttemptId = 0;
  let lastHoveredCard = null;
  let previewButtonState = null;
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
  const bridgeRequests = new Map();
  const bridgeReadyWaiters = [];

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

  function createBridgeNonce() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);

    return Array.from(bytes).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function isBridgeEnvelope(data) {
    return Boolean(
      data &&
      data.source === PAGE_BRIDGE_SOURCE &&
      data.nonce === pageBridgeNonce &&
      (
        data.type === 'ready' ||
        (
          data.type === 'response' &&
          typeof data.id === 'string' &&
          BRIDGE_ID_PATTERN.test(data.id)
        )
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
      targetTime: sanitizeTime(result.targetTime),
      playerCurrentTimeBefore: sanitizeTime(result.playerCurrentTimeBefore),
      playerCurrentTimeAfter: sanitizeTime(result.playerCurrentTimeAfter)
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
      'seek-preview'
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

  function isAdCard(card) {
    if (!isElement(card)) {
      return false;
    }

    return card.matches(AD_CARD_SELECTOR) || Boolean(card.querySelector(AD_CARD_SELECTOR));
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
    button.setAttribute('aria-label', 'Maximize YouTube preview');
    button.title = 'Maximize YouTube preview';
    button.textContent = '⛶';

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
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
    if (!thumbnailHost || thumbnailHost.querySelector('.' + BUTTON_CLASS)) {
      return;
    }

    thumbnailHost.classList.add(THUMBNAIL_CLASS);
    thumbnailHost.dataset.ytpmThumbnailHost = 'true';
    const button = createMaximizeButton(card);
    thumbnailHost.appendChild(button);
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
      return !isAdCard(card);
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

    const thumbnailHost = findThumbnailHost(state.card);
    if (thumbnailHost) {
      thumbnailHost.classList.add(THUMBNAIL_CLASS);
      thumbnailHost.appendChild(state.button);
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

    activePreview.classList.add(PREVIEW_HOST_CLASS);
    if (button.parentNode !== activePreview) {
      activePreview.appendChild(button);
    }
    button.classList.add(PREVIEW_BUTTON_CLASS);
    previewButtonState = {
      card: card,
      preview: activePreview,
      button: button,
      video: previewVideo
    };
  }

  function handleCardHover(event) {
    const target = isElement(event.target) ? event.target : null;
    const card = target ? target.closest(CARD_SELECTOR) : null;
    if (!card || card === lastHoveredCard) {
      return;
    }

    lastHoveredCard = card;
    schedulePreviewSync();
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
    frame.appendChild(captions);
    frame.appendChild(timelinePreview);
    frame.appendChild(seekInput);
    frame.appendChild(controls);

    return {
      overlay: overlay,
      closeButton: closeButton,
      frame: frame,
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

    if (!state.controls.qualityMenu.hidden) {
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

  function readCaptionWindowText(captionWindow) {
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
      if (!seenSegments.has(segment) && isVisibleCaptionNode(segment)) {
        seenSegments.add(segment);
        segments.push(segment);
      }
    });

    const values = segments.length
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

    const values = activeWindows.map(readCaptionWindowText).filter(Boolean);
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
        windowText: readCaptionWindowText(captionWindow),
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
  }

  function connectNativeCaptionObservers(state, info) {
    if (state.nativeCaptionRenderer !== info.renderer) {
      if (state.nativeCaptionObserver) {
        state.nativeCaptionObserver.disconnect();
        state.nativeCaptionObserver = null;
      }
      state.nativeCaptionRenderer = info.renderer || null;
      state.captionGeneration = 0;
      state.captionActiveWindows = new Set();
      state.captionWindowGenerations = new Map();
      state.captionLastMutationDebug = null;

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
          scheduleNativeCaptionMirrorUpdate(state);
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
    const mirrorReplaced = state.nativeCaptionText !== text;
    state.nativeCaptionText = text;
    state.controls.captions.textContent = text;
    state.controls.captions.hidden = !text;
    if (state.captionLastMutationDebug) {
      state.captionLastMutationDebug.finalMirroredLines = text
        ? text.split('\n').length
        : 0;
      debugLog('Captions', 'mutationBatchFinal', state.captionLastMutationDebug);
      state.captionLastMutationDebug = null;
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
    state.captionGeneration = 0;
    state.captionActiveWindows = new Set();
    state.captionWindowGenerations = new Map();
    state.captionLastMutationDebug = null;
    if (state.controls && state.controls.captions) {
      state.controls.captions.textContent = '';
      state.controls.captions.hidden = true;
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

  function debugStoryboardMetadata(state, storyboard) {
    const format = storyboard && Array.isArray(storyboard.formats)
      ? storyboard.formats.find(function (candidate) {
        return candidate.level === storyboard.recommendedLevel;
      }) || storyboard.formats[0]
      : null;

    debugLog('Storyboard', 'metadata', {
      videoId: state.videoId,
      duration: state.duration || (storyboard && storyboard.duration) || 0,
      storyboardSpecFound: Boolean(storyboard),
      storyboardLevel: format ? format.level : null,
      frameCount: format ? format.count : 0,
      columns: format ? format.columns : 0,
      rows: format ? format.rows : 0,
      framesPerSprite: format ? format.framesPerSprite : 0,
      spriteCount: format ? format.spriteCount : 0,
      storyboardUrl: format ? getDebugUrl(storyboard.template) : '',
      templateUrl: format ? getDebugUrl(storyboard.template) : ''
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
    controls.seekInput.value = String(displayTime);
    controls.seekInput.style.setProperty(
      '--ytpm-seek-progress',
      (duration ? Math.min(100, (displayTime / duration) * 100) : 0) + '%'
    );
    controls.timeLabel.textContent = formatTime(displayTime) + ' / ' + formatTime(duration);

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
      percent = (clientX - rect.left) / rect.width;
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
    debugLog('Storyboard', 'frameIgnored', {
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
    debugLog('Storyboard', 'frameApplied', {
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
    debugLog('Storyboard', 'frameRequested', {
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
      debugLog('Storyboard', 'frameFailed', {
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
        debugLog('Storyboard', 'frameIgnored', {
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
      debugLog('Storyboard', 'loadCompleted', {
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
      debugLog('Storyboard', 'frameFailed', {
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
    debugLog('Storyboard', 'loadStarted', {
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
    debugLog('Storyboard', 'frameMapped', {
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
      requestedUrl: getDebugUrl(frame.url)
    });
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
    if (captionUtils.getSeekConfirmationPlan) {
      return captionUtils.getSeekConfirmationPlan(
        request.playerControlled === true,
        current.playerCurrentTime,
        current.videoCurrentTime,
        request.targetTime,
        SEEK_CONFIRM_TOLERANCE
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
      stage: request.stage || 'pending',
      allowSeekAhead: typeof request.allowSeekAhead === 'boolean'
        ? request.allowSeekAhead
        : null,
      videoCurrentTimeBefore: request.before.videoCurrentTime,
      videoCurrentTimeAfter: current.videoCurrentTime,
      playerCurrentTimeBefore: request.before.playerCurrentTime,
      playerCurrentTimeAfter: current.playerCurrentTime,
      videoDuration: current.videoDuration,
      metadataDuration: current.metadataDuration,
      bufferedRanges: current.bufferedRanges,
      requestId: request.requestId,
      controller: request.controller,
      playerConfirmed: confirmation.playerConfirmed,
      videoConfirmed: confirmation.videoConfirmed,
      confirmed: confirmation.confirmed,
      pendingCleared: state.seekPending === false,
      timeout: false,
      snapbackDetected: false
    };
    return Object.assign(output, details || {});
  }

  function isPlayerSeekUsable(result) {
    return Boolean(result && result.ok === true && result.seekToAvailable === true);
  }

  function canFallbackToVideoSeek(result) {
    return !result || result.playerFound !== true || result.seekToAvailable !== true;
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
      state.playerApi.seekTo(request.targetTime, allowSeekAhead === true);
      return {
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
    } catch (error) {
      reportError('seek-player-direct', error);
      return {
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
    }
  }

  function requestPlayerSeek(state, request, allowSeekAhead, stage) {
    request.stage = stage;
    request.allowSeekAhead = allowSeekAhead === true;
    const payload = {
      videoId: state.videoId,
      seconds: request.targetTime,
      allowSeekAhead: request.allowSeekAhead
    };

    debugLog('Seek', 'playerSeekRequest', getSeekDebugDetails(
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
          return null;
        }
        if (!result || result.playerFound !== true ||
          result.seekToAvailable !== true) {
          const directResult = invokeDirectPlayerSeek(
            state,
            request,
            allowSeekAhead,
            stage
          );
          if (directResult) {
            result = directResult;
          }
        }

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
    const snapbackDetected = !finalConfirmed && (
      (after.videoCurrentTime !== null && !confirmation.videoConfirmed) ||
      (request.playerControlled === true &&
        after.playerCurrentTime !== null && !confirmation.playerConfirmed)
    );
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
          snapbackDetected: !currentConfirmed && (
            (current.videoCurrentTime !== null && !confirmation.videoConfirmed) ||
            (request.playerControlled === true &&
              current.playerCurrentTime !== null && !confirmation.playerConfirmed)
          )
        }
      ));
      if (currentConfirmed || Date.now() >= deadline) {
        finishSeekRequest(
          state,
          request,
          currentConfirmed,
          currentConfirmed
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
    const wasPaused = state.video.paused || state.video.ended;
    const requestId = ++state.seekRequestId;
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekDragging = false;
    state.seekPending = true;
    state.pendingSeekTime = targetTime;
    const request = {
      requestId: requestId,
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
      restorePlayback: true
    };

    scheduleVideoControlUpdate(state);

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

  function beginSeekInteraction(state, event) {
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekRequestId += 1;
    state.seekInteractionId += 1;
    state.seekCommittedInteractionId = 0;
    state.seekDragging = true;
    state.seekPending = true;
    state.pendingSeekTime = readSeekInputTarget(state);
    state.seekPointerId = event && Number.isFinite(event.pointerId)
      ? event.pointerId
      : null;
    scheduleVideoControlUpdate(state);
  }

  function commitSeekInteraction(state) {
    if (!state.seekDragging && !state.seekPending) {
      beginSeekInteraction(state, null);
    }

    const targetTime = Number.isFinite(Number(state.pendingSeekTime))
      ? state.pendingSeekTime
      : readSeekInputTarget(state);
    state.pendingSeekTime = targetTime;
    state.seekDragging = false;
    if (state.seekCommittedInteractionId === state.seekInteractionId) {
      state.seekPointerId = null;
      return;
    }

    state.seekCommittedInteractionId = state.seekInteractionId;
    state.seekPointerId = null;
    seekPreviewTo(state, targetTime, { rangeValue: state.controls.seekInput.value });
  }

  function cancelSeekInteraction(state) {
    clearSeekConfirmationTimer(state);
    state.seekConfirmationCheck = null;
    state.seekRequestId += 1;
    state.seekDragging = false;
    state.seekPending = false;
    state.pendingSeekTime = null;
    state.seekConfirmationCheck = null;
    state.seekPointerId = null;
    scheduleVideoControlUpdate(state);
  }

  function seekVideoBy(state, amount) {
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
      rangeValue: currentTime + Number(amount || 0)
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
      registerListener(state.videoControlCleanup, state.video, eventName, function () {
        scheduleVideoControlUpdate(state);
        if (state.seekPending && state.seekConfirmationCheck &&
          (eventName === 'timeupdate' || eventName === 'seeking' ||
            eventName === 'seeked')) {
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
      });
    });

    ['pointermove', 'pointerenter', 'pointerdown', 'touchstart', 'focusin'].forEach(function (eventName) {
      registerListener(state.controlCleanup, state.elements.frame, eventName, function () {
        showOverlayControls(state);
      });
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
      updateTimelinePreview(state, event.clientX);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointerdown', function (event) {
      beginSeekInteraction(state, event);
      updateTimelinePreview(state, event.clientX);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointerleave', function () {
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'focus', function () {
      updateTimelinePreview(state, null);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'blur', function () {
      if (state.seekDragging) {
        commitSeekInteraction(state);
      }
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'input', function () {
      if (!state.seekDragging) {
        beginSeekInteraction(state, null);
      }

      state.pendingSeekTime = readSeekInputTarget(state);
      state.seekPending = true;
      updateTimelinePreview(state, state.timelineHoverClientX);
      scheduleVideoControlUpdate(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'change', function () {
      commitSeekInteraction(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'pointercancel', function () {
      cancelSeekInteraction(state);
      hideTimelinePreview(state);
    });
    registerListener(state.controlCleanup, document, 'pointerup', function (event) {
      if (!state.seekDragging ||
        (state.seekPointerId !== null && Number.isFinite(event.pointerId) &&
          event.pointerId !== state.seekPointerId)) {
        return;
      }
      commitSeekInteraction(state);
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
      nativePreview: activePreview,
      nativeCaptionObserver: null,
      nativePreviewObserver: null,
      nativePreviewObserved: null,
      nativeCaptionRenderer: null,
      nativeCaptionSyncTimer: 0,
      nativeCaptionState: null,
      nativeCaptionText: '',
      captionGeneration: 0,
      captionActiveWindows: new Set(),
      captionWindowGenerations: new Map(),
      captionLastMutationDebug: null,
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

      const isElementTarget = isElement(event.target);
      const isCloseTarget = isElementTarget && event.target.closest('.' + CLOSE_CLASS);
      const isActivationKey = isSpace || key === 'enter';
      const isTextInputTarget = isElementTarget && (
        event.target.tagName === 'TEXTAREA' ||
        event.target.isContentEditable ||
        (event.target.tagName === 'INPUT' && event.target !== state.controls.seekInput)
      );
      const isSeekControlKey = event.target === state.controls.seekInput &&
        (isArrowLeft || isArrowRight);
      if (isTextInputTarget ||
        (isCloseTarget && isActivationKey) ||
        isSeekControlKey) {
        return;
      }

      if (isArrowLeft || isArrowRight) {
        event.preventDefault();
        event.stopPropagation();
        seekVideoBy(state, isArrowLeft ? -5 : 5);
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
    removePreviewNotice();
    closePreviewOverlay({ restoreFocus: false });
    restoreButtonToCard();
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
    closePreviewOverlay({ restoreFocus: false });
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

  function initialize() {
    if (initialized) {
      return;
    }

    initialized = true;
    injectPageBridge();
    scanCards(document);
    startObserver();

    document.addEventListener('mouseover', handleCardHover, true);
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
