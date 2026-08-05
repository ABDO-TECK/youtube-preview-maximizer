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
    const template = rawTemplate
      .replace(/\{video_id\}/gi, normalizedVideoId)
      .trim();

    if (!template || !template.includes('$N')) {
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

  function normalizeStoryboard(rawStoryboard, videoId) {
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

    const formats = rawFormats.slice(0, MAX_STORYBOARD_FORMATS).map(function (format, index) {
      const parts = typeof format === 'string'
        ? format.split('#')
        : [format.width, format.height, format.count, format.columns,
          format.rows, format.intervalMs, format.name, format.signature];
      const level = typeof format === 'object' && format !== null &&
        Number.isInteger(Number(format.level))
        ? Number(format.level)
        : index;
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      const count = Number(parts[2]);
      const columns = Number(parts[3]);
      const rows = Number(parts[4]);
      const rawInterval = Number(parts[5]);
      const intervalMs = rawInterval >= 1000 ? rawInterval : rawInterval * 1000;

      if (
        !Number.isInteger(width) || width < 1 || width > MAX_STORYBOARD_DIMENSION ||
        !Number.isInteger(height) || height < 1 || height > MAX_STORYBOARD_DIMENSION ||
        !Number.isInteger(count) || count < 1 || count > MAX_STORYBOARD_COUNT ||
        !Number.isInteger(columns) || columns < 1 || columns > 100 ||
        !Number.isInteger(rows) || rows < 1 || rows > 100 ||
        !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_STORYBOARD_INTERVAL_MS
      ) {
        return null;
      }

      return {
        level: level,
        width: width,
        height: height,
        count: count,
        columns: columns,
        rows: rows,
        intervalMs: intervalMs,
        name: String(parts[6] || 'default').slice(0, 64),
        signature: String(parts[7] || '').slice(0, 256)
      };
    }).filter(Boolean);

    if (!formats.length) {
      return null;
    }

    const recommendedFormat = formats.find(function (format) {
      return format.level === recommendedLevel;
    }) || formats[0];

    return {
      template: template,
      formats: formats,
      recommendedLevel: recommendedFormat.level
    };
  }

  function getStoryboardFrame(storyboard, seconds, duration) {
    if (!storyboard || !Array.isArray(storyboard.formats) || !storyboard.formats.length) {
      return null;
    }

    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    const format = storyboard.formats.find(function (candidate) {
      return candidate.level === storyboard.recommendedLevel;
    }) || storyboard.formats[0];
    const maxTime = Number.isFinite(duration) && duration > 0 ? duration : safeSeconds;
    const boundedSeconds = Math.min(safeSeconds, maxTime);
    const frameIndex = Math.min(
      format.count - 1,
      Math.max(0, Math.floor((boundedSeconds * 1000) / format.intervalMs))
    );
    const framesPerSheet = format.columns * format.rows;
    const sheetIndex = Math.floor(frameIndex / framesPerSheet);
    const tileIndex = frameIndex % framesPerSheet;
    const queryValue = format.signature || format.name || 'default';
    const rawUrl = storyboard.template
      .replace(/\$L/g, String(format.level))
      .replace(/\$N/g, String(sheetIndex))
      .replace(/\$M/g, queryValue);

    let url;
    try {
      const parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== STORYBOARD_ORIGIN) {
        return null;
      }
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
      storyboard: normalizeStoryboard(storyboardRenderer, responseVideoId)
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
    const storyboard = normalizeStoryboard(catalog.storyboard, normalizedVideoId);
    const duration = normalizeDuration(catalog.duration);

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
    getSafeCaptionUrl: getSafeCaptionUrl,
    buildCaptionCatalog: buildCaptionCatalog,
    extractJsonObject: extractJsonObject,
    parseJsonCaptionCues: parseJsonCaptionCues,
    parseXmlCaptionCues: parseXmlCaptionCues,
    normalizeCaptionTrack: normalizeCaptionTrack,
    sanitizeCaptionCatalog: sanitizeCaptionCatalog,
    normalizeStoryboard: normalizeStoryboard,
    getStoryboardFrame: getStoryboardFrame
  });
})(typeof globalThis === 'object' ? globalThis : self);
