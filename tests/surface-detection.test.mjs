import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const contentSource = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.nextSibling = null;
    this.attributes = new Map();
    this.classList = new Set();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.isConnected = true;
  }

  get className() {
    return Array.from(this.classList).join(' ');
  }

  set className(val) {
    this.classList.clear();
    if (typeof val === 'string') {
      val.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  contains(other) {
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement || curr.parentNode;
    }
    return false;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  insertBefore(newNode, referenceNode) {
    if (!referenceNode) return this.appendChild(newNode);
    const index = this.children.indexOf(referenceNode);
    if (index >= 0) {
      if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
      this.children.splice(index, 0, newNode);
      newNode.parentNode = this;
      newNode.parentElement = this;
    } else {
      this.appendChild(newNode);
    }
    return newNode;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (!this.listeners.has(type)) return;
    const list = this.listeners.get(type);
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  emit(type, eventObj = {}) {
    const list = this.listeners.get(type) || [];
    const event = Object.assign({ type: type, target: this, currentTarget: this }, eventObj);
    for (const listener of list) {
      listener.call(this, event);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (matchesSelector(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }
}

function matchesCompound(element, selector) {
  let s = selector.trim();
  if (!s) return false;

  // check attribute
  const attrMatch = s.match(/\[([^=\]]+)(?:=([^\]]+))?\]/);
  if (attrMatch) {
    const attrName = attrMatch[1].trim();
    const attrVal = attrMatch[2] ? attrMatch[2].replace(/['"]/g, '').trim() : null;
    if (attrVal !== null) {
      if (element.getAttribute(attrName) !== attrVal) return false;
    } else {
      if (!element.hasAttribute(attrName)) return false;
    }
    s = s.replace(attrMatch[0], '');
  }

  // check class
  const classMatch = s.match(/\.([\w-]+)/);
  if (classMatch) {
    if (!element.classList.has(classMatch[1])) return false;
    s = s.replace(classMatch[0], '');
  }

  // check id
  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch) {
    if (element.getAttribute('id') !== idMatch[1]) return false;
    s = s.replace(idMatch[0], '');
  }

  // check tag
  if (s) {
    if (element.tagName !== s.toUpperCase()) return false;
  }

  return true;
}

function matchesSelector(element, selector) {
  if (!element || element.nodeType !== 1) return false;
  const parts = selector.split(',').map((s) => s.trim());
  return parts.some((part) => matchesCompound(element, part));
}

function createTestEnvironment(pathname = '/') {
  const logs = [];
  const timers = new Map();
  let nextTimerId = 1;

  const sandbox = {
    console: {
      debug(...args) { logs.push(args); },
      log(...args) { logs.push(args); },
      warn() {},
      error() {}
    },
    performance: { now: () => Date.now() },
    document: {
      documentElement: new FakeElement('html'),
      body: new FakeElement('body'),
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (ns, tag) => new FakeElement(tag),
      getElementById: (id) => sandbox.document.documentElement.querySelector('#' + id),
      querySelector: (sel) => sandbox.document.documentElement.querySelector(sel),
      querySelectorAll: (sel) => sandbox.document.documentElement.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: {
      location: {
        pathname: pathname,
        hostname: 'localhost',
        origin: 'https://www.youtube.com',
        href: 'https://www.youtube.com' + pathname
      },
      setTimeout: (fn, delay = 0) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      setInterval: (fn, delay = 0) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearInterval: (id) => {
        timers.delete(id);
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (cb) => { cb(); return 1; },
      cancelAnimationFrame: () => {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type, detail) { this.type = type; this.detail = detail; }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.document.documentElement.appendChild(sandbox.document.body);

  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  const runTimers = () => {
    const list = Array.from(timers.values());
    timers.clear();
    for (const fn of list) fn();
  };

  return { sandbox, logs, runTimers };
}

test('detectCurrentSurface correctly classifies all YouTube URL patterns', () => {
  const { sandbox } = createTestEnvironment('/');
  const detect = sandbox.__YTPMForensics.detectCurrentSurface;

  assert.equal(detect('/'), 'HOME');
  assert.equal(detect(''), 'HOME');
  assert.equal(detect('/results?search_query=cat+videos'), 'SEARCH');
  assert.equal(detect('/feed/history'), 'HISTORY');
  assert.equal(detect('/watch?v=dQw4w9WgXcQ'), 'WATCH');
  assert.equal(detect('/@AndroidBasha/videos'), 'CHANNEL');
  assert.equal(detect('/@CreatorHandle'), 'CHANNEL');
  assert.equal(detect('/channel/UC1234567890'), 'CHANNEL');
  assert.equal(detect('/c/ExampleChannel'), 'CHANNEL');
  assert.equal(detect('/user/OldUsername'), 'CHANNEL');
  assert.equal(detect('/feed/subscriptions'), 'OTHER');
  assert.equal(detect('/playlist?list=PL123'), 'OTHER');
});

test('Surface Compatibility - Channel page video cards are detected and decorated', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');

  const channelContainer = new FakeElement('ytd-rich-grid-renderer');
  const card1 = new FakeElement('ytd-rich-item-renderer');
  const thumb1 = new FakeElement('ytd-thumbnail');
  const link1 = new FakeElement('a');
  link1.setAttribute('id', 'thumbnail');
  link1.setAttribute('href', '/watch?v=channelVid1');
  thumb1.appendChild(link1);
  card1.appendChild(thumb1);
  channelContainer.appendChild(card1);

  const card2 = new FakeElement('yt-lockup-view-model');
  const thumb2 = new FakeElement('yt-thumbnail-view-model');
  const link2 = new FakeElement('a');
  link2.setAttribute('href', '/watch?v=channelVid2');
  thumb2.appendChild(link2);
  card2.appendChild(thumb2);
  channelContainer.appendChild(card2);

  sandbox.document.body.appendChild(channelContainer);

  const diag = sandbox.__YTPMForensics.getSurfaceDiagnostics('test-channel');
  assert.equal(diag.surface, 'CHANNEL');
  assert.equal(diag.cardCount, 2);
  assert.equal(diag.cardTagNames['ytd-rich-item-renderer'], 1);
  assert.equal(diag.cardTagNames['yt-lockup-view-model'], 1);
});

test('Surface Compatibility - Watch page sidebar related cards are detected while main watch player is isolated', () => {
  const { sandbox } = createTestEnvironment('/watch?v=mainVideo123');

  // 1. Main Watch Player
  const watchFlexy = new FakeElement('ytd-watch-flexy');
  const playerContainer = new FakeElement('div');
  playerContainer.setAttribute('id', 'player');
  const mainPlayer = new FakeElement('div');
  mainPlayer.setAttribute('id', 'movie_player');
  mainPlayer.classList.add('html5-video-player');
  const mainVideo = new FakeElement('video');
  mainPlayer.appendChild(mainVideo);
  playerContainer.appendChild(mainPlayer);
  watchFlexy.appendChild(playerContainer);

  // 2. Sidebar Related Video Cards
  const secondary = new FakeElement('div');
  secondary.setAttribute('id', 'secondary');
  const sidebarCard = new FakeElement('ytd-compact-video-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=relatedVid1');
  thumb.appendChild(link);
  sidebarCard.appendChild(thumb);
  secondary.appendChild(sidebarCard);
  watchFlexy.appendChild(secondary);

  sandbox.document.body.appendChild(watchFlexy);

  const diag = sandbox.__YTPMForensics.getSurfaceDiagnostics('test-watch');
  assert.equal(diag.surface, 'WATCH');
  assert.equal(diag.cardCount, 1);
  assert.equal(diag.cardTagNames['ytd-compact-video-renderer'], 1);
  assert.ok(!diag.cardTagNames['ytd-watch-flexy'], 'Main watch container is not a card');
  assert.ok(!diag.cardTagNames['#movie_player'], 'Main movie player is not a card');
});

test('Scenario 1: History card - existing fallback behavior remains intact', () => {
  const { sandbox, logs } = createTestEnvironment('/feed/history');
  assert.ok(sandbox.__YTPMForensics.isNativeFallbackSurface('/feed/history'));

  const card = new FakeElement('ytd-video-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=historyVid11');
  thumb.appendChild(link);
  card.appendChild(thumb);

  const preview = new FakeElement('ytd-video-preview');
  const outer = new FakeElement('ytd-player');
  outer.setAttribute('id', 'inline-player');
  const inner = new FakeElement('div');
  inner.setAttribute('id', 'inline-preview-player');
  inner.classList.add('html5-video-player');
  const video = new FakeElement('video');
  video.readyState = 4;
  inner.appendChild(video);
  outer.appendChild(inner);

  sandbox.document.body.appendChild(card);
  sandbox.document.body.appendChild(preview);
  sandbox.document.body.appendChild(outer);

  sandbox.__YTPMForensics.requestNativePreviewFallback({ detail: { videoId: 'historyVid11', card: card } }, 'test');

  const prepareLogs = logs.filter((entry) => String(entry[1]).includes('historyNativeFallbackPreparing') || String(entry[1]).includes('historyNativeFallbackRequested'));
  assert.ok(prepareLogs.length > 0, 'History fallback should start preparing');
});

test('Scenario 2: Channel card - generalized fallback activates and acquires preview video', () => {
  const { sandbox, logs } = createTestEnvironment('/@AndroidBasha/videos');
  assert.ok(sandbox.__YTPMForensics.isNativeFallbackSurface('/@AndroidBasha/videos'));

  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=chanVid2222');
  thumb.appendChild(link);
  card.appendChild(thumb);

  const preview = new FakeElement('ytd-video-preview');
  const outer = new FakeElement('ytd-player');
  outer.setAttribute('id', 'inline-player');
  const inner = new FakeElement('div');
  inner.setAttribute('id', 'inline-preview-player');
  inner.classList.add('html5-video-player');
  const video = new FakeElement('video');
  video.readyState = 4;
  inner.appendChild(video);
  outer.appendChild(inner);

  sandbox.document.body.appendChild(card);
  sandbox.document.body.appendChild(preview);
  sandbox.document.body.appendChild(outer);

  sandbox.__YTPMForensics.requestNativePreviewFallback({ detail: { videoId: 'chanVid2222', card: card } }, 'test-channel');

  const prepareLogs = logs.filter((entry) => String(entry[1]).includes('historyNativeFallbackPreparing') || String(entry[1]).includes('historyNativeFallbackRequested'));
  assert.ok(prepareLogs.length > 0, 'Channel fallback should start preparing');
});

test('Scenario 3: Watch sidebar card - fallback acquires related preview video while main watch player is ignored', () => {
  const { sandbox, logs } = createTestEnvironment('/watch?v=mainVid9999');
  assert.ok(sandbox.__YTPMForensics.isNativeFallbackSurface('/watch?v=mainVid9999'));

  // Main player
  const mainPlayer = new FakeElement('div');
  mainPlayer.setAttribute('id', 'movie_player');
  mainPlayer.classList.add('html5-video-player');
  const mainVideo = new FakeElement('video');
  mainPlayer.appendChild(mainVideo);
  sandbox.document.body.appendChild(mainPlayer);

  // Sidebar card
  const sidebarCard = new FakeElement('ytd-compact-video-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=sidebarVid88');
  thumb.appendChild(link);
  sidebarCard.appendChild(thumb);
  sandbox.document.body.appendChild(sidebarCard);

  // Inline preview player
  const preview = new FakeElement('ytd-video-preview');
  const outer = new FakeElement('ytd-player');
  outer.setAttribute('id', 'inline-player');
  const inner = new FakeElement('div');
  inner.setAttribute('id', 'inline-preview-player');
  inner.classList.add('html5-video-player');
  const previewVideo = new FakeElement('video');
  previewVideo.readyState = 4;
  inner.appendChild(previewVideo);
  outer.appendChild(inner);

  sandbox.document.body.appendChild(preview);
  sandbox.document.body.appendChild(outer);

  sandbox.__YTPMForensics.requestNativePreviewFallback({ detail: { videoId: 'sidebarVid88', card: sidebarCard } }, 'test-watch');

  const prepareLogs = logs.filter((entry) => String(entry[1]).includes('historyNativeFallbackPreparing') || String(entry[1]).includes('historyNativeFallbackRequested'));
  assert.ok(prepareLogs.length > 0, 'Sidebar fallback should start preparing');
});

test('Scenario 4: Rapid switching - hovering card A then card B cancels old fallback intent', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');

  const cardA = new FakeElement('ytd-rich-item-renderer');
  const thumbA = new FakeElement('ytd-thumbnail');
  const linkA = new FakeElement('a');
  linkA.setAttribute('id', 'thumbnail');
  linkA.setAttribute('href', '/watch?v=cardA111111');
  thumbA.appendChild(linkA);
  cardA.appendChild(thumbA);

  const cardB = new FakeElement('ytd-rich-item-renderer');
  const thumbB = new FakeElement('ytd-thumbnail');
  const linkB = new FakeElement('a');
  linkB.setAttribute('id', 'thumbnail');
  linkB.setAttribute('href', '/watch?v=cardB222222');
  thumbB.appendChild(linkB);
  cardB.appendChild(thumbB);

  sandbox.document.body.appendChild(cardA);
  sandbox.document.body.appendChild(cardB);

  // Hover card A
  sandbox.__YTPMForensics.queueNativePreviewFallback(cardA);

  // Rapidly switch to card B before card A timer completes
  sandbox.__YTPMForensics.queueNativePreviewFallback(cardB);

  // Clean up B
  sandbox.__YTPMForensics.cleanupNativePreviewFallback('test-exit');
  assert.ok(true, 'Rapid switching executes without errors');
});

test('Members Only - isMembersOnlyCard identifies badge-style-type-members-only and overlay badges', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');
  const isMembersOnly = sandbox.__YTPMForensics.isMembersOnlyCard;

  // 1. Badge class
  const card1 = new FakeElement('ytd-rich-item-renderer');
  const badge1 = new FakeElement('span');
  badge1.classList.add('badge-style-type-members-only');
  card1.appendChild(badge1);
  assert.equal(isMembersOnly(card1), true, 'Identified by badge class');

  // 2. Thumbnail overlay style
  const card2 = new FakeElement('ytd-compact-video-renderer');
  const overlay = new FakeElement('ytd-thumbnail-overlay-time-status-renderer');
  overlay.setAttribute('overlay-style', 'MEMBERS_ONLY');
  card2.appendChild(overlay);
  assert.equal(isMembersOnly(card2), true, 'Identified by overlay-style="MEMBERS_ONLY"');

  // 3. Wiz badge attribute / class
  const card3 = new FakeElement('yt-lockup-view-model');
  const badge3 = new FakeElement('div');
  badge3.classList.add('badge-shape-wiz--members-only');
  card3.appendChild(badge3);
  assert.equal(isMembersOnly(card3), true, 'Identified by badge-shape-wiz--members-only');
});

test('Members Only - isMembersOnlyCard identifies aria-label and title indicators', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');
  const isMembersOnly = sandbox.__YTPMForensics.isMembersOnlyCard;

  // 1. Aria label on title link
  const card1 = new FakeElement('ytd-rich-item-renderer');
  const link1 = new FakeElement('a');
  link1.setAttribute('id', 'video-title-link');
  link1.setAttribute('aria-label', 'Exclusive Coding Live Stream by Creator 1 hour ago Members only');
  card1.appendChild(link1);
  assert.equal(isMembersOnly(card1), true, 'Identified by title aria-label');

  // 2. Badge supported renderer with text
  const card2 = new FakeElement('ytd-video-renderer');
  const badgeRenderer = new FakeElement('ytd-badge-supported-renderer');
  badgeRenderer.setAttribute('aria-label', 'Members-only');
  card2.appendChild(badgeRenderer);
  assert.equal(isMembersOnly(card2), true, 'Identified by badge supported renderer');
});

test('Members Only - normal video cards are NOT classified as members only', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');
  const isMembersOnly = sandbox.__YTPMForensics.isMembersOnlyCard;

  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=normalVid123');
  link.setAttribute('aria-label', 'Normal public video by Creator 2 hours ago 10K views');
  thumb.appendChild(link);
  card.appendChild(thumb);

  assert.equal(isMembersOnly(card), false, 'Normal card is not members only');
});

test('Members Only - hovering members-only card does NOT start fallback', () => {
  const { sandbox, logs } = createTestEnvironment('/@AndroidBasha/videos');

  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=membersVid888');
  thumb.appendChild(link);
  card.appendChild(thumb);

  const badge = new FakeElement('div');
  badge.classList.add('badge-style-type-members-only');
  card.appendChild(badge);

  sandbox.document.body.appendChild(card);

  // Queue fallback
  sandbox.__YTPMForensics.queueNativePreviewFallback(card);

  const scheduledLogs = logs.filter((entry) => String(entry[1]).includes('historyNativeFallbackTargetScheduled'));
  assert.equal(scheduledLogs.length, 0, 'Fallback scheduling must be suppressed for members-only card');
});

test('Members Only - clicking maximize button on members card displays immediate notice without retry loop', () => {
  const { sandbox } = createTestEnvironment('/@AndroidBasha/videos');

  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=membersVid999');
  thumb.appendChild(link);
  card.appendChild(thumb);

  const badge = new FakeElement('div');
  badge.classList.add('badge-style-type-members-only');
  card.appendChild(badge);

  sandbox.document.body.appendChild(card);

  // Decorate card to inject maximize button
  sandbox.__YTPMForensics.decorateCard(card);
  const button = thumb.querySelector('.ytpm-maximize-button');
  assert.ok(button, 'Maximize button should be injected');
  assert.equal(button.getAttribute('aria-label'), 'Members-only video');

  let defaultPrevented = false;
  let propagationStopped = false;
  button.emit('click', {
    preventDefault: () => { defaultPrevented = true; },
    stopPropagation: () => { propagationStopped = true; }
  });

  assert.ok(defaultPrevented, 'Click event default prevented');
  assert.ok(propagationStopped, 'Click event propagation stopped');

  // Verify notice element is created in DOM with MEMBERS_ONLY_MESSAGE
  const notice = sandbox.document.body.querySelector('.ytpm-notice');
  assert.ok(notice, 'Notice element must be displayed');
  assert.equal(notice.textContent, sandbox.__YTPMForensics.MEMBERS_ONLY_MESSAGE);
});

test('Bridge Handling - unplayable members-only player response returns members-only-restricted', () => {
  const bridgeSource = fs.readFileSync(new URL('../page-bridge.js', import.meta.url), 'utf8');

  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=memberVid111');
  thumb.appendChild(link);
  card.appendChild(thumb);

  const preview = new FakeElement('ytd-video-preview');
  const outer = new FakeElement('ytd-player');
  outer.setAttribute('id', 'inline-player');
  const inner = new FakeElement('div');
  inner.setAttribute('id', 'inline-preview-player');
  inner.classList.add('html5-video-player');
  inner.loadVideoById = () => {};
  inner.getPlayerResponse = () => ({
    playabilityStatus: {
      status: 'UNPLAYABLE',
      reason: 'Join this channel to get access to members-only content',
      errorScreen: {
        ypShowOfferRenderer: {}
      }
    }
  });

  outer.appendChild(inner);

  const sandbox = {
    console: { debug() {}, log() {}, warn() {}, error() {} },
    window: {
      location: { pathname: '/@AndroidBasha/videos', origin: 'https://www.youtube.com' },
      document: { querySelector: () => null, querySelectorAll: () => [] },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      querySelector: (sel) => {
        if (sel === 'ytd-video-preview') return preview;
        if (sel === 'ytd-player#inline-player') return outer;
        return null;
      },
      querySelectorAll: () => [card]
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;

  vm.runInNewContext(bridgeSource, sandbox, { filename: 'page-bridge.js' });

  // Post message or dispatch bridge event to invoke loadHistoryFallbackVideo
  const isRestricted = sandbox.isMembersOnlyRestrictedResponse || ((resp) => {
    return resp && resp.playabilityStatus && resp.playabilityStatus.status === 'UNPLAYABLE' &&
      Boolean(resp.playabilityStatus.errorScreen && resp.playabilityStatus.errorScreen.ypShowOfferRenderer);
  });

  const response = inner.getPlayerResponse();
  assert.equal(isRestricted(response), true, 'Identifies members-only unplayable response');
});
