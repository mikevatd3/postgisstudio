import os
import json
from decimal import Decimal
from datetime import date, datetime, time
from uuid import UUID

import asyncpg

_pool: asyncpg.Pool | None = None
_geom_oids: set[int] = set()


async def init_pool():
    global _pool, _geom_oids
    _pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT oid FROM pg_type WHERE typname IN ('geometry', 'geography')"
        )
        _geom_oids = {r["oid"] for r in rows}


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def _json_safe(val):
    if val is None:
        return None
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, (datetime, date, time)):
        return val.isoformat()
    if isinstance(val, UUID):
        return str(val)
    if isinstance(val, memoryview):
        return val.tobytes().hex()
    if isinstance(val, bytes):
        return val.hex()
    return val


async def run_query(sql: str) -> dict:
    async with _pool.acquire() as conn:
        stmt = await conn.prepare(sql)
        attrs = stmt.get_attributes()

        geom_indices: list[int] = []
        col_names: list[str] = []
        for i, attr in enumerate(attrs):
            col_names.append(attr.name)
            if attr.type.oid in _geom_oids:
                geom_indices.append(i)

        if geom_indices:
            wrapped_cols = []
            for i, attr in enumerate(attrs):
                if i in geom_indices:
                    wrapped_cols.append(
                        f'ST_AsGeoJSON("{attr.name}")::json AS "{attr.name}"'
                    )
                else:
                    wrapped_cols.append(f'"{attr.name}"')
            rewritten = "SELECT {} FROM ({}) AS _pgs_sub".format(
                ", ".join(wrapped_cols), sql.rstrip("; \n\t")
            )
            rows = await conn.fetch(rewritten)
        else:
            rows = await conn.fetch(sql)

        features = []
        for row in rows:
            geometry = None
            properties = {}
            for i, name in enumerate(col_names):
                val = row[name]
                if i in geom_indices:
                    if val is not None:
                        geometry = val if isinstance(val, dict) else json.loads(val)
                else:
                    properties[name] = _json_safe(val)
            if geometry is not None:
                features.append(
                    {
                        "type": "Feature",
                        "geometry": geometry,
                        "properties": properties,
                    }
                )
            else:
                features.append(
                    {
                        "type": "Feature",
                        "geometry": None,
                        "properties": properties,
                    }
                )

        return {
            "type": "FeatureCollection",
            "features": features,
            "row_count": len(rows),
            "has_geometry": len(geom_indices) > 0,
        }
