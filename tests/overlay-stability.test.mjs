import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const contentSource = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  has(name) { return this.set.has(name); }
  toggle(name, force) {
    if (force === true) { this.set.add(name); return true; }
    if (force === false) { this.set.delete(name); return false; }
    if (this.set.has(name)) { this.set.delete(name); return false; }
    this.set.add(name); return true;
  }
  clear() { this.set.clear(); }
  [Symbol.iterator]() { return this.set[Symbol.iterator](); }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.nextSibling = null;
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = {
      setProperty(name, val) { this[name] = val; },
      removeProperty(name) { delete this[name]; }
    };
    this.dataset = {};
    this.listeners = new Map();
    this.isConnected = true;
    this.tabIndex = 0;
    this.isContentEditable = false;
    this.type = tagName.toLowerCase() === 'input' ? 'text' : undefined;
    this.value = '';
    this.currentTime = 0;
    this.duration = 100;
    this.paused = true;
    this.ended = false;
    this.muted = false;
    this.volume = 1;
    this.readyState = 4;
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

  replaceWith(newNode) {
    if (this.parentNode) {
      this.parentNode.insertBefore(newNode, this);
      this.parentNode.removeChild(this);
    }
  }

  replaceChildren(...newChildren) {
    while (this.children.length > 0) {
      this.removeChild(this.children[0]);
    }
    for (const child of newChildren) {
      this.appendChild(child);
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
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
    const list = (this.listeners.get(type) || []).slice();
    const event = Object.assign({ type: type, target: this, currentTarget: this }, eventObj);
    for (const listener of list) {
      listener.call(this, event);
    }
  }

  getBoundingClientRect() {
    return { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 };
  }

  focus() {}
  blur() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }

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

  const classMatch = s.match(/\.([\w-]+)/);
  if (classMatch) {
    if (!element.classList.has(classMatch[1])) return false;
    s = s.replace(classMatch[0], '');
  }

  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch) {
    if (element.getAttribute('id') !== idMatch[1]) return false;
    s = s.replace(idMatch[0], '');
  }

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
  const intervals = new Map();
  const windowListeners = new Map();
  let nextTimerId = 1;

  const sandbox = {
    console: {
      debug(...args) { logs.push(args); },
      log(...args) { logs.push(args); },
      warn() {},
      error() {}
    },
    performance: { now: () => Date.now() },
    crypto: {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      }
    },
    document: {
      activeElement: null,
      documentElement: new FakeElement('html'),
      body: new FakeElement('body'),
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (ns, tag) => new FakeElement(tag),
      getElementById: (id) => sandbox.document.documentElement.querySelector('#' + id),
      querySelector: (sel) => sandbox.document.documentElement.querySelector(sel),
      querySelectorAll: (sel) => sandbox.document.documentElement.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {},
      fullscreenElement: null,
      exitFullscreen: () => Promise.resolve()
    },
    window: {
      crypto: {
        getRandomValues: (arr) => {
          for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
          return arr;
        }
      },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
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
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (id) => {
        intervals.delete(id);
      },
      requestAnimationFrame: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      cancelAnimationFrame: (id) => {
        timers.delete(id);
      },
      addEventListener: (type, listener, options) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(listener);
      },
      removeEventListener: (type, listener, options) => {
        if (!windowListeners.has(type)) return;
        const list = windowListeners.get(type);
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      },
      emit: (type, eventObj = {}) => {
        const list = (windowListeners.get(type) || []).slice();
        const event = Object.assign({
          type: type,
          preventDefault: () => {},
          stopPropagation: () => {}
        }, eventObj);
        for (const listener of list) {
          listener(event);
        }
      },
      postMessage: () => {}
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type, opts = {}) {
        this.type = type;
        this.detail = opts.detail || {};
      }
    }
  };

  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.document.defaultView = sandbox.window;
  sandbox.document.documentElement.appendChild(sandbox.document.body);

  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  return { sandbox, logs, windowListeners, timers, intervals };
}

function createCardWithVideo(sandbox, videoId = 'testVid1234') {
  const card = new FakeElement('ytd-rich-item-renderer');
  const thumb = new FakeElement('ytd-thumbnail');
  const link = new FakeElement('a');
  link.setAttribute('id', 'thumbnail');
  link.setAttribute('href', '/watch?v=' + videoId);
  thumb.appendChild(link);
  card.appendChild(thumb);

  const preview = new FakeElement('ytd-video-preview');
  preview.setAttribute('active', 'true');
  const previewPlayer = new FakeElement('div');
  previewPlayer.setAttribute('id', 'inline-preview-player');
  previewPlayer.classList.add('html5-video-player');

  const video = new FakeElement('video');
  video.setAttribute('src', 'blob:https://www.youtube.com/test');
  video.src = 'blob:https://www.youtube.com/test';
  video.currentSrc = 'blob:https://www.youtube.com/test';
  video.currentTime = 5;
  video.duration = 120;
  video.volume = 0.8;
  video.muted = false;
  video.paused = false;
  video.readyState = 4;

  previewPlayer.appendChild(video);
  preview.appendChild(previewPlayer);
  thumb.appendChild(preview);

  sandbox.document.body.appendChild(card);
  return { card, preview, video };
}

test('Overlay Stability 1 - Overlay reopen does not duplicate keyboard handlers', () => {
  const { sandbox, windowListeners } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidReopen11');

  // Open overlay
  forensics.openPreviewOverlay(card, preview, video);
  const keydownListenersFirst = (windowListeners.get('keydown') || []).length;
  assert.equal(keydownListenersFirst, 1, 'Exactly one keydown listener registered on open');

  // Close overlay
  forensics.closePreviewOverlay();
  const keydownListenersClosed = (windowListeners.get('keydown') || []).length;
  assert.equal(keydownListenersClosed, 0, 'Keydown listener removed on close');

  // Reopen overlay
  forensics.openPreviewOverlay(card, preview, video);
  const keydownListenersSecond = (windowListeners.get('keydown') || []).length;
  assert.equal(keydownListenersSecond, 1, 'Exactly one keydown listener after reopen');

  forensics.closePreviewOverlay();
});

test('Overlay Stability 2 - Keyboard shortcuts still work when controls or sliders are focused and ignore text inputs', async () => {
  const { sandbox, windowListeners } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidShortcuts');

  forensics.openPreviewOverlay(card, preview, video);
  const active = forensics.getActiveOverlay();
  assert.ok(active, 'Overlay is active');

  // 1. Focus volume slider (input[type="range"]) -> Space / K toggles playback
  sandbox.document.activeElement = active.controls.volumeInput;
  active.video.paused = false;
  sandbox.window.emit('keydown', { key: 'k', code: 'KeyK', target: active.controls.volumeInput });
  assert.equal(active.userPaused, true, 'K toggles playback even when volume slider is focused');

  // 2. M toggles mute when volume slider is focused
  const initialMuted = active.video.muted;
  sandbox.window.emit('keydown', { key: 'm', code: 'KeyM', target: active.controls.volumeInput });
  assert.equal(active.video.muted, !initialMuted, 'M toggles mute when slider is focused');

  // 3. ArrowLeft / ArrowRight seeks when player frame is focused
  sandbox.document.activeElement = active.elements.frame;
  const initialTime = active.video.currentTime;
  sandbox.window.emit('keydown', { key: 'ArrowRight', code: 'ArrowRight', target: active.elements.frame });
  assert.equal(active.pendingSeekTime, initialTime + 5, 'ArrowRight sets pending seek target to +5s');

  // 4. Typing in a real text input (e.g. search bar) ignores shortcuts
  const textInput = new FakeElement('input');
  textInput.type = 'text';
  sandbox.document.body.appendChild(textInput);
  sandbox.document.activeElement = textInput;

  const timeBefore = active.video.currentTime;
  sandbox.window.emit('keydown', { key: 'ArrowRight', code: 'ArrowRight', target: textInput });
  assert.equal(active.video.currentTime, timeBefore, 'ArrowRight ignored in text input');

  // 5. Escape closes overlay
  sandbox.window.emit('keydown', { key: 'Escape', code: 'Escape', target: active.elements.frame });
  assert.equal(forensics.getActiveOverlay(), null, 'Escape closes overlay');
});

test('Overlay Stability 3 - Mouse movement restores controls', () => {
  const { sandbox } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidMouseRev');

  forensics.openPreviewOverlay(card, preview, video);
  const active = forensics.getActiveOverlay();

  // Hide controls manually
  active.elements.frame.classList.add('ytpm-controls-hidden');
  assert.ok(active.elements.frame.classList.has('ytpm-controls-hidden'), 'Controls hidden');

  // Mousemove on overlay container restores controls
  active.elements.overlay.emit('mousemove');
  assert.ok(!active.elements.frame.classList.has('ytpm-controls-hidden'), 'Controls restored on overlay mousemove');

  forensics.closePreviewOverlay();
});

test('Overlay Stability 4 - Hide timer resets correctly on user activity', () => {
  const { sandbox } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidHideTimer');

  forensics.openPreviewOverlay(card, preview, video);
  const active = forensics.getActiveOverlay();
  const timer1 = active.controlsHideTimer;
  assert.ok(timer1 > 0, 'Controls hide timer initially scheduled');

  // Pointer movement on frame
  active.elements.frame.emit('pointermove');
  const timer2 = active.controlsHideTimer;
  assert.ok(timer2 > 0, 'Controls hide timer rescheduled');
  assert.notEqual(timer1, timer2, 'Timer was refreshed');

  forensics.closePreviewOverlay();
});

test('Overlay Stability 5 - Volume state survives open/close lifecycle', () => {
  const { sandbox } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidVolState');
  video.volume = 0.65;
  video.muted = false;

  forensics.openPreviewOverlay(card, preview, video);
  const active = forensics.getActiveOverlay();

  // Change volume in overlay
  active.controls.volumeInput.value = '0.35';
  active.controls.volumeInput.emit('input');
  assert.equal(active.video.volume, 0.35, 'Volume adjusted in overlay');

  // Close overlay and verify volume state preserved on origin video
  forensics.closePreviewOverlay();
  assert.equal(video.volume, 0.35, 'Restored video preserves adjusted volume state');
  assert.equal(video.muted, false, 'Restored video preserves unmuted state');
});

test('Overlay Stability 6 - Closing overlay removes all listeners, timers, and active references', () => {
  const { sandbox, windowListeners } = createTestEnvironment('/');
  const forensics = sandbox.__YTPMForensics;
  const { card, preview, video } = createCardWithVideo(sandbox, 'vidFullClean');

  forensics.openPreviewOverlay(card, preview, video);
  const active = forensics.getActiveOverlay();
  assert.ok(active, 'Active overlay reference exists');
  assert.ok(active.controlsHideTimer > 0, 'Controls timer active');
  assert.equal((windowListeners.get('keydown') || []).length, 1, 'Keydown active');

  forensics.closePreviewOverlay();
  assert.equal(forensics.getActiveOverlay(), null, 'Active overlay reference cleared');
  assert.equal((windowListeners.get('keydown') || []).length, 0, 'Window keydown listener cleared');
  assert.equal(active.controlsHideTimer, 0, 'Controls timer cleared');
});
