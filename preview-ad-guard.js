(function () {
  'use strict';

  console.debug('[YTPM][AdGuard] phase=module-loaded');
 

  const AD_PLAYER_CLASSES = ['ad-showing', 'ad-interrupting', 'ad-created'];
  const AD_UI_SELECTORS = ['.ytp-ad-player-overlay', '.ytp-ad-text', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-container', '.ytp-ad-module', '.ytp-ad-overlay-container', '.ytp-ad-preview-container', '.ytp-ad-preview-text', '.ytp-ad-message-container', '.ytp-ad-message', '.ytp-ad-persistent-banner', '.ytp-ad-image-overlay', '.ytp-ad-action-interstitial', '.ytp-ad-end-screens-paginated', '.ytp-paid-content-overlay', '.ytp-ad-badge', '.ytp-chrome-top', '.ytp-title', '.ytp-title-text', '.ytp-title-link', '.ytp-title-channel', '.ytp-chrome-bottom', '.ytp-gradient-top', '.ytp-gradient-bottom'];
  const AD_UI_CATEGORIES = [
    { selector: '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-container', category: 'SKIP_AD' },
    { selector: '.ytp-ad-preview-container, .ytp-ad-preview-text, .ytp-ad-text, .ytp-ad-module, .ytp-ad-message, .ytp-ad-message-container, .ytp-ad-persistent-banner', category: 'AD_COUNTDOWN' },
    { selector: '.ytp-ad-player-overlay, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-paid-content-overlay, .ytp-ad-badge', category: 'AD_OVERLAY' },
    { selector: '.ytp-chrome-top, .ytp-title, .ytp-title-text, .ytp-title-link, .ytp-title-channel', category: 'AD_TITLE' },
    { selector: '.ytp-ad-action-interstitial, .ytp-ad-end-screens-paginated', category: 'AD_ENDCARD' }
  ];
  const SKIP_SELECTORS = ['.ytp-ad-skip-button-modern', '.ytp-ad-skip-button', '.ytp-ad-skip-button-container button', 'button.ytp-ad-skip-button', '[role="button"].ytp-ad-skip-button'];
  const MAX_AD_SEGMENTS = 3;
  const MAX_MEDIA_LOAD_EPOCH = 32;
  const AD_END_EPSILON_SECONDS = 0.25;
  const AD_ACCELERATION_RATE = 4;
  const AD_ACCELERATION_CANDIDATES = [16, 8, AD_ACCELERATION_RATE];
  const MAX_AD_RATE_REAPPLIES = 3;
  const CONTENT_STABILIZATION_MS = 250;
  const READINESS_OBSERVATION_MS = 1500;
  const ACCELERATION_OBSERVATION_MS = 500;
  const SEEK_OBSERVATION_MS = 1000;
  const SEEK_NEAR_END_TOLERANCE_SECONDS = 0.75;
  const TERMINAL_TRANSITION_SOFT_DELAY_MS = 8000;
  const TERMINAL_TRANSITION_OBSERVATION_MS = 10000;
  const POST_LOAD_CLASSIFICATION_MS = 100;
  const POST_LOAD_PENDING_RESOLUTION_MS = 3000;
  const TERMINAL_ENDPOINT_PROBE_DELAY_MS = 2000;
  const TERMINAL_CLOCK_SAMPLE_MS = 500;
  const TERMINAL_CLOCK_MAX_MS = 10000;
  const HOLD_BREAK_PROBE_DELAY_MS = 500;
  const HOLD_BREAK_PROBE_RESULT_MS = 1500;
  const CONTENT_MEDIA_READY_RECOVERY_MS = 5000;
  const CONTENT_READY_RECOVERY_RESULT_MS = 1800;
  const finalizedLatencySummaries = new Set();
  const finalizedControllerHolds = new Set();

  function isConnected(element) { return Boolean(element && element.isConnected); }
  function isVisible(element) {
    if (!isConnected(element)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }
  function getPlayerStatus(player) {
    if (!isConnected(player)) return { active: false, confidence: 'none', reason: 'player-unavailable' };
    const nodes = [player].concat(Array.from(player.querySelectorAll('.html5-video-player')));
    for (const node of nodes) {
      const reason = AD_PLAYER_CLASSES.find(function (name) { return node.classList.contains(name) || node.hasAttribute(name) || node.getAttribute('data-' + name) === 'true'; });
      if (reason) return { active: true, confidence: 'high', reason: reason };
    }
    const ui = player.querySelector(AD_UI_SELECTORS.join(','));
    return ui && isVisible(ui) ? { active: true, confidence: 'high', reason: 'active-ad-ui' } : { active: false, confidence: 'high', reason: 'content' };
  }
  function normalizeStatus(value) {
    if (!value || typeof value !== 'object') return null;
    return { active: value.active === true, confidence: value.confidence === 'high' ? 'high' : 'none', reason: typeof value.reason === 'string' ? value.reason.slice(0, 80) : 'unknown', requestedVideoIdMatches: value.requestedVideoIdMatches === true, associationSource: typeof value.associationSource === 'string' ? value.associationSource.slice(0, 80) : 'unavailable', associationAvailable: value.associationAvailable === true, playerReportedVideoIdPresent: value.playerReportedVideoIdPresent === true, playerReportedVideoIdMatches: value.playerReportedVideoIdMatches === true, playerState: Number.isFinite(value.playerState) ? value.playerState : null, playerCurrentTime: Number.isFinite(value.playerCurrentTime) ? value.playerCurrentTime : null, playerDuration: Number.isFinite(value.playerDuration) ? value.playerDuration : null, loadedFraction: Number.isFinite(value.loadedFraction) ? value.loadedFraction : null, playerVideoIdPresent: value.playerVideoIdPresent === true, playerVideoIdMatchesRequested: value.playerVideoIdMatchesRequested === true };
  }

  function createGuard(options) {
    const config = options && typeof options === 'object' ? options : {};
    const state = { armed: false, suppressed: false, presentationClosed: false, presentationClosedAt: 0, initialPresentationClosedAt: 0, firstMediaPlayAt: 0, presentationOpenedAt: 0, contentConfirmedAt: 0, skipInvoked: false, adDetected: false, contentStarted: false, contentEstablishedEpoch: -1, laterAdInterruptionEpoch: -1, requestedContentClassified: false, contentHandoff: null, handoffSequence: 0, observer: null, mediaCleanup: [], readinessCleanup: [], seekCleanup: [], terminalCleanup: [], progressTimer: 0, contentConfirmationTimer: 0, postLoadTimer: 0, postLoadPending: null, lastAssociation: null, lastBridgeStatus: null, media: null, mediaState: null, originalMuted: false, originalVolume: 1, originalPlaybackRate: 1, contentBaseline: { playbackRate: 1, muted: false, volume: 1, latched: false }, visualQuarantine: false, quarantineTimer: 0, pageContentConfirmed: false, confirmedAdSegments: 0, currentPodConfirmedSegments: 0, segmentSequence: 0, currentAdSegment: null, loadEpoch: 0, progressionBudgetLogged: false, summaryLogged: false, presentationSummaryLogged: false, presentationCloseCycles: 0, presentationOpenCycles: 0, postContentReclosures: 0, visibleAdViolation: false, adUiSummaryLogged: false, adUiSeen: {}, skipUiDetected: false, skipUiVisibleWhileClosed: false, otherAdUiDetected: false, otherAdUiVisibleWhileClosed: false, latencyStartedAt: 0, latencyFirstAdAt: 0, latencyRequestedContentAt: 0, latencyContentConfirmedAt: 0, latencyGateOpenedAt: 0, latencyTerminalWaitMs: 0, latencyPostLoadWaitMs: 0, latencySummaryLogged: false, adPodSummaryLogged: false, adPod: { loadRequestedAt: 0, firstConfirmedAdAt: 0, firstConfirmedAdSegment: 0, initialConfirmedAdSegments: 0, initialFinalized: false, laterAdSegments: 0, provisionalAdPodEndedAt: 0, finalRequestedContentAssociatedAt: 0, finalRequestedContentConfirmedAt: 0, requestedContentAssociatedAt: 0, requestedContentConfirmedAt: 0, presentationGateOpenedAt: 0, gateOpenedAt: 0, adPodEndedAt: 0, segments: new Map(), initialSegments: [] }, lastLoggedAdState: 'none', holdBreakProbe: null, holdBreakStats: { holdsObserved: 0, commandsInvoked: 0, fastLoadstartsTriggered: 0, adReentries: 0, requestedContentTransitions: 0, initialRequestedContentReached: 0, laterAdInterruptions: 0, contentResumedAfterLaterAd: 0, staleContentClassifications: 0, nativeTransitionsBeforeProbe: 0, commandNoEffects: 0, totalObservedHoldMs: 0, totalCommandToLoadstartMs: 0, maxCommandToLoadstartMs: 0, summaryLogged: false }, contentReadyRecovery: null, preloadResidue: null };
    function sessionCurrent() { return typeof config.isCurrent === 'function' && config.isCurrent(); }
    function current() { return state.armed && sessionCurrent(); }
    function player() { return typeof config.getPlayer === 'function' ? config.getPlayer() : null; }
    function presentationSessionId() { return String(config.sessionId || config.generation || 'preview-session'); }
    function ownsPresentationGate() { return Boolean(config.overlay && config.overlay.getAttribute('data-ytpm-presentation-session') === presentationSessionId()); }
    function media() { return typeof config.getMedia === 'function' ? config.getMedia() : config.media; }
    function log(message, details) { if (console && typeof console.debug === 'function') console.debug('[YTPM][AdGuard]', 'generation=' + String(config.generation), message, details || {}); }
    function progressLog(segment, phase, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(segment), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdProgress]', parts.join(' '));
    }
    function progressGuardLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdProgressGuard]', parts.join(' '));
    }
    function contentBaselineLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][ContentMediaBaseline]', parts.join(' '));
    }
    function contentReadyRecoveryLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][ContentReadyRecovery]', parts.join(' '));
    }
    function rapidReentryBarrierLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'loadEpoch=' + String(state.loadEpoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][RapidReentryBarrier]', parts.join(' '));
    }
    function seekLog(segment, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(segment), 'phase=result'];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdSeek]', parts.join(' '));
    }
    function terminalLog(segment, phase, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(segment), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdTerminal]', parts.join(' '));
    }
    function postLoadLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdPostLoad]', parts.join(' '));
    }
    function contentIdentityLog(epoch, phase, fields) {
      const parts = ['generation=' + String(config.generation), 'loadEpoch=' + String(epoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdContentIdentity]', parts.join(' '));
    }
    function contentHandoffLog(epoch, phase, fields) {
      if (['waiting-media-ready', 'media-ready-wakeup', 'confirmed', 'restored', 'cancelled'].indexOf(phase) < 0) return;
      const parts = ['generation=' + String(config.generation), 'loadEpoch=' + String(epoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdContentHandoff]', parts.join(' '));
    }
    function adPodLog(milestone, fields) {
      if (milestone !== 'ad-reentry') return;
      const parts = ['generation=' + String(config.generation), 'milestone=' + milestone];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdPodLatency]', parts.join(' '));
    }
    function ensureSegmentTiming(segment) {
      if (!segment) return null;
      let segData = segment.adPodTiming;
      if (!segData) {
        segData = {
          segmentNumber: segment.number,
          confirmedOrdinal: 0,
          initialOrdinal: 0,
          isInitial: Boolean(segment.isInitialAdPod),
          segmentConfirmedAt: 0,
          mediaReadyAt: 0,
          endpointEvidenceAt: 0,
          mediaResetAt: 0,
          nextLoadstartAt: 0,
          nextClassificationAt: 0
        };
        segment.adPodTiming = segData;
        if (state.adPod.segments) {
          state.adPod.segments.set(segment.number, segData);
        }
      }
      return segData;
    }
    function notePreviousSegmentClassification(atTime) {
      const records = state.adPod.initialSegments && state.adPod.initialSegments.length > 0 ? state.adPod.initialSegments : state.adPod.segments;
      if (!records) return;
      records.forEach(function (segData) {
        if (segData.isInitial && segData.nextLoadstartAt && !segData.nextClassificationAt) {
          segData.nextClassificationAt = atTime || latencyNow();
        }
      });
    }
    function invalidateProvisionalPodEnd() {
      if (state.contentStarted || state.adPod.initialFinalized) return;
      state.adPod.provisionalAdPodEndedAt = 0;
      state.adPod.adPodEndedAt = 0;
      state.adPod.finalRequestedContentAssociatedAt = 0;
      state.adPod.finalRequestedContentConfirmedAt = 0;
    }
    function presentationNow() { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
    function latencyNow() { return presentationNow(); }
    function latencyElapsed() { return state.latencyStartedAt ? Math.max(0, Math.round(latencyNow() - state.latencyStartedAt)) : 0; }
    function latencyLog() {}
    function segmentLatencyFields(segment) {
      const sample = measurement(segment && segment.media);
      return { segment: segment ? segment.number : 0, loadEpoch: segment ? segment.loadEpoch : state.loadEpoch, segmentElapsedMs: segment && segment.latencyStartedAt ? Math.max(0, Math.round(latencyNow() - segment.latencyStartedAt)) : 0, durationSeconds: sample.durationFinite ? Math.round(Number(segment.media.duration) * 10) / 10 : 'unknown', skipAvailable: Boolean(segment && segment.skipAvailable), skipInvoked: Boolean(segment && segment.skipAttempted), seekAttempted: Boolean(segment && segment.seekAttempted), seekEffective: Boolean(segment && segment.seekEffective), accelerationApplied: Boolean(segment && segment.accelerationApplied), terminalWaitMs: Math.round(Number(segment && segment.terminalWaitMs) || 0) };
    }
    function accelerationLog(segment, phase, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(segment ? segment.number : 0), 'loadEpoch=' + String(segment ? segment.loadEpoch : state.loadEpoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdAcceleration]', parts.join(' '));
    }
    function terminalClockSnapshot(segment, observation) {
      if (!segment || !observation || !current() || !terminalIdentityCurrent(segment)) return;
      const activeMedia = segment.media; const sample = measurement(activeMedia); const currentTime = Number(activeMedia.currentTime) || 0;
      if (Number.isFinite(sample.end) && currentTime >= sample.end - AD_END_EPSILON_SECONDS) latchTerminalEndpointEvidence(segment);
      observeControllerHold(segment, observation, sample, currentTime, activeAdFlags());
    }
    function holdBreakLog(probe, phase, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(probe.segment.number), 'loadEpoch=' + String(probe.loadEpoch), 'holdOrdinal=' + String(probe.holdOrdinal), 'phase=' + phase];
      ['timeToNextLoadstartMs', 'classification', 'reason'].forEach(function (key) { if (fields && Object.prototype.hasOwnProperty.call(fields, key)) parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdHoldBreak]', parts.join(' '));
    }
    function postContentLifecycleLog(phase, segment, reason) {
      console.debug('[YTPM][AdPostContentLifecycle]', 'generation=' + String(config.generation), 'segment=' + String(segment ? segment.number : 0), 'loadEpoch=' + String(segment ? segment.loadEpoch : state.loadEpoch), 'phase=' + String(phase), 'reason=' + String(reason));
    }
    function genuineLaterAdInterruption(segment) {
      return Boolean(state.contentStarted && segment && segment.confirmed && segment.laterAdInterruption === true && segment.loadEpoch > state.contentEstablishedEpoch && exactSegmentCurrent(segment));
    }
    function clearHoldBreakProbe(probe) { if (!probe) return; if (probe.armTimer) window.clearTimeout(probe.armTimer); if (probe.resultTimer) window.clearTimeout(probe.resultTimer); probe.armTimer = 0; probe.resultTimer = 0; }
    function isMediaReset(activeMedia, sample, currentTime) {
      return Boolean(activeMedia && Number(activeMedia.readyState) === 0 && !sample.durationFinite && currentTime <= 0.1);
    }
    function holdBreakFields() { return {}; }
    function holdBreakEligible(probe) {
      const activeMedia = probe.segment.media; const sample = measurement(activeMedia); const flags = activeAdFlags(); const identity = ownershipIdentity(activeMedia);
      return Boolean(config.surface === 'history-native-fallback' && current() && (!state.contentStarted || genuineLaterAdInterruption(probe.segment)) && probe.hold === probe.observation.controllerHold && !probe.hold.closed && probe.observation.priorMediaReachedEnd && probe.segment.confirmed && state.loadEpoch === probe.loadEpoch && exactSegmentCurrent(probe.segment) && identity.outer === probe.outer && identity.inner === probe.inner && identity.video === probe.video && isMediaReset(activeMedia, sample, Number(activeMedia.currentTime) || 0) && (flags.adShowing || flags.adInterrupting) && /^[A-Za-z0-9_-]{11}$/.test(String(config.videoId || '')) && Boolean(state.lastBridgeStatus && state.lastBridgeStatus.playerVideoIdMatchesRequested));
    }
    function finishHoldBreakProbe(probe, classification, fields) { if (!probe || probe.outcomeLogged) return; probe.outcomeLogged = true; clearHoldBreakProbe(probe); const stats = state.holdBreakStats; stats.totalObservedHoldMs += Math.max(0, Math.round(latencyNow() - probe.hold.startedAt)); if (classification === 'NATIVE_TRANSITION_BEFORE_PROBE') stats.nativeTransitionsBeforeProbe += 1; if (classification === 'COMMAND_NO_EFFECT') stats.commandNoEffects += 1; if (classification === 'COMMAND_TRIGGERED_AD_REENTRY') stats.adReentries += 1; holdBreakLog(probe, 'outcome', Object.assign({ classification: classification, holdBreakSucceeded: classification === 'COMMAND_TRIGGERED_AD_REENTRY' || classification === 'COMMAND_TRIGGERED_REQUESTED_CONTENT' || classification === 'COMMAND_TRIGGERED_FAST_LOADSTART', adPodCompleted: classification === 'COMMAND_TRIGGERED_REQUESTED_CONTENT' }, fields || {})); }
    function armHoldBreakProbe(segment, observation, hold) {
      if (config.surface !== 'history-native-fallback' || !hold || state.holdBreakProbe && state.holdBreakProbe.hold === hold) return;
      if (state.contentStarted && !genuineLaterAdInterruption(segment)) { postContentLifecycleLog('later-hold-rejected', segment, 'NO_GENUINE_LATER_AD_CONFIRMATION'); return; }
      if (state.contentStarted) postContentLifecycleLog('later-hold-eligible', segment, 'CONFIRMED_ACTIVE_AD_NEW_LOAD_EPOCH');
      const identity = ownershipIdentity(segment.media); const probe = { segment: segment, observation: observation, hold: hold, holdOrdinal: ++state.holdBreakStats.holdsObserved, loadEpoch: segment.loadEpoch, outer: identity.outer, inner: identity.inner, video: segment.media, armedAt: latencyNow(), armTimer: 0, resultTimer: 0, commandIssuedAt: 0, commandIssued: false, outcomeLogged: false };
      state.holdBreakProbe = probe;
      holdBreakLog(probe, 'hold-entered');
      if (config.holdBreakProbeEnabled !== true || typeof config.holdBreakProbe !== 'function') return;
      probe.armTimer = window.setTimeout(function () {
        probe.armTimer = 0;
        if (state.loadEpoch !== probe.loadEpoch) { finishHoldBreakProbe(probe, 'NATIVE_TRANSITION_BEFORE_PROBE', { timeToNextLoadstartMs: Math.max(0, Math.round(latencyNow() - probe.armedAt)), newLoadEpoch: state.loadEpoch }); return; }
        if (!current() || !holdBreakEligible(probe)) { finishHoldBreakProbe(probe, current() ? 'COMMAND_REJECTED' : 'SESSION_INVALIDATED', holdBreakFields(probe)); return; }
        holdBreakLog(probe, 'command-invoked'); probe.commandIssued = true; probe.commandIssuedAt = latencyNow(); state.holdBreakStats.commandsInvoked += 1;
        Promise.resolve(config.holdBreakProbe()).then(function (result) {
          const loadInvoked = Boolean(result && result.loadInvoked); const loadThrew = Boolean(result && result.loadThrew);
          if (!loadInvoked || loadThrew) { finishHoldBreakProbe(probe, 'COMMAND_REJECTED', { loadInvoked: loadInvoked, loadThrew: loadThrew }); return; }
          probe.resultTimer = window.setTimeout(function () { probe.resultTimer = 0; if (!probe.outcomeLogged) finishHoldBreakProbe(probe, probe.transitionSeen ? 'COMMAND_TRIGGERED_FAST_LOADSTART' : 'COMMAND_NO_EFFECT', { loadInvoked: true, loadThrew: false, timeToNextLoadstartMs: probe.transitionElapsedMs || 'unknown', newLoadEpoch: probe.newLoadEpoch || 'unknown' }); }, HOLD_BREAK_PROBE_RESULT_MS);
        }).catch(function () { finishHoldBreakProbe(probe, 'COMMAND_REJECTED', { loadInvoked: false, loadThrew: true }); });
      }, HOLD_BREAK_PROBE_DELAY_MS);
    }
    function noteHoldBreakLoadstart(previousEpoch) {
      const probe = state.holdBreakProbe;
      if (!probe || probe.loadEpoch !== previousEpoch || probe.outcomeLogged) return;
      const elapsed = Math.max(0, Math.round(latencyNow() - (probe.commandIssued ? probe.commandIssuedAt : probe.armedAt)));
      probe.transitionSeen = true; probe.transitionElapsedMs = elapsed; probe.newLoadEpoch = state.loadEpoch;
      if (probe.segment) {
        const segData = ensureSegmentTiming(probe.segment);
        if (segData && !segData.nextLoadstartAt) segData.nextLoadstartAt = latencyNow();
      }
      if (probe.commandIssued) { state.holdBreakStats.fastLoadstartsTriggered += 1; state.holdBreakStats.totalCommandToLoadstartMs += elapsed; state.holdBreakStats.maxCommandToLoadstartMs = Math.max(state.holdBreakStats.maxCommandToLoadstartMs, elapsed); }
      holdBreakLog(probe, probe.commandIssued ? 'transition' : 'native-transition', Object.assign({ timeToNextLoadstartMs: elapsed, newLoadEpoch: state.loadEpoch }, holdBreakFields(probe)));
      if (!probe.commandIssued) finishHoldBreakProbe(probe, 'NATIVE_TRANSITION_BEFORE_PROBE', { timeToNextLoadstartMs: elapsed, newLoadEpoch: state.loadEpoch });
    }
    function latchTerminalEndpointEvidence(segment, source) {
      const observation = segment && segment.terminalObservation;
      if (!observation || observation.priorMediaReachedEnd || !exactSegmentCurrent(segment)) return false;
      observation.priorMediaReachedEnd = true;
      if (segment) {
        const segData = ensureSegmentTiming(segment);
        if (segData && !segData.endpointEvidenceAt) segData.endpointEvidenceAt = latencyNow();
      }
      adPodLog('endpoint-evidence', { segment: segment.number, loadEpoch: segment.loadEpoch, source: source || 'evidence', elapsedMs: latencyElapsed() });
      if (observation.lastResetSnapshot) observeControllerHold(segment, observation, observation.lastResetSnapshot.sample, observation.lastResetSnapshot.currentTime, activeAdFlags());
      return true;
    }
    function observeControllerHold(segment, observation, sample, currentTime, flags) {
      const activeMedia = segment.media;
      const mediaReset = isMediaReset(activeMedia, sample, currentTime);
      if (mediaReset) {
        observation.lastResetSnapshot = { sample: sample, currentTime: currentTime };
        if (segment) {
          const segData = ensureSegmentTiming(segment);
          if (segData && !segData.mediaResetAt) segData.mediaResetAt = latencyNow();
        }
        adPodLog('media-reset', { segment: segment.number, loadEpoch: segment.loadEpoch, elapsedMs: latencyElapsed() });
      }
      if (observation.controllerHold || !observation.priorMediaReachedEnd || !mediaReset || !(flags.adShowing || flags.adInterrupting)) return;
      const holdKey = String(config.sessionId || config.generation) + ':' + String(segment.number) + ':' + String(segment.loadEpoch);
      if (finalizedControllerHolds.has(holdKey)) return;
      const hold = observation.controllerHold = { key: holdKey, startedAt: latencyNow(), closed: false };
      armHoldBreakProbe(segment, observation, hold);
    }
    function presentationLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'phase=' + phase, 'elapsedMs=' + String(Math.round(presentationNow() - state.presentationClosedAt))];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][PresentationGate]', parts.join(' '));
    }
    function adUiLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'loadEpoch=' + String(state.loadEpoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdUiGate]', parts.join(' '));
    }
    function adUiExposureLog(phase, fields) {
      const parts = ['generation=' + String(config.generation), 'loadEpoch=' + String(state.loadEpoch), 'phase=' + phase];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdUiExposure]', parts.join(' '));
    }
    function adUiClassTokens(node) {
      const classValue = typeof node.className === 'string' ? node.className : node.getAttribute && node.getAttribute('class') || '';
      return String(classValue).split(/\s+/).filter(Boolean).filter(function (token) { return token.indexOf('ytp-') === 0; }).slice(0, 6).join(',') || 'none';
    }
    function inspectAdUi() {
      if (!current() || !state.presentationClosed || !ownsPresentationGate()) return;
      const activePlayer = player();
      if (!isConnected(activePlayer)) return;
      AD_UI_CATEGORIES.forEach(function (entry) {
        Array.from(activePlayer.querySelectorAll(entry.selector)).forEach(function (node) {
          if (!isConnected(node)) return;
          const key = entry.category + ':' + adUiClassTokens(node);
          if (state.adUiSeen[key]) return;
          state.adUiSeen[key] = true;
          if (entry.category === 'SKIP_AD') state.skipUiDetected = true;
          else state.otherAdUiDetected = true;
          const fields = { ui: entry.category, tag: String(node.tagName || 'unknown').toLowerCase(), classTokens: adUiClassTokens(node), ariaLabelPresent: Boolean(node.getAttribute && node.getAttribute('aria-label')), textCategory: entry.category };
          adUiExposureLog('detected', fields);
          adUiLog('ad-ui-detected', { ui: entry.category });
          adUiLog('ad-ui-hidden', { ui: entry.category });
        });
      });
    }
    function closePresentationGate(reason) {
      if (state.presentationClosed || !config.overlay) return;
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch && reason !== 'post-content-transition' && reason !== 'media-replaced-post-content' && reason !== 'post-content-active-ad-quarantine') {
        return;
      }
      state.presentationClosed = true;
      state.presentationClosedAt = presentationNow();
      if (!state.initialPresentationClosedAt) state.initialPresentationClosedAt = state.presentationClosedAt;
      state.presentationCloseCycles += 1;
      if (state.contentStarted) state.postContentReclosures += 1;
      config.overlay.setAttribute('data-ytpm-presentation-session', presentationSessionId());
      config.overlay.setAttribute('data-ytpm-presentation-closed', 'true');
      presentationLog(state.contentStarted ? 'reclosed-post-content' : 'closed', reason ? { reason: reason } : {});
      adUiLog(state.contentStarted ? 'reclosed-post-content' : 'closed');
    }
    function openPresentationGate() {
      if (!state.presentationClosed || !current() || !ownsPresentationGate()) return;
      config.overlay.removeAttribute('data-ytpm-presentation-closed');
      state.presentationClosed = false;
      state.presentationOpenedAt = presentationNow();
      state.presentationOpenCycles += 1;
      state.latencyGateOpenedAt = latencyNow();
      latencyLog('gate-opened');
      if (!state.adPod.presentationGateOpenedAt) {
        state.adPod.presentationGateOpenedAt = latencyNow();
        state.adPod.gateOpenedAt = state.adPod.presentationGateOpenedAt;
      }
      adPodLog('presentation-gate-opened', { elapsedMs: latencyElapsed() });
      presentationLog(state.presentationOpenCycles > 1 ? 'reopened-content' : 'opened', { reason: 'content-confirmed' });
      adUiLog(state.presentationOpenCycles > 1 ? 'reopened-content' : 'opened');
    }
    function mediaStateLog(segment, event, fields) {
      const parts = ['generation=' + String(config.generation), 'segment=' + String(segment || 0), 'event=' + event];
      Object.keys(fields || {}).forEach(function (key) { parts.push(key + '=' + String(fields[key])); });
      console.debug('[YTPM][AdMediaState]', parts.join(' '));
    }
    function ownershipIdentity(activeMedia) {
      const details = typeof config.getRecoveryContext === 'function' ? config.getRecoveryContext() || {} : {};
      return { outer: details.outer || config.overlay || null, inner: details.inner || player(), video: activeMedia || state.media || null };
    }
    function attachMedia() {
      const nextMedia = media();
      if (nextMedia === state.media) return nextMedia;
      const previousMedia = state.media;
      if ((previousMedia && nextMedia && nextMedia !== previousMedia) || (state.preloadResidue && state.preloadResidue.media && nextMedia && nextMedia !== state.preloadResidue.media)) {
        releasePreloadResidue('MEDIA_REPLACED');
      }
      if (state.contentStarted && !state.presentationClosed && nextMedia && nextMedia !== previousMedia) {
        state.loadEpoch = Math.min(MAX_MEDIA_LOAD_EPOCH, state.loadEpoch + 1);
        closePresentationGate('media-replaced-post-content');
        suppress('media-replaced-post-content');
      }
      if (state.contentHandoff && state.contentHandoff.media !== nextMedia) cancelDeferredHandoff(state.contentHandoff, 'MEDIA_CHANGED');
      if (state.currentAdSegment && state.currentAdSegment.seekObservation) finishSeekObservation(state.currentAdSegment, 'SEEK_MEDIA_REPLACED');
      if (state.currentAdSegment && state.currentAdSegment.terminalObservation) finishTerminalObservation(state.currentAdSegment, 'VIDEO_REPLACED');
      clearReadinessObservation();
      clearSeekObservation();
      state.mediaCleanup.splice(0).forEach(function (cleanup) { cleanup(); });
      state.media = nextMedia || null;
      if (!isConnected(state.media)) return null;
      if (!state.contentBaseline.latched && !state.contentStarted) {
        state.contentBaseline.playbackRate = Number.isFinite(state.media.playbackRate) && Number(state.media.playbackRate) > 0 ? Number(state.media.playbackRate) : 1;
        state.contentBaseline.muted = Boolean(state.media.muted);
        state.contentBaseline.volume = Number.isFinite(state.media.volume) ? state.media.volume : 1;
      }
      state.mediaState = { playbackRate: Number(state.media.playbackRate) || 1, guardRateExpected: null };
      if (state.presentationClosed && !state.suppressed) { state.originalMuted = Boolean(state.media.muted); state.originalVolume = Number.isFinite(state.media.volume) ? state.media.volume : 1; state.originalPlaybackRate = Number.isFinite(state.media.playbackRate) ? state.media.playbackRate : 1; state.media.muted = true; state.suppressed = true; if (config.overlay) config.overlay.setAttribute('data-ytpm-ad-suppressed', 'true'); }
      ['loadstart', 'playing', 'loadeddata', 'emptied', 'ended', 'ratechange', 'volumechange', 'pause', 'play', 'durationchange', 'timeupdate'].forEach(function (type) {
        state.media.addEventListener(type, onMediaEvent);
        state.mediaCleanup.push(function () { if (state.media) state.media.removeEventListener(type, onMediaEvent); });
      });
      return state.media;
    }
    function setPlaybackRate(activeMedia, value) {
      const from = Number(activeMedia.playbackRate) || 1;
      if (state.mediaState && state.media === activeMedia) state.mediaState.guardRateExpected = value;
      activeMedia.playbackRate = value;
      if (state.mediaState && state.media === activeMedia) state.mediaState.playbackRate = value;
      if (from !== value) mediaStateLog(state.currentAdSegment && state.currentAdSegment.number, 'ratechange', { from: from, to: value, guardInitiated: true });
    }
    function applyAdaptiveAcceleration(segment, reason, phase) {
      if (!segment || !segment.confirmed || !exactSegmentCurrent(segment) || !isActiveAdPlayback(getPlayerStatus(player()))) return false;
      if (isPreloadResidueActive(segment.media)) return false;
      if (state.contentStarted && segment.loadEpoch <= state.contentEstablishedEpoch) return false;
      const activeMedia = segment.media;
      const previousRate = Number(activeMedia.playbackRate) || 1;
      for (let index = 0; index < AD_ACCELERATION_CANDIDATES.length; index += 1) {
        const requestedRate = AD_ACCELERATION_CANDIDATES[index];
        try {
          setPlaybackRate(activeMedia, requestedRate);
          const appliedRate = Number(activeMedia.playbackRate) || 1;
          if (appliedRate === requestedRate) {
            segment.selectedAccelerationRate = appliedRate;
            segment.accelerationApplied = true;
            accelerationLog(segment, phase, { requestedRate: requestedRate, appliedRate: appliedRate, reason: reason, reapplyCount: segment.reapplyCount || 0 });
            return true;
          }
        } catch (error) {}
      }
      try { setPlaybackRate(activeMedia, previousRate); } catch (error) {}
      accelerationLog(segment, phase, { requestedRate: AD_ACCELERATION_RATE, appliedRate: Number(activeMedia.playbackRate) || 1, reason: reason, reapplyCount: segment.reapplyCount || 0, accepted: false });
      return false;
    }
    function clearReadinessObservation() { state.readinessCleanup.splice(0).forEach(function (cleanup) { cleanup(); }); }
    function clearSeekObservation() { state.seekCleanup.splice(0).forEach(function (cleanup) { cleanup(); }); }
    function clearTerminalObservation() { state.terminalCleanup.splice(0).forEach(function (cleanup) { cleanup(); }); }
    function measurement(activeMedia) {
      let seekable = false;
      let end = Number(activeMedia && activeMedia.duration);
      try { if (activeMedia && activeMedia.seekable && activeMedia.seekable.length > 0) { end = Number(activeMedia.seekable.end(activeMedia.seekable.length - 1)); seekable = Number.isFinite(end) && end > 0; } } catch (error) { end = NaN; }
      let start = 0;
      try { if (activeMedia && activeMedia.seekable && activeMedia.seekable.length > 0) start = Number(activeMedia.seekable.start(activeMedia.seekable.length - 1)); } catch (error) { start = 0; }
      return { durationFinite: Number.isFinite(Number(activeMedia && activeMedia.duration)) && Number(activeMedia.duration) > 0, seekable: seekable, readyState: Number(activeMedia && activeMedia.readyState) || 0, start: start, end: end };
    }
    function isPreloadResidueActive(targetMedia) {
      if (!state.preloadResidue || !state.preloadResidue.active) return false;
      if (state.loadEpoch > state.preloadResidue.loadEpochAtArm) {
        state.preloadResidue.active = false;
        return false;
      }
      if (targetMedia && targetMedia !== state.preloadResidue.media) {
        state.preloadResidue.active = false;
        return false;
      }
      return true;
    }
    function releasePreloadResidue(reason) {
      if (!state.preloadResidue || !state.preloadResidue.active) return;
      state.preloadResidue.active = false;
      const activeMedia = state.media || media();
      const sample = activeMedia ? measurement(activeMedia) : { durationFinite: false, seekable: false, readyState: 0 };
      rapidReentryBarrierLog('released', {
        sameMediaAsArm: Boolean(activeMedia && activeMedia === state.preloadResidue.media),
        readyState: sample.readyState,
        durationFinite: sample.durationFinite,
        seekable: sample.seekable,
        releaseReason: reason
      });
    }
    function exactSegmentCurrent(segment) {
      if (!current() || state.currentAdSegment !== segment || !segment.media || media() !== segment.media || !isConnected(segment.media) || state.loadEpoch !== segment.loadEpoch) return false;
      const identity = ownershipIdentity(segment.media);
      return identity.outer === segment.outer && identity.inner === segment.inner && identity.video === segment.video;
    }
    function endSegment(segment, evidence, nextState) {
      if (!segment || segment.ended) return;
      segment.ended = true; clearReadinessObservation();
      if (segment.terminalObservation) finishTerminalObservation(segment, evidence);
      if (segment.accelerationTimer) { window.clearTimeout(segment.accelerationTimer); segment.accelerationTimer = 0; }
      progressLog(segment.number, 'segment-ended', { evidence: evidence, nextState: nextState || 'unknown' });
      if (segment.accelerationApplied) accelerationLog(segment, 'ended', { requestedRate: segment.selectedAccelerationRate || AD_ACCELERATION_RATE, appliedRate: Number(segment.media.playbackRate) || 1, reason: evidence, reapplyCount: segment.reapplyCount || 0 });
      latencyLog('segment-ended', segmentLatencyFields(segment));
    }
    function observeAcceleration(segment) {
      if (segment.accelerationObserved || !segment.accelerationTimer) return;
      window.clearTimeout(segment.accelerationTimer); segment.accelerationTimer = 0;
      if (!exactSegmentCurrent(segment)) return;
      segment.accelerationObserved = true;
      const advanced = Number(segment.media.currentTime) > segment.accelerationStartTime;
      progressLog(segment.number, 'acceleration-observed', { currentTimeAdvanced: advanced, playbackRateStillApplied: Number(segment.media.playbackRate) === segment.appliedPlaybackRate });
      if (advanced) confirmAdSegment(segment, 'ACTIVE_MEDIA_ADVANCING');
    }
    function activeAdFlags() {
      const activePlayer = player();
      return {
        adCreated: Boolean(activePlayer && activePlayer.classList.contains('ad-created')),
        adShowing: Boolean(activePlayer && activePlayer.classList.contains('ad-showing')),
        adInterrupting: Boolean(activePlayer && activePlayer.classList.contains('ad-interrupting'))
      };
    }
    function terminalIdentityCurrent(segment) {
      if (!current() || !segment || media() !== segment.media || !isConnected(segment.media)) return false;
      const identity = ownershipIdentity(segment.media);
      return identity.outer === segment.outer && identity.inner === segment.inner && identity.video === segment.video;
    }
    function finishTerminalObservation(segment, evidence) {
      const observation = segment && segment.terminalObservation;
      if (!observation || observation.finished) return;
      observation.finished = true;
      if (observation.timer) window.clearTimeout(observation.timer);
      if (observation.softTimer) window.clearTimeout(observation.softTimer);
      if (observation.probeTimer) window.clearTimeout(observation.probeTimer);
      if (observation.clockTimer) window.clearTimeout(observation.clockTimer);
      if (observation.controllerHold && !observation.controllerHold.closed) { observation.controllerHold.closed = true; finalizedControllerHolds.add(observation.controllerHold.key); }
      terminalClockSnapshot(segment, observation);
      const terminalWaitMs = Math.max(0, Math.round(latencyNow() - observation.latencyStartedAt));
      segment.terminalWaitMs = (segment.terminalWaitMs || 0) + terminalWaitMs;
      state.latencyTerminalWaitMs += terminalWaitMs;
      latencyLog('terminal-transition', Object.assign(segmentLatencyFields(segment), { terminalWaitMs: terminalWaitMs, evidence: evidence }));
      terminalLog(segment.number, 'transition', { evidence: evidence, elapsedMs: Math.max(0, Math.round(Date.now() - observation.startedAt)) });
      clearTerminalObservation();
    }
    function startTerminalTransitionObservation(segment) {
      if (!exactSegmentCurrent(segment) || segment.terminalObservation) return;
      const observation = { startedAt: Date.now(), latencyStartedAt: latencyNow(), finished: false, timer: 0, probeTimer: 0, probeAttempted: false, clockTimer: 0, firstCurrentTime: NaN, lastCurrentTime: NaN, lastRemaining: NaN, clockReverted: false, priorMediaReachedEnd: false, lastResetSnapshot: null, controllerHold: null };
      segment.terminalObservation = observation;
      latencyLog('terminal-wait-start', segmentLatencyFields(segment));
      terminalClockSnapshot(segment, observation);
      const sampleClock = function () {
        observation.clockTimer = 0;
        if (observation.finished || !terminalIdentityCurrent(segment)) return;
        terminalClockSnapshot(segment, observation);
        if (latencyNow() - observation.latencyStartedAt < TERMINAL_CLOCK_MAX_MS) observation.clockTimer = window.setTimeout(sampleClock, TERMINAL_CLOCK_SAMPLE_MS);
      };
      observation.clockTimer = window.setTimeout(sampleClock, TERMINAL_CLOCK_SAMPLE_MS);
      terminalLog(segment.number, 'waiting-for-player-transition', { softBoundMs: TERMINAL_TRANSITION_SOFT_DELAY_MS, hardBoundMs: TERMINAL_TRANSITION_OBSERVATION_MS });
      const onTransition = function (event) {
        if (event.target !== segment.media || observation.finished || !terminalIdentityCurrent(segment)) return;
        if (event.type === 'loadstart') finishTerminalObservation(segment, 'NEW_LOADSTART');
        else if (event.type === 'ended') finishTerminalObservation(segment, 'MEDIA_ENDED');
        else terminalClockSnapshot(segment, observation);
      };
      ['loadstart', 'ended', 'durationchange', 'timeupdate', 'pause', 'emptied', 'abort'].forEach(function (type) { segment.media.addEventListener(type, onTransition); state.terminalCleanup.push(function () { segment.media.removeEventListener(type, onTransition); }); });
      observation.probeTimer = window.setTimeout(function () {
        observation.probeTimer = 0;
        if (observation.finished || observation.probeAttempted || !segment.confirmed || !exactSegmentCurrent(segment) || !isActiveAdPlayback(getPlayerStatus(player())) || segment.media.paused) return;
        const sample = measurement(segment.media);
        if (!sample.seekable || !Number.isFinite(sample.end) || sample.end < sample.start || Number(segment.media.currentTime) < segment.seekTarget - SEEK_NEAR_END_TOLERANCE_SECONDS) return;
        observation.probeAttempted = true;
        const beforeCurrentTime = Number(segment.media.currentTime) || 0;
        try { segment.media.currentTime = sample.end; terminalLog(segment.number, 'endpoint-probe', { invoked: true, threw: false }); terminalClockSnapshot(segment, observation); }
        catch (error) { terminalLog(segment.number, 'endpoint-probe', { invoked: false, threw: true }); terminalClockSnapshot(segment, observation); }
      }, TERMINAL_ENDPOINT_PROBE_DELAY_MS);
      observation.softTimer = window.setTimeout(function () {
        observation.softTimer = 0;
        if (!observation.finished) terminalLog(segment.number, 'transition-delayed', { elapsedMs: TERMINAL_TRANSITION_SOFT_DELAY_MS });
      }, TERMINAL_TRANSITION_SOFT_DELAY_MS);
      observation.timer = window.setTimeout(function () {
        observation.timer = 0;
        if (!observation.finished) { observation.finished = true; terminalLog(segment.number, 'transition-timeout', { classification: 'AD_MEDIA_NEAR_END_BUT_PLAYER_NOT_TRANSITIONING', boundMs: TERMINAL_TRANSITION_OBSERVATION_MS }); if (observation.clockTimer) window.clearTimeout(observation.clockTimer); terminalClockSnapshot(segment, observation); const terminalWaitMs = Math.max(0, Math.round(latencyNow() - observation.latencyStartedAt)); segment.terminalWaitMs = (segment.terminalWaitMs || 0) + terminalWaitMs; state.latencyTerminalWaitMs += terminalWaitMs; latencyLog('terminal-transition', Object.assign(segmentLatencyFields(segment), { terminalWaitMs: terminalWaitMs, evidence: 'TIMEOUT' })); clearTerminalObservation(); }
      }, TERMINAL_TRANSITION_OBSERVATION_MS);
      state.terminalCleanup.push(function () { if (observation.timer) window.clearTimeout(observation.timer); if (observation.softTimer) window.clearTimeout(observation.softTimer); if (observation.probeTimer) window.clearTimeout(observation.probeTimer); if (observation.clockTimer) window.clearTimeout(observation.clockTimer); observation.timer = 0; observation.softTimer = 0; observation.probeTimer = 0; observation.clockTimer = 0; });
    }
    function armControllerForensics() {}
    function confirmAdSegment(segment, evidence) {
      if (!segment || segment.confirmed) return true;
      if (isPreloadResidueActive(segment.media)) return false;
      if (state.contentStarted && segment.loadEpoch <= state.contentEstablishedEpoch) return false;
      if (state.currentPodConfirmedSegments >= MAX_AD_SEGMENTS) return false;
      if (!state.presentationClosed) {
        state.visibleAdViolation = true;
        console.error('[YTPM][AdExposureFence]', 'INVARIANT_FAILURE: confirmed ad active while PresentationGate open', 'generation=' + String(config.generation), 'segment=' + String(segment.number), 'loadEpoch=' + String(segment.loadEpoch));
      }
      segment.confirmed = true;
      state.confirmedAdSegments += 1;
      state.currentPodConfirmedSegments += 1;
      segment.confirmedNumber = state.confirmedAdSegments;
      segment.podConfirmedNumber = state.currentPodConfirmedSegments;
      if (state.contentStarted) {
        const flags = activeAdFlags();
        segment.laterAdInterruption = Boolean(segment.loadEpoch > state.contentEstablishedEpoch && exactSegmentCurrent(segment) && (flags.adShowing || flags.adInterrupting));
        if (segment.laterAdInterruption) { state.laterAdInterruptionEpoch = segment.loadEpoch; state.holdBreakStats.laterAdInterruptions += 1; postContentLifecycleLog('later-ad-confirmed', segment, 'CONFIRMED_ACTIVE_AD_NEW_LOAD_EPOCH'); }
      }
      const isInitialAd = !state.contentStarted && !state.adPod.initialFinalized;
      segment.isInitialAdPod = isInitialAd;
      if (isInitialAd) {
        state.adPod.initialConfirmedAdSegments += 1;
        segment.initialConfirmedOrdinal = state.adPod.initialConfirmedAdSegments;
        if (!state.adPod.firstConfirmedAdAt) {
          state.adPod.firstConfirmedAdAt = latencyNow();
          state.adPod.firstConfirmedAdSegment = segment.number;
          state.latencyFirstAdAt = latencyNow();
        }
        invalidateProvisionalPodEnd();
        notePreviousSegmentClassification(latencyNow());
      } else {
        state.adPod.laterAdSegments += 1;
      }
      armControllerForensics(segment, evidence === 'LATE_MEDIA_READY' ? 'MEDIA_READY_CONFIRMATION' : 'EXISTING_SEGMENT_CONFIRMATION');
      progressLog(segment.number, 'classified', { classification: 'ACTIVE_AD_MEDIA', loadEpoch: segment.loadEpoch, confirmedAdSegment: segment.confirmedNumber, podConfirmedSegment: segment.podConfirmedNumber, evidence: evidence });
      if (segment) {
        const segData = ensureSegmentTiming(segment);
        if (segData) {
          segData.isInitial = isInitialAd;
          segData.confirmedOrdinal = segment.confirmedNumber;
          segData.initialOrdinal = isInitialAd ? segment.initialConfirmedOrdinal : 0;
          if (!segData.segmentConfirmedAt) segData.segmentConfirmedAt = latencyNow();
          if (isInitialAd && state.adPod.initialSegments && state.adPod.initialSegments.indexOf(segData) < 0) {
            state.adPod.initialSegments.push(segData);
          }
        }
      }
      adPodLog('segment-confirmed', { segment: segment.number, loadEpoch: segment.loadEpoch, evidence: evidence, elapsedMs: latencyElapsed() });
      latencyLog('ad-playback-confirmed', Object.assign(segmentLatencyFields(segment), { classification: 'ACTIVE_AD_MEDIA' }));
      startTerminalTransitionObservation(segment);
      return true;
    }
    function progressionBudgetAvailable(segment) {
      if (segment.confirmed || state.currentPodConfirmedSegments < MAX_AD_SEGMENTS) return true;
      if (!state.progressionBudgetLogged) {
        state.progressionBudgetLogged = true;
        progressLog(segment.number, 'progression-budget-exhausted', {
          currentPodConfirmedSegments: state.currentPodConfirmedSegments,
          sessionConfirmedSegments: state.confirmedAdSegments,
          limit: MAX_AD_SEGMENTS
        });
      }
      return false;
    }
    function finishSeekObservation(segment, forcedClassification) {
      const observation = segment && segment.seekObservation;
      if (!observation || observation.finished) return;
      observation.finished = true;
      if (observation.timer) window.clearTimeout(observation.timer);
      const sameMedia = media() === segment.media;
      const stillCurrent = exactSegmentCurrent(segment);
      const observed = Number(segment.media.currentTime) || 0;
      const moved = Math.abs(observed - observation.before) > 0.05;
      const reachedNearEnd = observed >= observation.target - SEEK_NEAR_END_TOLERANCE_SECONDS;
      let classification = forcedClassification;
      if (!classification) {
        if (!current()) classification = 'SEEK_SESSION_INVALIDATED';
        else if (!sameMedia || !stillCurrent) classification = 'SEEK_MEDIA_REPLACED';
        else if (observation.sawLoadstart) classification = 'SEEK_SUPERSEDED_BY_NEW_LOAD';
        else if (reachedNearEnd) classification = 'SEEK_REACHED_NEAR_END';
        else if (observation.sawNearEnd) classification = 'SEEK_APPLIED_THEN_REVERTED';
        else if (moved) classification = 'SEEK_CLAMPED_BEFORE_END';
        else classification = 'SEEK_NEVER_APPLIED';
      }
      const flags = activeAdFlags();
      const adStillActive = flags.adCreated || flags.adShowing || flags.adInterrupting;
      seekLog(segment.number, {
        classification: classification,
        seekAssigned: true,
        sawSeeking: observation.sawSeeking,
        sawSeeked: observation.sawSeeked,
        currentTimeMoved: moved,
        reachedNearEnd: reachedNearEnd,
        ended: observation.ended,
        sawLoadstart: observation.sawLoadstart,
        adStillActive: adStillActive,
        adCreated: flags.adCreated,
        adShowing: flags.adShowing,
        adInterrupting: flags.adInterrupting,
        durationSeconds: Math.round(observation.duration * 10) / 10,
        seekableStartSeconds: Math.round(observation.seekableStart * 10) / 10,
        seekableEndSeconds: Math.round(observation.seekableEnd * 10) / 10,
        targetSeconds: Math.round(observation.target * 10) / 10,
        observedCurrentTimeSeconds: Math.round(observed * 10) / 10,
        remainingSeconds: Math.round(Math.max(0, observation.seekableEnd - observed) * 10) / 10,
        paused: Boolean(segment.media.paused),
        playbackRate: Number(segment.media.playbackRate) || 1,
        currentTimeAdvancing: observed > observation.before
      });
      segment.seekEffective = reachedNearEnd || classification === 'SEEK_SUPERSEDED_BY_NEW_LOAD';
      if (segment.seekEffective) {
        latchTerminalEndpointEvidence(segment, 'EXISTING_EFFECTIVE_SEEK');
        adPodLog('progression-action', { segment: segment.number, loadEpoch: segment.loadEpoch, action: 'seek-effective', elapsedMs: latencyElapsed() });
      }
      latencyLog(segment.seekEffective ? 'seek-effective' : 'seek-ineffective', Object.assign(segmentLatencyFields(segment), { classification: classification }));
      if (segment.confirmed && !segment.seekEffective && (classification === 'SEEK_APPLIED_THEN_REVERTED' || classification === 'SEEK_CLAMPED_BEFORE_END' || classification === 'SEEK_NEVER_APPLIED')) applyAdaptiveAcceleration(segment, classification, 'escalated');
      if (segment.confirmed && adStillActive && !observation.ended && !observation.sawLoadstart) startTerminalTransitionObservation(segment);
      if (classification === 'SEEK_CLAMPED_BEFORE_END') {
        progressLog(segment.number, 'terminal-stall', { classification: 'AD_MEDIA_SEEK_RESTRICTED' });
      }
      clearSeekObservation();
    }
    function startSeekObservation(segment, sample, target, before) {
      clearSeekObservation();
      if (!exactSegmentCurrent(segment)) return;
      const observation = {
        duration: Number(segment.media.duration), seekableStart: sample.start, seekableEnd: sample.end,
        target: target, before: before, sawSeeking: false, sawSeeked: false, ended: false,
        sawLoadstart: false, sawNearEnd: false, finished: false, timer: 0
      };
      segment.seekObservation = observation;
      const onSeekEvent = function (event) {
        if (event.target !== segment.media || observation.finished) return;
        if (event.type === 'seeking') observation.sawSeeking = true;
        if (event.type === 'seeked') observation.sawSeeked = true;
        if (event.type === 'ended') observation.ended = true;
        if (event.type === 'loadstart') observation.sawLoadstart = true;
        if (Number(segment.media.currentTime) >= target - SEEK_NEAR_END_TOLERANCE_SECONDS) { observation.sawNearEnd = true; latchTerminalEndpointEvidence(segment, 'SEEK_EVENT_NEAR_END'); }
        if (event.type === 'ended') finishSeekObservation(segment);
      };
      ['seeking', 'seeked', 'timeupdate', 'playing', 'ended', 'durationchange', 'loadstart'].forEach(function (type) { segment.media.addEventListener(type, onSeekEvent); state.seekCleanup.push(function () { segment.media.removeEventListener(type, onSeekEvent); }); });
      observation.timer = window.setTimeout(function () { finishSeekObservation(segment); }, SEEK_OBSERVATION_MS);
      state.seekCleanup.push(function () { if (observation.timer) window.clearTimeout(observation.timer); observation.timer = 0; });
    }
    function seekNearEnd(segment, source) {
      if (!exactSegmentCurrent(segment)) return false;
      if (isPreloadResidueActive(segment.media)) return false;
      if (state.contentStarted && segment.loadEpoch <= state.contentEstablishedEpoch) return false;
      const sample = measurement(segment.media);
      const target = Number.isFinite(sample.end) && sample.end > 0 ? Math.max(0, sample.end - AD_END_EPSILON_SECONDS) : NaN;
      if (!sample.durationFinite || !sample.seekable || !Number.isFinite(target) || target < sample.start || target > sample.end) return false;
      const before = Number(segment.media.currentTime) || 0;
      try {
        segment.media.currentTime = target;
        segment.progressed = true;
        segment.seekAttempted = true;
        segment.seekTarget = target;
        startSeekObservation(segment, sample, target, before);
        if (Number(segment.media.currentTime) >= target - SEEK_NEAR_END_TOLERANCE_SECONDS) latchTerminalEndpointEvidence(segment, 'SEEK_READBACK_NEAR_END');
        progressLog(segment.number, 'seek-attempt', { invoked: true, targetNearEnd: true, source: source, threw: false });
        latencyLog('seek-attempt', Object.assign(segmentLatencyFields(segment), { source: source }));
        adPodLog('progression-action', { segment: segment.number, loadEpoch: segment.loadEpoch, action: 'seek-attempt', source: source, elapsedMs: latencyElapsed() });
        return true;
      }
      catch (error) { segment.seekAttempted = true; progressLog(segment.number, 'seek-attempt', { invoked: false, targetNearEnd: true, source: source, threw: true }); latencyLog('seek-ineffective', Object.assign(segmentLatencyFields(segment), { source: source, threw: true })); return false; }
    }
    function startReadinessObservation(segment) {
      if (!exactSegmentCurrent(segment) || segment.readinessObserved || segment.readinessTimer) return;
      const onReadiness = function () {
        if (!exactSegmentCurrent(segment) || segment.readinessObserved) return;
        const sample = measurement(segment.media);
        if (sample.durationFinite === segment.initialDurationFinite && sample.seekable === segment.initialSeekable && sample.readyState === segment.initialReadyState) return;
        segment.readinessObserved = true;
        progressLog(segment.number, 'media-ready', { durationFinite: sample.durationFinite, seekable: sample.seekable, readyState: sample.readyState, durationSeconds: sample.durationFinite ? Math.round(Number(segment.media.duration) * 10) / 10 : 'unavailable' });
        if (segment) {
          const segData = ensureSegmentTiming(segment);
          if (segData && !segData.mediaReadyAt) segData.mediaReadyAt = latencyNow();
        }
        adPodLog('media-ready', { segment: segment.number, loadEpoch: segment.loadEpoch, elapsedMs: latencyElapsed() });
        if (sample.durationFinite && sample.seekable && confirmAdSegment(segment, 'LATE_MEDIA_READY') && progressionBudgetAvailable(segment)) seekNearEnd(segment, 'media-ready');
      };
      ['loadedmetadata', 'durationchange', 'progress', 'canplay'].forEach(function (type) { segment.media.addEventListener(type, onReadiness); state.readinessCleanup.push(function () { segment.media.removeEventListener(type, onReadiness); }); });
      segment.readinessTimer = window.setTimeout(function () { segment.readinessTimer = 0; clearReadinessObservation(); }, READINESS_OBSERVATION_MS);
      state.readinessCleanup.push(function () { if (segment.readinessTimer) window.clearTimeout(segment.readinessTimer); segment.readinessTimer = 0; });
    }
    function suppress(reason) {
      if (!current()) return;
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch &&
          reason !== 'post-content-transition' &&
          reason !== 'media-replaced-post-content' &&
          reason !== 'post-content-active-ad-quarantine') {
        return;
      }
      state.adDetected = true;
      if (state.suppressed) return;
      const activeMedia = attachMedia(); if (!activeMedia) return;
      if (!state.contentStarted || state.loadEpoch > state.contentEstablishedEpoch) {
        state.originalMuted = Boolean(activeMedia.muted);
        state.originalVolume = Number.isFinite(activeMedia.volume) ? activeMedia.volume : 1;
        state.originalPlaybackRate = Number.isFinite(activeMedia.playbackRate) ? activeMedia.playbackRate : 1;
      }
      activeMedia.muted = true;
      if (config.overlay) config.overlay.setAttribute('data-ytpm-ad-suppressed', 'true');
      state.suppressed = true;
      log('action=media-suppressed', { reason: reason });
    }
    function maybeRecoverFromQuarantine() {
      if (!current() || !state.visualQuarantine) return;
      if (state.loadEpoch > state.contentEstablishedEpoch) {
        state.visualQuarantine = false;
        return;
      }
      const status = getPlayerStatus(player());
      if (!isActiveAdPlayback(status) && state.contentStarted && state.loadEpoch === state.contentEstablishedEpoch) {
        state.visualQuarantine = false;
        progressGuardLog('quarantine-recovered', { loadEpoch: state.loadEpoch });
        restoreContent();
      } else if (isActiveAdPlayback(status) && state.contentStarted && state.loadEpoch === state.contentEstablishedEpoch) {
        if (!state.quarantineTimer) {
          state.quarantineTimer = window.setTimeout(function () {
            state.quarantineTimer = 0;
            maybeRecoverFromQuarantine();
          }, 250);
        }
      }
    }
    function activeAdFlags() {
      const playerEl = player();
      if (!playerEl) return { adShowing: false, adInterrupting: false, adCreated: false };
      const nodes = [playerEl].concat(Array.from(playerEl.querySelectorAll('.html5-video-player')));
      let adShowing = false;
      let adInterrupting = false;
      let adCreated = false;
      for (const node of nodes) {
        if (node.classList.contains('ad-showing') || node.hasAttribute('ad-showing') || node.getAttribute('data-ad-showing') === 'true') adShowing = true;
        if (node.classList.contains('ad-interrupting') || node.hasAttribute('ad-interrupting') || node.getAttribute('data-ad-interrupting') === 'true') adInterrupting = true;
        if (node.classList.contains('ad-created') || node.hasAttribute('ad-created') || node.getAttribute('data-ad-created') === 'true') adCreated = true;
      }
      return { adShowing: adShowing, adInterrupting: adInterrupting, adCreated: adCreated };
    }
    function clearDeferredHandoffWakeup(handoff) {
      if (!handoff) return;
      if (handoff.recoveryTimer) { window.clearTimeout(handoff.recoveryTimer); handoff.recoveryTimer = 0; }
      if (!handoff.readinessCleanup) return;
      handoff.readinessCleanup.splice(0).forEach(function (cleanup) { cleanup(); });
      handoff.readinessArmed = false;
    }
    function cancelDeferredHandoff(handoff, reason) {
      if (!handoff || handoff.stage !== 'waiting-media-ready') return;
      if (handoff.recoveryTimer) {
        window.clearTimeout(handoff.recoveryTimer);
        handoff.recoveryTimer = 0;
        contentReadyRecoveryLog('invalidated', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, reason: reason });
      }
      clearDeferredHandoffWakeup(handoff); handoff.stage = 'cancelled';
      contentHandoffLog(handoff.epoch, 'cancelled', { reason: reason, handoffSerial: handoff.serial });
      if (reason === 'AD_REENTRY') {
        invalidateProvisionalPodEnd();
        notePreviousSegmentClassification(latencyNow());
        adPodLog('ad-reentry', { loadEpoch: handoff.epoch, reason: reason, elapsedMs: latencyElapsed() });
      }
    }
    function deferredHandoffFields(handoff, activeMedia) {
      const flags = activeAdFlags();
      return { expectedLoadEpoch: handoff.epoch, currentLoadEpoch: state.loadEpoch, sameVideoNode: handoff.media === activeMedia && state.media === activeMedia && media() === activeMedia, readyState: Number(activeMedia && activeMedia.readyState) || 0, associationMatch: Boolean(state.lastAssociation && state.lastAssociation.matches), adShowing: flags.adShowing, adInterrupting: flags.adInterrupting };
    }
    function wakeDeferredHandoff(handoff, source) {
      if (!handoff || handoff.stage !== 'waiting-media-ready') return;
      const activeMedia = media(); const fields = deferredHandoffFields(handoff, activeMedia);
      const identity = ownershipIdentity(activeMedia); const recovery = typeof config.getRecoveryContext === 'function' ? config.getRecoveryContext() || {} : {};
      if (!current()) { cancelDeferredHandoff(handoff, 'SESSION_CHANGED'); return; }
      if (handoff.epoch !== state.loadEpoch) { cancelDeferredHandoff(handoff, 'LOAD_EPOCH_CHANGED'); return; }
      if (!fields.sameVideoNode) { cancelDeferredHandoff(handoff, 'MEDIA_CHANGED'); return; }
      if (identity.outer !== handoff.outer || identity.inner !== handoff.inner || identity.video !== handoff.video || recovery.ownershipValid === false) { cancelDeferredHandoff(handoff, 'OWNERSHIP_LOST'); return; }
      if (recovery.hoverValid === false) { cancelDeferredHandoff(handoff, 'HOVER_OWNERSHIP_LOST'); return; }
      if (!fields.associationMatch) { cancelDeferredHandoff(handoff, 'ASSOCIATION_LOST'); return; }
      if (!state.pageContentConfirmed) { cancelDeferredHandoff(handoff, 'PAGE_CONTENT_CONFIRMATION_LOST'); return; }
      if (fields.adShowing || fields.adInterrupting) { cancelDeferredHandoff(handoff, 'AD_REENTRY'); return; }
      if (fields.readyState < 1) return;
      if (handoff.recoveryTimer) {
        window.clearTimeout(handoff.recoveryTimer);
        handoff.recoveryTimer = 0;
        contentReadyRecoveryLog('cancelled-native-ready', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, source: source, elapsedMs: Math.max(0, Math.round(latencyNow() - (handoff.recoveryStartedAt || latencyNow()))) });
      }
      clearDeferredHandoffWakeup(handoff); handoff.stage = 'start';
      contentHandoffLog(handoff.epoch, 'media-ready-wakeup', Object.assign({ source: source, handoffSerial: handoff.serial }, fields));
      maybeConfirmContent();
    }
    function contentReadyRecoveryEligibilityReason(handoff) {
      if (!current()) return 'NOT_CURRENT';
      if (!handoff || state.contentHandoff !== handoff || handoff.stage !== 'waiting-media-ready') return 'INVALID_HANDOFF';
      if (handoff.epoch !== state.loadEpoch) return 'EPOCH_MISMATCH';
      if (handoff.recoveryInvoked) return 'ALREADY_INVOKED';
      const activeMedia = media();
      if (!activeMedia || activeMedia !== state.media || !isConnected(activeMedia)) return 'MEDIA_DISCONNECTED';
      const playerEl = player();
      if (!playerEl || !isConnected(playerEl)) return 'PLAYER_DISCONNECTED';
      const identity = ownershipIdentity(activeMedia);
      const recovery = typeof config.getRecoveryContext === 'function' ? config.getRecoveryContext() || {} : {};
      if (identity.outer !== handoff.outer || identity.inner !== handoff.inner || identity.video !== handoff.video) return 'OWNERSHIP_IDENTITY_MISMATCH';
      if (recovery.ownershipValid === false || recovery.hoverValid === false) return 'RECOVERY_CONTEXT_INVALID';
      if (!state.lastAssociation || !state.lastAssociation.matches) return 'NO_ASSOCIATION_MATCH';
      if (!state.pageContentConfirmed) return 'PAGE_CONTENT_NOT_CONFIRMED';
      const flags = activeAdFlags();
      if (flags.adShowing || flags.adInterrupting) return 'AD_FLAGS_ACTIVE';
      if (state.currentAdSegment && !state.currentAdSegment.ended && state.currentAdSegment.loadEpoch === state.loadEpoch) return 'ACTIVE_AD_SEGMENT';
      if (Number(activeMedia.readyState) !== 0) return 'READY_STATE_NOT_ZERO';
      if (!state.presentationClosed) return 'PRESENTATION_GATE_NOT_CLOSED';
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) return 'CONTENT_ALREADY_ESTABLISHED';
      if (!/^[A-Za-z0-9_-]{11}$/.test(String(config.videoId || ''))) return 'INVALID_VIDEO_ID';
      if (typeof config.contentReadyRecovery !== 'function' && typeof config.holdBreakProbe !== 'function') return 'NO_RECOVERY_FUNCTION';
      return 'ELIGIBLE';
    }
    function contentReadyRecoveryEligible(handoff) {
      return contentReadyRecoveryEligibilityReason(handoff) === 'ELIGIBLE';
    }
    function armContentReadyRecovery(handoff) {
      if (!handoff) return;
      handoff.recoveryTimer = 0;
      const eligibility = contentReadyRecoveryEligibilityReason(handoff);
      if (eligibility !== 'ELIGIBLE') {
        contentReadyRecoveryLog('invalidated', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, reason: eligibility });
        return;
      }
      handoff.recoveryInvoked = true;
      const recovery = { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, videoId: config.videoId, issuedAt: latencyNow(), resultTimer: 0, transitionSeen: false, outcomeLogged: false };
      state.contentReadyRecovery = recovery;
      contentReadyRecoveryLog('invoked', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, videoId: config.videoId, elapsedMs: Math.max(0, Math.round(latencyNow() - (handoff.recoveryStartedAt || latencyNow()))) });
      const bridgePromise = typeof config.contentReadyRecovery === 'function'
        ? config.contentReadyRecovery()
        : config.holdBreakProbe();
      Promise.resolve(bridgePromise).then(function (result) {
        const loadInvoked = Boolean(result && result.loadInvoked);
        const loadThrew = Boolean(result && result.loadThrew);
        if (!loadInvoked || loadThrew) {
          contentReadyRecoveryLog('invalidated', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, reason: 'COMMAND_REJECTED', loadInvoked: loadInvoked, loadThrew: loadThrew });
          return;
        }
        recovery.resultTimer = window.setTimeout(function () {
          recovery.resultTimer = 0;
          if (!recovery.outcomeLogged && !recovery.transitionSeen && state.contentReadyRecovery === recovery) {
            recovery.outcomeLogged = true;
            contentReadyRecoveryLog('no-effect', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch });
          }
        }, CONTENT_READY_RECOVERY_RESULT_MS);
      }).catch(function () {
        contentReadyRecoveryLog('invalidated', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, reason: 'COMMAND_ERROR' });
      });
    }
    function deferHandoffForMediaReady(handoff, activeMedia) {
      if (!handoff || handoff.stage === 'waiting-media-ready') return;
      const identity = ownershipIdentity(activeMedia);
      handoff.outer = identity.outer; handoff.inner = identity.inner; handoff.video = identity.video;
      handoff.stage = 'waiting-media-ready'; handoff.readinessCleanup = handoff.readinessCleanup || [];
      contentHandoffLog(handoff.epoch, 'waiting-media-ready', Object.assign({ reason: 'MEDIA_NOT_READY', handoffSerial: handoff.serial }, deferredHandoffFields(handoff, activeMedia)));
      if (state.confirmedAdSegments > 0 && Number(activeMedia.readyState) === 0 && !handoff.recoveryArmed && !handoff.recoveryInvoked) {
        handoff.recoveryArmed = true;
        handoff.recoveryStartedAt = latencyNow();
        contentReadyRecoveryLog('armed', { handoffSerial: handoff.serial, loadEpoch: handoff.epoch, readyState: 0, boundMs: CONTENT_MEDIA_READY_RECOVERY_MS });
        handoff.recoveryTimer = window.setTimeout(function () { armContentReadyRecovery(handoff); }, CONTENT_MEDIA_READY_RECOVERY_MS);
        handoff.readinessCleanup.push(function () { if (handoff.recoveryTimer) window.clearTimeout(handoff.recoveryTimer); handoff.recoveryTimer = 0; });
      }
      if (handoff.readinessArmed) return;
      handoff.readinessArmed = true;
      ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate'].forEach(function (type) {
        const listener = function (event) { if (event.target === activeMedia) wakeDeferredHandoff(handoff, type.toUpperCase()); };
        activeMedia.addEventListener(type, listener);
        handoff.readinessCleanup.push(function () { activeMedia.removeEventListener(type, listener); });
      });
    }
    function restoreContent() {
      if (!state.suppressed && !state.presentationClosed && state.contentStarted) return;
      if (!current()) return;
      const activeMedia = attachMedia(); const segment = state.currentAdSegment && state.currentAdSegment.media === activeMedia ? state.currentAdSegment : null;
      const handoffEpoch = state.contentHandoff ? state.contentHandoff.epoch : state.loadEpoch;
      const initialContent = !state.contentStarted;
      const resumedAfterLaterAd = !initialContent && state.laterAdInterruptionEpoch >= 0 && handoffEpoch > state.contentEstablishedEpoch;
      if (activeMedia) {
        if (!state.contentBaseline.latched) {
          state.contentBaseline.playbackRate = segment ? segment.originalPlaybackRate : (state.originalPlaybackRate || Number(activeMedia.playbackRate) || 1);
          state.contentBaseline.muted = segment ? segment.originalMuted : state.originalMuted;
          state.contentBaseline.volume = segment ? segment.originalVolume : state.originalVolume;
          state.contentBaseline.latched = true;
        }
        activeMedia.muted = state.contentBaseline.muted;
        activeMedia.volume = state.contentBaseline.volume;
        setPlaybackRate(activeMedia, state.contentBaseline.playbackRate);
        contentBaselineLog('restored', { playbackRate: state.contentBaseline.playbackRate, muted: state.contentBaseline.muted, volume: state.contentBaseline.volume });
      }
      if (config.overlay) config.overlay.removeAttribute('data-ytpm-ad-suppressed');
      clearReadinessObservation(); clearTerminalObservation(); state.suppressed = false; state.contentStarted = true; state.contentConfirmedAt = presentationNow(); state.currentAdSegment = null;
      state.currentPodConfirmedSegments = 0; state.progressionBudgetLogged = false;
      if (initialContent) { state.contentEstablishedEpoch = handoffEpoch; state.holdBreakStats.initialRequestedContentReached += 1; state.holdBreakStats.requestedContentTransitions += 1; postContentLifecycleLog('content-established', null, 'INITIAL_REQUESTED_CONTENT_REACHED'); }
      else if (resumedAfterLaterAd) { state.contentEstablishedEpoch = handoffEpoch; state.laterAdInterruptionEpoch = -1; state.holdBreakStats.contentResumedAfterLaterAd += 1; state.holdBreakStats.requestedContentTransitions += 1; postContentLifecycleLog('content-resumed', null, 'CONTENT_RESUMED_AFTER_LATER_AD'); }
      else state.holdBreakStats.staleContentClassifications += 1;
      if (state.contentHandoff) { clearDeferredHandoffWakeup(state.contentHandoff); state.contentHandoff.stage = 'restored'; contentHandoffLog(state.contentHandoff.epoch, 'restored', { playbackRateNormal: Boolean(!activeMedia || activeMedia.playbackRate !== AD_ACCELERATION_RATE), shieldRemoved: Boolean(!config.overlay || !config.overlay.hasAttribute('data-ytpm-ad-suppressed')), audioStateRestored: true }); state.contentHandoff = null; }
      openPresentationGate(); log('state=content-restored');
    }
    function maybeConfirmContent() {
      const handoff = state.contentHandoff;
      const rejectSetup = function (reason, fields) {
        if (!handoff || handoff.setupOutcomeLogged) return;
        handoff.setupOutcomeLogged = true; handoff.stage = 'cancelled'; clearDeferredHandoffWakeup(handoff);
        contentHandoffLog(handoff.epoch, 'cancelled', Object.assign({ reason: reason, handoffSerial: handoff.serial }, fields || {}));
      };
      try {
        if (handoff) contentHandoffLog(handoff.epoch, 'stage', { stage: 'pre-confirmation-check', handoffSerial: handoff.serial, pageContentConfirmed: state.pageContentConfirmed, expectedLoadEpoch: handoff.epoch, currentLoadEpoch: state.loadEpoch });
        const activeMedia = attachMedia();
        if (!handoff) {
          if (!state.suppressed || !current() || !state.pageContentConfirmed || !activeMedia || activeMedia.paused || activeMedia.readyState < 1 || state.contentConfirmationTimer) return;
        } else {
          if (handoff.stage === 'waiting-media-ready' || handoff.stage === 'stabilizing' || handoff.stage === 'confirmed' || handoff.stage === 'restored') return;
          if (handoff.stage !== 'start') { return; }
          if (!state.suppressed) { rejectSetup('MEDIA_NOT_SUPPRESSED'); return; }
          if (!current()) { rejectSetup('SESSION_CHANGED'); return; }
          if (!state.pageContentConfirmed) { rejectSetup('PAGE_CONTENT_CONFIRMATION_LOST'); return; }
          if (handoff.epoch !== state.loadEpoch) { rejectSetup('LOAD_EPOCH_CHANGED', { expectedLoadEpoch: handoff.epoch, currentLoadEpoch: state.loadEpoch }); return; }
          if (!activeMedia) { rejectSetup('MEDIA_UNAVAILABLE'); return; }
          if (handoff.media !== activeMedia) { rejectSetup('MEDIA_CHANGED'); return; }
          if (activeMedia.paused) { rejectSetup('MEDIA_STOPPED'); return; }
          if (activeMedia.readyState < 1) { deferHandoffForMediaReady(handoff, activeMedia); return; }
          if (state.contentConfirmationTimer) { return; }
          contentHandoffLog(handoff.epoch, 'stage', { stage: 'post-confirmation-check', handoffSerial: handoff.serial, pageContentConfirmed: state.pageContentConfirmed });
          contentHandoffLog(handoff.epoch, 'stage', { stage: 'pre-timer', handoffSerial: handoff.serial, expectedLoadEpoch: handoff.epoch, currentLoadEpoch: state.loadEpoch, mediaMatches: handoff.media === activeMedia });
        }
        const handoffSerial = handoff && handoff.serial;
        state.contentConfirmationTimer = window.setTimeout(function () {
        state.contentConfirmationTimer = 0;
        if (handoff && (!state.contentHandoff || state.contentHandoff.serial !== handoffSerial)) { contentHandoffLog(handoff.epoch, 'cancelled', { reason: 'HANDOFF_REPLACED', handoffSerial: handoffSerial }); return; }
        const latest = attachMedia();
        let rejectedReason = '';
        if (!current()) rejectedReason = 'session-not-current';
        else if (!state.pageContentConfirmed) rejectedReason = 'page-content-confirmation-cleared';
        else if (!latest) rejectedReason = 'media-missing';
        else if (latest !== activeMedia) rejectedReason = 'media-replaced';
        else if (latest.paused) rejectedReason = 'media-paused';
        else if (latest.readyState < 1) rejectedReason = 'media-not-ready';
        else if (isActiveAdPlayback(getPlayerStatus(player()))) rejectedReason = 'active-ad-playback';
        if (rejectedReason) {
          if (state.contentHandoff && state.contentHandoff.stage === 'stabilizing') { state.contentHandoff.stage = 'cancelled'; contentHandoffLog(state.contentHandoff.epoch, 'cancelled', { reason: rejectedReason }); }
          return;
        }
        if (state.contentHandoff && state.contentHandoff.stage === 'stabilizing') { state.contentHandoff.stage = 'confirmed'; contentHandoffLog(state.contentHandoff.epoch, 'confirmed', { handoffSerial: handoffSerial }); }
        state.latencyContentConfirmedAt = latencyNow();
        const isInitial = !state.contentStarted && !state.adPod.initialFinalized;
        if (isInitial) {
          state.adPod.finalRequestedContentConfirmedAt = latencyNow();
          state.adPod.requestedContentConfirmedAt = state.adPod.finalRequestedContentConfirmedAt;
          if (state.adPod.firstConfirmedAdAt) {
            state.adPod.adPodEndedAt = latencyNow();
          }
          state.adPod.initialFinalized = true;
          notePreviousSegmentClassification(latencyNow());
        }
        adPodLog('requested-content-confirmed', { loadEpoch: state.loadEpoch, elapsedMs: latencyElapsed() });
        latencyLog('content-confirmed', { loadEpoch: state.loadEpoch });
        if (state.currentAdSegment && state.currentAdSegment.terminalObservation) finishTerminalObservation(state.currentAdSegment, 'CONTENT_CONFIRMED');
        progressLog(state.currentAdSegment ? state.currentAdSegment.number : 0, 'content-confirmed', { loadEpoch: state.loadEpoch, confirmedAdSegments: state.confirmedAdSegments });
        endSegment(state.currentAdSegment, 'CONTENT_CONFIRMED', 'content');
        restoreContent();
        }, CONTENT_STABILIZATION_MS);
        if (handoff) { handoff.stage = 'stabilizing'; contentHandoffLog(handoff.epoch, 'stabilizing', { boundMs: CONTENT_STABILIZATION_MS, timerScheduled: true, handoffSerial: handoff.serial }); }
      } catch (error) {
        if (handoff && !handoff.setupOutcomeLogged) { handoff.setupOutcomeLogged = true; handoff.stage = 'cancelled'; clearDeferredHandoffWakeup(handoff); contentHandoffLog(handoff.epoch, 'cancelled', { reason: 'SETUP_ERROR', errorName: error && error.name || 'Error', handoffSerial: handoff.serial }); }
      }
    }
    function invokeSkip(segment) {
      if (!current() || segment.skipAttempted) return false;
      const activePlayer = player(); const control = isConnected(activePlayer) && activePlayer.querySelector(SKIP_SELECTORS.join(','));
      segment.skipAvailable = Boolean(control && isVisible(control));
      if (!segment.skipAvailable) return false;
      latencyLog('skip-control-detected', segmentLatencyFields(segment));
      segment.skipAttempted = true; state.skipInvoked = true; control.click(); log('action=skip-invoked'); progressLog(segment.number, 'skip-invoked', { invoked: true }); latencyLog('skip-invoked', segmentLatencyFields(segment));
      adPodLog('progression-action', { segment: segment.number, loadEpoch: segment.loadEpoch, action: 'skip-invoked', elapsedMs: latencyElapsed() });
      return true;
    }
    function isActiveAdPlayback(status) { return Boolean(status && (status.reason === 'ad-showing' || status.reason === 'ad-interrupting')); }
    function beginAdSegment(activeMedia) {
      if (isPreloadResidueActive(activeMedia)) return null;
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) return null;
      const identity = ownershipIdentity(activeMedia); const previous = state.currentAdSegment;
      const replaced = previous && (previous.outer !== identity.outer || previous.inner !== identity.inner || previous.video !== activeMedia);
      const newEpoch = previous && state.loadEpoch > previous.loadEpoch;
      if (previous && !replaced && !newEpoch) return previous;
      if (previous) endSegment(previous, replaced ? 'VIDEO_REPLACED' : previous.endedByMedia ? 'MEDIA_ENDED' : 'NEW_LOADSTART', 'ad');
      const sample = measurement(activeMedia); state.segmentSequence += 1;
      const segment = { number: state.segmentSequence, media: activeMedia, outer: identity.outer, inner: identity.inner, video: activeMedia, loadEpoch: state.loadEpoch, latencyStartedAt: latencyNow(), terminalWaitMs: 0, skipAvailable: false, skipAttempted: false, seekAttempted: false, seekEffective: false, accelerationApplied: false, selectedAccelerationRate: 0, reapplyCount: 0, originalMuted: state.contentBaseline.latched ? state.contentBaseline.muted : (state.suppressed && activeMedia === state.media ? state.originalMuted : Boolean(activeMedia.muted)), originalVolume: state.contentBaseline.latched ? state.contentBaseline.volume : (state.suppressed && activeMedia === state.media ? state.originalVolume : (Number.isFinite(activeMedia.volume) ? activeMedia.volume : 1)), originalPlaybackRate: state.contentBaseline.latched ? state.contentBaseline.playbackRate : (state.suppressed && activeMedia === state.media ? state.originalPlaybackRate : (Number.isFinite(activeMedia.playbackRate) ? activeMedia.playbackRate : 1)), initialDurationFinite: sample.durationFinite, initialSeekable: sample.seekable, initialReadyState: sample.readyState, progressed: false, ended: false, endedByMedia: false, readinessObserved: false, readinessTimer: 0, accelerationTimer: 0, accelerationObserved: false, confirmed: false, confirmedNumber: 0, terminalObservation: null, seekTarget: NaN };
      state.currentAdSegment = segment;
      progressLog(segment.number, 'detected', { loadEpoch: segment.loadEpoch, sessionConfirmedAdSegments: state.confirmedAdSegments, currentLoadConfirmed: false, outerReplaced: Boolean(previous && previous.outer !== identity.outer), innerReplaced: Boolean(previous && previous.inner !== identity.inner), videoReplaced: Boolean(previous && previous.video !== activeMedia), durationFinite: sample.durationFinite, seekable: sample.seekable, readyState: sample.readyState });
      if (sample.durationFinite && sample.seekable) confirmAdSegment(segment, 'FINITE_MEDIA_READY');
      else progressLog(segment.number, 'classified', { classification: 'BOOTSTRAP_LOAD', loadEpoch: segment.loadEpoch, sessionConfirmedAdSegments: state.confirmedAdSegments, currentLoadConfirmed: false });
      return segment;
    }
    function progressActiveAd(status) {
      if (!current() || !isActiveAdPlayback(status)) return;
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) {
        progressGuardLog('same-canonical-epoch-blocked', { loadEpoch: state.loadEpoch, contentEstablishedEpoch: state.contentEstablishedEpoch });
        return;
      }
      const activeMedia = attachMedia(); if (!activeMedia || !isConnected(activeMedia)) return;
      if (isPreloadResidueActive(activeMedia)) {
        const sample = measurement(activeMedia);
        rapidReentryBarrierLog('stale-media-blocked', {
          sameMediaAsArm: true,
          readyState: sample.readyState,
          durationFinite: sample.durationFinite,
          seekable: sample.seekable
        });
        return;
      }
      const segment = beginAdSegment(activeMedia); if (!segment || segment.progressed) return;
      const sample = measurement(activeMedia);
      if (!segment.confirmed && state.currentPodConfirmedSegments >= MAX_AD_SEGMENTS) { progressionBudgetAvailable(segment); return; }
      if (sample.durationFinite && sample.seekable && !confirmAdSegment(segment, 'FINITE_MEDIA_READY')) { progressionBudgetAvailable(segment); return; }
      if (segment.confirmed && !progressionBudgetAvailable(segment)) return;
      if (invokeSkip(segment)) { segment.progressed = true; return; }
      if (seekNearEnd(segment, 'initial')) return;
      startReadinessObservation(segment);
      try {
        const requested = Math.max(segment.originalPlaybackRate, AD_ACCELERATION_RATE);
        segment.accelerationStartTime = Number(activeMedia.currentTime) || 0;
        segment.requestedPlaybackRate = requested;
        const accelerated = segment.confirmed ? applyAdaptiveAcceleration(segment, 'ACTIVE_AD_MEDIA', 'initial') : (setPlaybackRate(activeMedia, requested), true);
        segment.appliedPlaybackRate = Number(activeMedia.playbackRate);
        segment.accelerationApplied = accelerated;
        segment.progressed = true;
        progressLog(segment.number, 'acceleration-fallback', { invoked: accelerated, requestedPlaybackRate: requested, appliedPlaybackRate: segment.appliedPlaybackRate, currentTimeAtStart: segment.accelerationStartTime });
        if (segment.confirmed) accelerationLog(segment, 'initial', { requestedRate: requested, appliedRate: segment.appliedPlaybackRate, reason: 'ACTIVE_AD_MEDIA', reapplyCount: segment.reapplyCount || 0 });
        adPodLog('progression-action', { segment: segment.number, loadEpoch: segment.loadEpoch, action: 'acceleration-applied', requestedRate: requested, appliedRate: segment.appliedPlaybackRate, elapsedMs: latencyElapsed() });
        segment.accelerationTimer = window.setTimeout(function () { observeAcceleration(segment); }, ACCELERATION_OBSERVATION_MS);
      }
      catch (error) { progressLog(segment.number, 'acceleration-fallback', { invoked: false }); }
    }
    function scheduleAdProgress(status) {
      if (!current() || state.progressTimer || !isActiveAdPlayback(status)) return;
      const activeMedia = media();
      if (isPreloadResidueActive(activeMedia)) {
        const sample = measurement(activeMedia);
        rapidReentryBarrierLog('stale-media-blocked', {
          sameMediaAsArm: true,
          readyState: sample.readyState,
          durationFinite: sample.durationFinite,
          seekable: sample.seekable
        });
        return;
      }
      if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) return;
      state.progressTimer = window.setTimeout(function () { state.progressTimer = 0; progressActiveAd(getPlayerStatus(player())); }, 0);
    }
    function inspect(reason) {
      if (!current()) return;
      const status = getPlayerStatus(player());
      inspectAdUi();
      if (status.active) {
        if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) {
          if (!isActiveAdPlayback(status)) {
            state.lastLoggedAdState = 'none';
            return;
          }
          if (!state.presentationClosed) closePresentationGate('post-content-active-ad-quarantine');
          if (!state.suppressed) suppress('post-content-active-ad-quarantine');
          state.visualQuarantine = true;
          if (!state.quarantineTimer) {
            state.quarantineTimer = window.setTimeout(function () {
              state.quarantineTimer = 0;
              maybeRecoverFromQuarantine();
            }, 500);
          }
          if (state.lastLoggedAdState !== status.reason) { log('adState=quarantine', { reason: status.reason, source: reason }); state.lastLoggedAdState = status.reason; }
          progressGuardLog('same-canonical-epoch-blocked', { loadEpoch: state.loadEpoch, contentEstablishedEpoch: state.contentEstablishedEpoch, reason: status.reason });
          return;
        }
        if (!state.presentationClosed && (!state.contentStarted || state.loadEpoch > state.contentEstablishedEpoch)) {
          closePresentationGate('ad-detected');
        }
        if (isActiveAdPlayback(status)) {
          invalidateProvisionalPodEnd();
          notePreviousSegmentClassification(latencyNow());
          cancelDeferredHandoff(state.contentHandoff, 'AD_REENTRY');
        }
        if (state.lastLoggedAdState !== status.reason) { log('adState=detected', { reason: status.reason, source: reason }); state.lastLoggedAdState = status.reason; }
        suppress(status.reason);
        scheduleAdProgress(status);
        return;
      }
      state.lastLoggedAdState = 'none';
      if (state.visualQuarantine) maybeRecoverFromQuarantine();
      maybeConfirmContent();
    }
    function inspectPageStatus() {
      if (!current() || typeof config.status !== 'function') return;
      const requestEpoch = state.loadEpoch;
      const requestMedia = state.media;
      Promise.resolve(config.status()).then(function (result) {
        if (!current()) return;
        const status = normalizeStatus(result);
        if (!status) return;
        state.lastBridgeStatus = status;
        const association = { source: status.associationSource, available: status.associationAvailable, matchesRequested: status.requestedVideoIdMatches };
        state.lastAssociation = { associationSource: association.source, associationAvailable: association.available, matches: association.matchesRequested };
        const pending = state.postLoadPending;
        if (pending && pending.epoch === requestEpoch && pending.media === requestMedia && state.loadEpoch === requestEpoch && state.media === requestMedia) {
          const changed = pending.association.matchesRequested !== association.matchesRequested || pending.association.available !== association.available;
          pending.association = association;
          if (changed) contentIdentityLog(pending.epoch, 'association-applied', { classification: association.matchesRequested ? 'ASSOCIATION_MATCH' : association.available ? 'ASSOCIATION_DIFFERENT_VIDEO' : 'ASSOCIATION_EMPTY', epochStateUpdated: true, classifierReevaluated: true });
          resolvePostLoad(pending.epoch, pending);
        } else if (pending && requestEpoch !== state.loadEpoch) {
          contentIdentityLog(requestEpoch, 'association-discarded', { reason: 'stale-load-epoch' });
        }
        if (status.active) {
          if (state.contentStarted && state.loadEpoch <= state.contentEstablishedEpoch) {
            if (isActiveAdPlayback(status)) {
              if (!state.presentationClosed) closePresentationGate('post-content-active-ad-quarantine');
              if (!state.suppressed) suppress('post-content-active-ad-quarantine');
              state.visualQuarantine = true;
              if (!state.quarantineTimer) {
                state.quarantineTimer = window.setTimeout(function () {
                  state.quarantineTimer = 0;
                  maybeRecoverFromQuarantine();
                }, 500);
              }
              progressGuardLog('same-canonical-epoch-blocked', { loadEpoch: state.loadEpoch, contentEstablishedEpoch: state.contentEstablishedEpoch, reason: status.reason });
            }
          } else {
            if (!state.presentationClosed && (!state.contentStarted || state.loadEpoch > state.contentEstablishedEpoch)) {
              closePresentationGate('ad-detected');
            }
            if (isActiveAdPlayback(status)) {
              state.pageContentConfirmed = false;
              invalidateProvisionalPodEnd();
              notePreviousSegmentClassification(latencyNow());
              cancelDeferredHandoff(state.contentHandoff, 'AD_REENTRY');
            }
            suppress(status.reason);
            scheduleAdProgress(status);
          }
        } else if (status.requestedVideoIdMatches) {
          state.pageContentConfirmed = true;
          if (state.visualQuarantine) maybeRecoverFromQuarantine();
          if (state.postLoadPending) resolvePostLoad(state.postLoadPending.epoch, state.postLoadPending);
          maybeConfirmContent();
        }
      }).catch(function () {});
    }
    function schedulePostLoadClassification(epoch) {
      if (!current()) return;
      clearPostLoadPending();
      if (state.postLoadTimer) window.clearTimeout(state.postLoadTimer);
      postLoadLog('classifying', { loadEpoch: epoch });
      state.postLoadTimer = window.setTimeout(function () {
        state.postLoadTimer = 0;
        if (!current() || state.loadEpoch !== epoch) return;
        if (!resolvePostLoad(epoch, false)) startPostLoadPending(epoch);
      }, POST_LOAD_CLASSIFICATION_MS);
    }
    function clearPostLoadPending() {
      if (state.postLoadPending && state.postLoadPending.timer) window.clearTimeout(state.postLoadPending.timer);
      state.postLoadPending = null;
    }
    function postLoadEvidence() {
      const activeMedia = attachMedia(); const status = getPlayerStatus(player()); const flags = activeAdFlags();
      const association = state.postLoadPending && state.postLoadPending.association;
      return { status: status, adCreated: flags.adCreated, adShowing: flags.adShowing, adInterrupting: flags.adInterrupting, videoPresent: Boolean(activeMedia), metadataAvailable: Boolean(activeMedia && activeMedia.readyState >= 1), durationFinite: Boolean(activeMedia && Number.isFinite(Number(activeMedia.duration)) && Number(activeMedia.duration) > 0), playing: Boolean(activeMedia && !activeMedia.paused), requestedVideoAssociationValid: Boolean(association && association.matchesRequested), contentSignalSeen: state.contentStarted };
    }
    function resolvePostLoad(epoch, pending) {
      if (!current() || state.loadEpoch !== epoch) return true;
      if (pending && pending.latencyStartedAt && !pending.latencyRecorded) { pending.latencyRecorded = true; state.latencyPostLoadWaitMs += Math.max(0, Math.round(latencyNow() - pending.latencyStartedAt)); }
      const evidence = postLoadEvidence();
      const activeConfirmed = isActiveAdPlayback(evidence.status) && evidence.metadataAvailable && (evidence.durationFinite || evidence.playing);
      if (activeConfirmed) {
        postLoadLog(pending ? 'resolved' : 'classified', { classification: 'ACTIVE_AD_MEDIA', loadEpoch: epoch, elapsedMs: pending ? Math.round(Date.now() - pending.startedAt) : 0 });
        if (state.holdBreakProbe && state.holdBreakProbe.commandIssued && !state.holdBreakProbe.outcomeLogged && state.holdBreakProbe.loadEpoch + 1 === epoch) finishHoldBreakProbe(state.holdBreakProbe, 'COMMAND_TRIGGERED_AD_REENTRY', { newLoadEpoch: epoch });
        if (state.contentReadyRecovery && !state.contentReadyRecovery.outcomeLogged && state.contentReadyRecovery.loadEpoch + 1 === epoch) {
          state.contentReadyRecovery.outcomeLogged = true;
          contentReadyRecoveryLog('ad-reentry', { handoffSerial: state.contentReadyRecovery.handoffSerial, loadEpoch: epoch });
        }
        latencyLog('postload-classified', { loadEpoch: epoch, classification: 'ACTIVE_AD_MEDIA' });
        clearPostLoadPending();
        scheduleAdProgress(evidence.status);
        return true;
      }
      if (evidence.requestedVideoAssociationValid && !isActiveAdPlayback(evidence.status) && evidence.playing) {
        postLoadLog(pending ? 'resolved' : 'classified', { classification: 'REQUESTED_CONTENT', loadEpoch: epoch, elapsedMs: pending ? Math.round(Date.now() - pending.startedAt) : 0 });
        if (state.holdBreakProbe && state.holdBreakProbe.commandIssued && !state.holdBreakProbe.outcomeLogged && state.holdBreakProbe.loadEpoch + 1 === epoch) finishHoldBreakProbe(state.holdBreakProbe, 'COMMAND_TRIGGERED_REQUESTED_CONTENT', { newLoadEpoch: epoch });
        if (state.contentReadyRecovery && !state.contentReadyRecovery.outcomeLogged && state.contentReadyRecovery.loadEpoch + 1 === epoch) {
          state.contentReadyRecovery.outcomeLogged = true;
          contentReadyRecoveryLog('content-ready', { handoffSerial: state.contentReadyRecovery.handoffSerial, loadEpoch: epoch });
        }
        state.latencyRequestedContentAt = latencyNow();
        if (!state.contentStarted && !state.adPod.initialFinalized) {
          state.adPod.finalRequestedContentAssociatedAt = latencyNow();
          state.adPod.requestedContentAssociatedAt = state.adPod.finalRequestedContentAssociatedAt;
          state.adPod.provisionalAdPodEndedAt = latencyNow();
          notePreviousSegmentClassification(latencyNow());
        }
        adPodLog('requested-content-associated', { loadEpoch: epoch, elapsedMs: latencyElapsed() });
        latencyLog('postload-classified', { loadEpoch: epoch, classification: 'REQUESTED_CONTENT' });
        state.requestedContentClassified = true;
        state.pageContentConfirmed = true;
        if (state.contentConfirmationTimer) { window.clearTimeout(state.contentConfirmationTimer); state.contentConfirmationTimer = 0; }
        state.handoffSequence += 1;
        state.contentHandoff = { epoch: epoch, media: state.media, stage: 'start', serial: state.handoffSequence, setupOutcomeLogged: false, readinessCleanup: [], readinessArmed: false };
        contentHandoffLog(epoch, 'start', { sessionCurrent: current(), generationCurrent: true, ownershipValid: Boolean(state.media && isConnected(state.media) && isConnected(player())), previewConnected: Boolean(config.overlay && config.overlay.isConnected), videoPresent: Boolean(state.media), mediaPlaying: evidence.playing, associationMatch: true, pageContentConfirmed: state.pageContentConfirmed, adShowing: evidence.adShowing, adInterrupting: evidence.adInterrupting, handoffSerial: state.handoffSequence });
        clearPostLoadPending();
        maybeConfirmContent();
        return true;
      }
      return false;
    }
    function startPostLoadPending(epoch) {
      const evidence = postLoadEvidence();
      const previous = state.lastAssociation || {};
      const pending = { epoch: epoch, media: state.media, startedAt: Date.now(), latencyStartedAt: latencyNow(), timer: 0, association: { source: previous.associationSource || 'unavailable', available: previous.associationAvailable === true, matchesRequested: previous.matches === true } };
      state.postLoadPending = pending;
      postLoadLog('pending', { loadEpoch: epoch, initialWindowMs: POST_LOAD_CLASSIFICATION_MS, adCreated: evidence.adCreated, adShowing: evidence.adShowing, adInterrupting: evidence.adInterrupting, videoPresent: evidence.videoPresent, metadataAvailable: evidence.metadataAvailable, durationFinite: evidence.durationFinite, playing: evidence.playing, requestedVideoAssociationValid: evidence.requestedVideoAssociationValid, contentSignalSeen: evidence.contentSignalSeen });
      const association = pending.association;
      contentIdentityLog(epoch, 'association-check', { associationSource: association.source, associationAvailable: association.available, associationMatchesRequested: association.matchesRequested, playerReportedVideoIdPresent: association.available, playerReportedVideoIdMatches: association.matchesRequested, sessionVideoIdPresent: Boolean(config.videoId), classification: association.matchesRequested ? 'ASSOCIATION_MATCH' : association.available ? 'ASSOCIATION_DIFFERENT_VIDEO' : 'ASSOCIATION_EMPTY', contentSignalAvailable: false, contentSignalSeen: state.contentStarted, contentSignalSource: 'guard-restoration' });
      if (resolvePostLoad(epoch, pending)) return;
      pending.timer = window.setTimeout(function () { if (state.postLoadPending === pending) { postLoadLog('classification-timeout', { loadEpoch: epoch, boundMs: POST_LOAD_PENDING_RESOLUTION_MS }); clearPostLoadPending(); } }, POST_LOAD_PENDING_RESOLUTION_MS);
    }
    function onMediaEvent(event) {
      if (!current() || event.target !== state.media) return;
      if (event.type === 'loadstart') {
        releasePreloadResidue('NEW_LOADSTART');
        const loadEpochBefore = state.loadEpoch;
        if (state.quarantineTimer) { window.clearTimeout(state.quarantineTimer); state.quarantineTimer = 0; }
        state.visualQuarantine = false;
        state.loadEpoch = Math.min(MAX_MEDIA_LOAD_EPOCH, state.loadEpoch + 1);
        if (state.contentStarted && !state.presentationClosed) {
          closePresentationGate('post-content-transition');
          suppress('post-content-transition');
        }
        state.pageContentConfirmed = false;
        const sameVideoNode = event.target === state.media;
        const sameOwnedPlayer = Boolean(isConnected(player()) && ownershipIdentity(event.target).inner === player());
        const previousAdSegment = state.currentAdSegment || (state.holdBreakProbe && state.holdBreakProbe.segment);
        if (state.contentHandoff && state.contentHandoff.epoch === loadEpochBefore) cancelDeferredHandoff(state.contentHandoff, 'LOAD_EPOCH_CHANGED');
        if (state.currentAdSegment && state.currentAdSegment.seekObservation) {
          state.currentAdSegment.seekObservation.sawLoadstart = true;
          finishSeekObservation(state.currentAdSegment, 'SEEK_SUPERSEDED_BY_NEW_LOAD');
        }
        if (state.currentAdSegment && !state.currentAdSegment.ended) endSegment(state.currentAdSegment, 'NEW_LOADSTART', 'pending');
        noteHoldBreakLoadstart(loadEpochBefore);
        if (state.contentReadyRecovery && state.contentReadyRecovery.loadEpoch === loadEpochBefore) {
          state.contentReadyRecovery.transitionSeen = true;
          const elapsed = Math.max(0, Math.round(latencyNow() - state.contentReadyRecovery.issuedAt));
          contentReadyRecoveryLog('new-loadstart', { handoffSerial: state.contentReadyRecovery.handoffSerial, loadEpoch: state.loadEpoch, elapsedMs: elapsed });
        }
        latencyLog('new-loadstart', { loadEpoch: state.loadEpoch });
        if (previousAdSegment) {
          const segData = ensureSegmentTiming(previousAdSegment);
          if (segData && !segData.nextLoadstartAt) segData.nextLoadstartAt = latencyNow();
        }
        adPodLog('new-loadstart', { loadEpoch: state.loadEpoch, elapsedMs: latencyElapsed() });
        schedulePostLoadClassification(state.loadEpoch);
      }
      if (event.type === 'emptied') {
        releasePreloadResidue('MEDIA_RESET');
      }
      if (event.type === 'ratechange' && state.mediaState) {
        const from = state.mediaState.playbackRate;
        const to = Number(state.media.playbackRate) || 1;
        const guardInitiated = state.mediaState.guardRateExpected === to;
        mediaStateLog(state.currentAdSegment && state.currentAdSegment.number, 'ratechange', { from: from, to: to, guardInitiated: guardInitiated });
        state.mediaState.playbackRate = to;
        if (guardInitiated) state.mediaState.guardRateExpected = null;
        if (!guardInitiated && state.contentStarted && (!state.currentAdSegment || state.loadEpoch <= state.contentEstablishedEpoch)) {
          state.contentBaseline.playbackRate = to;
          state.contentBaseline.latched = true;
          contentBaselineLog('user-rate-updated', { playbackRate: to });
        }
        const segment = state.currentAdSegment;
        if (!guardInitiated && segment && segment.confirmed && segment.selectedAccelerationRate && to !== segment.selectedAccelerationRate && exactSegmentCurrent(segment) && isActiveAdPlayback(getPlayerStatus(player()))) {
          accelerationLog(segment, 'rate-reset-detected', { requestedRate: segment.selectedAccelerationRate, appliedRate: to, reason: 'EXTERNAL_RATE_RESET', reapplyCount: segment.reapplyCount || 0 });
          if ((segment.reapplyCount || 0) < MAX_AD_RATE_REAPPLIES) { segment.reapplyCount = (segment.reapplyCount || 0) + 1; applyAdaptiveAcceleration(segment, 'EXTERNAL_RATE_RESET', 'reapplied'); }
        }
      }
      if (event.type === 'volumechange' && state.media) {
        if (!state.suppressed && state.contentStarted && (!state.currentAdSegment || state.loadEpoch <= state.contentEstablishedEpoch)) {
          state.contentBaseline.muted = Boolean(state.media.muted);
          state.contentBaseline.volume = Number.isFinite(state.media.volume) ? state.media.volume : 1;
          state.contentBaseline.latched = true;
          contentBaselineLog('user-audio-updated', { muted: state.contentBaseline.muted, volume: state.contentBaseline.volume });
        }
      }
      if (event.type === 'pause' || event.type === 'play') mediaStateLog(state.currentAdSegment && state.currentAdSegment.number, event.type, { guardInitiated: false });
      if ((event.type === 'play' || event.type === 'playing') && !state.firstMediaPlayAt) { state.firstMediaPlayAt = presentationNow(); presentationLog('media-play-observed', { gateClosed: state.presentationClosed }); latencyLog('first-media-play', { gateClosed: state.presentationClosed }); }
      if (event.type === 'ended' && state.currentAdSegment && event.target === state.currentAdSegment.media) {
        mediaStateLog(state.currentAdSegment.number, 'ended', { currentTime: Number(state.media.currentTime) || 0, duration: Number(state.media.duration) || 0 });
        latchTerminalEndpointEvidence(state.currentAdSegment, 'media-ended');
        state.currentAdSegment.endedByMedia = true;
        endSegment(state.currentAdSegment, 'MEDIA_ENDED', 'ended');
      }
      if (state.currentAdSegment && exactSegmentCurrent(state.currentAdSegment) && (event.type === 'durationchange' || event.type === 'loadedmetadata' || event.type === 'timeupdate')) {
        const sample = measurement(state.media);
        if (sample.durationFinite && sample.seekable && state.currentAdSegment.requestedPlaybackRate && !state.currentAdSegment.seekAttempted) {
          progressLog(state.currentAdSegment.number, 'late-metadata', { durationFinite: sample.durationFinite, seekable: sample.seekable, currentTime: Number(state.media.currentTime) || 0 });
          if (confirmAdSegment(state.currentAdSegment, 'LATE_MEDIA_READY') && progressionBudgetAvailable(state.currentAdSegment)) seekNearEnd(state.currentAdSegment, 'late-metadata');
        }
        if (sample.durationFinite && sample.seekable && Number(state.media.currentTime) >= (state.currentAdSegment.seekTarget || (sample.end - 1)) - SEEK_NEAR_END_TOLERANCE_SECONDS) {
          latchTerminalEndpointEvidence(state.currentAdSegment, event.type);
        }
      }
      inspect('media'); inspectPageStatus();
    }
    function arm() {
      if (state.armed) return true;
      if (!sessionCurrent()) { console.debug('[YTPM][AdGuard]', 'phase=arm-rejected', 'generation=' + String(config.generation), 'reason=session-not-current'); return false; }
      if (!player()) { console.debug('[YTPM][AdGuard]', 'phase=arm-rejected', 'generation=' + String(config.generation), 'reason=player-unavailable'); return false; }
      state.armed = true;
      state.latencyStartedAt = latencyNow();
      state.adPod.loadRequestedAt = latencyNow();
      latencyLog('armed');
      config.overlay.setAttribute('data-ytpm-preview-owned', 'true');
      closePresentationGate();
      if (config.surface === 'history-native-fallback') {
        const initialMedia = media();
        if (initialMedia && isConnected(initialMedia)) {
          const sample = measurement(initialMedia);
          state.preloadResidue = {
            active: true,
            media: initialMedia,
            loadEpochAtArm: state.loadEpoch
          };
          rapidReentryBarrierLog('armed', {
            sameMediaAsArm: true,
            readyState: sample.readyState,
            durationFinite: sample.durationFinite,
            seekable: sample.seekable
          });
        }
      }
      state.observer = new MutationObserver(function () { attachMedia(); inspect('mutation'); inspectPageStatus(); });
      state.observer.observe(player(), { attributes: true, attributeFilter: ['class', 'ad-showing', 'ad-interrupting', 'ad-created'], childList: true, subtree: true });
      attachMedia();
      console.debug('[YTPM][AdGuard]', 'phase=armed', 'generation=' + String(config.generation), 'surface=' + String(config.surface || 'overlay'), 'videoId=' + String(config.videoId));
      inspect('armed');
      inspectPageStatus();
      return true;
    }
    function disarm(reason) {
      if (!state.armed) return;
      state.preloadResidue = null;
      if (state.quarantineTimer) { window.clearTimeout(state.quarantineTimer); state.quarantineTimer = 0; }
      state.visualQuarantine = false;
      if (state.currentAdSegment && state.currentAdSegment.seekObservation) finishSeekObservation(state.currentAdSegment, 'SEEK_SESSION_INVALIDATED');
      if (state.currentAdSegment && state.currentAdSegment.terminalObservation) finishTerminalObservation(state.currentAdSegment, 'SESSION_INVALIDATED');
      if (state.holdBreakProbe && !state.holdBreakProbe.outcomeLogged) finishHoldBreakProbe(state.holdBreakProbe, 'SESSION_INVALIDATED');
      if (state.contentReadyRecovery && state.contentReadyRecovery.resultTimer) {
        window.clearTimeout(state.contentReadyRecovery.resultTimer);
        state.contentReadyRecovery.resultTimer = 0;
      }
      state.contentReadyRecovery = null;
      if (!state.holdBreakStats.summaryLogged) { const stats = state.holdBreakStats; stats.summaryLogged = true; let result = 'SESSION_INVALIDATED'; if (stats.contentResumedAfterLaterAd > 0) result = 'CONTENT_RESUMED_AFTER_LATER_AD'; else if (stats.initialRequestedContentReached > 0) result = 'INITIAL_REQUESTED_CONTENT_REACHED'; else if (state.confirmedAdSegments >= MAX_AD_SEGMENTS && stats.holdsObserved >= MAX_AD_SEGMENTS) result = 'SEGMENT_BUDGET_EXHAUSTED'; else if (stats.commandsInvoked > 0 && stats.commandNoEffects === stats.commandsInvoked) result = 'NO_EFFECT'; else if (stats.commandsInvoked > 0 && stats.fastLoadstartsTriggered === stats.commandsInvoked) result = 'ALL_HOLDS_COLLAPSED'; else if (stats.fastLoadstartsTriggered > 0) result = 'PARTIAL_HOLD_COLLAPSE'; console.debug('[YTPM][AdHoldBreakSummary]', 'generation=' + String(config.generation), 'confirmedAdSegments=' + String(state.confirmedAdSegments), 'holdsObserved=' + String(stats.holdsObserved), 'commandsInvoked=' + String(stats.commandsInvoked), 'fastLoadstartsTriggered=' + String(stats.fastLoadstartsTriggered), 'adReentries=' + String(stats.adReentries), 'requestedContentTransitions=' + String(stats.requestedContentTransitions), 'initialRequestedContentReached=' + String(stats.initialRequestedContentReached), 'laterAdInterruptions=' + String(stats.laterAdInterruptions), 'contentResumedAfterLaterAd=' + String(stats.contentResumedAfterLaterAd), 'staleContentClassifications=' + String(stats.staleContentClassifications), 'nativeTransitionsBeforeProbe=' + String(stats.nativeTransitionsBeforeProbe), 'commandNoEffects=' + String(stats.commandNoEffects), 'totalObservedHoldMs=' + String(Math.round(stats.totalObservedHoldMs)), 'totalCommandToLoadstartMs=' + String(Math.round(stats.totalCommandToLoadstartMs)), 'maxCommandToLoadstartMs=' + String(Math.round(stats.maxCommandToLoadstartMs)), 'result=' + result); }
      clearDeferredHandoffWakeup(state.contentHandoff);
      state.armed = false; if (state.progressTimer) window.clearTimeout(state.progressTimer); if (state.contentConfirmationTimer) window.clearTimeout(state.contentConfirmationTimer); if (state.postLoadTimer) window.clearTimeout(state.postLoadTimer); clearReadinessObservation(); clearTerminalObservation(); if (state.currentAdSegment && state.currentAdSegment.accelerationTimer) window.clearTimeout(state.currentAdSegment.accelerationTimer); if (state.observer) state.observer.disconnect(); state.mediaCleanup.splice(0).forEach(function (cleanup) { cleanup(); });
      if (state.suppressed && state.media) { const segment = state.currentAdSegment && state.currentAdSegment.media === state.media ? state.currentAdSegment : null; state.media.muted = segment ? segment.originalMuted : state.originalMuted; state.media.volume = segment ? segment.originalVolume : state.originalVolume; setPlaybackRate(state.media, segment ? segment.originalPlaybackRate : state.originalPlaybackRate); }
      if (config.overlay && ownsPresentationGate()) {
        if (state.presentationClosedAt) presentationLog('cleanup', { reason: reason || 'session-ended' });
        if (state.presentationClosedAt) adUiLog('cleanup', { reason: reason || 'session-ended' });
        config.overlay.removeAttribute('data-ytpm-ad-suppressed');
        config.overlay.removeAttribute('data-ytpm-presentation-closed');
        config.overlay.removeAttribute('data-ytpm-preview-owned');
        config.overlay.removeAttribute('data-ytpm-presentation-session');
      }
      const initialClosedAt = state.initialPresentationClosedAt || state.presentationClosedAt;
      const closedBeforeFirstMediaPlay = Boolean(initialClosedAt) && (!state.firstMediaPlayAt || initialClosedAt <= state.firstMediaPlayAt);
      const gateEverOpened = Boolean(state.presentationOpenedAt);
      const openedOnlyAfterContent = gateEverOpened && !state.visibleAdViolation;
      let presentationResult = 'USER_EXIT_BEFORE_CONTENT';
      if (state.requestedContentClassified && !state.contentStarted) presentationResult = 'INCOMPLETE_CONTENT_NOT_CONFIRMED';
      else if (state.contentStarted && !gateEverOpened) presentationResult = 'INCOMPLETE_GATE_NEVER_OPENED';
      else if (state.visibleAdViolation) presentationResult = 'FAIL';
      else if (state.contentStarted && gateEverOpened && Boolean(initialClosedAt) && closedBeforeFirstMediaPlay && openedOnlyAfterContent) presentationResult = 'PASS';
      else if (state.requestedContentClassified) presentationResult = 'INCOMPLETE_PRESENTATION_VALIDATION_FAILED';
      if (!state.presentationSummaryLogged) {
        state.presentationSummaryLogged = true;
        console.debug('[YTPM][PresentationGateSummary]', 'generation=' + String(config.generation), 'closedBeforeLoad=' + String(Boolean(initialClosedAt)), 'closedBeforeFirstMediaPlay=' + String(closedBeforeFirstMediaPlay), 'adDetected=' + String(state.adDetected), 'contentConfirmed=' + String(state.contentStarted), 'gateEverOpened=' + String(gateEverOpened), 'openedOnlyAfterContent=' + String(openedOnlyAfterContent), 'closeCycles=' + String(state.presentationCloseCycles), 'openCycles=' + String(state.presentationOpenCycles), 'postContentReclosures=' + String(state.postContentReclosures), 'visibleAdViolation=' + String(state.visibleAdViolation), 'result=' + presentationResult);
      }
      const adUiResult = state.adDetected && (!state.contentStarted || !gateEverOpened) ? 'INCOMPLETE' : state.skipUiVisibleWhileClosed || state.otherAdUiVisibleWhileClosed || state.visibleAdViolation ? 'FAIL' : 'PASS';
      if (!state.adUiSummaryLogged) {
        state.adUiSummaryLogged = true;
        console.debug('[YTPM][AdUiGateSummary]', 'generation=' + String(config.generation), 'skipUiDetected=' + String(state.skipUiDetected), 'skipUiVisibleWhileClosed=' + String(state.skipUiVisibleWhileClosed), 'otherAdUiDetected=' + String(state.otherAdUiDetected), 'otherAdUiVisibleWhileClosed=' + String(state.otherAdUiVisibleWhileClosed), 'contentConfirmed=' + String(state.contentStarted), 'gateReleasedAfterContent=' + String(gateEverOpened && openedOnlyAfterContent), 'closeCycles=' + String(state.presentationCloseCycles), 'openCycles=' + String(state.presentationOpenCycles), 'result=' + adUiResult);
      }
      const latencySummaryKey = String(config.sessionId || 'generation-' + String(config.generation));
      if (!state.latencySummaryLogged && !finalizedLatencySummaries.has(latencySummaryKey)) {
        state.latencySummaryLogged = true;
        finalizedLatencySummaries.add(latencySummaryKey);
        const totalElapsedMs = latencyElapsed();
        const timeToRequestedContentMs = state.latencyRequestedContentAt ? Math.max(0, Math.round(state.latencyRequestedContentAt - state.latencyStartedAt)) : 0;
        const timeToContentConfirmedMs = state.latencyContentConfirmedAt ? Math.max(0, Math.round(state.latencyContentConfirmedAt - state.latencyStartedAt)) : 0;
        const timeToGateOpenedMs = state.latencyGateOpenedAt ? Math.max(0, Math.round(state.latencyGateOpenedAt - state.latencyStartedAt)) : 0;
        const totalAdProgressionMs = state.latencyFirstAdAt && state.latencyRequestedContentAt ? Math.max(0, Math.round(state.latencyRequestedContentAt - state.latencyFirstAdAt)) : 0;
        const handoffDelayMs = state.latencyRequestedContentAt && state.latencyContentConfirmedAt ? Math.max(0, Math.round(state.latencyContentConfirmedAt - state.latencyRequestedContentAt)) : 0;
        const stages = [['terminal', state.latencyTerminalWaitMs], ['postload', state.latencyPostLoadWaitMs], ['content-handoff', handoffDelayMs], ['ad-progression', totalAdProgressionMs]];
        const slowest = stages.reduce(function (best, entry) { return entry[1] > best[1] ? entry : best; }, ['none', 0]);
        let result = 'FAST_PATH';
        if (state.latencyTerminalWaitMs >= TERMINAL_TRANSITION_SOFT_DELAY_MS) result = 'TERMINAL_TRANSITION_DELAY';
        else if (state.latencyPostLoadWaitMs >= POST_LOAD_PENDING_RESOLUTION_MS) result = 'POSTLOAD_DELAY';
        else if (handoffDelayMs >= CONTENT_STABILIZATION_MS * 4) result = 'CONTENT_HANDOFF_DELAY';
        else if (state.confirmedAdSegments > 1) result = 'REPEATED_AD_SEGMENTS';
        else if (state.adDetected && !state.skipInvoked && totalAdProgressionMs >= 1000) result = 'SKIP_NOT_AVAILABLE';
        console.debug('[YTPM][AdLatencySummary]', 'generation=' + String(config.generation), 'totalElapsedMs=' + String(totalElapsedMs), 'timeToFirstAdMs=' + String(state.latencyFirstAdAt ? Math.max(0, Math.round(state.latencyFirstAdAt - state.latencyStartedAt)) : 0), 'confirmedAdSegments=' + String(state.confirmedAdSegments), 'totalAdProgressionMs=' + String(totalAdProgressionMs), 'totalTerminalWaitMs=' + String(Math.round(state.latencyTerminalWaitMs)), 'totalPostLoadWaitMs=' + String(Math.round(state.latencyPostLoadWaitMs)), 'timeToRequestedContentMs=' + String(timeToRequestedContentMs), 'timeToContentConfirmedMs=' + String(timeToContentConfirmedMs), 'timeToGateOpenedMs=' + String(timeToGateOpenedMs), 'slowestStage=' + String(slowest[0]), 'slowestStageMs=' + String(Math.round(slowest[1])), 'result=' + result);
      }
      if (!state.adPodSummaryLogged) {
        state.adPodSummaryLogged = true;
        const initialAds = state.adPod.initialConfirmedAdSegments > 0;
        const loadRequestToFirstConfirmedAdMs = initialAds && state.adPod.firstConfirmedAdAt && state.adPod.loadRequestedAt
          ? Math.max(0, Math.round(state.adPod.firstConfirmedAdAt - state.adPod.loadRequestedAt))
          : 0;
        const timeFromLoadRequestToFirstAdMs = loadRequestToFirstConfirmedAdMs;
        const adPodEnd = state.adPod.adPodEndedAt || (initialAds ? state.adPod.finalRequestedContentConfirmedAt || state.adPod.finalRequestedContentAssociatedAt || state.adPod.provisionalAdPodEndedAt : 0);
        const totalAdPodWallMs = initialAds && state.adPod.firstConfirmedAdAt && adPodEnd >= state.adPod.firstConfirmedAdAt
          ? Math.max(0, Math.round(adPodEnd - state.adPod.firstConfirmedAdAt))
          : 0;
        const loadRequestToGateOpenMs = state.adPod.presentationGateOpenedAt && state.adPod.loadRequestedAt
          ? Math.max(0, Math.round(state.adPod.presentationGateOpenedAt - state.adPod.loadRequestedAt))
          : 0;
        const finalContentAssociationToGateOpenMs = state.adPod.finalRequestedContentAssociatedAt && state.adPod.presentationGateOpenedAt
          ? Math.max(0, Math.round(state.adPod.presentationGateOpenedAt - state.adPod.finalRequestedContentAssociatedAt))
          : 0;
        const requestedContentClassificationToGateOpenMs = finalContentAssociationToGateOpenMs;

        let maxSegmentConfirmedToEndpointMs = 0;
        let maxEndpointToMediaResetMs = 0;
        let maxMediaResetToNextLoadstartMs = 0;
        let maxNextLoadstartToClassificationMs = 0;

        const summaryParts = [
          'generation=' + String(config.generation),
          'confirmedAdSegments=' + String(state.confirmedAdSegments),
          'initialConfirmedAdSegments=' + String(state.adPod.initialConfirmedAdSegments),
          'timeFromLoadRequestToFirstAdMs=' + String(timeFromLoadRequestToFirstAdMs),
          'loadRequestToFirstConfirmedAdMs=' + String(loadRequestToFirstConfirmedAdMs),
          'totalAdPodWallMs=' + String(totalAdPodWallMs),
          'loadRequestToGateOpenMs=' + String(loadRequestToGateOpenMs),
          'requestedContentClassificationToGateOpenMs=' + String(requestedContentClassificationToGateOpenMs),
          'finalContentAssociationToGateOpenMs=' + String(finalContentAssociationToGateOpenMs)
        ];

        const initialSegmentRecords = state.adPod.initialSegments && state.adPod.initialSegments.length > 0
          ? state.adPod.initialSegments
          : (state.adPod.segments ? Array.from(state.adPod.segments.values()).filter(function (s) { return s.isInitial; }) : []);

        if (initialAds && initialSegmentRecords.length > 0) {
          initialSegmentRecords.slice(0, MAX_AD_SEGMENTS).forEach(function (segData, index) {
            const segNum = index + 1;
            const segConfirmedToEndpointMs = segData.endpointEvidenceAt && segData.segmentConfirmedAt
              ? Math.max(0, Math.round(segData.endpointEvidenceAt - segData.segmentConfirmedAt)) : 'none';
            const endpointToMediaResetMs = segData.mediaResetAt && segData.endpointEvidenceAt
              ? Math.max(0, Math.round(segData.mediaResetAt - segData.endpointEvidenceAt)) : 'none';
            const mediaResetToNextLoadstartMs = segData.nextLoadstartAt && segData.mediaResetAt
              ? Math.max(0, Math.round(segData.nextLoadstartAt - segData.mediaResetAt)) : 'none';
            const nextLoadstartToClassificationMs = segData.nextClassificationAt && segData.nextLoadstartAt
              ? Math.max(0, Math.round(segData.nextClassificationAt - segData.nextLoadstartAt)) : 'none';

            if (typeof segConfirmedToEndpointMs === 'number') maxSegmentConfirmedToEndpointMs = Math.max(maxSegmentConfirmedToEndpointMs, segConfirmedToEndpointMs);
            if (typeof endpointToMediaResetMs === 'number') maxEndpointToMediaResetMs = Math.max(maxEndpointToMediaResetMs, endpointToMediaResetMs);
            if (typeof mediaResetToNextLoadstartMs === 'number') maxMediaResetToNextLoadstartMs = Math.max(maxMediaResetToNextLoadstartMs, mediaResetToNextLoadstartMs);
            if (typeof nextLoadstartToClassificationMs === 'number') maxNextLoadstartToClassificationMs = Math.max(maxNextLoadstartToClassificationMs, nextLoadstartToClassificationMs);

            summaryParts.push('seg' + String(segNum) + 'ConfirmedToEndpointMs=' + String(segConfirmedToEndpointMs));
            summaryParts.push('seg' + String(segNum) + 'EndpointToMediaResetMs=' + String(endpointToMediaResetMs));
            summaryParts.push('seg' + String(segNum) + 'MediaResetToNextLoadstartMs=' + String(mediaResetToNextLoadstartMs));
            summaryParts.push('seg' + String(segNum) + 'NextLoadstartToClassificationMs=' + String(nextLoadstartToClassificationMs));
          });
        }

        summaryParts.push('maxSegmentConfirmedToEndpointMs=' + String(maxSegmentConfirmedToEndpointMs));
        summaryParts.push('maxEndpointToMediaResetMs=' + String(maxEndpointToMediaResetMs));
        summaryParts.push('maxMediaResetToNextLoadstartMs=' + String(maxMediaResetToNextLoadstartMs));
        summaryParts.push('maxNextLoadstartToClassificationMs=' + String(maxNextLoadstartToClassificationMs));

        if (state.adPod.laterAdSegments > 0) {
          summaryParts.push('laterAdSegments=' + String(state.adPod.laterAdSegments));
          summaryParts.push('laterAdInterruptions=' + String(state.holdBreakStats.laterAdInterruptions));
        }

        let unattributedLatencyMs = 0;
        if (initialAds && loadRequestToGateOpenMs > 0) {
          const sumKnown = loadRequestToFirstConfirmedAdMs + totalAdPodWallMs + finalContentAssociationToGateOpenMs;
          unattributedLatencyMs = Math.max(0, Math.round(loadRequestToGateOpenMs - sumKnown));
        }
        summaryParts.push('unattributedLatencyMs=' + String(unattributedLatencyMs));

        console.debug('[YTPM][AdPodLatencySummary]', summaryParts.join(' '));
      }
      state.suppressed = false; console.debug('[YTPM][AdGuard]', 'phase=disarmed', 'generation=' + String(config.generation), 'reason=' + String(reason || 'session-ended'));
      if (!state.summaryLogged) { state.summaryLogged = true; log('summary', { adDetected: state.adDetected, skipInvoked: state.skipInvoked, confirmedAdSegments: state.confirmedAdSegments, contentStarted: state.contentStarted, result: state.contentStarted || !state.adDetected ? 'PASS' : 'PENDING' }); }
    }
    function noteLoadRequested() {
      state.adPod.loadRequestedAt = latencyNow();
    }
    return { arm: arm, disarm: disarm, refresh: function () { inspect('refresh'); inspectPageStatus(); }, status: function () { return { armed: state.armed, suppressed: state.suppressed, handledAdSegments: state.confirmedAdSegments, confirmedAdSegments: state.confirmedAdSegments, currentPodConfirmedSegments: state.currentPodConfirmedSegments, adDetected: state.adDetected, contentStarted: state.contentStarted, loadEpoch: state.loadEpoch, presentationClosed: state.presentationClosed, presentationCloseCycles: state.presentationCloseCycles, presentationOpenCycles: state.presentationOpenCycles, postContentReclosures: state.postContentReclosures, visibleAdViolation: state.visibleAdViolation }; }, noteLoadRequested: noteLoadRequested };
  }
  globalThis.YTPMPreviewAdGuard = Object.freeze({ create: createGuard, getPlayerStatus: getPlayerStatus, MAX_AD_SEGMENTS: MAX_AD_SEGMENTS });
  console.debug('[YTPM][AdGuard] phase=api-ready');
})();
