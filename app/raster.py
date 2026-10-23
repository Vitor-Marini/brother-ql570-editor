"""Gera o fluxo de comandos raster da QL-570 a partir de imagens PIL."""
import struct

from PIL import Image, ImageOps

from .labels import DEVICE_PIXEL_WIDTH, ENDLESS, Label

BYTES_PER_LINE = DEVICE_PIXEL_WIDTH // 8  # 90

MEDIA_ENDLESS = 0x0A
MEDIA_DIE_CUT = 0x0B


def prepare_image(img: Image.Image, label: Label, rotate: int = 0,
                  threshold: int = 128, dither: bool = False) -> Image.Image:
    """Converte a imagem para 1 bit no tamanho imprimível da etiqueta.

    Na imagem resultante a largura é transversal à fita e a altura é o
    comprimento (sentido de avanço do papel).
    """
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    img = img.convert("L")
    if rotate:
        img = img.rotate(-rotate, expand=True)  # sentido horário

    w = label.printable_w
    if img.width != w:
        h = max(1, round(img.height * w / img.width))
        img = img.resize((w, h), Image.LANCZOS)
    if label.kind != ENDLESS:
        img = ImageOps.pad(img, (w, label.printable_h), color=255) \
            if img.height != label.printable_h else img

    if dither:
        return img.convert("1")  # Floyd-Steinberg
    return img.point(lambda p: 255 if p >= threshold else 0, mode="1")


def _raster_lines(img: Image.Image, label: Label) -> bytes:
    """Coloca a imagem na posição correta da cabeça e gera comandos 'g'."""
    canvas = Image.new("1", (DEVICE_PIXEL_WIDTH, img.height), 1)
    canvas.paste(img, (DEVICE_PIXEL_WIDTH - img.width - label.offset_r, 0))
    canvas = ImageOps.mirror(canvas)
    # No modo "1" do PIL, branco = 1; para a impressora, 1 = ponto preto.
    raw = bytes(b ^ 0xFF for b in canvas.tobytes())
    out = bytearray()
    for y in range(img.height):
        out += b"g\x00" + bytes([BYTES_PER_LINE])
        out += raw[y * BYTES_PER_LINE:(y + 1) * BYTES_PER_LINE]
    return bytes(out)


def build_job(images: list[Image.Image], label: Label, cut: bool = True,
              cut_every: int = 1) -> bytes:
    """Monta o job completo. `images` já devem vir de prepare_image()."""
    data = bytearray()
    data += b"\x00" * 200          # invalidate
    data += b"\x1b@"               # initialize
    data += b"\x1bia\x01"          # modo raster

    for page, img in enumerate(images):
        mtype = MEDIA_ENDLESS if label.kind == ENDLESS else MEDIA_DIE_CUT
        # ESC i z: flags válidas = recover|tipo|largura|comprimento|qualidade
        data += b"\x1biz" + bytes([0x80 | 0x02 | 0x04 | 0x08 | 0x40, mtype,
                                   label.width_mm, label.length_mm])
        data += struct.pack("<L", img.height)
        data += bytes([0 if page == 0 else 1, 0])
        data += b"\x1biM" + bytes([0x40 if cut else 0x00])   # auto cut
        if cut:
            data += b"\x1biA" + bytes([max(1, min(255, cut_every))])
        data += b"\x1biK" + bytes([0x08 if cut else 0x00])   # cut at end
        data += b"\x1bid" + struct.pack("<H", label.feed_margin)
        data += _raster_lines(img, label)
        data += b"\x1a" if page == len(images) - 1 else b"\x0c"
    return bytes(data)


def decode_job(data: bytes) -> list[Image.Image]:
    """Decodifica um job de volta em imagens (usado em testes/preview)."""
    pages, rows, i = [], [], 0
    while i < len(data):
        b = data[i]
        if b == 0x00:
            i += 1
        elif data[i:i + 2] == b"\x1b@":
            i += 2
        elif data[i:i + 3] in (b"\x1bia", b"\x1biM", b"\x1biA", b"\x1biK"):
            i += 4
        elif data[i:i + 3] == b"\x1biz":
            i += 13
        elif data[i:i + 3] == b"\x1bid":
            i += 5
        elif b == ord("g"):
            n = data[i + 2]
            rows.append(data[i + 3:i + 3 + n])
            i += 3 + n
        elif b in (0x0C, 0x1A):
            img = Image.frombytes("1", (DEVICE_PIXEL_WIDTH, len(rows)),
                                  bytes(x ^ 0xFF for r in rows for x in r))
            pages.append(ImageOps.mirror(img))
            rows = []
            i += 1
        else:
            raise ValueError(f"byte inesperado 0x{b:02x} na posição {i}")
    return pages
