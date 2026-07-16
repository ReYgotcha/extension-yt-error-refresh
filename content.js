(() => {
  "use strict";

  const CONFIRM_MS = 1500;      // error must stay on screen this long before we act
  const MAX_ATTEMPTS = 5;       // per video, per tab session
  const BASE_DELAY_MS = 800;    // backoff: attempt N waits BASE * N
  const HEALTHY_MS = 5000;      // playback this long clears the attempt counter

  let errorSince = null;
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

  const currentTime = () => {
    const v = document.querySelector("video");
    return v && v.currentTime > 3 ? Math.floor(v.currentTime) : 0;
  };

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

  function reload() {
    if (reloading) return;
    reloading = true;

    const n = attempts() + 1;
    sessionStorage.setItem(videoKey(), String(n));

    const url = new URL(location.href);
    const t = currentTime();
    if (t) url.searchParams.set("t", t + "s");
    // Cache-bust so we don't get handed the same failed response.
    url.searchParams.set("_r", String(Date.now()));

    console.info(`[yt-error-refresh] error detected, reloading (attempt ${n}/${MAX_ATTEMPTS})`);

    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      setTimeout(() => location.replace(url.toString()), BASE_DELAY_MS * n);
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
      if (errorSince === null) errorSince = Date.now();
      if (Date.now() - errorSince < CONFIRM_MS) return;
      if (attempts() >= MAX_ATTEMPTS) return; // give up rather than loop forever
      reload();
      return;
    }

    errorSince = null;
  }

  // Clear the counter once a video has actually played for a while.
  function watchHealth() {
    clearTimeout(healthyTimer);
    const v = document.querySelector("video");
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
