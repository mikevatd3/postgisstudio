"""Write GeoPackage files using sqlite3 + shapely (no GDAL)."""

import re
import sqlite3
import struct

from shapely.geometry import shape


def _sanitize_name(name: str) -> str:
    """Make a string safe for use as a SQL table/column name."""
    name = re.sub(r"[^\w]", "_", name)
    if name and name[0].isdigit():
        name = "l_" + name
    return name or "layer"


def _infer_col_types(features: list[dict]) -> dict[str, str]:
    """Scan features and map property names to INTEGER|REAL|TEXT."""
    types: dict[str, str | None] = {}
    for f in features:
        for k, v in (f.get("properties") or {}).items():
            if v is None:
                types.setdefault(k, None)
                continue
            if isinstance(v, bool):
                vtype = "INTEGER"
            elif isinstance(v, int):
                vtype = "INTEGER"
            elif isinstance(v, float):
                vtype = "REAL"
            else:
                vtype = "TEXT"
            prev = types.get(k)
            if prev is None:
                types[k] = vtype
            elif prev != vtype:
                # Promote: INT+REAL→REAL, anything+TEXT→TEXT
                if {prev, vtype} == {"INTEGER", "REAL"}:
                    types[k] = "REAL"
                else:
                    types[k] = "TEXT"
    return {k: (v or "TEXT") for k, v in types.items()}


def _geom_to_gpkb(geom_dict: dict, srs_id: int = 4326) -> bytes | None:
    """Convert a GeoJSON geometry dict to GeoPackage Binary (GPKB).

    GPKB = GP header + WKB.
    Header: magic 'GP', version 0, flags byte, srs_id (int32), envelope.
    """
    try:
        geom = shape(geom_dict)
    except Exception:
        return None
    if geom.is_empty:
        return None

    wkb = geom.wkb
    bounds = geom.bounds  # (minx, miny, maxx, maxy)

    # Flags byte: bit 1 = byte order (1=little-endian), bits 3-1 = envelope type
    # envelope type 1 = [minx, maxx, miny, maxy]
    flags = 0b00000011  # little-endian + envelope type 1 (xy)

    header = struct.pack(
        "<2sBBi4d",
        b"GP",  # magic
        0,  # version
        flags,
        srs_id,
        bounds[0],  # minx
        bounds[2],  # maxx
        bounds[1],  # miny
        bounds[3],  # maxy
    )
    return header + wkb


def write_gpkg(layers_data: list[dict], path: str) -> None:
    """Write layers to a GeoPackage file.

    layers_data: list of {"name": str, "geojsonData": {GeoJSON FeatureCollection}}
    """
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA application_id = 1196444487")  # 0x47504B47 = 'GPKG'
    conn.execute("PRAGMA user_version = 10301")  # version 1.3.1

    # --- Spatial ref sys ---
    conn.execute("""
        CREATE TABLE gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL,
            organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL,
            description TEXT
        )
    """)
    wgs84_wkt = (
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,'
        'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],'
        'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],'
        'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],'
        'AUTHORITY["EPSG","4326"]]'
    )
    conn.execute(
        "INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)",
        ("WGS 84 geodetic", 4326, "EPSG", 4326, wgs84_wkt, "WGS 84"),
    )
    conn.execute("""
        INSERT INTO gpkg_spatial_ref_sys VALUES
        ('Undefined Cartesian', -1, 'NONE', -1, 'undefined', NULL)
    """)
    conn.execute("""
        INSERT INTO gpkg_spatial_ref_sys VALUES
        ('Undefined Geographic', 0, 'NONE', 0, 'undefined', NULL)
    """)

    # --- Contents table ---
    conn.execute("""
        CREATE TABLE gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY,
            data_type TEXT NOT NULL DEFAULT 'features',
            identifier TEXT UNIQUE,
            description TEXT DEFAULT '',
            last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
            srs_id INTEGER,
            CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        )
    """)

    # --- Geometry columns table ---
    conn.execute("""
        CREATE TABLE gpkg_geometry_columns (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL,
            geometry_type_name TEXT NOT NULL DEFAULT 'GEOMETRY',
            srs_id INTEGER NOT NULL,
            z TINYINT NOT NULL DEFAULT 0,
            m TINYINT NOT NULL DEFAULT 0,
            CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
            CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
            CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
        )
    """)

    seen_names: set[str] = set()

    for layer in layers_data:
        raw_name = layer.get("name", "layer")
        geojson = layer.get("geojsonData") or {}
        features = geojson.get("features") or []
        if not features:
            continue

        table_name = _sanitize_name(raw_name)
        # Ensure unique table names
        base = table_name
        i = 2
        while table_name in seen_names:
            table_name = f"{base}_{i}"
            i += 1
        seen_names.add(table_name)

        col_types = _infer_col_types(features)
        col_defs = ", ".join(
            f'"{col}" {ctype}' for col, ctype in col_types.items()
        )

        create_sql = f"""
            CREATE TABLE "{table_name}" (
                fid INTEGER PRIMARY KEY AUTOINCREMENT,
                geom BLOB
                {"," + col_defs if col_defs else ""}
            )
        """
        conn.execute(create_sql)

        # Detect geometry type from first feature
        geom_type = "GEOMETRY"
        first_geom = features[0].get("geometry")
        if first_geom:
            gtype = first_geom.get("type", "").upper()
            known = {
                "POINT", "LINESTRING", "POLYGON",
                "MULTIPOINT", "MULTILINESTRING", "MULTIPOLYGON",
                "GEOMETRYCOLLECTION",
            }
            if gtype in known:
                geom_type = gtype

        # Insert features
        col_names = list(col_types.keys())
        placeholders = ", ".join(["?"] * (1 + len(col_names)))  # geom + props
        insert_sql = (
            f'INSERT INTO "{table_name}" (geom'
            + ("".join(f', "{c}"' for c in col_names))
            + f") VALUES ({placeholders})"
        )

        min_x = min_y = float("inf")
        max_x = max_y = float("-inf")

        for f in features:
            geom_dict = f.get("geometry")
            gpkb = _geom_to_gpkb(geom_dict) if geom_dict else None

            if gpkb and geom_dict:
                try:
                    s = shape(geom_dict)
                    b = s.bounds
                    min_x = min(min_x, b[0])
                    min_y = min(min_y, b[1])
                    max_x = max(max_x, b[2])
                    max_y = max(max_y, b[3])
                except Exception:
                    pass

            props = f.get("properties") or {}
            vals = [gpkb] + [props.get(c) for c in col_names]
            conn.execute(insert_sql, vals)

        # Clamp bounds for empty case
        if min_x == float("inf"):
            min_x = min_y = max_x = max_y = 0.0

        # Register in gpkg_contents
        conn.execute(
            """INSERT INTO gpkg_contents
               (table_name, data_type, identifier, srs_id,
                min_x, min_y, max_x, max_y)
               VALUES (?, 'features', ?, 4326, ?, ?, ?, ?)""",
            (table_name, table_name, min_x, min_y, max_x, max_y),
        )

        # Register geometry column
        conn.execute(
            """INSERT INTO gpkg_geometry_columns
               (table_name, column_name, geometry_type_name, srs_id, z, m)
               VALUES (?, 'geom', ?, 4326, 0, 0)""",
            (table_name, geom_type),
        )

    conn.commit()
    conn.close()
