import base64
import io
import importlib

from PIL import Image


def _png():
    buf = io.BytesIO()
    Image.new("L", (300, 200), 255).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_history_and_presets(tmp_path, monkeypatch):
    monkeypatch.setenv("QL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("QL_HISTORY_LIMIT", "3")
    from app import server
    server = importlib.reload(server)

    req = server.PrintRequest(label="62", images=[_png()], copies=2, title="teste")
    for _ in range(5):
        server._add_history(req, 2)
    hist = server.list_history()
    assert len(hist) == 3 and hist[0]["title"] == "teste" and hist[0]["thumb"].startswith("data:image/png")
    assert server._history_entry(hist[0]["id"])["request"]["copies"] == 2

    server.save_preset(server.Preset(name="Meu", label="29", length_mm=40))
    names = [(p["name"], p["builtin"]) for p in server.list_presets()]
    assert ("Meu", False) in names and any(b for _, b in names)
    server.delete_preset("Meu")
    assert ("Meu", False) not in [(p["name"], p["builtin"]) for p in server.list_presets()]

    ids = {d["id"] for d in server.default_templates()}
    assert {"endereco", "wifi", "patrimonio"} <= ids
