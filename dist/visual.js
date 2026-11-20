import { createBlobTracker, drawBlobOverlay } from './blobs.js?v=10';

import { createWarp, createCanvasWarp } from './warp.js?v=9';

import { createStrobe, drawStrobe } from './strobe.js?v=9';
import { createObjectLayer } from './object3d.js?v=5';

const TAU = Math.PI * 2;
const clamp = (v) => Math.min(1, Math.max(0, v));
const random = (seed) => () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 4294967296;
};

export function createVisual(canvas, sample) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const src = sample.getContext('2d', { willReadFrequently: true });
  const map = document.createElement('canvas');
  const mapCtx = map.getContext('2d', { alpha: false });
  const rng = random(301);
  const dust = Array.from({ length: 7200 }, () => ({
    u: rng(), v: rng(), opacity: rng(), radius: rng(), angle: rng() * TAU, layer: rng()
  }));
  let w = sample.width, h = sample.height, hasPixels = false;
  let luma, edges, depth, targetDepth, smoothed, pixels;
  let lastFrame = -1;
  let tracker;
  const strobe = createStrobe();
  const objectLayer = createObjectLayer(canvas);
  let warpRenderer;
  let canvasWarp;

  function reset(width, height) {
    const scale = 176 / Math.max(width, height);
    w = Math.max(4, Math.round(width * scale));
    h = Math.max(4, Math.round(height * scale));
    sample.width = map.width = w;
    sample.height = map.height = h;
    luma = new Float32Array(w * h);
    smoothed = new Float32Array(w * h);
    edges = new Float32Array(w * h);
    pixels = mapCtx.createImageData(w, h);
    hasPixels = false;
    lastFrame = -1;
    tracker = createBlobTracker(w, h);
    strobe.reset();
    clearDepth();
  }

  function clearDepth() {
    depth = null;
    targetDepth = null;
  }

  function updateDepth(data, width, height) {
    targetDepth = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const index = Math.floor(y * height / h) * width + Math.floor(x * width / w);
        targetDepth[y * w + x] = data[index] / 255;
      }
    }
    if (!depth) depth = targetDepth.slice();
  }

  function inspectVideo(video, frameTime) {
    if (video.readyState < 2 || video.seeking) return false;
    if (lastFrame === frameTime && hasPixels) return true;
    lastFrame = frameTime;
    src.drawImage(video, 0, 0, w, h);
    const { data } = src.getImageData(0, 0, w, h);
    for (let p = 0; p < luma.length; p++) {
      const i = p * 4;
      luma[p] = (data[i] * .213 + data[i + 1] * .715 + data[i + 2] * .072) / 255;
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (luma[i + 1] - luma[i - 1]) * 2 + luma[i - w + 1] - luma[i - w - 1] + luma[i + w + 1] - luma[i + w - 1];
        const gy = (luma[i + w] - luma[i - w]) * 2 + luma[i + w - 1] - luma[i - w - 1] + luma[i + w + 1] - luma[i - w + 1];
        edges[i] = Math.min(1, Math.hypot(gx, gy) * .55);
        smoothed[i] = (luma[i] * 2 + luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w]) / 6;
      }
    }
    hasPixels = true;
    return true;
  }

  function trackFrame(video, time, settings) {
    if (settings && inspectVideo(video, time)) tracker.update(luma, time, settings);
  }

  function renderVideo(video, view, settings, time, pulse, frameTime) {
    const { width, height } = canvas;
    ctx.fillStyle = view === 'dust' ? '#000' : '#050505';
    ctx.fillRect(0, 0, width, height);
    if (!inspectVideo(video, frameTime)) return;
    if (depth) {
      for (let i = 0; i < depth.length; i++) depth[i] += (targetDepth[i] - depth[i]) * .16;
    }
    if (view === 'source') {
      ctx.drawImage(video, 0, 0, width, height);
      return;
    }
    if (view === 'dust') {
      if (settings.dustEnabled && !(settings.object?.enabled && settings.object.layer === 'below')) drawVideoDust(settings, pulse, time);
      return;
    }
    if (view === 'depth' && !depth) return;
    const mix = settings.depthMix;
    const contour = settings.contours;
    for (let i = 0; i < luma.length; i++) {
      const d = depth?.[i] ?? 0;
      const edge = edges[i];
      const depthEdge = depth && i > w && i + w < depth.length
        ? Math.abs(depth[i + 1] - depth[i - 1]) + Math.abs(depth[i + w] - depth[i - w]) : 0;
      const ridge = depth ? Math.pow(1 - Math.abs(Math.sin(d * 29)), 8) * (.1 + d * .34) : 0;
      const value = view === 'depth' ? d : clamp(
        smoothed[i] * (.40 - mix * .28) + edge * contour * (.46 + pulse * .25) +
        mix * (Math.pow(d, 2) * .14 + ridge * contour * .48 + depthEdge * contour)
      );
      const gray = Math.round(Math.pow(value, view === 'depth' ? .88 : 1.12) * 255);
      const p = i * 4;
      pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = gray;
      pixels.data[p + 3] = 255;
    }
    mapCtx.putImageData(pixels, 0, 0);
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(map, 0, 0, width, height);
    if (view === 'effect' && settings.dustEnabled && !(settings.object?.enabled && settings.object.layer === 'below')) drawVideoDust(settings, pulse, time);
  }

  function drawVideoDust(settings, pulse, time) {
    drawSurfaceDust(settings, pulse, time);
    drawDust(settings, time, pulse, (u, v) => {
      const i = Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w));
      const anchored = (depth?.[i] ?? .4) * settings.depthMix + edges[i] * .60;
      return .42 + (anchored - .42) * settings.surface;
    });
  }

  function drawSurfaceDust(settings, pulse, time) {
    if (!settings.density || !settings.brightness || !settings.surface) return;
    const { width, height } = canvas;
    const dx = width / w, dy = height / h;
    const step = settings.density > .75 ? 2 : 3;
    const size = settings.size * Math.max(width, height) / 960;
    const scan = (.5 + .5 * Math.sin(time * 1.6)) * h;
    ctx.fillStyle = settings.colors?.dust?.hex ?? '#fff';
    for (let y = 2; y < h - 2; y += step) {
      for (let x = 2; x < w - 2; x += step) {
        const i = y * w + x;
        const edge = edges[i];
        const z = depth?.[i] ?? 0;
        const depthEdge = depth ? Math.abs(depth[i - 1] - depth[i + 1]) + Math.abs(depth[i - w] - depth[i + w]) : 0;
        const frequency = Math.min(1, (edge * 1.7 + depthEdge * settings.depthMix * 2.2) * (.50 + settings.density) * Math.sqrt(settings.surface));
        const noise = ((Math.imul(i, 2654435761) >>> 0) % 997) / 997;
        if (noise > frequency) continue;
        const glow = Math.exp(-Math.abs(y - scan) / 5);
        const alpha = (.18 + edge * .68 + z * .16) * (.68 + glow * .65 + pulse * .7);
        ctx.globalAlpha = clamp(alpha * settings.brightness * Math.sqrt(settings.surface) * (settings.colors?.dust?.opacity ?? 1));
        const radius = size * (.55 + noise * .75 + glow * .40 + pulse * .5);
        ctx.fillRect((x + (noise - .5) * .7) * dx, (y + (noise - .5) * .6) * dy, radius, radius);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawDust(settings, time, pulse, getDepth) {
    const { width, height } = canvas;
    // More dust becomes visible on strong transients within the selected band.
    const count = Math.floor(dust.length * settings.density * (.72 + pulse * .28));
    const drift = settings.drift;
    const scale = Math.max(width, height) / 960;
    const grainFrame = Math.floor(time * 23);
    ctx.fillStyle = settings.colors?.dust?.hex ?? '#fff';
    for (let i = 0; i < count; i++) {
      const point = dust[i];
      const z = clamp(getDepth(point.u, point.v) * .72 + point.layer * .28);
      const travel = drift * (.12 + z * .75) * (1 + pulse * .8);
      const grain = (((Math.imul(i + 1, 1597334677) ^ Math.imul(grainFrame, 3812015801)) >>> 0) % 4093) / 4093;
      const jitter = (grain - .5) * settings.grain * .006;
      const u = ((point.u + jitter + travel * (time * .018 + Math.sin(point.angle + time * .43) * .07)) % 1 + 1) % 1;
      const v = ((point.v - jitter * 1.29 + travel * (Math.cos(point.angle + time * .36) * .08 - time * .009)) % 1 + 1) % 1;
      const sparkle = .55 + .45 * Math.sin(point.angle + time * (2.2 + point.radius * 4));
      const radius = settings.size * scale * (.24 + point.radius * .78) * (.65 + z * .55 + pulse * .42);
      ctx.globalAlpha = clamp(settings.brightness * (.12 + point.opacity * .83) * (.38 + .62 * z) * (.48 + sparkle * .52) * (1 + (grain - .5) * settings.grain * 1.55) * (1 + pulse * .9) * (settings.colors?.dust?.opacity ?? 1));
      ctx.fillRect(u * width, v * height, radius, radius);
    }
    ctx.globalAlpha = 1;
  }

  function renderDemo(view, settings, time, pulse) {
    const { width, height } = canvas;
    ctx.fillStyle = view === 'dust' ? '#000' : '#050505';
    ctx.fillRect(0, 0, width, height);
    const wobble = Math.sin(time * .5);
    const project = (x, y, z) => {
      const focal = 665 / (z + 565);
      return [
        width * .52 + (x + wobble * (26 - z * .009)) * focal,
        height * .49 + (y + Math.sin(time * .42) * 26) * focal - z * .013
      ];
    };
    const segments = [];
    const add = (a, b, z, tone) => segments.push([a, b, z, tone]);
    const lightBand = 880 + Math.sin(time * .53) * 370;
    for (let i = 18; i >= 0; i--) {
      const z = i * 110 + 45;
      const skew = Math.sin(i * .79) * 25;
      const left = -345 + skew;
      const right = 310 + skew;
      const top = -198 + (i % 3) * 12;
      const bottom = 180;
      const a = project(left, top, z), b = project(right, top, z);
      const c = project(right, bottom, z), d = project(left, bottom, z);
      add(a, b, z, .64); add(b, c, z, .70); add(c, d, z, .48); add(d, a, z, .76);
      if (i % 3 === 1) {
        add(a, c, z, .29);
        add(project(left + 9, top + 13, z), project(right + 40, top + 16, z), z, .28);
      }
    }
    for (let x = -384; x <= 384; x += 74) {
      add(project(x, 180, 10), project(x, 180, 2460), 430, .43);
      add(project(x, -200, 10), project(x, -200, 2460), 550, .30);
    }
    for (let y = -183; y <= 170; y += 46) {
      add(project(-346, y, 34), project(-340, y, 2380), 300, .36);
      add(project(310, y, 38), project(306, y, 2380), 330, .40);
    }
    const sceneRandom = random(440);
    for (let i = 0; i < 86; i++) {
      const z = 20 + sceneRandom() * 1900;
      const y = sceneRandom() * 420 - 215;
      const x = (sceneRandom() - .5) * 950;
      const span = 20 + sceneRandom() * 240;
      add(project(x, y, z), project(x + span, y + (i % 7 === 0 ? -94 : 1), z + 18), z, .12 + sceneRandom() * .24);
    }
    for (const [a, b, z, tone] of segments) {
      const near = clamp(1 - z / 2200);
      const flash = Math.exp(-Math.abs(z - lightBand) / 150);
      const alpha = view === 'source' ? tone * .70 : view === 'depth' ? tone * (.27 + .73 * near)
        : tone * (.18 + settings.contours * .85) * (.38 + near * settings.depthMix + flash * (.55 + pulse));
      if (view !== 'dust') {
        ctx.strokeStyle = `rgba(245,245,245,${clamp(alpha)})`;
        ctx.lineWidth = view === 'depth' ? 2 + near * 4 : .47 + near * .64;
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.stroke();
      }
      if ((view === 'effect' || view === 'dust') && settings.dustEnabled && settings.density > 0 && settings.surface > 0) {
        const steps = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5);
        ctx.fillStyle = '#fff';
        for (let j = 0; j < steps; j++) {
          const noise = ((j * 9277 + Math.round(z) * 9083) % 991) / 991;
          if (noise > settings.density * settings.surface + pulse * .14) continue;
          const along = j / steps;
          const x = a[0] + (b[0] - a[0]) * along;
          const y = a[1] + (b[1] - a[1]) * along;
          ctx.globalAlpha = clamp((.2 + near * .32 + flash * .45) * settings.brightness * settings.surface * (.6 + pulse));
          ctx.fillRect(x + (noise - .5) * 7, y + Math.sin(noise * 34 + time * 2) * (2 + settings.drift * 6), settings.size * (1 + pulse), settings.size * .85);
        }
        ctx.globalAlpha = 1;
      }
    }
    if ((view === 'effect' || view === 'dust') && settings.dustEnabled) {
      drawDust(settings, time, pulse, (u) => .42 + (Math.abs(u - .52) * .58 - .07) * settings.surface);
    }
    if (view === 'effect') {
      const glow = ctx.createRadialGradient(width * .52, height * .49, 0, width * .52, height * .49, width * .44);
      glow.addColorStop(0, 'rgba(255,255,255,.04)');
      glow.addColorStop(1, 'rgba(0,0,0,.38)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function demoBlobs(time) {
    return Array.from({ length: 5 }, (_, index) => {
      const position = (t) => [
        .5 + Math.cos(index * 2.0 + t * .61) * (.16 + index * .026),
        .5 + Math.sin(index * 1.8 + t * .69) * (.15 + index * .04)
      ];
      const [x, y] = position(time);
      const w = .032 + index * .006, h = w * 1.32;
      const history = Array.from({ length: 28 }, (_, step) => position(time - (27 - step) * .058));
      return { x, y, w, h, left: x - w / 2, top: y - h / 2, history, id: index + 1, missing: 0 };
    });
  }

  function finishFrame(view, settings, time, source, audioBands, beatId, audioActive) {
    let status = 'Off';
    // Keep screen-space overlays alive in every preview mode, including Depth
    // and Source. The old early return skipped finishFrame's object composite,
    // so an imported 3D object appeared to vanish when those views were active.
    if (view === 'depth') status = 'Depth preview';
    else if (source && (source.readyState < 2 || source.seeking)) status = 'Waiting for video';
    const tracksForObject = settings.blobs ? tracker.getTracks() : source ? [] : demoBlobs(time);
    const objectSettings = settings.object ? { ...settings.object } : null;
    if (objectSettings?.depthAssist && depth) {
      objectSettings.depthSampler = (u, v) => {
        const x = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
        const y = Math.max(0, Math.min(h - 1, Math.floor(v * h)));
        return depth[y * w + x];
      };
    }
    const drawObject = () => objectLayer.draw(ctx, objectSettings, time, { ...settings.audioBands, level: settings.audio, beatId: settings.beatId }, tracksForObject);
    if (settings.object?.enabled && settings.object.warp) drawObject();
    if (settings.warp && settings.warp.amount) {
      if (warpRenderer === undefined) {
        try {
          warpRenderer = createWarp(canvas);
        } catch (error) {
          console.warn('WebGL warp unavailable', error);
          warpRenderer = null;
        }
      }
      const warp = settings.warp;
      const pulse = warp.sync ? settings.audio : 0;
      const strength = warp.amount * (.22 + pulse * .11);
      const phase = .55 + time * (.48 + warp.speed * 4.0);
      const map = warp.mode === 'depth' ? depth : null;
      if (warpRenderer?.(ctx, map, w, h, phase, strength)) {
        status = map ? '3D depth active' : warp.mode === 'wave' ? 'Wave active' : source ? 'Wave until depth is ready' : 'Demo wave';
      } else {
        canvasWarp ??= createCanvasWarp(canvas);
        const rendered = canvasWarp(ctx, map, w, h, phase, strength);
        status = rendered ? map ? '3D depth active' : warp.mode === 'wave' ? 'Wave active' : source ? 'Wave until depth is ready' : 'Demo wave' : 'Warp unavailable';
      }
    }
    let flash;
    if (settings.strobe && settings.playing) {
      flash = strobe.update(time, settings.beatId, settings.strobe);
      drawStrobe(ctx, canvas.width, canvas.height, flash, settings.colors?.flash?.hex ?? '#ffffff', settings.colors?.flash?.opacity ?? 1);
    }
    if (settings.object?.enabled && !settings.object.warp) drawObject();
    if (settings.object?.enabled && settings.object.layer === 'below' && settings.dustEnabled && (view === 'effect' || view === 'dust')) {
      drawVideoDust(settings, settings.audio * settings.impact, time);
    }

    // Tracking geometry stays in original screen coordinates above both base effects.
    let tracked = 0;
    if (settings.blobs) {
      const tracks = source ? tracker.getTracks() : demoBlobs(time);
      tracked = drawBlobOverlay(ctx, canvas, source, tracks, { ...settings.blobs, colors: settings.colors },
        settings.blobs.sync ? settings.audio : 0, time, beatId ?? settings.numberBeat, audioBands, audioActive);
    }
    return { status, tracked, flashing: Boolean(flash) };
  }

  reset(canvas.width, canvas.height);
  return { reset, clearDepth, updateDepth, renderVideo, renderDemo, trackFrame, finishFrame, loadObject: (files, progress, quality) => objectLayer.load(files, progress, quality), resetObject: () => objectLayer.reset(), removeObject: () => objectLayer.remove(), getObjectName: () => objectLayer.name, objectReady: () => objectLayer.ready, objectAvailable: () => objectLayer.available, objectError: () => objectLayer.error, collapseObject: () => objectLayer.collapseNow(), reformObject: () => objectLayer.reformNow(), resetStrobe: () => strobe.reset(), resetBlobs: () => tracker.reset() };
}
