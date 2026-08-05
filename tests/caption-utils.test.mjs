import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../caption-utils.js', import.meta.url),
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

test('parses a YouTube storyboard spec and selects a bounded sprite tile', () => {
  const catalog = utils.buildCaptionCatalog({
    videoDetails: { videoId: 'dQw4w9WgXcQ' },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg|' +
          '160#90#100#10#10#10000#default#M0'
      }
    }
  }, 'https://www.youtube.com', 'dQw4w9WgXcQ');

  assert.equal(catalog.videoId, 'dQw4w9WgXcQ');
  assert.equal(catalog.storyboard.formats[0].intervalMs, 10000);
  const frame = utils.getStoryboardFrame(catalog.storyboard, 55, 1000);
  assert.equal(frame.url, 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L0/0.jpg');
  assert.equal(frame.x, 5 * 160);
  assert.equal(frame.y, 0);
});

test('preserves sparse storyboard levels when the recommended level skips an invalid format', () => {
  const catalog = utils.buildCaptionCatalog({
    videoDetails: { videoId: 'dQw4w9WgXcQ' },
    storyboards: {
      playerStoryboardSpecRenderer: {
        spec: 'https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg|' +
          '48#27#100#10#10#0#default#sig0|' +
          '80#45#108#10#10#2000#M$M#sig1|' +
          '160#90#108#5#5#2000#M$M#sig2|' +
          '320#180#108#3#3#2000#M$M#sig3',
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
    utils.getStoryboardFrame(catalog.storyboard, 60, 213).url.includes('/storyboard3_L3/'),
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
