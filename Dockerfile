FROM python:3.12-slim

# libusb for the pyusb fallback (when /dev/usb/lp* does not exist)
RUN apt-get update \
 && apt-get install -y --no-install-recommends libusb-1.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Unprivileged user; USB access comes from the "lp" group (group_add in compose)
RUN useradd --system --uid 1000 --no-create-home ql \
 && mkdir -p /data && chown ql /data
USER ql

ENV QL_DATA_DIR=/data \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8570

HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8570/api/health')"

CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8570"]
