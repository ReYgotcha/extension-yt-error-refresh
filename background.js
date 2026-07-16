"use strict";

// State lives in storage.session: it survives service-worker restarts (MV3 kills
// the worker aggressively) but clears on browser restart, which is exactly the
// "session" lifetime we want.
//
//   history         -> newest-first array of every video opened this session,
//                       each with a refresh count if YouTube's player choked on it
//   totalRefreshes  -> single shared counter, badged on every tab (not per tab —
//                       the badge answers "how much trouble this session", and
//                       that's the same answer no matter which tab you're on)

const HISTORY_KEY = "history";
const TOTAL_KEY = "totalRefreshes";
const HISTORY_MAX = 200;

const YOUTUBE_RE = /^https?:\/\/(www\.|m\.)?youtube\.com\//;

const ICONS = {
  color: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
  gray: { 16: "icons/icon16-gray.png", 32: "icons/icon32-gray.png", 48: "icons/icon48-gray.png", 128: "icons/icon128-gray.png" },
};

async function syncIcon(tabId, url) {
  if (tabId === undefined || tabId < 0) return;
  const path = url && YOUTUBE_RE.test(url) ? ICONS.color : ICONS.gray;
  try {
    await chrome.action.setIcon({ tabId, path });
  } catch {
    // Tab closed mid-update; nothing to paint.
  }
}

async function paintBadge(total) {
  // No tabId: this sets the *default* badge, shown on every tab that doesn't
  // have its own tab-specific override — which is all of them, since we never
  // set a per-tab badge. That's what makes the counter shared across tabs.
  await chrome.action.setBadgeText({ text: total ? String(total) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#CC0000" });
  await chrome.action.setTitle({
    title: total
      ? `YouTube Error Auto-Refresh — ${total} refresh${total === 1 ? "" : "es"} this session`
      : "YouTube Error Auto-Refresh",
  });
}

async function getHistory() {
  const stored = await chrome.storage.session.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

async function getTotal() {
  const stored = await chrome.storage.session.get(TOTAL_KEY);
  return Number(stored[TOTAL_KEY] || 0);
}

async function handleOpened(msg, tabId) {
  const history = await getHistory();
  history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    videoId: msg.videoId || null,
    title: msg.title || msg.url,
    url: msg.url,
    ts: Date.now(),
    attempts: 0,
    lastRefreshTs: null,
  });
  await chrome.storage.session.set({ [HISTORY_KEY]: history.slice(0, HISTORY_MAX) });
  await syncIcon(tabId, msg.url);
}

async function handleRefreshed(msg, tabId) {
  const history = await getHistory();
  // Newest-first, so the first match is the entry this reload continues.
  const entry = history.find((e) => e.videoId && e.videoId === msg.videoId);
  if (entry) {
    entry.attempts = msg.attempt;
    entry.lastRefreshTs = Date.now();
    if (msg.title) entry.title = msg.title;
  } else {
    // No matching "opened" entry (e.g. it aged out of the cap) — log it anyway.
    history.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      videoId: msg.videoId || null,
      title: msg.title || msg.url,
      url: msg.url,
      ts: Date.now(),
      attempts: msg.attempt,
      lastRefreshTs: Date.now(),
    });
  }
  await chrome.storage.session.set({ [HISTORY_KEY]: history.slice(0, HISTORY_MAX) });

  const total = (await getTotal()) + 1;
  await chrome.storage.session.set({ [TOTAL_KEY]: total });
  await paintBadge(total);
  await syncIcon(tabId, msg.url);
}

async function clearAll() {
  await chrome.storage.session.remove([HISTORY_KEY, TOTAL_KEY]);
  await paintBadge(0);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "clear") {
      await clearAll();
      sendResponse({ ok: true });
      return;
    }

    const tabId = sender.tab?.id;

    if (msg.type === "opened") {
      await handleOpened(msg, tabId);
      sendResponse({ ok: true });
    } else if (msg.type === "refreshed") {
      await handleRefreshed(msg, tabId);
      sendResponse({ ok: true });
    } else if (msg.type === "sync") {
      // A freshly created/navigated tab has no icon set yet — paint it so a
      // new YouTube tab isn't stuck on the gray default.
      await syncIcon(tabId, msg.url);
      sendResponse({ total: await getTotal() });
    }
  })();

  return true; // async sendResponse
});

// Keep every tab's icon honest as the user browses, including tabs the
// content script never touches (it only runs on youtube.com).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) syncIcon(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => syncIcon(tabId, tab.url)).catch(() => {});
});

async function syncAllOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => syncIcon(tab.id, tab.url)));
}

chrome.runtime.onInstalled.addListener(syncAllOpenTabs);
chrome.runtime.onStartup.addListener(syncAllOpenTabs);
