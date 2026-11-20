import { createVisual } from './visual.js?v=13';

const byId = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
};
const settings = {};
const canvas = byId('canvas');
const sample = document.createElement('canvas');
const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
const visual = createVisual(canvas, sample);
const video = byId('video');
const audio = byId('audio');
const play = byId('play');
const scrub = byId('scrub');
const depthStatus = byId('depth-state');
const depthHint = byId('depth-hint');
const mapMessage = byId('map-message');
const analyze = byId('analyze');
const notice = byId('notice');
const meter = byId('meter').getContext('2d');
const exportButton = byId('export');
const waveform = byId('audio-waveform');
const waveformCtx = waveform.getContext('2d');
const exportCanvas = document.createElement('canvas');
const exportCanvasCtx = exportCanvas.getContext('2d');
const demoAudio = new URL('./demo.m4a', location.href).href;

function setupPanels() {
  document.querySelectorAll('.inspector>.panel').forEach((panel, index) => {
    const head = panel.querySelector('.panel-top');
    if (!head) return;
    const body = document.createElement('div');
    body.className = 'panel-body';
    const children = [...panel.children].filter(child => child !== head);
    children.forEach(child => body.append(child));
    panel.append(body);
    const fold = document.createElement('button');
    fold.className = 'panel-fold'; fold.type = 'button'; fold.setAttribute('aria-label', 'Collapse settings');
    fold.setAttribute('aria-expanded', 'true'); fold.title = 'Collapse section';
    head.append(fold);
    const key = `xo-lab-panel-${panel.id || index}`;
    const expanded = store.get(key) !== 'false';
    panel.classList.toggle('is-collapsed', !expanded); body.hidden = !expanded;
    fold.setAttribute('aria-expanded', String(expanded));
    fold.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open; panel.classList.toggle('is-collapsed', !open);
      fold.setAttribute('aria-expanded', String(open));
      fold.title = open ? 'Collapse section' : 'Expand section';
      fold.setAttribute('aria-label', fold.title);
      store.set(key, String(open));
    });
  });
}
setupPanels();

const colorDefs = [
  ['marker', 'Marker numbers'], ['label', 'Label backgrounds'], ['box', 'Box outlines'],
  ['fill', 'Box fills'], ['center', 'Center marks'], ['links', 'Connecting lines'],
  ['trails', 'Trails'], ['tile', 'Source-tile borders'],
  ['dust', 'Dust particles'], ['flash', 'Flash tint'], ['wireGlow', 'Wireframe glow']
];
const defaultColors = Object.fromEntries(colorDefs.map(([key]) => [key, { hex: key === 'label' ? '#080808' : '#ffffff', opacity: 1 }]));
settings.colors = JSON.parse(JSON.stringify(defaultColors));
const colorRoot = byId('color-controls');
const swatchSet = ['#ffffff', '#ccff00', '#ff2b2b', '#00d8ff', '#bf5aff', '#ff9d00'];
for (const [key, title] of colorDefs) {
  const row = document.createElement('div'); row.className = 'color-row'; row.dataset.color = key;
  const initialColor = key === 'label' ? '#080808' : '#ffffff';
  row.innerHTML = `<span class="color-title">${title}</span><input id="color-${key}" class="color-chip" type="color" aria-label="${title} color" value="${initialColor}"><div class="color-values"><input id="hex-${key}" class="color-hex" aria-label="${title} HEX" value="${initialColor.toUpperCase()}" maxlength="7" spellcheck="false"><input id="opacity-${key}" class="color-alpha" aria-label="${title} opacity percent" type="number" min="0" max="100" value="100" inputmode="numeric" title="Opacity percent"></div><div class="swatches" role="group" aria-label="${title} quick colors">${swatchSet.map(color => `<button class="swatch" type="button" data-color-value="${color}" aria-label="${color}" style="background:${color}"></button>`).join('')}</div>`;
  const [picker, hex, alpha] = [row.querySelector('.color-chip'), row.querySelector('.color-hex'), row.querySelector('.color-alpha')];
  let colorHistoryTimer;
  const queueColorHistory = () => { clearTimeout(colorHistoryTimer); colorHistoryTimer = setTimeout(() => row.dispatchEvent(new Event('change', { bubbles: true })), 320); };
  const apply = (value, opacity = alpha.value, record = true) => {
    if (!/^#[\da-f]{6}$/i.test(value)) return;
    const color = value.toLowerCase();
    picker.value = color; hex.value = color.toUpperCase();
    const a = Math.max(0, Math.min(100, Number(opacity) || 0)); alpha.value = a;
    settings.colors[key] = { hex: color, opacity: a / 100 };
    if (record) { clearTimeout(colorHistoryTimer); row.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  picker.addEventListener('input', () => { apply(picker.value, alpha.value, false); queueColorHistory(); });
  picker.addEventListener('change', () => apply(picker.value));
  hex.addEventListener('input', () => { apply(hex.value, alpha.value, false); queueColorHistory(); });
  hex.addEventListener('change', () => apply(hex.value));
  alpha.addEventListener('input', () => { apply(hex.value, alpha.value, false); queueColorHistory(); });
  alpha.addEventListener('change', () => apply(hex.value, alpha.value));
  for (const field of [hex, alpha]) field.addEventListener('keydown', event => { if (event.key === 'Enter') field.blur(); });
  row.querySelectorAll('.swatch').forEach(button => button.addEventListener('click', () => apply(button.dataset.colorValue)));
  row._applyColor = apply;
  colorRoot.append(row);
}
byId('mono-reset').addEventListener('click', () => {
  restoring = true;
  colorRoot.querySelectorAll('.color-row').forEach(row => row._applyColor('#ffffff', 100));
  colorRoot.querySelector('[data-color="label"]')?._applyColor('#080808', 100);
  restoring = false; commitHistory();
});

function enhanceSliders() {
  document.querySelectorAll('.control input[type="range"],.transport input[type="range"]').forEach(input => {
    if (input.id === 'scrub' || input.dataset.enhanced) return;
    input.dataset.enhanced = 'true';
    const row = document.createElement('div'); row.className = 'range-row';
    input.parentNode.insertBefore(row, input); row.append(input);
    for (const [label, direction] of [['−', -1], ['+', 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'range-step'; button.textContent = label; button.setAttribute('aria-label', `${label === '+' ? 'Increase' : 'Decrease'} ${input.id}`);
      if (direction < 0) row.prepend(button); else row.append(button);
      button.addEventListener('click', () => {
        const step = Number(input.step) > 0 ? Number(input.step) : 1;
        input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + direction * step)));
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const output = document.querySelector(`output[for="${input.id}"]`);
    if (output) {
      output.classList.add('editable-value'); output.tabIndex = 0; output.setAttribute('role', 'button'); output.title = 'Tap to enter an exact value';
      const edit = () => {
        if (output.hidden) return;
        const exact = document.createElement('input'); exact.type = 'number'; exact.className = 'exact-value'; exact.min = input.min; exact.max = input.max; exact.step = input.step || '1'; exact.value = input.value; exact.setAttribute('aria-label', `Exact ${input.id} value`);
        output.replaceWith(exact); exact.focus(); exact.select();
        const finish = (apply) => {
          if (!exact.isConnected) return;
          if (apply && exact.value !== '') { input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(exact.value)))); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
          exact.replaceWith(output);
        };
        exact.addEventListener('keydown', event => { if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
        exact.addEventListener('blur', () => finish(true), { once: true });
      };
      output.addEventListener('click', edit); output.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
    }
    input.addEventListener('pointerdown', event => { try { input.setPointerCapture(event.pointerId); } catch {} });
  });
}

const defaults = { 'depth-mix': 64, contours: 72, density: 66, size: 1.4, drift: 34, brightness: 88, grain: 62, surface: 56, impact: 68 };
const keys = { 'depth-mix': 'depthMix' };
const blobEnabled = byId('blob-enabled');
const blobControls = byId('blob-controls');
const blobStatus = byId('blob-status');
const blobSettings = {};
const settingKey = (key) => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
for (const key of ['sensitivity', 'minimum', 'smoothing', 'trail', 'limit', 'flicker-amount', 'pulse-amount', 'padding', 'thickness', 'opacity', 'box-scale', 'audio-threshold', 'audio-sensitivity', 'audio-random', 'audio-duration']) {
  const input = byId('blob-' + key);
  const output = document.querySelector(`output[for="${input.id}"]`);
  const refresh = () => {
    const divisor = key === 'limit' ? 1 : key === 'audio-duration' ? 1000 : 100;
    blobSettings[settingKey(key)] = Number(input.value) / divisor;
    output.value = input.value + (key === 'limit' ? '' : input.dataset.unit || '%');
    updateFill(input);
    if (key === 'sensitivity' || key === 'minimum' || key === 'limit') visual.resetBlobs();
  };
  input.addEventListener('input', refresh);
  refresh();
}
for (const key of ['links', 'tiles', 'mode', 'trails', 'sync', 'flicker', 'size-pulse', 'random-numbers', 'number-mode', 'box', 'box-style', 'labels', 'center', 'audio-appear', 'audio-band']) {
  const input = byId('blob-' + key);
  const refresh = () => {
    blobSettings[settingKey(key)] = input.type === 'checkbox' ? input.checked : input.value;
    if (key === 'mode') visual.resetBlobs();
  };
  input.addEventListener('change', refresh);
  refresh();
}
function toggleBlobs() {
  blobControls.hidden = !blobEnabled.checked;
  settings.blobs = blobEnabled.checked ? blobSettings : null;
  visual.resetBlobs();
}
blobEnabled.addEventListener('change', toggleBlobs);
toggleBlobs();

for (const [prefix, key, names] of [
  ['warp', 'warp', ['sync', 'mode', 'amount', 'speed']],
  ['strobe', 'strobe', ['sync', 'mode', 'intensity', 'duration', 'rate']]
]) {
  const group = {};
  for (const name of names) {
    const input = byId(prefix + '-' + name);
    const refresh = () => {
      if (input.type === 'range') {
        const duration = prefix === 'strobe' && name === 'duration';
        const rate = prefix === 'strobe' && name === 'rate';
        group[name] = Number(input.value) / (rate ? 1 : duration ? 1000 : 100);
        document.querySelector(`output[for="${input.id}"]`).value = input.value + (rate ? ' Hz' : duration ? ' ms' : '%');
        updateFill(input);
      } else {
        group[name] = input.type === 'checkbox' ? input.checked : input.value;
        if (prefix === 'strobe') visual.resetStrobe();
      }
    };
    input.addEventListener(input.type === 'range' ? 'input' : 'change', refresh);
    refresh();
  }
  const toggle = byId(prefix + '-enabled');
  const refresh = () => {
    byId(prefix + '-controls').hidden = !toggle.checked;
    settings[key] = toggle.checked ? group : null;
    if (prefix === 'strobe') visual.resetStrobe();
  };
  toggle.addEventListener('change', refresh);
  refresh();
}
const dustEnabled = byId('dust-enabled');
const refreshDust = () => { settings.dustEnabled = dustEnabled.checked; };
dustEnabled.addEventListener('change', refreshDust);
refreshDust();
const warpStatus = byId('warp-status');
const strobeStatus = byId('strobe-status');

let depthAvailable = false;
const objectIds = ['x','y','depth','rx','ry','rz','scale','width','height','zscale','tint','opacity','brightness','roughness','layer','wireframe','shadow','warp','depth-assist','quality','glow-enabled','glow-style','glow-placement','glow-intensity','glow-radius','glow-opacity','anchor','track','smoothing','motion-pulse','motion-bounce','motion-intensity','auto-rotate','show-pivot','pivot-export','rotate-x-enabled','rotate-y-enabled','rotate-z-enabled','rotate-x-direction','rotate-x-speed','rotate-x-intensity','rotate-y-direction','rotate-y-speed','rotate-y-intensity','rotate-z-direction','rotate-z-speed','rotate-z-intensity','rotation-acceleration','motion-rotate','rotation-band','rotation-sensitivity','collapse-enabled','collapse-audio','collapse-auto-reform','collapse-use-dust','collapse-band','collapse-threshold','collapse-sensitivity','collapse-intensity','collapse-count','collapse-size','collapse-spread','collapse-drift','collapse-gravity','collapse-duration','collapse-reform-delay','collapse-fade','collapse-color','collapse-opacity','audio-sync','hit-flash','band','audio-response','touch','touch-mode'];
function refreshObject() {
  const read = (key) => byId('object-' + key);
  const value = (key) => Number(read(key).value);
  settings.object = {
    enabled: read('enabled').checked,
    x: value('x'), y: value('y'), depth: value('depth'), rx: value('rx'), ry: value('ry'), rz: value('rz'),
    scale: value('scale'), width: value('width'), height: value('height'), zscale: value('zscale'),
    tint: read('tint').value, opacity: value('opacity'), brightness: value('brightness'), roughness: value('roughness'),
    layer: read('layer').value, wireframe: read('wireframe').checked, shadow: read('shadow').checked,
    warp: read('warp').checked, depthAssist: read('depth-assist').checked, quality: read('quality').value,
    glowEnabled: read('glow-enabled').checked, glowIntensity: value('glow-intensity'), glowRadius: value('glow-radius'), glowOpacity: value('glow-opacity'),
    glowStyle: read('glow-style').value, glowPlacement: read('glow-placement').value,
    anchor: read('anchor').value, track: read('track').value, smoothing: value('smoothing'),
    rotateMotion: read('motion-rotate').checked, pulse: read('motion-pulse').checked, bounce: read('motion-bounce').checked,
    autoRotate: read('auto-rotate').checked, showPivot: read('show-pivot').checked, pivotExport: read('pivot-export').checked,
    rotateXEnabled: read('rotate-x-enabled').checked, rotateYEnabled: read('rotate-y-enabled').checked, rotateZEnabled: read('rotate-z-enabled').checked,
    rotateXDirection: Number(read('rotate-x-direction').value), rotateXSpeed: value('rotate-x-speed'), rotateXIntensity: value('rotate-x-intensity'),
    rotateYDirection: Number(read('rotate-y-direction').value), rotateYSpeed: value('rotate-y-speed'), rotateYIntensity: value('rotate-y-intensity'),
    rotateZDirection: Number(read('rotate-z-direction').value), rotateZSpeed: value('rotate-z-speed'), rotateZIntensity: value('rotate-z-intensity'),
    rotationAcceleration: value('rotation-acceleration'), rotationBand: read('rotation-band').value, rotationSensitivity: value('rotation-sensitivity'),
    collapseEnabled: read('collapse-enabled').checked, collapseAudio: read('collapse-audio').checked, collapseAutoReform: read('collapse-auto-reform').checked, collapseUseDust: read('collapse-use-dust').checked,
    collapseBand: read('collapse-band').value, collapseThreshold: value('collapse-threshold'), collapseSensitivity: value('collapse-sensitivity'),
    collapseIntensity: value('collapse-intensity'), collapseCount: value('collapse-count'), collapseSize: value('collapse-size'),
    collapseSpread: value('collapse-spread'), collapseDrift: value('collapse-drift'), collapseGravity: value('collapse-gravity'),
    collapseDuration: value('collapse-duration'), collapseReformDelay: value('collapse-reform-delay'), collapseFade: value('collapse-fade'),
    collapseColor: read('collapse-color').value, collapseOpacity: value('collapse-opacity'),
    motionIntensity: value('motion-intensity'), audioSync: read('audio-sync').checked, hitFlash: read('hit-flash').checked,
    band: read('band').value, audioResponse: value('audio-response')
  };
  settings.object.isExporting = Boolean(settings.exporting);
  settings.object.colors = settings.colors;
  byId('object-controls').hidden = !settings.object.enabled;
  byId('object-glow-controls').hidden = !settings.object.glowEnabled || !settings.object.wireframe;
  byId('object-collapse-controls').hidden = !settings.object.collapseEnabled;
  read('collapse-color').disabled = settings.object.collapseUseDust;
  byId('stage').classList.toggle('object-gesture-mode', settings.object.enabled && settings.object.touch);
  if (settings.object.depthAssist && !depthAvailable) byId('object-depth-note').textContent = 'Depth assist is waiting for an analyzed depth map. It stays inactive until depth analysis is ready.';
  else byId('object-depth-note').textContent = settings.object.depthAssist ? 'Approximate depth placement uses the current analyzed depth map.' : 'Depth assist uses the current depth map when available.';
  if (settings.object.enabled && !visual.objectAvailable()) byId('object-status').textContent = '3D rendering unavailable';
}
for (const key of objectIds) {
  const input = byId('object-' + key);
  input.addEventListener(input.type === 'range' || input.type === 'color' ? 'input' : 'change', refreshObject);
}
byId('object-enabled').addEventListener('change', refreshObject);
byId('object-input').addEventListener('change', async event => {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length) return;
  const toggle = byId('object-enabled'); toggle.checked = true; refreshObject();
  const status = byId('object-status');
  const modelName = byId('object-model-name');
  const errorPanel = byId('object-error');
  errorPanel.hidden = true; errorPanel.textContent = '';
  modelName.textContent = files.map(file => file.name).join(', ');
  status.textContent = 'Loading selected file…';
  try {
    await visual.loadObject(files, ({ message: label, progress }) => { status.textContent = `${label} ${progress}%`; }, byId('object-quality').value);
    modelName.textContent = visual.getObjectName();
    if (visual.objectAvailable()) message('3D model loaded locally on this device.');
    else { status.textContent = 'Model loaded · WebGL unavailable'; message(visual.objectError()); }
  } catch (error) {
    console.error('3D object import failed', error);
    const reason = error?.message || 'The model could not be parsed. Confirm the file is FBX, USDZ, GLB, or OBJ.';
    if (!visual.objectReady()) visual.resetObject();
    status.textContent = visual.objectAvailable() ? 'Import failed · sample cube shown' : 'Import failed';
    modelName.textContent = files.map(file => file.name).join(', ');
    errorPanel.textContent = reason;
    errorPanel.hidden = false;
    message(`Could not import ${files[0].name}: ${reason}${visual.objectAvailable() ? ' The sample cube remains in the preview.' : ''}`);
  }
});
byId('object-sample').addEventListener('click', () => {
  visual.resetObject(); byId('object-model-name').textContent = 'Sample cube'; byId('object-status').textContent = 'Sample cube ready'; byId('object-error').hidden = true;
});
byId('object-collapse-now').addEventListener('click', () => {
  visual.collapseObject();
  byId('object-collapse-status').textContent = 'Collapse triggered.';
});
byId('object-reform-now').addEventListener('click', () => {
  visual.reformObject();
  byId('object-collapse-status').textContent = 'Reforming object.';
});
byId('object-remove').addEventListener('click', () => {
  visual.removeObject(); byId('object-model-name').textContent = 'No model'; byId('object-status').textContent = 'Object removed'; byId('object-error').hidden = true;
});
byId('object-reset').addEventListener('click', () => {
  const values = { x:50,y:50,depth:50,rx:12,ry:28,rz:0,scale:72,width:100,height:100,zscale:100 };
  for (const [key,value] of Object.entries(values)) { const input = byId('object-' + key); input.value = value; input.dispatchEvent(new Event('input', { bubbles:true })); }
});
refreshObject();

let objectDrag = null;
canvas.addEventListener('pointerdown', event => {
  if (!settings.object?.enabled || !settings.object.touch) return;
  event.preventDefault(); event.stopPropagation();
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  objectDrag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, values: Object.fromEntries(['x','y','rx','ry'].map(key => [key, Number(byId('object-' + key).value)])) };
});
canvas.addEventListener('pointermove', event => {
  if (!objectDrag || objectDrag.pointer !== event.pointerId) return;
  const rect = canvas.getBoundingClientRect();
  const dx = (event.clientX - objectDrag.x) / Math.max(1, rect.width) * 100;
  const dy = (event.clientY - objectDrag.y) / Math.max(1, rect.height) * 100;
  const rotate = byId('object-touch-mode').value === 'rotate';
  for (const [key, value] of Object.entries(rotate ? { rx: objectDrag.values.rx - dy * 1.8, ry: objectDrag.values.ry + dx * 1.8 } : { x: objectDrag.values.x + dx, y: objectDrag.values.y + dy })) {
    const input = byId('object-' + key);
    input.value = Math.max(Number(input.min), Math.min(Number(input.max), value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
const finishObjectDrag = event => { if (objectDrag?.pointer === event.pointerId) objectDrag = null; };
canvas.addEventListener('pointerup', finishObjectDrag); canvas.addEventListener('pointercancel', finishObjectDrag);

const ranges = { bass: [35, 180], mid: [180, 2200], high: [2200, 10000] };
let view = 'dust';
let band = 'bass';
let isDemo = true;
let running = false;
let visualUrl;
let externalAudio;
let audioSelection = 0;
let audioTrimStart = 0;
let audioTrimEnd = 0;
let audioWavePeaks = [];
let audioDecodedDuration = 0;
let waveformDrag = null;
let exportUrl;
let exportFile;
let graph;
let smooth = 0;
let average = 0;
let beat = 0;
let beatId = 0;
let lastOnset = -Infinity;
let displayMuted = false;
let lastMoment = 0;
let demoPosition = 0;
let lastAudioClock = 0;
let lastFadeEnvelope = 1;
let worker;
let depthEnabled = false;
let modelProgress = 0;
let depthFailed = false;
let modelReady = false;
let pendingFrame = null;
let cycle = 0;
let previousVideoTime = -1;
let nextInference = 0;
let depthTimeout;
let recorder;
let exportStartedAt = 0;
let exportExpectedSeconds = 0;
let exportEstimatedBitsPerSecond = 0;
let exportDrawFrame = 0;
let exportProgressTimer;
let exportEstimateSecond = -1;
let scrubbing = false;
let decodedTime = null;

for (const id of Object.keys(defaults)) {
  const input = byId(id);
  const output = document.querySelector(`output[for="${id}"]`);
  const refresh = () => {
    settings[keys[id] ?? id] = Number(input.value) / (id === 'size' ? 1 : 100);
    output.value = input.value + (input.dataset.unit ?? '%');
    updateFill(input);
  };
  input.addEventListener('input', refresh);
  refresh();
}

function updateFill(input) {
  const percent = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--fill', percent + '%');
}

function activateButtons(selector, key, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset[key] === value));
  });
}

function setView(value) {
  view = value;
  activateButtons('[data-view]', 'view', value);
  updateDepthUI();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});
document.querySelectorAll('[data-band]').forEach((button) => {
  button.addEventListener('click', () => {
    band = button.dataset.band;
    smooth = average = beat = 0;
    activateButtons('[data-band]', 'band', band);
  });
});
byId('reset').addEventListener('click', () => {
  restoring = true;
  for (const [id, value] of Object.entries(defaults)) {
    const input = byId(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  for (const id of ['blob-enabled', 'warp-enabled', 'strobe-enabled', 'dust-enabled', 'reactive', 'object-enabled']) {
    const toggle = byId(id);
    toggle.checked = toggle.defaultChecked;
    toggle.dispatchEvent(new Event('change'));
  }
  for (const input of document.querySelectorAll('#blob-controls input, #blob-controls select, #warp-controls input, #warp-controls select, #strobe-controls input, #strobe-controls select, #object-controls input, #object-controls select')) {
    if (input.type === 'checkbox') input.checked = input.defaultChecked;
    else if (input.tagName === 'SELECT') input.selectedIndex = 0;
    else input.value = input.defaultValue;
    input.dispatchEvent(new Event(input.type === 'range' ? 'input' : 'change'));
  }
  visual.resetObject(); byId('object-model-name').textContent = 'Sample cube'; byId('object-status').textContent = 'Sample cube ready'; byId('object-error').hidden = true;
  colorRoot.querySelectorAll('.color-row').forEach(row => row._applyColor('#ffffff', 100));
  document.querySelector('[data-band="bass"]').click();
  restoring = false;
  commitHistory();
});

function message(text) {
  notice.textContent = text;
}

function formatTime(value) {
  const total = Math.max(0, Math.floor(value || 0));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function duration() {
  const trimLength = Math.max(0, audioTrimEnd - audioTrimStart);
  const length = isDemo ? (externalAudio?.url && trimLength > 0 ? trimLength : Number.isFinite(audio.duration) ? audio.duration : 8) : video.duration;
  return Number.isFinite(length) ? length : 0;
}

function playbackTime() {
  if (!isDemo) return video.currentTime || 0;
  return audio.paused ? demoPosition : Math.max(0, audio.currentTime - (externalAudio ? audioTrimStart : 0));
}

function knownAudioLength() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : audioDecodedDuration;
}

function updateAudioTrimFields() {
  const active = Boolean(externalAudio);
  const length = knownAudioLength();
  byId('audio-trim-start').disabled = !active || !length;
  byId('audio-trim-end').disabled = !active || !length;
  byId('audio-scrub').disabled = !active || !length;
  byId('audio-play-selection').disabled = !active || !length;
  byId('audio-set-start').disabled = !active || !length;
  byId('audio-set-end').disabled = !active || !length;
  byId('audio-reset-trim').disabled = !active || !length;
  byId('audio-trim-status').textContent = active
    ? length ? `${externalAudio.name} · drag the waveform handles or edit the times.` : 'Reading audio duration…'
    : 'Import an MP3 or WAV to trim it. Video sound stays unchanged.';
  const trimLength = Math.max(0, audioTrimEnd - audioTrimStart);
  byId('audio-trim-start').value = audioTrimStart.toFixed(2);
  byId('audio-trim-end').value = audioTrimEnd.toFixed(2);
  byId('audio-trim-length').value = `${trimLength.toFixed(2)} s`;
  byId('audio-scrub').value = active && length ? String(Math.round(Math.max(0, Math.min(1, (audio.currentTime - audioTrimStart) / Math.max(.01, trimLength))) * 1000)) : '0';
  document.querySelector('output[for="audio-scrub"]').value = `${Math.max(0, audio.currentTime - audioTrimStart).toFixed(2)} s`;
  paintAudioWaveform();
}

function setAudioTrim(start, end = audioTrimEnd) {
  const length = knownAudioLength();
  if (!length) return;
  const minSpan = Math.min(.05, length);
  const requestedStart = Number.isFinite(Number(start)) ? Number(start) : audioTrimStart;
  const requestedEnd = Number.isFinite(Number(end)) ? Number(end) : audioTrimEnd;
  audioTrimStart = Math.max(0, Math.min(length - minSpan, requestedStart));
  audioTrimEnd = Math.max(audioTrimStart + minSpan, Math.min(length, requestedEnd));
  updateAudioTrimFields();
  if (isDemo) demoPosition = Math.min(demoPosition, Math.max(0, audioTrimEnd - audioTrimStart));
  if (externalAudio) syncAudioToTimeline(isDemo ? demoPosition : video.currentTime);
  applyAudioMix();
}

function paintAudioWaveform() {
  if (!waveformCtx) return;
  const box = waveform.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(300, Math.round((box.width || 600) * ratio));
  const height = Math.max(64, Math.round((box.height || 64) * ratio));
  if (waveform.width !== width || waveform.height !== height) { waveform.width = width; waveform.height = height; }
  waveformCtx.clearRect(0, 0, width, height);
  waveformCtx.fillStyle = '#080808'; waveformCtx.fillRect(0, 0, width, height);
  const mid = height / 2;
  waveformCtx.strokeStyle = '#363636'; waveformCtx.lineWidth = 1;
  waveformCtx.beginPath(); waveformCtx.moveTo(0, mid); waveformCtx.lineTo(width, mid); waveformCtx.stroke();
  if (!audioWavePeaks.length || !knownAudioLength()) {
    waveformCtx.fillStyle = '#8d8d8d'; waveformCtx.font = `${12 * ratio}px system-ui`;
    waveformCtx.textAlign = 'center'; waveformCtx.fillText('IMPORT AUDIO TO SEE WAVEFORM', width / 2, mid + 4 * ratio);
    return;
  }
  const fileLength = knownAudioLength();
  const sx = audioTrimStart / fileLength * width, ex = audioTrimEnd / fileLength * width;
  waveformCtx.fillStyle = 'rgba(0,0,0,.67)';
  waveformCtx.fillRect(0, 0, sx, height); waveformCtx.fillRect(ex, 0, width - ex, height);
  waveformCtx.strokeStyle = '#aaa'; waveformCtx.lineWidth = Math.max(1, ratio);
  const step = width / audioWavePeaks.length;
  waveformCtx.beginPath();
  for (let i = 0; i < audioWavePeaks.length; i++) {
    const x = (i + .5) * step, peak = audioWavePeaks[i] * height * .42;
    waveformCtx.moveTo(x, mid - peak); waveformCtx.lineTo(x, mid + peak);
  }
  waveformCtx.stroke();
  waveformCtx.strokeStyle = '#fff'; waveformCtx.lineWidth = Math.max(2, ratio * 1.5);
  for (const x of [sx, ex]) { waveformCtx.beginPath(); waveformCtx.moveTo(x, 0); waveformCtx.lineTo(x, height); waveformCtx.stroke(); }
  const handleWidth = 7 * ratio;
  waveformCtx.fillStyle = '#fff'; waveformCtx.fillRect(sx - handleWidth / 2, height * .33, handleWidth, height * .34);
  waveformCtx.fillRect(ex - handleWidth / 2, height * .33, handleWidth, height * .34);
  const current = externalAudio ? audio.currentTime : 0;
  const px = current / fileLength * width;
  waveformCtx.strokeStyle = '#aaa'; waveformCtx.lineWidth = Math.max(1, ratio);
  waveformCtx.beginPath(); waveformCtx.moveTo(px, 0); waveformCtx.lineTo(px, height); waveformCtx.stroke();
  if (byId('audio-scrub')) {
    const selected = Math.max(.01, audioTrimEnd - audioTrimStart);
    byId('audio-scrub').value = String(Math.round(Math.max(0, Math.min(1, (current - audioTrimStart) / selected)) * 1000));
    document.querySelector('output[for="audio-scrub"]').value = `${Math.max(0, current - audioTrimStart).toFixed(2)} s`;
  }
}

async function buildAudioWaveform(blob, selection) {
  audioWavePeaks = []; audioDecodedDuration = 0; updateAudioTrimFields();
  try {
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) throw new Error('Audio decoding unavailable');
    const localContext = graph?.context ?? new Context();
    const buffer = await localContext.decodeAudioData(await blob.arrayBuffer());
    if (selection !== audioSelection) return;
    audioDecodedDuration = buffer.duration;
    const bins = 900, step = Math.max(1, Math.floor(buffer.length / (bins * 192)));
    const channels = Array.from({length: buffer.numberOfChannels}, (_, index) => buffer.getChannelData(index));
    audioWavePeaks = new Array(bins).fill(0);
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.floor(bin / bins * buffer.length), end = Math.max(start + 1, Math.floor((bin + 1) / bins * buffer.length));
      let peak = 0;
      for (let i = start; i < end; i += step) for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] || 0));
      audioWavePeaks[bin] = peak;
    }
    if (audioTrimEnd <= 0 || audioTrimEnd > audioDecodedDuration) audioTrimEnd = audioDecodedDuration;
    updateAudioTrimFields();
    if (!graph) void localContext.close().catch(() => {});
  } catch (error) {
    console.warn('Audio waveform decode failed', error);
    if (selection === audioSelection) byId('audio-trim-status').textContent = 'Audio loaded; waveform decoding is unavailable here. Use the time fields to trim.';
  }
}

function syncAudioToTimeline(time) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const offset = externalAudio ? audioTrimStart : 0;
  const end = externalAudio ? audioTrimEnd : audio.duration;
  const desired = offset + Math.max(0, time);
  audio.currentTime = Math.max(offset, Math.min(Math.max(offset, end - .015), desired));
  paintAudioWaveform();
}

function audioFadeEnvelope() {
  if (!externalAudio) return 1;
  const span = Math.max(.01, audioTrimEnd - audioTrimStart);
  const elapsed = audio.currentTime - audioTrimStart;
  if (elapsed < 0 || elapsed > span) return 0;
  const fadeIn = Number(byId('audio-fade-in').value) / 1000;
  const fadeOut = Number(byId('audio-fade-out').value) / 1000;
  const inLevel = fadeIn > 0 ? Math.min(1, elapsed / fadeIn) : 1;
  const outLevel = fadeOut > 0 ? Math.min(1, (span - elapsed) / fadeOut) : 1;
  return Math.max(0, Math.min(inLevel, outLevel));
}

function resize(width, height) {
  const longest = Math.max(width, height);
  const scale = Math.min(1, 1080 / longest);
  canvas.width = Math.max(2, Math.round(width * scale / 2) * 2);
  canvas.height = Math.max(2, Math.round(height * scale / 2) * 2);
  byId('frame-size').textContent = canvas.width + ' × ' + canvas.height;
  byId('stage').classList.toggle('portrait', height > width);
  visual.reset(canvas.width, canvas.height);
}

function setRunning(value) {
  running = value;
  if (!value) visual.resetStrobe();
  play.classList.toggle('playing', value);
  play.setAttribute('aria-label', value ? 'Pause' : 'Play');
}

function configureAudio() {
  if (graph) return graph;
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = .32;
  const videoGain = context.createGain();
  const audioGain = context.createGain();
  const monitor = context.createGain();
  const output = context.createMediaStreamDestination();
  context.createMediaElementSource(video).connect(videoGain).connect(analyser);
  context.createMediaElementSource(audio).connect(audioGain).connect(analyser);
  analyser.connect(output);
  analyser.connect(monitor).connect(context.destination);
  graph = { context, analyser, videoGain, audioGain, monitor, output, bins: new Uint8Array(analyser.frequencyBinCount) };
  applyAudioMix();
  return graph;
}

function applyAudioMix() {
  const useSeparateTrack = isDemo || Boolean(externalAudio);
  if (!graph) {
    video.muted = displayMuted || useSeparateTrack;
    audio.muted = displayMuted;
    return;
  }
  video.muted = false;
  audio.muted = false;
  graph.videoGain.gain.value = useSeparateTrack ? 0 : 1;
  graph.audioGain.gain.value = useSeparateTrack ? audioFadeEnvelope() : 0;
  graph.monitor.gain.value = displayMuted ? 0 : 1;
}

function updateAudioSource() {
  const next = externalAudio?.url ?? (isDemo ? demoAudio : '');
  if (next && audio.src !== next) audio.src = next;
  if (!next && audio.getAttribute('src')) {
    audio.removeAttribute('src');
    audio.load();
  }
  byId('audio-name').textContent = externalAudio?.name ?? (isDemo ? 'Demo audio' : 'Video sound');
  byId('clear-audio').hidden = !externalAudio;
  updateAudioTrimFields();
  applyAudioMix();
  smooth = average = beat = 0;
}

async function startPlayback() {
  if (!isDemo && (!video.getAttribute('src') || video.error)) {
    message('Choose a playable video first.');
    return false;
  }
  try {
    configureAudio();
  } catch (error) {
    console.warn('Audio analysis unavailable', error);
    message('Audio analysis is unavailable in this browser.');
  }
  const tasks = [];
  if (graph) tasks.push(graph.context.resume());
  if (!isDemo) tasks.push(video.play());
  if (audio.getAttribute('src')) {
    if (audio.readyState > 0 && Number.isFinite(audio.duration) && audio.duration > 0) {
      const timeline = isDemo ? demoPosition : video.currentTime;
      if (externalAudio) syncAudioToTimeline(timeline);
      else audio.currentTime = timeline % audio.duration;
    }
    tasks.push(audio.play().catch((error) => {
      console.warn('Audio playback unavailable', error);
      message('The current audio file could not play.');
      if (isDemo) throw error;
    }));
  }
  const result = await Promise.allSettled(tasks);
  if (result.some((task) => task.status === 'rejected')) {
    pausePlayback();
    message('Playback could not start. Try tapping Play again or using an MP4 with AAC audio.');
    return false;
  }
  setRunning(true);
  return true;
}

function pausePlayback() {
  if (isDemo) demoPosition = playbackTime();
  video.pause();
  audio.pause();
  setRunning(false);
}

play.addEventListener('click', () => {
  if (running) pausePlayback();
  else void startPlayback();
});

byId('mute').addEventListener('click', (event) => {
  displayMuted = !displayMuted;
  event.currentTarget.textContent = displayMuted ? 'Muted' : 'Sound';
  event.currentTarget.setAttribute('aria-pressed', String(displayMuted));
  applyAudioMix();
});

byId('video-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || recorder) return;
  pausePlayback();
  cancelDepth();
  if (visualUrl) URL.revokeObjectURL(visualUrl);
  visualUrl = URL.createObjectURL(file);
  isDemo = false;
  decodedTime = null;
  video.src = visualUrl;
  byId('project').textContent = file.name;
  byId('frame-size').textContent = 'Loading…';
  updateAudioSource();
  if (view === 'source') setView('dust');
  updateDepthUI();
  message('Loading video…');
});

video.addEventListener('seeking', () => {
  decodedTime = null;
  if (externalAudio) syncAudioToTimeline(video.currentTime);
  visual.resetBlobs();
  visual.resetStrobe();
});

function trackDecodedFrame(_, frame) {
  if (!isDemo && !video.seeking) {
    decodedTime = frame.mediaTime;
    visual.trackFrame(video, decodedTime, settings.blobs);
  }
  video.requestVideoFrameCallback(trackDecodedFrame);
}
video.requestVideoFrameCallback?.(trackDecodedFrame);

video.addEventListener('loadedmetadata', () => {
  if (isDemo || !video.videoWidth || !video.videoHeight) return;
  resize(video.videoWidth, video.videoHeight);
  // Keep video import, playback, tracking, and dust responsive on iPhone.
  // The ONNX model is memory-heavy, so load it only when the user requests depth.
  updateDepthUI();
});

video.addEventListener('loadeddata', () => {
  if (isDemo) return;
  message('Video ready. Tap Play to animate the dust.');
  updateDepthUI();
});

video.addEventListener('error', () => {
  if (isDemo) return;
  byId('frame-size').textContent = 'Video unavailable';
  message('This video could not open. Try an H.264 MP4 or MOV.');
  pausePlayback();
  updateDepthUI();
});

function replaceAudio(file) {
  pausePlayback();
  if (externalAudio) URL.revokeObjectURL(externalAudio.url);
  externalAudio = file ? { url: URL.createObjectURL(file.blob), name: file.name } : null;
  audioTrimStart = 0; audioTrimEnd = 0; audioDecodedDuration = 0; audioWavePeaks = [];
  updateAudioSource();
  if (file) void buildAudioWaveform(file.blob, audioSelection);
  updateAudioTrimFields();
  message(file ? 'Audio loaded. Tap Play to start the response.' : 'Restored the original sound.');
}

async function readAudioFile(file) {
  const extension = /\.(mp3|wav)$/i.exec(file.name)?.[1].toLowerCase();
  if (!extension) return null;
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = String.fromCharCode(...header);
  const wav = /^(RIFF|RIFX|RF64)/.test(text) && text.slice(8, 12) === 'WAVE';
  const mp3Frame = header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 0x06) === 0x02 &&
    (header[1] & 0x18) !== 0x08 && (header[2] & 0xf0) !== 0xf0 && (header[2] & 0x0c) !== 0x0c;
  const mp3 = text.startsWith('ID3') || mp3Frame;
  if (extension === 'wav' && wav) return { name: file.name, blob: file.slice(0, file.size, 'audio/wav') };
  if (extension === 'mp3' && mp3) return { name: file.name, blob: file.slice(0, file.size, 'audio/mpeg') };
  return null;
}

byId('audio-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || recorder) return;
  const selection = ++audioSelection;
  try {
    const track = await readAudioFile(file);
    if (selection !== audioSelection || recorder) return;
    if (track) replaceAudio(track);
    else message('Choose an MP3 or WAV audio file.');
  } catch (error) {
    if (selection === audioSelection) message('This audio file could not be read. Try another MP3 or WAV.');
  }
});
byId('clear-audio').addEventListener('click', () => {
  if (recorder) return;
  audioSelection++;
  replaceAudio(null);
});
audio.addEventListener('loadedmetadata', () => {
  if (!externalAudio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audioDecodedDuration = audio.duration;
  if (audioTrimEnd <= 0) audioTrimEnd = audio.duration;
  else audioTrimEnd = Math.min(audioTrimEnd, audio.duration);
  audioTrimStart = Math.min(audioTrimStart, Math.max(0, audioTrimEnd - .05));
  updateAudioTrimFields();
  applyAudioMix();
});
audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) message('This audio could not open. Try a different MP3 or WAV.');
});

byId('audio-trim-start').addEventListener('change', event => setAudioTrim(Number(event.currentTarget.value), audioTrimEnd));
byId('audio-trim-end').addEventListener('change', event => setAudioTrim(audioTrimStart, Number(event.currentTarget.value)));
byId('audio-scrub').addEventListener('input', event => {
  if (!externalAudio || !knownAudioLength()) return;
  const offset = Number(event.currentTarget.value) / 1000 * (audioTrimEnd - audioTrimStart);
  audio.currentTime = Math.max(audioTrimStart, Math.min(audioTrimEnd - .015, audioTrimStart + offset));
  const timeline = Math.max(0, audio.currentTime - audioTrimStart);
  if (isDemo) demoPosition = timeline;
  else if (Number.isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, video.duration - .01), timeline);
  paintAudioWaveform(); updateAudioTrimFields();
});
byId('audio-reset-trim').addEventListener('click', () => setAudioTrim(0, knownAudioLength()));
byId('audio-set-start').addEventListener('click', () => setAudioTrim(audio.currentTime, audioTrimEnd));
byId('audio-set-end').addEventListener('click', () => setAudioTrim(audioTrimStart, audio.currentTime));
byId('audio-play-selection').addEventListener('click', async () => {
  if (!externalAudio || !knownAudioLength()) { message('Import an MP3 or WAV before previewing a trim.'); return; }
  pausePlayback();
  if (isDemo) demoPosition = 0;
  else if (video.readyState >= 1) video.currentTime = 0;
  syncAudioToTimeline(0);
  await startPlayback();
});
waveform.addEventListener('pointerdown', event => {
  if (!externalAudio || !knownAudioLength()) return;
  const rect = waveform.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const time = ratio * knownAudioLength();
  waveformDrag = Math.abs(time - audioTrimStart) <= Math.abs(time - audioTrimEnd) ? 'start' : 'end';
  waveform.setPointerCapture(event.pointerId);
  setAudioTrim(waveformDrag === 'start' ? time : audioTrimStart, waveformDrag === 'end' ? time : audioTrimEnd);
});
waveform.addEventListener('pointermove', event => {
  if (!waveformDrag) return;
  const rect = waveform.getBoundingClientRect();
  const time = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))) * knownAudioLength();
  setAudioTrim(waveformDrag === 'start' ? time : audioTrimStart, waveformDrag === 'end' ? time : audioTrimEnd);
});
for (const name of ['pointerup','pointercancel','lostpointercapture']) waveform.addEventListener(name, () => {
  if (waveformDrag) { waveformDrag = null; byId('audio-trim-start').dispatchEvent(new Event('change', { bubbles: true })); }
});
window.addEventListener('resize', paintAudioWaveform);

byId('demo').addEventListener('click', () => {
  if (recorder) return;
  audioSelection++;
  pausePlayback();
  cancelDepth();
  isDemo = true;
  demoPosition = 0;
  video.removeAttribute('src');
  video.load();
  if (visualUrl) URL.revokeObjectURL(visualUrl);
  if (externalAudio) URL.revokeObjectURL(externalAudio.url);
  visualUrl = externalAudio = null;
  audioTrimStart = audioTrimEnd = audioDecodedDuration = 0; audioWavePeaks = [];
  byId('project').textContent = 'Demo scene';
  resize(960, 540);
  updateAudioSource();
  setView('dust');
  message('Demo loaded. Tap Play to hear the audio response.');
});

scrub.addEventListener('pointerdown', () => { scrubbing = true; });
for (const event of ['pointerup', 'pointercancel', 'blur', 'change']) {
  scrub.addEventListener(event, () => { scrubbing = false; });
}
scrub.addEventListener('input', () => {
  updateFill(scrub);
  const time = Math.min(duration() - .001, Number(scrub.value) / 1000 * duration());
  if (!(time >= 0)) return;
  if (isDemo) demoPosition = time;
  else video.currentTime = time;
  if (externalAudio) syncAudioToTimeline(time);
  else if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = time % audio.duration;
  clearCurrentDepth();
  visual.resetBlobs();
  nextInference = performance.now() + 120;
  updateDepthUI();
});

function updateDepthUI() {
  analyze.hidden = isDemo || video.readyState < 1 || Boolean(video.error);
  analyze.textContent = depthEnabled ? 'Pause depth' : depthFailed ? 'Retry depth' : 'Analyze depth';
  depthHint.hidden = isDemo || !depthEnabled && !depthFailed && view !== 'depth';
  mapMessage.hidden = isDemo || view !== 'depth' || depthAvailable;
  if (isDemo) {
    depthStatus.textContent = 'Demo geometry';
    return;
  }

  if (depthFailed) {
    depthStatus.textContent = 'Depth unavailable';
    depthHint.textContent = 'Tap Retry depth to reload the model.';
    mapMessage.textContent = 'Tap Retry depth to try again.';
  } else if (!depthEnabled) {
    depthStatus.textContent = depthAvailable ? 'Paused · last map' : 'Depth off';
    depthHint.textContent = 'Turn depth analysis on to estimate what is nearer in the frame.';
    mapMessage.textContent = 'Tap Analyze depth to scan the current frame.';
  } else if (modelReady) {
    depthStatus.textContent = depthAvailable ? 'Relative depth' : 'Analyzing frame';
    depthHint.textContent = 'Brighter areas are estimated to be closer. Analysis samples frames during playback.';
    mapMessage.textContent = video.readyState < 2 ? 'Tap Play to decode the first frame.' : 'Analyzing the current frame…';
  } else {
    depthStatus.textContent = modelProgress ? `Loading ${modelProgress}%` : 'Loading model';
    depthHint.textContent = 'First load downloads the depth engine. Analysis runs on your device.';
    mapMessage.textContent = 'Loading the depth engine…';
  }
}

function clearCurrentDepth() {
  cycle++;
  depthAvailable = false;
  previousVideoTime = -1;
  visual.clearDepth();
}

function cancelDepth() {
  clearCurrentDepth();
  depthEnabled = false;
  depthFailed = false;
}

function stopDepthWorker(error) {
  console.warn('Depth analysis unavailable', error);
  clearTimeout(depthTimeout);
  worker?.terminate();
  worker = null;
  modelReady = false;
  modelProgress = 0;
  pendingFrame = null;
  depthEnabled = false;
  depthFailed = !isDemo;
  previousVideoTime = -1;
  updateDepthUI();
}

function beginDepth() {
  depthEnabled = true;
  depthFailed = false;
  nextInference = 0;
  previousVideoTime = -1;
  if (!worker) startDepthWorker();
  updateDepthUI();
}

function startDepthWorker() {
  try {
    worker = new Worker(new URL('./depth-worker.js?v=3', import.meta.url), { type: 'module' });
  } catch (error) {
    stopDepthWorker(error);
    return;
  }
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      modelProgress = data.progress;
      if (depthEnabled) updateDepthUI();
    } else if (data.type === 'ready') {
      clearTimeout(depthTimeout);
      modelReady = true;
      updateDepthUI();
    } else if (data.type === 'depth') {
      clearTimeout(depthTimeout);
      pendingFrame = null;
      if (isDemo || data.id !== cycle || !depthEnabled) return;
      visual.updateDepth(data.pixels, data.width, data.height);
      depthAvailable = true;
      updateDepthUI();
    } else if (data.type === 'error') {
      stopDepthWorker(data.message);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stopDepthWorker(event.message);
  };
  worker.postMessage({ type: 'load' });
  depthTimeout = setTimeout(() => stopDepthWorker('Model loading timed out'), 120000);
}

analyze.addEventListener('click', () => {
  if (!depthEnabled) {
    beginDepth();
    return;
  }
  depthEnabled = false;
  cycle++;
  updateDepthUI();
});

function queueDepth(now) {
  if (isDemo || !depthEnabled || !modelReady || pendingFrame !== null || now < nextInference ||
    video.readyState < 2 || video.seeking) return;
  const position = video.currentTime;
  if (Math.abs(position - previousVideoTime) < .01) return;
  const { width, height } = sample;
  sampleCtx.drawImage(video, 0, 0, width, height);
  const rgba = sampleCtx.getImageData(0, 0, width, height).data.buffer;
  previousVideoTime = position;
  nextInference = now + 240;
  pendingFrame = cycle;
  worker.postMessage({ type: 'frame', id: cycle, width, height, rgba }, [rgba]);
  depthTimeout = setTimeout(() => stopDepthWorker('Frame analysis timed out'), 60000);
}

function audioPulse(dt, now) {
  meter.fillStyle = '#080808';
  meter.fillRect(0, 0, 260, 34);
  if (!graph || !running) { settings.audioBands = { bass:0, mid:0, high:0 }; return 0; }
  const { analyser, context, bins } = graph;
  analyser.getByteFrequencyData(bins);
  const hz = context.sampleRate / analyser.fftSize;
  const [lo, hi] = ranges[band];
  const min = Math.max(1, Math.floor(lo / hz));
  const max = Math.min(bins.length - 1, Math.ceil(hi / hz));
  let total = 0;
  for (let i = min; i <= max; i++) total += (bins[i] / 255) ** 2;
  const level = Math.sqrt(total / (max - min + 1));
  settings.audioBands = Object.fromEntries(Object.entries(ranges).map(([name, [low, high]]) => {
    const first = Math.max(1, Math.floor(low / hz)), last = Math.min(bins.length - 1, Math.ceil(high / hz));
    let sum = 0; for (let i = first; i <= last; i++) sum += (bins[i] / 255) ** 2;
    return [name, Math.sqrt(sum / Math.max(1, last - first + 1))];
  }));
  const rise = level - smooth;
  if (level > .14 && rise > Math.max(.065, average * .13) && now - lastOnset >= 145) {
    lastOnset = now;
    beatId++;
  }
  smooth += (level - smooth) * (1 - Math.exp(-dt * 24));
  average += (smooth - average) * (1 - Math.exp(-dt * 2.5));
  beat = Math.max(beat * Math.exp(-dt * 8), Math.min(1, Math.max(0, smooth - average) * 3));
  const bars = 43;
  for (let i = 0; i < bars; i++) {
    const l = Math.max(1, Math.floor(Math.pow(10, 3 * i / bars) * 1.4));
    const r = Math.min(bins.length - 1, Math.max(l + 1, Math.floor(Math.pow(10, 3 * (i + 1) / bars) * 1.4)));
    let peak = bins[l] ?? 0;
    for (let j = l + 1; j <= r; j++) peak = Math.max(peak, bins[j]);
    const size = 1 + peak / 255 * 31;
    meter.fillStyle = l <= max && r >= min ? '#eee' : '#565656';
    meter.fillRect(i * 6 + 2, 33 - size, 3, size);
  }
  return Math.min(1, smooth * .48 + beat * .78);
}

function draw(now) {
  requestAnimationFrame(draw);
  const elapsed = now - lastMoment;
  const targetFrameMs = recorder ? 1000 / (Number(byId('export-fps').value) || 30) : 30;
  if (elapsed < targetFrameMs) return;
  lastMoment = now;
  const time = playbackTime();
  const length = duration();
  byId('time').textContent = formatTime(time);
  byId('duration').textContent = formatTime(length);
  if (!scrubbing) {
    scrub.value = length ? Math.round(time / length * 1000) : 0;
    updateFill(scrub);
  }
  if (!recorder && Math.floor(now / 1000) !== exportEstimateSecond) {
    exportEstimateSecond = Math.floor(now / 1000);
    updateExportSettings();
  }
  settings.audio = audioPulse(Math.min(.12, elapsed / 1000), now);
  if (externalAudio && running && Number.isFinite(audioTrimEnd)) {
    const currentAudio = audio.currentTime;
    const wrapped = currentAudio < lastAudioClock - .25;
    const reachedTrimEnd = currentAudio >= audioTrimEnd - .025;
    if (isDemo) demoPosition = Math.max(0, Math.min(audioTrimEnd - audioTrimStart, currentAudio - audioTrimStart));
    if (reachedTrimEnd || wrapped) {
      if (wrapped && audioTrimEnd >= knownAudioLength() - .08) syncAudioToTimeline(0);
      else if (isDemo) { demoPosition = Math.max(0, audioTrimEnd - audioTrimStart); pausePlayback(); }
      else audio.pause();
    }
    lastAudioClock = audio.currentTime;
    if (graph) {
      const envelope = audioFadeEnvelope();
      if (Math.abs(envelope - lastFadeEnvelope) > .018) {
        graph.audioGain.gain.cancelScheduledValues(graph.context.currentTime);
        graph.audioGain.gain.setTargetAtTime(envelope, graph.context.currentTime, .018);
        lastFadeEnvelope = envelope;
      }
    }
  }
  paintAudioWaveform();
  settings.beatId = running && now - lastOnset < 110 ? beatId : 0;
  settings.numberBeat = beatId;
  settings.playing = running;
  const pulse = byId('reactive').checked ? settings.audio * settings.impact : 0;
  const frameTime = isDemo ? time + (running ? 0 : .9) : time;
  if (isDemo) {
    visual.renderDemo(view, settings, frameTime, pulse);
  } else {
    const frame = decodedTime ?? time;
    visual.trackFrame(video, frame, settings.blobs);
    visual.renderVideo(video, view, settings, time, pulse, frame);
  }
  if (settings.blobs || settings.warp || settings.strobe || settings.object?.enabled) {
    const { status, tracked, flashing } = visual.finishFrame(view, settings, frameTime, isDemo ? null : video, settings.audioBands, settings.numberBeat, settings.playing && Boolean(graph));
    if (settings.blobs) updateStatus(blobStatus, isDemo ? 'Demo markers' : `${tracked} active`);
    if (settings.warp) updateStatus(warpStatus, status);
    if (settings.strobe) updateStatus(strobeStatus, flashing ? 'Flash active' : running && settings.strobe.sync ? 'Listening for audio hits' : 'Ready');
  }
  queueDepth(now);
}

function updateStatus(element, label) {
  if (element.textContent !== label) element.textContent = label;
}

function setRecording(value) {
  settings.exporting = Boolean(value);
  if (settings.object) settings.object.isExporting = Boolean(value);
  exportButton.disabled = value || !supportedExportMime(byId('export-format-choice').value);
  exportButton.firstChild.textContent = value ? 'Recording… ' : 'Export clip ';
  for (const id of ['video-input', 'audio-input', 'object-input', 'demo', 'clear-audio', 'play', 'scrub', 'audio-scrub']) byId(id).disabled = value;
  for (const id of ['export-format-choice','export-resolution','export-fps','export-quality']) byId(id).disabled = value;
  document.querySelectorAll('[data-view]').forEach((button) => { button.disabled = value; });
}

function supportedExportMime(format) {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  const candidates = format === 'mp4'
    ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1,mp4a','video/mp4']
    : ['video/webm;codecs=vp8,opus','video/webm'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function updateExportSettings() {
  const selected = byId('export-format-choice').value;
  const mime = supportedExportMime(selected);
  const webm = supportedExportMime('webm');
  const estimate = Math.max(0, duration() - playbackTime());
  const targetBitrate = byId('export-quality').value === 'high' ? 10000000 : 5500000;
  const predicted = targetBitrate * estimate / 8 / 1000000;
  byId('export-estimate').textContent = `Estimated size: ${predicted.toFixed(1)} MB · ${Math.ceil(estimate)} s`;
  byId('export-capability').textContent = mime
    ? `${selected.toUpperCase()} recording is supported in this browser.`
    : selected === 'mp4' && webm ? 'MP4 encoding is unavailable here. Select WebM or open XO LAB in a browser that supports MP4 recording.'
      : `${selected.toUpperCase()} recording is unavailable in this browser.`;
  if (!recorder) exportButton.disabled = !mime;
}
for (const id of ['export-format-choice','export-resolution','export-fps','export-quality']) byId(id).addEventListener('change', updateExportSettings);

function offerExport(data) {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  const mp4 = data.type.includes('mp4');
  exportFile = new File([data], `xo-lab-depth-dust.${mp4 ? 'mp4' : 'webm'}`, { type: data.type.split(';')[0] });
  exportUrl = URL.createObjectURL(exportFile);
  const link = byId('download');
  link.href = exportUrl;
  link.download = exportFile.name;
  byId('export-format').textContent = mp4 ? 'MP4 ready' : 'WebM ready';
  byId('export-estimate').textContent = `Finished file size: ${(data.size / 1000000).toFixed(2)} MB`;
  byId('share').hidden = !(navigator.canShare?.({ files: [exportFile] }));
  byId('export-result').hidden = false;
}

byId('share').addEventListener('click', async () => {
  if (!exportFile) return;
  try {
    await navigator.share({ files: [exportFile] });
  } catch (error) {
    if (error.name !== 'AbortError') message('Sharing is unavailable. Use Download clip.');
  }
});

exportButton.addEventListener('click', async () => {
  if (recorder) return;
  const selectedFormat = byId('export-format-choice').value;
  const mimeType = supportedExportMime(selectedFormat);
  if (!mimeType) {
    updateExportSettings();
    message(`${selectedFormat.toUpperCase()} export is not supported in this browser. Choose another format or use a compatible browser.`);
    return;
  }
  if (!exportCanvas.captureStream || !window.MediaRecorder) {
    message('Clip recording is unavailable in this browser.');
    return;
  }
  setRecording(true);
  if (!running && !(await startPlayback())) {
    setRecording(false);
    return;
  }
  if (view === 'depth' || (view === 'source' && !(settings.blobs || settings.warp || settings.strobe))) setView('effect');
  const exportFps = Number(byId('export-fps').value) || 30;
  const sourceLong = Math.max(canvas.width, canvas.height);
  const resolutionChoice = byId('export-resolution').value;
  const targetLong = resolutionChoice === 'source' ? sourceLong : Number(resolutionChoice);
  const scale = targetLong / Math.max(1, sourceLong);
  exportCanvas.width = Math.max(2, Math.round(canvas.width * scale / 2) * 2);
  exportCanvas.height = Math.max(2, Math.round(canvas.height * scale / 2) * 2);
  exportCanvasCtx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
  const stream = exportCanvas.captureStream(exportFps);
  const audioTracks = graph?.output.stream.getAudioTracks() ?? [];
  if (externalAudio && !audioTracks.length) {
    stream.getTracks().forEach(track => track.stop());
    setRecording(false);
    message('Audio cannot be included in export in this browser because Web Audio capture is unavailable.');
    return;
  }
  audioTracks.forEach((track) => stream.addTrack(track));
  const chunks = [];
  let timer;
  let failed = false;
  let actualBytes = 0;
  exportExpectedSeconds = Math.max(.25, duration() - playbackTime());
  exportStartedAt = performance.now();
  exportEstimatedBitsPerSecond = byId('export-quality').value === 'high' ? 10000000 : 5500000;
  byId('export-progress-wrap').hidden = false;
  byId('export-progress').value = 0;
  const copyPreviewFrame = () => {
    if (!recorder || recorder.state !== 'recording') return;
    try { exportCanvasCtx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height); } catch {}
    exportDrawFrame = requestAnimationFrame(copyPreviewFrame);
  };
  const updateExportProgress = () => {
    const elapsed = Math.min(exportExpectedSeconds, Math.max(0, (performance.now() - exportStartedAt) / 1000));
    const percent = Math.min(99, elapsed / exportExpectedSeconds * 100);
    byId('export-progress').value = percent;
    const estimateMb = actualBytes ? actualBytes / 1000000 : elapsed * exportEstimatedBitsPerSecond / 8 / 1000000;
    byId('export-progress-label').textContent = `Exporting ${Math.floor(percent)}% · about ${estimateMb.toFixed(1)} MB`;
  };
  function finish() {
    clearTimeout(timer);
    clearInterval(exportProgressTimer);
    cancelAnimationFrame(exportDrawFrame);
    stream.getVideoTracks().forEach((track) => track.stop());
    recorder = null;
    setRecording(false);
    updateExportSettings();
  }
  try {
    const bitrate = byId('export-quality').value === 'high' ? 10000000 : 5500000;
    const recording = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
    recorder = recording;
    recording.ondataavailable = ({ data }) => { if (data.size) { chunks.push(data); actualBytes += data.size; updateExportProgress(); } };
    recording.onerror = () => {
      failed = true;
      finish();
      message('Recording failed in this browser.');
    };
    recording.onstop = () => {
      finish();
      if (failed) return;
      if (!chunks.length) {
        message('The browser returned an empty recording.');
        return;
      }
      const data = new Blob(chunks, { type: chunks[0].type || recording.mimeType || mimeType });
      offerExport(data);
      if (selectedFormat === 'mp4' && !data.type.includes('mp4')) message('This browser returned WebM instead of MP4. The file is labeled WebM; no false MP4 extension was added.');
      else message(`${data.type.includes('mp4') ? 'MP4' : 'WebM'} export ready. Download the clip or use Share when available.`);
    };
    const seconds = exportExpectedSeconds;
    recording.start(1000);
    exportDrawFrame = requestAnimationFrame(copyPreviewFrame);
    exportProgressTimer = setInterval(updateExportProgress, 200);
    timer = setTimeout(() => { if (recording.state === 'recording') recording.stop(); }, Math.round(seconds * 1000));
    message(`Recording ${seconds.toFixed(1)} seconds from the current position as ${selectedFormat.toUpperCase()}. Keep this page open.`);
  } catch (error) {
    console.warn('Recording unavailable', error);
    finish();
    message('This browser could not start clip recording.');
  }
});

updateAudioSource();
updateDepthUI();
enhanceSliders();
updateAudioTrimFields();
updateExportSettings();

const presetKey = 'xo-lab-presets-v1';
const stateKey = 'xo-lab-editor-state-v1';
let restoring = false;
let historyBack = [];
let historyForward = [];
let currentSnapshot;
function captureState() {
  const values = [...document.querySelectorAll('input[id],select[id]')]
    .filter(element => !['file', 'button', 'submit'].includes(element.type))
    .map(element => [element.id, element.type === 'checkbox' || element.type === 'radio' ? element.checked : element.value]);
  const panels = [...document.querySelectorAll('.inspector>.panel')].map(panel => [panel.id, !panel.classList.contains('is-collapsed')]);
  return { values, panels, view, band };
}
function stateString(state) { return JSON.stringify(state); }
function syncHistoryButtons() {
  byId('undo').disabled = historyBack.length === 0;
  byId('redo').disabled = historyForward.length === 0;
}
function applyState(state) {
  if (!state) return;
  restoring = true;
  for (const [id, value] of state.values ?? []) {
    const element = byId(id);
    if (!element) continue;
    if (element.type === 'checkbox' || element.type === 'radio') element.checked = value;
    else element.value = value;
    element.dispatchEvent(new Event(element.type === 'range' ? 'input' : 'change', { bubbles: true }));
    if (element.classList.contains('color-chip')) element.dispatchEvent(new Event('input', { bubbles: true }));
    if (element.classList.contains('color-hex')) element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.classList.contains('color-alpha')) element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const [id, expanded] of state.panels ?? []) {
    const panel = byId(id); const fold = panel?.querySelector('.panel-fold'); const body = panel?.querySelector('.panel-body');
    if (!panel || !fold || !body) continue;
    body.hidden = !expanded; panel.classList.toggle('is-collapsed', !expanded); fold.setAttribute('aria-expanded', String(expanded));
    store.set(`xo-lab-panel-${id}`, String(expanded));
  }
  if (state.view) setView(state.view);
  if (state.band) { band = state.band; activateButtons('[data-band]', 'band', band); }
  restoring = false;
}
function commitHistory() {
  if (restoring) return;
  const next = captureState();
  if (currentSnapshot && stateString(currentSnapshot) !== stateString(next)) {
    historyBack.push(currentSnapshot);
    if (historyBack.length > 80) historyBack.shift();
    historyForward = [];
  }
  currentSnapshot = next;
  syncHistoryButtons();
  store.set(stateKey, stateString(next));
}
document.addEventListener('change', event => {
  if ((event.target.matches('input,select') && !['file'].includes(event.target.type)) || event.target.matches('.color-row')) commitHistory();
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-view],[data-band],.panel-fold')) setTimeout(commitHistory, 0);
});
function restoreHistory(from, to) {
  if (!from.length) return;
  to.push(captureState());
  const state = from.pop();
  applyState(state); currentSnapshot = captureState();
  syncHistoryButtons();
  store.set(stateKey, stateString(currentSnapshot));
}
byId('undo').addEventListener('click', () => restoreHistory(historyBack, historyForward));
byId('redo').addEventListener('click', () => restoreHistory(historyForward, historyBack));
function getPresets() { try { return JSON.parse(store.get(presetKey) || '[]'); } catch { return []; } }
function renderPresets(selected = '') {
  const select = byId('preset-list');
  select.innerHTML = '<option value="">Presets</option>';
  getPresets().forEach((preset, index) => { const option = new Option(preset.name, String(index)); select.add(option); });
  select.value = selected;
}
byId('save-preset').addEventListener('click', () => {
  const name = prompt('Name this effect preset');
  if (!name?.trim()) return;
  const presets = getPresets(); presets.push({ name: name.trim().slice(0, 48), state: captureState() });
  try { if (!store.set(presetKey, JSON.stringify(presets.slice(-40)))) throw new Error('Storage unavailable'); renderPresets(String(Math.min(presets.length, 40) - 1)); message(`Preset “${name.trim()}” saved on this device.`); }
  catch { message('Preset could not be saved. Device storage may be full.'); }
});
byId('load-preset').addEventListener('click', () => {
  const index = Number(byId('preset-list').value); const preset = getPresets()[index];
  if (!preset) { message('Choose a saved preset first.'); return; }
  historyBack.push(captureState()); historyForward = []; applyState(preset.state); currentSnapshot = captureState(); syncHistoryButtons(); message(`Loaded “${preset.name}”.`);
});
renderPresets();
for (const slot of ['a', 'b']) byId(`compare-${slot}`).addEventListener('click', () => {
  try { if (!store.set(`xo-lab-snapshot-${slot}`, stateString(captureState()))) throw new Error('Storage unavailable'); message(`Snapshot ${slot.toUpperCase()} saved.`); }
  catch { message('Snapshot could not be saved on this device.'); }
});
let compareSlot = 'a';
byId('compare-toggle').addEventListener('click', event => {
  const target = store.get(`xo-lab-snapshot-${compareSlot}`);
  if (!target) { message(`Save snapshot ${compareSlot.toUpperCase()} first.`); return; }
  historyBack.push(captureState()); historyForward = [];
  compareSlot = compareSlot === 'a' ? 'b' : 'a';
  applyState(JSON.parse(target)); currentSnapshot = captureState(); syncHistoryButtons();
  event.currentTarget.setAttribute('aria-pressed', String(compareSlot === 'b'));
  message(`Showing snapshot ${compareSlot === 'b' ? 'A' : 'B'} at the current timecode.`);
});
byId('preview-size').addEventListener('click', event => {
  const compact = event.currentTarget.getAttribute('aria-pressed') !== 'true';
  byId('stage').classList.toggle('compact', compact);
  event.currentTarget.setAttribute('aria-pressed', String(compact));
  event.currentTarget.textContent = compact ? 'Expand preview' : 'Compact preview';
});
document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => {
  const target = byId(button.dataset.jump); const inspector = target?.closest('.inspector');
  if (!target || !inspector) return;
  if (target.classList.contains('is-collapsed')) target.querySelector('.panel-fold')?.click();
  const top = target.getBoundingClientRect().top - inspector.getBoundingClientRect().top + inspector.scrollTop;
  inspector.scrollTo({ top, behavior: 'smooth' });
}));
try {
  const saved = JSON.parse(store.get(stateKey) || 'null');
  if (saved?.values?.length) { applyState(saved); currentSnapshot = captureState(); }
} catch {}
if (!currentSnapshot) currentSnapshot = captureState();
syncHistoryButtons();
requestAnimationFrame(draw);
