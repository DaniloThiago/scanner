'use strict';

/*
 * Scanner (PWA)
 * - Câmera/galeria → ajuste das bordas (detecção automática com OpenCV.js) → filtro → página.
 * - Páginas ficam no IndexedDB (sobrevivem ao fechar o app).
 * - PDF é montado aqui mesmo (JPEG embutido), sem bibliotecas.
 * - "Enviar" usa o menu de compartilhar do sistema (WhatsApp, e-mail, Salvar em Arquivos…).
 */

const $ = (s) => document.querySelector(s);
const MAX_SRC = 2400;   // maior lado da foto ao carregar
const MAX_OUT = 2000;   // maior lado da página final
const JPEG_Q = 0.85;
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

const state = { base: null, pages: [], format: 'pdf', pdfFile: null, imageFiles: [] };
// pages: [{ bytes: Uint8Array (JPEG), w, h, url }]

/* =================== Utilitários =================== */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function busy(on, text = 'Processando…') {
  $('#busyText').textContent = text;
  $('#busy').hidden = !on;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function newBaseName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Documento_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function freeCanvas(c) {
  if (c) { c.width = 0; c.height = 0; } // libera memória rápido (importante no iPhone)
}
function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}
function canvasToBlob(c) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', JPEG_Q));
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagem inválida')); };
    img.src = url;
  });
}

/** Desenha a foto num canvas, reduzindo se for muito grande (o navegador já aplica a rotação EXIF). */
function imageToCanvas(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* =================== Armazenamento (IndexedDB) =================== */

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('scanner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => { db.close(); res(r.result); };
    r.onerror = () => { db.close(); rej(r.error); };
  });
}

async function persist() {
  try {
    await idbSet('doc', { base: state.base, pages: state.pages.map(({ bytes, w, h }) => ({ bytes, w, h })) });
  } catch (e) {
    console.warn('Falha ao salvar', e);
  }
}

async function restore() {
  try {
    const d = await idbGet('doc');
    if (d && d.pages && d.pages.length) {
      state.base = d.base;
      state.pages = d.pages.map((p) => {
        const bytes = new Uint8Array(p.bytes);
        return { bytes, w: p.w, h: p.h, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) };
      });
    }
  } catch (e) {
    console.warn('Falha ao carregar', e);
  }
}

/* =================== PDF =================== */

/** Monta um PDF com uma imagem JPEG por página (largura A4 = 595pt). */
function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    len += b.length;
  };
  const obj = (id, parts) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };

  const n = pages.length;
  const total = 2 + 3 * n;
  push('%PDF-1.4\n');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`]);

  pages.forEach((p, i) => {
    const pid = 3 + 3 * i, cid = pid + 1, iid = pid + 2;
    const W = 595;
    const H = (595 * p.h / p.w).toFixed(2);
    obj(pid, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`]);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(cid, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    obj(iid, [
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`,
      p.bytes,
      '\nendstream',
    ]);
  });

  const xref = len;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) x += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(`${x}trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/* =================== Documento =================== */

async function addPage(blob, w, h) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!state.base) state.base = newBaseName();
  state.pages.push({ bytes, w, h, url: URL.createObjectURL(blob) });
}

/**
 * Arquivos prontos ANTES do toque em "Enviar": o iPhone só abre o menu de compartilhar
 * se a chamada acontecer logo após o toque, sem processamento no meio.
 */
function rebuildOutputs() {
  if (!state.pages.length) {
    state.pdfFile = null;
    state.imageFiles = [];
    return;
  }
  state.pdfFile = new File([buildPdf(state.pages)], `${state.base}.pdf`, { type: 'application/pdf' });
  state.imageFiles = state.pages.map(
    (p, i) => new File([p.bytes], `${state.base}_pag${i + 1}.jpg`, { type: 'image/jpeg' })
  );
}

function documentChanged(scrollTo) {
  rebuildOutputs();
  render(scrollTo);
  persist();
}

function deleteCurrentPage() {
  const i = currentIndex();
  if (!state.pages[i] || !confirm('Excluir esta página?')) return;
  URL.revokeObjectURL(state.pages[i].url);
  state.pages.splice(i, 1);
  if (!state.pages.length) state.base = null;
  documentChanged(Math.min(i, state.pages.length - 1));
}

function newDocument() {
  if (!confirm('Começar um novo documento?\nAs páginas atuais serão descartadas.')) return;
  state.pages.forEach((p) => URL.revokeObjectURL(p.url));
  state.pages = [];
  state.base = null;
  documentChanged();
}

/* =================== Tela principal =================== */

function render(scrollTo) {
  const has = state.pages.length > 0;
  $('#empty').hidden = has;
  $('#result').hidden = !has;
  $('#share').hidden = !has;
  $('#scanLabel').textContent = has ? 'Adicionar páginas' : 'Escanear documento';

  const box = $('#pages');
  box.replaceChildren(...state.pages.map((p, i) => {
    const d = document.createElement('div');
    d.className = 'page';
    const img = new Image();
    img.src = p.url;
    img.alt = `Página ${i + 1}`;
    d.append(img);
    return d;
  }));

  if (has && scrollTo != null && scrollTo >= 0) {
    requestAnimationFrame(() => {
      box.scrollLeft = scrollTo * box.clientWidth;
      updatePageLabel();
    });
  }
  updatePageLabel();
  updateFormatUi();
}

function currentIndex() {
  const box = $('#pages');
  return box.clientWidth ? clamp(Math.round(box.scrollLeft / box.clientWidth), 0, state.pages.length - 1) : 0;
}

function updatePageLabel() {
  const n = state.pages.length;
  $('#pageLabel').textContent = n <= 1 ? '1 página' : `Página ${currentIndex() + 1} de ${n}`;
}

function updateFormatUi() {
  document.querySelectorAll('.toggle button').forEach((b) => b.classList.toggle('on', b.dataset.format === state.format));
  $('#downloadLabel').textContent = state.format === 'pdf' ? 'Baixar PDF' : 'Baixar imagens';
}

function filesToSend() {
  return state.format === 'pdf' ? (state.pdfFile ? [state.pdfFile] : []) : state.imageFiles;
}

async function sendFiles() {
  const files = filesToSend();
  if (!files.length) return;
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Não foi possível compartilhar');
    }
  } else {
    downloadFiles(files);
    toast('Este navegador não compartilha arquivos; eles foram baixados.');
  }
}

function downloadFiles(files) {
  files.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, i * 400);
  });
}

/* =================== Processamento de imagem =================== */

/** Ordena 4 pontos como: topo-esq, topo-dir, baixo-dir, baixo-esq. */
function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

function defaultCorners(c) {
  const mx = c.width * 0.04, my = c.height * 0.04;
  return [
    { x: mx, y: my }, { x: c.width - mx, y: my },
    { x: c.width - mx, y: c.height - my }, { x: mx, y: c.height - my },
  ];
}

function fullCorners(c) {
  return [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }];
}

/** Procura o maior quadrilátero da foto (a folha). Retorna null se não achar. */
function detectCorners(canvas) {
  if (!cvReady) return null;
  const cv = window.cv;
  const scale = 500 / Math.max(canvas.width, canvas.height);
  const small = makeCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
  ctx2d(small).drawImage(canvas, 0, 0, small.width, small.height);

  const src = cv.imread(small);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 40, 120);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, k);
    k.delete();
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const minArea = small.width * small.height * 0.15;
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx);
        if (area > minArea && area > bestArea) {
          bestArea = area;
          best = [];
          for (let j = 0; j < 4; j++) {
            best.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
          }
        }
      }
      approx.delete();
      c.delete();
    }
    if (!best) return null;
    // a borda detectada fica um pouco para fora da folha; puxa os cantos ~1,5% para dentro
    const cx = best.reduce((s, p) => s + p.x, 0) / 4;
    const cy = best.reduce((s, p) => s + p.y, 0) / 4;
    return orderCorners(best.map((p) => ({ x: p.x + (cx - p.x) * 0.015, y: p.y + (cy - p.y) * 0.015 })));
  } catch (e) {
    console.warn('Detecção falhou', e);
    return null;
  } finally {
    src.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete();
    freeCanvas(small);
  }
}

/** Coeficientes da transformação quadrado unitário → quadrilátero (Heckbert). */
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y,
    g, h,
  };
}

/** Corrige a perspectiva: recorta o quadrilátero e "estica" para um retângulo. */
function warp(src, q) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * s));
  H = Math.max(1, Math.round(H * s));

  const sw = src.width, sh = src.height;
  const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H);
  const octx = ctx2d(out);
  const oi = octx.createImageData(W, H);
  const od = oi.data;
  const m = squareToQuad(q);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const den = m.g * u + m.h * v + 1;
      let fxp = (m.a * u + m.b * v + m.c) / den - 0.5;
      let fyp = (m.d * u + m.e * v + m.f) / den - 0.5;
      fxp = clamp(fxp, 0, sw - 1);
      fyp = clamp(fyp, 0, sh - 1);
      const x0 = fxp | 0, y0 = fyp | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = fxp - x0, fy = fyp - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        od[o + c] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  octx.putImageData(oi, 0, 0);
  return out;
}

function rotate90(c) {
  const out = makeCanvas(c.height, c.width);
  const ctx = ctx2d(out);
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(c, 0, 0);
  freeCanvas(c);
  return out;
}

function percentile(hist, total, p) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * p) return i;
  }
  return 255;
}

/** Filtros: original, melhorado (fundo mais branco), cinza e P&B (limiar adaptativo). */
function applyFilter(src, filter) {
  const out = makeCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.drawImage(src, 0, 0);
  if (filter === 'original') return out;

  const w = out.width, h = out.height, n = w * h;
  const im = ctx.getImageData(0, 0, w, h);
  const d = im.data;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;

  if (filter === 'bw') {
    // Limiar adaptativo (Bradley): compara cada pixel com a média da vizinhança.
    const W1 = w + 1;
    const integ = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
      }
    }
    const half = Math.max(8, Math.round(Math.max(w, h) / 32));
    const T = 0.15;
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - half), yb = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - half), xb = Math.min(w - 1, x + half);
        const count = (xb - xa + 1) * (yb - ya + 1);
        const sum = integ[(yb + 1) * W1 + xb + 1] - integ[ya * W1 + xb + 1] - integ[(yb + 1) * W1 + xa] + integ[ya * W1 + xa];
        const v = gray[y * w + x] * count <= sum * (1 - T) ? 0 : 255;
        const j = (y * w + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = v;
      }
    }
  } else {
    // Estica o contraste: tons escuros mais escuros, papel mais branco.
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    const lo = percentile(hist, n, 0.01);
    const hi = Math.max(lo + 1, percentile(hist, n, 0.9));
    const k = 255 / (hi - lo);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (filter === 'gray') {
        d[j] = d[j + 1] = d[j + 2] = (gray[i] - lo) * k;
      } else {
        d[j] = (d[j] - lo) * k;
        d[j + 1] = (d[j + 1] - lo) * k;
        d[j + 2] = (d[j + 2] - lo) * k;
      }
    }
  }
  ctx.putImageData(im, 0, 0);
  return out;
}

/* =================== Editor =================== */

const ed = {
  queue: [], total: 0, index: 0, firstNew: 0, added: 0,
  src: null, corners: null, warped: null, result: null,
  step: 'crop', filter: 'enhance', scale: 1, drag: null,
};

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  Object.assign(ed, { queue: files, total: files.length, index: 0, firstNew: state.pages.length, added: 0 });
  $('#editor').hidden = false;
  await loadNext();
}

async function loadNext() {
  const file = ed.queue.shift();
  if (!file) return closeEditor();
  ed.index++;
  busy(true, 'Carregando imagem…');
  await nextFrame();
  try {
    const img = await loadImage(file);
    freeCanvas(ed.src);
    ed.src = imageToCanvas(img, MAX_SRC);
    ed.corners = detectCorners(ed.src) || defaultCorners(ed.src);
    showCropStep();
  } catch (e) {
    console.warn(e);
    toast('Não foi possível abrir a imagem');
    busy(false);
    return loadNext();
  }
  busy(false);
}

function closeEditor() {
  $('#editor').hidden = true;
  freeCanvas(ed.src); freeCanvas(ed.warped); freeCanvas(ed.result);
  ed.src = ed.warped = ed.result = null;
  ed.queue = [];
  if (ed.added > 0) {
    documentChanged(ed.firstNew);
    if (ed.firstNew > 0) toast(`${ed.added} página(s) adicionada(s)`);
  }
}

function stepTitle(text) {
  return ed.total > 1 ? `${text} (${ed.index}/${ed.total})` : text;
}

function showCropStep() {
  ed.step = 'crop';
  $('#edTitle').textContent = stepTitle('Ajustar bordas');
  $('#edBack').textContent = 'Cancelar';
  $('#edNext').textContent = 'Avançar';
  $('#cropTools').hidden = false;
  $('#filterTools').hidden = true;
  $('#edHint').hidden = false;
  layoutStage(ed.src);
  drawOverlay();
}

async function applyCrop() {
  busy(true, 'Recortando…');
  await nextFrame();
  freeCanvas(ed.warped);
  ed.warped = warp(ed.src, orderCorners(ed.corners));
  ed.filter = 'enhance';
  showFilterStep();
  busy(false);
}

function showFilterStep() {
  ed.step = 'filter';
  $('#edTitle').textContent = stepTitle('Filtros');
  $('#edBack').textContent = 'Voltar';
  $('#edNext').textContent = 'Concluir';
  $('#cropTools').hidden = true;
  $('#filterTools').hidden = false;
  $('#edHint').hidden = true;
  renderFiltered();
}

function renderFiltered() {
  freeCanvas(ed.result);
  ed.result = applyFilter(ed.warped, ed.filter);
  document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === ed.filter));
  layoutStage(ed.result);
  drawOverlay();
}

async function finishPage() {
  busy(true, 'Salvando página…');
  await nextFrame();
  try {
    const blob = await canvasToBlob(ed.result);
    await addPage(blob, ed.result.width, ed.result.height);
    ed.added++;
  } catch (e) {
    console.warn(e);
    toast('Não foi possível salvar a página');
  }
  busy(false);
  await loadNext();
}

/** Encaixa a imagem na área do editor. */
function layoutStage(source) {
  const r = $('#edStage').getBoundingClientRect();
  const pad = 24;
  const s = Math.min((r.width - pad * 2) / source.width, (r.height - pad * 2) / source.height);
  const w = Math.max(1, Math.round(source.width * s));
  const h = Math.max(1, Math.round(source.height * s));
  const left = Math.round((r.width - w) / 2) + 'px';
  const top = Math.round((r.height - h) / 2) + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const c = $('#edCanvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  Object.assign(c.style, { width: w + 'px', height: h + 'px', left, top });
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);

  const o = $('#edOverlay');
  Object.assign(o.style, { width: w + 'px', height: h + 'px', left, top });
  o.setAttribute('viewBox', `0 0 ${w} ${h}`);
  ed.scale = s;
}

function drawOverlay() {
  const o = $('#edOverlay');
  if (ed.step !== 'crop') { o.innerHTML = ''; return; }
  const pts = ed.corners.map((p) => [p.x * ed.scale, p.y * ed.scale]);
  o.innerHTML =
    `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="rgba(138,180,248,.18)" stroke="#8ab4f8" stroke-width="2"/>` +
    pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="12" fill="#fff" stroke="#1e6fd9" stroke-width="3"/>`).join('');
}

function pointerToImage(e) {
  const r = $('#edCanvas').getBoundingClientRect();
  return { x: (e.clientX - r.left) / ed.scale, y: (e.clientY - r.top) / ed.scale };
}

function setupEditorEvents() {
  const stage = $('#edStage');
  stage.addEventListener('pointerdown', (e) => {
    if (ed.step !== 'crop') return;
    const p = pointerToImage(e);
    let best = -1, bestDist = Infinity;
    ed.corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y) * ed.scale;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (bestDist < 56) {
      ed.drag = best;
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (ed.drag == null) return;
    const p = pointerToImage(e);
    ed.corners[ed.drag] = { x: clamp(p.x, 0, ed.src.width), y: clamp(p.y, 0, ed.src.height) };
    drawOverlay();
  });
  const end = () => { ed.drag = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  $('#edBack').addEventListener('click', () => {
    if (ed.step === 'filter') showCropStep();
    else { ed.queue = []; closeEditor(); }
  });
  $('#edNext').addEventListener('click', () => (ed.step === 'crop' ? applyCrop() : finishPage()));
  $('#edAuto').addEventListener('click', () => {
    if (!cvReady) { toast('A detecção automática ainda está carregando. Tente em alguns segundos.'); return; }
    const found = detectCorners(ed.src);
    if (found) { ed.corners = found; drawOverlay(); } else toast('Não encontrei as bordas. Ajuste os cantos manualmente.');
  });
  $('#edFull').addEventListener('click', () => { ed.corners = fullCorners(ed.src); drawOverlay(); });
  document.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', async () => {
      ed.filter = b.dataset.filter;
      busy(true, 'Aplicando filtro…');
      await nextFrame();
      renderFiltered();
      busy(false);
    })
  );
  $('#edRotate').addEventListener('click', async () => {
    busy(true, 'Girando…');
    await nextFrame();
    ed.warped = rotate90(ed.warped);
    renderFiltered();
    busy(false);
  });
  window.addEventListener('resize', () => {
    if ($('#editor').hidden) return;
    layoutStage(ed.step === 'crop' ? ed.src : ed.result);
    drawOverlay();
  });
}

/* =================== OpenCV (detecção de bordas) =================== */

let cvReady = false;
function loadOpenCV() {
  const s = document.createElement('script');
  s.src = OPENCV_URL;
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.onload = async () => {
    try {
      if (window.cv instanceof Promise) window.cv = await window.cv;
      const t0 = Date.now();
      while (!(window.cv && window.cv.Mat)) {
        if (Date.now() - t0 > 30000) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      cvReady = true;
      // se o editor estiver aberto com os cantos padrão, tenta detectar agora
      if (!$('#editor').hidden && ed.step === 'crop' && ed.src) {
        const found = detectCorners(ed.src);
        if (found) { ed.corners = found; drawOverlay(); }
      }
    } catch (e) {
      console.warn('OpenCV indisponível', e);
    }
  };
  document.head.append(s);
}

/* =================== Início =================== */

function setupMainEvents() {
  const onPick = (input) => input.addEventListener('change', () => {
    const files = input.files;
    openFiles(files).finally(() => (input.value = ''));
  });
  onPick($('#inCamera'));
  onPick($('#inGallery'));

  $('#pages').addEventListener('scroll', updatePageLabel, { passive: true });
  $('#btnDelete').addEventListener('click', deleteCurrentPage);
  $('#btnNew').addEventListener('click', newDocument);
  $('#btnSend').addEventListener('click', sendFiles);
  $('#btnDownload').addEventListener('click', () => downloadFiles(filesToSend()));
  document.querySelectorAll('.toggle button').forEach((b) =>
    b.addEventListener('click', () => { state.format = b.dataset.format; updateFormatUi(); })
  );
}

async function init() {
  setupMainEvents();
  setupEditorEvents();
  await restore();
  rebuildOutputs();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setTimeout(loadOpenCV, 300);
}

init();
