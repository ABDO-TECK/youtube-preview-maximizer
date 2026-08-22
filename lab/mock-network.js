export const LAB_VIDEO_IDS = { clean: 'video-clean', preroll: 'video-preroll', multiple: 'video-multiple', malformed: 'video-malformed', delayed: 'video-delayed', reuse: 'video-reuse' };

function normalResponse(videoId) {
  return { videoDetails: { videoId, title: 'Mock ' + videoId }, streamingData: { formats: [{ itag: 18, mimeType: 'video/mp4' }] }, captions: { tracks: [{ languageCode: 'en' }] }, storyboards: { spec: 'mock://' + videoId }, playbackTracking: { videostatsPlaybackUrl: { baseUrl: 'mock://' + videoId } }, metadata: { adaptiveMode: true, advertisingPreferenceExample: 'keep-me' } };
}

export function createMockPlayerResponse(videoId, scenario = videoId) {
  const response = normalResponse(videoId);
  scenario = String(scenario).replace(/^video-/, '');
  if (scenario === 'preroll' || scenario === 'multiple') {
    response.adPlacements = [{ type: 'pre-roll' }];
    response.playerAds = [{ id: 'mock-pre' }];
    response.adSlots = [{ offset: 0 }];
    if (scenario === 'multiple') response.playerAds.push({ id: 'mock-mid' });
  } else if (scenario === 'nested') {
    response.adPlacements = [{ type: 'pre-roll' }];
    response.auxiliary = { playerAds: [{ id: 'mock-pre' }] };
    response.playbackContext = { adSlots: [{ offset: 0 }] };
  } else if (scenario === 'malformed') return { videoDetails: { videoId }, adPlacements: [] };
  return response;
}

export async function mockFetchPlayer(videoId, options = {}) {
  const scenario = String(options.scenario || videoId).replace(/^video-/, '');
  const delay = options.delayMs ?? (scenario === 'delayed' ? 20 : 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  return createMockPlayerResponse(videoId, scenario);
}
