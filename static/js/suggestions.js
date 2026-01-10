async function apiGetJson(url) {
  const res = await fetch(url, { cache: "no-store" });

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    throw new Error(
      `API did not return JSON (status ${res.status}). ` +
      `This usually means the route is missing or returning an HTML error page.\n` +
      `First 120 chars: ${text.slice(0, 120)}`
    );
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `GET ${url} failed (status ${res.status})`);
  }
  return data;
}

function scoreBadge(score) {
  const s = (typeof score === "number") ? score : 0;
  const pct = Math.max(0, Math.min(1, s));
  return `<span class="score-badge">${Math.round(pct * 100)}%</span>`;
}

function renderSuggestions(payload) {
  const status = document.getElementById("suggestionsStatus");
  const grid = document.getElementById("suggestionsGrid");

  grid.innerHTML = "";

  const suggestions = payload.suggestions || {};
  const countries = Object.keys(suggestions);

  if (!countries.length) {
    status.textContent = payload.note || "No suggestions yet. Add planned countries + a city catalog.";
    return;
  }

  status.textContent = `Suggestions for ${countries.length} planned countries`;

  for (const country of countries) {
    const card = document.createElement("div");
    card.className = "suggestion-card";

    const header = document.createElement("div");
    header.className = "suggestion-header";
    header.innerHTML = `<div class="suggestion-country">${country}</div>`;

    const list = document.createElement("div");
    list.className = "suggestion-list";

    const items = suggestions[country] || [];
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "suggestion-row";
      row.innerHTML = `
        <div class="suggestion-city">
          <div class="city-name">${item.city}</div>
          <div class="city-reason">${item.reason || ""}</div>
        </div>
        ${scoreBadge(item.score)}
      `;
      list.appendChild(row);
    }

    card.appendChild(header);
    card.appendChild(list);
    grid.appendChild(card);
  }
}

async function loadSuggestions() {
  const status = document.getElementById("suggestionsStatus");
  status.textContent = "Loading suggestions…";

  try {
    const data = await apiGetJson("/api/suggestions");
    renderSuggestions(data);
  } catch (e) {
    status.textContent = String(e);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("refreshSuggestions")?.addEventListener("click", loadSuggestions);
  loadSuggestions();
});
