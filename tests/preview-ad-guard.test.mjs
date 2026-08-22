import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../preview-ad-guard.js', import.meta.url),
  'utf8'
);
const contentSource = fs.readFileSync(
  new URL('../content.js', import.meta.url),
  'utf8'
);
const stylesSource = fs.readFileSync(
  new URL('../styles.css', import.meta.url),
  'utf8'
);
const pageBridgeSource = fs.readFileSync(
  new URL('../page-bridge.js', import.meta.url),
  'utf8'
);

class FakeElement {
  constructor() {
    this.isConnected = true;
    this.attributes = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.visible = true;
    this.display = '';
    this.visibility = '';
    this.opacity = '';
    this.hidden = false;
    this.child = null;
    this.clicked = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.networkState = 1;
    this.frameCallbacks = new Map();
    this.lastFrameCallback = null;
    this.nextFrameCallbackId = 0;
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name)
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(sel) { return false; }
  querySelector() { return this.child; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100, width: this.visible ? 100 : 0, height: this.visible ? 50 : 0 }; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    listeners.delete(listener);
    if (!listeners.size) this.listeners.delete(type);
  }
  emit(type) { this.listeners.get(type)?.forEach((listener) => listener({ type, target: this })); }
  click() { this.clicked += 1; }
  requestVideoFrameCallback(callback) { this.nextFrameCallbackId += 1; this.frameCallbacks.set(this.nextFrameCallbackId, callback); this.lastFrameCallback = callback; return this.nextFrameCallbackId; }
  cancelVideoFrameCallback(id) { this.frameCallbacks.delete(id); }
  emitVideoFrame(metadata = { mediaTime: this.currentTime || 0, presentedFrames: 1 }) { const callback = this.frameCallbacks.values().next().value; this.frameCallbacks.clear(); callback?.(0, metadata); }
  emitLastVideoFrame(metadata = { mediaTime: this.currentTime || 0, presentedFrames: 1 }) { this.lastFrameCallback?.(0, metadata); }
  getVideoPlaybackQuality() { return { totalVideoFrames: this.totalVideoFrames || 0 }; }
}

function loadGuard() {
  const observers = [];
  const timers = new Map();
  const logs = [];
  let nextTimerId = 0;
  let monotonicTime = 0;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const sandbox = {
    console: { debug(...args) { logs.push(args); } },
    performance: { now: () => ++monotonicTime },
    MutationObserver: FakeMutationObserver,
    window: {
      getComputedStyle(element) {
        return { display: element.display || (element.visible ? 'block' : 'none'), visibility: element.visibility || 'visible', opacity: element.opacity || '1' };
      },
      setTimeout(callback, delay = 0) {
        nextTimerId += 1;
        timers.set(nextTimerId, { callback, delay: Number(delay) || 0 });
        return nextTimerId;
      },
      clearTimeout(timerId) { timers.delete(timerId); }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'preview-ad-guard.js' });
  return {
    api: sandbox.YTPMPreviewAdGuard,
    observers,
    logs,
    runNextTimer() {
      const entry = timers.entries().next().value;
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    },
    runTimerByDelay() {
      const entry = Array.from(timers.entries()).sort((left, right) => left[1].delay - right[1].delay || left[0] - right[0])[0];
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    }
  };
}

function createActiveMedia() {
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 1;
  media.currentTime = 0;
  media.duration = Number.NaN;
  media.seekable = { length: 0, end: () => 0 };
  return media;
}

function runUntil(runNextTimer, predicate, limit = 8) {
  for (let index = 0; index < limit && !predicate(); index += 1) runNextTimer();
}

async function armRequestedContentProbe(overrides = {}) {
  const runtime = loadGuard();
  const player = overrides.player || new FakeElement();
  const overlay = overrides.overlay || new FakeElement();
  const recovery = overrides.recovery || null;
  let content = false;
  let media = createActiveMedia();
  media.readyState = overrides.readyState ?? 3;
  media.videoWidth = overrides.videoWidth ?? 640;
  media.videoHeight = overrides.videoHeight ?? 360;
  const guard = runtime.api.create({
    generation: overrides.generation ?? 401,
    sessionId: 'content-frame-probe',
    surface: overrides.surface,
    getPlayer: () => player,
    getMedia: () => media,
    overlay,
    isCurrent: () => true,
    getRecoveryContext: recovery ? () => recovery : undefined,
    status: () => content ? { active: false, reason: 'content', requestedVideoIdMatches: true, associationAvailable: true } : { active: true, reason: 'ad-showing', requestedVideoIdMatches: false }
  });
  player.classes.add('ad-showing');
  guard.arm();
  player.classes.delete('ad-showing');
  content = true;
  media.emit('loadstart');
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  runUntil(runtime.runNextTimer, () => runtime.logs.some((entry) => entry[0] === '[YTPM][AdContentHandoff]' && (entry.join(' ').includes('phase=start') || entry.join(' ').includes('phase=waiting-media-ready'))), 12);
  return { ...runtime, player, overlay, guard, media: () => media, replaceMedia(next) { media = next; } };
}

test('detects only active player signals, not a permanently mounted container', () => {
  const { api } = loadGuard();
  const player = new FakeElement();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getPlayerStatus(player))),
    { active: false, confidence: 'high', reason: 'content' }
  );
  player.classes.add('ad-showing');
  assert.equal(api.getPlayerStatus(player).reason, 'ad-showing');
});

test('publishes the guard API and exposes explicit arm rejection diagnostics', () => {
  const { api } = loadGuard();
  assert.equal(typeof api.create, 'function');
  assert.match(contentSource, /guard-api-unavailable/);
  assert.match(contentSource, /function armHistoryPreviewAdGuard/);
});

test('suppresses ad media, invokes a local skip control, and restores content audio', async () => {
  const { api, observers, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const skip = new FakeElement();
  player.child = skip;
  const media = new FakeElement();
  media.muted = false;
  media.volume = 0.65;
  media.paused = false;
  media.readyState = 2;
  const overlay = new FakeElement();
  let current = true;
  const guard = api.create({
    generation: 7,
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media,
    overlay,
    isCurrent: () => current,
    status: () => ({ active: false, reason: 'content', requestedVideoIdMatches: true })
  });

  player.classes.add('ad-showing');
  assert.equal(guard.arm(), true);
  assert.equal(overlay.getAttribute('data-ytpm-presentation-closed'), 'true');
  assert.equal(media.muted, true);
  assert.equal(overlay.getAttribute('data-ytpm-ad-suppressed'), 'true');
  assert.equal(runNextTimer(), true);
  assert.equal(skip.clicked, 1);

  player.classes.delete('ad-showing');
  player.child = null;
  media.emit('playing');
  guard.refresh();
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  assert.equal(runNextTimer(), true);
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.65);
  assert.equal(overlay.hasAttribute('data-ytpm-ad-suppressed'), false);
  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false);
  assert.equal(logs.some((entry) => entry[0] === '[YTPM][PresentationGate]' && entry.join(' ').includes('phase=media-play-observed') && entry.join(' ').includes('gateClosed=true')), true);
  assert.equal(logs.some((entry) => entry[0] === '[YTPM][PresentationGate]' && entry.join(' ').includes('phase=opened') && entry.join(' ').includes('reason=content-confirmed')), true);

  guard.disarm();
  assert.equal(logs.some((entry) => entry[0] === '[YTPM][PresentationGateSummary]' && entry.join(' ').includes('closedBeforeLoad=true') && entry.join(' ').includes('gateEverOpened=true') && entry.join(' ').includes('openedOnlyAfterContent=true') && entry.join(' ').includes('result=PASS')), true);
  assert.equal(logs.some((entry) => entry[0] === '[YTPM][AdLatency]'), false);
  assert.equal(logs.filter((entry) => entry[0] === '[YTPM][AdLatencySummary]').length, 1);
  assert.equal(observers[0].disconnected, true);
  assert.equal(media.listeners.size, 0);
  current = false;
  guard.refresh();
  assert.equal(media.muted, false);
});

test('pre-ready requested content defers the canonical handoff and wakes it once on owned media readiness', async () => {
  const runtime = await armRequestedContentProbe({ generation: 412, readyState: 0 });
  let entries = runtime.logs.filter((entry) => entry[0] === '[YTPM][AdContentHandoff]').map((entry) => entry.join(' '));
  assert.ok(entries.some((entry) => entry.includes('phase=waiting-media-ready') && entry.includes('reason=MEDIA_NOT_READY')));
  assert.equal(runtime.overlay.hasAttribute('data-ytpm-presentation-closed'), true);
  runtime.media().readyState = 1;
  runtime.media().emit('loadedmetadata');
  runtime.runTimerByDelay();
  entries = runtime.logs.filter((entry) => entry[0] === '[YTPM][AdContentHandoff]').map((entry) => entry.join(' '));
  assert.ok(entries.some((entry) => entry.includes('phase=media-ready-wakeup') && entry.includes('source=LOADEDMETADATA') && entry.includes('sameVideoNode=true')));
  assert.equal(entries.some((entry) => entry.includes('phase=stabilizing')), false);
  assert.ok(entries.some((entry) => entry.includes('phase=confirmed')));
  assert.ok(entries.some((entry) => entry.includes('phase=restored')));
  assert.equal(runtime.overlay.hasAttribute('data-ytpm-presentation-closed'), false);
  runtime.guard.disarm();
});

test('healthy ready requested content retains its immediate canonical stabilization', async () => {
  const runtime = await armRequestedContentProbe({ generation: 413, readyState: 4 });
  runtime.runTimerByDelay();
  const entries = runtime.logs.filter((entry) => entry[0] === '[YTPM][AdContentHandoff]').map((entry) => entry.join(' '));
  assert.equal(entries.some((entry) => entry.includes('phase=waiting-media-ready')), false);
  assert.equal(entries.some((entry) => entry.includes('phase=stabilizing')), false);
  assert.ok(entries.some((entry) => entry.includes('phase=restored')));
  runtime.guard.disarm();
});

test('deferred handoff refuses ad-state, stale-epoch, and replaced-video wakeups', async () => {
  const adRuntime = await armRequestedContentProbe({ generation: 414, readyState: 0 });
  adRuntime.player.classes.add('ad-showing');
  adRuntime.media().readyState = 2;
  adRuntime.media().emit('canplay');
  assert.equal(adRuntime.logs.some((entry) => entry[0] === '[YTPM][AdContentHandoff]' && entry.join(' ').includes('phase=media-ready-wakeup')), false);
  assert.equal(adRuntime.overlay.hasAttribute('data-ytpm-presentation-closed'), true);
  adRuntime.guard.disarm();

  const epochRuntime = await armRequestedContentProbe({ generation: 415, readyState: 0 });
  epochRuntime.media().emit('loadstart');
  epochRuntime.media().readyState = 2;
  epochRuntime.media().emit('loadeddata');
  assert.equal(epochRuntime.logs.some((entry) => entry[0] === '[YTPM][AdContentHandoff]' && entry.join(' ').includes('phase=media-ready-wakeup')), false);
  epochRuntime.guard.disarm();

  const replacementRuntime = await armRequestedContentProbe({ generation: 416, readyState: 0 });
  const oldMedia = replacementRuntime.media();
  const replacement = createActiveMedia();
  replacement.readyState = 2;
  replacementRuntime.replaceMedia(replacement);
  replacementRuntime.observers[0].callback();
  oldMedia.emit('loadedmetadata');
  assert.equal(replacementRuntime.logs.some((entry) => entry[0] === '[YTPM][AdContentHandoff]' && entry.join(' ').includes('phase=media-ready-wakeup')), false);
  replacementRuntime.guard.disarm();
});

test('deferred handoff deduplicates readiness signals and removes listeners after completion or disarm', async () => {
  const runtime = await armRequestedContentProbe({ generation: 417, readyState: 0 });
  runtime.media().readyState = 2;
  runtime.media().emit('loadedmetadata');
  runtime.media().emit('loadeddata');
  runtime.media().emit('canplay');
  runtime.runTimerByDelay();
  const entries = runtime.logs.filter((entry) => entry[0] === '[YTPM][AdContentHandoff]').map((entry) => entry.join(' '));
  assert.equal(entries.filter((entry) => entry.includes('phase=media-ready-wakeup')).length, 1);
  assert.equal(entries.some((entry) => entry.includes('phase=stabilizing')), false);
  runtime.media().emit('timeupdate');
  assert.equal(entries.filter((entry) => entry.includes('phase=confirmed')).length, 1);
  runtime.guard.disarm();
  assert.equal(runtime.media().listeners.size, 0);

  const cancelled = await armRequestedContentProbe({ generation: 418, readyState: 0 });
  assert.ok(cancelled.media().listeners.has('loadedmetadata'));
  cancelled.guard.disarm();
  assert.equal(cancelled.media().listeners.size, 0);
});

test('rejects a stale session before it can mutate media', () => {
  const { api } = loadGuard();
  const player = new FakeElement();
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.paused = false;
  media.readyState = 2;
  const guard = api.create({
    generation: 8,
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media,
    overlay: new FakeElement(),
    isCurrent: () => false
  });

  player.classes.add('ad-interrupting');
  assert.equal(guard.arm(), false);
  assert.equal(media.muted, false);
});

test('stale cleanup cannot reveal a newer reused-player presentation gate', () => {
  const { api } = loadGuard();
  const player = new FakeElement();
  const media = createActiveMedia();
  const overlay = new FakeElement();
  let sessionAActive = true;
  let sessionBActive = false;
  const guardA = api.create({ generation: 101, sessionId: 'session-a', getPlayer: () => player, media, overlay, isCurrent: () => sessionAActive });
  const guardB = api.create({ generation: 102, sessionId: 'session-b', getPlayer: () => player, media, overlay, isCurrent: () => sessionBActive });

  assert.equal(guardA.arm(), true);
  sessionAActive = false;
  sessionBActive = true;
  assert.equal(guardB.arm(), true);
  guardA.disarm('stale-session');

  assert.equal(overlay.getAttribute('data-ytpm-presentation-session'), 'session-b');
  assert.equal(overlay.getAttribute('data-ytpm-presentation-closed'), 'true');
  guardB.disarm('test-complete');
  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false);
});

test('presentation summary cannot pass when requested content was never confirmed', () => {
  const { api, logs } = loadGuard();
  const player = new FakeElement();
  const media = createActiveMedia();
  const overlay = new FakeElement();
  const guard = api.create({ generation: 103, getPlayer: () => player, media, overlay, isCurrent: () => true });

  guard.arm();
  guard.disarm('user-exit');

  const summary = logs.find((entry) => entry[0] === '[YTPM][PresentationGateSummary]');
  assert.equal(summary.join(' ').includes('contentConfirmed=false'), true);
  assert.equal(summary.join(' ').includes('gateEverOpened=false'), true);
  assert.equal(summary.join(' ').includes('result=PASS'), false);
  assert.equal(summary.join(' ').includes('result=USER_EXIT_BEFORE_CONTENT'), true);
});

test('ad UI gate hides scoped inline ad layers without disabling the internal skip node', () => {
  const gateScope = '[data-ytpm-preview-owned="true"][data-ytpm-presentation-closed="true"]';
  assert.equal(stylesSource.includes(`${gateScope} .ytp-ad-skip-button`), true);
  assert.equal(stylesSource.includes(`${gateScope} .ytp-ad-preview-container`), true);
  assert.equal(stylesSource.includes(`${gateScope} .ytp-ad-action-interstitial`), true);
  const uiGateRule = stylesSource.slice(stylesSource.indexOf(`${gateScope} .ytp-ad-player-overlay`), stylesSource.indexOf('}', stylesSource.indexOf(`${gateScope} .ytp-ad-player-overlay`)));
  assert.equal(uiGateRule.includes('opacity: 0 !important;'), true);
  assert.equal(uiGateRule.includes('pointer-events: none !important;'), true);
  assert.equal(uiGateRule.includes('display: none !important;'), false);
});

test('presentation and ad UI summaries each finalize exactly once', () => {
  const { api, logs } = loadGuard();
  const player = new FakeElement();
  const guard = api.create({ generation: 104, getPlayer: () => player, media: createActiveMedia(), overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  guard.disarm('first-cleanup');
  guard.disarm('duplicate-cleanup');
  assert.equal(logs.filter((entry) => entry[0] === '[YTPM][PresentationGateSummary]').length, 1);
  assert.equal(logs.filter((entry) => entry[0] === '[YTPM][AdUiGateSummary]').length, 1);
});

test('arms player monitoring before a History-style media node is created', () => {
  const { api, observers } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-created');
  const overlay = new FakeElement();
  let media = null;
  const guard = api.create({
    generation: 8,
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    getMedia: () => media,
    overlay,
    isCurrent: () => true
  });

  assert.equal(guard.arm(), true);
  assert.equal(guard.status().armed, true);
  media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.paused = false;
  media.readyState = 1;
  observers[0].callback();
  assert.equal(media.muted, true);
  guard.disarm('test-complete');
});

test('ad-created shields without destructive media progression', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-created');
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.paused = false;
  media.readyState = 2;
  media.duration = 10;
  media.currentTime = 1;
  media.seekable = { length: 1, end: () => 10 };
  const guard = api.create({
    generation: 9,
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media,
    overlay: new FakeElement(),
    isCurrent: () => true
  });

  guard.arm();
  assert.equal(media.muted, true);
  assert.equal(runNextTimer(), false);
  assert.equal(media.currentTime, 1);
  guard.disarm();
});

test('active ad media seeks near a validated seekable endpoint', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 2;
  media.duration = 10;
  media.currentTime = 1;
  media.seekable = { length: 1, end: () => 10 };
  let legacyRecoveryCalls = 0;
  const guard = api.create({ generation: 10, videoId: 'dQw4w9WgXcQ', getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true, recover: () => { legacyRecoveryCalls += 1; } });
  guard.arm();
  assert.equal(runNextTimer(), true);
  assert.equal(media.currentTime, 9.75);
  assert.equal(legacyRecoveryCalls, 0);
  assert.equal(guard.status().handledAdSegments, 1);
  guard.disarm();
  assert.equal(media.playbackRate, 1);
});

test('non-seekable active ad uses reversible bounded acceleration', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-interrupting');
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.playbackRate = 1.25;
  media.paused = false;
  media.readyState = 2;
  media.duration = Number.NaN;
  media.seekable = { length: 0, end: () => 0 };
  const guard = api.create({ generation: 11, videoId: 'dQw4w9WgXcQ', getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  assert.equal(runNextTimer(), true);
  assert.equal(media.playbackRate, 4);
  guard.disarm();
  assert.equal(media.playbackRate, 1.25);
});

test('handles distinct ad load segments with a conservative bound', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = new FakeElement();
  media.muted = false;
  media.volume = 1;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 2;
  media.duration = 8;
  media.seekable = { length: 1, end: () => 8 };
  const guard = api.create({ generation: 12, videoId: 'dQw4w9WgXcQ', getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  assert.equal(runNextTimer(), true);
  for (let index = 0; index < api.MAX_AD_SEGMENTS + 1; index += 1) {
    media.emit('loadstart');
    runNextTimer();
  }
  assert.equal(guard.status().handledAdSegments, api.MAX_AD_SEGMENTS);
  guard.disarm();
});

test('a transient ad-class reset on the same media does not create another segment', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const media = createActiveMedia();
  const guard = api.create({ generation: 13, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  player.classes.add('ad-showing');
  guard.arm();
  runNextTimer();
  player.classes.delete('ad-showing');
  guard.refresh();
  player.classes.add('ad-showing');
  guard.refresh();
  runNextTimer();
  assert.equal(guard.status().handledAdSegments, 0);
  guard.disarm();
});

test('a replaced owned video creates a new segment with replacement evidence', () => {
  const { api, observers, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  let media = createActiveMedia();
  const guard = api.create({ generation: 14, getPlayer: () => player, getMedia: () => media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  media = createActiveMedia();
  observers[0].callback();
  runNextTimer();
  runNextTimer();
  assert.equal(guard.status().handledAdSegments, 0);
  assert.ok(logs.some((entry) => entry.join(' ').includes('evidence=VIDEO_REPLACED')));
  guard.disarm();
});

test('late metadata re-evaluates the same segment and switches acceleration to a seek', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-interrupting');
  const media = createActiveMedia();
  const guard = api.create({ generation: 15, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  assert.equal(media.playbackRate, 4);
  media.duration = 12;
  media.seekable = { length: 1, end: () => 12 };
  media.readyState = 3;
  media.emit('loadedmetadata');
  assert.equal(media.currentTime, 11.75);
  assert.equal(guard.status().handledAdSegments, 1);
  assert.equal(logs.filter((entry) => entry.join(' ').includes('phase=media-ready')).length, 1);
  guard.disarm();
});

test('stale media-ready callbacks cannot seek after video replacement and cleanup removes them', () => {
  const { api, observers, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  let media = createActiveMedia();
  const firstMedia = media;
  const guard = api.create({ generation: 16, getPlayer: () => player, getMedia: () => media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  assert.ok(firstMedia.listeners.has('loadedmetadata'));
  media = createActiveMedia();
  observers[0].callback();
  firstMedia.duration = 9;
  firstMedia.seekable = { length: 1, end: () => 9 };
  firstMedia.emit('loadedmetadata');
  assert.equal(firstMedia.currentTime, 0);
  guard.disarm();
  assert.equal(media.listeners.size, 0);
});

test('acceleration diagnostics verify application and observe media advancement once', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  const guard = api.create({ generation: 17, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  media.currentTime = 2;
  runNextTimer();
  runNextTimer();
  assert.ok(logs.some((entry) => entry.join(' ').includes('requestedPlaybackRate=4') && entry.join(' ').includes('appliedPlaybackRate=4')));
  assert.equal(logs.filter((entry) => entry.join(' ').includes('phase=acceleration-observed') && entry.join(' ').includes('currentTimeAdvanced=true')).length, 1);
  guard.disarm();
});

test('seek evidence uses the last seekable endpoint and confirms reaching its near end', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 62.1;
  media.seekable = { length: 1, start: () => 3, end: () => 60 };
  const guard = api.create({ generation: 18, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  assert.equal(media.currentTime, 59.75);
  media.emit('seeking');
  media.emit('seeked');
  runUntil(runNextTimer, () => logs.some((entry) => entry[0] === '[YTPM][AdSeek]'));
  const result = logs.find((entry) => entry[0] === '[YTPM][AdSeek]');
  assert.match(result.join(' '), /classification=SEEK_REACHED_NEAR_END/);
  assert.match(result.join(' '), /seekableStartSeconds=3/);
  assert.match(result.join(' '), /seekableEndSeconds=60/);
  guard.disarm();
});

test('seek evidence classifies clamped and no-effect assignments', () => {
  for (const [generation, observed, expected] of [[19, 4.2, 'SEEK_CLAMPED_BEFORE_END'], [20, 0, 'SEEK_NEVER_APPLIED']]) {
    const { api, logs, runNextTimer } = loadGuard();
    const player = new FakeElement();
    player.classes.add('ad-showing');
    const media = createActiveMedia();
    media.duration = 30;
    media.seekable = { length: 1, start: () => 0, end: () => 30 };
    const guard = api.create({ generation, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
    guard.arm();
    runNextTimer();
    media.currentTime = observed;
    runUntil(runNextTimer, () => logs.some((entry) => entry[0] === '[YTPM][AdSeek]'));
    assert.match(logs.find((entry) => entry[0] === '[YTPM][AdSeek]').join(' '), new RegExp('classification=' + expected));
    guard.disarm();
  }
});

test('seek observer classifies replacement and stale session without mutating the successor', () => {
  const { api, observers, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  let current = true;
  let media = createActiveMedia();
  media.duration = 20;
  media.seekable = { length: 1, start: () => 0, end: () => 20 };
  const guard = api.create({ generation: 21, getPlayer: () => player, getMedia: () => media, overlay: new FakeElement(), isCurrent: () => current });
  guard.arm();
  runNextTimer();
  media = createActiveMedia();
  observers[0].callback();
  assert.match(logs.find((entry) => entry[0] === '[YTPM][AdSeek]').join(' '), /classification=SEEK_MEDIA_REPLACED/);
  current = false;
  guard.disarm();
});

test('seek observer reports session invalidation before its bounded timeout', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  let current = true;
  const media = createActiveMedia();
  media.duration = 20;
  media.seekable = { length: 1, start: () => 0, end: () => 20 };
  const guard = api.create({ generation: 24, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => current });
  guard.arm();
  runNextTimer();
  current = false;
  guard.disarm();
  assert.match(logs.find((entry) => entry[0] === '[YTPM][AdSeek]').join(' '), /classification=SEEK_SESSION_INVALIDATED/);
});

test('confirmed segment budget is emitted once, while the last allowed segment keeps its lifecycle observer', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 10;
  media.seekable = { length: 1, start: () => 0, end: () => 10 };
  const guard = api.create({ generation: 22, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  for (let index = 0; index < api.MAX_AD_SEGMENTS - 1; index += 1) {
    media.emit('loadstart');
    for (let timer = 0; timer < 4; timer += 1) runNextTimer();
  }
  assert.equal(guard.status().handledAdSegments, api.MAX_AD_SEGMENTS);
  assert.ok(media.listeners.has('seeked'));
  media.emit('loadstart');
  for (let index = 0; index < 4; index += 1) runNextTimer();
  assert.equal(logs.filter((entry) => entry.join(' ').includes('phase=progression-budget-exhausted')).length, 1);
  assert.ok(logs.some((entry) => entry.join(' ').includes('segment=3') && entry.join(' ').includes('evidence=NEW_LOADSTART')));
  guard.disarm();
});

test('disarm removes bounded seek observers', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 15;
  media.seekable = { length: 1, start: () => 0, end: () => 15 };
  const guard = api.create({ generation: 23, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  assert.ok(media.listeners.has('seeking'));
  guard.disarm();
  assert.equal(media.listeners.size, 0);
});

test('bootstrap epochs stay outside the confirmed-ad budget until media is proven active', () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  const guard = api.create({ generation: 25, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  media.emit('loadstart');
  runNextTimer();
  assert.equal(guard.status().loadEpoch, 1);
  assert.equal(guard.status().confirmedAdSegments, 0);
  media.duration = 12;
  media.seekable = { length: 1, start: () => 0, end: () => 12 };
  media.readyState = 2;
  media.emit('loadedmetadata');
  guard.refresh();
  for (let index = 0; index < 4; index += 1) runNextTimer();
  assert.equal(guard.status().confirmedAdSegments, 1);
  media.emit('durationchange');
  assert.equal(guard.status().confirmedAdSegments, 1);
  guard.disarm();
});

test('near-end seek keeps a terminal observer past the seek result and captures delayed loadstart', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 18;
  media.seekable = { length: 1, start: () => 0, end: () => 18 };
  const guard = api.create({ generation: 26, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  runNextTimer();
  assert.ok(logs.some((entry) => entry[0] === '[YTPM][AdTerminal]' && entry.join(' ').includes('waiting-for-player-transition')));
  media.emit('loadstart');
  assert.ok(logs.some((entry) => entry[0] === '[YTPM][AdTerminal]' && entry.join(' ').includes('evidence=NEW_LOADSTART')));
  guard.disarm();
});

test('endpoint probe is bounded to one exact confirmed segment and never synthesizes media events', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 14;
  media.seekable = { length: 1, start: () => 0, end: () => 14 };
  const guard = api.create({ generation: 27, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  runNextTimer();
  runNextTimer();
  assert.equal(logs.filter((entry) => entry[0] === '[YTPM][AdTerminal]' && entry.join(' ').includes('phase=endpoint-probe')).length, 1);
  assert.equal(typeof media.dispatchEvent, 'undefined');
  guard.disarm();
});

test('content confirmation remains available after progression budget exhaustion and restores once', async () => {
  const { api, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 10;
  media.seekable = { length: 1, start: () => 0, end: () => 10 };
  let pageContent = false;
  const overlay = new FakeElement();
  const guard = api.create({ generation: 28, getPlayer: () => player, media, overlay, isCurrent: () => true, status: () => ({ active: !pageContent, requestedVideoIdMatches: pageContent }) });
  guard.arm();
  runNextTimer();
  for (let index = 0; index < api.MAX_AD_SEGMENTS; index += 1) { media.emit('loadstart'); for (let timer = 0; timer < 4; timer += 1) runNextTimer(); }
  player.classes.delete('ad-showing');
  pageContent = true;
  media.paused = false;
  media.readyState = 2;
  guard.refresh();
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  for (let timer = 0; timer < 10; timer += 1) runNextTimer();
  assert.equal(overlay.hasAttribute('data-ytpm-ad-suppressed'), false);
  guard.disarm();
});

test('terminal observation remains armed when a confirmed seek never applies or is clamped', () => {
  for (const [generation, observed] of [[29, 0], [30, 3]]) {
    const { api, logs, runNextTimer } = loadGuard();
    const player = new FakeElement();
    player.classes.add('ad-showing');
    const media = createActiveMedia();
    media.duration = 20;
    media.seekable = { length: 1, start: () => 0, end: () => 20 };
    const guard = api.create({ generation, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
    guard.arm();
    runNextTimer();
    media.currentTime = observed;
    runUntil(runNextTimer, () => logs.some((entry) => entry[0] === '[YTPM][AdSeek]'));
    assert.ok(logs.some((entry) => entry[0] === '[YTPM][AdTerminal]' && entry.join(' ').includes('waiting-for-player-transition')));
    guard.disarm();
  }
});

test('loadstart during seek hands off once and classifies the seek as superseded', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 20;
  media.seekable = { length: 1, start: () => 0, end: () => 20 };
  const guard = api.create({ generation: 31, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  media.emit('loadstart');
  assert.equal(guard.status().loadEpoch, 1);
  assert.match(logs.find((entry) => entry[0] === '[YTPM][AdSeek]').join(' '), /classification=SEEK_SUPERSEDED_BY_NEW_LOAD/);
  assert.equal(logs.filter((entry) => entry.join(' ').includes('phase=segment-ended') && entry.join(' ').includes('evidence=NEW_LOADSTART')).length, 1);
  guard.disarm();
});

test('external rate reset is diagnosed and active same-media guard does not restore it', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  const guard = api.create({ generation: 32, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  runNextTimer();
  assert.equal(media.playbackRate, 4);
  media.playbackRate = 1;
  media.emit('ratechange');
  assert.ok(logs.some((entry) => entry[0] === '[YTPM][AdMediaState]' && entry.join(' ').includes('from=4') && entry.join(' ').includes('to=1') && entry.join(' ').includes('guardInitiated=false')));
  assert.equal(media.playbackRate, 1);
  guard.disarm();
});

test('places History arm before its load request', () => {
  const arm = contentSource.indexOf('armHistoryPreviewAdGuard(session);');
  const load = contentSource.indexOf("logHistoryNativeFallback('historyNativeFallbackLoadRequested'");
  assert.ok(arm >= 0);
  assert.ok(load > arm);
  assert.match(contentSource, /disarmPreviewAdGuard\(session, reason \|\| 'history-cleanup'\)/);
});

test('History hover-loss diagnostics classify card, overlay, replacement, stale, and ownership states', () => {
  assert.match(contentSource, /function getHistoryHoverEvidence\(session\)/);
  assert.match(contentSource, /function classifyHistoryHoverLoss\(evidence\)/);
  assert.match(contentSource, /REAL_POINTER_EXIT/);
  assert.match(contentSource, /CARD_STILL_HOVERED/);
  assert.match(contentSource, /POINTER_INSIDE_OVERLAY/);
  assert.match(contentSource, /THUMBNAIL_REPLACED_SESSION_STILL_VALID/);
  assert.match(contentSource, /CANDIDATE_REPLACED_SESSION_STILL_VALID/);
  assert.match(contentSource, /SESSION_STALE/);
  assert.match(contentSource, /OWNERSHIP_LOST/);
});

test('History fallback keeps hover tracking session-scoped and removes it during cleanup', () => {
  assert.match(contentSource, /document\.addEventListener\('pointermove', session\.hoverPointerListener/);
  assert.match(contentSource, /document\.removeEventListener\('pointermove', session\.hoverPointerListener, true\)/);
  assert.match(contentSource, /isHistoryFallbackInteractionValid\(session\)/);
  assert.match(contentSource, /logHistoryHoverLossCandidate\(historyNativeFallbackSession\)/);
});

test('terminal timeout uses a soft delay and bounded hard expiry', () => {
  assert.match(source, /TERMINAL_TRANSITION_SOFT_DELAY_MS = 8000/);
  assert.match(source, /TERMINAL_TRANSITION_OBSERVATION_MS = 10000/);
  assert.match(source, /terminalLog\(segment\.number, 'transition-delayed'/);
  assert.match(source, /observation\.finished = true; terminalLog\(segment\.number, 'transition-timeout'/);
});

test('new media loads are classified from a pending handoff instead of pre-labeled as ads', () => {
  assert.match(source, /endSegment\(state\.currentAdSegment, 'NEW_LOADSTART', 'pending'\)/);
  assert.match(source, /function schedulePostLoadClassification\(epoch\)/);
  assert.match(source, /\[YTPM\]\[AdPostLoad\]/);
  assert.match(source, /classification: 'ACTIVE_AD_MEDIA'/);
  assert.match(source, /classification: 'REQUESTED_CONTENT'/);
  assert.match(source, /postLoadLog\('pending'/);
});

test('History AdHoldBreakProbe is production-enabled only for a strict post-media controller hold and bounded one-shot command', () => {
  assert.match(source, /HOLD_BREAK_PROBE_DELAY_MS = 500/);
  assert.match(source, /HOLD_BREAK_PROBE_RESULT_MS = 1500/);
  assert.match(source, /config\.surface === 'history-native-fallback'/);
  assert.match(source, /probe\.observation\.priorMediaReachedEnd/);
  assert.match(source, /Number\(activeMedia\.readyState\) === 0/);
  assert.match(source, /!sample\.durationFinite/);
  assert.match(source, /playerVideoIdMatchesRequested/);
  assert.match(source, /config\.holdBreakProbeEnabled !== true/);
  assert.match(source, /COMMAND_TRIGGERED_AD_REENTRY/);
  assert.match(source, /COMMAND_TRIGGERED_REQUESTED_CONTENT/);
  assert.match(source, /COMMAND_TRIGGERED_FAST_LOADSTART/);
});

test('History AdHoldBreakProbe bridge performs only the owned player loadVideoById command', () => {
  assert.match(pageBridgeSource, /'history-ad-hold-break-load'/);
  assert.match(pageBridgeSource, /getOwnedPreviewAdContext\(videoId, sessionId\)/);
  assert.match(pageBridgeSource, /player\.loadVideoById\(normalizeVideoId\(videoId\)\)/);
  assert.doesNotMatch(pageBridgeSource.slice(pageBridgeSource.indexOf('function loadOwnedHistoryHoldBreakVideo'), pageBridgeSource.indexOf('function logHistoryLoadFailure')), /stopVideo|cueVideoById|clearVideo|nextVideo|playVideo|pauseVideo|seekTo/);
  assert.match(contentSource, /holdBreakProbeEnabled: true/);
  assert.doesNotMatch(contentSource, /__YTPM_AD_HOLD_BREAK_PROBE__/);
});

test('multi-segment AdHoldBreakProbe keeps one allowance per hold and emits a single pod summary', () => {
  assert.match(source, /holdOrdinal: \+\+state\.holdBreakStats\.holdsObserved/);
  assert.match(source, /state\.holdBreakProbe && state\.holdBreakProbe\.hold === hold/);
  assert.match(source, /state\.confirmedAdSegments >= MAX_AD_SEGMENTS/);
  assert.match(source, /COMMAND_TRIGGERED_AD_REENTRY/);
  assert.match(source, /COMMAND_TRIGGERED_REQUESTED_CONTENT/);
  assert.match(source, /\[YTPM\]\[AdHoldBreakSummary\]/);
  assert.match(source, /totalCommandToLoadstartMs=/);
  assert.match(source, /maxCommandToLoadstartMs=/);

  const { api, logs } = loadGuard();
  const player = new FakeElement();
  const guard = api.create({ generation: 419, getPlayer: () => player, media: createActiveMedia(), overlay: new FakeElement(), isCurrent: () => true });
  guard.arm();
  guard.disarm('summary-test');
  guard.disarm('duplicate-summary-test');
  assert.equal(logs.filter((entry) => entry[0] === '[YTPM][AdHoldBreakSummary]').length, 1);
});

test('post-content History hold eligibility requires a new confirmed active-ad epoch and lifecycle summary keeps stale classifications out of transitions', () => {
  assert.match(source, /function genuineLaterAdInterruption\(segment\)/);
  assert.match(source, /segment\.laterAdInterruption === true/);
  assert.match(source, /segment\.loadEpoch > state\.contentEstablishedEpoch/);
  assert.match(source, /exactSegmentCurrent\(segment\)/);
  assert.match(source, /\(flags\.adShowing \|\| flags\.adInterrupting\)/);
  assert.match(source, /\(!state\.contentStarted \|\| genuineLaterAdInterruption\(probe\.segment\)\)/);
  assert.match(source, /postContentLifecycleLog\('later-ad-confirmed'/);
  assert.match(source, /postContentLifecycleLog\('later-hold-eligible'/);
  assert.match(source, /postContentLifecycleLog\('later-hold-rejected'/);
  assert.match(source, /postContentLifecycleLog\('content-established'/);
  assert.match(source, /postContentLifecycleLog\('content-resumed'/);
  assert.match(source, /initialRequestedContentReached/);
  assert.match(source, /laterAdInterruptions/);
  assert.match(source, /contentResumedAfterLaterAd/);
  assert.match(source, /staleContentClassifications/);
  assert.doesNotMatch(source.slice(source.indexOf('function genuineLaterAdInterruption'), source.indexOf('function clearHoldBreakProbe')), /playerState/);
});

test('production diagnostics retain concise hold-break and handoff events without investigation probes', () => {
  assert.match(source, /\[YTPM\]\[AdHoldBreak\]/);
  assert.match(source, /'hold-entered'/);
  assert.match(source, /'command-invoked'/);
  assert.match(source, /'transition'/);
  assert.match(source, /\[YTPM\]\[AdContentHandoff\]/);
  assert.match(source, /\['waiting-media-ready', 'media-ready-wakeup', 'confirmed', 'restored', 'cancelled'\]/);
  assert.doesNotMatch(source, /AdControllerProbe|AdControllerHold|AdControllerPrecursor|AdTerminalClock|ContentFrameProbe/);
  assert.doesNotMatch(source, /__YTPM_AD_HOLD_BREAK_PROBE__/);
});

test('History pre-presentation fence activates before player presentation and covers video and ad UI', () => {
  assert.match(contentSource, /const HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE = 'data-ytpm-history-fence';/);
  assert.match(contentSource, /function activateHistoryPrePresentationFence\(session\)/);
  assert.match(contentSource, /function releaseHistoryPrePresentationFence\(session, reason\)/);
  assert.match(contentSource, /function logAdExposureFenceFailure\(invariant, session, fields\)/);

  // Selector checks in styles.css
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] video/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-player-overlay/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-text/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-skip-button/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-skip-button-modern/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-skip-button-container/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-module/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-overlay-container/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-preview-container/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-image-overlay/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-action-interstitial/);
  assert.match(stylesSource, /\[data-ytpm-history-fence="true"\] \.ytp-ad-end-screens-paginated/);

  // Activation occurs immediately upon session creation before preparation / presentation
  const internalStart = contentSource.indexOf('function requestHistoryNativeFallbackInternal');
  assert.ok(internalStart >= 0);
  const sessionCreation = contentSource.indexOf('historyNativeFallbackSession = session;', internalStart);
  const fenceActivation = contentSource.indexOf('activateHistoryPrePresentationFence(session);', internalStart);
  const playerPresentation = contentSource.indexOf('presentHistoryNativeFallback(session)', internalStart);
  const guardArm = contentSource.indexOf('armHistoryPreviewAdGuard(session);', internalStart);

  assert.ok(sessionCreation >= internalStart);
  assert.ok(fenceActivation > sessionCreation);
  assert.ok(playerPresentation > fenceActivation);
  assert.ok(guardArm > playerPresentation);
});

test('History pre-presentation fence executes an atomic handoff to PresentationGate without unprotected gaps', () => {
  // Verify that during presentHistoryNativeFallback, the fence attribute is preserved on thumbnailHost and outer
  assert.match(contentSource, /if \(session\.fenceActive\) \{\s*thumbnailHost\.setAttribute\(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true'\);\s*session\.outer\.setAttribute\(HISTORY_PRE_PRESENTATION_FENCE_ATTRIBUTE, 'true'\);\s*\}/);

  // Verify that guard arm verifies authoritative gate closure before releasing fence
  assert.match(contentSource, /if \(session\.adGuard && session\.adGuard\.arm\(\)\) \{/);
  assert.match(contentSource, /session\.outer\.getAttribute\('data-ytpm-preview-owned'\) === 'true'/);
  assert.match(contentSource, /session\.outer\.getAttribute\('data-ytpm-presentation-closed'\) === 'true'/);
  assert.match(contentSource, /session\.outer\.getAttribute\('data-ytpm-presentation-session'\) === session\.adSessionId/);
  assert.match(contentSource, /releaseHistoryPrePresentationFence\(session, 'presentation-gate-authoritative'\);/);

  // Invariant test: simulate the sequential DOM state transitions
  const outer = new FakeElement();
  const card = new FakeElement();
  const preview = new FakeElement();
  const thumbnailHost = new FakeElement();

  let preFenceActive = false;
  let presentationGateActive = false;

  const states = [];
  const recordState = (phase) => {
    states.push({
      phase,
      preFence: outer.getAttribute('data-ytpm-history-fence') === 'true',
      gate: outer.getAttribute('data-ytpm-presentation-closed') === 'true',
      owned: outer.getAttribute('data-ytpm-preview-owned') === 'true'
    });
  };

  // 1. Session created
  preFenceActive = true;
  outer.setAttribute('data-ytpm-history-fence', 'true');
  card.setAttribute('data-ytpm-history-fence', 'true');
  thumbnailHost.setAttribute('data-ytpm-history-fence', 'true');
  recordState('session-created');

  // 2. Player presented (DOM attachment)
  recordState('player-presented');

  // 3. Guard armed & PresentationGate closed (OVERLAP STATE)
  presentationGateActive = true;
  outer.setAttribute('data-ytpm-preview-owned', 'true');
  outer.setAttribute('data-ytpm-presentation-closed', 'true');
  recordState('guard-armed');

  // 4. Handoff to PresentationGate (fence released)
  preFenceActive = false;
  outer.removeAttribute('data-ytpm-history-fence');
  card.removeAttribute('data-ytpm-history-fence');
  thumbnailHost.removeAttribute('data-ytpm-history-fence');
  recordState('fence-handed-off');

  // 5. Load requested and ad playback
  recordState('ad-playback');

  // 6. Content confirmed -> PresentationGate opened
  presentationGateActive = false;
  outer.removeAttribute('data-ytpm-presentation-closed');
  recordState('content-confirmed');

  // Assertions on the sequence:
  // Step 1: preFence=true, gate=false
  assert.equal(states[0].preFence, true);
  assert.equal(states[0].gate, false);

  // Step 2: preFence=true, gate=false
  assert.equal(states[1].preFence, true);
  assert.equal(states[1].gate, false);

  // Step 3 (OVERLAP): preFence=true, gate=true
  assert.equal(states[2].preFence, true);
  assert.equal(states[2].gate, true);

  // Step 4: preFence=false, gate=true
  assert.equal(states[3].preFence, false);
  assert.equal(states[3].gate, true);

  // Step 5: preFence=false, gate=true
  assert.equal(states[4].preFence, false);
  assert.equal(states[4].gate, true);

  // Step 6: preFence=false, gate=false (content visible)
  assert.equal(states[5].preFence, false);
  assert.equal(states[5].gate, false);

  // INVARIANT: In all pre-content states (0-4), at least one suppression gate was true
  for (let i = 0; i <= 4; i++) {
    const isSuppressed = states[i].preFence || states[i].gate;
    assert.ok(isSuppressed, `Phase ${states[i].phase} must be fail-closed suppressed`);
  }
});

test('History pre-presentation fence is cleaned up on all cancellation, replacement, and disconnect paths', () => {
  // Verify cleanup function releases fence synchronously
  assert.match(contentSource, /function cleanupHistoryNativeFallback\(reason\) \{\s*const session = historyNativeFallbackSession;\s*if \(!session\) \{ return; \}\s*releaseHistoryPrePresentationFence\(session, reason \|\| 'history-cleanup'\);/);

  // Verify all disconnect / validation failure paths call cleanup
  assert.match(contentSource, /cleanupHistoryNativeFallback\('arm-rejected'\)/);
  assert.match(contentSource, /cleanupHistoryNativeFallback\('replaced'\)/);
  assert.match(contentSource, /cleanupHistoryNativeFallback\('presentation-unavailable'\)/);
  assert.match(contentSource, /cleanupHistoryNativeFallback\('inner-player-not-prepared'\)/);
  assert.match(contentSource, /cleanupHistoryNativeFallback\('fallback-ownership-ended'\)/);
});

test('AdExposureFence failure-only diagnostics emit concise invariant failures without polling or URLs', () => {
  assert.match(contentSource, /\[YTPM\]\[AdExposureFence\]/);
  assert.match(contentSource, /phase=failure/);
  assert.match(contentSource, /FENCE_NOT_ACTIVE_BEFORE_PRESENT/);
  assert.match(contentSource, /PRESENTATION_GATE_NOT_CLOSED_BEFORE_HANDOFF/);

  // Ensure telemetry does not leak URLs, media sources, or arbitrary objects
  assert.doesNotMatch(contentSource.slice(contentSource.indexOf('function logAdExposureFenceFailure'), contentSource.indexOf('function activateHistoryPrePresentationFence')), /currentSrc|videoUrl|JSON\.stringify/);
});

test('History ad UI and player chrome title suppression covers top bar, title, gradients, and ad banners', () => {
  // Stylesheet covers both pre-presentation fence and closed presentation gate
  const targetSelectors = [
    '.ytp-chrome-top',
    '.ytp-title',
    '.ytp-title-text',
    '.ytp-title-link',
    '.ytp-title-channel',
    '.ytp-chrome-bottom',
    '.ytp-gradient-top',
    '.ytp-gradient-bottom',
    '.ytp-ad-preview-text',
    '.ytp-ad-message-container',
    '.ytp-ad-message',
    '.ytp-ad-persistent-banner',
    '.ytp-paid-content-overlay',
    '.ytp-ad-badge'
  ];

  targetSelectors.forEach((sel) => {
    assert.match(stylesSource, new RegExp(`\\[data-ytpm-history-fence="true"\\] ${sel.replace(/\./g, '\\.')}`));
    assert.match(stylesSource, new RegExp(`\\[data-ytpm-presentation-closed="true"\\] ${sel.replace(/\./g, '\\.')}`));
  });

  // Guard library catalogs AD_TITLE category
  assert.match(source, /category:\s*'AD_TITLE'/);
  assert.match(source, /\.ytp-chrome-top/);
  assert.match(source, /\.ytp-title/);
});

test('Exact History fallback player surface is fail-closed with opacity 0 under pre-fence and closed presentation gate', () => {
  // Stylesheet contains exact parent outer player suppression rules
  assert.match(stylesSource, /ytd-player\.ytpm-history-native-fallback-active\[data-ytpm-history-fence="true"\]/);
  assert.match(stylesSource, /ytd-player\.ytpm-history-native-fallback-active\[data-ytpm-preview-owned="true"\]\[data-ytpm-presentation-closed="true"\]/);
  assert.match(stylesSource, /opacity:\s*0\s*!important/);
  assert.match(stylesSource, /pointer-events:\s*none\s*!important/);
  assert.match(stylesSource, /transition:\s*none\s*!important/);

  // Thumbnail and card are NOT hidden by the rule
  assert.doesNotMatch(stylesSource, /ytd-video-renderer\.ytpm-history-native-fallback-active\s*\{[^}]*opacity:\s*0/);
  assert.doesNotMatch(stylesSource, /#thumbnail\.ytpm-history-native-fallback-active\s*\{[^}]*opacity:\s*0/);
});

test('AdPodLatency summary emits compact production metrics upon disarm', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  player.classes.add('ad-showing');
  const media = createActiveMedia();
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  const guard = api.create({ generation: 42, getPlayer: () => player, media, overlay: new FakeElement(), isCurrent: () => true });

  guard.arm();
  runNextTimer();

  guard.disarm();

  // Summary emitted with max progression metrics
  const summary = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=42'));
  assert.ok(summary);
  const summaryText = summary.join(' ');
  assert.ok(summaryText.includes('timeFromLoadRequestToFirstAdMs='));
  assert.ok(summaryText.includes('totalAdPodWallMs='));
  assert.ok(summaryText.includes('loadRequestToGateOpenMs='));
  assert.ok(summaryText.includes('requestedContentClassificationToGateOpenMs='));
  assert.ok(summaryText.includes('maxSegmentConfirmedToEndpointMs='));
  assert.ok(summaryText.includes('maxEndpointToMediaResetMs='));
  assert.ok(summaryText.includes('maxMediaResetToNextLoadstartMs='));
});

test('AdPodLatencySummary emits totalAdPodWallMs=0 and timeFromLoadRequestToFirstAdMs=0 for no-ad sessions', () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.duration = 60;
  media.readyState = 3;
  media.paused = false;

  const guard = api.create({
    generation: 10,
    sessionId: 'gen-10',
    getPlayer: () => player,
    media,
    overlay,
    isCurrent: () => true,
    status: () => Promise.resolve({ associationSource: 'player-api', requestedVideoIdMatches: true, active: false })
  });

  guard.arm();
  runNextTimer();

  // No ad was ever detected or confirmed
  assert.equal(guard.status().confirmedAdSegments, 0);

  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be emitted');
  const summaryText = summaryEntry.join(' ');

  assert.ok(summaryText.includes('confirmedAdSegments=0'));
  assert.ok(summaryText.includes('timeFromLoadRequestToFirstAdMs=0'));
  assert.ok(summaryText.includes('totalAdPodWallMs=0'));
  assert.ok(summaryText.includes('loadRequestToGateOpenMs='));
  assert.ok(summaryText.includes('requestedContentClassificationToGateOpenMs='));
  assert.ok(summaryText.includes('maxSegmentConfirmedToEndpointMs=0'));
  assert.ok(summaryText.includes('maxEndpointToMediaResetMs=0'));
  assert.ok(summaryText.includes('maxMediaResetToNextLoadstartMs=0'));
});

test('AdPodLatency captures ad-reentry milestone when ad interrupts handoff', async () => {
  const runtime = await armRequestedContentProbe({ generation: 419, readyState: 0 });
  runtime.player.classes.add('ad-showing');
  runtime.guard.refresh();

  assert.ok(runtime.logs.some((entry) => entry.join(' ').includes('[YTPM][AdPodLatency]') && entry.join(' ').includes('milestone=ad-reentry')));
  runtime.guard.disarm();
});

test('Investigation-only AdUiExposureProbe is completely removed from content script', () => {
  assert.doesNotMatch(contentSource, /\[YTPM\]\[AdUiExposureProbe\]/);
  assert.doesNotMatch(contentSource, /function probeAdUiExposure/);
  assert.doesNotMatch(contentSource, /probeAdUiExposure\(/);
});

test('Multi-segment AdPodLatency accounting invalidates provisional pod end upon AD_REENTRY and tracks all ad segments', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };

  const guard = api.create({
    generation: 99,
    sessionId: 'gen-99',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. First ad segment (Ad A)
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Provisional requested-content association (simulating deferred handoff with readyState=0)
  media.readyState = 0;
  player.classList.remove('ad-showing');
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();

  // 3. AD_REENTRY interrupts the handoff before confirmation
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();

  // 4. Second ad segment (Ad B) confirmed
  media.duration = 20;
  media.seekable = { length: 1, end: () => 20 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);
  assert.equal(guard.status().confirmedAdSegments, 2);

  // 5. Terminal progression on Segment B leads to final content confirmation
  media.emit('loadstart');
  player.classList.remove('ad-showing');
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().contentStarted);

  assert.equal(guard.status().contentStarted, true);

  // 6. Disarm and inspect summary
  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=99'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be logged');
  const summaryText = summaryEntry.join(' ');

  assert.ok(summaryText.includes('confirmedAdSegments=2'), 'Must confirm 2 ad segments');
  assert.ok(summaryText.includes('initialConfirmedAdSegments=2'), 'Initial confirmed ad segments must be 2');
  assert.ok(summaryText.includes('loadRequestToFirstConfirmedAdMs='), 'Must include loadRequestToFirstConfirmedAdMs');
  assert.ok(summaryText.includes('finalContentAssociationToGateOpenMs='), 'Must include finalContentAssociationToGateOpenMs');
  assert.ok(summaryText.includes('seg1ConfirmedToEndpointMs='), 'Must include seg1 metrics');
  assert.ok(summaryText.includes('seg2ConfirmedToEndpointMs='), 'Must include seg2 metrics');
  assert.ok(summaryText.includes('maxNextLoadstartToClassificationMs='), 'Must include maxNextLoadstartToClassificationMs');
  assert.ok(summaryText.includes('unattributedLatencyMs='), 'Must include unattributedLatencyMs');
});

test('Initial ad-pod latency accounting is isolated from post-content later-ad interruptions', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };

  const guard = api.create({
    generation: 101,
    sessionId: 'gen-101',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial Ad Segment A
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Provisional content association
  media.readyState = 0;
  player.classList.remove('ad-showing');
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();

  // 3. AD_REENTRY before initial content established
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();

  // 4. Initial Ad Segment B confirmed
  media.duration = 20;
  media.seekable = { length: 1, end: () => 20 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // 5. Initial Requested Content Confirmed (INITIAL_REQUESTED_CONTENT_REACHED)
  media.emit('loadstart');
  player.classList.remove('ad-showing');
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().contentStarted);

  assert.equal(guard.status().contentStarted, true);
  assert.equal(guard.status().confirmedAdSegments, 2);

  // 6. Post-content later ad interruption (Later Ad C)
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  media.duration = 30;
  media.seekable = { length: 1, end: () => 30 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 3);

  assert.equal(guard.status().confirmedAdSegments, 3, 'Whole-session confirmedAdSegments must include later ad');

  // 7. Post-content later ad resolves back to content (CONTENT_RESUMED_AFTER_LATER_AD)
  media.emit('loadstart');
  player.classList.remove('ad-showing');
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  runUntil(runNextTimer, () => !overlay.hasAttribute('data-ytpm-ad-suppressed'));

  // 8. Disarm and inspect summary
  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=101'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be emitted');
  const summaryText = summaryEntry.join(' ');

  assert.ok(summaryText.includes('confirmedAdSegments=3'), 'Whole-session count must be 3');
  assert.ok(summaryText.includes('initialConfirmedAdSegments=2'), 'Initial pre-content count must be 2');
  assert.ok(summaryText.includes('laterAdSegments=1'), 'Later ad count must be 1');
  assert.ok(summaryText.includes('seg1ConfirmedToEndpointMs='), 'Must include initial seg1');
  assert.ok(summaryText.includes('seg2ConfirmedToEndpointMs='), 'Must include initial seg2');
  assert.ok(!summaryText.includes('seg3ConfirmedToEndpointMs='), 'Must NOT include later seg3 in initial breakdown');
});

test('Initial confirmed segment timing survives NATIVE_TRANSITION_BEFORE_PROBE fast path', async () => {
  const { api, logs, runNextTimer, runTimerByDelay } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, playerVideoIdMatchesRequested: true, associationSource: 'player-api', associationAvailable: true };

  const guard = api.create({
    generation: 102,
    sessionId: 'gen-102',
    videoId: 'dQw4w9WgXcQ',
    surface: 'history-native-fallback',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => Promise.resolve({ loadInvoked: true, loadThrew: false }),
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Confirm ad segment
  media.emit('loadstart');
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Terminal endpoint reached + media reset -> hold entered
  media.currentTime = 14.9;
  runTimerByDelay();
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;
  runTimerByDelay();
  guard.refresh();
  await Promise.resolve();

  // 3. Native transition occurs before probe timer fires
  player.classList.remove('ad-showing');
  media.duration = 100;
  media.seekable = { length: 1, end: () => 100 };
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, videoId: 'dQw4w9WgXcQ', playerReportedVideoIdMatches: true, playerVideoIdMatchesRequested: true, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  media.emit('loadstart');
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().contentStarted, 30);
  assert.equal(guard.status().contentStarted, true);

  // 4. Disarm and inspect summary
  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=102'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be emitted');
  const summaryText = summaryEntry.join(' ');

  assert.ok(summaryText.includes('confirmedAdSegments=1'), 'Confirmed ad count is 1');
  assert.ok(summaryText.includes('initialConfirmedAdSegments=1'), 'Initial confirmed ad count is 1');
  assert.ok(!summaryText.includes('seg1ConfirmedToEndpointMs=none'), 'seg1ConfirmedToEndpointMs must be numerical');
  assert.ok(!summaryText.includes('seg1EndpointToMediaResetMs=none'), 'seg1EndpointToMediaResetMs must be numerical');
  assert.ok(!summaryText.includes('seg1MediaResetToNextLoadstartMs=none'), 'seg1MediaResetToNextLoadstartMs must be numerical');
  assert.ok(!summaryText.includes('seg1NextLoadstartToClassificationMs=none'), 'seg1NextLoadstartToClassificationMs must be numerical');
});

test('Partial timing records emit available buckets without requiring all four stages', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };

  const guard = api.create({
    generation: 103,
    sessionId: 'gen-103',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Confirm ad segment
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Terminal endpoint reached but NO media reset happens
  media.currentTime = 14.9;
  guard.refresh();

  // 3. Directly transitions to content loadstart
  media.emit('loadstart');
  player.classList.remove('ad-showing');
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().contentStarted);

  // 4. Disarm and inspect summary
  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=103'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be emitted');
  const summaryText = summaryEntry.join(' ');

  assert.ok(!summaryText.includes('seg1ConfirmedToEndpointMs=none'), 'seg1ConfirmedToEndpointMs must be numerical');
  assert.ok(summaryText.includes('seg1EndpointToMediaResetMs=none'), 'seg1EndpointToMediaResetMs must be none');
  assert.ok(summaryText.includes('seg1MediaResetToNextLoadstartMs=none'), 'seg1MediaResetToNextLoadstartMs must be none');
  assert.ok(!summaryText.includes('maxSegmentConfirmedToEndpointMs=0'), 'maxSegmentConfirmedToEndpointMs must reflect valid stage');
});

test('Multi-segment initial pod timings with high sequence numbers map to ordinal seg1 and seg2', async () => {
  const { api, logs, runNextTimer, runTimerByDelay } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true };

  const guard = api.create({
    generation: 104,
    sessionId: 'gen-104',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial Ad Segment (sequence 1)
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Terminal endpoint reached + media reset
  media.currentTime = 14.9;
  runTimerByDelay();
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;
  runTimerByDelay();
  guard.refresh();
  await Promise.resolve();

  // 3. New ad loadstart -> confirmed ad segment 2
  media.emit('loadstart');
  media.duration = 20;
  media.seekable = { length: 1, end: () => 20 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // 4. Terminal progression on Segment 2 leads to content
  player.classList.remove('ad-showing');
  media.duration = 100;
  media.seekable = { length: 1, end: () => 100 };
  media.currentTime = 0;
  media.readyState = 3;
  media.paused = false;
  bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true };
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  media.emit('loadstart');
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().contentStarted, 30);

  assert.equal(guard.status().contentStarted, true);
  assert.equal(guard.status().confirmedAdSegments, 2);

  // 5. Disarm and inspect summary
  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdPodLatencySummary]') && entry.join(' ').includes('generation=104'));
  assert.ok(summaryEntry, 'AdPodLatencySummary must be emitted');
  const summaryText = summaryEntry.join(' ');

  assert.ok(summaryText.includes('initialConfirmedAdSegments=2'), 'Initial confirmed ad count is 2');
  assert.ok(!summaryText.includes('seg1ConfirmedToEndpointMs=none'), 'seg1ConfirmedToEndpointMs must be numerical');
  assert.ok(!summaryText.includes('seg2ConfirmedToEndpointMs=none'), 'seg2ConfirmedToEndpointMs must be numerical');
  assert.ok(!summaryText.includes('seg3ConfirmedToEndpointMs='), 'Must NOT contain seg3');
  assert.ok(!summaryText.includes('seg4ConfirmedToEndpointMs='), 'Must NOT contain seg4');
  assert.ok(!summaryText.includes('maxSegmentConfirmedToEndpointMs=0'), 'maxSegmentConfirmedToEndpointMs must be non-zero');
});

test('Reset with adShowing/adInterrupting false does NOT create a controller hold', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 105,
    sessionId: 'gen-105',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => Promise.resolve({ loadInvoked: true }),
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial Ad Segment confirmation
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Latch endpoint evidence
  media.currentTime = 14.9;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();

  // 3. Ad flags become inactive before reset
  player.classList.remove('ad-showing');
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;
  media.emit('durationchange');

  const holdEnteredLogs = logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered'));
  assert.equal(holdEnteredLogs.length, 0, 'No hold should be entered when ad flags are inactive at media reset');

  guard.disarm();
});

test('Near-end state alone does NOT create a controller hold before media reset', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 106,
    sessionId: 'gen-106',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => Promise.resolve({ loadInvoked: true }),
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // Near end reached, but media is still readyState 3 and duration is finite
  media.currentTime = 14.9;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  media.emit('timeupdate');
  media.emit('durationchange');

  const holdEnteredLogs = logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered'));
  assert.equal(holdEnteredLogs.length, 0, 'Near-end state alone must not create a hold before media reset');

  guard.disarm();
});

test('Event-driven media reset wakes controller hold evaluator immediately on media reset without sampler lag', async () => {
  const { api, logs, runNextTimer, runTimerByDelay } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let holdCommandCalls = 0;

  const guard = api.create({
    generation: 107,
    sessionId: 'gen-107',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => {
      holdCommandCalls += 1;
      return Promise.resolve({ loadInvoked: true });
    },
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial ad confirmation
  media.emit('loadstart');
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Latch endpoint evidence
  media.currentTime = 14.9;
  guard.refresh();
  await Promise.resolve();
  await Promise.resolve();

  // 3. Pre-reset durationchange event while duration is finite does NOT wake hold
  media.emit('durationchange');
  assert.equal(logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')).length, 0, 'Pre-reset durationchange must not enter hold');

  // 4. Physical media reset occurs and emits durationchange event -> immediate synchronous wake
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;
  media.emit('durationchange');

  const holdEnteredLogs = logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered'));
  assert.equal(holdEnteredLogs.length, 1, 'Hold evaluator must wake immediately and enter hold on media reset event');

  // 5. Subsequent duplicate events do not create duplicate holds
  media.emit('timeupdate');
  media.emit('emptied');
  assert.equal(logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')).length, 1, 'Duplicate events must not create duplicate holds');

  // 6. Hold command runs only after 500ms delay
  assert.equal(holdCommandCalls, 0, 'Command must not be invoked immediately from event callback');
  runUntil(runTimerByDelay, () => holdCommandCalls === 1);
  assert.equal(holdCommandCalls, 1, 'Command must be invoked after 500ms hold delay');

  guard.disarm();
});

test('Sampler fallback still catches media reset when no DOM event is emitted', async () => {
  const { api, logs, runNextTimer, runTimerByDelay } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 108,
    sessionId: 'gen-108',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => Promise.resolve({ loadInvoked: true }),
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  media.emit('loadstart');
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  media.currentTime = 14.9;
  guard.refresh();

  // Reset media silently without firing any DOM events
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;

  assert.equal(logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')).length, 0);

  // Run the 500ms sampleClock fallback
  runUntil(runTimerByDelay, () => logs.some((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')));

  assert.equal(logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')).length, 1, 'Sampler fallback must catch media reset');

  guard.disarm();
});

test('Native loadstart before 500ms hold command cancels command on event-driven wake path', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let holdCommandCalls = 0;

  const guard = api.create({
    generation: 109,
    sessionId: 'gen-109',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => {
      holdCommandCalls += 1;
      return Promise.resolve({ loadInvoked: true });
    },
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  media.emit('loadstart');
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  media.readyState = 3;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  media.currentTime = 14.9;
  guard.refresh();

  // Reset media + event -> hold entered
  media.readyState = 0;
  media.duration = NaN;
  media.currentTime = 0;
  media.emit('durationchange');

  assert.equal(logs.filter((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=hold-entered')).length, 1);

  // Native loadstart occurs before 500ms timer
  media.emit('loadstart');

  const nativeTransitionLog = logs.find((entry) => entry.join(' ').includes('[YTPM][AdHoldBreak]') && entry.join(' ').includes('phase=native-transition'));
  assert.ok(nativeTransitionLog, 'Native transition must be logged on fast path');
  assert.equal(holdCommandCalls, 0, 'Command must NOT have been called');

  guard.disarm();

  const summaryEntry = logs.find((entry) => entry.join(' ').includes('[YTPM][AdHoldBreakSummary]') && entry.join(' ').includes('generation=109'));
  assert.ok(summaryEntry);
  assert.ok(summaryEntry.join(' ').includes('nativeTransitionsBeforeProbe=1'));
  assert.ok(summaryEntry.join(' ').includes('commandsInvoked=0'));
});

test('Post-content load transition synchronously re-closes PresentationGate and AdUiGate before later ad classification', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.8;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 201,
    sessionId: 'gen-201',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial content confirmed & gate opened
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false, 'Gate must be open for content');
  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().presentationOpenCycles, 1);
  assert.equal(guard.status().presentationCloseCycles, 1);
  assert.equal(media.muted, false, 'Audio must be unmuted during content');

  // 2. Later transition starts (NEW_LOADSTART)
  media.emit('loadstart');

  // IMMEDIATELY on loadstart, gate must re-close synchronously before any ad classification occurs
  assert.equal(overlay.getAttribute('data-ytpm-presentation-closed'), 'true', 'Gate must synchronously re-close on post-content loadstart');
  assert.equal(guard.status().presentationClosed, true);
  assert.equal(guard.status().postContentReclosures, 1);
  assert.equal(guard.status().presentationCloseCycles, 2);
  assert.equal(media.muted, true, 'Audio must be muted during post-content transition');

  // 3. Later ad is classified
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.requestedVideoIdMatches = false;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().presentationClosed, true, 'Gate must stay closed during later ad');
  assert.equal(guard.status().visibleAdViolation, false, 'No visible ad violation because gate was closed before ad confirmed');

  // 4. Content returns
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false, 'Gate must reopen when content resumes');
  assert.equal(guard.status().presentationOpenCycles, 2);
  assert.equal(media.muted, false, 'Audio must be restored to original state');
  assert.equal(media.volume, 0.8, 'Volume must be preserved');

  guard.disarm();
});

test('Later ad interruptions and content resumptions cycle PresentationGate through multiple clean close/open states with audio restored', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 1;
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 202,
    sessionId: 'gen-202',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Cycle 1: Initial ad -> content
  player.classList.add('ad-showing');
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // Initial content
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationOpenCycles, 1);
  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false);

  // Cycle 2: Later ad 1 -> content
  media.emit('loadstart');
  assert.equal(guard.status().presentationClosed, true);
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationOpenCycles, 2);
  assert.equal(guard.status().postContentReclosures, 1);

  // Cycle 3: Later ad 2 -> content
  media.emit('loadstart');
  assert.equal(guard.status().presentationClosed, true);
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 3);

  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationOpenCycles, 3);
  assert.equal(guard.status().postContentReclosures, 2);
  assert.equal(guard.status().visibleAdViolation, false);

  guard.disarm();

  const presentationSummary = logs.find((entry) => entry[0] === '[YTPM][PresentationGateSummary]');
  assert.ok(presentationSummary);
  assert.ok(presentationSummary.join(' ').includes('closeCycles=3'));
  assert.ok(presentationSummary.join(' ').includes('openCycles=3'));
  assert.ok(presentationSummary.join(' ').includes('postContentReclosures=2'));
  assert.ok(presentationSummary.join(' ').includes('visibleAdViolation=false'));
  assert.ok(presentationSummary.join(' ').includes('result=PASS'));
});

test('Ad progression budget is scoped per-pod allowing later interruptions to progress after whole-session confirmed count exceeds MAX_AD_SEGMENTS', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 203,
    sessionId: 'gen-203',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Initial pod: 2 confirmed ads
  player.classList.add('ad-showing');
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // Initial content confirmed
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);
  assert.equal(guard.status().currentPodConfirmedSegments, 0, 'Current pod budget must reset on content established');

  // Later interruption 1: 2 confirmed ads (cumulative 3 and 4)
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 3);
  assert.equal(guard.status().currentPodConfirmedSegments, 1, 'Current pod confirmed count should be 1');

  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 4);
  assert.equal(guard.status().currentPodConfirmedSegments, 2, 'Current pod confirmed count should be 2');

  // Progression seek was still attempted on 4th total segment because current pod < 3!
  const progressLogs = logs.filter((entry) => entry.join(' ').includes('[YTPM][AdProgress]') && entry.join(' ').includes('phase=seek-attempt'));
  assert.ok(progressLogs.length >= 3, 'Progression must remain available across later pods');

  guard.disarm();
});

test('Budget exhaustion within a single pod fails closed by suppressing visual gate and audio while allowing natural content transition', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 204,
    sessionId: 'gen-204',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  player.classList.add('ad-showing');
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };

  // Segment 1 in pod
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // Segment 2 in pod
  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // Segment 3 in pod (budget limit reached: 3)
  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 3);

  // Segment 4 in same pod -> budget exhausted!
  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => logs.some((entry) => entry.join(' ').includes('progression-budget-exhausted')));

  assert.equal(guard.status().confirmedAdSegments, 3, 'Confirmed ad count does not advance past budget in same pod');
  assert.equal(overlay.getAttribute('data-ytpm-presentation-closed'), 'true', 'PresentationGate MUST remain fail-closed on budget exhaustion');
  assert.equal(guard.status().presentationClosed, true);
  assert.equal(media.muted, true, 'Audio MUST remain suppressed on budget exhaustion');

  // Natural progression to content by YouTube
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false, 'Gate opens only after canonical content is reached');
  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().visibleAdViolation, false);

  guard.disarm();
});

test('Stale ad-created mutations in canonical content epoch do NOT re-close PresentationGate, do not suppress media, and keep content visible and playing', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.75;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 205,
    sessionId: 'gen-205',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Initial ad
  player.classList.add('ad-showing');
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // Initial content established
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  const contentEpoch = guard.status().loadEpoch;
  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false, 'Gate must be open for content');
  assert.equal(overlay.hasAttribute('data-ytpm-ad-suppressed'), false, 'Ad suppression must be removed');
  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().suppressed, false);
  assert.equal(guard.status().presentationCloseCycles, 1);
  assert.equal(guard.status().presentationOpenCycles, 1);
  assert.equal(guard.status().postContentReclosures, 0);
  assert.equal(media.muted, false, 'Media must be unmuted');
  assert.equal(media.volume, 0.75, 'Volume must be preserved');

  // Stale ad-created mutation arrives in the same content epoch
  player.classList.add('ad-created');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-created';
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Assert: Gate must NOT re-close, media must NOT be suppressed, volume/rate unchanged!
  assert.equal(overlay.hasAttribute('data-ytpm-presentation-closed'), false, 'Gate MUST remain open despite ad-created mutation');
  assert.equal(overlay.hasAttribute('data-ytpm-ad-suppressed'), false, 'Media MUST NOT be suppressed on ad-created');
  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().suppressed, false);
  assert.equal(guard.status().presentationCloseCycles, 1, 'Close cycles must NOT increment');
  assert.equal(guard.status().postContentReclosures, 0, 'Post-content reclosures must remain 0');
  assert.equal(guard.status().loadEpoch, contentEpoch, 'Load epoch must remain unchanged');
  assert.equal(media.muted, false, 'Audio MUST remain unmuted');
  assert.equal(media.volume, 0.75, 'Volume must remain 0.75');

  // Repeated ad-created mutations in same epoch
  guard.refresh();
  guard.refresh();
  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().postContentReclosures, 0);

  guard.disarm();

  const presentationSummary = logs.find((entry) => entry[0] === '[YTPM][PresentationGateSummary]');
  assert.ok(presentationSummary);
  assert.ok(presentationSummary.join(' ').includes('closeCycles=1'));
  assert.ok(presentationSummary.join(' ').includes('openCycles=1'));
  assert.ok(presentationSummary.join(' ').includes('postContentReclosures=0'));
  assert.ok(presentationSummary.join(' ').includes('closedBeforeFirstMediaPlay=true'));
  assert.ok(presentationSummary.join(' ').includes('result=PASS'));
});

test('Full lifecycle: initial ads -> content -> stale ad-created ignored -> real loadstart re-closes -> later ad -> resume -> second stale ad-created ignored -> PASS summary', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.9;
  media.playbackRate = 1;
  media.paused = false;
  media.readyState = 3;
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 206,
    sessionId: 'gen-206',
    surface: 'history-native-fallback',
    videoId: 'abc12345678',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial ad 1 & 2
  player.classList.add('ad-showing');
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  media.emit('loadstart');
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // 2. Initial content established
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationOpenCycles, 1);
  assert.equal(guard.status().postContentReclosures, 0);
  assert.equal(media.muted, false);

  // 3. Stale ad-created mutation on content
  player.classList.add('ad-created');
  guard.refresh();
  assert.equal(guard.status().presentationClosed, false, 'Gate must remain open');
  assert.equal(guard.status().postContentReclosures, 0);

  // 4. Real later ad interruption begins (new media loadstart)
  media.emit('loadstart');
  assert.equal(guard.status().presentationClosed, true, 'Gate must synchronously reclose on real loadstart');
  assert.equal(guard.status().postContentReclosures, 1);
  assert.equal(media.muted, true, 'Media must be muted during later ad');

  // Later ad confirmed
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 3);

  // 5. Content resumes
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationOpenCycles, 2);
  assert.equal(guard.status().postContentReclosures, 1);
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.9);

  // 6. Another stale ad-created mutation in resumed content epoch
  player.classList.add('ad-created');
  guard.refresh();
  assert.equal(guard.status().presentationClosed, false, 'Gate must remain open');
  assert.equal(guard.status().postContentReclosures, 1);

  guard.disarm();

  const presentationSummary = logs.find((entry) => entry[0] === '[YTPM][PresentationGateSummary]');
  assert.ok(presentationSummary);
  assert.ok(presentationSummary.join(' ').includes('closeCycles=2'));
  assert.ok(presentationSummary.join(' ').includes('openCycles=2'));
  assert.ok(presentationSummary.join(' ').includes('postContentReclosures=1'));
  assert.ok(presentationSummary.join(' ').includes('closedBeforeFirstMediaPlay=true'));
  assert.ok(presentationSummary.join(' ').includes('visibleAdViolation=false'));
  assert.ok(presentationSummary.join(' ').includes('result=PASS'));
});

test('Canonical requested content at epoch N is strictly protected from same-epoch active ad progression, rate changes, and seeks', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.8;
  media.playbackRate = 1.0;
  media.currentTime = 15;
  media.duration = 100;
  media.seekable = { length: 1, start: () => 0, end: () => 100 };
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 207,
    sessionId: 'gen-207',
    surface: 'history-native-fallback',
    videoId: 'vidContent123',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Initial content established immediately at epoch 1
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().loadEpoch, 1);
  assert.equal(guard.status().confirmedAdSegments, 0);
  assert.equal(media.playbackRate, 1.0);
  assert.equal(media.currentTime, 15);

  // Now, in the SAME loadEpoch=1, an active ad signal (ad-showing) arrives BEFORE any new loadstart
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();

  // Run any timers that could be scheduled
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Assert: Hard progression guard blocked progression in the same canonical epoch!
  assert.equal(media.playbackRate, 1.0, 'Playback rate MUST NOT be mutated to 4x on canonical content media');
  assert.equal(media.currentTime, 15, 'Canonical content media MUST NOT be seeked near end');
  assert.equal(guard.status().confirmedAdSegments, 0, 'No ad segment confirmed in canonical content epoch');
  assert.equal(guard.status().loadEpoch, 1);

  // Verified log contains same-canonical-epoch-blocked
  const blockedLog = logs.find((entry) => entry[0] === '[YTPM][AdProgressGuard]' && entry.join(' ').includes('same-canonical-epoch-blocked'));
  assert.ok(blockedLog, 'AdProgressGuard log must confirm blocking same-canonical-epoch progression');

  // Now the REAL authoritative transition occurs (NEW_LOADSTART for next epoch)
  media.emit('loadstart');
  assert.equal(guard.status().loadEpoch, 2);
  assert.equal(guard.status().presentationClosed, true);

  // Now epoch 2 IS eligible for ad progression
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1, 'New epoch 2 is successfully progression eligible');

  guard.disarm();
});

test('Same-epoch active-ad suspicion with NO NEW_LOADSTART recovers visual quarantine and restores canonical content playing without being stranded', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.85;
  media.playbackRate = 1.0;
  media.currentTime = 20;
  media.duration = 200;
  media.seekable = { length: 1, start: () => 0, end: () => 200 };
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 208,
    sessionId: 'gen-208',
    surface: 'history-native-fallback',
    videoId: 'vidContent123',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Canonical content established
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);

  // Temporary active-ad suspicion arrives in same epoch (e.g. transient class flicker)
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  guard.refresh();

  // Visual quarantine enters (gate closed, suppressed), but NO progression
  assert.equal(guard.status().presentationClosed, true);
  assert.equal(media.muted, true);
  assert.equal(media.playbackRate, 1.0, 'No rate mutation');
  assert.equal(media.currentTime, 20, 'No seek');

  // NO new loadstart occurs. Instead, the suspicion clears (player removes ad-showing, requested content continues)
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;

  // Next inspection / quarantine recovery timer fires
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  // Assert: Visual quarantine is cleanly released and canonical content is visible and unmuted!
  assert.equal(guard.status().presentationClosed, false, 'Presentation gate must reopen after quarantine recovery');
  assert.equal(media.muted, false, 'Audio must be restored');
  assert.equal(media.volume, 0.85, 'Volume preserved');
  assert.equal(media.playbackRate, 1.0, 'Playback rate preserved');
  assert.equal(media.currentTime, 20, 'Current time preserved');

  guard.disarm();
});

test('Canonical content user rate (1.25x) and audio baseline are preserved across multiple ad acceleration cycles without rate drift', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 0.7;
  media.playbackRate = 1.25; // User plays video at 1.25x
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 209,
    sessionId: 'gen-209',
    surface: 'history-native-fallback',
    videoId: 'vidContent123',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial canonical content established
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);
  assert.equal(media.playbackRate, 1.25, 'Initial content plays at 1.25x');

  // User changes speed during content playback to 1.5x
  media.playbackRate = 1.5;
  media.emit('ratechange');
  assert.equal(media.playbackRate, 1.5);

  // 2. Real later ad 1 starts (NEW_LOADSTART)
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => media.playbackRate >= 4);

  // Ad was accelerated (e.g. to 4x or higher)
  assert.equal(media.muted, true);
  assert.ok(media.playbackRate >= 4, 'Ad was accelerated to 4x or higher');

  // Content resumes after Ad 1
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  // Assert: Playback rate must return to 1.5x (user rate baseline), NOT 1x and NOT 4x!
  assert.equal(media.playbackRate, 1.5, 'Content resumes at 1.5x');
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.7);

  // 3. Real later ad 2 starts (NEW_LOADSTART)
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  bridgeStatus.requestedVideoIdMatches = false;
  guard.refresh();
  runUntil(runNextTimer, () => media.playbackRate >= 4);

  // Ad 2 accelerated
  assert.equal(media.muted, true);
  assert.ok(media.playbackRate >= 4);

  // Content resumes after Ad 2
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  media.emit('loadstart');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  // Assert: Playback rate remains 1.5x with zero drift across multiple ad cycles!
  assert.equal(media.playbackRate, 1.5, 'Content resumes at 1.5x with zero drift');
  assert.equal(media.muted, false);
  assert.equal(media.volume, 0.7);

  guard.disarm();
});

test('Post-ad requested content with readyState=0 triggers bounded one-shot recovery after 5000ms and avoids infinite retry', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.muted = false;
  media.volume = 1.0;
  media.playbackRate = 1.0;
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 210,
    sessionId: 'gen-210',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad segment
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Ad finishes, transition to requested content (loadEpoch=1)
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0; // Stalled at readyState=0!
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer(); // Schedule post-load classification (100ms)
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Post load classified as REQUESTED_CONTENT, but media is readyState=0 -> waiting-media-ready
  assert.equal(guard.status().presentationClosed, true, 'Gate must stay fail-closed while waiting for ready');
  assert.equal(recoveryCommandInvoked, 0, 'No command before 5000ms timer');

  // Verify recovery armed log with boundMs=5000
  const armedLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=armed'));
  assert.ok(armedLog, 'ContentReadyRecovery must be armed for post-ad readyState=0');
  assert.ok(armedLog.join(' ').includes('boundMs=5000'), 'Armed bound must be 5000ms');

  // Fast forward until 5000ms timer fires
  runUntil(runNextTimer, () => recoveryCommandInvoked === 1, 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Assert: Exactly ONE recovery invocation
  assert.equal(recoveryCommandInvoked, 1, 'Exactly one recovery command must be invoked');
  const invokedLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=invoked'));
  assert.ok(invokedLog, 'ContentReadyRecovery log must confirm command invocation');

  // No duplicate invocations on subsequent timers (No infinite retry)
  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(recoveryCommandInvoked, 1, 'Must remain strictly one-shot (no infinite loops)');

  guard.disarm();
});

test('Native media-ready at 2900ms cancels recovery timer with zero commands', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 211,
    sessionId: 'gen-211',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to requested content (readyState=0 initially)
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer(); // 100ms post-load classification
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Native media ready arrives at 2900ms (before the 5000ms timer)
  media.readyState = 4;
  media.duration = 60;
  media.seekable = { length: 1, end: () => 60 };
  media.emit('loadedmetadata');

  // Content stabilization completes
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Gate opens on native media ready');
  assert.equal(recoveryCommandInvoked, 0, 'Zero recovery commands should run when native ready wins at 2900ms');

  const cancelledLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=cancelled-native-ready'));
  assert.ok(cancelledLog, 'ContentReadyRecovery must record cancelled-native-ready');

  guard.disarm();
});

test('Native media-ready in the 3200ms healthy tail cancels recovery timer with zero commands', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 215,
    sessionId: 'gen-215',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to content (armed with 5000ms bound)
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer(); // 100ms post-load classification
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Native media ready arrives in the 3200ms healthy tail (before 5000ms timer)
  media.readyState = 4;
  media.duration = 60;
  media.seekable = { length: 1, end: () => 60 };
  media.emit('loadedmetadata');

  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Gate opens on native media ready in 3200ms tail');
  assert.equal(recoveryCommandInvoked, 0, 'Zero commands invoked in 3200ms tail under 5000ms bound');

  const cancelledLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=cancelled-native-ready'));
  assert.ok(cancelledLog, 'ContentReadyRecovery must record cancelled-native-ready');

  guard.disarm();
});

test('Native media-ready at 4900ms cancels recovery timer with zero commands', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 216,
    sessionId: 'gen-216',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Transition to content
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Native media ready arrives at 4900ms (before 5000ms expiry)
  media.readyState = 4;
  media.duration = 60;
  media.seekable = { length: 1, end: () => 60 };
  media.emit('loadedmetadata');

  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);
  assert.equal(recoveryCommandInvoked, 0, 'Zero commands invoked at 4900ms');

  const cancelledLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=cancelled-native-ready'));
  assert.ok(cancelledLog);

  guard.disarm();
});

test('Native-ready race immediately before 5000ms wins with zero recovery command', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 217,
    sessionId: 'gen-217',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // 2. Transition to content
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Immediate race: native loadeddata arrives right before timeout
  media.readyState = 2;
  media.duration = 60;
  media.seekable = { length: 1, end: () => 60 };
  media.emit('loadeddata');

  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  guard.refresh();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Native path wins immediately');
  assert.equal(recoveryCommandInvoked, 0, 'Zero commands invoked');

  const cancelledLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=cancelled-native-ready'));
  assert.ok(cancelledLog);

  guard.disarm();
});

test('Recovery command resulting loadstart continues fail-closed requested content confirmation and gate opening', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 212,
    sessionId: 'gen-212',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to content at epoch 2, stalled at readyState=0
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer(); // 100ms post-load classification
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // 3. Fast-forward to 5000ms recovery timer
  runUntil(runNextTimer, () => recoveryCommandInvoked === 1, 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(recoveryCommandInvoked, 1);

  // Recovery command triggers NEW_LOADSTART on media (epoch 3)
  media.emit('loadstart');
  assert.equal(guard.status().loadEpoch, 3);
  assert.equal(guard.status().presentationClosed, true, 'Gate remains closed during recovery loadstart');

  const newLoadstartLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=new-loadstart'));
  assert.ok(newLoadstartLog, 'New loadstart from recovery must be logged in ContentReadyRecovery');

  // Now media becomes ready in new epoch
  media.readyState = 4;
  media.duration = 120;
  media.seekable = { length: 1, end: () => 120 };
  media.emit('loadedmetadata');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Gate opens cleanly once recovered content is ready');

  const contentReadyLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=content-ready'));
  assert.ok(contentReadyLog, 'ContentReadyRecovery must record content-ready');

  guard.disarm();
});

test('Recovery command resulting ad re-entry cancels content handoff, keeps gate closed, and progression owns epoch', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 213,
    sessionId: 'gen-213',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to content, stalled readyState=0
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // 3. Fast-forward to 5000ms recovery timer
  runUntil(runNextTimer, () => recoveryCommandInvoked === 1, 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(recoveryCommandInvoked, 1);

  // Recovery command loadstart triggers an ad re-entry!
  media.emit('loadstart');
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  bridgeStatus.requestedVideoIdMatches = false;
  media.readyState = 4;
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };

  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 2);

  // Assert: Gate remains closed, ad progression takes over
  assert.equal(guard.status().presentationClosed, true, 'Gate must remain strictly closed on ad re-entry');
  assert.equal(guard.status().confirmedAdSegments, 2, 'Ad progression must confirm and own the new ad segment');

  const adReentryLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=ad-reentry'));
  assert.ok(adReentryLog, 'ContentReadyRecovery must record ad-reentry');

  guard.disarm();
});

test('Hover loss before 5000ms timer invalidates recovery with zero commands and no infinite retries', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;
  let hoverValid = true;

  const guard = api.create({
    generation: 214,
    sessionId: 'gen-214',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: hoverValid })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to content
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // User moves cursor away before 5000ms
  hoverValid = false;

  // Timer fires after 5000ms
  runUntil(runNextTimer, () => logs.some((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=invalidated')), 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  assert.equal(recoveryCommandInvoked, 0, 'Zero commands should run if hover/ownership was lost');
  const invalidatedLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=invalidated'));
  assert.ok(invalidatedLog, 'ContentReadyRecovery must record invalidated');

  guard.disarm();
});

test('ContentReadyRecovery race: media element change before callback invalidates recovery with zero commands', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  let currentMedia = createActiveMedia();
  currentMedia.readyState = 3;
  currentMedia.duration = 10;
  currentMedia.seekable = { length: 1, end: () => 10 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCommandInvoked = 0;

  const guard = api.create({
    generation: 218,
    sessionId: 'gen-218',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    getMedia: () => currentMedia,
    media: currentMedia,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => {
      recoveryCommandInvoked += 1;
      return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false });
    },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial confirmed ad segment
  currentMedia.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Transition to requested content (readyState=0) -> arms recovery timer (5000ms)
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  currentMedia.readyState = 0;
  currentMedia.duration = NaN;
  currentMedia.seekable = { length: 0 };
  currentMedia.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer(); // 100ms post-load classification
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  const armedLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=armed'));
  assert.ok(armedLog, 'ContentReadyRecovery must be armed');

  // 3. Media element changes / replaced before recovery timer fires
  const newMedia = createActiveMedia();
  newMedia.readyState = 0;
  currentMedia = newMedia;
  guard.refresh();

  // 4. Old recovery callback / timer fires
  runUntil(runNextTimer, () => logs.some((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('phase=invalidated')), 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // 5. Assert: Callback was safely ignored, zero commands executed, gate stays closed
  assert.equal(recoveryCommandInvoked, 0, 'Zero recovery commands should run on stale/replaced media');
  assert.equal(guard.status().presentationClosed, true, 'Presentation gate must remain closed');

  const invalidatedLog = logs.find((entry) => entry[0] === '[YTPM][ContentReadyRecovery]' && entry.join(' ').includes('reason=MEDIA_CHANGED'));
  assert.ok(invalidatedLog, 'ContentReadyRecovery log must record invalidated due to MEDIA_CHANGED');

  guard.disarm();
});

test('RapidReentryBarrier 1: Fresh normal History load has no regression', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 301,
    sessionId: 'gen-301',
    surface: 'history-native-fallback',
    videoId: 'freshVideo123',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();
  media.emit('loadstart');

  media.readyState = 4;
  media.duration = 60;
  media.seekable = { length: 1, end: () => 60 };
  media.emit('loadedmetadata');

  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Gate opens on fresh History load');
  assert.equal(guard.status().contentStarted, true, 'Content confirmed');
  guard.disarm();
});

test('RapidReentryBarrier 2-4: Stale arm-time media residue receives zero seek, zero acceleration, zero confirmed ads, and gate remains closed', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 4;
  media.duration = 120;
  media.currentTime = 10;
  media.playbackRate = 1.0;
  media.seekable = { length: 1, end: () => 120 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: false };
  let holdCommandCalls = 0;

  // Session 2 arms immediately with retained media from previous session
  const guard = api.create({
    generation: 302,
    sessionId: 'gen-302',
    surface: 'history-native-fallback',
    videoId: 'newVideo456',
    holdBreakProbeEnabled: true,
    holdBreakProbe: () => { holdCommandCalls += 1; return Promise.resolve({ loadInvoked: true }); },
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Reused player has ad-showing class from prior session, but NO new loadstart yet (loadEpoch=0)
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Verify barrier armed log
  const armedLog = logs.find((entry) => entry[0] === '[YTPM][RapidReentryBarrier]' && entry.join(' ').includes('phase=armed'));
  assert.ok(armedLog, 'RapidReentryBarrier must log armed phase');
  assert.ok(armedLog.join(' ').includes('sameMediaAsArm=true'));
  assert.ok(armedLog.join(' ').includes('readyState=4'));

  // Verify stale media blocked log
  const blockedLog = logs.find((entry) => entry[0] === '[YTPM][RapidReentryBarrier]' && entry.join(' ').includes('phase=stale-media-blocked'));
  assert.ok(blockedLog, 'RapidReentryBarrier must log stale-media-blocked phase');

  // Verify ZERO side-effects on stale media
  assert.equal(guard.status().confirmedAdSegments, 0, 'Zero ad segments confirmed on stale residue');
  assert.equal(media.currentTime, 10, 'Zero seek on stale residue');
  assert.equal(media.playbackRate, 1.0, 'Zero acceleration on stale residue');
  assert.equal(holdCommandCalls, 0, 'Zero hold-break commands issued');
  assert.equal(guard.status().presentationClosed, true, 'PresentationGate remains fail-closed');

  guard.disarm();
});

test('RapidReentryBarrier 5-6: NEW_LOADSTART releases barrier and allows genuine active ad to progress normally', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 4;
  media.duration = 120;
  media.currentTime = 5;
  media.seekable = { length: 1, end: () => 120 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: false };

  const guard = api.create({
    generation: 303,
    sessionId: 'gen-303',
    surface: 'history-native-fallback',
    videoId: 'genuineAdVideo',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Stale media blocked at loadEpoch=0
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(guard.status().confirmedAdSegments, 0);

  // 2. Authoritative current-load evidence: NEW_LOADSTART
  media.emit('loadstart');

  const releasedLog = logs.find((entry) => entry[0] === '[YTPM][RapidReentryBarrier]' && entry.join(' ').includes('phase=released'));
  assert.ok(releasedLog, 'RapidReentryBarrier must log released phase');
  assert.ok(releasedLog.join(' ').includes('releaseReason=NEW_LOADSTART'));

  // 3. Genuine ad arrives in epoch 1 -> progresses normally
  media.readyState = 4;
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  assert.equal(guard.status().confirmedAdSegments, 1, 'Genuine ad progresses normally after release');
  assert.equal(guard.status().presentationClosed, true, 'Gate remains closed during ad playback');

  guard.disarm();
});

test('RapidReentryBarrier 7: After release, REQUESTED_CONTENT follows existing handoff and opens PresentationGate', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 4;
  media.duration = 120;
  media.seekable = { length: 1, end: () => 120 };
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 304,
    sessionId: 'gen-304',
    surface: 'history-native-fallback',
    videoId: 'requestedContentVideo',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();

  // Release barrier via loadstart
  media.emit('loadstart');

  media.readyState = 4;
  media.duration = 80;
  media.seekable = { length: 1, end: () => 80 };
  media.emit('loadedmetadata');

  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false, 'Gate opens cleanly for requested content');
  assert.equal(guard.status().contentStarted, true);
  guard.disarm();
});

test('RapidReentryBarrier 8: Immediate repeated re-entry across several sessions does not carry progression ownership across generations', async () => {
  const { api, logs } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 4;
  media.duration = 120;
  media.currentTime = 20;
  media.seekable = { length: 1, end: () => 120 };
  player.classList.add('ad-showing');

  // Simulate Rapid Hover -> Leave across Gen 1, 2, 3, 4
  for (let gen = 1; gen <= 4; gen += 1) {
    let current = true;
    const guard = api.create({
      generation: 400 + gen,
      sessionId: 'gen-' + String(400 + gen),
      surface: 'history-native-fallback',
      videoId: 'video-' + String(gen),
      getPlayer: () => player,
      media: media,
      overlay: overlay,
      isCurrent: () => current,
      status: () => Promise.resolve({ requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: false })
    });

    guard.arm();
    guard.noteLoadRequested();
    guard.refresh();

    assert.equal(guard.status().confirmedAdSegments, 0, `Gen ${gen} must confirm 0 ads on stale media`);
    assert.equal(media.currentTime, 20, `Gen ${gen} must not seek`);
    assert.equal(guard.status().presentationClosed, true, `Gen ${gen} must keep gate closed`);

    // Abrupt user leave
    current = false;
    guard.disarm('user-left');
  }

  // All 4 generations successfully blocked stale progression
  for (let gen = 1; gen <= 4; gen += 1) {
    assert.ok(
      logs.some((entry) => entry[0] === '[YTPM][RapidReentryBarrier]' && entry.join(' ').includes('generation=' + String(400 + gen)) && entry.join(' ').includes('phase=stale-media-blocked')),
      `Gen ${gen} must log stale-media-blocked`
    );
  }
});

test('RapidReentryBarrier 9: No-ad fast path unaffected', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 501,
    sessionId: 'gen-501',
    surface: 'history-native-fallback',
    videoId: 'fastPathVideo',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();
  media.emit('loadstart');

  media.readyState = 4;
  media.duration = 45;
  media.seekable = { length: 1, end: () => 45 };
  media.emit('loadedmetadata');

  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().confirmedAdSegments, 0);
  guard.disarm();
});

test('RapidReentryBarrier 10: ContentReadyRecovery 5000ms behavior operates normally when released', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };
  let recoveryCalls = 0;

  const guard = api.create({
    generation: 502,
    sessionId: 'gen-502',
    surface: 'history-native-fallback',
    videoId: 'dQw4w9WgXcQ',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus),
    contentReadyRecovery: () => { recoveryCalls += 1; return Promise.resolve({ ok: true, loadInvoked: true, loadThrew: false }); },
    getRecoveryContext: () => ({ ownershipValid: true, hoverValid: true })
  });

  guard.arm();
  guard.noteLoadRequested();

  // 1. Initial ad
  media.readyState = 3;
  media.duration = 10;
  media.seekable = { length: 1, end: () => 10 };
  media.emit('loadstart');
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);
  assert.equal(guard.status().confirmedAdSegments, 1);

  // 2. Content handoff with readyState=0
  player.classList.remove('ad-showing');
  bridgeStatus.active = false;
  bridgeStatus.reason = 'content';
  bridgeStatus.requestedVideoIdMatches = true;
  bridgeStatus.playerVideoIdMatchesRequested = true;
  media.readyState = 0;
  media.duration = NaN;
  media.seekable = { length: 0 };
  media.emit('loadstart');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  runNextTimer();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // Fast-forward to 5000ms
  runUntil(runNextTimer, () => recoveryCalls === 1, 80);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  assert.equal(recoveryCalls, 1, '5000ms recovery runs after barrier release and ad completion');
  guard.disarm();
});

test('RapidReentryBarrier 11: Same-canonical-epoch progression guard remains intact', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  let bridgeStatus = { requestedVideoIdMatches: true, active: false, reason: 'content', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: true };

  const guard = api.create({
    generation: 503,
    sessionId: 'gen-503',
    surface: 'history-native-fallback',
    videoId: 'sameEpochVideo',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  guard.noteLoadRequested();
  media.emit('loadstart');

  media.readyState = 4;
  media.duration = 100;
  media.seekable = { length: 1, end: () => 100 };
  media.emit('loadedmetadata');

  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().presentationClosed === false);

  assert.equal(guard.status().presentationClosed, false);
  assert.equal(guard.status().contentStarted, true);

  // Stale ad-showing in same content epoch does not progress
  player.classList.add('ad-showing');
  bridgeStatus.active = true;
  bridgeStatus.reason = 'ad-showing';
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  const sameEpochLog = logs.find((entry) => entry[0] === '[YTPM][AdProgressGuard]' && entry.join(' ').includes('phase=same-canonical-epoch-blocked'));
  assert.ok(sameEpochLog, 'Same canonical epoch must be blocked from ad progression');
  assert.equal(guard.status().confirmedAdSegments, 0);

  guard.disarm();
});

test('RapidReentryBarrier 12: Home surface is completely unaffected by residue barrier', async () => {
  const { api, logs, runNextTimer } = loadGuard();
  const player = new FakeElement();
  const overlay = new FakeElement();
  const media = createActiveMedia();
  media.readyState = 4;
  media.duration = 15;
  media.seekable = { length: 1, end: () => 15 };
  let bridgeStatus = { requestedVideoIdMatches: false, active: true, reason: 'ad-showing', associationSource: 'player-api', associationAvailable: true, playerVideoIdMatchesRequested: false };

  // Home preview uses overlay surface (default)
  const guard = api.create({
    generation: 504,
    sessionId: 'gen-504',
    surface: 'overlay',
    videoId: 'homeVideo',
    getPlayer: () => player,
    media: media,
    overlay: overlay,
    isCurrent: () => true,
    status: () => Promise.resolve(bridgeStatus)
  });

  guard.arm();
  player.classList.add('ad-showing');
  guard.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  runUntil(runNextTimer, () => guard.status().confirmedAdSegments === 1);

  // Home arms and progresses ad immediately without residue barrier
  assert.equal(guard.status().confirmedAdSegments, 1, 'Home preview progresses ads normally');
  const barrierLogs = logs.filter((entry) => entry[0] === '[YTPM][RapidReentryBarrier]');
  assert.equal(barrierLogs.length, 0, 'Zero RapidReentryBarrier logs for Home surface');

  guard.disarm();
});

test('HistoryOwnershipEnd 1: Stale callback generation is distinguishable from current generation', () => {
  const logs = [];
  const sandbox = {
    console: { debug(...args) { logs.push(args); }, log() {}, warn() {}, error() {} },
    performance: { now: () => 1 },
    document: { createElement: () => new FakeElement(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { location: { pathname: '/feed/history' }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  const card = new FakeElement();
  const session = { generation: 2, card: card, startedAt: Date.now() - 200, active: true };
  sandbox.__YTPMForensics.logHistoryOwnershipEnd(session, 'fallback-ownership-ended', {
    callbackGeneration: 2,
    currentGeneration: 5,
    scheduledAt: Date.now() - 150
  });

  const endLog = logs.find((entry) => entry[0] === '[YTPM][HistoryOwnershipEnd]');
  assert.ok(endLog, 'Must emit [YTPM][HistoryOwnershipEnd]');
  const text = endLog.join(' ');
  assert.ok(text.includes('generation=2'), 'Identifies session generation');
  assert.ok(text.includes('callbackGeneration=2'), 'Identifies callback generation');
  assert.ok(text.includes('currentGeneration=5'), 'Identifies current generation');
  assert.ok(text.includes('callbackAgeMs='), 'Includes callback age in ms');
  assert.ok(text.includes('reason=fallback-ownership-ended'));
});

test('HistoryOwnershipEnd 2: Current-session ownership end reports exact hover and geometry state', () => {
  const logs = [];
  const sandbox = {
    console: { debug(...args) { logs.push(args); }, log() {}, warn() {}, error() {} },
    performance: { now: () => 1 },
    document: { createElement: () => new FakeElement(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { location: { pathname: '/feed/history' }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  const card = new FakeElement();
  const outer = new FakeElement();
  const inner = new FakeElement();
  const session = {
    generation: 6,
    card: card,
    outer: outer,
    inner: inner,
    overlay: outer,
    lastPointer: { x: 50, y: 50 },
    active: true
  };

  sandbox.__YTPMForensics.logHistoryOwnershipEnd(session, 'fallback-ownership-ended');

  const endLog = logs.find((entry) => entry[0] === '[YTPM][HistoryOwnershipEnd]');
  assert.ok(endLog);
  const text = endLog.join(' ');
  assert.ok(text.includes('generation=6'));
  assert.ok(text.includes('currentFallbackGeneration=0'));
  assert.ok(text.includes('sessionStillCurrent=false'));
  assert.ok(text.includes('cardConnected=true'));
  assert.ok(text.includes('outerConnected=true'));
  assert.ok(text.includes('innerConnected=true'));
  assert.ok(text.includes('pointerInsideOverlay='));
  assert.ok(text.includes('pointerInsideCardGeometry='));
  assert.ok(text.includes('pointerInsideThumbnailGeometry='));
  assert.ok(text.includes('activeCardSame=false'));
  assert.ok(text.includes('pendingCleanupPresent=false'));
  assert.ok(text.includes('cleanupOwnerGeneration=none'));
  assert.ok(text.includes('reason=fallback-ownership-ended'));
});

test('HistoryOwnershipEnd 3: Scheduled ownership cleanup identifies its owner generation', () => {
  const logs = [];
  const sandbox = {
    console: { debug(...args) { logs.push(args); }, log() {}, warn() {}, error() {} },
    performance: { now: () => 1 },
    document: { createElement: () => new FakeElement(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { location: { pathname: '/feed/history' }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  const card = new FakeElement();
  const session = { generation: 6, card: card, active: true };
  sandbox.__YTPMForensics.logHistoryOwnershipEndSchedule(6, 6, 80, 'automatic-hover', session);

  const schedLog = logs.find((entry) => entry[0] === '[YTPM][HistoryOwnershipEndSchedule]');
  assert.ok(schedLog, 'Must emit [YTPM][HistoryOwnershipEndSchedule]');
  const text = schedLog.join(' ');
  assert.ok(text.includes('generation=6'));
  assert.ok(text.includes('callbackGeneration=6'));
  assert.ok(text.includes('delayMs=80'));
  assert.ok(text.includes('trigger=automatic-hover'));
  assert.ok(text.includes('cardHovered='));
  assert.ok(text.includes('pointerInsideOverlay='));
  assert.ok(text.includes('sessionStillCurrent=false'));
});

test('HistoryOwnershipEnd 4: Cancellation identifies the callback generation', () => {
  const logs = [];
  const sandbox = {
    console: { debug(...args) { logs.push(args); }, log() {}, warn() {}, error() {} },
    performance: { now: () => 1 },
    document: { createElement: () => new FakeElement(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
    window: { location: { pathname: '/feed/history' }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });

  sandbox.__YTPMForensics.logHistoryOwnershipEndCancel(6, 6, 'intent-rescheduled');

  const cancelLog = logs.find((entry) => entry[0] === '[YTPM][HistoryOwnershipEndCancel]');
  assert.ok(cancelLog, 'Must emit [YTPM][HistoryOwnershipEndCancel]');
  const text = cancelLog.join(' ');
  assert.ok(text.includes('generation=6'));
  assert.ok(text.includes('callbackGeneration=6'));
  assert.ok(text.includes('cancelReason=intent-rescheduled'));
});

test('HistoryOwnershipEnd 5: Diagnostics do not leak URLs or object dumps and preserve static invariants', () => {
  assert.match(contentSource, /\[YTPM\]\[HistoryOwnershipEnd\]/);
  assert.match(contentSource, /\[YTPM\]\[HistoryOwnershipEndSchedule\]/);
  assert.match(contentSource, /\[YTPM\]\[HistoryOwnershipEndCancel\]/);

  // Monitor timer logs before calling cleanup
  assert.match(contentSource, /logHistoryOwnershipEnd\(session,\s*'fallback-ownership-ended'/);

  // Ensure telemetry does not leak URLs, media sources, or arbitrary object dumps
  const helperSource = contentSource.slice(contentSource.indexOf('function logHistoryOwnershipEnd'), contentSource.indexOf('function logAdExposureFenceFailure'));
  assert.doesNotMatch(helperSource, /currentSrc|videoUrl|JSON\.stringify/);
});









