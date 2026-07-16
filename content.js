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

  const videoId = () => {
    const v = new URLSearchParams(location.search).get("v");
    if (v) return v;
    const m = location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/);
    return m ? m[1] : null;
  };

  const videoKey = () => "yterr:" + (videoId() || location.pathname);

  const attempts = () => Number(sessionStorage.getItem(videoKey()) || 0);

  // document.title is the one title that's present even when the player itself
  // failed to render. Strip YouTube's suffix and its "(3) " unread-count prefix.
  const videoTitle = () =>
    document.title
      .replace(/\s*-\s*YouTube\s*$/, "")
      .replace(/^\(\d+\)\s*/, "")
      .trim() || location.href;

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
        title: videoTitle(),
        attempt: n,
      },
      go
    );
    setTimeout(go, 500);
  }

  // Logs every video actually opened (not just ones that error), so the popup
  // can show a full history. Skips videos we're mid-reload on — those already
  // have an "opened" entry from before the error, and reload() updates it.
  function maybeAnnounceOpen() {
    const vid = videoId();
    if (!vid || vid === announcedVideoId) return;
    announcedVideoId = vid;
    if (attempts() > 0) return;
    tell({ type: "opened", videoId: vid, title: videoTitle(), url: location.href });
  }

  function tick() {
    if (reloading) return;

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

  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000); // MutationObserver can miss pure style/visibility flips
  window.addEventListener("yt-navigate-finish", () => {
    errorSince = null;
    watchHealth();
    maybeAnnounceOpen();
  });

  tell({ type: "sync", url: location.href }); // paint this tab's icon on load
  watchHealth();
  maybeAnnounceOpen();
  tick();
})();
