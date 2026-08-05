(function () {
  'use strict';

  const MESSAGE_SOURCE = 'ytpm-page-bridge';
  const VIDEO_PLAYER_SELECTOR = [
    'ytd-video-preview[active] .html5-video-player',
    '#inline-preview-player',
    '.html5-video-player',
    'ytd-player'
  ].join(', ');

  function isRequest(data) {
    return data &&
      data.source === MESSAGE_SOURCE &&
      data.type === 'request' &&
      typeof data.id === 'string' &&
      typeof data.command === 'string';
  }

  function getVideoData(player) {
    if (!player || typeof player.getVideoData !== 'function') {
      return null;
    }

    try {
      const data = player.getVideoData();
      return data && typeof data === 'object' ? data : null;
    } catch (error) {
      return null;
    }
  }

  function getPlayerResponse(player) {
    const candidates = [];

    if (player) {
      ['getPlayerResponse', 'getPlayerResponseData'].some(function (methodName) {
        if (typeof player[methodName] !== 'function') {
          return false;
        }

        try {
          const response = player[methodName]();
          if (response) {
            candidates.push(response);
            return true;
          }
        } catch (error) {
          // Try the next available source.
        }
        return false;
      });
    }

    candidates.push(window.ytInitialPlayerResponse);
    if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      candidates.push(window.ytplayer.config.args.player_response);
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (typeof candidate === 'string') {
        try {
          return JSON.parse(candidate);
        } catch (error) {
          continue;
        }
      }

      if (typeof candidate === 'object') {
        return candidate;
      }
    }

    return null;
  }

  function readText(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    if (value.simpleText) {
      return value.simpleText;
    }

    if (Array.isArray(value.runs)) {
      return value.runs.map(function (run) {
        return run && run.text ? run.text : '';
      }).join('');
    }

    return '';
  }

  function getCaptionRenderer(response) {
    return response && response.captions &&
      response.captions.playerCaptionsTracklistRenderer
      ? response.captions.playerCaptionsTracklistRenderer
      : null;
  }

  function buildCaptionCatalog(response) {
    const renderer = getCaptionRenderer(response);
    const rawTracks = renderer && Array.isArray(renderer.captionTracks)
      ? renderer.captionTracks
      : [];
    const tracks = rawTracks.map(function (track, index) {
      return {
        id: String(index),
        baseUrl: track.baseUrl || '',
        languageCode: track.languageCode || 'und',
        label: readText(track.name) || track.languageCode || 'Captions',
        kind: track.kind || ''
      };
    }).filter(function (track) {
      return Boolean(track.baseUrl);
    });
    const translationLanguages = renderer && Array.isArray(renderer.translationLanguages)
      ? renderer.translationLanguages.map(function (language) {
        return {
          languageCode: language.languageCode || '',
          label: readText(language.languageName) || language.languageCode || ''
        };
      }).filter(function (language) {
        return Boolean(language.languageCode);
      })
      : [];

    return {
      available: tracks.length > 0,
      tracks: tracks,
      translationLanguages: translationLanguages
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

  async function fetchPlayerResponse(videoId) {
    if (!videoId || typeof fetch !== 'function') {
      return null;
    }

    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? window.setTimeout(function () {
        controller.abort();
      }, 4500) : 0;
      const response = await fetch(
        window.location.origin + '/watch?v=' + encodeURIComponent(videoId),
        {
          credentials: 'include',
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        }
      );
      if (timeout) {
        window.clearTimeout(timeout);
      }
      if (!response.ok) {
        return null;
      }

      const html = await response.text();
      return extractJsonObject(html, 'ytInitialPlayerResponse');
    } catch (error) {
      return null;
    }
  }

  async function getCaptionCatalog(videoId, player) {
    const normalizedVideoId = String(videoId || '').replace(/^(watch|shorts):/, '');
    let response = getPlayerResponse(player);
    if (response && normalizedVideoId && response.videoDetails &&
      response.videoDetails.videoId && response.videoDetails.videoId !== normalizedVideoId) {
      response = null;
    }
    let catalog = buildCaptionCatalog(response);
    if (catalog.available) {
      return catalog;
    }

    response = await fetchPlayerResponse(normalizedVideoId);
    catalog = buildCaptionCatalog(response);
    return catalog;
  }

  function parseJsonCaptionCues(text) {
    try {
      const normalizedText = text.replace(/^\uFEFF/, '').replace(/^\)\]\}'\s*/, '');
      const data = JSON.parse(normalizedText);
      if (!Array.isArray(data.events)) {
        return [];
      }

      return data.events.map(function (event, index) {
        const start = Number(event.tStartMs) / 1000;
        const nextEvent = data.events[index + 1];
        const nextStart = nextEvent ? Number(nextEvent.tStartMs) / 1000 : 0;
        const duration = Number(event.dDurationMs) / 1000 ||
          (nextStart > start ? nextStart - start : 2);
        const textValue = Array.isArray(event.segs)
          ? event.segs.map(function (segment) {
            return segment && segment.utf8 ? segment.utf8 : '';
          }).join('')
          : '';
        return { start: start, duration: duration, text: textValue };
      }).filter(function (cue) {
        return Number.isFinite(cue.start) && Number.isFinite(cue.duration) &&
          cue.duration > 0 && cue.text.trim();
      }).slice(0, 5000);
    } catch (error) {
      return [];
    }
  }

  function parseXmlCaptionCues(text) {
    if (typeof DOMParser !== 'function') {
      return [];
    }

    try {
      const documentRoot = new DOMParser().parseFromString(text, 'text/xml');
      return Array.from(documentRoot.querySelectorAll('text')).map(function (node) {
        const start = Number(node.getAttribute('start'));
        const duration = Number(node.getAttribute('dur')) || 2;
        return { start: start, duration: duration, text: node.textContent || '' };
      }).filter(function (cue) {
        return Number.isFinite(cue.start) && Number.isFinite(cue.duration) &&
          cue.duration > 0 && cue.text.trim();
      }).slice(0, 5000);
    } catch (error) {
      return [];
    }
  }

  async function fetchCaptionCues(videoId, trackId, targetLanguage, player) {
    const catalog = await getCaptionCatalog(videoId, player);
    const track = catalog.tracks.find(function (candidate) {
      return candidate.id === String(trackId);
    });
    if (!track || !track.baseUrl || typeof fetch !== 'function') {
      return { ok: false, cues: [] };
    }

    try {
      const captionUrl = new URL(track.baseUrl, window.location.href);
      captionUrl.searchParams.set('fmt', 'json3');
      if (targetLanguage && targetLanguage !== track.languageCode) {
        captionUrl.searchParams.set('tlang', targetLanguage);
      }

      const response = await fetch(captionUrl.href, {
        credentials: 'include',
        cache: 'no-store'
      });
      if (!response.ok) {
        return { ok: false, cues: [] };
      }

      const text = await response.text();
      const cues = parseJsonCaptionCues(text);
      const fallbackCues = cues.length ? cues : parseXmlCaptionCues(text);
      return {
        ok: fallbackCues.length > 0,
        cues: fallbackCues,
        track: {
          languageCode: targetLanguage || track.languageCode,
          label: track.label
        }
      };
    } catch (error) {
      return { ok: false, cues: [] };
    }
  }

  function getApiPlayer(candidate) {
    if (!candidate) {
      return null;
    }

    if (typeof candidate.getAvailableQualityLevels === 'function' ||
      typeof candidate.setPlaybackQuality === 'function' ||
      typeof candidate.setPlaybackQualityRange === 'function' ||
      typeof candidate.getOption === 'function' ||
      typeof candidate.setOption === 'function') {
      return candidate;
    }

    const nestedPlayer = candidate.querySelector &&
      candidate.querySelector('.html5-video-player');
    return nestedPlayer || null;
  }

  function getPlayerCandidates() {
    const seen = new Set();
    const candidates = [];

    document.querySelectorAll(VIDEO_PLAYER_SELECTOR).forEach(function (candidate) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    });

    return candidates;
  }

  function findPlayer(videoId) {
    const normalizedVideoId = String(videoId || '').replace(/^(watch|shorts):/, '');
    const candidates = getPlayerCandidates();

    if (normalizedVideoId) {
      const matchingCandidate = candidates.find(function (candidate) {
        const data = getVideoData(candidate) || getVideoData(getApiPlayer(candidate));
        return data && data.video_id === normalizedVideoId;
      });

      if (matchingCandidate) {
        return getApiPlayer(matchingCandidate);
      }
    }

    const activeCandidate = candidates.find(function (candidate) {
      return candidate.matches('ytd-video-preview[active] .html5-video-player') ||
        candidate.id === 'inline-preview-player' ||
        candidate.closest('ytd-video-preview[active]');
    });

    return getApiPlayer(activeCandidate || candidates[0]);
  }

  function getQualityInfo(player) {
    if (!player || typeof player.getAvailableQualityLevels !== 'function') {
      return { ok: false, levels: [], canSet: false, current: 'auto' };
    }

    let levels = [];
    let current = 'auto';

    try {
      const availableLevels = player.getAvailableQualityLevels();
      levels = Array.from(new Set(
        (Array.isArray(availableLevels) ? availableLevels : []).filter(Boolean)
      ));
    } catch (error) {
      levels = [];
    }

    try {
      if (typeof player.getPlaybackQuality === 'function') {
        current = player.getPlaybackQuality() || 'auto';
      }
    } catch (error) {
      current = 'auto';
    }

    const canSet = typeof player.setPlaybackQualityRange === 'function' ||
      typeof player.setPlaybackQuality === 'function';

    return {
      ok: Boolean(levels.length && canSet),
      levels: levels,
      canSet: canSet,
      current: current
    };
  }

  function setQuality(player, level) {
    if (!player) {
      return { ok: false };
    }

    const requestedLevel = level === 'auto' ? 'default' : level;
    let called = false;

    try {
      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(requestedLevel);
        called = true;
      }
    } catch (error) {
      // Some preview players expose only one of the two quality methods.
    }

    try {
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(requestedLevel);
        called = true;
      }
    } catch (error) {
      // Keep the successful method when the other one is unavailable.
    }

    const info = getQualityInfo(player);
    return {
      ok: called,
      levels: info.levels,
      current: info.current
    };
  }

  function getOption(player, moduleName, optionName) {
    if (!player || typeof player.getOption !== 'function') {
      return null;
    }

    try {
      return player.getOption(moduleName, optionName);
    } catch (error) {
      return null;
    }
  }

  function toArray(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value.length === 'number') {
      try {
        return Array.from(value);
      } catch (error) {
        return [];
      }
    }

    if (value && Array.isArray(value.tracks)) {
      return value.tracks;
    }

    return [];
  }

  function getCaptionTrackList(player) {
    let availableCaptionTracks = null;
    try {
      availableCaptionTracks = player && typeof player.getAvailableCaptionTracks === 'function'
        ? player.getAvailableCaptionTracks()
        : null;
    } catch (error) {
      availableCaptionTracks = null;
    }

    const candidates = [
      getOption(player, 'captions', 'tracklist'),
      getOption(player, 'captions', 'tracks'),
      availableCaptionTracks
    ];

    for (const candidate of candidates) {
      const tracks = toArray(candidate).filter(Boolean);
      if (tracks.length) {
        return tracks;
      }
    }

    return [];
  }

  function findCaptionControl(player) {
    if (!player || typeof player.querySelector !== 'function') {
      return null;
    }

    return player.querySelector(
      '.ytp-subtitles-button, ' +
      '.ytp-button[aria-label*="caption" i], ' +
      '.ytp-button[aria-label*="subtitle" i]'
    );
  }

  function findPlayerVideos(player) {
    const seen = new Set();
    const videos = [];

    if (player && typeof player.querySelectorAll === 'function') {
      player.querySelectorAll('video').forEach(function (video) {
        seen.add(video);
        videos.push(video);
      });
    }

    document.querySelectorAll('video.ytpm-overlay__video, ytd-video-preview[active] video')
      .forEach(function (video) {
        if (!seen.has(video)) {
          seen.add(video);
          videos.push(video);
        }
      });

    return videos;
  }

  function hasShowingTextTrack(player) {
    return findPlayerVideos(player).some(function (video) {
      return video.textTracks && Array.from(video.textTracks).some(function (track) {
        return (track.kind === 'captions' || track.kind === 'subtitles') &&
          track.mode === 'showing';
      });
    });
  }

  function hasTextTracks(player) {
    return findPlayerVideos(player).some(function (video) {
      return video.textTracks && Array.from(video.textTracks).some(function (track) {
        return track.kind === 'captions' || track.kind === 'subtitles';
      });
    });
  }

  function isCaptionControlEnabled(button) {
    if (!button) {
      return false;
    }

    if (button.getAttribute('aria-pressed') === 'true' ||
      button.classList.contains('ytp-button-active')) {
      return true;
    }

    const label = button.getAttribute('aria-label') || '';
    return /turn off|disable|hide/i.test(label);
  }

  function getCaptionInfo(player) {
    const button = findCaptionControl(player);
    const trackList = getCaptionTrackList(player);
    const selectedTrack = getOption(player, 'captions', 'track');
    const available = Boolean(
      button ||
      trackList.length ||
      hasTextTracks(player) ||
      selectedTrack ||
      (player && typeof player.setOption === 'function')
    );

    return {
      available: available,
      enabled: hasShowingTextTrack(player) ||
        isCaptionControlEnabled(button) ||
        Boolean(selectedTrack && (selectedTrack.languageCode || selectedTrack.vssId))
    };
  }

  function safeTrackValue(track) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const value = {};
    ['languageCode', 'vssId', 'kind', 'name'].forEach(function (property) {
      if (track[property]) {
        value[property] = track[property];
      }
    });
    return Object.keys(value).length ? value : null;
  }

  function toggleCaptions(player) {
    if (!player) {
      return { ok: false, available: false, enabled: false };
    }

    if (typeof player.setOption !== 'function') {
      const info = getCaptionInfo(player);
      return { ok: false, available: info.available, enabled: info.enabled };
    }

    const info = getCaptionInfo(player);
    let value = null;
    if (!info.enabled) {
      const selectedTrack = safeTrackValue(getOption(player, 'captions', 'track'));
      const firstTrack = getCaptionTrackList(player)[0];
      value = selectedTrack || safeTrackValue(firstTrack);
      if (!value) {
        return { ok: false, available: info.available, enabled: info.enabled };
      }
    }

    try {
      player.setOption('captions', 'track', value || {});
      const updated = getCaptionInfo(player);
      return { ok: true, available: updated.available, enabled: updated.enabled };
    } catch (error) {
      return { ok: false, available: info.available, enabled: info.enabled };
    }
  }

  function handleRequest(command, payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const player = findPlayer(data.videoId);

    if (command === 'quality-info') {
      return getQualityInfo(player);
    }

    if (command === 'set-quality') {
      return setQuality(player, data.level);
    }

    if (command === 'captions-info') {
      const info = getCaptionInfo(player);
      return { ok: info.available, available: info.available, enabled: info.enabled };
    }

    if (command === 'caption-tracks') {
      return getCaptionCatalog(data.videoId, player).then(function (catalog) {
        return {
          ok: catalog.available,
          available: catalog.available,
          tracks: catalog.tracks,
          translationLanguages: catalog.translationLanguages
        };
      });
    }

    if (command === 'fetch-captions') {
      return fetchCaptionCues(
        data.videoId,
        data.trackId,
        data.targetLanguage,
        player
      );
    }

    if (command === 'toggle-captions') {
      return toggleCaptions(player);
    }

    return { ok: false, error: 'Unknown command' };
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !isRequest(event.data)) {
      return;
    }

    Promise.resolve().then(function () {
      return handleRequest(event.data.command, event.data.payload);
    }).catch(function () {
      return { ok: false, error: 'Bridge operation failed' };
    }).then(function (result) {
      window.postMessage({
        source: MESSAGE_SOURCE,
        type: 'response',
        id: event.data.id,
        result: result
      }, '*');
    });
  });

  window.postMessage({ source: MESSAGE_SOURCE, type: 'ready' }, '*');
})();
