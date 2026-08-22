(function () {
  'use strict';

  const AD_RENDERER_SELECTOR = [
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
    '[is-ad]',
    '[ad-placement]'
  ].join(',');
  const HOME_ITEM_SELECTOR = 'ytd-rich-item-renderer';
  const WATCH_AD_CONTAINER_SELECTOR = [
    'ytd-companion-slot-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-display-ad-renderer'
  ].join(',');
  const reported = new WeakSet();

  function log(eventName, node, reason) {
    if (reported.has(node)) {
      return;
    }
    reported.add(node);
    console.debug('[YTPM][Ads]', eventName, {
      renderer: node.tagName ? node.tagName.toLowerCase() : 'unknown',
      surface: window.location.pathname === '/' ? 'home' : 'watch-or-other',
      reason: reason
    });
  }

  function cleanNode(node) {
    if (!node || node.nodeType !== 1) {
      return;
    }
    const renderers = [];
    if (node.matches && node.matches(AD_RENDERER_SELECTOR)) {
      renderers.push(node);
    }
    if (node.querySelectorAll) {
      node.querySelectorAll(AD_RENDERER_SELECTOR).forEach(function (renderer) {
        renderers.push(renderer);
      });
    }
    renderers.forEach(function (renderer) {
      const homeItem = renderer.closest(HOME_ITEM_SELECTOR);
      if (window.location.pathname === '/' && homeItem) {
        log('ytpmAdNodeRemoved', renderer, 'promoted-home-item');
        homeItem.remove();
        return;
      }
      if (WATCH_AD_CONTAINER_SELECTOR && renderer.matches(WATCH_AD_CONTAINER_SELECTOR)) {
        log('ytpmAdNodeHidden', renderer, 'watch-ad-container');
        renderer.hidden = true;
      }
    });
  }

  function cleanRoot() {
    if (document.documentElement) {
      cleanNode(document.documentElement);
    }
  }

  function start() {
    cleanRoot();
    if (typeof MutationObserver !== 'function' || !document.documentElement) {
      return;
    }
    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(cleanNode);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
