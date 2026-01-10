// static/js/app.js
// Home page controller: map + visited/planned + trips + hover tooltip summary + trip modal

// ============================================================
// CONFIG
// ============================================================
const GEOJSON_URL = "/static/data/countries.geojson";

/**
 * CARTO raster tiles (light basemap). Much more reliable than GL styles.
 */
const MAP_STYLE = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

const SRC_ID = "countries";
const VISITED_LAYER = "visited-fill";
const PLANNED_LAYER = "planned-fill";
const OUTLINE_LAYER = "country-outline";

// ============================================================
// STATE
// ============================================================
let state = { visited: [], planned: [], trips: [] };

let countriesIndex = [];
let visitedTS = null;
let plannedTS = null;
let map = null;

// modal
let modalTrip = null;

// ============================================================
// API HELPERS
// ============================================================
async function apiGet(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `POST ${url} failed: ${res.status}`);
  return data;
}

async function apiDelete(url) {
  const res = await fetch(url, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `DELETE ${url} failed: ${res.status}`);
  return data;
}

// ============================================================
// HELPERS
// ============================================================
function uniqSorted(arr) {
  return Array.from(new Set((arr || []).map(x => (x || "").toString().trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function effectivePlanned() {
  const visitedSet = new Set(state.visited);
  return (state.planned || []).filter(c => !visitedSet.has(c));
}

function toMs(isoStr) {
  if (!isoStr) return null;
  const t = Date.parse(isoStr);
  return Number.isFinite(t) ? t : null;
}

function sortTripsLatestFirst(trips) {
  return [...(trips || [])].sort((a, b) => {
    const aKey = toMs(a.end_date) ?? toMs(a.start_date) ?? toMs(a.created_at) ?? 0;
    const bKey = toMs(b.end_date) ?? toMs(b.start_date) ?? toMs(b.created_at) ?? 0;
    return bKey - aKey;
  });
}

function formatTripDates(t) {
  const s = t.start_date || "";
  const e = t.end_date || "";
  if (s && e) return `${s} → ${e}`;
  if (s) return s;
  if (e) return e;
  return "No dates";
}

function tripYear(t) {
  const d = t.end_date || t.start_date || t.created_at;
  const ms = d ? Date.parse(d) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getFullYear();
}

function getVisitedSummary(country) {
  const trips = (state.trips || []).filter(t => (t.country || "") === country);
  if (!trips.length) return null;

  const years = trips.map(tripYear).filter(y => y !== null);
  const uniqueYears = Array.from(new Set(years)).sort((a, b) => a - b);

  const times = trips.length;
  const timesText = times === 1 ? "1 time" : `${times} times`;
  const yearsText = uniqueYears.length ? ` (${uniqueYears.join(", ")})` : "";

  return `Visited ${timesText}${yearsText}`;
}

// ============================================================
// OPTIONAL MAP ERROR OVERLAY (non-fatal)
// ============================================================
function showMapError(message) {
  const host = document.querySelector(".main");
  if (!host) return;

  let el = document.getElementById("mapError");
  if (!el) {
    el = document.createElement("div");
    el.id = "mapError";
    el.className = "map-error";
    host.appendChild(el);
  }
  el.innerHTML = message;
}

function clearMapError() {
  const el = document.getElementById("mapError");
  if (el) el.remove();
}

async function verifyTilesReachable() {
  const testTile = "https://a.basemaps.cartocdn.com/light_all/1/1/1.png";
  try {
    const res = await fetch(testTile, { mode: "cors" });
    if (!res.ok) {
      showMapError(
        `Basemap tiles not reachable (HTTP ${res.status}).<br/>
         This is usually a network/adblock restriction.`
      );
      return false;
    }
    clearMapError();
    return true;
  } catch (err) {
    showMapError(
      `Basemap tiles request failed.<br/>
       Likely blocked network/adblock/DNS.<br/>
       Error: <span style="color:rgba(255,255,255,0.75)">${String(err)}</span>`
    );
    return false;
  }
}

// ============================================================
// GEOJSON LOADING
// ============================================================
function detectNameProperty(feature) {
  const props = feature?.properties || {};
  const candidates = ["ADMIN", "name", "NAME", "NAME_EN", "SOVEREIGNT", "formal_en"];
  for (const k of candidates) {
    if (typeof props[k] === "string" && props[k].trim().length > 0) return k;
  }
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" && v.trim().length > 0) return k;
  }
  return null;
}

async function loadCountries() {
  const res = await fetch(GEOJSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load GeoJSON: ${res.status}`);
  const geojson = await res.json();

  if (!geojson.features?.length) throw new Error("GeoJSON has no features.");

  const nameProp = detectNameProperty(geojson.features[0]);
  if (!nameProp) throw new Error("Could not detect a country name property in GeoJSON.");

  const normalized = {
    type: "FeatureCollection",
    features: geojson.features
      .filter(f => f && f.type === "Feature" && f.properties)
      .map(f => {
        const name = (f.properties[nameProp] || "").toString().trim();
        return { ...f, properties: { ...f.properties, ADMIN: name } };
      })
      .filter(f => f.properties.ADMIN && f.properties.ADMIN.length > 0),
  };

  countriesIndex = uniqSorted(normalized.features.map(f => f.properties.ADMIN))
    .map(name => ({ id: name, name }));

  return normalized;
}

// ============================================================
// DROPDOWNS (Tom Select)
// ============================================================
function initDropdowns() {
  const visitedSelect = document.getElementById("visitedSelect");
  const plannedSelect = document.getElementById("plannedSelect");
  if (!visitedSelect || !plannedSelect) return;

  // populate options
  for (const c of countriesIndex) {
    visitedSelect.appendChild(new Option(c.name, c.id));
    plannedSelect.appendChild(new Option(c.name, c.id));
  }

  visitedTS = new TomSelect("#visitedSelect", {
    plugins: ["remove_button", "clear_button"],
    persist: false,
    maxItems: null,
    create: false,
    sortField: { field: "text", direction: "asc" },
    onChange: async (values) => {
      state.visited = uniqSorted(values || []);
      applyMapFilters();
      updateSidebarLists();
      await persistState();
    },
  });

  plannedTS = new TomSelect("#plannedSelect", {
    plugins: ["remove_button", "clear_button"],
    persist: false,
    maxItems: null,
    create: false,
    sortField: { field: "text", direction: "asc" },
    onChange: async (values) => {
      state.planned = uniqSorted(values || []);
      applyMapFilters();
      updateSidebarLists();
      await persistState();
    },
  });
}

async function persistState() {
  await apiPost("/api/state", { visited: state.visited, planned: state.planned });
}

// ============================================================
// MAP FILTERS
// ============================================================
function applyMapFilters() {
  if (!map || !map.getSource(SRC_ID)) return;

  const visited = state.visited || [];
  const planned = effectivePlanned();

  map.setFilter(
    VISITED_LAYER,
    visited.length ? ["in", ["get", "ADMIN"], ["literal", visited]]
                  : ["==", ["get", "ADMIN"], "__none__"]
  );

  map.setFilter(
    PLANNED_LAYER,
    planned.length ? ["in", ["get", "ADMIN"], ["literal", planned]]
                  : ["==", ["get", "ADMIN"], "__none__"]
  );
}

// ============================================================
// SIDEBAR LISTS (optional UI)
// ============================================================
function renderSelectedList(listEl, values, onRemove) {
  if (!listEl) return;
  listEl.innerHTML = "";

  const v = values || [];
  if (!v.length) {
    const li = document.createElement("li");
    li.style.color = "rgba(255,255,255,0.45)";
    li.textContent = "None selected";
    listEl.appendChild(li);
    return;
  }

  for (const name of v) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = name;

    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await onRemove(name);
    });

    li.appendChild(span);
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function updateSidebarLists() {
  const visitedList = document.getElementById("visitedList");
  const plannedList = document.getElementById("plannedList");

  renderSelectedList(visitedList, state.visited, async (name) => {
    state.visited = (state.visited || []).filter(x => x !== name);
    if (visitedTS) visitedTS.removeItem(name, true);
    applyMapFilters();
    updateSidebarLists();
    await persistState();
  });

  renderSelectedList(plannedList, state.planned, async (name) => {
    state.planned = (state.planned || []).filter(x => x !== name);
    if (plannedTS) plannedTS.removeItem(name, true);
    applyMapFilters();
    updateSidebarLists();
    await persistState();
  });
}

// ============================================================
// TRIPS: LIST + MODAL + SAVE
// ============================================================
function openTripModal(trip) {
  modalTrip = trip;

  const modal = document.getElementById("tripModal");
  if (!modal) return;

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setText("modalTitle", trip.country || "Trip");
  setText("modalSubtitle", formatTripDates(trip));

  setText("modalCountry", trip.country || "—");
  setText("modalDates", formatTripDates(trip));

  const cities = (trip.cities || []).length ? (trip.cities || []).join(", ") : "—";
  const people = (trip.companions || []).length ? (trip.companions || []).join(", ") : "—";
  const notes = (trip.notes || "").trim() ? trip.notes : "—";

  setText("modalCities", cities);
  setText("modalPeople", people);

  const notesEl = document.getElementById("modalNotes");
  if (notesEl) notesEl.textContent = notes;

  const delBtn = document.getElementById("modalDeleteBtn");
  if (delBtn) {
    delBtn.onclick = async () => {
      try {
        await apiDelete(`/api/trips/${trip.id}`);
        closeTripModal();
        await refreshStateFromDb();
      } catch (e) {
        alert(String(e));
      }
    };
  }
}

function closeTripModal() {
  modalTrip = null;
  const modal = document.getElementById("tripModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function initModal() {
  const modal = document.getElementById("tripModal");
  if (!modal) return;

  document.getElementById("modalCloseBtn")?.addEventListener("click", closeTripModal);
  document.getElementById("modalOkBtn")?.addEventListener("click", closeTripModal);
  modal.querySelector(".modal-backdrop")?.addEventListener("click", closeTripModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTripModal();
  });
}

function renderTrips() {
  const tripList = document.getElementById("tripList");
  if (!tripList) return;

  tripList.innerHTML = "";

  const trips = sortTripsLatestFirst(state.trips || []);
  if (!trips.length) {
    const li = document.createElement("li");
    li.style.color = "rgba(255,255,255,0.45)";
    li.textContent = "No trips saved yet";
    tripList.appendChild(li);
    return;
  }

  for (const t of trips.slice(0, 50)) {
    const li = document.createElement("li");

    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.flexDirection = "column";
    left.style.gap = "2px";
    left.style.minWidth = "0";

    const title = document.createElement("div");
    title.style.fontWeight = "650";
    title.textContent = t.country || "Unknown country";

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.color = "rgba(255,255,255,0.65)";

    const dates = formatTripDates(t);
    const cities = (t.cities || []).slice(0, 3).join(", ");
    const people = (t.companions || []).slice(0, 2).join(", ");
    meta.textContent = `${dates}` + (cities ? ` • ${cities}` : "") + (people ? ` • with ${people}` : "");

    left.appendChild(title);
    left.appendChild(meta);

    const del = document.createElement("button");
    del.className = "remove";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        await apiDelete(`/api/trips/${t.id}`);
        await refreshStateFromDb();
      } catch (e) {
        alert(String(e));
      }
    });

    li.appendChild(left);
    li.appendChild(del);

    li.addEventListener("click", () => openTripModal(t));

    tripList.appendChild(li);
  }
}

async function refreshStateFromDb() {
  const data = await apiGet("/api/state");

  state.visited = uniqSorted(data.visited || []);
  state.planned = uniqSorted(data.planned || []);
  state.trips = data.trips || [];

  if (visitedTS) visitedTS.setValue(state.visited, true);
  if (plannedTS) plannedTS.setValue(state.planned, true);

  applyMapFilters();
  updateSidebarLists();
  renderTrips();
}

function initTripForm() {
  const btn = document.getElementById("addTripBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const country = (document.getElementById("tripCountry")?.value || "").trim();
    const start_date = document.getElementById("tripStart")?.value || null;
    const end_date = document.getElementById("tripEnd")?.value || null;

    const citiesRaw = (document.getElementById("tripCities")?.value || "").trim();
    const peopleRaw = (document.getElementById("tripPeople")?.value || "").trim();
    const notes = (document.getElementById("tripNotes")?.value || "").trim();

    const cities = citiesRaw ? citiesRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    const companions = peopleRaw ? peopleRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!country) {
      alert("Please enter a country (e.g. Spain).");
      return;
    }

    try {
      await apiPost("/api/trips", { country, start_date, end_date, cities, companions, notes });

      // clear most inputs
      const idsToClear = ["tripStart", "tripEnd", "tripCities", "tripPeople", "tripNotes"];
      for (const id of idsToClear) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }

      await refreshStateFromDb();
      alert("Trip saved.");
    } catch (e) {
      alert(String(e));
    }
  });
}

// ============================================================
// MAP INIT
// ============================================================
function initMap(geojson) {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  map = new maplibregl.Map({
    container: mapEl,
    style: MAP_STYLE,
    center: [0, 20],
    zoom: 1.25,
    minZoom: 1.0,
    maxZoom: 7.0,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  map.on("error", (e) => {
    console.error("MapLibre error:", e?.error || e);
  });

  // Resize safety net
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      try { map.resize(); } catch (_) {}
    }).observe(mapEl);
  }
  setTimeout(() => { try { map.resize(); } catch (_) {} }, 80);

  map.on("load", async () => {
    // Optional: show a helpful message if tiles are blocked
    await verifyTilesReachable();

    map.addSource(SRC_ID, { type: "geojson", data: geojson });

    map.addLayer({
      id: OUTLINE_LAYER,
      type: "line",
      source: SRC_ID,
      paint: { "line-color": "rgba(0,0,0,0.25)", "line-width": 0.6 },
    });

    map.addLayer({
      id: PLANNED_LAYER,
      type: "fill",
      source: SRC_ID,
      paint: {
        "fill-color": "rgba(47,123,255,0.45)",
        "fill-outline-color": "rgba(47,123,255,0.75)",
      },
      filter: ["==", ["get", "ADMIN"], "__none__"],
    });

    map.addLayer({
      id: VISITED_LAYER,
      type: "fill",
      source: SRC_ID,
      paint: {
        "fill-color": "rgba(255,59,59,0.45)",
        "fill-outline-color": "rgba(255,59,59,0.75)",
      },
      filter: ["==", ["get", "ADMIN"], "__none__"],
    });

    // Tooltip (country name + visited summary)
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

    map.on("mousemove", (e) => {
      const visitedHits = map.queryRenderedFeatures(e.point, { layers: [VISITED_LAYER] });
      const plannedHits = map.queryRenderedFeatures(e.point, { layers: [PLANNED_LAYER] });

      const isVisited = visitedHits.length > 0;
      const hit = visitedHits[0] || plannedHits[0];

      if (!hit) {
        map.getCanvas().style.cursor = "";
        popup.remove();
        return;
      }

      const country = hit?.properties?.ADMIN || "Unknown country";

      let subHtml = "";
      if (isVisited) {
        const summary = getVisitedSummary(country);
        if (summary) subHtml = `<div class="country-popup-sub">${summary}</div>`;
      }

      map.getCanvas().style.cursor = "pointer";
      popup
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="country-popup">
            <div class="country-popup-title">${country}</div>
            ${subHtml}
          </div>
        `)
        .addTo(map);
    });

    map.on("mouseout", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });

    applyMapFilters();
    setTimeout(() => { try { map.resize(); } catch (_) {} }, 120);
  });
}

// ============================================================
// OPTIONAL BUTTONS (if present in HTML)
// ============================================================
function initButtons() {
  const clearBtn = document.getElementById("clearBtn");
  const swapBtn = document.getElementById("swapBtn");

  clearBtn?.addEventListener("click", async () => {
    state.visited = [];
    state.planned = [];
    visitedTS?.clear(true);
    plannedTS?.clear(true);
    applyMapFilters();
    updateSidebarLists();
    await persistState();
  });

  swapBtn?.addEventListener("click", async () => {
    const tmp = state.visited;
    state.visited = state.planned;
    state.planned = tmp;

    visitedTS?.setValue(state.visited, true);
    plannedTS?.setValue(state.planned, true);

    applyMapFilters();
    updateSidebarLists();
    await persistState();
  });
}

// ============================================================
// BOOTSTRAP
// ============================================================
(async function main() {
  console.log("App starting…");
  console.log("MapLibre loaded?", !!window.maplibregl);

  const geojson = await loadCountries();

  initDropdowns();
  initButtons();
  initTripForm();
  initModal();
  initMap(geojson);

  await refreshStateFromDb();
})();
