# YouTube Error Auto-Refresh

A small Chrome extension that reloads the page when the YouTube player dies with *"An error occurred. Please try again later. (Playback ID: …)"* — the failure mode you tend to hit when YouTube is throwing anti-adblock playback errors at ad-blocker users instead of showing an ad.

It was built for one reason: reloading by hand every time that error shows up gets old fast. This does it automatically, with limits so it can't turn into an infinite reload loop, and it keeps a quiet log of what it did so you can tell whether it's actually helping.

This is a personal-use tool, distributed unpacked rather than through the Chrome Web Store, under the MIT License (see [LICENSE](LICENSE)).

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder

## Features

- **Auto-refresh on playback error.** A content script watches for YouTube's `.ytp-error` overlay. When it appears and stays visible for 1.5s (to rule out a flicker), the page reloads via `location.replace()` — no history spam — and your playback position is preserved through a `t=` param.
- **Auto-refresh on a black player.** YouTube's other punishment is a player that just sits there black, with no error text to look for. That one's caught by behaviour instead: if the player is *trying* to play yet has decoded no frames — or its clock is frozen — for 12s straight, it gets the same treatment.
- **An overlay tells you why.** Before reloading, a full-page overlay says what went wrong and which attempt this is, so a page vanishing out from under you never looks like a random glitch.
- **Loop protection.** The failures can be persistent, so a naive reloader would spin forever. This one caps attempts, backs off, and gives up gracefully — see [Safety rails](#safety-rails).
- **Toolbar icon reflects the current tab.** Full color on a YouTube tab, grayscale everywhere else — a glance tells you whether the extension is even active on the page you're looking at.
- **A shared badge counter.** The number on the icon is how many refreshes have happened this browser session, across *every* YouTube tab combined — not per tab. Open five videos in five tabs and they all report into the same total.
- **A watch history in the popup.** Click the icon to see every video you've opened this session — thumbnail, title, how long ago — newest first, scrollable. Ones that needed a refresh are marked with a small **↻ N** pill showing how many attempts it took; hover it to see whether the cause was a playback error or a black screen.
- **Clear.** Wipes the history and resets the badge back to zero, in one click.

## How it works

[content.js](content.js) runs on every `youtube.com` page. It logs an "opened" event the moment a video actually starts (skipping over live reload attempts, which continue the same log entry instead of creating a new one), and watches for the error overlay in the background via a `MutationObserver` plus a 1s poll (YouTube can swap the overlay's visibility with pure CSS, which observers alone can miss).

[background.js](background.js) is the service worker: it owns the shared session state (`chrome.storage.session`, so it survives service-worker restarts but clears when Chrome restarts), paints the toolbar badge, and keeps every tab's icon in sync with whether that tab is currently on YouTube.

[popup.html](popup.html) / [popup.js](popup.js) / [popup.css](popup.css) render the history list, light/dark aware, from the same session storage.

## Safety rails

- **Max 5 attempts per video** (tracked in `sessionStorage`, per tab, per video). After that it stops and leaves the error on screen rather than looping forever.
- **Backoff** — attempt N waits 800ms × N before reloading.
- **1.5s confirmation** before acting on an error overlay, so a transient flicker doesn't trigger a reload.
- **12s confirmation** before acting on a black player, and only while it's genuinely trying to play. A paused video is left alone (that's your choice, not a failure), and a single healthy sample resets the timer — during real playback the clock advances ~60×/sec, so normal watching can't accumulate 12s of "stuck".
- **Attempt counter resets** once a video plays successfully for 5s, so an old failure doesn't count against a video that's now playing fine.
- **Black-player detection only runs on a visible tab.** Chrome deprioritizes video decode in background tabs, so a video opened with middle-click/cmd-click sits at 0 frames the whole time it's unfocused — indistinguishable from a real stuck player. Time spent hidden never counts toward the 12s, so switching to a background tab plays normally instead of immediately triggering a reload.

Tuning knobs live as constants at the top of [content.js](content.js) — `MAX_ATTEMPTS`, `BASE_DELAY_MS`, `CONFIRM_MS`, `STUCK_MS`, `HEALTHY_MS`, `OVERLAY_MIN_MS`.

The one deliberate trade-off: a genuine network stall lasting over `STUCK_MS` looks identical to a black player from the DOM's point of view, so on a bad connection it may reload a video that would have recovered on its own. Raise `STUCK_MS` if that bites.

## Icons

`assets/source/icon.png` (600×600, plus the layered `.psd`) is the source of truth. After editing it, regenerate every size Chrome actually loads — both the full-color and grayscale sets:

```
python3 make_icons.py
```

Needs Pillow (`pip install Pillow`). If you add a size, update `SIZES` in [make_icons.py](make_icons.py) *and* the `icons` / `action.default_icon` blocks in [manifest.json](manifest.json).

## Permissions

- `storage` — for the session history and counter.
- `tabs` — to read each tab's URL so the toolbar icon can tell YouTube tabs apart from everything else and color itself accordingly.

Neither is used to collect or transmit anything; both stay local to the browser.
