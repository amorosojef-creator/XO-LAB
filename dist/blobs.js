const maxTracks = 48;
const fadeSeconds = .23;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
let lastBlobAudioTrigger = 0;
let lastBlobAudioLevel = 0;
const markerRandom = (seed) => {
  const mixed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 4294967296;
};
function markerFlicker(id, time, amount, rate, pulse) {
  if (!amount) return 1;
  const cycle = Math.floor(time * (3 + rate * 19));
  const flicker = markerRandom(id * 12553 + cycle * 159173);
  return Math.min(1, 1 - amount * (1 - flicker) * (1 - pulse * .65));
}

export function createBlobTracker(width, height) {
  const size = width * height;
  const background = new Float32Array(size);
  const mask = new Uint8Array(size);
  const expanded = new Uint8Array(size);
  const queue = new Int32Array(size);
  let tracks = [], nextId = 1, last = NaN, lastMode;

  function reset() {
    tracks = [];
    nextId = 1;
    last = NaN;
    lastMode = undefined;
  }

  function detect(luma, mode, sensitivity, minimum, difference, adaptation) {
    const motion = mode === 'motion';
    const threshold = motion ? .23 - .20 * sensitivity : .93 - .59 * sensitivity;
    mask.fill(0);
    expanded.fill(0);
    let selected = 0;
    for (let i = 0; i < size; i++) {
      const residual = motion ? luma[i] - background[i] - difference : 0;
      const value = motion ? Math.abs(residual) : mode === 'dark' ? 1 - luma[i] : luma[i];
      if (motion) background[i] += (residual + difference) * adaptation;
      if (value >= threshold) {
        mask[i] = 1;
        selected++;
      }
    }
    // Ignore nearly full-frame masks from lighting changes and scene cuts.
    if (selected > size * (motion ? .47 : .79)) return [];
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (mask[i]) {
          expanded[i] = expanded[i - 1] = expanded[i + 1] = 1;
          expanded[i - width] = expanded[i + width] = 1;
        }
      }
    }
    const blobs = [];
    const minPixels = Math.max(4, size * (.00018 + minimum ** 2 * .018));
    for (let i = 0; i < size; i++) {
      if (!expanded[i]) continue;
      let start = 0, end = 1, count = 0, sumX = 0, sumY = 0;
      let left = width, right = 0, top = height, bottom = 0;
      expanded[i] = 0;
      queue[0] = i;
      while (start < end) {
        const index = queue[start++];
        const y = Math.floor(index / width), x = index - y * width;
        if (mask[index]) {
          count++;
          sumX += x;
          sumY += y;
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
        if (x && expanded[index - 1]) { expanded[index - 1] = 0; queue[end++] = index - 1; }
        if (x + 1 < width && expanded[index + 1]) { expanded[index + 1] = 0; queue[end++] = index + 1; }
        if (y && expanded[index - width]) { expanded[index - width] = 0; queue[end++] = index - width; }
        if (y + 1 < height && expanded[index + width]) { expanded[index + width] = 0; queue[end++] = index + width; }
      }
      const w = (right - left + 1) / width, h = (bottom - top + 1) / height;
      if (count < minPixels || w * h > .63) continue;
      blobs.push({ x: (sumX / count + .5) / width, y: (sumY / count + .5) / height,
        left: left / width, top: top / height, w, h, area: count });
    }
    return blobs.sort((a, b) => b.area - a.area).slice(0, maxTracks * 2);
  }

  function update(luma, time, settings) {
    const { mode, sensitivity, minimum, smoothing, limit } = settings;
    const interval = time - last;
    if (interval < 0 || interval > .62 || (lastMode && lastMode !== mode)) reset();
    const initial = !Number.isFinite(last);
    if (!initial && time - last < .001) return;
    const elapsed = initial ? 1 / 30 : time - last;
    last = time;
    lastMode = mode;
    let offset = 0;
    if (mode === 'motion') {
      if (initial) background.set(luma);
      else {
        for (let i = 0; i < size; i++) offset += luma[i] - background[i];
        offset /= size;
      }
    }
    const blobs = initial && mode === 'motion' ? [] :
      detect(luma, mode, sensitivity, minimum, offset, 1 - Math.exp(-elapsed / .24));
    const pairs = [];
    for (const track of tracks) {
      for (const blob of blobs) {
        const predict = Math.min(.13, time - track.seen);
        const distance = Math.hypot(blob.x - track.x - track.vx * predict, blob.y - track.y - track.vy * predict);
        const reach = Math.min(.24, .050 + Math.hypot(track.w, track.h) * .57 + track.missing * .45);
        const overlap = Math.max(0, Math.min(track.left + track.w, blob.left + blob.w) - Math.max(track.left, blob.left)) *
          Math.max(0, Math.min(track.top + track.h, blob.top + blob.h) - Math.max(track.top, blob.top));
        if (distance <= reach) {
          const sizeChange = Math.abs(Math.log(blob.area / track.area));
          pairs.push({ track, blob, score: distance + Math.min(.07, sizeChange * .012) - Math.min(.05, overlap / (track.w * track.h) * .05) });
        }
      }
    }
    pairs.sort((a, b) => a.score - b.score);
    const usedTracks = new Set(), usedBlobs = new Set();
    const follow = smoothing === 0 ? 1 : 1 - Math.exp(-elapsed / (.009 + smoothing * .15));
    for (const { track, blob } of pairs) {
      if (usedTracks.has(track) || usedBlobs.has(blob)) continue;
      usedTracks.add(track);
      usedBlobs.add(blob);
      const sinceSeen = Math.max(.012, time - track.seen);
      track.vx = track.vx * .36 + clamp((blob.x - track.x) * follow / sinceSeen, -3, 3) * .64;
      track.vy = track.vy * .36 + clamp((blob.y - track.y) * follow / sinceSeen, -3, 3) * .64;
      for (const key of ['x', 'y', 'left', 'top', 'w', 'h']) track[key] += (blob[key] - track[key]) * follow;
      track.area = blob.area;
      track.seen = time;
      track.missing = 0;
      track.history.push([track.x, track.y]);
      if (track.history.length > 28) track.history.shift();
    }
    for (const track of tracks) {
      if (!usedTracks.has(track)) track.missing = time - track.seen;
    }
    tracks = tracks.filter((track) => track.missing < fadeSeconds);
    for (const blob of blobs) {
      if (tracks.length >= limit) break;
      if (usedBlobs.has(blob)) continue;
      tracks.push({ ...blob, id: nextId++, vx: 0, vy: 0, missing: 0, seen: time, history: [[blob.x, blob.y]] });
    }
  }

  return { reset, update, getTracks: () => tracks };
}

function randomUnit(seed) {
  const value = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

export function markerNumber(id, time, mode, beat) {
  if (!mode || (mode === 'audio' && beat === 0)) return id;
  const clock = time + (id % 11) * .029;
  const cycle = mode === 'audio' ? beat : Math.floor(clock * 6.2 + Math.sin(clock * 3.5 + id) * .47);
  const value = Math.floor(randomUnit(id * 7919 + cycle * 13007) * 450);
  return 100 + value * 2 + Math.abs(cycle % 2);
}

function drawBox(ctx, settings, left, top, w, h) {
  if (settings.boxStyle === 'filled') {
    ctx.fillRect(left, top, w, h);
  } else if (settings.boxStyle === 'corners') {
    const arm = Math.min(w, h) * .27;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[left, top, 1, 1], [left + w, top, -1, 1],
      [left, top + h, 1, -1], [left + w, top + h, -1, -1]]) {
      ctx.moveTo(x, y + dy * arm);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * arm, y);
    }
    ctx.stroke();
  } else {
    ctx.strokeRect(left, top, w, h);
  }
}

export function drawBlobOverlay(ctx, canvas, source, tracks, settings, pulse, time, beatId, audioBands = {}, audioActive = false) {
  const { width, height } = canvas;
  if (settings.audioAppear && audioActive) {
    const level = audioBands?.[settings.audioBand] ?? 0;
    const threshold = Math.max(.015, (settings.audioThreshold ?? .34) * (1.2 - (settings.audioSensitivity ?? .65) * .9));
    const beatHit = beatId > 0 && beatId !== lastBlobAudioTrigger && level >= threshold;
    const bandHit = level >= threshold && lastBlobAudioLevel < threshold;
    if (beatId > 0 && beatId !== lastBlobAudioTrigger) lastBlobAudioTrigger = beatId;
    if (beatHit || bandHit) {
      const candidates = tracks.filter(track => track.missing === 0);
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const variation = settings.audioRandom ?? .58;
      const count = Math.min(candidates.length, Math.max(1, Math.ceil(candidates.length * (.12 + variation * .62))));
      for (const track of candidates.slice(0, count)) {
        track.audioShowAt = time;
        track.audioHideAt = time + (settings.audioDuration ?? .6) * (1 + Math.random() * variation);
      }
    }
    lastBlobAudioLevel = level;
  } else {
    lastBlobAudioLevel = 0;
  }
  const scale = Math.max(width, height) / 960;
  const live = tracks.slice(0, settings.limit).map(track => {
    const fade = 1 - track.missing / fadeSeconds;
    const flicker = markerFlicker(track.id, time, settings.flicker ? settings.flickerAmount : 0, .62, pulse);
    let audioFade = 1;
    if (settings.audioAppear && audioActive) {
      const shownAt = track.audioShowAt ?? -Infinity;
      const hiddenAt = track.audioHideAt ?? -Infinity;
      audioFade = time >= shownAt && time < hiddenAt
        ? Math.min(1, (time - shownAt) / .08, (hiddenAt - time) / .14)
        : 0;
    }
    const alpha = fade * (.83 + pulse * .17) * flicker * Math.max(0, audioFade);
    // Marker position is always the detector's smoothed region center. Audio
    // timing and randomness affect visibility only; they never displace it.
    return { track, x: clamp(track.x * width, 0, width), y: clamp(track.y * height, 0, height), alpha };
  });
  const colors = settings.colors ?? {};
  const color = (key, fallback = '#fff') => colors[key]?.hex ?? fallback;
  const opacity = (key) => colors[key]?.opacity ?? 1;
  ctx.save();
  ctx.lineWidth = Math.max(.65, scale);
  ctx.strokeStyle = color('links');
  ctx.fillStyle = '#fff';
  if (settings.links) {
    for (let i = 1; i < live.length; i++) {
      const marker = live[i];
      let link = live[0], nearest = Infinity;
      for (let j = 0; j < i; j++) {
        const other = live[j];
        const distance = Math.hypot((marker.x - other.x) / width, (marker.y - other.y) / height);
        if (distance < nearest) { nearest = distance; link = other; }
      }
      ctx.globalAlpha = Math.max(.09, .50 - nearest * .65) * opacity('links') * Math.min(marker.alpha, link.alpha);
      ctx.beginPath();
      ctx.moveTo(marker.x, marker.y);
      ctx.lineTo(link.x, link.y);
      ctx.stroke();
    }
  }

  ctx.font = `${Math.max(9, 11 * scale)}px monospace`;
  for (const { track, x, y, alpha } of live) {
    const history = settings.trails ? track.history.slice(-Math.round(settings.trail * 27) - 1) : [];
    for (let i = 1; i < history.length; i++) {
      ctx.globalAlpha = i / history.length * .54 * alpha * opacity('trails');
      ctx.strokeStyle = color('trails');
      ctx.beginPath();
      ctx.moveTo(history[i - 1][0] * width, history[i - 1][1] * height);
      ctx.lineTo(history[i][0] * width, history[i][1] * height);
      ctx.stroke();
    }

    const pulseSize = settings.sizePulse ? settings.pulseAmount * (.37 * Math.sin(time * 23 + track.id) + pulse * .63) : 0;
    const boxScale = (.4 + settings.boxScale * 1.2) * (1 + pulseSize);
    const pad = settings.padding * 38 * scale;
    let w = Math.min(width, Math.max(12 * scale, track.w * width * boxScale + 2 * pad));
    let h = Math.min(height, Math.max(12 * scale, track.h * height * boxScale + 2 * pad));
    if (settings.box && settings.boxStyle === 'filled') w = h = Math.min(width, height, Math.max(w, h));
    const left = clamp(track.left * width + (x - track.x * width) + (track.w * width - w) / 2, 0, width - w);
    const top = clamp(track.top * height + (y - track.y * height) + (track.h * height - h) / 2, 0, height - h);
    if (settings.box) {
      ctx.lineWidth = Math.max(.65, scale * (.45 + settings.thickness * 5));
      ctx.globalAlpha = alpha * settings.opacity * opacity('box');
      ctx.strokeStyle = color('box');
      if (settings.boxStyle === 'filled') {
        ctx.fillStyle = color('fill'); ctx.globalAlpha = alpha * settings.opacity * opacity('fill');
        ctx.fillRect(left, top, w, h);
        ctx.globalAlpha = alpha * settings.opacity * opacity('box'); ctx.strokeRect(left, top, w, h);
      }
      else {
        ctx.lineWidth += 2 * scale;
        drawBox(ctx, settings, left, top, w, h);
        ctx.lineWidth -= 2 * scale;
      }
      if (settings.boxStyle !== 'filled') drawBox(ctx, settings, left, top, w, h);
    }
    ctx.globalAlpha = alpha * opacity('center');
    ctx.lineWidth = Math.max(.65, scale);
    if (settings.center) {
      const cross = 4 * scale;
      ctx.fillStyle = color('center');
      ctx.fillRect(x - cross, y, 2 * cross, ctx.lineWidth);
      ctx.fillRect(x, y - cross, ctx.lineWidth, 2 * cross);
    }
    if (settings.labels) {
      const mode = settings.randomNumbers ? settings.numberMode : null;
      const tag = String(markerNumber(track.id, time, mode, beatId)).padStart(2, '0');
      const tagWidth = Math.ceil(ctx.measureText(tag).width) + 6 * scale;
      const tagX = Math.min(width - tagWidth, left);
      const tagY = Math.max(13 * scale, top - 4 * scale);
      ctx.globalAlpha = alpha * opacity('label');
      ctx.fillStyle = color('label');
      ctx.fillRect(tagX, tagY - 12 * scale, tagWidth, 14 * scale);
      ctx.globalAlpha = alpha * opacity('marker');
      ctx.fillStyle = color('marker');
      ctx.fillText(tag, tagX + 3 * scale, tagY);
    }
    if (settings.tiles && source?.videoWidth) {
      const tile = Math.min(width, height, (36 + pulse * 12) * scale);
      const crop = clamp(Math.max(track.w * source.videoWidth, track.h * source.videoHeight), 20, Math.min(source.videoWidth, source.videoHeight));
      const srcX = clamp(track.x * source.videoWidth - crop / 2, 0, source.videoWidth - crop);
      const srcY = clamp(track.y * source.videoHeight - crop / 2, 0, source.videoHeight - crop);
      const tileX = clamp(left + w + 4 * scale, 0, width - tile);
      const tileY = clamp(top - tile / 2, 0, height - tile);
      ctx.drawImage(source, srcX, srcY, crop, crop, tileX, tileY, tile, tile);
      ctx.globalAlpha = alpha * opacity('tile'); ctx.strokeStyle = color('tile');
      ctx.strokeRect(tileX, tileY, tile, tile);
    }
  }
  ctx.restore();
  return live.filter(({ track }) => track.missing === 0).length;
}
