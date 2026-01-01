import './style.css';
import Tesseract from 'tesseract.js';

/* -------------------- Types -------------------- */

interface HotWheelsEntry {
  Number: string;
  Name: string;
  Year: string;
  Color: string;
}

/* -------------------- DOM -------------------- */

const select = document.getElementById('videoSource') as HTMLSelectElement;
const canvas = document.getElementById('outputCanvas') as HTMLCanvasElement;
const tesseractCanvas = document.getElementById('tesseractCanvas') as HTMLCanvasElement;

const toyNumberCell = document.getElementById('toyNumber')!;
const toyNameCell = document.getElementById('toyName')!;
const toyColorCell = document.getElementById('toyColor')!;
const toyYearCell = document.getElementById('toyYear')!;

const ctx = canvas.getContext('2d')!;
const tctx = tesseractCanvas.getContext('2d')!;

/* -------------------- Constants -------------------- */

const GUIDE_WIDTH = 100;
const GUIDE_HEIGHT = 40;

const OCR_INTERVAL = 750;
const CODE_REGEX = /^[A-Z0-9]{3,5}-[A-Z0-9]{3,5}$/;

/* -------------------- State -------------------- */

let capture: ImageCapture | null = null;
let worker: Tesseract.Worker | null = null;
let lastOcrTime = 0;

let hotwheelsData: HotWheelsEntry[] = [];
let currentEntry: HotWheelsEntry | null = null;

/* -------------------- Startup -------------------- */

await ensurePermission();
await loadHotWheelsData();
await populateVideoSources();
await startSelectedDevice();
await initTesseract();
startRenderLoop();

select.addEventListener('change', startSelectedDevice);

/* -------------------- Data -------------------- */

async function loadHotWheelsData(): Promise<void> {
  const res = await fetch('/hotwheels.json');
  if (!res.ok) throw new Error('Failed to load hotwheels.json');
  hotwheelsData = await res.json();
}

/* -------------------- Camera -------------------- */

async function ensurePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach(t => t.stop());
}

async function populateVideoSources(): Promise<void> {
  select.innerHTML = '';

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');

  cams.forEach((device, i) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.text = device.label || `Camera ${i + 1}`;
    select.appendChild(option);
  });
}

async function startSelectedDevice(): Promise<void> {
  stopCapture();
  if (!select.value) return;
  capture = await initCapture(select.value);
}

async function initCapture(deviceId: string): Promise<ImageCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } }
  });
  return new ImageCapture(stream.getVideoTracks()[0]);
}

function stopCapture(): void {
  if (!capture) return;
  const track = (capture as any).track as MediaStreamTrack | undefined;
  track?.stop();
  capture = null;
}

/* -------------------- Tesseract -------------------- */

async function initTesseract(): Promise<void> {
  worker = await Tesseract.createWorker(
    'eng',
    1,
    {
      workerPath: new URL(
        'tesseract.js/dist/worker.min.js',
        import.meta.url
      ).toString(),
      corePath: new URL(
        'tesseract.js-core/tesseract-core.wasm.js',
        import.meta.url
      ).toString(),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0'
    }
  );

  await worker.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'
  });
}

/* -------------------- Render Loop -------------------- */

function startRenderLoop(): void {
  const loop = async () => {
    if (capture) {
      try {
        const frame = await capture.grabFrame();
        drawFrame(frame);
        maybeRunOCR(frame);
      } catch (err) {
        console.error('Frame error:', err);
      }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

/* -------------------- Drawing -------------------- */

function drawFrame(frame: ImageBitmap): void {
  const { sx, sy, sw, sh } = computeCoverCrop(
    frame.width,
    frame.height,
    canvas.width,
    canvas.height
  );

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  drawHelperBox();
}

function drawHelperBox(): void {
  const x = (canvas.width - GUIDE_WIDTH) / 2;
  const y = (canvas.height - GUIDE_HEIGHT) / 2;

  ctx.save();
  ctx.fillStyle = currentEntry ? 'rgba(0,255,0,0.15)' : 'rgba(255,255,0,0.1)';
  ctx.fillRect(x, y, GUIDE_WIDTH, GUIDE_HEIGHT);

  ctx.strokeStyle = currentEntry ? 'lime' : 'yellow';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, GUIDE_WIDTH, GUIDE_HEIGHT);

  const baselineY = y + GUIDE_HEIGHT * 0.75;
  ctx.beginPath();
  ctx.moveTo(x, baselineY);
  ctx.lineTo(x + GUIDE_WIDTH, baselineY);
  ctx.stroke();

  ctx.restore();
}

/* -------------------- OCR -------------------- */

async function maybeRunOCR(frame: ImageBitmap): Promise<void> {
  if (!worker) return;

  const now = performance.now();
  if (now - lastOcrTime < OCR_INTERVAL) return;
  lastOcrTime = now;

  const crop = computeOCRCrop(frame);

  tesseractCanvas.width = crop.sw;
  tesseractCanvas.height = crop.sh;

  tctx.clearRect(0, 0, crop.sw, crop.sh);
  tctx.drawImage(
    frame,
    crop.sx, crop.sy, crop.sw, crop.sh,
    0, 0, crop.sw, crop.sh
  );

  preprocessOCR();

  try {
    const { data } = await worker.recognize(tesseractCanvas);
    const text = data.text.trim();
    console.log('OCR Result:', JSON.stringify(text));

    if (!CODE_REGEX.test(text)) return;

    const prefix = text.split('-')[0];
    const match = hotwheelsData.find(e => prefix.startsWith(e.Number));

    if (match && match.Number !== currentEntry?.Number) {
      currentEntry = match;
      updateTable(match);
      console.log('📌 UPDATED:', match.Number, match.Name);
    }
  } catch (err) {
    console.error('OCR failed:', err);
  }
}

function preprocessOCR(): void {
  const img = tctx.getImageData(0, 0, tesseractCanvas.width, tesseractCanvas.height);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    //const bw = g > 140 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  tctx.putImageData(img, 0, 0);
}

/* -------------------- UI -------------------- */

function updateTable(entry: HotWheelsEntry): void {
  toyNumberCell.textContent = entry.Number;
  toyNameCell.textContent = entry.Name;
  toyColorCell.textContent = entry.Color;
  toyYearCell.textContent = entry.Year;
}

/* -------------------- Math -------------------- */

function computeCoverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;

  let sx: number, sy: number, sw: number, sh: number;

  if (srcRatio > dstRatio) {
    sh = srcH;
    sw = sh * dstRatio;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = sw / dstRatio;
    sx = 0;
    sy = (srcH - sh) / 2;
  }

  return { sx, sy, sw, sh };
}

function computeOCRCrop(frame: ImageBitmap) {
  const displayCrop = computeCoverCrop(
    frame.width,
    frame.height,
    canvas.width,
    canvas.height
  );

  const scaleX = displayCrop.sw / canvas.width;
  const scaleY = displayCrop.sh / canvas.height;

  const boxX = (canvas.width - GUIDE_WIDTH) / 2;
  const boxY = (canvas.height - GUIDE_HEIGHT) / 2;

  return {
    sx: displayCrop.sx + boxX * scaleX,
    sy: displayCrop.sy + boxY * scaleY,
    sw: GUIDE_WIDTH * scaleX,
    sh: GUIDE_HEIGHT * scaleY
  };
}

/* -------------------- Cleanup -------------------- */

window.addEventListener('beforeunload', async () => {
  if (worker) await worker.terminate();
});
