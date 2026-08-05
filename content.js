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
  const CAPTION_BRIDGE_TIMEOUT_MS = 5000;
  const CONTROLS_HIDE_DELAY_MS = 5000;

  let activeOverlay = null;
  let observer = null;
  let scanQueued = false;
  let noticeElement = null;
  let noticeTimer = 0;
  let previewAttemptId = 0;
  let lastHoveredCard = null;
  let previewButtonState = null;
  let bridgeInjectionAttempted = false;
  let bridgeReady = false;
  let bridgeRequestCounter = 0;
  const cardButtonMap = new WeakMap();
  const cardPreviewVideoMap = new WeakMap();
  const bridgeRequests = new Map();
  const bridgeReadyWaiters = [];

  function resolveBridgeReady(value) {
    while (bridgeReadyWaiters.length) {
      const waiter = bridgeReadyWaiters.shift();
      window.clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  function handlePageBridgeMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== PAGE_BRIDGE_SOURCE) {
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
    request.resolve(event.data.result || null);
  }

  function injectPageBridge() {
    if (bridgeInjectionAttempted) {
      return;
    }

    bridgeInjectionAttempted = true;
    window.addEventListener('message', handlePageBridgeMessage);

    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-bridge.js');
      script.async = false;
      script.dataset.ytpmPageBridge = 'true';
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
      // Direct DOM and video controls remain available if the bridge is blocked.
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

        bridgeRequests.set(id, { resolve: resolve, timer: timer });
        window.postMessage({
          source: PAGE_BRIDGE_SOURCE,
          type: 'request',
          id: id,
          command: command,
          payload: payload || {}
        }, '*');
      });
    });
  }

  function disposePageBridge() {
    window.removeEventListener('message', handlePageBridgeMessage);
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
      const watchId = url.searchParams.get('v');
      if (watchId) {
        return 'watch:' + watchId;
      }

      const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
      return shortsMatch ? 'shorts:' + shortsMatch[1] : null;
    } catch (error) {
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
      return videoData && videoData.video_id ? 'watch:' + videoData.video_id : null;
    } catch (error) {
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
    return separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
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

    if (targetCard && lastHoveredCard === targetCard && activePreviews.length === 1) {
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
    if (!card) {
      return;
    }

    lastHoveredCard = card;
    queueFullScan();
  }

  function queueFullScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;
    window.requestAnimationFrame(function () {
      scanQueued = false;
      scanCards(document);
      syncPreviewButton();

      if (activeOverlay && (!activeOverlay.card.isConnected ||
        !activeOverlay.video.isConnected ||
        (activeOverlay.mediaRoot && !activeOverlay.mediaRoot.isConnected))) {
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
          playPromise.catch(function () {
            // YouTube may pause a preview after the card has been restored.
          });
        }
      }
    } catch (error) {
      // The media element can become unavailable while YouTube re-renders a card.
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
      // YouTube may replace the media element while the preview is ending.
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
        // The preview can still be transitioning between YouTube player states.
      }
    }

    restorePreviewSource(state.video, state.videoState);

    try {
      const playPromise = state.video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () {
          // A later retry can succeed after YouTube finishes its player update.
        });
      }
    } catch (error) {
      // The media element can briefly be in a transitional state.
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
    captionsButton.className = CONTROL_BUTTON_CLASS;
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

  function getCaptionTracks(video) {
    if (!video.textTracks) {
      return [];
    }

    return Array.from(video.textTracks).filter(function (track) {
      return track.kind === 'captions' || track.kind === 'subtitles';
    });
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
    if (!state.video || !Array.isArray(captionData) || !captionData.length ||
      typeof Blob !== 'function' || !window.URL || typeof URL.createObjectURL !== 'function') {
      return false;
    }

    const safeTrackInfo = trackInfo || {};
    removeSyntheticCaptionTrack(state);
    const vttLines = ['WEBVTT', ''];
    captionData.forEach(function (cue, index) {
      const start = Number(cue.start);
      const end = start + Number(cue.duration);
      const text = String(cue.text || '').trim();
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
    trackElement.label = safeTrackInfo.label || 'Captions';
    trackElement.srclang = safeTrackInfo.languageCode || 'und';
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
    state.video.appendChild(trackElement);
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
        typeof candidate.getVideoData === 'function';
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
      return Array.from(new Set((Array.isArray(levels) ? levels : []).filter(Boolean)));
    } catch (error) {
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
    const enabled = Boolean(info && info.enabled);

    state.controls.captionsButton.disabled = !available;
    state.controls.captionsButton.setAttribute('aria-pressed', String(enabled));
    state.controls.captionsButton.setAttribute(
      'aria-label',
      enabled ? 'Turn captions off' : 'Turn captions on'
    );
    state.controls.captionsButton.title = available
      ? enabled ? 'Turn captions off' : 'Turn captions on'
      : 'Captions are unavailable for this preview';
  }

  function updateCaptionControl(state) {
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

    // Preview videos often expose zero textTracks in the isolated content-script world.
    // The page bridge fills this state from YouTube's own player controls/API.
    applyCaptionControl(state, state.captionInfo || { available: true, enabled: false });
  }

  function refreshCaptionControl(state) {
    const tracks = getCaptionTracks(state.video);
    if (tracks.length) {
      updateCaptionControl(state);
      return;
    }

    const requestId = ++state.captionRequestId;
    requestPageBridge('caption-tracks', {
      videoId: state.videoId
    }, CAPTION_BRIDGE_TIMEOUT_MS).then(function (catalog) {
      if (activeOverlay !== state || requestId !== state.captionRequestId) {
        return;
      }

      if (catalog && catalog.available && Array.isArray(catalog.tracks) && catalog.tracks.length) {
        state.captionCatalog = catalog;
        state.captionInfo = { available: true, enabled: false };
        applyCaptionControl(state, state.captionInfo);
        return;
      }

      return requestPageBridge('captions-info', { videoId: state.videoId }).then(function (info) {
        if (activeOverlay !== state || requestId !== state.captionRequestId) {
          return;
        }

        if (info && typeof info.available === 'boolean') {
          state.captionInfo = {
            available: info.available,
            enabled: Boolean(info.enabled)
          };
          applyCaptionControl(state, state.captionInfo);
        }
      });
    });
  }

  function chooseCaptionSelection(catalog) {
    const browserLanguage = String(navigator.language || '').split('-')[0].toLowerCase();
    const tracks = Array.isArray(catalog.tracks) ? catalog.tracks : [];
    const translations = Array.isArray(catalog.translationLanguages)
      ? catalog.translationLanguages
      : [];
    const directTrack = tracks.find(function (track) {
      return String(track.languageCode || '').toLowerCase() === browserLanguage;
    });
    const track = directTrack || tracks[0];
    const translatedLanguage = !directTrack && translations.find(function (language) {
      return String(language.languageCode || '').toLowerCase() === browserLanguage;
    });

    if (!track) {
      return null;
    }

    return {
      trackId: track.id,
      targetLanguage: translatedLanguage ? browserLanguage : null,
      languageCode: translatedLanguage ? browserLanguage : track.languageCode,
      label: translatedLanguage
        ? String(track.label || 'Captions') + ' · ' + browserLanguage.toUpperCase()
        : String(track.label || 'Captions')
    };
  }

  async function toggleCaptionsViaPlayerApi(state) {
    const result = await requestPageBridge('toggle-captions', {
      videoId: state.videoId
    });

    if (activeOverlay !== state) {
      return false;
    }

    if (result && result.ok) {
      state.captionInfo = {
        available: result.available !== false,
        enabled: Boolean(result.enabled)
      };
      applyCaptionControl(state, state.captionInfo);
      return true;
    }

    return false;
  }

  async function loadPreviewCaptions(state) {
    if (state.captionLoadPending) {
      return;
    }

    state.captionLoadPending = true;
    state.controls.captionsButton.disabled = true;
    state.controls.captionsButton.title = 'Loading captions…';

    try {
      const catalog = state.captionCatalog || await requestPageBridge('caption-tracks', {
        videoId: state.videoId
      }, CAPTION_BRIDGE_TIMEOUT_MS);
      if (activeOverlay !== state) {
        return;
      }

      if (catalog && catalog.available && Array.isArray(catalog.tracks) && catalog.tracks.length) {
        state.captionCatalog = catalog;
        const selection = chooseCaptionSelection(catalog);
        const captionResult = selection && await requestPageBridge('fetch-captions', {
          videoId: state.videoId,
          trackId: selection.trackId,
          targetLanguage: selection.targetLanguage
        }, CAPTION_BRIDGE_TIMEOUT_MS);

        if (captionResult && captionResult.ok && installSyntheticCaptionTrack(
          state,
          captionResult.cues,
          {
            label: selection.label,
            languageCode: selection.languageCode
          }
        )) {
          state.captionInfo = { available: true, enabled: true };
          applyCaptionControl(state, state.captionInfo);
          return;
        }
      }

      if (await toggleCaptionsViaPlayerApi(state)) {
        return;
      }

      state.captionInfo = { available: false, enabled: false };
      applyCaptionControl(state, state.captionInfo);
      showPreviewNotice('YouTube did not provide captions for this preview.');
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

  function updateFullscreenControl(state) {
    const isFullscreen = document.fullscreenElement === state.elements.frame;
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
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const currentTime = Number.isFinite(video.currentTime) && video.currentTime >= 0
      ? video.currentTime
      : 0;
    const isPlaying = !video.paused && !video.ended;

    const volume = Number.isFinite(video.volume) ? video.volume : 1;

    controls.playButton.setAttribute('aria-label', isPlaying ? 'Pause preview' : 'Play preview');
    controls.playButton.title = isPlaying ? 'Pause preview' : 'Play preview';
    setButtonIcon(controls.playButton, isPlaying ? 'pause' : 'play');
    controls.muteButton.setAttribute(
      'aria-label',
      video.muted || video.volume === 0 ? 'Unmute preview' : 'Mute preview'
    );
    controls.muteButton.title = video.muted || video.volume === 0 ? 'Unmute preview' : 'Mute preview';
    setButtonIcon(controls.muteButton, video.muted || video.volume === 0 ? 'muted' : 'volume');
    if (controls.volumeInput) {
      if (document.activeElement !== controls.volumeInput) {
        controls.volumeInput.value = String(volume);
      }
      controls.volumeInput.style.setProperty('--ytpm-volume-progress', (volume * 100) + '%');
    }

    controls.seekInput.disabled = duration === 0;
    controls.seekInput.max = String(duration || 1);
    if (document.activeElement !== controls.seekInput) {
      controls.seekInput.value = String(Math.min(currentTime, duration || 1));
    }
    controls.seekInput.style.setProperty(
      '--ytpm-seek-progress',
      (duration ? Math.min(100, (currentTime / duration) * 100) : 0) + '%'
    );
    controls.timeLabel.textContent = formatTime(currentTime) + ' / ' + formatTime(duration);

    updateCaptionControl(state);
    updateFullscreenControl(state);
  }

  function seekVideoBy(state, amount) {
    const duration = Number.isFinite(state.video.duration) ? state.video.duration : 0;
    if (!duration) {
      return;
    }

    state.video.currentTime = Math.max(0, Math.min(duration, state.video.currentTime + amount));
    updateVideoControls(state);
  }

  function togglePreviewPlayback(state) {
    if (state.video.paused || state.video.ended) {
      state.userPaused = false;
      if (state.video.ended) {
        state.video.currentTime = 0;
      }
      schedulePreviewPlayback(state, 4);
    } else {
      state.userPaused = true;
      if (state.playbackRetryTimer) {
        window.clearTimeout(state.playbackRetryTimer);
        state.playbackRetryTimer = 0;
      }
      state.video.pause();
      updateVideoControls(state);
    }
  }

  function togglePreviewMute(state) {
    const isMuted = state.video.muted || state.video.volume === 0;
    if (isMuted) {
      state.video.muted = false;
      if (state.video.volume === 0) {
        state.video.volume = state.videoState.volume > 0 ? state.videoState.volume : 1;
      }
    } else {
      state.video.muted = true;
    }
    updateVideoControls(state);
  }

  function togglePreviewCaptions(state) {
    const tracks = getCaptionTracks(state.video);
    if (tracks.length) {
      toggleSyntheticCaptionTracks(state, tracks);
      return;
    }

    loadPreviewCaptions(state);
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
    const bridgeResult = await requestPageBridge('set-quality', {
      videoId: state.videoId,
      level: level
    });

    if (activeOverlay !== state) {
      return;
    }

    if (bridgeResult && bridgeResult.ok) {
      state.qualityInfo = Object.assign({}, state.qualityInfo || {}, {
        current: normalizeQualityLevel(bridgeResult.current || level)
      });
      state.controls.qualityButton.title = 'Video quality: ' + qualityLabel(level);
      setButtonIcon(state.controls.qualityButton, 'settings');
      state.controls.qualityMenu.hidden = true;
      state.controls.qualityButton.setAttribute('aria-expanded', 'false');
      window.setTimeout(function () {
        if (activeOverlay === state) {
          refreshQualityMenu(state, 0);
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
      const apiLevel = level === 'auto' ? 'default' : level;
      if (typeof api.setPlaybackQualityRange === 'function') {
        api.setPlaybackQualityRange(apiLevel);
      }
      if (typeof api.setPlaybackQuality === 'function') {
        api.setPlaybackQuality(apiLevel);
      }
      state.controls.qualityButton.title = 'Video quality: ' + qualityLabel(level);
      setButtonIcon(state.controls.qualityButton, 'settings');
      state.controls.qualityMenu.hidden = true;
      state.controls.qualityButton.setAttribute('aria-expanded', 'false');
      state.qualityInfo = Object.assign({}, state.qualityInfo || {}, {
        current: normalizeQualityLevel(level)
      });
      window.setTimeout(function () {
        if (activeOverlay === state) {
          refreshQualityMenu(state, 0);
        }
      }, 350);
    } catch (error) {
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
          refreshQualityMenu(state, remainingAttempts - 1);
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
        // Keep Auto as the safe display value.
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
        setPreviewQuality(state, level);
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
      'durationchange',
      'loadedmetadata',
      'progress',
      'volumechange',
      'ended'
    ];

    videoEvents.forEach(function (eventName) {
      registerListener(state.videoControlCleanup, state.video, eventName, function () {
        updateVideoControls(state);
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

      state.video.volume = Math.max(0, Math.min(1, value));
      state.video.muted = value === 0;
      if (value > 0) {
        state.userPaused = false;
      }
      updateVideoControls(state);
    });
    registerListener(state.controlCleanup, state.controls.captionsButton, 'click', function () {
      togglePreviewCaptions(state);
    });
    registerListener(state.controlCleanup, state.controls.seekInput, 'input', function () {
      const value = Number(state.controls.seekInput.value);
      if (Number.isFinite(value)) {
        state.video.currentTime = value;
        updateVideoControls(state);
      }
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
        updateCaptionControl(state);
      });
    }

    updateVideoControls(state);
    showOverlayControls(state);
    refreshCaptionControl(state);
    refreshQualityMenu(state, QUALITY_RETRY_LIMIT);
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

  function restoreVideoToOrigin(state) {
    const video = state.video;
    const mediaRoot = state.mediaRoot || video;
    video.classList.remove(VIDEO_CLASS);

    if (!state.card.isConnected || !state.originParent || !state.originParent.isConnected) {
      try {
        video.pause();
      } catch (error) {
        // The video may already have been detached by YouTube.
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
    state.video.removeEventListener('pause', state.handleVideoInterruption);
    state.video.removeEventListener('emptied', state.handleVideoInterruption);
    state.video.removeEventListener('loadedmetadata', state.handleVideoInterruption);

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
        // Removing the fullscreen frame still lets the browser exit fullscreen.
      }
    }

    // Stop the preview before returning it to YouTube. This prevents the
    // restored video from continuing to emit audio after the overlay closes.
    try {
      state.video.pause();
    } catch (error) {
      // YouTube may have detached the media element during navigation.
    }
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

    const buttonPreview = previewButtonState && previewButtonState.card === card
      ? previewButtonState.preview
      : null;
    const previewHost = preferredPreview && preferredPreview.isConnected
      ? preferredPreview
      : buttonPreview && buttonPreview.isConnected
        ? buttonPreview
        : null;
    const attemptId = ++previewAttemptId;
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
    const activePreview = findActivePreview(card);
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
      captionInfo: null,
      captionCatalog: null,
      captionRequestId: 0,
      captionLoadPending: false,
      captionTrackElement: null,
      captionTrackLoadHandler: null,
      captionObjectUrl: '',
      captionTrackInfo: null,
      controlsHideTimer: 0,
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
      lockPageScroll();
      bindVideoControls(state);
      schedulePreviewPlayback(state, PLAYBACK_RETRY_LIMIT);

      window.requestAnimationFrame(function () {
        if (activeOverlay === state) {
          elements.frame.focus({ preventScroll: true });
        }
      });
    } catch (error) {
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
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (isElement(node)) {
            scanCards(node);
          }
        });
      });

      queueFullScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['active']
    });
  }

  function initialize() {
    injectPageBridge();
    scanCards(document);
    startObserver();

    document.addEventListener('mouseover', handleCardHover, true);
    document.addEventListener('yt-navigate-start', handleNavigation);
    document.addEventListener('yt-navigate-finish', handleNavigation);
    window.addEventListener('popstate', handleNavigation);
    window.addEventListener('pagehide', function () {
      previewAttemptId += 1;
      closePreviewOverlay({ restoreFocus: false });
      restoreButtonToCard();
      removePreviewNotice();
      if (observer) {
        observer.disconnect();
      }
      disposePageBridge();
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
