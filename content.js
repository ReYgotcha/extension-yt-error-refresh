(() => {
  "use strict";

  const CONFIRM_MS = 1500;      // error must stay on screen this long before we act
  const STUCK_MS = 12000;       // a black player trying to play this long counts as failed
  const MAX_ATTEMPTS = 5;       // per video, per tab session
  const BASE_DELAY_MS = 800;    // backoff: attempt N waits BASE * N
  const OVERLAY_MIN_MS = 1200;  // ...but always long enough to read the overlay
  const HEALTHY_MS = 5000;      // playback this long clears the attempt counter

  let errorSince = null;
  let stuckSince = null;
  let lastTime = -1;
  let reloading = false;
  let healthyTimer = null;
  let announcedVideoId = null;
  let lastHref = location.href;

  const videoId = () => {
    const v = new URLSearchParams(location.search).get("v");
    if (v) return v;
    const m = location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/);
    return m ? m[1] : null;
  };

  const videoKey = () => "yterr:" + (videoId() || location.pathname);

  const attempts = () => Number(sessionStorage.getItem(videoKey()) || 0);

  // Best available title, or null if the page hasn't caught up yet. On an SPA
  // navigation document.title still says the *previous* video for a moment, so
  // callers that care about accuracy retry until this returns something.
  // The metadata <h1> survives a player error, so it stays usable there too.
  function pageTitle() {
    const h1 = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, #title h1"
    );
    const fromDom = h1 && h1.textContent.trim();
    if (fromDom) return fromDom;

    // Fall back to document.title, minus YouTube's suffix and "(3) " unread prefix.
    const fromDoc = document.title
      .replace(/\s*-\s*YouTube\s*$/, "")
      .replace(/^\(\d+\)\s*/, "")
      .trim();
    return fromDoc && fromDoc !== "YouTube" ? fromDoc : null;
  }

  // YouTube renders this overlay only when playback actually fails.
  const errorShown = () => {
    const el = document.querySelector(".ytp-error");
    return !!el && el.offsetParent !== null;
  };

  // The main player, not a homepage hover-preview.
  const playerVideo = () =>
    document.querySelector("video.html5-main-video") || document.querySelector("video");

  const currentTime = () => {
    const v = playerVideo();
    return v && v.currentTime > 3 ? Math.floor(v.currentTime) : 0;
  };

  // The other failure mode: no .ytp-error overlay, just a black box that never
  // plays. Detected by behaviour instead of markup — the player is *trying* to
  // play (not paused, so this can't be autoplay-blocked or a user pause) yet has
  // decoded no frames, or its clock is frozen. Any healthy sample resets the
  // timer, and currentTime advances ~60x/sec during real playback, so normal
  // watching can never accumulate STUCK_MS.
  function playerStuck() {
    if (!videoId()) return false;
    const v = playerVideo();
    if (!v || v.paused) return false;

    const t = v.currentTime;
    const advancing = t !== lastTime;
    lastTime = t;

    return !(advancing && v.videoWidth > 0);
  }

  // Styles are inline so YouTube's stylesheets can't reach them, and the z-index
  // is the max so nothing (including the player) can sit on top.
  function showOverlay(headline, sub) {
    if (document.getElementById("yt-error-refresh-overlay")) return;

    const el = document.createElement("div");
    el.id = "yt-error-refresh-overlay";
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgba(0, 0, 0, 0.85)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "14px",
      padding: "24px",
      textAlign: "center",
      color: "#fff",
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      opacity: "0",
      transition: "opacity 150ms ease-out",
    });

    // Extension files need web_accessible_resources to be reachable from a page.
    // If that ever fails, skip the logo rather than render a broken image.
    let logoUrl = null;
    try {
      logoUrl = chrome.runtime.getURL("icons/icon128.png");
    } catch {}
    if (logoUrl) {
      const logo = document.createElement("img");
      logo.src = logoUrl;
      logo.alt = "";
      Object.assign(logo.style, { width: "56px", height: "56px", marginBottom: "2px" });
      el.append(logo);
    }

    const h = document.createElement("div");
    h.textContent = headline;
    Object.assign(h.style, { fontSize: "40px", fontWeight: "700", letterSpacing: "-0.02em" });

    const p = document.createElement("div");
    p.textContent = sub;
    Object.assign(p.style, { fontSize: "18px", fontWeight: "400", opacity: "0.75" });

    el.append(h, p);
    (document.body || document.documentElement).append(el);

    // Force a reflow so the browser has a frame at opacity 0 to transition from,
    // otherwise it batches both values into one paint and nothing fades.
    void el.offsetHeight;
    el.style.opacity = "1";
  }

  function tell(msg, done) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError; // worker asleep / context gone — not fatal
        if (done) done();
      });
    } catch {
      if (done) done(); // extension reloaded out from under us
    }
  }

  const REASON_COPY = {
    error: "Playback error detected",
    black: "Video didn’t load",
  };

  function reload(reason) {
    if (reloading) return;
    reloading = true;

    const n = attempts() + 1;
    sessionStorage.setItem(videoKey(), String(n));

    const url = new URL(location.href);
    const t = currentTime();
    if (t) url.searchParams.set("t", t + "s");
    // Cache-bust so we don't get handed the same failed response.
    url.searchParams.set("_r", String(Date.now()));

    console.info(`[yt-error-refresh] ${reason} detected, reloading (attempt ${n}/${MAX_ATTEMPTS})`);
    showOverlay(REASON_COPY[reason], "Refreshing…");

    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      // Back off, but never flash the overlay too briefly to read.
      const wait = Math.max(BASE_DELAY_MS * n, OVERLAY_MIN_MS);
      setTimeout(() => location.replace(url.toString()), wait);
    };

    // Log what we're leaving before we leave it — after the reload, the title
    // and the pre-refresh URL are gone.
    // Let the badge tick over before we navigate away, but never let a stuck
    // message handler block the reload.
    tell(
      {
        type: "refreshed",
        url: location.href,
        videoId: videoId(),
        title: pageTitle() || location.href,
        attempt: n,
        reason,
      },
      go
    );
    setTimeout(go, 500);
  }

  // Logs every video opened, not just ones that error, so the popup can show a
  // full history. Called from tick(), so a video whose title hasn't rendered yet
  // is simply retried on the next pass rather than logged under a stale title.
  function maybeAnnounceOpen() {
    const vid = videoId();
    if (!vid || vid === announcedVideoId) return;

    const title = pageTitle();
    if (!title) return; // not ready — try again next tick

    announcedVideoId = vid;
    // Mid-reload: an "opened" entry already exists from before the error, and
    // the "refreshed" message updates it in place.
    if (attempts() > 0) return;
    tell({ type: "opened", videoId: vid, title, url: location.href });
  }

  function tick() {
    if (reloading) return;

    // Watching location directly means SPA navigation is caught without relying
    // on YouTube's internal yt-navigate-finish event firing where we can see it.
    if (location.href !== lastHref) {
      lastHref = location.href;
      errorSince = null;
      watchHealth();
    }
    maybeAnnounceOpen();

    if (errorShown()) {
      stuckSince = null;
      if (errorSince === null) errorSince = Date.now();
      if (Date.now() - errorSince < CONFIRM_MS) return;
      if (attempts() >= MAX_ATTEMPTS) return; // give up rather than loop forever
      reload("error");
      return;
    }
    errorSince = null;

    if (playerStuck()) {
      if (stuckSince === null) stuckSince = Date.now();
      if (Date.now() - stuckSince < STUCK_MS) return;
      if (attempts() >= MAX_ATTEMPTS) return;
      reload("black");
      return;
    }
    stuckSince = null;
  }

  // Clear the counter once a video has actually played for a while.
  function watchHealth() {
    clearTimeout(healthyTimer);
    const v = playerVideo();
    if (!v) return;
    const onPlaying = () => {
      clearTimeout(healthyTimer);
      healthyTimer = setTimeout(() => sessionStorage.removeItem(videoKey()), HEALTHY_MS);
    };
    v.addEventListener("playing", onPlaying, { once: true });
  }

  // tick() drives everything: navigation detection, logging, and error handling.
  // The observer makes it near-instant on DOM churn; the interval covers pure
  // style/visibility flips the observer can miss, and retries a title that
  // hasn't rendered yet.
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);

  tell({ type: "sync", url: location.href }); // paint this tab's icon on load
  watchHealth();
  tick();
})();
