/* Editor de etiquetas para Brother QL-570 */
'use strict';

const DPMM = 300 / 25.4;
const FONTS = ['Inter', 'Oswald', 'Bebas Neue', 'Roboto Slab', 'Roboto Mono',
  'DejaVu Sans', 'Liberation Sans', 'Liberation Serif', 'Ubuntu'];
const BARCODE_FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF14', 'ITF', 'codabar', 'MSI', 'pharmacode'];
const VAR_RE = /\{\{\s*([\wÀ-ú]+)\s*\}\}/g;
const HAS_VAR = /\{\{\s*[\wÀ-ú]+\s*\}\}/;
const EXTRA_PROPS = ['data', 'imageSmoothing'];

const $ = (s) => document.querySelector(s);
const state = { labels: [], label: null, docW: 0, docH: 0, zoom: 1, csvRows: null, printing: false, fields: {}, currentName: '', margins: { x: 0, y: 0 } };

const canvas = new fabric.Canvas('c', { backgroundColor: '#fff', preserveObjectStacking: true });
fabric.Object.prototype.set({ cornerColor: '#c8102e', borderColor: '#c8102e', cornerSize: 9, transparentCorners: false });

/* ---------- utilidades ---------- */
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), error ? 5000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* resposta não-JSON */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return res;
}

function substitute(str, vars) {
  return str.replace(VAR_RE, (m, k) => (k in vars ? String(vars[k]) : m));
}

function builtinVars(n) {
  const d = new Date();
  return {
    hoje: d.toLocaleDateString('pt-BR'),
    hora: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    n,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------- códigos de barras / QR ---------- */
function barcodeCanvas(d, value) {
  const c = document.createElement('canvas');
  let ok = true;
  JsBarcode(c, value || ' ', {
    format: d.format, width: d.module, height: d.height, displayValue: d.showText,
    fontSize: d.fontSize, font: 'Inter', margin: 0, textMargin: 4, valid: (v) => (ok = v),
  });
  if (!ok) throw new Error('invalid');
  return c;
}

function qrCanvas(d, value) {
  const q = qrcode(0, d.ecc);
  q.addData(value || ' ');
  q.make();
  const n = q.getModuleCount();
  const c = document.createElement('canvas');
  c.width = c.height = n * d.cell;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++)
    for (let col = 0; col < n; col++)
      if (q.isDark(r, col)) ctx.fillRect(col * d.cell, r * d.cell, d.cell, d.cell);
  return c;
}
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

function codeElement(d, value) {
  return d.type === 'qr' ? qrCanvas(d, value) : barcodeCanvas(d, value);
}

/** Valores usados para mostrar {{campos}} em códigos no editor. */
function displayVars() {
  return { ...builtinVars(+($('#n-start')?.value) || 1), ...state.fields };
}

/**
 * Regera a imagem de um código. Com `value` explícito (impressão) o valor
 * precisa ser válido; sem ele (editor) os {{campos}} são preenchidos e um
 * valor inválido vira um CODE128 provisório.
 */
async function refreshCode(obj, value) {
  const strict = value !== undefined;
  const shown = strict ? value : substitute(obj.data.value, displayVars());
  let el;
  try {
    el = await loadImage(codeElement(obj.data, shown).toDataURL());
  } catch (_) {
    if (strict || !HAS_VAR.test(obj.data.value)) {
      toast(`Valor inválido para ${obj.data.format || 'QR'}: ${shown}`, true);
      return false;
    }
    el = await loadImage(barcodeCanvas({ ...obj.data, format: 'CODE128' }, shown).toDataURL());
  }
  obj.setElement(el);
  obj.set({ scaleX: 1, scaleY: 1 });
  obj.setCoords();
  obj.canvas?.requestRenderAll();
  return true;
}

/* ---------- layout da etiqueta ---------- */
function docFor(l, orientation, lengthMm) {
  const across = l.printable_w;
  let along = l.printable_h;
  if (l.kind === 'endless') along = Math.max(80, Math.round(lengthMm * DPMM) - 2 * l.feed_margin);
  return orientation === 'landscape' ? { w: along, h: across, rotate: 90 } : { w: across, h: along, rotate: 0 };
}

function computeDoc() {
  return docFor(state.label, $('#orientation').value, +$('#length-mm').value);
}

/** Margens não imprimíveis (em pontos, por lado) entre a área imprimível e a borda física. */
function unprintableMargins(l, orientation) {
  const across = Math.max(0, (l.width_mm * DPMM - l.printable_w) / 2);
  const along = l.kind === 'endless' ? l.feed_margin
    : l.kind === 'round' ? across : Math.max(0, (l.length_mm * DPMM - l.printable_h) / 2);
  return orientation === 'landscape' ? { x: along, y: across } : { x: across, y: along };
}

const mm = (dots) => (dots / DPMM).toFixed(1).replace('.', ',');

function applyLayout(fit = true) {
  const d = computeDoc();
  state.docW = d.w;
  state.docH = d.h;
  const l = state.label;
  state.margins = unprintableMargins(l, $('#orientation').value);
  $('#length-wrap').hidden = l.kind !== 'endless';
  $('#tape').classList.toggle('round', l.kind === 'round');
  const len = l.kind === 'endless' ? `${$('#length-mm').value} mm` : `${l.length_mm} mm`;
  $('#label-info').textContent = `${l.width_mm} × ${len} — área imprimível ${mm(d.w)} × ${mm(d.h)} mm`
    + ` (${d.w} × ${d.h} pontos, 300 dpi). A faixa cinza ao redor não é impressa.`;
  if (fit) {
    const wrap = $('#canvas-wrap');
    const { x, y } = state.margins;
    const z = Math.min((wrap.clientWidth - 100) / (d.w + 2 * x), (wrap.clientHeight - 100) / (d.h + 2 * y), 3);
    state.zoom = Math.max(0.2, z);
    $('#zoom').value = state.zoom;
  }
  setZoom(state.zoom);
}

function setZoom(z) {
  state.zoom = z;
  canvas.setDimensions({ width: state.docW * z, height: state.docH * z });
  canvas.setZoom(z);
  const { x, y } = state.margins;
  $('#tape').style.padding = `${y * z}px ${x * z}px`;
  layoutMarginLabels(x * z, y * z);
  canvas.requestRenderAll();
}

/* ---------- margens não imprimíveis ---------- */
const MARGIN_TEXTS = ['Margem reservada, não imprimível', 'Não imprimível'];

/** Posiciona as faixas da margem; usa o texto mais longo que couber, ou nenhum. */
function layoutMarginLabels(px, py) {
  const set = (sel, thick, css) => {
    const el = $(sel);
    Object.assign(el.style, css, { fontSize: `${Math.min(11, thick * 0.6)}px` });
    const vertical = sel === '.m-left' || sel === '.m-right';
    const fits = () => (vertical ? el.scrollHeight <= el.clientHeight : el.scrollWidth <= el.clientWidth);
    el.textContent = thick < 9 ? '' : MARGIN_TEXTS.find((t) => ((el.textContent = t), fits())) || '';
  };
  set('.m-left', px, { width: `${px}px` });
  set('.m-right', px, { width: `${px}px` });
  set('.m-top', py, { height: `${py}px`, left: `${px}px`, right: `${px}px` });
  set('.m-bottom', py, { height: `${py}px`, left: `${px}px`, right: `${px}px` });
}

/** Destaca as margens invadidas por elementos e mostra o aviso abaixo da etiqueta. */
function checkMargins() {
  const out = { left: false, right: false, top: false, bottom: false };
  const tol = 0.5;
  const offenders = canvas.getObjects().filter((o) => {
    const r = o.getBoundingRect(true, true);
    const sides = {
      left: r.left < -tol, top: r.top < -tol,
      right: r.left + r.width > state.docW + tol, bottom: r.top + r.height > state.docH + tol,
    };
    Object.keys(sides).forEach((k) => (out[k] ||= sides[k]));
    return Object.values(sides).some(Boolean);
  });
  Object.entries(out).forEach(([k, v]) => $(`.m-${k}`).classList.toggle('out', v));
  const sel = canvas.getActiveObjects();
  const warn = $('#margin-warn');
  warn.hidden = !offenders.length;
  warn.textContent = offenders.some((o) => sel.includes(o))
    ? '⚠ Parte do elemento selecionado fica na margem e não será impressa.'
    : offenders.length === 1
      ? '⚠ Parte de um elemento fica na margem e não será impressa.'
      : `⚠ Parte de ${offenders.length} elementos fica na margem e não será impressa.`;
}

let marginsFrame;
canvas.on('after:render', () => {
  cancelAnimationFrame(marginsFrame);
  marginsFrame = requestAnimationFrame(checkMargins);
});

/* ---------- inserção de elementos ---------- */
function place(obj) {
  obj.set({
    left: (state.docW - obj.getScaledWidth()) / 2,
    top: (state.docH - obj.getScaledHeight()) / 2,
  });
  canvas.add(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
}

function newTextbox(text, extra = {}) {
  const fontSize = Math.round(Math.min(state.docH, state.docW) * 0.16);
  const t = new fabric.Textbox(text, {
    fontFamily: 'Inter', fontSize, fill: '#000', width: state.docW * 0.8,
    textAlign: 'center', splitByGrapheme: false, data: { type: 'text' }, ...extra,
  });
  t.left = (state.docW - t.width) / 2;
  t.top = (state.docH - t.height) / 2;
  return t;
}

async function newCode(type) {
  const d = type === 'qr'
    ? { type: 'qr', value: 'https://exemplo.com', cell: Math.max(2, Math.floor(state.docH / 40)), ecc: 'M' }
    : { type: 'barcode', value: '123456789', format: 'CODE128', module: 3,
        height: Math.round(state.docH * 0.45), showText: true, fontSize: Math.round(state.docH * 0.1) };
  const el = await loadImage(codeElement(d, d.value).toDataURL());
  return new fabric.Image(el, { imageSmoothing: false, data: d });
}

const adders = {
  text: () => place(newTextbox('Texto')),
  date: () => place(newTextbox('{{hoje}}')),
  barcode: async () => place(await newCode('barcode')),
  qr: async () => place(await newCode('qr')),
  image: () => $('#image-input').click(),
  rect: () => place(new fabric.Rect({
    width: state.docW * 0.5, height: state.docH * 0.5, fill: 'transparent', stroke: '#000',
    strokeWidth: 6, strokeUniform: true, rx: 0, ry: 0, data: { type: 'shape' },
  })),
  ellipse: () => place(new fabric.Ellipse({
    rx: state.docH * 0.3, ry: state.docH * 0.3, fill: 'transparent', stroke: '#000',
    strokeWidth: 6, strokeUniform: true, data: { type: 'shape' },
  })),
  line: () => place(new fabric.Line([0, 0, state.docW * 0.6, 0], {
    stroke: '#000', strokeWidth: 6, strokeUniform: true, data: { type: 'line' },
  })),
};

document.querySelectorAll('[data-add]').forEach((b) =>
  b.addEventListener('click', () => adders[b.dataset.add]()));

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => fabric.Image.fromURL(reader.result, (img) => {
    const s = Math.min(state.docW * 0.8 / img.width, state.docH * 0.9 / img.height);
    img.set({ scaleX: s, scaleY: s, data: { type: 'image' } });
    place(img);
  });
  reader.readAsDataURL(file);
}

$('#image-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  addImageFile(file);
  e.target.value = '';
});

/* ---------- painel de propriedades ---------- */
function field(label, input) {
  const l = document.createElement('label');
  l.textContent = label;
  l.appendChild(input);
  return l;
}

function input(type, value, onInput, attrs = {}) {
  const el = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') el.type = type;
  if (type === 'checkbox') el.checked = value; else el.value = value;
  Object.assign(el, attrs);
  el.addEventListener('input', () => onInput(type === 'checkbox' ? el.checked : type === 'number' ? +el.value : el.value));
  if (type !== 'textarea' && type !== 'text') el.addEventListener('change', () => saveHistory());
  else el.addEventListener('blur', () => saveHistory());
  return el;
}

function select(options, value, onChange) {
  const el = document.createElement('select');
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    el.add(new Option(t, v, false, String(v) === String(value)));
  }
  el.addEventListener('change', () => { onChange(el.value); saveHistory(); });
  return el;
}

function toggles(items) {
  const g = document.createElement('div');
  g.className = 'btn-group';
  for (const it of items) {
    const b = document.createElement('button');
    b.innerHTML = it.label;
    b.title = it.title || '';
    b.classList.toggle('active', it.active());
    b.addEventListener('click', () => {
      it.click();
      g.querySelectorAll('button').forEach((x, i) => x.classList.toggle('active', items[i].active()));
      canvas.requestRenderAll();
      saveHistory();
    });
    g.appendChild(b);
  }
  return g;
}

function setProp(obj, key, val) {
  obj.set(key, val);
  obj.setCoords();
  canvas.requestRenderAll();
}

function grid(...children) {
  const g = document.createElement('div');
  g.className = 'grid2';
  children.forEach((c) => g.appendChild(c));
  return g;
}

/* ---------- tamanho das figuras (mm ou pixels) ---------- */
try { state.sizeUnit = localStorage.getItem('ql-size-unit') || 'mm'; } catch (_) { state.sizeUnit = 'mm'; }

/** Define o tamanho externo (contorno incluído) de retângulo/elipse, em pixels. */
function setShapeSize(obj, w, h) {
  const sw = obj.strokeWidth;
  if (obj.type === 'ellipse') obj.set({ rx: Math.max(0.5, (w - sw) / 2), ry: Math.max(0.5, (h - sw) / 2) });
  else obj.set({ width: Math.max(1, w - sw), height: Math.max(1, h - sw) });
  obj.set({ scaleX: 1, scaleY: 1 });
  obj.setCoords();
  canvas.requestRenderAll();
}

function lineLength(obj) {
  return Math.hypot(obj.width * obj.scaleX, obj.height * obj.scaleY);
}

function setLineLength(obj, len) {
  const cur = lineLength(obj);
  if (!cur || !len) return;
  if (!obj.strokeUniform) {
    // mantém a espessura visível ao redimensionar
    const s = obj.width >= obj.height ? obj.scaleY : obj.scaleX;
    obj.set({ strokeWidth: obj.strokeWidth * s, strokeUniform: true });
  }
  const k = len / cur;
  obj.set({ scaleX: obj.scaleX * k, scaleY: obj.scaleY * k });
  obj.setCoords();
  canvas.requestRenderAll();
}

function sizeFields(obj, type) {
  const inMm = state.sizeUnit === 'mm';
  const toUnit = (px) => (inMm ? +(px / DPMM).toFixed(1) : Math.round(px));
  const fromUnit = (v) => (inMm ? v * DPMM : v);
  const attrs = { min: inMm ? 0.5 : 1, step: inMm ? 0.5 : 1 };
  const box = document.createElement('div');
  box.appendChild(field('Unidade de tamanho', select([['mm', 'Milímetros (mm)'], ['px', 'Pixels (300 dpi)']], state.sizeUnit, (v) => {
    state.sizeUnit = v;
    try { localStorage.setItem('ql-size-unit', v); } catch (_) { /* sem storage */ }
    renderProps();
  })));
  if (type === 'line') {
    box.appendChild(field('Comprimento', input('number', toUnit(lineLength(obj)), (v) => setLineLength(obj, fromUnit(v)), attrs)));
  } else {
    box.appendChild(grid(
      field('Largura', input('number', toUnit(obj.getScaledWidth()), (v) => setShapeSize(obj, fromUnit(v), obj.getScaledHeight()), attrs)),
      field('Altura', input('number', toUnit(obj.getScaledHeight()), (v) => setShapeSize(obj, obj.getScaledWidth(), fromUnit(v)), attrs)),
    ));
  }
  return box;
}

function renderProps() {
  const obj = canvas.getActiveObject();
  const body = $('#props-body');
  body.innerHTML = '';
  const single = obj && obj.type !== 'activeSelection';
  $('#props-empty').hidden = !!single;
  body.hidden = !single;
  if (!single) return;
  const type = obj.data?.type || obj.type;

  if (type === 'text') {
    body.appendChild(field('Texto', input('textarea', obj.text, (v) => setProp(obj, 'text', v))));
    body.appendChild(field('Fonte', select(FONTS, obj.fontFamily, async (v) => {
      await document.fonts.load(`${obj.fontWeight} 40px "${v}"`).catch(() => {});
      setProp(obj, 'fontFamily', v);
    })));
    body.appendChild(grid(
      field('Tamanho', input('number', Math.round(obj.fontSize), (v) => setProp(obj, 'fontSize', v), { min: 6 })),
      field('Espaçamento', input('number', obj.lineHeight, (v) => setProp(obj, 'lineHeight', v), { step: 0.05, min: 0.5 })),
    ));
    body.appendChild(toggles([
      { label: '<b>N</b>', title: 'Negrito', active: () => obj.fontWeight === 'bold', click: () => obj.set('fontWeight', obj.fontWeight === 'bold' ? 'normal' : 'bold') },
      { label: '<i>I</i>', title: 'Itálico', active: () => obj.fontStyle === 'italic', click: () => obj.set('fontStyle', obj.fontStyle === 'italic' ? 'normal' : 'italic') },
      { label: '<u>S</u>', title: 'Sublinhado', active: () => obj.underline, click: () => obj.set('underline', !obj.underline) },
      { label: '◐', title: 'Inverter (branco no preto)', active: () => obj.fill === '#fff', click: () => obj.set(obj.fill === '#fff' ? { fill: '#000', backgroundColor: '' } : { fill: '#fff', backgroundColor: '#000' }) },
    ]));
    const fit = field('Reduzir fonte para caber (ao imprimir)', input('checkbox', !!obj.data.fit, (v) => { obj.data.fit = v; }));
    fit.className = 'check';
    fit.prepend(fit.lastChild);
    body.appendChild(fit);
    body.appendChild(toggles(['left', 'center', 'right', 'justify'].map((a, i) => ({
      label: ['⇤', '≡', '⇥', '☰'][i], title: a, active: () => obj.textAlign === a, click: () => obj.set('textAlign', a),
    }))));
  } else if (type === 'barcode' || type === 'qr') {
    const d = obj.data;
    let timer;
    const update = () => { clearTimeout(timer); timer = setTimeout(() => refreshCode(obj), 250); };
    const bind = (key) => (v) => { d[key] = v; update(); };
    body.appendChild(field('Conteúdo', input('textarea', d.value, bind('value'))));
    if (type === 'barcode') {
      body.appendChild(field('Formato', select(BARCODE_FORMATS, d.format, bind('format'))));
      body.appendChild(grid(
        field('Largura barra', input('number', d.module, bind('module'), { min: 1, max: 10 })),
        field('Altura', input('number', d.height, bind('height'), { min: 10 })),
      ));
      body.appendChild(grid(
        field('Texto (px)', input('number', d.fontSize, bind('fontSize'), { min: 8 })),
        field('Mostrar texto', input('checkbox', d.showText, bind('showText'))),
      ));
    } else {
      body.appendChild(grid(
        field('Módulo (px)', input('number', d.cell, bind('cell'), { min: 1, max: 30 })),
        field('Correção', select([['L', 'L 7%'], ['M', 'M 15%'], ['Q', 'Q 25%'], ['H', 'H 30%']], d.ecc, bind('ecc'))),
      ));
    }
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Ajuste o tamanho pela largura de barra/módulo para manter a leitura nítida.';
    body.appendChild(p);
  } else if (type === 'shape' || type === 'line') {
    body.appendChild(sizeFields(obj, type));
    body.appendChild(field('Espessura', input('number', obj.strokeWidth, (v) => setProp(obj, 'strokeWidth', v), { min: 1 })));
    if (type === 'shape') {
      body.appendChild(toggles([
        { label: 'Contorno', active: () => obj.fill === 'transparent', click: () => obj.set('fill', 'transparent') },
        { label: 'Preenchido', active: () => obj.fill === '#000', click: () => obj.set('fill', '#000') },
      ]));
      if (obj.type === 'rect')
        body.appendChild(field('Cantos arredondados', input('number', obj.rx, (v) => setProp(obj, { rx: v, ry: v }), { min: 0 })));
    }
  }

  body.appendChild(grid(
    field('Rotação °', input('number', Math.round(obj.angle), (v) => { obj.rotate(v); obj.setCoords(); canvas.requestRenderAll(); }, { step: 90 })),
    field('Bloquear', input('checkbox', !!obj.lockMovementX, (v) => setProp(obj, {
      lockMovementX: v, lockMovementY: v, lockScalingX: v, lockScalingY: v, lockRotation: v,
    }))),
  ));
}

canvas.on('selection:created', renderProps);
canvas.on('selection:updated', renderProps);
canvas.on('selection:cleared', renderProps);

/* ---------- histórico ---------- */
const history = { stack: [], index: -1, paused: false };

function snapshot() {
  return JSON.stringify(canvas.toJSON(EXTRA_PROPS));
}

function saveHistory() {
  if (history.paused) return;
  renderFields();
  const s = snapshot();
  if (history.stack[history.index] === s) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(s);
  if (history.stack.length > 60) history.stack.shift();
  history.index = history.stack.length - 1;
}

function restore(json) {
  return new Promise((resolve) => {
    history.paused = true;
    canvas.loadFromJSON(json, () => {
      canvas.backgroundColor = '#fff';
      canvas.renderAll();
      history.paused = false;
      renderProps();
      renderFields();
      resolve();
    });
  });
}

function undo() { if (history.index > 0) restore(history.stack[--history.index]); }
function redo() { if (history.index < history.stack.length - 1) restore(history.stack[++history.index]); }

canvas.on('object:added', saveHistory);
canvas.on('object:removed', saveHistory);
canvas.on('object:modified', () => { saveHistory(); renderProps(); });
canvas.on('text:changed', () => {
  const ta = $('#props-body textarea');
  const obj = canvas.getActiveObject();
  if (ta && obj?.text !== undefined) ta.value = obj.text;
  renderFields();
});

/* ---------- barra de ferramentas ---------- */
function active() { return canvas.getActiveObject(); }

function removeSelected() {
  const objs = canvas.getActiveObjects();
  canvas.discardActiveObject();
  objs.forEach((o) => canvas.remove(o));
}

function cloneObject(obj) {
  return new Promise((resolve) => obj.clone((c) => {
    // clone() compartilha o objeto `data` com o original; separa os dois
    [c, ...(c.getObjects?.() || [])].forEach((o) => { if (o.data) o.data = structuredClone(o.data); });
    resolve(c);
  }, EXTRA_PROPS));
}

/** Adiciona um clone (objeto ou seleção múltipla) deslocado de `offset`. */
function insertClone(c, offset) {
  c.set({ left: c.left + offset, top: c.top + offset });
  history.paused = true;
  if (c.type === 'activeSelection') {
    c.canvas = canvas;
    c.forEachObject((o) => canvas.add(o));
    c.setCoords();
  } else {
    canvas.add(c);
  }
  history.paused = false;
  canvas.setActiveObject(c);
  canvas.requestRenderAll();
  saveHistory();
}

async function duplicate() {
  const obj = active();
  if (obj) insertClone(await cloneObject(obj), 20);
}

/* ---------- copiar / colar ---------- */
const CLIP_TYPE = 'application/x-ql570-elementos';
const clipboard = { obj: null, text: '', pastes: 0 };

/** Texto dos elementos selecionados, para colar em outros programas. */
function selectionText(obj) {
  return (obj.getObjects?.() || [obj]).filter((o) => o.data?.type === 'text').map((o) => o.text).join('\n');
}

async function copySelection() {
  const obj = active();
  if (!obj) return false;
  clipboard.text = selectionText(obj);
  clipboard.pastes = 0;
  clipboard.obj = await cloneObject(obj);
  return true;
}

/** Cola os elementos copiados; com `at` o canto superior esquerdo fica nesse ponto. */
async function paste(at) {
  if (!clipboard.obj) return;
  const c = await cloneObject(clipboard.obj);
  if (at) {
    c.set({ left: at.x, top: at.y });
    insertClone(c, 0);
  } else {
    clipboard.pastes++;
    insertClone(c, 20 * clipboard.pastes);
  }
}

/** Copia pelo evento do navegador, para que o Ctrl+V reconheça os elementos depois. */
function copyFromButton() {
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { /* sem suporte */ }
  return ok ? Promise.resolve(true) : copySelection();
}

async function cut() {
  if (await copySelection()) removeSelected();
}

function editorHasFocus() {
  const tag = document.activeElement.tagName;
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active()?.isEditing
    || document.querySelector('dialog[open]'));
}

function onCopy(e, isCut) {
  if (!editorHasFocus() || !active() || !document.getSelection().isCollapsed) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', selectionText(active()));
  e.clipboardData.setData(CLIP_TYPE, '1');
  isCut ? cut() : copySelection();
}

document.addEventListener('copy', (e) => onCopy(e, false));
document.addEventListener('cut', (e) => onCopy(e, true));
document.addEventListener('paste', (e) => {
  if (!editorHasFocus()) return;
  const data = e.clipboardData;
  const image = [...data.files].find((f) => f.type.startsWith('image/'));
  const text = data.getData('text/plain');
  e.preventDefault();
  // elementos copiados do próprio editor têm prioridade sobre o conteúdo externo
  if (clipboard.obj && (data.types.includes(CLIP_TYPE) || (!image && text === clipboard.text))) paste();
  else if (image) addImageFile(image);
  else if (text.trim()) place(newTextbox(text.replace(/\r\n/g, '\n')));
});

$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#btn-del').onclick = removeSelected;
$('#btn-dup').onclick = duplicate;
$('#btn-copy').onclick = () => active() && copyFromButton().then(() => toast('Copiado'));
$('#btn-paste').onclick = () => (clipboard.obj ? paste() : toast('Nada copiado', true));

/* ---------- menu do botão direito ---------- */
const ctxMenu = $('#ctx-menu');
let ctxPoint = null;

function hideContextMenu() { ctxMenu.hidden = true; }

canvas.upperCanvasEl.addEventListener('contextmenu', (e) => {
  if (active()?.isEditing) return;   // menu nativo ao editar texto
  e.preventDefault();
  const target = canvas.findTarget(e, false);
  if (!target) canvas.discardActiveObject();
  else if (!canvas.getActiveObjects().includes(target)) canvas.setActiveObject(target);
  canvas.requestRenderAll();
  ctxPoint = canvas.getPointer(e);
  const has = !!active();
  ctxMenu.querySelectorAll('[data-needs-sel]').forEach((b) => (b.disabled = !has));
  ctxMenu.querySelector('[data-action="paste"]').disabled = !clipboard.obj;
  ctxMenu.hidden = false;
  const { innerWidth: W, innerHeight: H } = window;
  ctxMenu.style.left = `${Math.min(e.clientX, W - ctxMenu.offsetWidth - 4)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, H - ctxMenu.offsetHeight - 4)}px`;
});

const ctxActions = {
  copy: () => copyFromButton(),
  paste: () => paste(ctxPoint),
  duplicate,
  delete: removeSelected,
};
ctxMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  hideContextMenu();
  ctxActions[b.dataset.action]();
});
document.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);
window.addEventListener('resize', hideContextMenu);
$('#canvas-wrap').addEventListener('scroll', hideContextMenu);
$('#btn-front').onclick = () => { active()?.bringToFront(); saveHistory(); };
$('#btn-back').onclick = () => { active()?.sendToBack(); saveHistory(); };
$('#btn-center-h').onclick = () => { const o = active(); if (o) { canvas.viewportCenterObjectH(o); o.setCoords(); saveHistory(); canvas.requestRenderAll(); } };
$('#btn-center-v').onclick = () => { const o = active(); if (o) { canvas.viewportCenterObjectV(o); o.setCoords(); saveHistory(); canvas.requestRenderAll(); } };
$('#zoom').oninput = (e) => setZoom(+e.target.value);

document.addEventListener('keydown', (e) => {
  if (!editorHasFocus()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
  else if (e.key.startsWith('Arrow') && active()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const o = active();
    const dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0;
    const dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
    o.set({ left: o.left + dx, top: o.top + dy });
    o.setCoords();
    canvas.requestRenderAll();
    saveHistory();
  }
});

/* ---------- renderização e impressão ---------- */
function templateVarsUsed() {
  const used = new Set();
  for (const o of canvas.getObjects()) {
    const s = o.data?.type === 'text' ? o.text : o.data?.value;
    if (typeof s === 'string') for (const m of s.matchAll(VAR_RE)) used.add(m[1]);
  }
  return used;
}

function exportPNG() {
  canvas.discardActiveObject();
  canvas.renderAll();
  return canvas.toDataURL({ format: 'png', multiplier: 1 / state.zoom });
}

/** Reduz a fonte até o texto caber na largura sem quebrar linhas extras. */
function fitText(o, maxW, baseSize) {
  const lines = o.text.split('\n').length;
  const lineH = (size) => size * o.lineHeight * o._fontSizeMult;
  const h0 = lineH(baseSize) * lines;
  o.set({ fontSize: baseSize, width: maxW });
  o.initDimensions();
  for (let i = 0; i < 80 && o.fontSize > 6 && (o._textLines.length > lines || o.width > maxW + 0.5); i++) {
    o.set({ fontSize: o.fontSize * 0.95, width: maxW });
    o.initDimensions();
  }
  o.set({ top: o.top + (h0 - lineH(o.fontSize) * lines) / 2 });   // mantém o centro vertical
  o.setCoords();
}

/** Renderiza a etiqueta substituindo {{variáveis}}, depois restaura o original. */
async function renderWith(vars) {
  const saved = [];
  history.paused = true;
  try {
    for (const o of canvas.getObjects()) {
      const t = o.data?.type;
      if (t === 'text') {
        const v = substitute(o.text, vars);
        if (v === o.text && !o.data.fit) continue;
        const prev = { text: o.text, fontSize: o.fontSize, width: o.width, top: o.top };
        saved.push(() => { o.set(prev); o.initDimensions(); o.setCoords(); });
        o.set('text', v);
        if (o.data.fit) fitText(o, prev.width, prev.fontSize);
      } else if (t === 'barcode' || t === 'qr') {
        const v = substitute(o.data.value, vars);
        const el = o.getElement();
        const { scaleX, scaleY } = o;
        saved.push(() => { o.setElement(el); o.set({ scaleX, scaleY }); });
        if (!(await refreshCode(o, v))) throw new Error(`Conteúdo inválido: ${v}`);
      }
    }
    return exportPNG();
  } finally {
    saved.reverse().forEach((f) => f());
    canvas.requestRenderAll();
    history.paused = false;
  }
}

function printOptions() {
  return {
    label: state.label.id,
    rotate: computeDoc().rotate,
    threshold: +$('#threshold').value,
    dither: $('#dither').checked,
    cut: $('#cut').checked,
  };
}

/* ---------- campos ({{variáveis}}) ---------- */
function fieldNames() {
  const builtin = builtinVars(0);
  return [...templateVarsUsed()].filter((v) => !(v in builtin));
}

let fieldsTimer;
function onFieldsChanged() {
  clearTimeout(fieldsTimer);
  fieldsTimer = setTimeout(() => {
    canvas.getObjects().filter((o) => (o.data?.type === 'barcode' || o.data?.type === 'qr')
      && HAS_VAR.test(o.data.value)).forEach((o) => refreshCode(o));
  }, 300);
}

function renderFields() {
  const names = fieldNames();
  const box = $('#fields-body');
  $('#fields').hidden = !names.length;
  const current = [...box.querySelectorAll('input')].map((i) => i.name);
  if (current.join('\n') === names.join('\n')) return;
  box.innerHTML = '';
  for (const name of names) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.name = name;
    inp.value = state.fields[name] ?? '';
    inp.placeholder = `{{${name}}}`;
    inp.addEventListener('input', () => { state.fields[name] = inp.value; onFieldsChanged(); });
    box.appendChild(field(name, inp));
  }
}

/* ---------- renderização / impressão ---------- */
/** Gera as imagens. Com {{n}} cada cópia vira uma imagem distinta. */
async function buildImages(rows) {
  const copies = Math.max(1, +$('#copies').value || 1);
  const start = +$('#n-start').value || 1;
  const usesN = templateVarsUsed().has('n');
  const images = [];
  try {
    if (rows) {
      for (let i = 0; i < rows.length; i++)
        images.push(await renderWith({ ...builtinVars(start + i), ...state.fields, ...rows[i] }));
      return { images, copies };
    }
    if (usesN) {
      for (let i = 0; i < copies; i++)
        images.push(await renderWith({ ...builtinVars(start + i), ...state.fields }));
      return { images, copies: 1 };
    }
    return { images: [await renderWith({ ...builtinVars(start), ...state.fields })], copies };
  } finally {
    onFieldsChanged();   // volta os códigos para os valores de exibição
  }
}

function jobTitle() {
  if (state.currentName) return state.currentName;
  const t = canvas.getObjects().find((o) => o.data?.type === 'text');
  return t ? t.text.slice(0, 40) : 'Etiqueta';
}

async function send(path, rows) {
  const { images, copies } = await buildImages(rows);
  return api(path, { method: 'POST', body: { ...printOptions(), images, copies, title: jobTitle() } });
}

async function doPrint(rows) {
  if (state.printing) return;
  state.printing = true;
  [$('#btn-print'), $('#btn-batch')].forEach((b) => (b.disabled = true));
  $('#btn-print').textContent = 'Imprimindo…';
  try {
    const r = await (await send('/api/print', rows)).json();
    toast(`Impresso: ${r.completed || r.pages} etiqueta(s)`);
    if (templateVarsUsed().has('n') && !rows) {
      // continua a numeração de onde parou
      $('#n-start').value = (+$('#n-start').value || 1) + (+$('#copies').value || 1);
    }
  } catch (e) {
    toast(`Erro: ${e.message}`, true);
  } finally {
    state.printing = false;
    $('#btn-print').textContent = 'Imprimir';
    $('#btn-print').disabled = false;
    $('#btn-batch').disabled = !state.csvRows;
    refreshStatus();
  }
}

$('#btn-print').onclick = () => doPrint(null);
$('#btn-batch').onclick = () => doPrint(state.csvRows);

$('#btn-preview').onclick = async () => {
  try {
    const firstRow = state.csvRows && templateVarsUsed().size ? [state.csvRows[0]] : null;
    const blob = await (await send('/api/preview', firstRow)).blob();
    const img = $('#preview-img');
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    $('#preview-dialog').showModal();
  } catch (e) { toast(`Erro: ${e.message}`, true); }
};

$('#btn-bin').onclick = async () => {
  try {
    const blob = await (await send('/api/job', null)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'etiqueta.bin';
    a.click();
  } catch (e) { toast(`Erro: ${e.message}`, true); }
};

$('#threshold').oninput = (e) => ($('#thr-val').textContent = e.target.value);

/* ---------- CSV ---------- */
function parseCSV(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  const header = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
  return { header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

$('#csv-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) { state.csvRows = null; $('#btn-batch').disabled = true; return; }
  const { header, rows } = parseCSV(await file.text());
  state.csvRows = rows;
  $('#btn-batch').disabled = !rows.length;
  const missing = fieldNames().filter((v) => !header.includes(v));
  $('#csv-info').innerHTML = `${rows.length} linha(s). Colunas: ${header.map((h) => `<code>{{${h}}}</code>`).join(' ')}`
    + (missing.length ? `<br>Sem coluna (usa o valor de Campos): ${missing.join(', ')}` : '');
});

$('#btn-csv-example').onclick = () => {
  const names = fieldNames();
  if (!names.length) return toast('Esta etiqueta não tem {{campos}}', true);
  const esc = (v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = names.join(';') + '\n' + names.map((n) => esc(state.fields[n] ?? '')).join(';') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${state.currentName || 'etiqueta'}.csv`;
  a.click();
};

/* ---------- etiquetas padrão (galeria) ---------- */
/** Cria os objetos de um modelo padrão; coordenadas são frações da etiqueta. */
async function buildObjects(spec, W, H, vars) {
  const sub = (s) => (vars ? substitute(s, vars) : s);
  const objs = [];
  for (const it of spec.items) {
    if (it.t === 'text') {
      objs.push(new fabric.Textbox(sub(it.text), {
        left: it.x * W, top: it.y * H, width: it.w * W, fontSize: Math.round(it.size * H),
        fontFamily: it.font || 'Inter', fontWeight: it.bold ? 'bold' : 'normal',
        textAlign: it.align || 'left', fill: it.invert ? '#fff' : '#000', lineHeight: 1.1,
        data: { type: 'text', fit: it.fit !== false },
      }));
      if (vars && it.fit !== false) fitText(objs.at(-1), it.w * W, Math.round(it.size * H));
    } else if (it.t === 'rect') {
      const sw = it.fill ? 0 : (it.sw || 6);
      objs.push(new fabric.Rect({
        left: it.x * W, top: it.y * H, width: it.w * W - sw, height: it.h * H - sw,
        fill: it.fill ? '#000' : 'transparent', stroke: it.fill ? null : '#000', strokeWidth: sw,
        rx: it.r || 0, ry: it.r || 0, strokeUniform: true, data: { type: 'shape' },
      }));
    } else if (it.t === 'line') {
      objs.push(new fabric.Line([it.x1 * W, it.y1 * H, it.x2 * W, it.y2 * H], {
        stroke: '#000', strokeWidth: it.sw || 4, data: { type: 'line' },
      }));
    } else if (it.t === 'barcode' || it.t === 'qr') {
      const shown = substitute(it.value, vars || { ...builtinVars(1), ...spec.fields });
      let d;
      if (it.t === 'barcode') {
        d = { type: 'barcode', value: it.value, format: it.format || 'CODE128', module: it.module || 3,
              height: Math.round(it.h * H), showText: it.text !== false, fontSize: Math.round(H * 0.07) };
      } else {
        const q = qrcode(0, 'M');
        q.addData(shown);
        q.make();
        d = { type: 'qr', value: it.value, ecc: 'M', cell: Math.max(1, Math.floor(it.size * H / q.getModuleCount())) };
      }
      let el;
      try { el = codeElement(d, shown); } catch (_) { el = barcodeCanvas({ ...d, format: 'CODE128' }, shown); }
      const img = new fabric.Image(await loadImage(el.toDataURL()), { imageSmoothing: false, data: d });
      img.set({ left: it.x === 'center' ? (W - img.width) / 2 : it.x * W, top: it.y * H });
      objs.push(img);
    }
  }
  return objs;
}

async function loadFonts() {
  await Promise.all(['Inter', 'Oswald', 'Bebas Neue', 'Roboto Slab', 'Roboto Mono'].flatMap((f) =>
    ['400', '700'].map((w) => document.fonts.load(`${w} 40px "${f}"`).catch(() => {}))));
}

async function specThumb(spec) {
  const label = state.labels.find((l) => l.id === spec.label);
  const d = docFor(label, spec.orientation, spec.length_mm || 90);
  const s = Math.min(260 / d.w, 150 / d.h);
  const sc = new fabric.StaticCanvas(null, { width: d.w * s, height: d.h * s, backgroundColor: '#fff' });
  sc.setZoom(s);
  for (const o of await buildObjects(spec, d.w, d.h, { ...builtinVars(1), ...spec.fields })) sc.add(o);
  sc.renderAll();
  const url = sc.toDataURL({ format: 'png' });
  sc.dispose();
  return url;
}

async function applyLayoutFrom(data) {
  $('#preset-select').value = '';
  $('#btn-preset-del').disabled = true;
  setLabel(data.label, false);
  if (data.orientation) $('#orientation').value = data.orientation;
  if (data.length_mm) $('#length-mm').value = data.length_mm;
  applyLayout();
}

function resetHistory() {
  history.stack = [];
  history.index = -1;
  saveHistory();
}

async function applySpec(spec) {
  await applyLayoutFrom(spec);
  await loadFonts();
  history.paused = true;
  canvas.clear();
  canvas.backgroundColor = '#fff';
  state.fields = { ...spec.fields };
  (await buildObjects(spec, state.docW, state.docH)).forEach((o) => canvas.add(o));
  history.paused = false;
  canvas.requestRenderAll();
  state.currentName = spec.name;
  $('#fields-body').innerHTML = '';
  resetHistory();
  renderProps();
}

function card({ thumb, title, subtitle, onOpen, onDelete }) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = `<div class="thumb">${thumb ? `<img alt="">` : '<span>sem miniatura</span>'}</div>
    <div class="card-text"><strong></strong><small></small></div>`;
  if (thumb) c.querySelector('img').src = thumb;
  c.querySelector('strong').textContent = title;
  c.querySelector('small').textContent = subtitle;
  c.onclick = onOpen;
  if (onDelete) {
    const x = document.createElement('button');
    x.className = 'card-del';
    x.title = 'Excluir';
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); onDelete(); };
    c.appendChild(x);
  }
  return c;
}

const labelName = (id) => state.labels.find((l) => l.id === id)?.name || id;

async function showDefaults() {
  const box = $('#gallery-body');
  box.innerHTML = '<p class="hint">Carregando…</p>';
  state.defaults ??= await (await api('/api/defaults')).json();
  await loadFonts();
  box.innerHTML = '';
  const byCat = {};
  state.defaults.forEach((s) => (byCat[s.category] ??= []).push(s));
  for (const [cat, specs] of Object.entries(byCat)) {
    const h = document.createElement('h3');
    h.textContent = cat;
    const grid = document.createElement('div');
    grid.className = 'cards';
    box.append(h, grid);
    for (const spec of specs) {
      spec.thumb ??= await specThumb(spec);
      grid.appendChild(card({
        thumb: spec.thumb, title: spec.name, subtitle: `${labelName(spec.label)} — ${spec.description}`,
        onOpen: async () => {
          if (canvas.getObjects().length > 1 && !confirm('Substituir a etiqueta atual?')) return;
          $('#gallery').close();
          await applySpec(spec);
          toast(`"${spec.name}" aberta — preencha os Campos`);
        },
      }));
    }
  }
}

async function showMine() {
  const box = $('#gallery-body');
  const list = await (await api('/api/templates')).json();
  box.innerHTML = list.length ? '' : '<p class="hint">Nenhum modelo salvo ainda. Use “Salvar modelo”.</p>';
  const grid = document.createElement('div');
  grid.className = 'cards';
  box.appendChild(grid);
  for (const t of list) {
    grid.appendChild(card({
      thumb: t.thumb, title: t.name, subtitle: labelName(t.label),
      onOpen: async () => { $('#gallery').close(); await openTemplate(t.name); },
      onDelete: async () => {
        if (!confirm(`Excluir o modelo "${t.name}"?`)) return;
        await api(`/api/templates/${encodeURIComponent(t.name)}`, { method: 'DELETE' });
        showMine();
      },
    }));
  }
}

function galleryTab(tab) {
  document.querySelectorAll('#gallery .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  (tab === 'mine' ? showMine : showDefaults)().catch((e) => toast(e.message, true));
}

$('#btn-gallery').onclick = () => { $('#gallery').showModal(); galleryTab('defaults'); };
document.querySelectorAll('#gallery .tabs button').forEach((b) => (b.onclick = () => galleryTab(b.dataset.tab)));

/* ---------- modelos do usuário ---------- */
async function openTemplate(name) {
  const data = await (await api(`/api/templates/${encodeURIComponent(name)}`)).json();
  await applyLayoutFrom(data);
  await loadFonts();
  state.fields = { ...(data.fields || {}) };
  $('#fields-body').innerHTML = '';
  await restore(data.canvas);
  state.currentName = name;
  resetHistory();
  onFieldsChanged();
  toast(`Modelo "${name}" aberto`);
}

$('#btn-tpl-save').onclick = async () => {
  const name = prompt('Nome do modelo:', state.currentName || '');
  if (!name) return;
  canvas.discardActiveObject();
  canvas.renderAll();
  const data = {
    label: state.label.id, orientation: $('#orientation').value, length_mm: +$('#length-mm').value,
    fields: state.fields, canvas: canvas.toJSON(EXTRA_PROPS),
    thumb: canvas.toDataURL({ format: 'png', multiplier: Math.min(260 / state.docW, 150 / state.docH) / state.zoom }),
  };
  try {
    await api('/api/templates', { method: 'PUT', body: { name, data } });
    state.currentName = name;
    toast('Modelo salvo');
  } catch (e) { toast(e.message, true); }
};

$('#btn-new').onclick = () => {
  if (canvas.getObjects().length && !confirm('Descartar a etiqueta atual?')) return;
  canvas.clear();
  canvas.backgroundColor = '#fff';
  state.currentName = '';
  state.fields = {};
  saveHistory();
};

/* ---------- predefinições ---------- */
async function loadPresets(selected = '') {
  state.presets = await (await api('/api/presets')).json();
  const sel = $('#preset-select');
  sel.innerHTML = '<option value="">— escolha uma predefinição —</option>';
  const groups = [['Padrão', true], ['Minhas', false]];
  for (const [title, builtin] of groups) {
    const items = state.presets.filter((p) => p.builtin === builtin);
    if (!items.length) continue;
    const og = document.createElement('optgroup');
    og.label = title;
    items.forEach((p) => og.appendChild(new Option(p.name, p.name, false, p.name === selected)));
    sel.appendChild(og);
  }
  $('#btn-preset-del').disabled = !state.presets.find((p) => p.name === sel.value && !p.builtin);
}

$('#preset-select').onchange = (e) => {
  const p = state.presets.find((x) => x.name === e.target.value);
  $('#btn-preset-del').disabled = !p || p.builtin;
  if (!p) return;
  $('#orientation').value = p.orientation;
  $('#length-mm').value = p.length_mm;
  $('#threshold').value = p.threshold;
  $('#thr-val').textContent = p.threshold;
  $('#dither').checked = p.dither;
  $('#cut').checked = p.cut;
  $('#copies').value = p.copies;
  setLabel(p.label);
};

$('#btn-preset-save').onclick = async () => {
  const name = prompt('Nome da predefinição:');
  if (!name) return;
  if (state.presets.find((p) => p.name === name && p.builtin)) return toast('Já existe uma predefinição padrão com esse nome', true);
  try {
    await api('/api/presets', { method: 'PUT', body: {
      name, label: state.label.id, orientation: $('#orientation').value, length_mm: +$('#length-mm').value,
      threshold: +$('#threshold').value, dither: $('#dither').checked, cut: $('#cut').checked,
      copies: +$('#copies').value || 1,
    } });
    await loadPresets(name);
    toast('Predefinição salva');
  } catch (e) { toast(e.message, true); }
};

$('#btn-preset-del').onclick = async () => {
  const name = $('#preset-select').value;
  if (!name || !confirm(`Excluir a predefinição "${name}"?`)) return;
  await api(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadPresets();
};

/* ---------- histórico ---------- */
async function showHistory() {
  const box = $('#history-body');
  const list = await (await api('/api/history')).json();
  box.innerHTML = list.length ? '' : '<p class="hint">Nada impresso ainda.</p>';
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<img alt=""><div><strong></strong><small></small></div><button class="ghost">Reimprimir</button>`;
    row.querySelector('img').src = h.thumb;
    row.querySelector('strong').textContent = h.title || 'Etiqueta';
    const when = new Date(h.ts * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    row.querySelector('small').textContent = `${when} · ${labelName(h.label)} · ${h.printed} etiqueta(s)`;
    row.querySelector('button').onclick = async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = 'Imprimindo…';
      try {
        const r = await (await api(`/api/history/${h.id}/reprint`, { method: 'POST' })).json();
        toast(`Reimpresso: ${r.completed || r.pages} etiqueta(s)`);
        showHistory();
      } catch (err) {
        toast(`Erro: ${err.message}`, true);
        b.disabled = false;
        b.textContent = 'Reimprimir';
      }
    };
    box.appendChild(row);
  }
}

$('#btn-history').onclick = () => { $('#history-dialog').showModal(); showHistory().catch((e) => toast(e.message, true)); };
$('#btn-history-clear').onclick = async () => {
  if (!confirm('Apagar todo o histórico?')) return;
  await api('/api/history', { method: 'DELETE' });
  showHistory();
};

/* ---------- status da impressora ---------- */
async function refreshStatus() {
  if (state.printing || document.hidden) return;
  const el = $('#status');
  try {
    const s = await (await api('/api/status')).json();
    state.status = s;
    if (s.busy) {
      el.className = 'status warn';
      $('#status-text').textContent = 'Imprimindo…';
    } else if (!s.online) {
      el.className = 'status off';
      $('#status-text').textContent = s.error;
    } else if (s.errors.length) {
      el.className = 'status warn';
      $('#status-text').textContent = s.errors.join(', ');
    } else {
      el.className = 'status on';
      const l = state.labels.find((x) => x.id === s.detected_label);
      $('#status-text').textContent = `Pronta — ${l ? l.name : `${s.media_width_mm} mm ${s.media_type}`}`;
    }
    el.title = s.device || '';
  } catch (e) {
    el.className = 'status off';
    $('#status-text').textContent = 'Servidor indisponível';
  }
}

$('#status').onclick = refreshStatus;
$('#btn-detect').onclick = async () => {
  await refreshStatus();
  const id = state.status?.detected_label;
  if (id) { setLabel(id); toast('Mídia detectada'); }
  else toast(state.status?.error || 'Não foi possível detectar a mídia', true);
};

/* ---------- tema claro / escuro ---------- */
const THEMES = [['', '◐ Automático'], ['light', '☀ Claro'], ['dark', '☾ Escuro']];

function setTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('#btn-theme').textContent = THEMES.find(([t]) => t === theme)[1];
  try { theme ? localStorage.setItem('ql-theme', theme) : localStorage.removeItem('ql-theme'); } catch (_) { /* sem storage */ }
}

$('#btn-theme').onclick = () => {
  const i = THEMES.findIndex(([t]) => t === (document.documentElement.dataset.theme || ''));
  setTheme(THEMES[(i + 1) % THEMES.length][0]);
};
setTheme(document.documentElement.dataset.theme || '');

/* ---------- inicialização ---------- */
function setLabel(id, layout = true) {
  state.label = state.labels.find((l) => l.id === id) || state.labels[0];
  $('#label-select').value = state.label.id;
  if (state.label.kind === 'round') $('#orientation').value = 'portrait';
  try { localStorage.setItem('ql-label', state.label.id); } catch (_) { /* sem storage */ }
  if (layout) applyLayout();
}

$('#label-select').onchange = (e) => setLabel(e.target.value);
$('#orientation').onchange = () => applyLayout();
$('#length-mm').oninput = () => applyLayout(false);
$('#length-mm').onchange = () => applyLayout();
$('#n-start').oninput = onFieldsChanged;
window.addEventListener('resize', () => applyLayout());

(async function init() {
  state.labels = await (await api('/api/labels')).json();
  const groups = { endless: 'Fita contínua', die_cut: 'Pré-cortadas', round: 'Redondas' };
  for (const [kind, title] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = title;
    state.labels.filter((l) => l.kind === kind).forEach((l) => og.appendChild(new Option(l.name, l.id)));
    $('#label-select').appendChild(og);
  }
  let saved = null;
  try { saved = localStorage.getItem('ql-label'); } catch (_) { /* sem storage */ }
  setLabel(saved || '62');
  await loadFonts();
  place(newTextbox('Olá, QL-570!', { fontWeight: 'bold' }));
  canvas.discardActiveObject();
  resetHistory();
  loadPresets().catch((e) => toast(e.message, true));
  refreshStatus();
  setInterval(refreshStatus, 10000);
})();
