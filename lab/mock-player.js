import { mockFetchPlayer } from './mock-network.js';
import { createPayloadSession } from './payload.js';

export const PLAYER_STATES = Object.freeze(['UNPREPARED', 'IDLE', 'LOADING', 'AD_CREATED', 'AD_SHOWING', 'AD_INTERRUPTING', 'CONTENT_READY', 'CONTENT_PLAYING', 'CANCELLED', 'ERROR']);
const allowed = { UNPREPARED: ['IDLE'], IDLE: ['LOADING'], LOADING: ['AD_CREATED', 'CONTENT_READY', 'CANCELLED', 'ERROR'], AD_CREATED: ['AD_SHOWING', 'CANCELLED', 'ERROR'], AD_SHOWING: ['AD_INTERRUPTING', 'CANCELLED', 'ERROR'], AD_INTERRUPTING: ['CONTENT_READY', 'CANCELLED', 'ERROR'], CONTENT_READY: ['CONTENT_PLAYING', 'CANCELLED', 'ERROR'], CONTENT_PLAYING: ['LOADING', 'CANCELLED'], CANCELLED: ['LOADING', 'IDLE'], ERROR: ['LOADING', 'IDLE'] };

export class MockInlinePlayer {
  constructor({ fetchPlayer = mockFetchPlayer, sanitizer = null, sanitizerFactory = null, onEvent = () => {}, onError = () => {} } = {}) {
    this.fetchPlayer = fetchPlayer; this.sanitizer = sanitizer; this.sanitizerFactory = sanitizerFactory; this.onEvent = onEvent; this.onError = onError;
    this.generation = 0; this.videoId = ''; this.loadId = ''; this.inner = null; this.session = null; this.lifecycleState = 'UNPREPARED'; this.state = 'unprepared'; this.events = [];
    this.outer = { id: 'inline-player', tagName: 'YTD-PLAYER', staged: false };
  }
  transition(next, details = {}) {
    if (next !== this.lifecycleState && !(allowed[this.lifecycleState] || []).includes(next)) throw new Error(`Illegal transition ${this.lifecycleState}->${next}`);
    this.lifecycleState = next; this.state = next.toLowerCase().replaceAll('_', '-'); const event = { event: next, generation: this.generation, videoId: this.videoId, loadId: this.loadId, elapsedMs: 0, ...details }; this.events.push(event); this.onEvent(next.toLowerCase().replaceAll('_', '-'), event);
  }
  preparePlayer() {
    if (this.lifecycleState === 'UNPREPARED') this.transition('IDLE');
    if (!this.inner) this.inner = { id: 'inline-preview-player', className: 'html5-video-player', video: { paused: true, readyState: 0, currentTime: 0 }, classes: new Set() };
    return this.inner;
  }
  async loadVideoById(videoId, { scenario = videoId, generation = this.generation + 1, delayMs } = {}) {
    if (!this.inner) this.preparePlayer();
    if (this.session?.invalidate) this.session.invalidate('new-generation');
    this.generation = generation; this.videoId = videoId; this.loadId = `load-${generation}-${videoId}`;
    const owned = { generation, videoId, loadId: this.loadId };
    this.session = this.sanitizerFactory ? this.sanitizerFactory(owned) : (this.sanitizer ? { sanitize: this.sanitizer } : createPayloadSession(owned));
    this.inner.classes.clear(); this.inner.video.paused = true; this.inner.video.readyState = 0;
    this.events.push({ event: 'requestStarted', ...owned, elapsedMs: 0 });
    this.transition('LOADING');
    const raw = await this.fetchPlayer(videoId, { scenario, delayMs });
    this.events.push({ event: 'requestResolved', ...owned, elapsedMs: 0 });
    if (owned.generation !== this.generation || owned.videoId !== this.videoId) return { stale: true, generation, videoId };
    const result = this.session.sanitize(raw, { ...owned, requestType: 'player' });
    if (result.sanitized) this.events.push({ event: 'responseConsumptionStarted', ...owned, elapsedMs: 0 });
    if (result.reason === 'malformed-response') { this.transition('ERROR', { reason: result.reason }); return { error: result.reason, generation, videoId }; }
    return this.consumePlayerResponse(result.response, { ...owned, result, raw });
  }
  consumePlayerResponse(response, session) {
    if (session.generation !== this.generation || session.videoId !== this.videoId || this.lifecycleState === 'CANCELLED') return { stale: true, ...session };
    if (session.result?.sanitized && Object.keys(response).some((key) => ['adPlacements', 'playerAds', 'adSlots'].includes(key))) throw new Error('AD_PAYLOAD_REACHED_CONSUMPTION_BOUNDARY');
    const hadAds = ['adPlacements', 'playerAds', 'adSlots'].some((key) => Object.prototype.hasOwnProperty.call(response || {}, key)) || Boolean(response?.auxiliary?.playerAds || response?.playbackContext?.adSlots);
    this.inner.video.readyState = 1;
    if (hadAds) { this.events.push({ event: 'adLifecycleEntered', ...session, elapsedMs: 0 }); this.transition('AD_CREATED'); this.transition('AD_SHOWING'); this.inner.classes.add('ad-showing'); this.transition('AD_INTERRUPTING'); this.inner.classes.clear(); }
    this.transition('CONTENT_READY'); this.inner.video.paused = false; this.inner.video.currentTime = 0.1; this.transition('CONTENT_PLAYING'); this.events.push({ event: 'contentLifecycleEntered', ...session, elapsedMs: 0 }); this.events.push({ event: 'sessionCompleted', ...session, elapsedMs: 0 });
    return { generation: session.generation, videoId: session.videoId, rawHadAds: Object.keys(session.raw || {}).length > 0 && (Object.prototype.hasOwnProperty.call(session.raw, 'adPlacements') || Boolean(session.raw.auxiliary?.playerAds)), sanitizedHadAds: hadAds, removedPaths: session.result?.removedPaths || [] };
  }
  cancel() { if (this.session) this.session.cancel(); if (this.lifecycleState !== 'CANCELLED') this.transition('CANCELLED'); this.inner?.classes.clear(); }
}
