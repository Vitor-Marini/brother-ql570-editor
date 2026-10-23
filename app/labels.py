"""Mídias suportadas pela QL-570 (300 dpi).

Valores em pontos (dots) seguem o "Raster Command Reference" da Brother
para a série QL-500/550/560/570/580N/650TD.
"""
from dataclasses import dataclass, asdict

ENDLESS = "endless"
DIE_CUT = "die_cut"
ROUND = "round"

# Largura da cabeça de impressão em pontos (90 bytes por linha raster)
DEVICE_PIXEL_WIDTH = 720


@dataclass(frozen=True)
class Label:
    id: str
    name: str
    kind: str
    width_mm: int          # largura da fita
    length_mm: int         # 0 para fita contínua
    printable_w: int       # pontos imprimíveis na largura
    printable_h: int       # pontos imprimíveis no comprimento (0 = contínua)
    offset_r: int          # margem direita em pontos dentro da cabeça
    feed_margin: int       # margem de avanço (ESC i d)

    def to_dict(self):
        return asdict(self)


LABELS = [
    Label("12", "12 mm contínua", ENDLESS, 12, 0, 106, 0, 29, 35),
    Label("29", "29 mm contínua", ENDLESS, 29, 0, 306, 0, 6, 35),
    Label("38", "38 mm contínua", ENDLESS, 38, 0, 413, 0, 12, 35),
    Label("50", "50 mm contínua", ENDLESS, 50, 0, 554, 0, 12, 35),
    Label("54", "54 mm contínua", ENDLESS, 54, 0, 590, 0, 0, 35),
    Label("62", "62 mm contínua", ENDLESS, 62, 0, 696, 0, 12, 35),
    Label("17x54", "17 x 54 mm", DIE_CUT, 17, 54, 165, 566, 0, 0),
    Label("17x87", "17 x 87 mm", DIE_CUT, 17, 87, 165, 956, 0, 0),
    Label("23x23", "23 x 23 mm", DIE_CUT, 23, 23, 202, 202, 42, 0),
    Label("29x42", "29 x 42 mm", DIE_CUT, 29, 42, 306, 425, 6, 0),
    Label("29x90", "29 x 90 mm (endereço)", DIE_CUT, 29, 90, 306, 991, 6, 0),
    Label("39x90", "38 x 90 mm", DIE_CUT, 38, 90, 413, 991, 12, 0),
    Label("39x48", "39 x 48 mm", DIE_CUT, 39, 48, 425, 495, 6, 0),
    Label("52x29", "52 x 29 mm", DIE_CUT, 52, 29, 578, 271, 0, 0),
    Label("62x29", "62 x 29 mm", DIE_CUT, 62, 29, 696, 271, 12, 0),
    Label("62x100", "62 x 100 mm", DIE_CUT, 62, 100, 696, 1109, 12, 0),
    Label("d12", "Redonda 12 mm", ROUND, 12, 12, 94, 94, 113, 0),
    Label("d24", "Redonda 24 mm", ROUND, 24, 24, 236, 236, 42, 0),
    Label("d58", "Redonda 58 mm", ROUND, 58, 58, 618, 618, 51, 0),
]

BY_ID = {l.id: l for l in LABELS}


def find_by_media(width_mm: int, length_mm: int, media_type: int):
    """Encontra a etiqueta a partir do status da impressora."""
    for l in LABELS:
        if media_type == 0x0A and l.kind == ENDLESS and l.width_mm == width_mm:
            return l
        if media_type == 0x0B and l.kind != ENDLESS and l.width_mm == width_mm and l.length_mm == length_mm:
            return l
    return None
