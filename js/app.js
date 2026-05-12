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
player.mode = document.querySelector('input[name="viewMode"]:checked')?.value || '2d';
window.__player = player;
window.__state = state;

setupQueueDropzone();
setupFileInput();
setupSampleButton();
setupPreviewControls();
setupSettings();
setupQueueActions();
setupKeyboardShortcuts();
setupWindows();

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
  // Stop any audio/video playback before switching files.
  if (player.playing) {
    player.pause();
    $('#playBtn').innerHTML = '<img class="play-icon" src="assets/icons/play.svg" alt="▶">';
  }
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
      $('#timeLabel').textContent = '— / —';
    } else {
      throw new Error('未対応の拡張子: ' + ext);
    }
    state.current = { kind, file, parsed, name: file.name, jobId: job?.id };
    document.body.classList.remove('kind-video', 'kind-image');
    document.body.classList.add('kind-' + kind);
    updateFileHeader();
    updateMetaPanel();
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
  dlg.showModal();
  setTimeout(() => $('#fieldEditInput').focus(), 0);

  const saveBtn = $('#fieldEditSaveBtn');
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
}


function setupPreviewControls() {
  $('#playBtn').addEventListener('click', () => {
    if (!state.current || state.current.kind !== 'video') return;
    if (player.playing) {
      player.pause();
      $('#playBtn').innerHTML = '<img class="play-icon" src="assets/icons/play.svg" alt="▶">';
      ga('preview_pause');
    } else {
      player.play();
      $('#playBtn').innerHTML = '<img class="play-icon" src="assets/icons/pause.svg" alt="⏸">';
      ga('preview_play');
    }
  });
  player.onTime = (t) => {
    const total = state.current?.parsed.durationSec || 1;
    $('#seekBar').value = String(Math.round(t/total*1000));
    $('#timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  };
  player.onEnd = () => { $('#playBtn').innerHTML = '<img class="play-icon" src="assets/icons/play.svg" alt="▶">'; };
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
  $('#runQueueBtn').disabled = state.queue.length === 0;
  $('#clearQueueBtn').disabled = false;
  list.innerHTML = state.queue.map(j => `
    <li class="queue-item ${j.id === state.selectedJobId ? 'selected' : ''}" data-id="${j.id}" data-action="select">
      ${j.thumbUrl ? `<img class="q-thumb" src="${j.thumbUrl}" alt="">` : `<div class="q-thumb"></div>`}
      <div class="q-info">
        <span class="q-name">${escapeHtml(j.name)}</span>
        <div class="q-detail">${labelOutput(j.settings.outputFormat)}</div>
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
    'mp4-2d-l':'MP4 2D 左', 'mp4-2d-r':'MP4 2D 右', 'mp4-sbs':'MP4 サイドバイサイド', 'mp4-tab':'MP4 上下', 'mp4-anaglyph':'MP4 アナグリフ',
    'jpg-2d-l':'JPEG 2D 左','jpg-2d-r':'JPEG 2D 右','jpg-sbs':'JPEG サイドバイサイド','jpg-tab':'JPEG 上下','jpg-anaglyph':'JPEG アナグリフ',
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
  const pending = state.queue.filter(j => j.status === 'pending');
  ga('convert_start', { count: pending.length });
  const justFinished = [];
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
      justFinished.push(job);
      ga('convert_done', { format: job.settings.outputFormat, ms, output_size: blob.size });
    } catch (err) {
      console.error('[Queue]', err);
      job.status = 'error';
      job.error = err.message;
      ga('convert_error', { reason: err.message });
    }
    refreshQueueUi();
  }
  // Auto-download all successful conversions from this run as a single .zip.
  if (justFinished.length > 0) {
    await downloadZip(justFinished);
  }
}

async function downloadZip(jobs) {
  try {
    const { buildZip } = await import('./encoders/zip.js?v=20');
    const entries = [];
    const seen = new Map();
    for (const j of jobs) {
      let name = dlName(j);
      // Avoid name collisions if user dropped two files with the same base.
      const n = seen.get(name) || 0;
      seen.set(name, n + 1);
      if (n > 0) {
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)}_${n}${name.slice(dot)}` : `${name}_${n}`;
      }
      const bytes = new Uint8Array(await j.blob.arrayBuffer());
      entries.push({ name, bytes });
    }
    const zipBlob = buildZip(entries);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `3ds-export-${ts}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    ga('zip_download', { count: jobs.length, size: zipBlob.size });
  } catch (err) {
    console.error('[ZIP]', err);
    ga('zip_error', { reason: err.message });
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

// === MDI windows + taskbar ===========================================
function setupWindows() {
  const desktop = $('#desktop');
  if (!desktop) return;
  const wins = [...document.querySelectorAll('.win')];
  let zCounter = 10;

  // Minimum grip area kept visible when viewport shrinks or user drags off-screen.
  const MIN_GRIP = 15;
  const TITLEBAR_H = 22;

  // Default layout — proportions of desktop, captured from a designed arrangement.
  // Windows overlap slightly for a natural scattered feel.
  const DEFAULT_LAYOUT = {
    playback: { fx: 0.0338, fy: 0.0412, fw: 0.6798, fh: 0.6162, z: 1 },
    info:     { fx: 0.1360, fy: 0.5060, fw: 0.3492, fh: 0.4157, z: 2 },
    edit:     { fx: 0.2647, fy: 0.6388, fw: 0.3467, fh: 0.4050, z: 3 },
    queue:    { fx: 0.6436, fy: 0.1700, fw: 0.3218, fh: 0.8101, z: 4 },
  };
  const placeDefaults = () => {
    const dw = desktop.clientWidth;
    const dh = desktop.clientHeight;
    for (const w of wins) {
      const id = w.dataset.win;
      const l = DEFAULT_LAYOUT[id]; if (!l) continue;
      let x = Math.round(l.fx * dw);
      let y = Math.round(l.fy * dh);
      let wd = Math.round(l.fw * dw);
      let hd = Math.round(l.fh * dh);
      // Clamp size to viewport (windows shouldn't be larger than the desktop).
      wd = Math.min(wd, dw);
      hd = Math.min(hd, dh);
      // Clamp position so titlebar remains grabable.
      x = Math.max(MIN_GRIP - wd, Math.min(dw - MIN_GRIP, x));
      y = Math.max(MIN_GRIP - TITLEBAR_H, Math.min(dh - MIN_GRIP, y));
      w.style.left = x + 'px';
      w.style.top = y + 'px';
      w.style.width = wd + 'px';
      w.style.height = hd + 'px';
      w.style.zIndex = String(10 + (l.z || 0));
    }
  };

  // Restore saved geometry; fall back to defaults.
  let saved;
  try { saved = JSON.parse(localStorage.getItem('ui:windows:v3') || '{}'); } catch { saved = {}; }
  let hasAnySaved = false;
  for (const w of wins) {
    const id = w.dataset.win;
    if (saved[id]) {
      hasAnySaved = true;
      const s = saved[id];
      if (s.x != null) w.style.left = s.x + 'px';
      if (s.y != null) w.style.top = s.y + 'px';
      if (s.w != null) w.style.width = s.w + 'px';
      if (s.h != null) w.style.height = s.h + 'px';
      if (s.z != null) {
        w.style.zIndex = String(s.z);
        if (s.z > zCounter) zCounter = s.z;
      }
      if (s.min) w.classList.add('minimized');
      if (s.max) w.classList.add('maximized');
    }
  }
  if (!hasAnySaved) placeDefaults();

  const persist = () => {
    const data = {};
    for (const w of wins) {
      const id = w.dataset.win;
      data[id] = {
        x: w.offsetLeft, y: w.offsetTop, w: w.offsetWidth, h: w.offsetHeight,
        z: parseInt(w.style.zIndex || '10', 10),
        min: w.classList.contains('minimized'),
        max: w.classList.contains('maximized'),
      };
    }
    localStorage.setItem('ui:windows:v3', JSON.stringify(data));
  };

  const focusWin = (w) => {
    for (const x of wins) x.classList.remove('active');
    w.classList.add('active');
    w.style.zIndex = String(++zCounter);
    syncTaskbar();
  };

  // Pointer drag on titlebar to move window.
  for (const w of wins) {
    const bar = w.querySelector('.win-titlebar');
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.win-btn')) return;
      if (w.classList.contains('maximized')) return;
      focusWin(w);
      const startX = e.clientX, startY = e.clientY;
      const startLeft = w.offsetLeft, startTop = w.offsetTop;
      const ww = w.offsetWidth, wh = w.offsetHeight;
      const onMove = (ev) => {
        let nx = startLeft + (ev.clientX - startX);
        let ny = startTop + (ev.clientY - startY);
        const dw2 = desktop.clientWidth, dh2 = desktop.clientHeight;
        if (nx + ww < MIN_GRIP) nx = MIN_GRIP - ww;
        if (nx > dw2 - MIN_GRIP) nx = dw2 - MIN_GRIP;
        if (ny + TITLEBAR_H < MIN_GRIP) ny = MIN_GRIP - TITLEBAR_H;
        if (ny > dh2 - MIN_GRIP) ny = dh2 - MIN_GRIP;
        w.style.left = nx + 'px';
        w.style.top = ny + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        persist();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('.win-btn')) return;
      toggleMax(w);
    });
    w.addEventListener('mousedown', () => focusWin(w));

    // Window control buttons.
    w.querySelectorAll('.win-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'min') { w.classList.add('minimized'); persist(); syncTaskbar(); }
        else if (act === 'max') { toggleMax(w); }
        else if (act === 'close') { w.classList.add('minimized'); persist(); syncTaskbar(); }
      });
    });

    // Persist resize via ResizeObserver.
    const ro = new ResizeObserver(() => persist());
    ro.observe(w);
  }

  function toggleMax(w) {
    w.classList.toggle('maximized');
    persist();
    // Player canvas re-fit when playback window resized.
    if (w.dataset.win === 'playback') player.refit?.();
  }

  // Taskbar wiring.
  const taskbarItems = document.querySelectorAll('.task-item');
  taskbarItems.forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.show;
      const w = document.querySelector(`.win[data-win="${id}"]`);
      if (!w) return;
      const isMin = w.classList.contains('minimized');
      const isActive = w.classList.contains('active') && !isMin;
      if (isMin) {
        w.classList.remove('minimized');
        focusWin(w);
      } else if (isActive) {
        // Minimize when clicking active taskbar item.
        w.classList.add('minimized');
        syncTaskbar();
      } else {
        focusWin(w);
      }
      persist();
    });
  });

  function syncTaskbar() {
    taskbarItems.forEach(b => {
      const id = b.dataset.show;
      const w = document.querySelector(`.win[data-win="${id}"]`);
      const isVisible = w && !w.classList.contains('minimized');
      const isActive  = isVisible && w.classList.contains('active');
      b.classList.toggle('active', !!isActive);
    });
  }

  // Start button: invoke the dolphin tutorial.
  $('#startBtn')?.addEventListener('click', () => {
    showTutorial();
  });
  // First-visit tutorial.
  if (!localStorage.getItem('ui:tutorialSeen')) {
    setTimeout(showTutorial, 500);
  }

  // Clock updates every 30s.
  const clock = $('#trayClock');
  const tick = () => {
    const d = new Date();
    if (clock) clock.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  tick(); setInterval(tick, 30_000);

  // Keep the titlebar (grab area) always grabable when the viewport shrinks.
  // Window size never changes — only position is nudged so at least MIN_GRIP
  // pixels of the titlebar stay reachable within the desktop.
  const fitInsideDesktop = () => {
    const dw = desktop.clientWidth;
    const dh = desktop.clientHeight;
    for (const w of wins) {
      if (w.classList.contains('maximized')) continue;
      const ww = w.offsetWidth, wh = w.offsetHeight;
      let x = w.offsetLeft, y = w.offsetTop;
      // Horizontal grip: ensure ≥ MIN_GRIP px of the titlebar overlaps the viewport.
      if (x + ww < MIN_GRIP) x = MIN_GRIP - ww;
      if (x > dw - MIN_GRIP) x = dw - MIN_GRIP;
      // Vertical grip: titlebar (height ~TITLEBAR_H) must be reachable.
      if (y + TITLEBAR_H < MIN_GRIP) y = MIN_GRIP - TITLEBAR_H;
      if (y > dh - MIN_GRIP) y = dh - MIN_GRIP;
      if (x !== w.offsetLeft) w.style.left = x + 'px';
      if (y !== w.offsetTop) w.style.top = y + 'px';
    }
  };
  fitInsideDesktop(); // run once at startup in case saved geometry exceeds viewport.

  let firstFocus = true;
  window.addEventListener('resize', () => {
    fitInsideDesktop();
    if (firstFocus) firstFocus = false; else persist();
  });

  // Focus the playback window initially.
  focusWin(document.querySelector('.win[data-win="playback"]'));
  syncTaskbar();
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

// === Tutorial (Kairu the dolphin) =====================================
const TUTORIAL_STEPS = [
  { text: '3DS 3D Media Studio は3DS で撮影した AVI / MPO をブラウザで再生・変換するツールです。', target: 'center' },
  { text: '右の「キュー」ウィンドウへ .AVI / .MPO ファイルをドラッグ&ドロップしてください。複数ファイルをまとめて投入できます。', target: '.win[data-win="queue"]' },
  { text: '「編集」ウィンドウで回転や色を調整できます。表示モードを「サイドバイサイド」にすると左右並列の3D出力になります。', target: '.win[data-win="edit"]' },
  { text: '「再生」ウィンドウで変換前のプレビューを確認できます。', target: '.win[data-win="playback"]' },
  { text: '「変換」ボタンを押すと、変換結果がまとめて ZIP で自動ダウンロードされます。', target: '#runQueueBtn' },
];
let tutorialStep = 0;
let tutorialUserDragged = false;

function showTutorial() {
  tutorialStep = 0;
  tutorialUserDragged = false;
  const t = $('#tutorial');
  t.hidden = false;
  renderTutorial();
  positionTutorial();
}
function hideTutorial() {
  $('#tutorial').hidden = true;
  localStorage.setItem('ui:tutorialSeen', '1');
}
function renderTutorial() {
  const s = TUTORIAL_STEPS[tutorialStep] || TUTORIAL_STEPS[0];
  $('#tutorialText').innerText = s.text;
  $('#tutorialStep').textContent = `${tutorialStep + 1} / ${TUTORIAL_STEPS.length}`;
  $('#tutorialPrev').disabled = tutorialStep === 0;
  $('#tutorialNext').textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? '閉じる' : '次へ';
}
function positionTutorial() {
  const t = $('#tutorial');
  if (!t || t.hidden) return;
  const s = TUTORIAL_STEPS[tutorialStep];
  const vw = window.innerWidth, vh = window.innerHeight;
  // Measure size (must be visible to measure correctly).
  t.style.visibility = 'hidden';
  const rect = t.getBoundingClientRect();
  const tw = rect.width || 380, th = rect.height || 140;
  const FISH = 96; // fish image size

  let cx, cy;
  if (s.target === 'center') {
    cx = vw / 2; cy = vh / 2;
  } else if (s.target === 'taskbar') {
    cx = vw / 2; cy = vh - 14;
  } else {
    const el = document.querySelector(s.target);
    if (el) {
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    } else {
      cx = vw / 2; cy = vh / 2;
    }
  }
  // Container layout: [bubble][gap][fish]. Fish horizontally centered on (cx).
  let left = cx - tw + FISH / 2;
  let top  = cy - th / 2;
  // If bubble would clip off the left edge, flip to the right side of target instead.
  if (left < 8) {
    left = cx + FISH / 2 + 12;
  }
  left = Math.max(8, Math.min(vw - tw - 8, left));
  top  = Math.max(8, Math.min(vh - th - 32, top)); // 32 = taskbar
  t.style.left = left + 'px';
  t.style.top  = top  + 'px';
  t.style.visibility = '';
}

function setupTutorialDragAndButtons() {
  const t = $('#tutorial');
  const dolphin = t?.querySelector('.tutorial-dolphin');
  if (!dolphin) return;
  // Drag the entire tutorial by grabbing the dolphin.
  dolphin.addEventListener('mousedown', (e) => {
    e.preventDefault();
    tutorialUserDragged = true;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = t.offsetLeft, startTop = t.offsetTop;
    t.classList.add('dragging');
    const onMove = (ev) => {
      let nx = startLeft + (ev.clientX - startX);
      let ny = startTop + (ev.clientY - startY);
      const vw = window.innerWidth, vh = window.innerHeight;
      nx = Math.max(-(t.offsetWidth - 40), Math.min(vw - 20, nx));
      ny = Math.max(0, Math.min(vh - 30, ny));
      t.style.left = nx + 'px';
      t.style.top  = ny + 'px';
    };
    const onUp = () => {
      t.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  $('#tutorialNext')?.addEventListener('click', () => {
    if (tutorialStep >= TUTORIAL_STEPS.length - 1) { hideTutorial(); return; }
    tutorialStep++;
    renderTutorial();
    positionTutorial(); // always reposition on step change (per user request)
  });
  $('#tutorialPrev')?.addEventListener('click', () => {
    if (tutorialStep > 0) {
      tutorialStep--;
      renderTutorial();
      positionTutorial();
    }
  });
  $('#tutorialSkip')?.addEventListener('click', () => hideTutorial());
  window.addEventListener('resize', () => {
    if (!t.hidden && !tutorialUserDragged) positionTutorial();
  });
}
setupTutorialDragAndButtons();

function cycleSelection(direction) {
  if (state.queue.length === 0) return;
  const i = state.queue.findIndex(j => j.id === state.selectedJobId);
  const next = state.queue[(i + direction + state.queue.length) % state.queue.length];
  selectJob(next.id);
}

function escapeHtml(s) {
  return s.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c]);
}
