import os
import tempfile
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.background import BackgroundTask

import db
import gpkg

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    yield
    await db.close_pool()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/schema")
async def schema():
    result = await db.get_schema()
    return JSONResponse(result)


class QueryRequest(BaseModel):
    sql: str


class ExportLayer(BaseModel):
    name: str
    geojsonData: dict


class ExportRequest(BaseModel):
    layers: list[ExportLayer]


@app.post("/api/query")
async def query(body: QueryRequest):
    try:
        result = await db.run_query(body.sql)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/export-gpkg")
async def export_gpkg(body: ExportRequest):
    if not body.layers:
        return JSONResponse({"error": "No layers to export"}, status_code=400)

    fd, path = tempfile.mkstemp(suffix=".gpkg")
    os.close(fd)
    try:
        gpkg.write_gpkg(
            [{"name": l.name, "geojsonData": l.geojsonData} for l in body.layers],
            path,
        )
    except Exception as e:
        os.unlink(path)
        return JSONResponse({"error": str(e)}, status_code=500)

    return FileResponse(
        path,
        media_type="application/geopackage+sqlite3",
        filename="export.gpkg",
        background=BackgroundTask(os.unlink, path),
    )
