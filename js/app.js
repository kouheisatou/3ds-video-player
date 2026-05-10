// Application entry. Wires UI to parsers, player, encoders, and queue.

import { parseAvi, jpegBlobAt } from './parsers/avi.js';
import { parseMpo } from './parsers/mpo.js';
import { Player } from './player.js';

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
  jpegQuality: 92,
  videoBitrate: 8_000_000,
  outputFormat: 'mp4-sbs',
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
    updateExifPanel();
    updateOutputFormatForKind(kind);
    $('#applyToSelectedBtn').disabled = !job;
    $('#editExifBtn').disabled = false;
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

function updateExifPanel() {
  const el = $('#exifReadonly');
  const c = state.current;
  if (!c) { el.textContent = 'ファイルが選択されていません'; return; }
  // Placeholder until exif parser is wired up.
  el.textContent = c.kind === 'image'
    ? '画像EXIF: 解析実装は次のイテレーションで対応'
    : '動画ファイル(AVI)はEXIFを持ちません';
}

function updateMetaPanel() {
  const c = state.current;
  if (!c) {
    $('#metaPanel').innerHTML = '<div class="meta-empty">ファイルが選択されていません</div>';
    return;
  }
  const p = c.parsed;
  let html = `<div class="row"><span>サイズ</span><strong>${(c.file.size/1024).toFixed(1)} KB</strong></div>`;
  html += `<div class="row"><span>種別</span><strong>${c.kind === 'video' ? '3DS 3D動画' : '3DS 3D写真'}</strong></div>`;
  html += `<div class="row"><span>解像度</span><strong>${p.width}×${p.height}${c.kind==='video'?' (各目)':''}</strong></div>`;
  if (c.kind === 'video') {
    html += `<div class="row"><span>長さ</span><strong>${p.durationSec.toFixed(2)}秒</strong></div>`;
    html += `<div class="row"><span>FPS</span><strong>${p.fps.toFixed(2)}</strong></div>`;
    html += `<div class="row"><span>フレーム数</span><strong>${p.frameCount}</strong></div>`;
    html += `<div class="row"><span>音声</span><strong>${p.audioFmt.sampleRate}Hz / ${p.audioFmt.channels}ch / ADPCM</strong></div>`;
  } else {
    html += `<div class="row"><span>画像数</span><strong>${p.imageCount}</strong></div>`;
    html += `<div class="row"><span>左目JPEG</span><strong>${(p.leftJpeg.byteLength/1024).toFixed(1)} KB</strong></div>`;
    html += `<div class="row"><span>右目JPEG</span><strong>${(p.rightJpeg.byteLength/1024).toFixed(1)} KB</strong></div>`;
  }
  $('#metaPanel').innerHTML = html;
}

function updateOutputFormatForKind(kind) {
  const sel = $('#outputFormat');
  for (const opt of sel.options) {
    const v = opt.value;
    const isVideo = v.startsWith('mp4-');
    const isImage = v.startsWith('jpg-') || v === 'mpo';
    opt.hidden = (kind === 'video' && !isVideo) || (kind === 'image' && !isImage);
  }
  if (sel.options[sel.selectedIndex]?.hidden) {
    for (const opt of sel.options) if (!opt.hidden) { sel.value = opt.value; break; }
  }
  state.outputFormat = sel.value;
}

function setupPreviewControls() {
  $('#playBtn').addEventListener('click', () => {
    if (!state.current || state.current.kind !== 'video') return;
    if (player.playing) {
      player.pause();
      $('#playBtn').textContent = '▶ 再生';
      ga('preview_pause');
    } else {
      player.play();
      $('#playBtn').textContent = '⏸ 一時停止';
      ga('preview_play');
    }
  });
  player.onTime = (t) => {
    const total = state.current?.parsed.durationSec || 1;
    $('#seekBar').value = String(Math.round(t/total*1000));
    $('#timeLabel').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
  };
  player.onEnd = () => { $('#playBtn').textContent = '▶ 再生'; };
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
  document.querySelectorAll('button.chip[data-rot]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('button.chip[data-rot]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.transform.rotate = parseInt(b.dataset.rot, 10);
      player.setTransform({ rotate: state.transform.rotate });
      persistToSelectedJob();
    });
  });
  $('#flipH').addEventListener('change', e => {
    state.transform.flipH = e.target.checked;
    player.setTransform({ flipH: e.target.checked });
    persistToSelectedJob();
  });
  $('#flipV').addEventListener('change', e => {
    state.transform.flipV = e.target.checked;
    player.setTransform({ flipV: e.target.checked });
    persistToSelectedJob();
  });
  $('#swapLR')?.addEventListener('click', () => {
    state.transform.swapLR = !state.transform.swapLR;
    $('#swapLR').classList.toggle('active', state.transform.swapLR);
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

  const q = $('#jpegQuality'), qOut = q.nextElementSibling;
  qOut.value = q.value;
  q.addEventListener('input', () => {
    qOut.value = q.value;
    state.jpegQuality = q.valueAsNumber;
    persistToSelectedJob();
  });
  const v = $('#videoBitrate'), vOut = v.nextElementSibling;
  vOut.value = v.value;
  v.addEventListener('input', () => {
    vOut.value = v.value;
    state.videoBitrate = v.valueAsNumber * 1_000_000;
    persistToSelectedJob();
  });

  $('#outputFormat').addEventListener('change', e => {
    state.outputFormat = e.target.value;
    persistToSelectedJob();
  });

  $('#editExifBtn').addEventListener('click', () => {
    populateExifFromCurrent();
    $('#exifDialog').showModal();
    ga('exif_open');
  });
  $('#exifSaveBtn').addEventListener('click', () => {
    state.exif = collectExifFromUi();
    ga('exif_edited', { fields: Object.keys(state.exif).length });
    persistToSelectedJob();
  });
}

function persistToSelectedJob() {
  const job = state.queue.find(x => x.id === state.selectedJobId);
  if (!job) return;
  job.settings = snapshotSettings();
  // Refresh queue UI just for the affected item's detail label.
  const li = document.querySelector(`.queue-item[data-id="${job.id}"]`);
  if (li) {
    const detail = li.querySelector('.q-detail');
    if (detail) detail.innerHTML = `${job.kind === 'video' ? '🎞️' : '🖼️'} ${labelOutput(job.settings.outputFormat)}`;
  }
}

function applyAllUiToPlayer() {
  player.setTransform(state.transform);
  player.setFilter(state.filter);
}

function populateExifFromCurrent() {
  // Pre-fill from current file metadata when available.
  const c = state.current;
  if (!c) return;
  $('#ex_make').value = $('#ex_make').value || 'Nintendo';
  $('#ex_model').value = $('#ex_model').value || 'Nintendo 3DS';
}

function collectExifFromUi() {
  return {
    dateTimeOriginal: $('#ex_dto').value,
    make: $('#ex_make').value,
    model: $('#ex_model').value,
    software: $('#ex_software').value,
    description: $('#ex_desc').value,
    artist: $('#ex_artist').value,
    copyright: $('#ex_copyright').value,
    orientation: parseInt($('#ex_orientation').value, 10),
    gps: {
      lat: parseFloat($('#ex_lat').value) || null,
      lon: parseFloat($('#ex_lon').value) || null,
      alt: parseFloat($('#ex_alt').value) || null,
    },
    keepMaker: $('#ex_keepMaker').checked,
  };
}

function setupQueueActions() {
  $('#applyToAllBtn').addEventListener('click', () => {
    if (state.queue.length === 0) return;
    const snap = snapshotSettings();
    for (const job of state.queue) {
      if (job.status === 'processing' || job.status === 'done') continue;
      // Re-pick output format compatible with this job's kind.
      const wanted = snap.outputFormat;
      const isVideoFmt = wanted.startsWith('mp4-');
      const isImageFmt = wanted.startsWith('jpg-') || wanted === 'mpo';
      if ((job.kind === 'video' && !isVideoFmt) || (job.kind === 'image' && !isImageFmt)) {
        // Map to corresponding format if mismatch.
        const mapping = {
          'mp4-2d-l':'jpg-2d-l','mp4-2d-r':'jpg-2d-r','mp4-sbs':'jpg-sbs',
          'mp4-tab':'jpg-tab','mp4-anaglyph':'jpg-anaglyph',
          'jpg-2d-l':'mp4-2d-l','jpg-2d-r':'mp4-2d-r','jpg-sbs':'mp4-sbs',
          'jpg-tab':'mp4-tab','jpg-anaglyph':'mp4-anaglyph','mpo':'mp4-sbs',
        };
        job.settings = { ...snap, outputFormat: mapping[wanted] || (job.kind === 'video' ? 'mp4-sbs' : 'jpg-sbs') };
      } else {
        job.settings = { ...snap };
      }
    }
    refreshQueueUi();
  });
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
      updateExifPanel();
    }
    refreshQueueUi();
  });
  $('#runQueueBtn').addEventListener('click', () => {
    runQueue().catch(err => console.error(err));
  });
}

function applySettingsToUi(s) {
  // Restore UI controls from a job's stored settings.
  state.outputFormat = s.outputFormat;
  state.transform = { ...s.transform };
  state.filter = { ...s.filter };
  state.jpegQuality = s.jpegQuality;
  state.videoBitrate = s.videoBitrate;
  state.exif = s.exif;

  const sel = $('#outputFormat');
  if (sel.value !== s.outputFormat) sel.value = s.outputFormat;

  document.querySelectorAll('button.chip[data-rot]').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.rot, 10) === s.transform.rotate);
  });
  $('#flipH').checked = !!s.transform.flipH;
  $('#flipV').checked = !!s.transform.flipV;
  $('#swapLR').classList.toggle('active', !!s.transform.swapLR);

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
  setSlider('jpegQuality', s.jpegQuality, v => String(v));
  setSlider('videoBitrate', Math.round(s.videoBitrate / 1_000_000), v => String(v));
}

function addToQueue(file, kind) {
  const job = {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    file,
    settings: snapshotSettings(),
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

function snapshotSettings() {
  return {
    outputFormat: state.outputFormat,
    transform: { ...state.transform },
    filter: { ...state.filter },
    jpegQuality: state.jpegQuality,
    videoBitrate: state.videoBitrate,
    exif: state.exif,
  };
}

function addToQueueFromFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  const kind = (ext === 'avi') ? 'video' : 'image';
  // Pick reasonable default output format per kind.
  const prevFormat = state.outputFormat;
  if (kind === 'video' && !state.outputFormat.startsWith('mp4')) state.outputFormat = 'mp4-sbs';
  if (kind === 'image' && !(state.outputFormat.startsWith('jpg') || state.outputFormat === 'mpo')) state.outputFormat = 'jpg-sbs';
  const job = addToQueue(file, kind);
  state.outputFormat = prevFormat;
  return job;
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

async function processJob(job, onProgress) {
  const buf = await job.file.arrayBuffer();
  const fmt = job.settings.outputFormat;
  if (fmt === 'mpo' || fmt.startsWith('jpg-')) {
    const { encodeImageJob } = await import('./encoders/image.js');
    return encodeImageJob({ buffer: buf, settings: job.settings, onProgress });
  }
  if (fmt.startsWith('mp4-')) {
    const { encodeVideoJob } = await import('./encoders/video.js');
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

function escapeHtml(s) {
  return s.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c]);
}
