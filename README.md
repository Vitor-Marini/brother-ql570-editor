# QL-570 Labels

Web label editor and Python driver for the **Brother QL-570**, with no Brother driver or CUPS required.
The server generates the QL-5xx series raster protocol (documented by Brother in the
*Raster Command Reference*) and sends it straight to the printer over USB.

> The web UI is currently in Brazilian Portuguese.

## Running with Docker (recommended)

On the machine the printer is plugged into via USB:

```bash
git clone <this-repo> && cd <this-repo>
cp .env.example .env          # adjust port/password if you like
docker compose up -d --build
```

Open `http://<machine-ip>:8570`.

| Variable (`.env`) | Default | Description |
|---|---|---|
| `PORT` | 8570 | Published port |
| `APP_PASSWORD` | empty | If set, the browser asks for a password (any username) |
| `QL_DEVICE` | auto | Pin the device, e.g. `/dev/usb/lp0` |
| `LP_GID` | 7 | GID of the `lp` group on the host (`getent group lp`) |

Templates, presets and print history are stored in the `ql-data` volume (`/data` inside the container).

**How USB reaches the container:** the compose file mounts `/dev/usb` and `/dev/bus/usb` and allows
the character devices `180:*` (usblp) and `189:*` (USB) through a cgroup rule. This way the printer
can be turned off and on again without restarting the container. The process runs as an unprivileged
user with the host's `lp` group; on Ubuntu/Debian `/dev/usb/lp*` is already `root:lp 0660`.

No internet access on the target machine? Build the image elsewhere and copy it over:

```bash
docker compose build
docker save ql570-web:latest | gzip > ql570-web.tar.gz
# on the target machine:
docker load < ql570-web.tar.gz && docker compose up -d
```

All JS libraries and fonts are vendored in `app/static/vendor` — no CDN needed.

## Running without Docker

```bash
sudo cp 99-brother-ql.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger
sudo usermod -aG lp $USER        # then log out and back in
./run.sh                          # http://localhost:8570
```

## Features

- **Built-in label gallery**: shipping address, sender, FRAGILE, price tag with EAN-13, stock bin,
  asset tag with numbered QR, binder spine, cable tag, food expiry date, Wi-Fi QR, name badge
  and large text. To add more, edit `app/defaults.json` (coordinates are fractions of the label).
- **My templates**: save the current design with a thumbnail, media and field values.
- **Presets**: combinations of media, orientation, length, threshold, dithering, cut and copies.
  Some presets ship by default and you can save your own.
- **Fields**: every `{{name}}` used in text, barcodes or QR codes becomes a field in the side panel.
  Built-in: `{{hoje}}` (today's date), `{{hora}}` (current time), `{{n}}` (sequence number; continues where it left off).
- **CSV batch printing**: one label per row. The "download sample CSV" button generates the right header.
- **Auto-fit text**: shrinks the font so the value fits the width.
- **History** of the last 50 print jobs, with one-click reprint.
- 1-bit preview exactly as it will be printed, adjustable threshold, dithering for photos.
- Printer status (cover open, no media…) and detection of the loaded media.
- Optional password, undo/redo, keyboard shortcuts (Del, Ctrl+Z/Y/D, arrow keys).

## Command line

```bash
.venv/bin/python -m app.cli status
.venv/bin/python -m app.cli labels
.venv/bin/python -m app.cli print photo.png --label 62 --rotate 90 --dither
.venv/bin/python -m app.cli print photo.png --label 62 --out job.bin   # only write the raster job
docker exec ql570 python -m app.cli status                             # inside the container
```

## Project layout

| File | Purpose |
|---|---|
| `app/labels.py` | Dimensions (in dots) of each supported media |
| `app/raster.py` | Image → raster commands (plus a decoder used in tests and preview) |
| `app/printer.py` | USB transport (`/dev/usb/lp*` or pyusb) and status parsing |
| `app/server.py` | FastAPI app: printing, templates, presets, history |
| `app/cli.py` | Command-line interface |
| `app/defaults.json` | Built-in gallery labels |
| `app/static/` | Editor (Fabric.js, JsBarcode, qrcode-generator) |

## Troubleshooting

- **"Nenhuma impressora encontrada" (no printer found)**: run `lsusb | grep 04f9` and `ls -l /dev/usb/` on the host.
- **"Sem permissão" (permission denied)**: check `LP_GID` (`getent group lp`) and the owner of `/dev/usb/lp*`.
  Without Docker: join the `lp` group and log out/in.
- **Print shifted to one side**: adjust the media's `offset_r` in `app/labels.py`.

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests
```

## Third-party assets

Bundled in `app/static/vendor`: [Fabric.js](https://github.com/fabricjs/fabric.js) (MIT),
[JsBarcode](https://github.com/lindell/JsBarcode) (MIT),
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) and fonts from
[Fontsource](https://fontsource.org/) (SIL Open Font License).

Brother and QL-570 are trademarks of Brother Industries, Ltd. This project is not affiliated with Brother.
