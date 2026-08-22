# YouTube Preview Maximizer

**YouTube Preview Maximizer** is a lightweight, secure Google Chrome extension (Manifest V3) that enlarges active YouTube thumbnail previews into an in-page, custom overlay player with intuitive controls, closed captions (CC), storyboard hover previews, quality selection, keyboard shortcuts, robust ad lifecycle protections, and fail-safe cleanup — all without opening video watch pages or altering URLs.

---

## Key Features

- **Manifest V3 & Vanilla Stack**: Built with pure Vanilla JavaScript and CSS with zero external runtime npm dependencies.
- **Universal Surface Compatibility**: Seamlessly works on YouTube Home, Search Results, Subscriptions, Channel pages, and History.
- **Dynamic In-Page Overlay**: Transposes the active preview `<video>` element into a maximized custom overlay with YouTube-inspired SVG controls, a red interactive timeline bar, audio/mute controls, and fullscreen toggle.
- **Auto-Hiding Interface**: Controls and close button automatically fade out after 5 seconds of inactivity and reappear upon pointer movement.
- **Storyboard Timeline Previews**: Renders precise storyboard sprite preview thumbnails on timeline hover with bounded LRU caching.
- **Closed Captions (CC)**: Reads native live captions or fetches verified timed-text tracks, rendering real-time WebVTT cues with multiline roll-up support.
- **Quality Level Selection**: Synchronizes available quality levels directly with the Player API via an isolated page bridge, displaying an active checkmark indicator.
- **Ad Lifecycle Protection & Presentation Gate**:
  - **Fail-Closed Presentation Gate**: Keeps the visual player surface hidden until content media is confirmed ready.
  - **Pre-Presentation Fence**: Suppresses ad UI overlays, titles, gradients, badges, and banners with zero-frame leakage.
  - **Rapid Re-entry Preload Barrier**: Prevents stale arm-time media residue from driving premature ad progression across fast leave/re-enter cycles.
  - **Bounded Recovery**: One-shot recovery mechanism for post-ad transitions without endless retries.
- **Smart DOM & Memory Cleanup**: Automatically restores video elements, cleans up listeners, disconnects MutationObservers, and clears all timers upon closing or card invalidation.
- **Privacy & Security Focused**:
  - Permissions strictly scoped to `https://www.youtube.com/*`.
  - Nonce-based page bridge with allowlisted commands, strict schema validation, and origin verification.
  - No tracking, analytics, telemetry collection, or remote code execution.

---

## Keyboard Shortcuts

When the preview overlay is open:

| Key | Action |
| :--- | :--- |
| `Space` / `K` | Toggle Play / Pause |
| `←` / `→` | Seek backward / forward 5 seconds |
| `M` | Toggle Mute / Unmute |
| `C` | Toggle Closed Captions (CC) |
| `F` | Toggle Fullscreen |
| `Escape` | Close Preview Overlay |

---

## Local Installation

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the project directory containing `manifest.json`:
   ```text
   C:\xampp\htdocs\youtube-preview-maximizer
   ```
5. If the extension is already installed, click the **Reload** button on the extension card and refresh open YouTube tabs (`Ctrl + Shift + R`).

---

## Manual Verification

1. Navigate to `https://www.youtube.com/` (Home, Search, or History).
2. Hover over any video thumbnail until YouTube begins playing the inline preview.
3. Click the `⛶` button located at the top-right corner of the thumbnail.
4. Verify that the preview opens inside the maximized overlay without redirecting to the watch page.
5. Test playback controls: Play/Pause, Volume, Timeline scrub, Captions (CC), Quality menu, and Fullscreen.
6. Verify keyboard shortcuts (`Space`, `K`, `M`, `C`, `F`, `←`, `→`, `Escape`).
7. Close the overlay using `×`, `Escape`, or by clicking outside the video frame, and verify playback cleanly halts.

---

## Project Structure

```text
youtube-preview-maximizer/
├── manifest.json            # Manifest V3 extension configuration & permissions
├── background.js            # Service worker for verified timed-text fetching
├── content.js               # In-page card observation, overlay player, and lifecycle management
├── preview-ad-guard.js      # PresentationGate, AdUiGate, RapidReentryBarrier, and ad protection
├── page-bridge.js           # Isolated bridge to YouTube Player API for quality and caption tracks
├── caption-utils.js         # Caption formatting, WebVTT cue generation, and storyboard mapping
├── styles.css               # Overlay geometry, controls styling, and visual fence rules
├── icons/                   # Extension icons (16px, 32px, 48px, 128px)
├── tests/                   # Automated unit & integration test suites
└── lab/                     # Player response sanitizer & lab tests
```

---

## Automated Testing

Run the test suite from Windows PowerShell / Terminal:

```bash
# Run all unit and regression tests
npm test

# Run caption and storyboard tests
node --test tests/caption-utils.test.mjs

# Run lab player sanitizer tests
node --test lab/tests/*.test.mjs
```

---

## Security Model

- **Host Permissions**: Limited exclusively to `https://www.youtube.com/*`.
- **Content Security Policy (CSP)**: Fully compliant with Manifest V3 (`script-src 'self'`). No `eval`, inline scripts, or remote code execution.
- **Isolated Page Bridge**: `page-bridge.js` communicates with `content.js` through `window.postMessage` using extension-generated nonces, origin verification, and strict payload type checking.
- **Safe Timed-Text Endpoint**: Caption requests validate YouTube origin, enforce strict response size and timeout limits, and only parse valid `/api/timedtext` URLs.
