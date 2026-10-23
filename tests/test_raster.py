import struct

from PIL import Image, ImageDraw

from app import labels, printer, raster


def _sample(w, h):
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 9, h - 1], fill=0)   # barra à esquerda
    d.rectangle([w // 2, h // 2, w // 2 + 20, h // 2 + 20], fill=0)
    return img


def test_roundtrip_endless_62():
    label = labels.BY_ID["62"]
    img = raster.prepare_image(_sample(696, 300), label)
    job = raster.build_job([img, img], label)
    pages = raster.decode_job(job)
    assert len(pages) == 2
    page = pages[0]
    assert page.size == (720, 300)
    # a imagem deve ocupar as colunas [720-696-12, 720-12)
    left = 720 - 696 - label.offset_r
    crop = page.crop((left, 0, left + 696, 300))
    assert crop.tobytes() == img.tobytes()
    # fora da área imprimível tudo é branco
    assert page.crop((0, 0, left, 300)).getextrema() == (255, 255)


def test_header_fields():
    label = labels.BY_ID["29x90"]
    img = raster.prepare_image(_sample(991, 306), label, rotate=90)
    assert img.size == (306, 991)
    job = raster.build_job([img], label)
    assert job.startswith(b"\x00" * 200 + b"\x1b@\x1bia\x01")
    i = job.index(b"\x1biz")
    flags, mtype, w, l = job[i + 3:i + 7]
    lines = struct.unpack("<L", job[i + 7:i + 11])[0]
    assert (mtype, w, l, lines) == (0x0B, 29, 90, 991)
    assert job.endswith(b"\x1a")
    assert job.count(b"g\x00\x5a") >= 991


def test_die_cut_padding():
    label = labels.BY_ID["62x29"]
    img = raster.prepare_image(Image.new("L", (696, 100), 0), label)
    assert img.size == (696, 271)


def test_parse_status():
    raw = bytearray(32)
    raw[0], raw[1], raw[2], raw[3], raw[4] = 0x80, 0x20, 0x42, 0x30, 0x34
    raw[10], raw[11], raw[17] = 62, 0x0A, 0
    st = printer.parse_status(bytes(raw))
    assert st["detected_label"] == "62" and st["errors"] == []
    raw[9] = 0x10
    assert printer.parse_status(bytes(raw))["errors"] == ["Tampa aberta"]
