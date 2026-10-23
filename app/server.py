"""API web: status, preview, impressão, modelos, predefinições e histórico."""
import base64
import binascii
import io
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from . import labels, printer, raster

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("QL_DATA_DIR", ROOT.parent / "data"))
TEMPLATES_DIR = Path(os.environ.get("QL_TEMPLATES_DIR", DATA_DIR / "templates"))
HISTORY_DIR = DATA_DIR / "history"
PRESETS_FILE = DATA_DIR / "presets.json"
for d in (TEMPLATES_DIR, HISTORY_DIR):
    d.mkdir(parents=True, exist_ok=True)

DEVICE = os.environ.get("QL_DEVICE") or None
PASSWORD = os.environ.get("APP_PASSWORD") or None
HISTORY_LIMIT = int(os.environ.get("QL_HISTORY_LIMIT", "50"))

# A impressora só atende um job por vez
_printer_lock = threading.Lock()

app = FastAPI(title="QL-570 Web")


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    """Se APP_PASSWORD estiver definido, exige HTTP Basic (qualquer usuário)."""
    if PASSWORD and request.url.path != "/api/health":
        ok = False
        auth = request.headers.get("authorization", "")
        if auth.startswith("Basic "):
            try:
                _, _, pwd = base64.b64decode(auth[6:]).decode().partition(":")
                ok = secrets.compare_digest(pwd, PASSWORD)
            except (binascii.Error, UnicodeDecodeError):
                pass
        if not ok:
            return Response("Autenticação necessária", 401,
                            {"WWW-Authenticate": 'Basic realm="QL-570"'})
    return await call_next(request)


class PrintSettings(BaseModel):
    label: str
    rotate: int = 0                   # 0, 90, 180, 270
    threshold: int = Field(128, ge=1, le=255)
    dither: bool = False
    cut: bool = True


class PrintRequest(PrintSettings):
    images: list[str]                 # data URLs PNG (uma por etiqueta diferente)
    copies: int = Field(1, ge=1, le=500)
    title: str = ""                   # nome exibido no histórico


class Template(BaseModel):
    name: str
    data: dict


class Preset(BaseModel):
    name: str
    label: str
    orientation: str = "landscape"
    length_mm: int = 90
    threshold: int = 128
    dither: bool = False
    cut: bool = True
    copies: int = 1


BUILTIN_PRESETS = [
    Preset(name="Fita 62 mm · 90 mm", label="62", length_mm=90),
    Preset(name="Fita 62 mm · 50 mm", label="62", length_mm=50),
    Preset(name="Fita 62 mm · foto (pontilhado)", label="62", orientation="portrait",
           length_mm=80, dither=True),
    Preset(name="Fita 29 mm · 60 mm", label="29", length_mm=60),
    Preset(name="Fita 12 mm · cabo 40 mm", label="12", length_mm=40),
    Preset(name="Endereço 29 × 90", label="29x90"),
    Preset(name="Envio 62 × 100", label="62x100"),
    Preset(name="Tira contínua sem corte", label="62", length_mm=60, cut=False),
]


def _decode(data_url: str) -> Image.Image:
    try:
        b64 = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
        return Image.open(io.BytesIO(base64.b64decode(b64)))
    except Exception as e:
        raise HTTPException(400, f"Imagem inválida: {e}")


def _label(label_id: str) -> labels.Label:
    if label_id not in labels.BY_ID:
        raise HTTPException(400, f"Etiqueta desconhecida: {label_id}")
    return labels.BY_ID[label_id]


def _prepare(req: PrintRequest):
    label = _label(req.label)
    imgs = [raster.prepare_image(_decode(u), label, req.rotate, req.threshold, req.dither)
            for u in req.images]
    return label, [im for im in imgs for _ in range(req.copies)]


def _safe_name(name: str) -> str:
    safe = re.sub(r"[^\w\- ]", "_", name).strip()
    if not safe:
        raise HTTPException(400, "Nome inválido")
    return safe


def _print(req: PrintRequest) -> dict:
    label, imgs = _prepare(req)
    job = raster.build_job(imgs, label, req.cut)
    if not _printer_lock.acquire(timeout=60):
        raise HTTPException(409, "Impressora ocupada")
    try:
        return printer.print_job(job, len(imgs), DEVICE)
    except printer.PrinterError as e:
        raise HTTPException(503, str(e))
    finally:
        _printer_lock.release()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/labels")
def list_labels():
    return [l.to_dict() for l in labels.LABELS]


@app.get("/api/status")
def status():
    if not _printer_lock.acquire(blocking=False):
        return {"online": True, "busy": True, "errors": []}
    try:
        return {"online": True, **printer.get_status(DEVICE)}
    except printer.PrinterError as e:
        return {"online": False, "error": str(e)}
    finally:
        _printer_lock.release()


@app.post("/api/preview")
def preview(req: PrintRequest):
    """Retorna exatamente o que será impresso (1 bit), a partir do job gerado."""
    req.copies = 1
    label, imgs = _prepare(req)
    page = raster.decode_job(raster.build_job(imgs[:1], label))[0]
    left = labels.DEVICE_PIXEL_WIDTH - label.printable_w - label.offset_r
    page = page.crop((left, 0, left + label.printable_w, page.height))
    if req.rotate:
        page = page.rotate(req.rotate, expand=True)
    buf = io.BytesIO()
    page.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png")


@app.post("/api/job")
def download_job(req: PrintRequest):
    label, imgs = _prepare(req)
    return Response(raster.build_job(imgs, label, req.cut), media_type="application/octet-stream",
                    headers={"Content-Disposition": "attachment; filename=etiqueta.bin"})


@app.post("/api/print")
def do_print(req: PrintRequest):
    result = _print(req)
    _add_history(req, result.get("completed") or len(req.images) * req.copies)
    return {"ok": True, **result}


# ---------- histórico ----------

def _thumb(data_url: str, size=(240, 160)) -> str:
    img = _decode(data_url).convert("L")
    img.thumbnail(size)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _add_history(req: PrintRequest, printed: int):
    entry_id = f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    entry = {
        "id": entry_id, "ts": time.time(), "title": req.title, "printed": printed,
        "labels": len(req.images), "thumb": _thumb(req.images[0]),
        "request": req.model_dump(),
    }
    (HISTORY_DIR / f"{entry_id}.json").write_text(json.dumps(entry))
    for old in sorted(HISTORY_DIR.glob("*.json"))[:-HISTORY_LIMIT]:
        old.unlink(missing_ok=True)


def _history_entry(entry_id: str) -> dict:
    p = HISTORY_DIR / f"{_safe_name(entry_id)}.json"
    if not p.exists():
        raise HTTPException(404, "Registro não encontrado")
    return json.loads(p.read_text())


@app.get("/api/history")
def list_history():
    out = []
    for p in sorted(HISTORY_DIR.glob("*.json"), reverse=True):
        e = json.loads(p.read_text())
        r = e["request"]
        out.append({k: e[k] for k in ("id", "ts", "title", "printed", "labels", "thumb")}
                   | {"label": r["label"], "copies": r["copies"]})
    return out


@app.post("/api/history/{entry_id}/reprint")
def reprint(entry_id: str):
    req = PrintRequest(**_history_entry(entry_id)["request"])
    result = _print(req)
    _add_history(req, result.get("completed") or len(req.images) * req.copies)
    return {"ok": True, **result}


@app.delete("/api/history")
def clear_history():
    for p in HISTORY_DIR.glob("*.json"):
        p.unlink(missing_ok=True)
    return {"ok": True}


# ---------- modelos ----------

@app.get("/api/defaults")
def default_templates():
    return json.loads((ROOT / "defaults.json").read_text())


@app.get("/api/templates")
def list_templates():
    out = []
    for p in sorted(TEMPLATES_DIR.glob("*.json")):
        d = json.loads(p.read_text())
        out.append({"name": p.stem, "label": d.get("label"), "thumb": d.get("thumb")})
    return out


@app.get("/api/templates/{name}")
def get_template(name: str):
    p = TEMPLATES_DIR / f"{_safe_name(name)}.json"
    if not p.exists():
        raise HTTPException(404, "Modelo não encontrado")
    return json.loads(p.read_text())


@app.put("/api/templates")
def save_template(t: Template):
    (TEMPLATES_DIR / f"{_safe_name(t.name)}.json").write_text(json.dumps(t.data))
    return {"ok": True}


@app.delete("/api/templates/{name}")
def delete_template(name: str):
    (TEMPLATES_DIR / f"{_safe_name(name)}.json").unlink(missing_ok=True)
    return {"ok": True}


# ---------- predefinições ----------

def _user_presets() -> list[dict]:
    try:
        return json.loads(PRESETS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


@app.get("/api/presets")
def list_presets():
    return ([p.model_dump() | {"builtin": True} for p in BUILTIN_PRESETS]
            + [p | {"builtin": False} for p in _user_presets()])


@app.put("/api/presets")
def save_preset(p: Preset):
    _label(p.label)
    items = [x for x in _user_presets() if x["name"] != p.name] + [p.model_dump()]
    PRESETS_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=1))
    return {"ok": True}


@app.delete("/api/presets/{name}")
def delete_preset(name: str):
    PRESETS_FILE.write_text(json.dumps([x for x in _user_presets() if x["name"] != name],
                                       ensure_ascii=False, indent=1))
    return {"ok": True}


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")
