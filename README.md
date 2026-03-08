# PostGIS Studio

A web app for running PostGIS queries and visualizing geometry results on a Leaflet map. Features a SQL editor with syntax highlighting, auto-detection of geometry columns, and a multi-layer system with color cycling — all in an Everforest dark theme with CARTO dark tiles.

## Features

- **SQL editor** — CodeMirror 6 with PostgreSQL dialect and syntax highlighting
- **Geometry auto-detection** — geometry/geography columns are detected via `pg_type` OIDs and automatically wrapped with `ST_AsGeoJSON()`, no manual conversion needed
- **Multi-layer system** — each query result becomes a named layer with its own color, cycling through Everforest palette colors
- **Layer management** — toggle visibility, remove layers, click a layer name to reload its SQL in the editor
- **Dark theme** — Everforest color scheme with CARTO dark map tiles and styled Leaflet popups
- **Feature popups** — click any geometry to see all non-geometry columns as properties
- **File loading** — drag-and-drop or file picker for `.sql` files
- **Keyboard shortcut** — Ctrl+Enter to run queries

## Setup

```sh
cp .env.example .env
# Edit .env with your PostGIS database URL
uv sync
uv run uvicorn main:app --reload
```

Open http://localhost:8000.

## Architecture

```
Browser (SPA)                         Server (FastAPI)
+----------------------------------+   +---------------------------+
| index.html                       |   | main.py                   |
|  +------------+ +-------------+  |   |  GET /  → template        |
|  | Left Panel | | Right Panel |  |   |  POST /api/query          |
|  | - CodeMirror| | - Leaflet  |  |   +---------------------------+
|  | - Layer List| |   Map      |  |   | db.py                     |
|  +------------+ +-------------+  |   |  asyncpg pool             |
|  static/app.js                   |   |  geometry auto-detection  |
|  static/style.css                |   |  GeoJSON assembly         |
+----------------------------------+   +---------------------------+
```

- `main.py` — FastAPI app with a single query endpoint
- `db.py` — asyncpg connection pool, geometry detection, query rewriting, GeoJSON FeatureCollection assembly
- `templates/index.html` — two-panel layout (420px sidebar + map)
- `static/style.css` — Everforest dark theme CSS variables and styles
- `static/app.js` — CodeMirror 6 editor, Leaflet map, layer system, drag-and-drop
