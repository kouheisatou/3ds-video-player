// Application entry. Wires UI to parsers, player, encoders, and queue.

import { parseAvi, jpegBlobAt } from './parsers/avi.js?v=20';
import { parseMpo } from './parsers/mpo.js?v=20';
import { Player } from './player.js?v=20';

const $ = (sel) => document.querySelector(sel);

const ga = (event, params = {}) => {
  if (typeof window.gtag === 'function') window.gtag('event', event, params);
  console.log('[GA4]', event, params);
};

const state = {
  current: null,        // { kind:'video'|'image', file, parsed, name, jobId }
  selectedJobId: null,
  queue: [],            // { id, name, kind, file, settings, status, progress, blob, thumbUrl }
  filter: { brightness:0, contrast:0, saturation:0, gamma:1, hue:0 },
  transform: { rotate: 0, flipH: false, flipV: false, swapLR: false },
  exif: null,
  // Queue-wide common settings:
  common: {
    jpegQuality: 92,
    videoBitrate: 8_000_000,
    videoFormat: 'mp4-sbs',
    imageFormat: 'jpg-sbs',
  },
};

const player = new Player($('#previewCanvas'));
window.__player = player;
window.__state = state;

setupQueueDropzone();
setupFileInput();
setupSampleButton();
setupPreviewControls();
setupSettings();
setupQueueActions();
setupSplitters();
setupKeyboardShortcuts();

window.addEventListener('resize', () => player.refit?.());
new ResizeObserver(() => player.refit?.()).observe(document.querySelector('.preview-stage'));

console.log('[App] ready');

// === Setup functions ===

function setupQueueDropzone() {
  const dz = $('#queueSection');
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dz.classList.add('dragover');
  }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault();
    dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', async e => {
    const files = [...e.dataTransfer.files];
    await handleFiles(files);
  });
}

function setupFileInput() {
  document.addEventListener('change', async e => {
    if (e.target?.id === 'fileInput') {
      await handleFiles([...e.target.files]);
      e.target.value = '';
    }
  });
}

function setupSampleButton() {
  document.addEventListener('click', async e => {
    if (e.target?.id !== 'loadSampleBtn') return;
    try {
      const samples = ['sample.AVI', 'sample.MPO'];
      const files = [];
      for (const name of samples) {
        const r = await fetch(name);
        if (!r.ok) continue;
        const blob = await r.blob();
        files.push(new File([blob], name));
      }
      if (files.length === 0) {
        alert('サンプルファイルが見つかりません');
        return;
      }
      await handleFiles(files);
    } catch (err) {
      console.error(err);
      alert('サンプル読込失敗: ' + err.message);
    }
  });
}

async function handleFiles(files) {
  if (files.length === 0) return;
  ga('file_loaded', { count: files.length });
  const jobs = [];
  for (const f of files) jobs.push(addToQueueFromFile(f));
  refreshQueueUi();
  if (jobs[0]) await selectJob(jobs[0].id);
}

async function selectJob(jobId) {
  const job = state.queue.find(x => x.id === jobId);
  if (!job) return;
  state.selectedJobId = jobId;
  // Apply this job's stored settings to the UI before previewing.
  applySettingsToUi(job.settings);
  await loadFileForPreview(job.file, job);
  refreshQueueUi();
}

async function loadFileForPreview(file, job = null) {
  $('#previewEmpty').style.display = 'none';
  try {
    const buf = await file.arrayBuffer();
    const ext = file.name.toLowerCase().split('.').pop();
    let kind, parsed;
    if (ext === 'avi') {
      parsed = parseAvi(buf);
      await player.loadVideo(parsed);
      kind = 'video';
      $('#playBtn').disabled = false;
      $('#seekBar').disabled = false;
    } else if (ext === 'mpo' || ext === 'jpg' || ext === 'jpeg') {
      parsed = parseMpo(buf);
      await player.loadImage(parsed);
      kind = 'image';
      $('#playBtn').disabled = true;
      $('#seekBar').disabled = true;
      $('#timeLabel').textContent = '';
    } else {
      throw new Error('未対応の拡張子: ' + ext);
    }
    state.current = { kind, file, parsed, name: file.name, jobId: job?.id };
    document.body.classList.remove('kind-video', 'kind-image');
    document.body.classList.add('kind-' + kind);
    updateFileHeader();
    updateMetaPanel();
    $('#restoreAllBtn').disabled = false;
    applyAllUiToPlayer();
  } catch (err) {
    console.error(err);
    ga('parse_error', { reason: err.message });
    alert('読込失敗: ' + err.message);
    $('#previewEmpty').style.display = 'grid';
    $('#previewEmpty').textContent = 'エラー: ' + err.message;
  }
}

function updateFileHeader() {
  const c = state.current;
  if (!c) {
    $('#fhName').textContent = 'ファイル未選択';
    $('#fhDate').textContent = '';
    return;
  }
  $('#fhName').textContent = c.name;
  // Date: prefer EXIF DateTimeOriginal (TODO), fallback to file.lastModified.
  const ts = c.file.lastModified;
  $('#fhDate').textContent = ts ? new Date(ts).toLocaleString('ja-JP') : '';
}

// EXIF fields editable via the pencil dialog.
const EXIF_FIELDS = [
  { key: 'dateTimeOriginal', label: '撮影日時', type: 'datetime-local',
    read: (e) => e.exif?.DateTimeOriginal || e.ifd0?.DateTime,
    display: (v) => v ? v.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1/$2/$3 ') : null },
  { key: 'make',        label: 'Make',        type: 'text',  read: (e) => e.ifd0?.Make },
  { key: 'model',       label: 'Model',       type: 'text',  read: (e) => e.ifd0?.Model },
  { key: 'software',    label: 'Software',    type: 'text',  read: (e) => e.ifd0?.Software },
  { key: 'description', label: '説明',         type: 'text',  read: (e) => e.ifd0?.ImageDescription },
  { key: 'artist',      label: '作者',         type: 'text',  read: (e) => e.ifd0?.Artist },
  { key: 'copyright',   label: '著作権',       type: 'text',  read: (e) => e.ifd0?.Copyright },
  { key: 'orientation', label: '向き',         type: 'select',
    options: [[1,'通常'],[3,'180°回転'],[6,'90°時計回り'],[8,'90°反時計回り'],[2,'水平反転'],[4,'垂直反転']],
    read: (e) => e.ifd0?.Orientation,
    display: (v) => ({1:'通常',2:'水平反転',3:'180°回転',4:'垂直反転',6:'90°時計回り',8:'90°反時計回り'})[v] || (v != null ? String(v) : null) },
  { key: 'gps.lat',     label: '緯度',         type: 'number', step: 0.000001,
    read: (e) => e.gps?.lat, display: (v) => v != null ? Number(v).toFixed(6) : null },
  { key: 'gps.lon',     label: '経度',         type: 'number', step: 0.000001,
    read: (e) => e.gps?.lon, display: (v) => v != null ? Number(v).toFixed(6) : null },
  { key: 'gps.alt',     label: '標高(m)',     type: 'number', step: 0.1,
    read: (e) => e.gps?.alt, display: (v) => v != null ? `${Number(v).toFixed(1)} m` : null },
];

function readEditValue(edits, key) {
  if (!edits) return undefined;
  if (key.startsWith('gps.')) return edits.gps?.[key.slice(4)];
  return edits[key];
}

function writeEditValue(edits, key, value) {
  if (key.startsWith('gps.')) {
    edits.gps = edits.gps || {};
    edits.gps[key.slice(4)] = value;
  } else {
    edits[key] = value;
  }
}

function clearEditValue(edits, key) {
  if (key.startsWith('gps.')) {
    if (edits.gps) delete edits.gps[key.slice(4)];
  } else {
    delete edits[key];
  }
}

function updateMetaPanel() {
  const list = $('#infoList');
  const c = state.current;
  if (!c) {
    list.innerHTML = '<div class="info-empty">ファイルが選択されていません</div>';
    return;
  }
  const p = c.parsed;
  const rows = [];
  rows.push(['サイズ', `${(c.file.size/1024).toFixed(1)} KB`]);
  rows.push(['種別', c.kind === 'video' ? '3DS 3D動画' : '3DS 3D写真']);
  rows.push(['解像度', `${p.width}×${p.height}${c.kind==='video'?' (各目)':''}`]);
  if (c.kind === 'video') {
    rows.push(['長さ', `${p.durationSec.toFixed(2)}秒`]);
    rows.push(['FPS', p.fps.toFixed(2)]);
    rows.push(['フレーム数', String(p.frameCount)]);
    rows.push(['音声', `${p.audioFmt.sampleRate}Hz / ${p.audioFmt.channels}ch / ADPCM`]);
  } else {
    rows.push(['画像数', String(p.imageCount)]);
    rows.push(['左目JPEG', `${(p.leftJpeg.byteLength/1024).toFixed(1)} KB`]);
    rows.push(['右目JPEG', `${(p.rightJpeg.byteLength/1024).toFixed(1)} KB`]);
  }

  let html = '<div class="info-section">ファイル詳細</div>';
  html += rows.map(([k, v]) =>
    `<div class="info-row"><span class="info-label">${escapeHtml(k)}</span><span class="info-value">${escapeHtml(String(v))}</span><span></span></div>`
  ).join('');

  if (c.kind === 'image') {
    html += '<div class="info-section">EXIF</div>';
    const exif = c.parsed.leftExif || { ifd0:{}, exif:{}, gps:{} };
    const edits = state.exif || {};
    for (const f of EXIF_FIELDS) {
      const originalRaw = f.read(exif);
      const editedRaw = readEditValue(edits, f.key);
      const isModified = editedRaw !== undefined && editedRaw !== null && editedRaw !== '';
      const raw = isModified ? editedRaw : originalRaw;
      const fmt = f.display ? f.display(raw) : (raw != null && raw !== '' ? String(raw) : null);
      const display = fmt ?? '—';
      html += `<div class="info-row"><span class="info-label">${escapeHtml(f.label)}</span><span class="info-value ${isModified?'modified':''}">${escapeHtml(display)}</span><button class="edit-btn" data-edit="${f.key}" title="編集">✏️</button></div>`;
    }
    if (c.parsed.leftExif?.makerNote?.parsed) {
      const m = c.parsed.leftExif.makerNote.parsed;
      const mrows = [];
      if (m.Parallax != null) mrows.push(['Parallax', m.Parallax]);
      if (m.ModelID != null) mrows.push(['Model ID', m.ModelID]);
      if (m.TimeStamp) mrows.push(['TimeStamp', m.TimeStamp]);
      if (m.InternalSerialNumber) mrows.push(['Internal Serial', m.InternalSerialNumber]);
      if (mrows.length) {
        html += '<div class="info-section">3DS MakerNote</div>';
        html += mrows.map(([k, v]) =>
          `<div class="info-row"><span class="info-label">${escapeHtml(k)}</span><span class="info-value">${escapeHtml(String(v))}</span><span></span></div>`
        ).join('');
      }
    }
  }

  list.innerHTML = html;
  list.querySelectorAll('.edit-btn').forEach(b => {
    b.addEventListener('click', () => openFieldEditDialog(b.dataset.edit));
  });
}

function openFieldEditDialog(key) {
  const field = EXIF_FIELDS.find(f => f.key === key);
  if (!field) return;
  const dlg = $('#fieldEditDialog');
  $('#fieldEditTitle').textContent = field.label + ' を編集';
  const body = $('#fieldEditBody');
  const exif = state.current?.parsed.leftExif || { ifd0:{}, exif:{}, gps:{} };
  const originalRaw = field.read(exif);
  const edited = readEditValue(state.exif || {}, key);
  let current = edited ?? originalRaw ?? '';
  // For datetime-local, convert EXIF "YYYY:MM:DD HH:mm:ss" → "YYYY-MM-DDTHH:mm"
  if (field.type === 'datetime-local' && typeof current === 'string') {
    const m = current.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})/);
    if (m) current = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
    else current = '';
  }
  let inputHtml;
  if (field.type === 'select') {
    inputHtml = `<select id="fieldEditInput">${field.options.map(([v,l]) =>
      `<option value="${v}"${String(v)===String(current)?' selected':''}>${escapeHtml(l)}</option>`).join('')}</select>`;
  } else {
    const stepAttr = field.step ? ` step="${field.step}"` : '';
    inputHtml = `<input id="fieldEditInput" type="${field.type}"${stepAttr} value="${escapeHtml(String(current))}">`;
  }
  const originalLabel = originalRaw != null && originalRaw !== ''
    ? `<div class="field-edit-orig">元: ${escapeHtml(field.display ? field.display(originalRaw) : String(originalRaw))}</div>`
    : '';
  body.innerHTML = `<label>${escapeHtml(field.label)}</label>${inputHtml}${originalLabel}`;
  if (edited != null && edited !== '') {
    body.innerHTML += `<button id="fieldEditClearBtn" type="button" class="btn mini ghost" style="align-self:flex-start">この項目を元に戻す</button>`;
  }
  dlg.showModal();
  setTimeout(() => $('#fieldEditInput').focus(), 0);

  const saveBtn = $('#fieldEditSaveBtn');
  const clearBtn = $('#fieldEditClearBtn');
  const onSave = (e) => {
    const val = $('#fieldEditInput').value;
    if (val === '' || val == null) {
      clearEditValue(state.exif || (state.exif = {}), key);
    } else {
      writeEditValue(state.exif || (state.exif = {}), key,
        field.type === 'number' ? parseFloat(val) :
        field.type === 'select' ? parseInt(val, 10) : val);
    }
    persistToSelectedJob();
    updateMetaPanel();
    ga('exif_edited', { key });
  };
  saveBtn.onclick = onSave;
  if (clearBtn) clearBtn.onclick = () => {
    clearEditValue(state.exif || {}, key);
    persistToSelectedJob();
    updateMetaPanel();
    dlg.close();
  };
}


function setupPreviewControls() {
  $('#playBtn').addEventListener('click', () => {
    if (!state.current || state.current.kind !== 'video') return;
    if (player.playing) {
      player.pause();
      $('#playBtn').textContent = '▶';
      ga('preview_pause');
    } else {
      player.play();
      $('#playBtn').textContent = '⏸';
      ga('preview_play');
    }
  });
  player.onTime = (t) => {
    const total = state.current?.parsed.durationSec || 1;
    $('#seekBar').value = String(Math.round(t/total*1000));
    $('#timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  };
  player.onEnd = () => { $('#playBtn').textContent = '▶'; };
  $('#seekBar').addEventListener('input', () => {
    const total = state.current?.parsed.durationSec || 0;
    const t = $('#seekBar').valueAsNumber/1000 * total;
    player.seek(t);
  });
  document.querySelectorAll('input[name="viewMode"]').forEach(r => {
    r.addEventListener('change', () => {
      player.setMode(r.value);
      ga('mode_change', { mode: r.value });
    });
  });
}

function setupSettings() {
  document.querySelectorAll('input[name="rotate"]').forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.transform.rotate = parseInt(r.value, 10);
      player.setTransform({ rotate: state.transform.rotate });
      enforceSbsAvailability();
      persistToSelectedJob();
    });
  });
  $('#flipH').addEventListener('change', e => {
    state.transform.flipH = e.target.checked;
    player.setTransform({ flipH: state.transform.flipH });
    persistToSelectedJob();
  });
  $('#flipV').addEventListener('change', e => {
    state.transform.flipV = e.target.checked;
    player.setTransform({ flipV: state.transform.flipV });
    persistToSelectedJob();
  });
  $('#swapLR').addEventListener('change', e => {
    state.transform.swapLR = e.target.checked;
    player.setTransform({ swapLR: state.transform.swapLR });
    persistToSelectedJob();
  });

  const sliders = [
    ['brightness', v => v, v => v],
    ['contrast', v => v, v => v],
    ['saturation', v => v, v => v],
    ['gamma', v => (v/100).toFixed(2), v => v/100],
    ['hue', v => v + '°', v => v],
  ];
  for (const [id, fmt, mapper] of sliders) {
    const input = document.getElementById(id);
    const out = input.nextElementSibling;
    out.value = fmt(input.valueAsNumber);
    input.addEventListener('input', () => {
      out.value = fmt(input.valueAsNumber);
      state.filter[id] = mapper(input.valueAsNumber);
      player.setFilter(state.filter);
      persistToSelectedJob();
    });
  }
  $('#resetColor').addEventListener('click', () => {
    ['brightness','contrast','saturation','hue'].forEach(id => document.getElementById(id).value = 0);
    document.getElementById('gamma').value = 100;
    state.filter = { brightness:0, contrast:0, saturation:0, gamma:1, hue:0 };
    document.querySelectorAll('.slider').forEach(s => {
      const inp = s.querySelector('input'), out = s.querySelector('output');
      const id = inp.id;
      out.value = id === 'gamma' ? '1.00' : (id === 'hue' ? '0°' : '0');
    });
    player.setFilter(state.filter);
    persistToSelectedJob();
  });

  // Common (queue-wide) settings
  const q = $('#jpegQuality'), qOut = q.nextElementSibling;
  qOut.value = q.value;
  q.addEventListener('input', () => {
    qOut.value = q.value;
    state.common.jpegQuality = q.valueAsNumber;
    applyCommonToAllJobs();
  });
  const v = $('#videoBitrate'), vOut = v.nextElementSibling;
  vOut.value = v.value;
  v.addEventListener('input', () => {
    vOut.value = v.value;
    state.common.videoBitrate = v.valueAsNumber * 1_000_000;
    applyCommonToAllJobs();
  });
  $('#outputFormatVideo').addEventListener('change', e => {
    state.common.videoFormat = e.target.value;
    applyCommonToAllJobs();
  });
  $('#outputFormatImage').addEventListener('change', e => {
    state.common.imageFormat = e.target.value;
    applyCommonToAllJobs();
  });

  $('#restoreAllBtn').addEventListener('click', () => {
    state.transform = { rotate: 0, flipH: false, flipV: false, swapLR: false };
    state.filter = { brightness:0, contrast:0, saturation:0, gamma:1, hue:0 };
    state.exif = null;
    applySettingsToUi({ transform: state.transform, filter: state.filter, exif: null });
    player.setTransform(state.transform);
    player.setFilter(state.filter);
    persistToSelectedJob();
    updateMetaPanel();
    ga('restore_all');
  });
}

// 90°/270° rotation makes stereoscopic disparity vertical, breaking 3D viewing.
// Force 2D preview and disable SBS toggle whenever rotation is perpendicular.
function enforceSbsAvailability() {
  const rot = state.transform.rotate % 360;
  const breaks3D = rot === 90 || rot === 270;
  const sbsRadio = document.querySelector('input[name="viewMode"][value="sbs"]');
  const twoDRadio = document.querySelector('input[name="viewMode"][value="2d"]');
  const sbsLabel = sbsRadio?.closest('label');
  if (!sbsRadio) return;
  sbsRadio.disabled = breaks3D;
  if (sbsLabel) {
    sbsLabel.style.opacity = breaks3D ? '0.4' : '';
    sbsLabel.title = breaks3D ? '90°/270°回転中は3D表示は無効' : '';
  }
  if (breaks3D && sbsRadio.checked) {
    twoDRadio.checked = true;
    twoDRadio.dispatchEvent(new Event('change'));
  }
}

function persistToSelectedJob() {
  // Per-file adjustments (transform/filter/exif) persist to the selected job only.
  // Queue-wide common settings are stored on state.common and copied into each job by applyCommonToAllJobs.
  const job = state.queue.find(x => x.id === state.selectedJobId);
  if (!job) return;
  job.settings = {
    ...job.settings,
    transform: { ...state.transform },
    filter: { ...state.filter },
    exif: state.exif,
  };
}

function applyAllUiToPlayer() {
  player.setTransform(state.transform);
  player.setFilter(state.filter);
}


function setupQueueActions() {
  $('#clearQueueBtn').addEventListener('click', () => {
    state.queue = state.queue.filter(j => j.status === 'processing');
    if (!state.queue.find(x => x.id === state.selectedJobId)) {
      state.selectedJobId = null;
      state.current = null;
      $('#previewEmpty').style.display = 'grid';
      $('#previewEmpty').textContent = '右のキューにファイルをドロップしてください';
      document.body.classList.remove('kind-video', 'kind-image');
      updateFileHeader();
      updateMetaPanel();
      $('#restoreAllBtn').disabled = true;
    }
    refreshQueueUi();
  });
  $('#runQueueBtn').addEventListener('click', () => {
    runQueue().catch(err => console.error(err));
  });
}

function applySettingsToUi(s) {
  // Per-file transform/filter/exif → restore to UI controls.
  state.transform = { ...s.transform };
  state.filter = { ...s.filter };
  state.exif = s.exif;

  document.querySelectorAll('input[name="rotate"]').forEach(r => {
    r.checked = parseInt(r.value, 10) === s.transform.rotate;
  });
  $('#flipH').checked = !!s.transform.flipH;
  $('#flipV').checked = !!s.transform.flipV;
  $('#swapLR').checked = !!s.transform.swapLR;

  const setSlider = (id, value, fmt) => {
    const inp = document.getElementById(id);
    inp.value = value;
    inp.nextElementSibling.value = fmt(value);
  };
  setSlider('brightness', s.filter.brightness, v => String(v));
  setSlider('contrast', s.filter.contrast, v => String(v));
  setSlider('saturation', s.filter.saturation, v => String(v));
  setSlider('gamma', Math.round(s.filter.gamma * 100), v => (v/100).toFixed(2));
  setSlider('hue', s.filter.hue, v => v + '°');

  enforceSbsAvailability();
}

function addToQueue(file, kind) {
  const job = {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    file,
    settings: defaultJobSettings(kind),
    status: 'pending',
    progress: 0,
    blob: null,
    thumbUrl: null,
  };
  state.queue.push(job);
  generateThumbnail(job).catch(err => console.warn('thumb failed', err));
  refreshQueueUi();
  return job;
}

function snapshotSettings(kind) {
  // Snapshot of the CURRENT state — used when persisting changes the user just made
  // to the selected job. Format/quality/bitrate always come from queue-wide common.
  const c = state.common;
  return {
    outputFormat: kind === 'video' ? c.videoFormat : c.imageFormat,
    transform: { ...state.transform },
    filter: { ...state.filter },
    jpegQuality: c.jpegQuality,
    videoBitrate: c.videoBitrate,
    exif: state.exif,
  };
}

function defaultJobSettings(kind) {
  // Each new queue item starts with neutral per-file adjustments — not inherited from
  // whatever the user was viewing. Common (format/quality/bitrate) is shared queue-wide.
  const c = state.common;
  return {
    outputFormat: kind === 'video' ? c.videoFormat : c.imageFormat,
    transform: { rotate: 0, flipH: false, flipV: false, swapLR: false },
    filter: { brightness: 0, contrast: 0, saturation: 0, gamma: 1, hue: 0 },
    jpegQuality: c.jpegQuality,
    videoBitrate: c.videoBitrate,
    exif: null,
  };
}

function addToQueueFromFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  const kind = (ext === 'avi') ? 'video' : 'image';
  return addToQueue(file, kind);
}

function applyCommonToAllJobs() {
  for (const job of state.queue) {
    if (job.status === 'processing' || job.status === 'done') continue;
    const c = state.common;
    job.settings = {
      ...job.settings,
      outputFormat: job.kind === 'video' ? c.videoFormat : c.imageFormat,
      jpegQuality: c.jpegQuality,
      videoBitrate: c.videoBitrate,
    };
  }
  refreshQueueUi();
}

async function generateThumbnail(job) {
  try {
    const buf = await job.file.arrayBuffer();
    let blob;
    if (job.kind === 'video') {
      const p = parseAvi(buf);
      blob = jpegBlobAt(p, p.videoLeft[0]);
    } else {
      const p = parseMpo(buf);
      blob = new Blob([p.leftJpeg], { type: 'image/jpeg' });
    }
    job.thumbUrl = URL.createObjectURL(blob);
    refreshQueueUi();
  } catch (e) {
    // ignore — keep no thumbnail
  }
}

function refreshQueueUi() {
  const list = $('#queueList');
  if (state.queue.length === 0) {
    list.innerHTML = `
      <li class="queue-empty">
        <div class="dz-icon">⤓</div>
        <div class="dz-title">.AVI / .MPO をここにドロップ</div>
        <div class="dz-sub">複数同時可</div>
        <div class="empty-actions">
          <label class="btn primary">
            ファイルを選択
            <input id="fileInput" type="file" accept=".avi,.mpo,video/avi,video/x-msvideo,image/jpeg" multiple hidden>
          </label>
          <button id="loadSampleBtn" class="btn" type="button">サンプル</button>
        </div>
      </li>`;
    $('#runQueueBtn').disabled = true;
    $('#clearQueueBtn').disabled = true;
    return;
  }
  $('#runQueueBtn').disabled = !state.queue.some(j => j.status === 'pending');
  $('#clearQueueBtn').disabled = false;
  list.innerHTML = state.queue.map(j => `
    <li class="queue-item ${j.id === state.selectedJobId ? 'selected' : ''}" data-id="${j.id}" data-action="select">
      ${j.thumbUrl ? `<img class="q-thumb" src="${j.thumbUrl}" alt="">` : `<div class="q-thumb"></div>`}
      <div class="q-info">
        <span class="q-name">${escapeHtml(j.name)}</span>
        <div class="q-detail">${j.kind === 'video' ? '🎞️' : '🖼️'} ${labelOutput(j.settings.outputFormat)}</div>
      </div>
      <div class="q-actions">
        ${j.blob
          ? `<a class="q-dl" href="${URL.createObjectURL(j.blob)}" download="${dlName(j)}">DL</a>`
          : `<a class="q-dl disabled">DL</a>`}
        <button class="q-remove" data-action="remove" data-id="${j.id}" title="削除">✕</button>
      </div>
      <div class="q-progress"><div style="width:${Math.round(j.progress*100)}%"></div></div>
      <div class="q-status ${j.status}"><span class="q-status-text">${labelStatus(j)}</span></div>
    </li>
  `).join('');

  list.querySelectorAll('.queue-item').forEach(li => {
    li.addEventListener('click', async (e) => {
      // Don't select when clicking the remove button or DL link.
      if (e.target.closest('[data-action="remove"]') || e.target.closest('.q-dl')) return;
      await selectJob(li.dataset.id);
    });
  });
  list.querySelectorAll('[data-action="remove"]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const job = state.queue.find(x => x.id === id);
      if (job?.thumbUrl) URL.revokeObjectURL(job.thumbUrl);
      state.queue = state.queue.filter(x => x.id !== id);
      if (state.selectedJobId === id) state.selectedJobId = null;
      refreshQueueUi();
    });
  });
}

function labelStatus(j) {
  if (j.status === 'pending') return '待機中';
  if (j.status === 'processing') return `変換中… ${Math.round(j.progress*100)}%`;
  if (j.status === 'done') return '✓ 完了';
  if (j.status === 'error') return '✗ ' + (j.error || 'エラー');
  return j.status;
}
function labelOutput(fmt) {
  const map = {
    'mp4-2d-l':'MP4 2D 左', 'mp4-2d-r':'MP4 2D 右', 'mp4-sbs':'MP4 SBS', 'mp4-tab':'MP4 TaB', 'mp4-anaglyph':'MP4 アナグリフ',
    'jpg-2d-l':'JPEG 2D 左','jpg-2d-r':'JPEG 2D 右','jpg-sbs':'JPEG SBS','jpg-tab':'JPEG TaB','jpg-anaglyph':'JPEG アナグリフ',
    'mpo':'MPO 再パック',
  };
  return map[fmt] || fmt;
}
function dlName(j) {
  const base = j.name.replace(/\.[^.]+$/, '');
  const ext = j.settings.outputFormat.startsWith('mp4') ? 'mp4'
            : j.settings.outputFormat === 'mpo' ? 'mpo'
            : 'jpg';
  return `${base}_${j.settings.outputFormat}.${ext}`;
}

async function runQueue() {
  ga('convert_start', { count: state.queue.filter(j=>j.status==='pending').length });
  for (const job of state.queue) {
    if (job.status !== 'pending') continue;
    job.status = 'processing';
    refreshQueueUi();
    try {
      const t0 = performance.now();
      const blob = await processJob(job, p => { job.progress = p; refreshQueueUi(); });
      const ms = Math.round(performance.now() - t0);
      job.blob = blob;
      job.progress = 1;
      job.status = 'done';
      ga('convert_done', { format: job.settings.outputFormat, ms, output_size: blob.size });
    } catch (err) {
      console.error('[Queue]', err);
      job.status = 'error';
      job.error = err.message;
      ga('convert_error', { reason: err.message });
    }
    refreshQueueUi();
  }
}

const ENC_VER = 'v=11';
async function processJob(job, onProgress) {
  const buf = await job.file.arrayBuffer();
  const fmt = job.settings.outputFormat;
  if (fmt === 'mpo' || fmt.startsWith('jpg-')) {
    const { encodeImageJob } = await import(`./encoders/image.js?${ENC_VER}`);
    return encodeImageJob({ buffer: buf, settings: job.settings, onProgress });
  }
  if (fmt.startsWith('mp4-')) {
    const { encodeVideoJob } = await import(`./encoders/video.js?${ENC_VER}`);
    return encodeVideoJob({ buffer: buf, settings: job.settings, onProgress });
  }
  throw new Error('未対応のフォーマット: ' + fmt);
}

function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setupSplitters() {
  const workspace = $('#workspace');
  const leftCol = $('#leftCol');
  // Restore saved sizes.
  const savedQ = localStorage.getItem('ui:queueW');
  if (savedQ) workspace.style.setProperty('--queue-w', savedQ);
  const savedP = localStorage.getItem('ui:previewH');
  if (savedP) leftCol.style.setProperty('--preview-h', savedP);

  setupDragSplitter($('#splitterV'), (deltaPx, startSize) => {
    const next = Math.max(260, Math.min(700, startSize - deltaPx));
    workspace.style.setProperty('--queue-w', next + 'px');
    localStorage.setItem('ui:queueW', next + 'px');
  }, () => parseInt(getComputedStyle(workspace).gridTemplateColumns.split(' ').slice(-1)[0], 10) || 380, 'x');

  setupDragSplitter($('#splitterH'), (deltaPx, startSize) => {
    const next = Math.max(180, Math.min(window.innerHeight - 200, startSize + deltaPx));
    leftCol.style.setProperty('--preview-h', next + 'px');
    localStorage.setItem('ui:previewH', next + 'px');
  }, () => leftCol.firstElementChild.getBoundingClientRect().height, 'y');
}

function setupDragSplitter(handle, onDelta, getStartSize, axis) {
  if (!handle) return;
  const start = (e) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = getStartSize();
    handle.classList.add('dragging');
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    const move = (ev) => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      onDelta(pos - startPos, startSize);
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  handle.addEventListener('mousedown', start);
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ignore when typing in form fields or when a dialog is open.
    if (e.target.matches('input, textarea, select') && e.target.type !== 'range') return;
    if ($('#fieldEditDialog')?.open) return;

    let handled = true;
    if (e.code === 'Space') {
      $('#playBtn').click();
    } else if (e.code === 'ArrowLeft') {
      seekRelative(e.shiftKey ? -1 : -5);
    } else if (e.code === 'ArrowRight') {
      seekRelative(e.shiftKey ? 1 : 5);
    } else if (e.code === 'ArrowDown' || e.code === 'KeyJ') {
      cycleSelection(1);
    } else if (e.code === 'ArrowUp' || e.code === 'KeyK') {
      cycleSelection(-1);
    } else if (e.key === '2') {
      const r = document.querySelector('input[name="viewMode"][value="2d"]'); r.checked = true; r.dispatchEvent(new Event('change'));
    } else if (e.key === '3' || e.key.toLowerCase() === 's') {
      const r = document.querySelector('input[name="viewMode"][value="sbs"]'); r.checked = true; r.dispatchEvent(new Event('change'));
    } else if (e.key.toLowerCase() === 'r') {
      const next = (state.transform.rotate + 90) % 360;
      const r = document.querySelector(`input[name="rotate"][value="${next}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change')); }
    } else if (e.key.toLowerCase() === 'h') {
      const c = $('#flipH'); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
    } else if (e.key.toLowerCase() === 'v') {
      const c = $('#flipV'); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
    } else if (e.key.toLowerCase() === 'x') {
      const c = $('#swapLR'); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  });
}

function seekRelative(deltaSec) {
  if (!state.current || state.current.kind !== 'video') return;
  const total = state.current.parsed.durationSec;
  const t = Math.max(0, Math.min(total, player.currentTime() + deltaSec));
  player.seek(t);
}

function cycleSelection(direction) {
  if (state.queue.length === 0) return;
  const i = state.queue.findIndex(j => j.id === state.selectedJobId);
  const next = state.queue[(i + direction + state.queue.length) % state.queue.length];
  selectJob(next.id);
}

function escapeHtml(s) {
  return s.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c]);
}
