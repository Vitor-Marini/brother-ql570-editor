"""Uso pela linha de comando:

    python -m app.cli status
    python -m app.cli print imagem.png --label 62 [--rotate 90] [--copies 2] [--dither]
    python -m app.cli print imagem.png --label 62 --out job.bin   # só gera o arquivo
"""
import argparse
import json
import sys

from PIL import Image

from . import labels, printer, raster


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ql570")
    ap.add_argument("--device", help="ex.: /dev/usb/lp0 (padrão: detecção automática)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("labels")
    p = sub.add_parser("print")
    p.add_argument("images", nargs="+")
    p.add_argument("--label", required=True, choices=list(labels.BY_ID))
    p.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270])
    p.add_argument("--copies", type=int, default=1)
    p.add_argument("--threshold", type=int, default=128)
    p.add_argument("--dither", action="store_true")
    p.add_argument("--no-cut", action="store_true")
    p.add_argument("--out", help="salva o job raster em arquivo em vez de imprimir")
    a = ap.parse_args(argv)

    try:
        if a.cmd == "status":
            print(json.dumps(printer.get_status(a.device), indent=2, ensure_ascii=False))
        elif a.cmd == "labels":
            for l in labels.LABELS:
                print(f"{l.id:8} {l.name:24} {l.printable_w} x {l.printable_h or '∞'} pontos")
        else:
            label = labels.BY_ID[a.label]
            imgs = [raster.prepare_image(Image.open(f), label, a.rotate, a.threshold, a.dither)
                    for f in a.images for _ in range(a.copies)]
            job = raster.build_job(imgs, label, cut=not a.no_cut)
            if a.out:
                with open(a.out, "wb") as f:
                    f.write(job)
                print(f"{len(job)} bytes gravados em {a.out}")
            else:
                print(json.dumps(printer.print_job(job, len(imgs), a.device), indent=2, ensure_ascii=False))
    except printer.PrinterError as e:
        sys.exit(f"Erro: {e}")


if __name__ == "__main__":
    main()
