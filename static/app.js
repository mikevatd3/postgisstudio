import { EditorView, basicSetup, sql, PostgreSQL, oneDark, keymap, vim, Prec } from "./vendor/codemirror-bundle.js";

// --- Constants ---
const COLORS = ['#a7c080', '#83c092', '#7fbbb3', '#dbbc7f', '#d699b6', '#e69875'];
const RAMP = [
  [127, 187, 179],  // --blue   #7fbbb3
  [131, 192, 146],  // --aqua   #83c092
  [219, 188, 127],  // --yellow #dbbc7f
  [230, 126, 128],  // --red    #e67e80
  [214, 153, 182],  // --purple #d699b6
];

let colorIndex = 0;
let layerCounter = 0;
const layers = [];
let selectedLayerId = null;

// --- CodeMirror Setup ---
const runKeymap = keymap.of([{
  key: "Ctrl-Enter",
  run: () => { runQuery(); return true; },
}, {
  key: "Mod-Enter",
  run: () => { runQuery(); return true; },
}]);

const editor = new EditorView({
  parent: document.getElementById("editor-container"),
  doc: "SELECT * FROM ",
  extensions: [
    vim(),
    Prec.high(runKeymap),
    basicSetup,
    sql({ dialect: PostgreSQL }),
    oneDark,
  ],
});

// Prevent Escape from blurring the editor. Must be a non-capture listener
// so it fires AFTER CodeMirror's own handler (CodeMirror skips key processing
// when defaultPrevented is already true, which would break vim).
editor.contentDOM.addEventListener("keydown", (e) => {
  if (e.key === "Escape") e.preventDefault();
});

// --- Leaflet Map ---
const map = L.map("map").setView([42.35, -83.1], 10);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

// --- UI Elements ---
const btnRun = document.getElementById("btn-run");
const btnAddLayer = document.getElementById("btn-add-layer");
const btnDraw = document.getElementById("btn-draw");
const btnSaveSession = document.getElementById("btn-save-session");
const sessionFileInput = document.getElementById("session-file-input");
const errorDisplay = document.getElementById("error-display");
const layerList = document.getElementById("layer-list");
const statusBar = document.getElementById("status-text");

// --- Draw Polygon State ---
const drawState = {
  active: false,
  vertices: [],
  markers: [],
  polyline: null,
  closingLine: null,
};

function enterDrawMode() {
  drawState.active = true;
  btnDraw.classList.add("active");
  map.getContainer().style.cursor = "crosshair";
  map.doubleClickZoom.disable();
  map.on("click", onDrawClick);
  map.on("dblclick", onDrawDoubleClick);
  map.on("mousemove", onDrawMouseMove);
  document.addEventListener("keydown", onDrawKeydown);
  setStatus("Draw: click to add vertices, click first vertex or double-click to close, Esc to cancel");
}

function exitDrawMode(insert) {
  if (insert && drawState.vertices.length >= 3) {
    insertPolygonSQL(drawState.vertices);
  }
  // Clean up map artifacts
  for (const m of drawState.markers) map.removeLayer(m);
  if (drawState.polyline) map.removeLayer(drawState.polyline);
  if (drawState.closingLine) map.removeLayer(drawState.closingLine);
  // Reset state
  drawState.active = false;
  drawState.vertices = [];
  drawState.markers = [];
  drawState.polyline = null;
  drawState.closingLine = null;
  // Unbind events
  map.off("click", onDrawClick);
  map.off("dblclick", onDrawDoubleClick);
  map.off("mousemove", onDrawMouseMove);
  document.removeEventListener("keydown", onDrawKeydown);
  // Restore UI
  map.doubleClickZoom.enable();
  map.getContainer().style.cursor = "";
  btnDraw.classList.remove("active");
  setStatus("Ready");
}

function onDrawClick(e) {
  // Close polygon if clicking near first vertex
  if (drawState.vertices.length >= 3) {
    const firstPx = map.latLngToContainerPoint(drawState.vertices[0]);
    const clickPx = map.latLngToContainerPoint(e.latlng);
    if (firstPx.distanceTo(clickPx) < 12) {
      exitDrawMode(true);
      return;
    }
  }
  drawState.vertices.push(e.latlng);
  const isFirst = drawState.vertices.length === 1;
  const marker = L.circleMarker(e.latlng, {
    radius: isFirst ? 7 : 5,
    color: "#e69875",
    fillColor: isFirst ? "#e69875" : "transparent",
    fillOpacity: 1,
    weight: 2,
  }).addTo(map);
  if (isFirst) {
    marker.bindTooltip("Click to close", {
      className: "draw-tooltip",
      direction: "top",
      offset: [0, -10],
    });
  }
  drawState.markers.push(marker);
  // Update connecting polyline
  if (drawState.polyline) {
    drawState.polyline.setLatLngs(drawState.vertices);
  } else if (drawState.vertices.length >= 2) {
    drawState.polyline = L.polyline(drawState.vertices, {
      color: "#e69875",
      weight: 2,
      dashArray: "6 4",
    }).addTo(map);
  }
}

function onDrawMouseMove(e) {
  if (drawState.vertices.length === 0) return;
  const last = drawState.vertices[drawState.vertices.length - 1];
  if (drawState.closingLine) {
    drawState.closingLine.setLatLngs([last, e.latlng]);
  } else {
    drawState.closingLine = L.polyline([last, e.latlng], {
      color: "#e69875",
      weight: 2,
      dashArray: "6 4",
      opacity: 0.5,
    }).addTo(map);
  }
}

function onDrawDoubleClick(e) {
  if (drawState.vertices.length < 3) return;
  // dblclick fires two clicks first — deduplicate last vertex
  if (drawState.vertices.length >= 2) {
    const last = drawState.vertices[drawState.vertices.length - 1];
    const prev = drawState.vertices[drawState.vertices.length - 2];
    const lastPx = map.latLngToContainerPoint(last);
    const prevPx = map.latLngToContainerPoint(prev);
    if (lastPx.distanceTo(prevPx) < 5) {
      drawState.vertices.pop();
      const m = drawState.markers.pop();
      if (m) map.removeLayer(m);
      if (drawState.polyline) drawState.polyline.setLatLngs(drawState.vertices);
    }
  }
  if (drawState.vertices.length >= 3) {
    exitDrawMode(true);
  }
}

function onDrawKeydown(e) {
  if (!drawState.active) return;
  if (e.key === "Escape") {
    e.preventDefault();
    exitDrawMode(false);
  } else if (e.key === "Backspace") {
    e.preventDefault();
    if (drawState.vertices.length > 0) {
      drawState.vertices.pop();
      const m = drawState.markers.pop();
      if (m) map.removeLayer(m);
      if (drawState.polyline) {
        if (drawState.vertices.length >= 2) {
          drawState.polyline.setLatLngs(drawState.vertices);
        } else {
          map.removeLayer(drawState.polyline);
          drawState.polyline = null;
        }
      }
      if (drawState.closingLine) {
        if (drawState.vertices.length > 0) {
          drawState.closingLine.setLatLngs([
            drawState.vertices[drawState.vertices.length - 1],
            drawState.closingLine.getLatLngs()[1],
          ]);
        } else {
          map.removeLayer(drawState.closingLine);
          drawState.closingLine = null;
        }
      }
    }
  }
}

function generatePolygonSQL(vertices) {
  const coords = [...vertices, vertices[0]]
    .map(ll => `${ll.lng.toFixed(6)} ${ll.lat.toFixed(6)}`)
    .join(", ");
  return `ST_GeomFromText('POLYGON((${coords}))', 4326)`;
}

function insertPolygonSQL(vertices) {
  const sqlText = generatePolygonSQL(vertices);
  const cursor = editor.state.selection.main.head;
  editor.dispatch({ changes: { from: cursor, insert: sqlText } });
  editor.focus();
}

// --- Event Listeners ---
btnRun.addEventListener("click", runQuery);
btnAddLayer.addEventListener("click", addLayer);
btnDraw.addEventListener("click", () => {
  if (drawState.active) {
    exitDrawMode(false);
  } else {
    enterDrawMode();
  }
});
const btnExportGpkg = document.getElementById("btn-export-gpkg");

const collapseToggle = document.getElementById("collapse-toggle");
const sidebar = document.getElementById("sidebar");
const appContainer = document.getElementById("app");

collapseToggle.addEventListener("click", () => {
  const collapsing = !sidebar.classList.contains("collapsed");
  sidebar.classList.toggle("collapsed");
  if (collapsing) {
    // Move toggle out of sidebar so it stays visible
    appContainer.appendChild(collapseToggle);
    collapseToggle.classList.add("floating");
  } else {
    // Move toggle back into sidebar header
    collapseToggle.classList.remove("floating");
    sidebar.querySelector("header").appendChild(collapseToggle);
  }
  setTimeout(() => map.invalidateSize(), 250);
});

btnSaveSession.addEventListener("click", (e) => { e.preventDefault(); saveSession(); });
btnExportGpkg.addEventListener("click", (e) => { e.preventDefault(); exportGpkg(); });
sessionFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadSession(file);
  sessionFileInput.value = "";
});

// Drag and drop
let dropOverlay = null;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (draggedLayerId) return;
  if (!dropOverlay) {
    dropOverlay = document.createElement("div");
    dropOverlay.id = "drop-overlay";
    dropOverlay.innerHTML = "<span>Drop .json file</span>";
    document.body.appendChild(dropOverlay);
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null && dropOverlay) {
    dropOverlay.remove();
    dropOverlay = null;
  }
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (dropOverlay) {
    dropOverlay.remove();
    dropOverlay = null;
  }
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith(".json")) {
    loadSession(file);
  }
});

// --- Layer drag-and-drop reordering ---
let draggedLayerId = null;
let dragFromHandle = false;

layerList.addEventListener("pointerdown", (e) => {
  dragFromHandle = !!e.target.closest(".layer-drag-handle");
});

layerList.addEventListener("dragstart", (e) => {
  if (!dragFromHandle) { e.preventDefault(); return; }
  const li = e.target.closest("li");
  draggedLayerId = li.dataset.layerId;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("application/x-layer-drag", draggedLayerId);
  requestAnimationFrame(() => li.classList.add("dragging"));
});

layerList.addEventListener("dragover", (e) => {
  if (!draggedLayerId) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest("#layer-list li");
  if (!li) return;
  const rect = li.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  li.classList.toggle("drag-over-above", e.clientY < midY);
  li.classList.toggle("drag-over-below", e.clientY >= midY);
});

layerList.addEventListener("dragenter", (e) => {
  if (!draggedLayerId) return;
  e.preventDefault();
  e.stopPropagation();
});

layerList.addEventListener("dragleave", (e) => {
  const li = e.target.closest("#layer-list li");
  if (li) {
    li.classList.remove("drag-over-above", "drag-over-below");
  }
});

layerList.addEventListener("drop", (e) => {
  if (!draggedLayerId) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest("#layer-list li");
  if (!li) return;
  const targetId = li.dataset.layerId;
  if (targetId === draggedLayerId) return;
  const fromIdx = layers.findIndex(l => l.id === draggedLayerId);
  const [moved] = layers.splice(fromIdx, 1);
  let toIdx = layers.findIndex(l => l.id === targetId);
  const rect = li.getBoundingClientRect();
  if (e.clientY >= rect.top + rect.height / 2) toIdx++;
  layers.splice(toIdx, 0, moved);
  renderLayerList();
  syncLayerZOrder();
});

layerList.addEventListener("dragend", () => {
  draggedLayerId = null;
  for (const li of layerList.querySelectorAll("li")) {
    li.classList.remove("dragging", "drag-over-above", "drag-over-below");
  }
});

// --- Functions ---
function getSQL() {
  return editor.state.doc.toString().trim();
}

function showError(msg) {
  errorDisplay.textContent = msg;
  errorDisplay.hidden = false;
}

function hideError() {
  errorDisplay.hidden = true;
  errorDisplay.textContent = "";
}

function setStatus(msg) {
  statusBar.textContent = msg;
}

function nextColor() {
  const c = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return c;
}

function lerpColor(t) {
  t = Math.max(0, Math.min(1, t));
  const seg = (RAMP.length - 1) * t;
  const i = Math.min(Math.floor(seg), RAMP.length - 2);
  const s = seg - i;
  const a = RAMP[i], b = RAMP[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * s);
  const g = Math.round(a[1] + (b[1] - a[1]) * s);
  const bl = Math.round(a[2] + (b[2] - a[2]) * s);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

function featureColor(feature, layerObj) {
  if (!layerObj.symbologyMeta) return layerObj.color;
  const val = feature.properties?.[layerObj.symbologyColumn];
  if (val == null) return '#555555';
  const meta = layerObj.symbologyMeta;
  if (meta.type === 'numeric') {
    if (meta.max === meta.min) return lerpColor(0.5);
    return lerpColor((val - meta.min) / (meta.max - meta.min));
  }
  return meta.colorMap.get(String(val)) ?? '#555555';
}

function computeSymbology(layer) {
  if (!layer.symbologyColumn || !layer.geojsonData?.features?.length) {
    layer.symbologyMeta = null;
    return;
  }
  const col = layer.symbologyColumn;
  const vals = layer.geojsonData.features
    .map(f => f.properties?.[col])
    .filter(v => v != null);
  if (vals.length === 0) { layer.symbologyMeta = null; return; }
  if (vals.every(v => typeof v === 'number')) {
    layer.symbologyMeta = { type: 'numeric', min: Math.min(...vals), max: Math.max(...vals) };
  } else {
    const unique = [...new Set(vals.map(String))];
    const colorMap = new Map();
    unique.forEach((v, i) => colorMap.set(v, COLORS[i % COLORS.length]));
    layer.symbologyMeta = { type: 'categorical', colorMap };
  }
}

function rebuildLayerStyle(layer) {
  const wasVisible = layer.visible && map.hasLayer(layer.leafletLayer);
  map.removeLayer(layer.leafletLayer);
  computeSymbology(layer);
  layer.leafletLayer = makeLeafletLayer(layer.geojsonData, layer);
  if (wasVisible) {
    layer.leafletLayer.addTo(map);
    syncLayerZOrder();
  }
}

function selectLayer(id) {
  const layer = layers.find(l => l.id === id);
  if (!layer) return;
  selectedLayerId = id;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: layer.sql },
  });
  renderLayerList();
}

function deselectLayer() {
  selectedLayerId = null;
  renderLayerList();
}

function makeLeafletLayer(geojsonData, layerObj) {
  return L.geoJSON(geojsonData, {
    style: (feature) => {
      const c = featureColor(feature, layerObj);
      return { color: c, weight: 2, fillColor: c, fillOpacity: layerObj.symbologyMeta ? 0.5 : 0.15 };
    },
    pointToLayer: (feature, latlng) => {
      const c = featureColor(feature, layerObj);
      return L.circleMarker(latlng, {
        radius: 6, color: c, fillColor: c, fillOpacity: layerObj.symbologyMeta ? 0.7 : 0.5, weight: 2,
      });
    },
    onEachFeature: (feature, layer) => {
      if (feature.properties && Object.keys(feature.properties).length > 0) {
        const rows = Object.entries(feature.properties)
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v ?? ""))}</td></tr>`)
          .join("");
        layer.bindPopup(`<table>${rows}</table>`, { maxWidth: 400 });
      }
    },
  });
}

function updateLayerData(layerObj, sqlText, geojson) {
  map.removeLayer(layerObj.leafletLayer);
  layerObj.sql = sqlText;
  layerObj.geojsonData = { type: "FeatureCollection", features: geojson.features };
  computeSymbology(layerObj);
  layerObj.leafletLayer = makeLeafletLayer(geojson, layerObj).addTo(map);
  renderLayerList();
  const bounds = layerObj.leafletLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
  syncLayerZOrder();
}

async function runQuery() {
  const sqlText = getSQL();
  if (!sqlText) return;

  hideError();
  setStatus("Running query...");
  btnRun.disabled = true;

  try {
    const resp = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: sqlText }),
    });
    const data = await resp.json();

    if (data.error) {
      showError(data.error);
      setStatus("Error");
      return;
    }

    setStatus(`${data.row_count} row${data.row_count !== 1 ? "s" : ""} returned`);

    if (data.has_geometry && data.features.length > 0) {
      const selected = selectedLayerId && layers.find(l => l.id === selectedLayerId);
      if (selected) {
        updateLayerData(selected, sqlText, data);
      } else {
        addLayerFromData(sqlText, data);
      }
    } else if (!data.has_geometry && data.row_count > 0) {
      setStatus(`${data.row_count} row${data.row_count !== 1 ? "s" : ""} returned (no geometry column)`);
    }
  } catch (err) {
    showError(err.message);
    setStatus("Error");
  } finally {
    btnRun.disabled = false;
  }
}

function addLayer() {
  selectedLayerId = null;
  renderLayerList();
}

function addLayerFromData(sqlText, geojson) {
  layerCounter++;
  const color = nextColor();
  const id = `layer-${layerCounter}`;
  const name = `Layer ${layerCounter}`;
  const geojsonData = { type: "FeatureCollection", features: geojson.features };

  const layerObj = {
    id, name, sql: sqlText, color, visible: true,
    leafletLayer: null, geojsonData,
    symbologyColumn: null, symbologyMeta: null,
  };
  computeSymbology(layerObj);
  const leafletLayer = makeLeafletLayer(geojsonData, layerObj).addTo(map);
  layerObj.leafletLayer = leafletLayer;
  layers.push(layerObj);
  selectedLayerId = id;
  renderLayerList();

  // Fit map to new layer bounds
  const bounds = leafletLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
  syncLayerZOrder();
}

function renderLayerList() {
  layerList.innerHTML = "";
  for (const layer of layers) {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.layerId = layer.id;
    if (layer.id === selectedLayerId) li.classList.add("selected");

    const swatch = document.createElement("span");
    swatch.className = "layer-color";
    swatch.style.background = layer.color;

    const nameSpan = document.createElement("span");
    nameSpan.className = "layer-name";
    nameSpan.textContent = layer.name;
    nameSpan.title = layer.sql;

    // Single-click: toggle selection (delayed to allow dblclick)
    let clickTimer = null;
    nameSpan.addEventListener("click", () => {
      if (nameSpan.isContentEditable) return;
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (selectedLayerId !== layer.id) {
          selectLayer(layer.id);
        }
      }, 250);
    });

    // Double-click: inline rename
    nameSpan.addEventListener("dblclick", (e) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      e.stopPropagation();
      const original = layer.name;
      nameSpan.contentEditable = "true";
      nameSpan.classList.add("editing");
      nameSpan.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(nameSpan);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const commit = () => {
        nameSpan.contentEditable = "false";
        nameSpan.classList.remove("editing");
        const newName = nameSpan.textContent.trim();
        layer.name = newName || original;
        nameSpan.textContent = layer.name;
      };
      const revert = () => {
        nameSpan.contentEditable = "false";
        nameSpan.classList.remove("editing");
        nameSpan.textContent = original;
      };

      nameSpan.addEventListener("keydown", function onKey(ke) {
        if (ke.key === "Enter") {
          ke.preventDefault();
          nameSpan.removeEventListener("keydown", onKey);
          nameSpan.removeEventListener("blur", onBlur);
          commit();
        } else if (ke.key === "Escape") {
          ke.preventDefault();
          nameSpan.removeEventListener("keydown", onKey);
          nameSpan.removeEventListener("blur", onBlur);
          revert();
        }
      });
      function onBlur() {
        nameSpan.removeEventListener("blur", onBlur);
        commit();
      }
      nameSpan.addEventListener("blur", onBlur);
    });

    const symbSelect = document.createElement("select");
    symbSelect.className = "layer-symbology";
    symbSelect.title = "Color by column";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "color";
    symbSelect.appendChild(noneOpt);
    const props = layer.geojsonData?.features?.[0]?.properties;
    if (props) {
      for (const key of Object.keys(props)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = key;
        if (key === layer.symbologyColumn) opt.selected = true;
        symbSelect.appendChild(opt);
      }
    }
    symbSelect.addEventListener("click", (e) => e.stopPropagation());
    symbSelect.addEventListener("change", (e) => {
      e.stopPropagation();
      layer.symbologyColumn = symbSelect.value || null;
      rebuildLayerStyle(layer);
      renderLayerList();
    });

    const toggle = document.createElement("span");
    toggle.className = `layer-toggle ${layer.visible ? "visible" : ""}`;
    toggle.textContent = layer.visible ? "\u25C9" : "\u25CB";
    toggle.title = layer.visible ? "Hide layer" : "Show layer";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      if (layer.visible) {
        map.addLayer(layer.leafletLayer);
        syncLayerZOrder();
      } else {
        map.removeLayer(layer.leafletLayer);
      }
      renderLayerList();
    });

    const save = document.createElement("span");
    save.className = "layer-save";
    save.textContent = "\u2913";
    save.title = "Save GeoJSON";
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      const filename = prompt("Save as:", "export.geojson");
      if (!filename) return;
      const blob = new Blob([JSON.stringify(layer.geojsonData, null, 2)], { type: "application/geo+json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.endsWith(".geojson") ? filename : filename + ".geojson";
      a.click();
      URL.revokeObjectURL(url);
    });

    const remove = document.createElement("span");
    remove.className = "layer-remove";
    remove.textContent = "\u2715";
    remove.title = "Remove layer";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      map.removeLayer(layer.leafletLayer);
      if (selectedLayerId === layer.id) selectedLayerId = null;
      const idx = layers.indexOf(layer);
      if (idx !== -1) layers.splice(idx, 1);
      renderLayerList();
    });

    const dragHandle = document.createElement("span");
    dragHandle.className = "layer-drag-handle";
    dragHandle.textContent = "\u2807";

    li.append(dragHandle, swatch, nameSpan, symbSelect, toggle, save, remove);
    layerList.appendChild(li);
  }
}

function syncLayerZOrder() {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].visible && layers[i].leafletLayer) {
      layers[i].leafletLayer.bringToFront();
    }
  }
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// --- Session Export/Import ---
function saveSession() {
  const filename = prompt("Save as:", "session.json");
  if (!filename) return;
  const session = {
    postgisstudio: 1,
    editor: editor.state.doc.toString(),
    mapCenter: [map.getCenter().lat, map.getCenter().lng],
    mapZoom: map.getZoom(),
    colorIndex,
    selectedLayerId,
    layers: layers.map(l => ({
      id: l.id, name: l.name, sql: l.sql, color: l.color,
      visible: l.visible, geojsonData: l.geojsonData,
      symbologyColumn: l.symbologyColumn,
    })),
  };
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : filename + ".json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Session saved");
}

function loadSession(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const session = JSON.parse(reader.result);
      if (!session.postgisstudio || !Array.isArray(session.layers)) {
        showError("Not a valid PostGIS Studio session file");
        return;
      }
      hideError();

      // Clear existing layers from map
      for (const l of layers) map.removeLayer(l.leafletLayer);
      layers.length = 0;

      // Restore editor content
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: session.editor || "" },
      });

      // Restore map view
      if (session.mapCenter && session.mapZoom != null) {
        map.setView(session.mapCenter, session.mapZoom);
      }

      colorIndex = session.colorIndex || 0;

      // Reconstruct layers
      let maxNum = 0;
      for (const sl of session.layers) {
        const layerObj = {
          id: sl.id, name: sl.name, sql: sl.sql, color: sl.color,
          visible: sl.visible, leafletLayer: null, geojsonData: sl.geojsonData,
          symbologyColumn: sl.symbologyColumn || null, symbologyMeta: null,
        };
        computeSymbology(layerObj);
        const leafletLayer = makeLeafletLayer(sl.geojsonData, layerObj);
        if (sl.visible) leafletLayer.addTo(map);
        layerObj.leafletLayer = leafletLayer;
        layers.push(layerObj);
        const m = sl.id.match(/^layer-(\d+)$/);
        if (m) maxNum = Math.max(maxNum, Number(m[1]));
      }
      layerCounter = maxNum;

      selectedLayerId = session.selectedLayerId || null;
      renderLayerList();
      syncLayerZOrder();
      setStatus(`Session loaded (${layers.length} layer${layers.length !== 1 ? "s" : ""})`);
    } catch (e) {
      showError("Failed to parse session file: " + e.message);
    }
  };
  reader.readAsText(file);
}

async function exportGpkg() {
  const exportLayers = layers
    .filter(l => l.geojsonData?.features?.length)
    .map(l => ({ name: l.name, geojsonData: l.geojsonData }));

  if (exportLayers.length === 0) {
    setStatus("No layers to export");
    return;
  }

  setStatus("Exporting GPKG...");
  try {
    const resp = await fetch("/api/export-gpkg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layers: exportLayers }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: "Export failed" }));
      setStatus(err.error || "Export failed");
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "export.gpkg";
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${exportLayers.length} layer${exportLayers.length !== 1 ? "s" : ""}`);
  } catch (err) {
    setStatus("Export failed: " + err.message);
  }
}
