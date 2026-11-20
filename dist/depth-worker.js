import { env, InferenceSession, Tensor } from './depth-model/ort.wasm.min.mjs';

const assetRoot = new URL('./depth-model/', import.meta.url);
const modelFiles = ['model-0.bin', 'model-1.bin', 'model-2.bin'];
const modelSize = 27258801;
const mean = [.485, .456, .406];
const deviation = [.229, .224, .225];
let session;
let ready;
let inferenceSize = 224;

env.wasm.numThreads = 1;
env.wasm.wasmPaths = assetRoot.href;

async function loadModel() {
  const model = new Uint8Array(modelSize);
  let offset = 0;
  for (const file of modelFiles) {
    const response = await fetch(new URL(file, assetRoot));
    if (!response.ok) throw new Error(`Depth model request failed (${response.status})`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    model.set(buffer, offset);
    offset += buffer.length;
    self.postMessage({ type: 'progress', progress: Math.round(offset / modelSize * 90) });
  }
  if (offset !== model.length) throw new Error('Depth model size does not match');
  session = await InferenceSession.create(model, { executionProviders: ['wasm'] });
}

function prepareFrame(rgba, sourceWidth, sourceHeight, size) {
  const scale = size / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(56, Math.round(sourceWidth * scale / 14) * 14);
  const height = Math.max(56, Math.round(sourceHeight * scale / 14) * 14);
  const plane = width * height;
  const tensorData = new Float32Array(plane * 3);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.max(0, (y + .5) * sourceHeight / height - .5);
    const top = Math.floor(sourceY);
    const bottom = Math.min(sourceHeight - 1, top + 1);
    const fy = sourceY - top;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, (x + .5) * sourceWidth / width - .5);
      const left = Math.floor(sourceX);
      const right = Math.min(sourceWidth - 1, left + 1);
      const fx = sourceX - left;
      const a = (top * sourceWidth + left) * 4;
      const b = (top * sourceWidth + right) * 4;
      const c = (bottom * sourceWidth + left) * 4;
      const d = (bottom * sourceWidth + right) * 4;
      const pixel = y * width + x;
      for (let channel = 0; channel < 3; channel++) {
        const upper = rgba[a + channel] * (1 - fx) + rgba[b + channel] * fx;
        const lower = rgba[c + channel] * (1 - fx) + rgba[d + channel] * fx;
        tensorData[channel * plane + pixel] = ((upper * (1 - fy) + lower * fy) / 255 - mean[channel]) / deviation[channel];
      }
    }
  }
  return new Tensor('float32', tensorData, [1, 3, height, width]);
}

async function estimate(data, size) {
  const frame = prepareFrame(new Uint8ClampedArray(data.rgba), data.width, data.height, size);
  let depth;
  try {
    ({ predicted_depth: depth } = await session.run({ pixel_values: frame }));
    if (!depth || depth.dims.length !== 3) throw new Error('Unexpected depth output');
    const [, height, width] = depth.dims;
    const values = depth.data;
    const sorted = values.slice().sort();
    const lo = sorted[Math.floor((sorted.length - 1) * .02)];
    const hi = sorted[Math.ceil((sorted.length - 1) * .98)];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('Depth output was invalid');
    const pixels = new Uint8ClampedArray(values.length);
    if (hi - lo < 1e-6) pixels.fill(128);
    else {
      const gain = 255 / (hi - lo);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (values[i] - lo) * gain;
    }
    self.postMessage({ type: 'depth', id: data.id, width, height, pixels }, [pixels.buffer]);
  } finally {
    frame.dispose();
    depth?.dispose();
  }
}

self.onmessage = async ({ data }) => {
  try {
    ready ??= loadModel();
    await ready;
    if (data.type === 'load') {
      self.postMessage({ type: 'ready' });
      return;
    }
    try {
      await estimate(data, inferenceSize);
    } catch (error) {
      if (inferenceSize === 154) throw error;
      inferenceSize = 154;
      await estimate(data, inferenceSize);
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: String(error?.message ?? error) });
  }
};
