"use strict";

const logEl = document.getElementById("log");
const emptyEl = document.getElementById("empty");
const summaryEl = document.getElementById("summary");
const clearEl = document.getElementById("clear");

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function entryNode(e) {
  const a = document.createElement("a");
  a.className = "entry";
  a.href = e.url;
  a.target = "_blank";
  a.rel = "noreferrer";

  const img = document.createElement("img");
  img.className = "thumb";
  img.alt = "";
  if (e.videoId) {
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(e.videoId)}/mqdefault.jpg`;
    img.addEventListener("error", () => { img.style.visibility = "hidden"; }, { once: true });
  } else {
    img.style.visibility = "hidden";
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";

  const title = document.createElement("div");
  title.className = "title";
  // textContent, not innerHTML: the title came off a web page.
  title.textContent = e.title;
  titleRow.append(title);

  if (e.attempts > 0) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = `↻ ${e.attempts}`;
    pill.title = `Needed ${e.attempts} refresh${e.attempts === 1 ? "" : "es"} to play`;
    titleRow.append(pill);
  }

  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = ago(e.lastRefreshTs || e.ts);

  meta.append(titleRow, sub);
  a.append(img, meta);
  return a;
}

async function render() {
  const { history = [] } = await chrome.storage.session.get("history");

  logEl.replaceChildren(...history.map(entryNode));
  emptyEl.classList.toggle("show", history.length === 0);
  clearEl.disabled = history.length === 0;

  const refreshed = history.filter((e) => e.attempts > 0).length;
  summaryEl.textContent = history.length
    ? `${history.length} video${history.length === 1 ? "" : "s"} · ${refreshed} needed a refresh`
    : "No videos yet";
}

clearEl.addEventListener("click", async () => {
  clearEl.disabled = true;
  await chrome.runtime.sendMessage({ type: "clear" });
  await render();
});

// Keep the popup live if something happens while it's open.
chrome.storage.session.onChanged.addListener((changes) => {
  if ("history" in changes) render();
});

render();
