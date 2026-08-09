(function (global) {
  'use strict';

  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
  const MAX_CAPTION_CUES = 5000;
  const MAX_CUE_TEXT_LENGTH = 8192;
  const MAX_LABEL_LENGTH = 200;
  const MAX_TRACKS = 100;
  const MAX_STORYBOARD_FORMATS = 8;
  const MAX_STORYBOARD_SPEC_LENGTH = 8192;
  const MAX_STORYBOARD_COUNT = 100000;
  const MAX_STORYBOARD_DIMENSION = 4096;
  const MAX_STORYBOARD_INTERVAL_MS = 3600000;
  const STORYBOARD_ORIGIN = 'https://i.ytimg.com';

  function normalizeVideoId(value) {
    const normalized = String(value || '')
      .replace(/^(watch|shorts|live):/, '');

    return VIDEO_ID_PATTERN.test(normalized) ? normalized : '';
  }

  function normalizeLanguage(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return LANGUAGE_PATTERN.test(normalized) ? normalized : '';
  }

  function normalizeDuration(value) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 && duration <= 86400
      ? duration
      : 0;
  }

  function readText(value) {
    if (typeof value === 'string') {
      return value.slice(0, MAX_LABEL_LENGTH);
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    if (typeof value.simpleText === 'string') {
      return value.simpleText.slice(0, MAX_LABEL_LENGTH);
    }

    if (Array.isArray(value.runs)) {
      return value.runs.map(function (run) {
        return run && typeof run.text === 'string' ? run.text : '';
      }).join('').slice(0, MAX_LABEL_LENGTH);
    }

    return '';
  }

  function normalizeCaptionLines(values) {
    const source = Array.isArray(values) ? values : [values];
    const lines = [];

    source.forEach(function (value) {
      if (typeof value !== 'string') {
        return;
      }

      value.replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
        const normalized = line.replace(/[ \t]+/g, ' ').trim();
        if (!normalized || lines[lines.length - 1] === normalized) {
          return;
        }
        lines.push(normalized);
      });
    });

    return lines.join('\n');
  }

  function getNormalizedCaptionLineList(value) {
    const normalized = normalizeCaptionLines(value);
    return normalized ? normalized.split('\n') : [];
  }

  function isStrictCaptionLineSuperset(previousLines, candidateLines) {
    const previous = getNormalizedCaptionLineList(previousLines);
    const candidate = getNormalizedCaptionLineList(candidateLines);
    return previous.length > 0 && candidate.length > previous.length &&
      previous.every(function (line) {
        return candidate.includes(line);
      });
  }

  function getRollupCaptionTransitionPlan(committedText, candidateText, isRollup, movedUpward) {
    const committedLines = getNormalizedCaptionLineList(committedText);
    const candidateLines = getNormalizedCaptionLineList(candidateText);
    const candidate = candidateLines.join('\n');
    const committed = committedLines.join('\n');
    const transientSuperset = isRollup === true && movedUpward === true &&
      isStrictCaptionLineSuperset(committedLines, candidateLines);
    return {
      shouldTransition: Boolean(committed && candidate && candidate !== committed),
      transientSuperset: transientSuperset,
      currentText: committed,
      incomingText: transientSuperset
        ? candidateLines.slice(committedLines.length).join('\n')
        : candidate
    };
  }

  function isCaptionTransitionCurrent(token, currentToken) {
    return Number.isInteger(Number(token)) && Number(token) >= 0 &&
      Number(token) === Number(currentToken);
  }

  function getIncomingOnlyCaptionRenderPlan(authoritativeText) {
    const visibleText = normalizeCaptionLines(authoritativeText);
    return {
      visibleText: visibleText,
      outgoingVisible: false,
      animationPhase: visibleText ? 'incoming-only-entry' : 'idle'
    };
  }

  function findCaptionLineSequence(rawLines, paragraphLines, startIndex) {
    const source = Array.isArray(rawLines) ? rawLines : [];
    const target = Array.isArray(paragraphLines) ? paragraphLines : [];
    if (!target.length) {
      return -1;
    }
    for (let index = Math.max(0, Number(startIndex) || 0); index <= source.length - target.length; index += 1) {
      if (target.every(function (line, offset) { return source[index + offset] === line; })) {
        return index;
      }
    }
    return -1;
  }

  function isRollupCaptionRollback(candidateText, currentText, previousText, rawRollupText) {
    const candidate = normalizeCaptionLines(candidateText);
    const current = normalizeCaptionLines(currentText);
    const previous = normalizeCaptionLines(previousText);
    if (!candidate || !current || !previous || candidate !== previous || current === previous) {
      return false;
    }
    const rawLines = getNormalizedCaptionLineList(rawRollupText);
    const previousLines = getNormalizedCaptionLineList(previous);
    const currentLines = getNormalizedCaptionLineList(current);
    const previousIndex = findCaptionLineSequence(rawLines, previousLines, 0);
    const currentIndex = findCaptionLineSequence(
      rawLines,
      currentLines,
      previousIndex >= 0 ? previousIndex + previousLines.length : 0
    );
    return previousIndex >= 0 && currentIndex >= 0;
  }

  function deriveTrailingRollupSuccessor(rawRollupText, predecessorText) {
    const rawLines = getNormalizedCaptionLineList(rawRollupText);
    const predecessorLines = getNormalizedCaptionLineList(predecessorText);
    const predecessorIndex = findCaptionLineSequence(rawLines, predecessorLines, 0);
    if (predecessorIndex < 0) {
      return [];
    }
    return rawLines.slice(predecessorIndex + predecessorLines.length);
  }

  function isExactCaptionLineSequence(candidateText, expectedLines) {
    const candidateLines = getNormalizedCaptionLineList(candidateText);
    const expected = Array.isArray(expectedLines) ? expectedLines : [];
    return candidateLines.length === expected.length && candidateLines.every(function (line, index) {
      return line === expected[index];
    });
  }

  function isCaptionLineFragment(candidateText, completeText) {
    const candidateLines = getNormalizedCaptionLineList(candidateText);
    const completeLines = getNormalizedCaptionLineList(completeText);
    return candidateLines.length > 0 && candidateLines.length < completeLines.length &&
      findCaptionLineSequence(completeLines, candidateLines, 0) >= 0;
  }

  function normalizeCaptionState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { available: false, enabled: false };
    }

    return {
      available: value.available === true,
      enabled: value.available === true && value.enabled === true
    };
  }

  function resolveCaptionEnabledState(controlState, hasShowingTextTrack, hasVisibleRendererText) {
    if (controlState === true) {
      return true;
    }
    if (controlState === false) {
      return false;
    }
    return Boolean(hasShowingTextTrack || hasVisibleRendererText);
  }

  function getCaptionTogglePlan(currentEnabled, desiredEnabled) {
    const current = currentEnabled === true;
    const desired = desiredEnabled === true;
    return {
      desiredEnabled: desired,
      shouldChange: current !== desired
    };
  }

  function isCaptionButtonPressed(value) {
    return value === true || value === 'true';
  }

  function clampSeekTime(value, duration) {
    const safeDuration = normalizeDuration(duration);
    const numericValue = Number(value);
    if (!safeDuration || !Number.isFinite(numericValue)) {
      return 0;
    }

    return Math.max(0, Math.min(safeDuration, numericValue));
  }

  function getTimelinePointerPosition(clientX, left, width, duration) {
    const safeClientX = Number(clientX);
    const safeLeft = Number(left);
    const safeWidth = Number(width);
    const safeDuration = normalizeDuration(duration);
    if (!Number.isFinite(safeClientX) || !Number.isFinite(safeLeft) ||
      !Number.isFinite(safeWidth) || safeWidth <= 0 || !safeDuration) {
      return null;
    }

    const percent = Math.max(0, Math.min(1, (safeClientX - safeLeft) / safeWidth));
    return {
      percent: percent,
      seconds: percent * safeDuration
    };
  }

  function getPointerSeekInputPlan(pointerInteractionActive, pointerTarget, rangeTarget) {
    const safePointerTarget = Number(pointerTarget);
    const safeRangeTarget = Number(rangeTarget);
    if (pointerInteractionActive === true && Number.isFinite(safePointerTarget)) {
      return {
        targetTime: safePointerTarget,
        source: 'pointer-geometry'
      };
    }

    return {
      targetTime: Number.isFinite(safeRangeTarget) ? safeRangeTarget : 0,
      source: 'range-value'
    };
  }

  function shouldCommitSeekInteraction(interactionId, committedInteractionId) {
    const interaction = Number(interactionId);
    return Number.isInteger(interaction) && interaction > 0 &&
      interaction !== Number(committedInteractionId);
  }

  function isPlayerSynchronizedWithVideo(playerCurrentTime, videoCurrentTime, tolerance) {
    return isSeekWithinTolerance(
      playerCurrentTime,
      videoCurrentTime,
      Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
        ? Number(tolerance)
        : 1.5
    );
  }

  function getSeekDisplayTime(actualTime, pendingTime, seekDragging, seekPending, duration) {
    const displayTime = seekDragging || seekPending ? pendingTime : actualTime;
    return clampSeekTime(displayTime, duration);
  }

  function isSeekWithinTolerance(actualTime, requestedTime, tolerance) {
    if (actualTime === null || actualTime === undefined ||
      requestedTime === null || requestedTime === undefined ||
      actualTime === '' || requestedTime === '') {
      return false;
    }

    const actual = Number(actualTime);
    const requested = Number(requestedTime);
    const safeTolerance = Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
      ? Number(tolerance)
      : 0.75;
    return Number.isFinite(actual) && Number.isFinite(requested) &&
      Math.abs(actual - requested) <= safeTolerance;
  }

  function isSeekNoOp(actualTime, requestedTime, epsilon) {
    const safeEpsilon = Number.isFinite(Number(epsilon)) && Number(epsilon) >= 0
      ? Number(epsilon)
      : 0.15;
    return isSeekWithinTolerance(actualTime, requestedTime, safeEpsilon);
  }

  function getSeekCommitPlan(currentTime, requestedTime, duration, epsilon) {
    const targetTime = clampSeekTime(requestedTime, duration);
    return {
      targetTime: targetTime,
      shouldSeek: !isSeekNoOp(currentTime, targetTime, epsilon)
    };
  }

  function isTimeBuffered(bufferedRanges, seconds, margin) {
    if (!Array.isArray(bufferedRanges)) {
      return false;
    }

    const target = Number(seconds);
    const safeMargin = Number.isFinite(Number(margin)) && Number(margin) >= 0
      ? Number(margin)
      : 0;
    if (!Number.isFinite(target)) {
      return false;
    }

    return bufferedRanges.some(function (range) {
      const start = Array.isArray(range) ? Number(range[0]) : Number(range && range.start);
      const end = Array.isArray(range) ? Number(range[1]) : Number(range && range.end);
      return Number.isFinite(start) && Number.isFinite(end) &&
        end >= start &&
        end - start >= safeMargin * 2 &&
        target >= start + safeMargin &&
      target <= end - safeMargin;
    });
  }

  function getSeekConfirmationPlan(
    playerControlled,
    playerCurrentTime,
    videoCurrentTime,
    requestedTime,
    tolerance,
    progress
  ) {
    const playerConfirmed = isSeekWithinTolerance(
      playerCurrentTime,
      requestedTime,
      tolerance
    );
    const videoConfirmed = isSeekWithinTolerance(
      videoCurrentTime,
      requestedTime,
      tolerance
    );
    const videoAvailable = videoCurrentTime !== null &&
      videoCurrentTime !== undefined;
    const visibleVideoReachedTarget = Boolean(
      progress && progress.visibleVideoReachedTarget === true
    ) || videoConfirmed;
    const preSeekVideoTime = progress && Number.isFinite(Number(progress.preSeekVideoTime))
      ? Number(progress.preSeekVideoTime)
      : null;
    const actualVideoTime = Number(videoCurrentTime);
    const targetTime = Number(requestedTime);
    const safeTolerance = Number.isFinite(Number(tolerance)) && Number(tolerance) >= 0
      ? Number(tolerance)
      : 0.75;
    const seekingForward = Number.isFinite(preSeekVideoTime) && Number.isFinite(targetTime) &&
      targetTime > preSeekVideoTime + safeTolerance;
    const seekingBackward = Number.isFinite(preSeekVideoTime) && Number.isFinite(targetTime) &&
      targetTime < preSeekVideoTime - safeTolerance;
    const snapback = Boolean(
      visibleVideoReachedTarget && videoAvailable && Number.isFinite(actualVideoTime) && (
        (seekingForward && actualVideoTime <= preSeekVideoTime + safeTolerance) ||
        (seekingBackward && actualVideoTime >= preSeekVideoTime - safeTolerance)
      )
    );
    return {
      playerConfirmed: playerConfirmed,
      videoConfirmed: videoConfirmed,
      visibleVideoReachedTarget: visibleVideoReachedTarget,
      snapback: snapback,
      confirmed: videoAvailable
        ? visibleVideoReachedTarget && !snapback
        : playerControlled === true && playerConfirmed
    };
  }

  function intersectCaptionRects(first, second) {
    if (!first || !second) {
      return null;
    }

    const left = Math.max(Number(first.left), Number(second.left));
    const right = Math.min(Number(first.right), Number(second.right));
    const top = Math.max(Number(first.top), Number(second.top));
    const bottom = Math.min(Number(first.bottom), Number(second.bottom));
    if (![left, right, top, bottom].every(Number.isFinite) ||
      right <= left || bottom <= top) {
      return null;
    }

    return {
      left: left,
      right: right,
      top: top,
      bottom: bottom,
      width: right - left,
      height: bottom - top
    };
  }

  function getCaptionSegmentMirrorPlan(segmentRect, effectiveClipRect, minVisibleHeightRatio) {
    const rect = segmentRect && typeof segmentRect === 'object' ? segmentRect : null;
    const clip = effectiveClipRect && typeof effectiveClipRect === 'object'
      ? effectiveClipRect
      : null;
    const ratioThreshold = Number.isFinite(Number(minVisibleHeightRatio)) &&
      Number(minVisibleHeightRatio) > 0 && Number(minVisibleHeightRatio) <= 1
      ? Number(minVisibleHeightRatio)
      : 0.5;
    if (!rect || !clip || !Number.isFinite(Number(rect.height)) ||
      Number(rect.height) <= 0) {
      return {
        shouldMirror: false,
        visibleHeightRatio: 0,
        verticalCenterInsideClip: false,
        visibleRect: null
      };
    }

    const visibleRect = intersectCaptionRects(rect, clip);
    const visibleHeightRatio = visibleRect
      ? visibleRect.height / Number(rect.height)
      : 0;
    const verticalCenter = (Number(rect.top) + Number(rect.bottom)) / 2;
    const verticalCenterInsideClip = Number.isFinite(verticalCenter) &&
      verticalCenter >= Number(clip.top) && verticalCenter <= Number(clip.bottom);
    return {
      shouldMirror: Boolean(
        visibleRect && verticalCenterInsideClip &&
        visibleHeightRatio >= ratioThreshold
      ),
      visibleHeightRatio: visibleHeightRatio,
      verticalCenterInsideClip: verticalCenterInsideClip,
      visibleRect: visibleRect
    };
  }

  function getSeekExecutionPlan(targetBuffered, playerSeekAvailable) {
    if (playerSeekAvailable !== true) {
      return [{ stage: 'video-fallback', allowSeekAhead: null }];
    }

    if (targetBuffered === true) {
      return [{ stage: 'buffered-player-seek', allowSeekAhead: false }];
    }

    return [
      { stage: 'unbuffered-load-seek', allowSeekAhead: true },
      { stage: 'precision-player-seek', allowSeekAhead: false }
    ];
  }

  function getCaptionMutationOwnershipPlan(mutations) {
    const contentTouched = [];
    const activationTouched = [];
    const removedWindows = [];
    const pushUnique = function (collection, value) {
      if (value !== null && value !== undefined && !collection.includes(value)) {
        collection.push(value);
      }
    };
    const collectNodeWindows = function (nodes, fallback) {
      const values = [];
      (Array.isArray(nodes) ? nodes : []).forEach(function (node) {
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          if (node.window !== undefined) {
            pushUnique(values, node.window);
          }
          if (node.captionWindow !== undefined) {
            pushUnique(values, node.captionWindow);
          }
          (Array.isArray(node.windows) ? node.windows : [])
            .forEach(function (captionWindow) {
              pushUnique(values, captionWindow);
            });
          (Array.isArray(node.descendants) ? node.descendants : [])
            .forEach(function (captionWindow) {
              pushUnique(values, captionWindow);
            });
          return;
        }
        pushUnique(values, node);
      });
      if (!values.length) {
        (Array.isArray(fallback) ? fallback : []).forEach(function (captionWindow) {
          pushUnique(values, captionWindow);
        });
      }
      return values;
    };

    (Array.isArray(mutations) ? mutations : []).forEach(function (mutation) {
      if (!mutation || typeof mutation !== 'object') {
        return;
      }

      if (mutation.type === 'childList') {
        pushUnique(contentTouched, mutation.targetWindow);
        collectNodeWindows(mutation.addedNodes, mutation.addedWindows)
          .forEach(function (captionWindow) {
            pushUnique(contentTouched, captionWindow);
          });
        collectNodeWindows(mutation.removedNodes, mutation.removedWindows)
          .forEach(function (captionWindow) {
            pushUnique(removedWindows, captionWindow);
          });
        return;
      }

      if (mutation.type === 'characterData') {
        pushUnique(contentTouched, mutation.targetWindow);
        return;
      }

      if (mutation.type === 'attributes' && mutation.attributeName === 'aria-hidden') {
        pushUnique(
          activationTouched,
          mutation.activationWindow !== undefined
            ? mutation.activationWindow
            : mutation.targetWindow
        );
      }
    });

    return {
      contentTouched: contentTouched,
      activationTouched: activationTouched,
      removedWindows: removedWindows
    };
  }

  function selectCaptionWindowGeneration(previousActiveWindows, touchedWindows, currentWindows) {
    const previous = Array.isArray(previousActiveWindows) ? previousActiveWindows : [];
    const touched = Array.isArray(touchedWindows) ? touchedWindows : [];
    const current = Array.isArray(currentWindows) ? currentWindows : [];
    const currentSet = new Set(current);
    const uniqueCurrent = function (values) {
      return Array.from(new Set(values.filter(function (value) {
        return currentSet.has(value);
      })));
    };
    const touchedCurrent = uniqueCurrent(touched);
    return touchedCurrent.length ? touchedCurrent : uniqueCurrent(previous);
  }

  function isSeekRequestCurrent(state, requestId) {
    return Boolean(
      state &&
      state.active === true &&
      state.requestId === requestId
    );
  }

  function getSeekController(hasPlayerSeekTo) {
    return hasPlayerSeekTo === true ? 'player' : 'video';
  }

  function isStoryboardFrameCurrent(state, token, url) {
    return Boolean(
      state &&
      state.active === true &&
      state.hovering === true &&
      state.token === token &&
      typeof url === 'string' &&
      state.desiredUrl === url
    );
  }

  function canApplyStoryboardFrame(state, token, url) {
    return isStoryboardFrameCurrent(state, token, url) &&
      state.displayedUrl === url;
  }

  function getSafeCaptionUrl(rawUrl, allowedOrigin) {
    if (
      typeof rawUrl !== 'string' ||
      rawUrl.length === 0 ||
      rawUrl.length > 4096
    ) {
      return null;
    }

    let url;

    try {
      url = new URL(rawUrl, allowedOrigin || global.location.href);
    } catch (error) {
      return null;
    }

    const expectedOrigin = allowedOrigin || global.location.origin;
    if (
      url.protocol !== 'https:' ||
      url.origin !== expectedOrigin ||
      url.pathname !== '/api/timedtext' ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url;
  }

  function readSafeId(value, fallback) {
    const candidate = String(value || '').slice(0, 32);
    return candidate || String(fallback);
  }

  function normalizeCaptionTrack(track, allowedOrigin, fallbackId) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const baseUrl = getSafeCaptionUrl(track.baseUrl, allowedOrigin);
    if (!baseUrl) {
      return null;
    }

    const languageCode = normalizeLanguage(track.languageCode) || 'und';
    const label = readText(track.label || track.name) || languageCode || 'Captions';

    return {
      id: readSafeId(track.id, fallbackId),
      baseUrl: baseUrl.href,
      languageCode: languageCode,
      label: label,
      kind: typeof track.kind === 'string' ? track.kind.slice(0, 32) : ''
    };
  }

  function normalizeTranslationLanguages(languages) {
    return Array.isArray(languages)
      ? languages.slice(0, MAX_TRACKS).map(function (language) {
        if (!language || typeof language !== 'object') {
          return null;
        }

        const languageCode = normalizeLanguage(language.languageCode);
        if (!languageCode) {
          return null;
        }

        return {
          languageCode: languageCode,
          label: readText(language.label || language.languageName) || languageCode
        };
      }).filter(Boolean)
      : [];
  }

  function getSafeStoryboardTemplate(rawTemplate, videoId) {
    if (typeof rawTemplate !== 'string' || rawTemplate.length > MAX_STORYBOARD_SPEC_LENGTH) {
      return '';
    }

    const normalizedVideoId = normalizeVideoId(videoId);
    if (!normalizedVideoId) {
      return '';
    }
    const template = rawTemplate
      .replace(/\{video_id\}/gi, normalizedVideoId)
      .trim();

    if (!template || !template.includes('$L') || !template.includes('$N')) {
      return '';
    }

    try {
      const url = new URL(template);
      if (
        url.protocol !== 'https:' ||
        url.origin !== STORYBOARD_ORIGIN ||
        url.username ||
        url.password ||
        (normalizedVideoId && !url.pathname.includes(normalizedVideoId))
      ) {
        return '';
      }

      return url.href;
    } catch (error) {
      return '';
    }
  }

  function normalizeStoryboard(rawStoryboard, videoId, duration) {
    if (!rawStoryboard || typeof rawStoryboard !== 'object') {
      return null;
    }

    const normalizedVideoId = normalizeVideoId(videoId);
    let template = '';
    let rawFormats = [];
    let recommendedLevel = 0;

    if (typeof rawStoryboard.template === 'string' && Array.isArray(rawStoryboard.formats)) {
      template = getSafeStoryboardTemplate(rawStoryboard.template, normalizedVideoId);
      rawFormats = rawStoryboard.formats;
      recommendedLevel = Number(rawStoryboard.recommendedLevel);
    } else if (typeof rawStoryboard.spec === 'string') {
      const parts = rawStoryboard.spec.split('|');
      template = getSafeStoryboardTemplate(parts.shift(), normalizedVideoId);
      rawFormats = parts;
      recommendedLevel = Number(rawStoryboard.recommendedLevel);
    }

    if (!template || !rawFormats.length) {
      return null;
    }

    const normalizedDuration = normalizeDuration(
      duration || rawStoryboard.duration
    );
    const formats = rawFormats.slice(0, MAX_STORYBOARD_FORMATS).map(function (format, index) {
      if (typeof format !== 'string' && (!format || typeof format !== 'object')) {
        return null;
      }

      const parts = typeof format === 'string'
        ? format.split('#')
        : [format.width, format.height, format.count, format.columns,
          format.rows,
          Object.prototype.hasOwnProperty.call(format, 'sourceInterval')
            ? format.sourceInterval
            : Object.prototype.hasOwnProperty.call(format, 'interval')
              ? format.interval
              : format.intervalMs,
          format.name, format.signature];

      // YouTube currently emits exactly eight fields. The sixth field is
      // retained for diagnostics/compatibility only; it is not frame timing.
      if (parts.length !== 8) {
        return null;
      }

      const level = typeof format === 'object' && format !== null &&
        Number.isInteger(Number(format.level))
        ? Number(format.level)
        : index;
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      const count = Number(parts[2]);
      const columns = Number(parts[3]);
      const rows = Number(parts[4]);
      const sourceInterval = Number(parts[5]);

      if (
        !Number.isInteger(width) || width < 1 || width > MAX_STORYBOARD_DIMENSION ||
        !Number.isInteger(height) || height < 1 || height > MAX_STORYBOARD_DIMENSION ||
        !Number.isInteger(count) || count < 1 || count > MAX_STORYBOARD_COUNT ||
        !Number.isInteger(columns) || columns < 1 || columns > 100 ||
        !Number.isInteger(rows) || rows < 1 || rows > 100 ||
        !Number.isFinite(sourceInterval) || sourceInterval < 0 ||
        sourceInterval > MAX_STORYBOARD_INTERVAL_MS ||
        !String(parts[6] || '').trim()
      ) {
        return null;
      }

      const framesPerSprite = columns * rows;
      return {
        level: level,
        width: width,
        height: height,
        count: count,
        columns: columns,
        rows: rows,
        sourceInterval: sourceInterval,
        intervalMs: sourceInterval,
        framesPerSprite: framesPerSprite,
        spriteCount: Math.ceil(count / framesPerSprite),
        name: String(parts[6]).slice(0, 128),
        signature: String(parts[7] || '').slice(0, 512)
      };
    }).filter(Boolean);

    if (!formats.length) {
      return null;
    }

    const recommendedFormat = formats.find(function (format) {
      return format.level === recommendedLevel;
    }) || formats.reduce(function (best, format) {
      return !best || format.width * format.height > best.width * best.height
        ? format
        : best;
    }, null);

    return {
      template: template,
      formats: formats,
      recommendedLevel: recommendedFormat.level,
      duration: normalizedDuration
    };
  }

  function getStoryboardFrame(storyboard, seconds, duration) {
    if (!storyboard || !Array.isArray(storyboard.formats) || !storyboard.formats.length) {
      return null;
    }

    const format = storyboard.formats.find(function (candidate) {
      return candidate.level === storyboard.recommendedLevel;
    }) || storyboard.formats[0];
    const maxTime = normalizeDuration(duration) || normalizeDuration(storyboard.duration);
    if (!maxTime) {
      return null;
    }

    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const boundedSeconds = Math.min(safeSeconds, maxTime);
    const frameIndex = Math.min(
      format.count - 1,
      Math.max(0, Math.floor((boundedSeconds / maxTime) * format.count))
    );
    const framesPerSheet = format.framesPerSprite || format.columns * format.rows;
    const sheetIndex = Math.floor(frameIndex / framesPerSheet);
    const tileIndex = frameIndex % framesPerSheet;
    const rawUrl = storyboard.template
      .replace(/\$L/g, String(format.level))
      .replace(/\$N/g, String(format.name))
      .replace(/\$M/g, String(sheetIndex));

    let url;
    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== STORYBOARD_ORIGIN) {
        return null;
      }
      parsedUrl.searchParams.set('sigh', format.signature || '');
      url = parsedUrl.href;
    } catch (error) {
      return null;
    }

    return {
      url: url,
      x: (tileIndex % format.columns) * format.width,
      y: Math.floor(tileIndex / format.columns) * format.height,
      width: format.width,
      height: format.height,
      sheetWidth: format.width * format.columns,
      sheetHeight: format.height * format.rows,
      frameIndex: frameIndex,
      spriteIndex: sheetIndex,
      cellIndex: tileIndex,
      framesPerSprite: framesPerSheet,
      spriteCount: format.spriteCount || Math.ceil(format.count / framesPerSheet),
      seconds: boundedSeconds
    };
  }

  function getCaptionRenderer(response) {
    return response && response.captions &&
      response.captions.playerCaptionsTracklistRenderer
      ? response.captions.playerCaptionsTracklistRenderer
      : null;
  }

  function buildCaptionCatalog(response, allowedOrigin, videoId) {
    const renderer = getCaptionRenderer(response);
    const rawTracks = renderer && Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks.slice(0, MAX_TRACKS)
      : [];

    const tracks = rawTracks.map(function (track, index) {
      return normalizeCaptionTrack(Object.assign({}, track, { id: String(index) }), allowedOrigin, index);
    }).filter(Boolean);

    const translationLanguages = normalizeTranslationLanguages(
      renderer && renderer.translationLanguages
    );
    const responseVideoId = normalizeVideoId(
      videoId || response && response.videoDetails && response.videoDetails.videoId
    );
    const duration = normalizeDuration(
      response && response.videoDetails && response.videoDetails.lengthSeconds
    );
    const storyboardRenderer = response && response.storyboards &&
      response.storyboards.playerStoryboardSpecRenderer;

    return {
      available: tracks.length > 0,
      tracks: tracks,
      translationLanguages: translationLanguages,
      videoId: responseVideoId,
      duration: duration,
      storyboard: normalizeStoryboard(storyboardRenderer, responseVideoId, duration)
    };
  }

  function sanitizeCaptionCatalog(catalog, allowedOrigin, videoId) {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      return null;
    }

    const normalizedVideoId = normalizeVideoId(
      videoId || catalog.videoId
    );
    const tracks = Array.isArray(catalog.tracks)
      ? catalog.tracks.slice(0, MAX_TRACKS).map(function (track, index) {
        return normalizeCaptionTrack(track, allowedOrigin, index);
      }).filter(Boolean)
      : [];

    const translationLanguages = normalizeTranslationLanguages(catalog.translationLanguages);
    const duration = normalizeDuration(catalog.duration);
    const storyboard = normalizeStoryboard(catalog.storyboard, normalizedVideoId, duration);

    return {
      available: catalog.available === true || tracks.length > 0,
      tracks: tracks,
      translationLanguages: translationLanguages,
      videoId: normalizedVideoId,
      duration: duration,
      storyboard: storyboard
    };
  }

  function extractJsonObject(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const equalsIndex = text.indexOf('=', markerIndex + marker.length);
    const startIndex = text.indexOf('{', equalsIndex);
    if (equalsIndex < 0 || startIndex < 0) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(startIndex, index + 1));
          } catch (error) {
            return null;
          }
        }
      }
    }

    return null;
  }

  function parseJsonCaptionCues(text) {
    try {
      const normalizedText = text
        .replace(/^\uFEFF/, '')
        .replace(/^\)\]\}'\s*/, '');
      const data = JSON.parse(normalizedText);
      const events = Array.isArray(data.events)
        ? data.events.slice(0, MAX_CAPTION_CUES)
        : [];

      return events.map(function (event, index) {
        if (!event || typeof event !== 'object') {
          return null;
        }

        const start = Number(event.tStartMs) / 1000;
        const nextEvent = events[index + 1];
        const nextStart = nextEvent ? Number(nextEvent.tStartMs) / 1000 : 0;
        const duration = Number(event.dDurationMs) / 1000 ||
          (nextStart > start ? nextStart - start : 2);
        const textValue = Array.isArray(event.segs)
          ? event.segs.map(function (segment) {
            return segment && typeof segment.utf8 === 'string'
              ? segment.utf8
              : '';
          }).join('').slice(0, MAX_CUE_TEXT_LENGTH)
          : '';

        return {
          start: start,
          duration: duration,
          text: textValue
        };
      }).filter(function (cue) {
        return cue &&
          Number.isFinite(cue.start) &&
          cue.start >= 0 &&
          Number.isFinite(cue.duration) &&
          cue.duration > 0 &&
          cue.duration <= 86400 &&
          cue.text.trim();
      });
    } catch (error) {
      return [];
    }
  }

  function parseXmlCaptionCues(text) {
    if (typeof global.DOMParser !== 'function') {
      return [];
    }

    try {
      const documentRoot = new global.DOMParser().parseFromString(text, 'text/xml');
      return Array.from(documentRoot.querySelectorAll('text'))
        .slice(0, MAX_CAPTION_CUES)
        .map(function (node) {
          const start = Number(node.getAttribute('start'));
          const duration = Number(node.getAttribute('dur')) || 2;
          return {
            start: start,
            duration: duration,
            text: String(node.textContent || '').slice(0, MAX_CUE_TEXT_LENGTH)
          };
        }).filter(function (cue) {
          return Number.isFinite(cue.start) &&
            cue.start >= 0 &&
            Number.isFinite(cue.duration) &&
            cue.duration > 0 &&
            cue.duration <= 86400 &&
            cue.text.trim();
        });
    } catch (error) {
      return [];
    }
  }

  global.YTPMCaptionUtils = Object.freeze({
    MAX_CAPTION_CUES: MAX_CAPTION_CUES,
    MAX_CUE_TEXT_LENGTH: MAX_CUE_TEXT_LENGTH,
    VIDEO_ID_PATTERN: VIDEO_ID_PATTERN,
    normalizeVideoId: normalizeVideoId,
    normalizeLanguage: normalizeLanguage,
    normalizeDuration: normalizeDuration,
    normalizeCaptionLines: normalizeCaptionLines,
    getNormalizedCaptionLineList: getNormalizedCaptionLineList,
    isStrictCaptionLineSuperset: isStrictCaptionLineSuperset,
    getRollupCaptionTransitionPlan: getRollupCaptionTransitionPlan,
    isCaptionTransitionCurrent: isCaptionTransitionCurrent,
    getIncomingOnlyCaptionRenderPlan: getIncomingOnlyCaptionRenderPlan,
    isRollupCaptionRollback: isRollupCaptionRollback,
    deriveTrailingRollupSuccessor: deriveTrailingRollupSuccessor,
    isExactCaptionLineSequence: isExactCaptionLineSequence,
    isCaptionLineFragment: isCaptionLineFragment,
    normalizeCaptionState: normalizeCaptionState,
    resolveCaptionEnabledState: resolveCaptionEnabledState,
    getCaptionTogglePlan: getCaptionTogglePlan,
    isCaptionButtonPressed: isCaptionButtonPressed,
    clampSeekTime: clampSeekTime,
    getTimelinePointerPosition: getTimelinePointerPosition,
    getPointerSeekInputPlan: getPointerSeekInputPlan,
    shouldCommitSeekInteraction: shouldCommitSeekInteraction,
    isPlayerSynchronizedWithVideo: isPlayerSynchronizedWithVideo,
    getSeekDisplayTime: getSeekDisplayTime,
    isSeekWithinTolerance: isSeekWithinTolerance,
    isSeekNoOp: isSeekNoOp,
    getSeekCommitPlan: getSeekCommitPlan,
    isTimeBuffered: isTimeBuffered,
    getSeekConfirmationPlan: getSeekConfirmationPlan,
    intersectCaptionRects: intersectCaptionRects,
    getCaptionSegmentMirrorPlan: getCaptionSegmentMirrorPlan,
    getSeekExecutionPlan: getSeekExecutionPlan,
    getCaptionMutationOwnershipPlan: getCaptionMutationOwnershipPlan,
    selectCaptionWindowGeneration: selectCaptionWindowGeneration,
    isSeekRequestCurrent: isSeekRequestCurrent,
    getSeekController: getSeekController,
    isStoryboardFrameCurrent: isStoryboardFrameCurrent,
    canApplyStoryboardFrame: canApplyStoryboardFrame,
    getSafeCaptionUrl: getSafeCaptionUrl,
    buildCaptionCatalog: buildCaptionCatalog,
    extractJsonObject: extractJsonObject,
    parseJsonCaptionCues: parseJsonCaptionCues,
    parseXmlCaptionCues: parseXmlCaptionCues,
    normalizeCaptionTrack: normalizeCaptionTrack,
    sanitizeCaptionCatalog: sanitizeCaptionCatalog,
    getSafeStoryboardTemplate: getSafeStoryboardTemplate,
    normalizeStoryboard: normalizeStoryboard,
    getStoryboardFrame: getStoryboardFrame
  });
})(typeof globalThis === 'object' ? globalThis : self);
