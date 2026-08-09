import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../caption-utils.js', import.meta.url),
  'utf8'
);
const stylesSource = fs.readFileSync(
  new URL('../styles.css', import.meta.url),
  'utf8'
);
const sandbox = {
  URL,
  location: {
    href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    origin: 'https://www.youtube.com'
  }
};
vm.runInNewContext(source, sandbox, { filename: 'caption-utils.js' });
const utils = sandbox.YTPMCaptionUtils;

test('normalizes only valid YouTube video IDs', () => {
  assert.equal(utils.normalizeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(utils.normalizeVideoId('watch:dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(utils.normalizeVideoId('shorts:dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(utils.normalizeVideoId('too-short'), '');
  assert.equal(utils.normalizeVideoId('dQw4w9WgXcQ<script>'), '');
});

test('accepts only HTTPS caption URLs on the YouTube origin', () => {
  const allowedOrigin = 'https://www.youtube.com';
  const safeUrl = utils.getSafeCaptionUrl(
    'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ',
    allowedOrigin
  );

  assert.equal(safeUrl.origin, allowedOrigin);
  assert.equal(
    utils.getSafeCaptionUrl('https://accounts.google.com/caption', allowedOrigin),
    null
  );
  assert.equal(
    utils.getSafeCaptionUrl('http://www.youtube.com/api/timedtext', allowedOrigin),
    null
  );
  assert.equal(
    utils.getSafeCaptionUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', allowedOrigin),
    null
  );
  assert.equal(
    utils.getSafeCaptionUrl('https://user:pass@www.youtube.com/caption', allowedOrigin),
    null
  );
});

test('builds a bounded caption catalog and discards unsafe tracks', () => {
  const catalog = utils.buildCaptionCatalog({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?lang=en',
            languageCode: 'en',
            name: { simpleText: 'English' }
          },
          {
            baseUrl: 'https://evil.example/caption',
            languageCode: 'fr',
            name: { simpleText: 'French' }
          }
        ],
        translationLanguages: [
          {
            languageCode: 'es',
            languageName: { simpleText: 'Spanish' }
          }
        ]
      }
    }
  }, 'https://www.youtube.com');

  assert.equal(catalog.available, true);
  assert.equal(catalog.tracks.length, 1);
  assert.equal(catalog.tracks[0].languageCode, 'en');
  assert.equal(catalog.translationLanguages[0].languageCode, 'es');
});

test('normalizes native caption text and state conservatively', () => {
  assert.equal(
    utils.normalizeCaptionLines([' Hello  world ', 'Hello world', 'Next\r\nline']),
    'Hello world\nNext\nline'
  );
  assert.equal(utils.normalizeCaptionLines(['  ', '\n', '\t']), '');
  assert.equal(utils.normalizeCaptionLines(['First sentence']), 'First sentence');
  assert.equal(utils.normalizeCaptionLines(['Second sentence']), 'Second sentence');
  assert.equal(
    utils.normalizeCaptionLines(['Hello there', 'How are you?']),
    'Hello there\nHow are you?'
  );
  assert.equal(utils.normalizeCaptionLines(['Next caption']), 'Next caption');
  assert.equal(utils.resolveCaptionEnabledState(false, true, true), false);
  assert.equal(utils.resolveCaptionEnabledState(true, false, false), true);
  assert.equal(utils.resolveCaptionEnabledState(null, false, true), true);
  assert.deepEqual(JSON.parse(JSON.stringify(utils.getCaptionTogglePlan(false, true))), {
    desiredEnabled: true,
    shouldChange: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(utils.getCaptionTogglePlan(true, true))), {
    desiredEnabled: true,
    shouldChange: false
  });
  assert.deepEqual(JSON.parse(JSON.stringify(utils.normalizeCaptionState({ available: true, enabled: true }))), {
    available: true,
    enabled: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(utils.normalizeCaptionState({ available: false, enabled: true }))), {
    available: false,
    enabled: false
  });
});

test('suppresses only structural transient caption empties that match the complete visible paragraph', () => {
  const visible = '>> First line\n>> Second line';
  const capturedFalseEmpty = utils.getTransientCaptionEmptyPlan('', visible,
    'Older roll-up material\n' + visible, [{
      rawText: 'Older roll-up material\n' + visible,
      extractedText: visible
    }]);

  assert.deepEqual(JSON.parse(JSON.stringify(capturedFalseEmpty)), {
    shouldSuppress: true,
    matchingWindowIndex: 0
  });

  const restored = utils.getTransientCaptionEmptyPlan(visible, visible, visible, [{
    rawText: visible,
    extractedText: visible
  }]);
  assert.equal(restored.shouldSuppress, false);

  const trueEmpty = utils.getTransientCaptionEmptyPlan('', visible, '', []);
  assert.equal(trueEmpty.shouldSuppress, false);

  const differentWindow = utils.getTransientCaptionEmptyPlan('', visible, 'Different text', [{
    rawText: 'Different text',
    extractedText: 'Different text'
  }]);
  assert.equal(differentWindow.shouldSuppress, false);

  const missingRawText = utils.getTransientCaptionEmptyPlan('', visible, visible, [{
    rawText: '',
    extractedText: visible
  }]);
  assert.equal(missingRawText.shouldSuppress, false);
});

test('keeps seek UI pending until one authoritative commit is confirmed', () => {
  assert.equal(utils.clampSeekTime(-4, 300), 0);
  assert.equal(utils.clampSeekTime(138, 300), 138);
  assert.equal(utils.clampSeekTime(999, 300), 300);
  assert.equal(
    utils.getSeekDisplayTime(130, 138, false, true, 300),
    138
  );
  assert.equal(
    utils.getSeekDisplayTime(130, 138, false, false, 300),
    130
  );
  assert.equal(utils.isSeekWithinTolerance(138, 138, 0.75), true);
  assert.equal(utils.isSeekWithinTolerance(130, 138, 0.75), false);
  assert.equal(utils.isSeekWithinTolerance(15.85, 16, 0.5), true);
  assert.equal(utils.isSeekWithinTolerance(13, 16, 0.5), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.getSeekConfirmationPlan(true, 13, 16, 16, 0.5))),
    {
      playerConfirmed: false,
      videoConfirmed: true,
      visibleVideoReachedTarget: true,
      snapback: false,
      confirmed: true
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.getSeekConfirmationPlan(true, 16, 15.8, 16, 0.5))),
    {
      playerConfirmed: true,
      videoConfirmed: true,
      visibleVideoReachedTarget: true,
      snapback: false,
      confirmed: true
    }
  );
  assert.equal(
    utils.getSeekConfirmationPlan(true, 16, 13, 16, 0.5).confirmed,
    false
  );
  assert.equal(
    utils.getSeekConfirmationPlan(false, null, 16, 16, 0.5).confirmed,
    true
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.getSeekExecutionPlan(true, true))),
    [{ stage: 'buffered-player-seek', allowSeekAhead: false }]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.getSeekExecutionPlan(false, true))),
    [
      { stage: 'unbuffered-load-seek', allowSeekAhead: true },
      { stage: 'precision-player-seek', allowSeekAhead: false }
    ]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.getSeekExecutionPlan(false, false))),
    [{ stage: 'video-fallback', allowSeekAhead: null }]
  );

  assert.equal(utils.getSeekCommitPlan(13, 16, 300, 0.15).shouldSeek, true);
  assert.equal(utils.getSeekCommitPlan(13, 18, 300, 0.15).shouldSeek, true);
  assert.equal(utils.getSeekCommitPlan(13, 23, 300, 0.15).shouldSeek, true);
  assert.equal(utils.getSeekCommitPlan(13, 13.05, 300, 0.15).shouldSeek, false);

  const buffered = [{ start: 10, end: 20 }];
  assert.equal(utils.isTimeBuffered(buffered, 16, 0.05), true);
  assert.equal(utils.isTimeBuffered(buffered, 18, 0.05), true);
  assert.equal(utils.isTimeBuffered(buffered, 21, 0.05), false);
  assert.equal(utils.isTimeBuffered(buffered, 10, 0), true);

  const currentRequest = { active: true, requestId: 2 };
  assert.equal(utils.isSeekRequestCurrent(currentRequest, 1), false);
  assert.equal(utils.isSeekRequestCurrent(currentRequest, 2), true);
  assert.equal(utils.getSeekController(true), 'player');
  assert.equal(utils.getSeekController(false), 'video');
  assert.equal(utils.isSeekWithinTolerance(130, 130, 0.75), true);
});

test('uses full timeline geometry for mouse seeks without changing keyboard range input', () => {
  const pointer = utils.getTimelinePointerPosition(68, 51.234375, 1205.53125, 1378);
  assert.ok(Math.abs(pointer.seconds - 19.164191098) < 0.001);
  assert.deepEqual(JSON.parse(JSON.stringify(
    utils.getPointerSeekInputPlan(true, pointer.seconds, 12.4)
  )), {
    targetTime: pointer.seconds,
    source: 'pointer-geometry'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    utils.getPointerSeekInputPlan(false, pointer.seconds, 12.4)
  )), {
    targetTime: 12.4,
    source: 'range-value'
  });
  assert.equal(utils.shouldCommitSeekInteraction(7, 0), true);
  assert.equal(utils.shouldCommitSeekInteraction(7, 7), false);
});

test('rejects stale players and distinguishes normal progression from snapback', () => {
  assert.equal(utils.isPlayerSynchronizedWithVideo(52.8, 29.66, 1.5), false);
  assert.equal(utils.isPlayerSynchronizedWithVideo(12.4, 12.8, 1.5), true);

  const progressed = utils.getSeekConfirmationPlan(
    true, 12.4, 13.2, 12.4, 0.5,
    { visibleVideoReachedTarget: true, preSeekVideoTime: 10 }
  );
  assert.equal(progressed.confirmed, true);
  assert.equal(progressed.snapback, false);

  const snapped = utils.getSeekConfirmationPlan(
    true, 12.4, 10.2, 12.4, 0.5,
    { visibleVideoReachedTarget: true, preSeekVideoTime: 10 }
  );
  assert.equal(snapped.confirmed, false);
  assert.equal(snapped.snapback, true);
});

test('mirrors only roll-up caption segments geometrically presented in the clip', () => {
  const clip = { left: 0, right: 300, top: 100, bottom: 140, width: 300, height: 40 };
  const currentTop = { left: 0, right: 300, top: 100, bottom: 120, width: 300, height: 20 };
  const currentBottom = { left: 0, right: 300, top: 120, bottom: 140, width: 300, height: 20 };
  const stale = { left: 0, right: 300, top: 60, bottom: 80, width: 300, height: 20 };
  const barelyLeaving = { left: 0, right: 300, top: 85, bottom: 105, width: 300, height: 20 };

  assert.equal(utils.getCaptionSegmentMirrorPlan(currentTop, clip, 0.5).shouldMirror, true);
  assert.equal(utils.getCaptionSegmentMirrorPlan(currentBottom, clip, 0.5).shouldMirror, true);
  assert.equal(utils.getCaptionSegmentMirrorPlan(stale, clip, 0.5).shouldMirror, false);
  assert.equal(utils.getCaptionSegmentMirrorPlan(barelyLeaving, clip, 0.5).shouldMirror, false);
});

test('resolves complete roll-up paragraphs into extension-owned transitions', () => {
  const fourLineParagraph = utils.normalizeCaptionLines(['L1', 'L2', 'L3', 'L4']);
  assert.equal(fourLineParagraph, 'L1\nL2\nL3\nL4');
  assert.equal(utils.getNormalizedCaptionLineList(fourLineParagraph).length, 4);
  assert.equal(utils.normalizeCaptionLines(['L1', 'L2']), 'L1\nL2');

  const superset = utils.getRollupCaptionTransitionPlan(
    'A1\nA2', 'A1\nA2\nB1\nB2', true, true
  );
  assert.deepEqual(JSON.parse(JSON.stringify(superset)), {
    shouldTransition: true,
    transientSuperset: true,
    currentText: 'A1\nA2',
    incomingText: 'B1\nB2'
  });
  const direct = utils.getRollupCaptionTransitionPlan('A1\nA2', 'B1\nB2', true, false);
  assert.equal(direct.incomingText, 'B1\nB2');
  assert.equal(direct.transientSuperset, false);
  const duplicate = utils.getRollupCaptionTransitionPlan('B1\nB2', 'B1\nB2', true, false);
  assert.equal(duplicate.shouldTransition, false);
  const nonRollup = utils.getRollupCaptionTransitionPlan('A1', 'A1\nB1', false, true);
  assert.equal(nonRollup.transientSuperset, false);
  const empty = utils.getRollupCaptionTransitionPlan('B1\nB2', '', true, false);
  assert.equal(empty.shouldTransition, false);
  assert.equal(utils.isCaptionTransitionCurrent(3, 3), true);
  assert.equal(utils.isCaptionTransitionCurrent(3, 4), false);
  assert.deepEqual(JSON.parse(JSON.stringify(
    utils.getIncomingOnlyCaptionRenderPlan('B1\nB2\nB3\nB4')
  )), {
    visibleText: 'B1\nB2\nB3\nB4',
    outgoingVisible: false,
    animationPhase: 'incoming-only-entry'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    utils.getIncomingOnlyCaptionRenderPlan('')
  )), {
    visibleText: '',
    outgoingVisible: false,
    animationPhase: 'idle'
  });
  assert.equal(
    utils.isRollupCaptionRollback('A1\nA2', 'B1\nB2', 'A1\nA2', 'A1\nA2\nB1\nB2'),
    true
  );
  assert.equal(
    utils.isRollupCaptionRollback('B1\nB2', 'B1\nB2', 'A1\nA2', 'A1\nA2\nB1\nB2'),
    false
  );
  assert.equal(
    utils.isRollupCaptionRollback('B1\nB2', 'C1\nC2', 'B1\nB2', 'B1\nB2\nC1\nC2'),
    true
  );
  assert.equal(
    utils.isRollupCaptionRollback('A1\nA2', 'B1\nB2', '', 'A1\nA2\nB1\nB2'),
    false
  );
  assert.deepEqual(JSON.parse(JSON.stringify(
    utils.deriveTrailingRollupSuccessor('A1\nA2\nB1\nB2', 'A1\nA2')
  )), ['B1', 'B2']);
  assert.equal(utils.isExactCaptionLineSequence('B1\nB2', ['B1', 'B2']), true);
  assert.equal(utils.isExactCaptionLineSequence('B2', ['B1', 'B2']), false);
  assert.equal(utils.isCaptionLineFragment('A2', 'A1\nA2'), true);
  assert.equal(utils.isCaptionLineFragment('B2', 'B1\nB2'), true);
  assert.equal(utils.isExactCaptionLineSequence('B1', ['B1']), true);
});

test('keeps an incoming caption visible before its roll animation frame', () => {
  assert.match(stylesSource, /caption-viewport--incoming-ready/);
  assert.match(stylesSource, /incoming-ready[\s\S]*caption-layer--incoming/);
  assert.match(stylesSource, /translateY\(10px\)/);
});

test('selects caption windows by mutation generation without losing multiline cues', () => {
  let active = utils.selectCaptionWindowGeneration([], ['A'], ['A']);
  assert.deepEqual(JSON.parse(JSON.stringify(active)), ['A']);

  active = utils.selectCaptionWindowGeneration(active, ['B'], ['A', 'B']);
  assert.deepEqual(JSON.parse(JSON.stringify(active)), ['B']);
  assert.equal(utils.normalizeCaptionLines(['line 1', 'line 2']), 'line 1\nline 2');

  active = utils.selectCaptionWindowGeneration(active, [], ['A', 'B']);
  assert.deepEqual(JSON.parse(JSON.stringify(active)), ['B']);

  active = utils.selectCaptionWindowGeneration(active, ['C'], ['A', 'B', 'C']);
  assert.deepEqual(JSON.parse(JSON.stringify(active)), ['C']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.selectCaptionWindowGeneration(active, [], ['A', 'B']))),
    []
  );
});

test('assigns caption mutations to their owning window and prioritizes the current generation', () => {
  const rendererNode = {
    kind: 'caption-renderer',
    descendantWindows: ['window-A', 'window-B']
  };
  const rendererTargetBatch = utils.getCaptionMutationOwnershipPlan([
    {
      type: 'childList',
      target: rendererNode,
      targetWindow: null,
      addedNodes: [{
        captionWindow: 'window-B',
        descendants: []
      }],
      removedNodes: []
    }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rendererTargetBatch)), {
    contentTouched: ['window-B'],
    activationTouched: [],
    removedWindows: []
  });

  const internalSegmentBatch = utils.getCaptionMutationOwnershipPlan([
    {
      type: 'characterData',
      targetWindow: 'window-B'
    }
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(internalSegmentBatch.contentTouched)),
    ['window-B']
  );

  const activationBatch = utils.getCaptionMutationOwnershipPlan([
    {
      type: 'attributes',
      attributeName: 'aria-hidden',
      activationWindow: 'window-B'
    }
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(activationBatch.activationTouched)),
    ['window-B']
  );
  const removalBatch = utils.getCaptionMutationOwnershipPlan([
    {
      type: 'childList',
      target: rendererNode,
      targetWindow: null,
      addedNodes: [],
      removedNodes: [{ captionWindow: 'window-B', descendants: [] }]
    }
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(removalBatch.removedWindows)),
    ['window-B']
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.selectCaptionWindowGeneration(
      ['window-A'],
      activationBatch.activationTouched,
      ['window-A', 'window-B']
    ))),
    ['window-B']
  );

  const arabicOldWindow = { id: 'A', text: '\u0645\u0631\u062d\u0628\u0627' };
  const arabicNewWindow = { id: 'B', text: '\u0627\u0644\u0639\u0627\u0644\u0645' };
  const arabicTransition = utils.getCaptionMutationOwnershipPlan([
    {
      type: 'childList',
      target: rendererNode,
      targetWindow: null,
      addedNodes: [{ captionWindow: arabicNewWindow, descendants: [] }],
      removedNodes: []
    }
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(utils.selectCaptionWindowGeneration(
      [arabicOldWindow],
      arabicTransition.contentTouched,
      [arabicOldWindow, arabicNewWindow]
    ))),
    [arabicNewWindow]
  );
});

test('exposes the CC pressed-state visual hook without changing its accessible label', () => {
  assert.equal(utils.isCaptionButtonPressed('true'), true);
  assert.equal(utils.isCaptionButtonPressed('false'), false);
  assert.match(
    stylesSource,
    /\.ytpm-overlay__captions-button\[aria-pressed="true"\]::after/
  );
  assert.match(
    stylesSource,
    /\.ytpm-overlay__captions-button\[aria-pressed="false"\]::after/
  );
});

test('rejects stale storyboard loads and mismatched displayed sprites', () => {
  const urls = {
    m0: 'https://i.ytimg.com/sb/video/storyboard3_L2/M0.jpg',
    m1: 'https://i.ytimg.com/sb/video/storyboard3_L2/M1.jpg',
    m4: 'https://i.ytimg.com/sb/video/storyboard3_L2/M4.jpg',
    m5: 'https://i.ytimg.com/sb/video/storyboard3_L2/M5.jpg'
  };
  const state = {
    active: true,
    hovering: true,
    token: 0,
    desiredUrl: '',
    displayedUrl: ''
  };
  const visible = [];
  const request = function (url, token) {
    state.token = token;
    state.desiredUrl = url;
    return function resolve() {
      if (utils.canApplyStoryboardFrame(state, token, url)) {
        visible.push(url);
      }
    };
  };

  const resolveM0 = request(urls.m0, 1);
  const resolveM5 = request(urls.m5, 2);
  const resolveM1 = request(urls.m1, 3);
  resolveM5();
  resolveM0();
  state.displayedUrl = urls.m1;
  resolveM1();

  const resolveM4 = request(urls.m4, 4);
  state.displayedUrl = urls.m4;
  resolveM4();
  assert.deepEqual(visible, [urls.m1, urls.m4]);
});

test('requires a cache-hit sprite to become the displayed source before cropping', () => {
  const state = {
    active: true,
    hovering: true,
    token: 1,
    desiredUrl: 'M0',
    displayedUrl: 'M0'
  };

  assert.equal(utils.canApplyStoryboardFrame(state, 1, 'M0'), true);

  state.token = 2;
  state.desiredUrl = 'M5';
  assert.equal(utils.canApplyStoryboardFrame(state, 2, 'M5'), false);
  state.displayedUrl = 'M5';
  assert.equal(utils.canApplyStoryboardFrame(state, 2, 'M5'), true);

  state.token = 3;
  state.desiredUrl = 'M0';
  assert.equal(utils.canApplyStoryboardFrame(state, 3, 'M0'), false);
  state.displayedUrl = 'M0';
  assert.equal(utils.canApplyStoryboardFrame(state, 3, 'M0'), true);
});

test('maps realistic storyboard specs across first, middle, and last sprite cells', () => {
  const catalog = utils.buildCaptionCatalog({
    videoDetails: { videoId: 'dQw4w9WgXcQ', lengthSeconds: '205' },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=test-sqp|' +
          '160#90#100#10#10#0#default#sig-low|' +
          '320#180#205#5#5#10000#M$M#sig-high',
        recommendedLevel: 1
      }
    }
  }, 'https://www.youtube.com', 'dQw4w9WgXcQ');

  assert.equal(catalog.videoId, 'dQw4w9WgXcQ');
  assert.equal(catalog.storyboard.duration, 205);
  assert.equal(catalog.storyboard.formats[1].sourceInterval, 10000);
  assert.equal(catalog.storyboard.formats[1].framesPerSprite, 25);
  assert.equal(catalog.storyboard.formats[1].name, 'M$M');
  assert.equal(catalog.storyboard.formats[1].signature, 'sig-high');

  const lowLevelStoryboard = { ...catalog.storyboard, recommendedLevel: 0 };
  const lowFrame = utils.getStoryboardFrame(lowLevelStoryboard, 100, 205);
  assert.equal(
    lowFrame.url,
    'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L0/default.jpg?sqp=test-sqp&sigh=sig-low'
  );

  const first = utils.getStoryboardFrame(catalog.storyboard, 0, 205);
  assert.equal(
    first.url,
    'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L1/M0.jpg?sqp=test-sqp&sigh=sig-high'
  );
  assert.deepEqual({ frameIndex: first.frameIndex, spriteIndex: first.spriteIndex, cellIndex: first.cellIndex }, {
    frameIndex: 0,
    spriteIndex: 0,
    cellIndex: 0
  });

  const secondSprite = utils.getStoryboardFrame(catalog.storyboard, 26, 205);
  assert.deepEqual({
    frameIndex: secondSprite.frameIndex,
    spriteIndex: secondSprite.spriteIndex,
    cellIndex: secondSprite.cellIndex,
    x: secondSprite.x,
    y: secondSprite.y
  }, {
    frameIndex: 26,
    spriteIndex: 1,
    cellIndex: 1,
    x: 320,
    y: 0
  });

  const middle = utils.getStoryboardFrame(catalog.storyboard, 126, 205);
  assert.deepEqual({ frameIndex: middle.frameIndex, spriteIndex: middle.spriteIndex, cellIndex: middle.cellIndex }, {
    frameIndex: 126,
    spriteIndex: 5,
    cellIndex: 1
  });
  assert.equal(middle.x, 320);
  assert.equal(middle.y, 0);

  const last = utils.getStoryboardFrame(catalog.storyboard, 204.9, 205);
  assert.deepEqual({ frameIndex: last.frameIndex, spriteIndex: last.spriteIndex, cellIndex: last.cellIndex }, {
    frameIndex: 204,
    spriteIndex: 8,
    cellIndex: 4
  });
  assert.equal(last.x, 4 * 320);
  assert.equal(last.y, 0);

  const midpoint = utils.getStoryboardFrame(catalog.storyboard, 205 / 2, 205);
  assert.equal(midpoint.frameIndex, 102);
  assert.ok(midpoint.frameIndex >= 0 && midpoint.frameIndex < 205);

  const exactEnd = utils.getStoryboardFrame(catalog.storyboard, 205, 205);
  assert.equal(exactEnd.frameIndex, 204);
  assert.equal(exactEnd.framesPerSprite, 25);
  assert.equal(exactEnd.spriteIndex, 8);
  assert.equal(exactEnd.cellIndex, 4);
  assert.ok(exactEnd.frameIndex >= 0 && exactEnd.frameIndex < 205);

  const pastEnd = utils.getStoryboardFrame(catalog.storyboard, 999, 205);
  assert.equal(pastEnd.frameIndex, 204);
  assert.equal(pastEnd.spriteIndex, 8);
  assert.equal(pastEnd.cellIndex, 4);

  const negative = utils.getStoryboardFrame(catalog.storyboard, -10, 205);
  assert.equal(negative.frameIndex, 0);
  assert.equal(negative.spriteIndex, 0);
  assert.equal(negative.cellIndex, 0);

  const notANumber = utils.getStoryboardFrame(catalog.storyboard, Number.NaN, 205);
  assert.equal(notANumber.frameIndex, 0);
  assert.equal(
    utils.getStoryboardFrame({ ...catalog.storyboard, duration: 0 }, 0, 0),
    null
  );
});

test('preserves sparse storyboard levels when the recommended level skips malformed data', () => {
  const catalog = utils.buildCaptionCatalog({
    videoDetails: { videoId: 'dQw4w9WgXcQ', lengthSeconds: '213' },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg|' +
          'not-a-storyboard-format|' +
          '80#45#213#10#10#10000#M$M#sig1|' +
          '160#90#213#5#5#10000#M$M#sig2|' +
          '320#180#213#3#3#10000#M$M#sig3',
        recommendedLevel: 3
      }
    }
  }, 'https://www.youtube.com', 'dQw4w9WgXcQ');

  assert.equal(catalog.storyboard.recommendedLevel, 3);
  assert.equal(
    catalog.storyboard.formats.map((format) => format.level).join(','),
    '1,2,3'
  );
  assert.equal(
    utils.getStoryboardFrame(catalog.storyboard, 60, 213).url.includes('/storyboard3_L3/M6.jpg'),
    true
  );
});

test('sanitizes live caption catalogs and rejects unsafe storyboard origins', () => {
  const catalog = utils.sanitizeCaptionCatalog({
    available: true,
    videoId: 'dQw4w9WgXcQ',
    tracks: [
      {
        id: '0',
        baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ',
        languageCode: 'en',
        label: 'English'
      },
      {
        id: '1',
        baseUrl: 'https://evil.example/caption',
        languageCode: 'fr',
        label: 'French'
      }
    ],
    translationLanguages: [
      { languageCode: 'ar', label: 'Arabic' }
    ],
    storyboard: {
      template: 'https://evil.example/sb/dQw4w9WgXcQ/$N.jpg',
      formats: [{
        width: 160,
        height: 90,
        count: 1,
        columns: 1,
        rows: 1,
        intervalMs: 1000
      }]
    }
  }, 'https://www.youtube.com', 'dQw4w9WgXcQ');

  assert.equal(catalog.tracks.length, 1);
  assert.equal(catalog.translationLanguages[0].languageCode, 'ar');
  assert.equal(catalog.storyboard, null);
  assert.equal(
    utils.normalizeStoryboard({ spec: 'not-a-valid-spec' }, 'dQw4w9WgXcQ', 10),
    null
  );
  assert.equal(
    utils.getStoryboardFrame({ formats: [] }, 1, 10),
    null
  );
});

test('parses JSON caption cues with a hard item limit', () => {
  const events = Array.from({ length: 5002 }, (_, index) => ({
    tStartMs: index * 1000,
    dDurationMs: 900,
    segs: [{ utf8: `cue-${index}` }]
  }));
  const cues = utils.parseJsonCaptionCues(JSON.stringify({ events }));

  assert.equal(cues.length, 5000);
  assert.deepEqual({ ...cues[0] }, {
    start: 0,
    duration: 0.9,
    text: 'cue-0'
  });
  assert.equal(utils.parseJsonCaptionCues('{not-json}').length, 0);
});

test('extracts only the marked JSON object from a player response', () => {
  const result = utils.extractJsonObject(
    'prefix;var ytInitialPlayerResponse = {"captions":{"ok":true}};suffix',
    'ytInitialPlayerResponse'
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { captions: { ok: true } });
  assert.equal(utils.extractJsonObject('var other = {};', 'ytInitialPlayerResponse'), null);
});
