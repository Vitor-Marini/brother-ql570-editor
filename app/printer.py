"""Comunicação USB com a QL-570 (kernel usblp ou pyusb) e leitura de status."""
import glob
import os
import select
import time

from . import labels

VENDOR_ID = 0x04F9
PRODUCT_IDS = {0x2028: "QL-570"}

STATUS_REQUEST = b"\x00" * 200 + b"\x1b@" + b"\x1biS"

ERRORS_1 = {
    0x01: "Sem mídia",
    0x02: "Fim da mídia",
    0x04: "Cortador travado",
    0x10: "Impressora em uso",
    0x20: "Impressora desligada",
    0x40: "Alta tensão",
    0x80: "Erro no ventilador",
}
ERRORS_2 = {
    0x01: "Trocar mídia",
    0x02: "Erro de expansão de buffer",
    0x04: "Erro de comunicação",
    0x08: "Buffer de comunicação cheio",
    0x10: "Tampa aberta",
    0x20: "Superaquecimento",
    0x40: "Falha de alimentação",
    0x80: "Erro de sistema",
}
STATUS_TYPES = {
    0x00: "Resposta ao status",
    0x01: "Impressão concluída",
    0x02: "Erro",
    0x05: "Notificação",
    0x06: "Mudança de fase",
}


class PrinterError(Exception):
    pass


def parse_status(raw: bytes) -> dict:
    if len(raw) < 32 or raw[0] != 0x80 or raw[2] != 0x42:
        raise PrinterError(f"Resposta de status inválida: {raw.hex()}")
    errors = [m for b, m in ERRORS_1.items() if raw[8] & b]
    errors += [m for b, m in ERRORS_2.items() if raw[9] & b]
    width, mtype, length = raw[10], raw[11], raw[17]
    label = labels.find_by_media(width, length, mtype)
    return {
        "model_code": raw[4],
        "errors": errors,
        "media_width_mm": width,
        "media_length_mm": length,
        "media_type": {0x0A: "contínua", 0x0B: "pré-cortada"}.get(mtype, "nenhuma"),
        "detected_label": label.id if label else None,
        "status_type": STATUS_TYPES.get(raw[18], hex(raw[18])),
        "phase": "imprimindo" if raw[19] == 0x01 else "recebendo",
        "raw": raw[:32].hex(),
    }


def _read_frames(read_some, until, timeout) -> list[bytes]:
    frames, buf, end = [], b"", time.monotonic() + timeout
    while time.monotonic() < end:
        chunk = read_some()
        if not chunk:
            time.sleep(0.05)
            continue
        buf += chunk
        while len(buf) >= 32:
            frame, buf = buf[:32], buf[32:]
            frames.append(frame)
            if until(frame):
                return frames
    return frames


class KernelBackend:
    """Usa /dev/usb/lpN (módulo usblp do Linux)."""

    def __init__(self, path):
        self.path = path

    @staticmethod
    def discover():
        for path in sorted(glob.glob("/dev/usb/lp*")):
            sysfs = f"/sys/class/usbmisc/{os.path.basename(path)}/device/../idVendor"
            try:
                with open(sysfs) as f:
                    if int(f.read(), 16) != VENDOR_ID:
                        continue
            except OSError:
                pass  # sem sysfs: tenta mesmo assim
            yield KernelBackend(path)

    def transfer(self, data: bytes, until=None, timeout: float = 3.0) -> list[bytes]:
        """Escreve `data` e lê frames de 32 bytes até `until(frame)` ou timeout."""
        try:
            fd = os.open(self.path, os.O_RDWR)
        except PermissionError as e:
            raise PrinterError(
                f"Sem permissão em {self.path}. Entre no grupo 'lp' (sudo usermod -aG lp $USER) "
                "e saia/entre da sessão, ou rode o servidor com: sg lp -c ./run.sh") from e
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
            return _read_frames(lambda: self._read_some(fd), until, timeout) if until else []
        finally:
            os.close(fd)

    @staticmethod
    def _read_some(fd):
        r, _, _ = select.select([fd], [], [], 0.1)
        return os.read(fd, 32) if r else b""

    def describe(self):
        return f"kernel:{self.path}"


class PyUSBBackend:
    """Fallback com libusb, para quando o usblp não está disponível."""

    def __init__(self, dev):
        self.dev = dev

    @staticmethod
    def discover():
        try:
            import usb.core
        except ImportError:
            return
        for dev in usb.core.find(find_all=True, idVendor=VENDOR_ID) or []:
            yield PyUSBBackend(dev)

    def transfer(self, data: bytes, until=None, timeout: float = 3.0) -> list[bytes]:
        import usb.core
        import usb.util
        dev = self.dev
        try:
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
            dev.set_configuration()
        except usb.core.USBError as e:
            if e.errno == 13:
                raise PrinterError("Sem permissão no dispositivo USB. Instale a regra udev.") from e
        intf = dev.get_active_configuration()[(0, 0)]
        ep_out = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT)
        ep_in = usb.util.find_descriptor(intf, custom_match=lambda e:
            usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN)
        try:
            ep_out.write(data, timeout=int(timeout * 1000) + len(data) // 50)
            if not until:
                return []

            def read_some():
                try:
                    return bytes(ep_in.read(32, timeout=200))
                except usb.core.USBTimeoutError:
                    return b""
            return _read_frames(read_some, until, timeout)
        finally:
            usb.util.dispose_resources(dev)

    def describe(self):
        return f"usb:{self.dev.bus}-{self.dev.address}"


def find_printer(device: str | None = None):
    if device:
        return KernelBackend(device)
    for backend in (KernelBackend, PyUSBBackend):
        for b in backend.discover():
            return b
    raise PrinterError("Nenhuma impressora Brother encontrada. Está ligada e conectada via USB?")


def get_status(device: str | None = None) -> dict:
    p = find_printer(device)
    frames = p.transfer(STATUS_REQUEST, until=lambda f: True)
    if not frames:
        raise PrinterError("A impressora não respondeu ao pedido de status")
    status = parse_status(frames[-1])
    status["device"] = p.describe()
    return status


def print_job(job: bytes, pages: int, device: str | None = None, timeout: float = 30.0) -> dict:
    """Envia o job e aguarda o status 'impressão concluída' ou erro."""
    p = find_printer(device)
    done = 0

    def finished(frame):
        nonlocal done
        if frame[18] == 0x01:
            done += 1
        return frame[18] == 0x02 or done >= pages

    frames = p.transfer(job, until=finished, timeout=timeout + 5 * pages)
    result = {"device": p.describe(), "sent_bytes": len(job), "pages": pages,
              "completed": done}
    if frames:
        st = parse_status(frames[-1])
        result["status"] = st
        if st["errors"]:
            raise PrinterError("; ".join(st["errors"]))
    return result
