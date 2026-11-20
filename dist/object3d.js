import * as THREE from 'three';
import { OBJLoader } from './vendor/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from './vendor/three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from './vendor/three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { USDLoader } from './vendor/three/examples/jsm/loaders/USDLoader.js';
import { unzipSync } from './vendor/three/examples/jsm/libs/fflate.module.js';

const SUPPORTED = new Set(['obj', 'fbx', 'glb', 'gltf', 'usdz']);
const ext = name => (name.split('.').pop() || '').toLowerCase();

export function centerModelPivot(modelHolder) {
  const measureRoot = new THREE.Group();
  const measuredNodes = [...modelHolder.children];
  measuredNodes.forEach(child => measureRoot.add(child));
  measureRoot.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(measureRoot);
  measuredNodes.forEach(child => modelHolder.add(child));
  modelHolder.updateMatrixWorld(true);
  if (bounds.isEmpty()) throw new Error('This file contains no renderable 3D geometry.');
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const max = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(max) || max <= 0) throw new Error('The model has no usable dimensions.');
  modelHolder.position.copy(center).negate();
  modelHolder.scale.set(1, 1, 1);
  return { normalization: 1 / max, center, size };
}

export function createObjectLayer(targetCanvas) {
  let renderer = null, renderError = '';
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
  } catch (error) {
    renderError = 'This browser could not create a WebGL context for 3D rendering.';
    console.warn(renderError, error);
  }
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
  camera.position.z = 8;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x252525, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(-3, 5, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.1);
  fill.position.set(4, -2, 3); scene.add(fill);
  const root = new THREE.Group(); scene.add(root);
  // Keep screen-space placement, local rotation, user scale, and model pivot
  // in separate groups. The model's visual center is always rotationRoot's origin.
  const rotationRoot = new THREE.Group(); root.add(rotationRoot);
  const scaleRoot = new THREE.Group(); rotationRoot.add(scaleRoot);
  const modelHolder = new THREE.Group(); scaleRoot.add(modelHolder);
  const glowCanvas = document.createElement('canvas');
  const glowCtx = glowCanvas.getContext('2d');
  const glowInnerCanvas = document.createElement('canvas');
  const glowInnerCtx = glowInnerCanvas.getContext('2d');
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(.43, 36), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .27, depthWrite: false }));
  shadow.scale.set(1.35, .26, 1); shadow.position.set(.025, -.70, -.08); root.add(shadow);
  const objectUrls = new Set();
  let loadedName = 'Sample cube';
  let modelReady = false;
  let lastVideoTime = -1;
  let lastBeat = 0;
  let activeQuality = 'balanced';
  let modelNormalization = 1;
  let modelMaterials = new WeakMap();
  let collapsePoints = null, collapseGeometry = null, collapseMaterial = null;
  let collapseBase = new Float32Array(), collapseDirection = new Float32Array(), collapseVelocity = new Float32Array();
  let collapseProgress = 0, collapseMode = 'idle', collapseStarted = 0, collapseFrom = 0;
  let collapseAge = 0, lastCollapseBeat = 0, lastCollapseBand = 0;
  let lastRotationClock = performance.now() / 1000, rotationElapsed = 0;
  let lastRotationKick = -Infinity, activeCollapseSettings = null;
  let smoothed = { x: .5, y: .5, w: .22, h: .22 };
  let loadToken = 0;

  function report(callback, message, progress) { callback?.({ message, progress }); }
  function releaseUrls() { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); }
  function releaseUrlSet(urls) { for (const url of urls) { URL.revokeObjectURL(url); objectUrls.delete(url); } }
  function releaseUrlsExcept(keep) {
    for (const url of [...objectUrls]) if (!keep.has(url)) { URL.revokeObjectURL(url); objectUrls.delete(url); }
  }
  function disposeNodes(children) {
    for (const child of children) {
      child.traverse?.(node => {
        node.geometry?.dispose?.();
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.filter(Boolean).forEach(material => { for (const value of Object.values(material)) if (value?.isTexture) value.dispose(); material.dispose?.(); });
      });
    }
  }
  function clearCollapseParticles() {
    if (collapsePoints) modelHolder.remove(collapsePoints);
    collapseGeometry?.dispose(); collapseMaterial?.dispose();
    collapsePoints = collapseGeometry = collapseMaterial = null;
    collapseBase = collapseDirection = collapseVelocity = new Float32Array();
    collapseProgress = 0; collapseMode = 'idle'; collapseAge = 0;
  }
  function captureMaterialDefaults() {
    modelMaterials = new WeakMap();
    modelHolder.traverse(node => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.filter(Boolean).forEach(material => modelMaterials.set(material, {
        opacity: material.opacity ?? 1, transparent: Boolean(material.transparent), depthWrite: material.depthWrite,
        side: material.side
      }));
    });
  }
  function ensureSurfaceParticles(quality = 'balanced') {
    if (collapsePoints || !modelReady) return;
    let totalTriangles = 0;
    modelHolder.traverse(node => {
      if (node.isMesh && node.geometry?.attributes?.position) {
        const index = node.geometry.index;
        totalTriangles += Math.floor((index?.count ?? node.geometry.attributes.position.count) / 3);
      }
    });
    if (!totalTriangles) return;
    modelHolder.updateWorldMatrix(true, true);
    const inverseHolder = modelHolder.matrixWorld.clone().invert();
    const maxTriangleRecords = 30000;
    const stride = Math.max(1, Math.ceil(totalTriangles / maxTriangleRecords));
    const triangleCount = Math.ceil(totalTriangles / stride);
    const triangleVertices = new Float32Array(triangleCount * 9);
    const cumulativeAreas = new Float64Array(triangleCount);
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    let rawTriangle = 0, stored = 0, areaTotal = 0;
    modelHolder.traverse(node => {
      if (!node.isMesh || !node.geometry?.attributes?.position) return;
      const geometry = node.geometry, position = geometry.attributes.position, index = geometry.index;
      node.updateWorldMatrix(true, false);
      const localToHolder = inverseHolder.clone().multiply(node.matrixWorld);
      const indexCount = index?.count ?? position.count;
      // Step over triangles in the index buffer instead of visiting every face
      // of a very dense mesh. Keep the global stride aligned across child meshes.
      const firstTriangle = (stride - (rawTriangle % stride)) % stride;
      for (let i = firstTriangle * 3; i + 2 < indexCount; i += 3 * stride) {
        rawTriangle += stride;
        const ia = index ? index.getX(i) : i;
        const ib = index ? index.getX(i + 1) : i + 1;
        const ic = index ? index.getX(i + 2) : i + 2;
        vA.fromBufferAttribute(position, ia).applyMatrix4(localToHolder);
        vB.fromBufferAttribute(position, ib).applyMatrix4(localToHolder);
        vC.fromBufferAttribute(position, ic).applyMatrix4(localToHolder);
        ab.subVectors(vB, vA); ac.subVectors(vC, vA);
        const area = ab.cross(ac).length() * .5;
        if (!Number.isFinite(area) || area <= 1e-12 || stored >= triangleCount) continue;
        const offset = stored * 9;
        triangleVertices[offset] = vA.x; triangleVertices[offset + 1] = vA.y; triangleVertices[offset + 2] = vA.z;
        triangleVertices[offset + 3] = vB.x; triangleVertices[offset + 4] = vB.y; triangleVertices[offset + 5] = vB.z;
        triangleVertices[offset + 6] = vC.x; triangleVertices[offset + 7] = vC.y; triangleVertices[offset + 8] = vC.z;
        areaTotal += area; cumulativeAreas[stored] = areaTotal; stored++;
      }
      rawTriangle += Math.floor(indexCount / 3) % stride;
    });
    if (!stored || !areaTotal) return;
    const count = quality === 'low' ? 5000 : quality === 'high' ? 16000 : 12000;
    collapseBase = new Float32Array(count * 3);
    collapseDirection = new Float32Array(count * 3);
    collapseVelocity = new Float32Array(count * 3);
    const direction = new THREE.Vector3();
    for (let p = 0; p < count; p++) {
      const choice = Math.random() * areaTotal;
      let lo = 0, hi = stored - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulativeAreas[mid] < choice) lo = mid + 1; else hi = mid; }
      const offset = lo * 9, root = Math.sqrt(Math.random()), b = Math.random();
      const wa = 1 - root, wb = root * (1 - b), wc = root * b;
      const x = triangleVertices[offset] * wa + triangleVertices[offset+3] * wb + triangleVertices[offset+6] * wc;
      const y = triangleVertices[offset+1] * wa + triangleVertices[offset+4] * wb + triangleVertices[offset+7] * wc;
      const z = triangleVertices[offset+2] * wa + triangleVertices[offset+5] * wb + triangleVertices[offset+8] * wc;
      const base = p * 3;
      collapseBase[base] = x; collapseBase[base+1] = y; collapseBase[base+2] = z;
      direction.set(x,y,z);
      if (direction.lengthSq() < 1e-12) direction.set(Math.random()-.5, Math.random()-.5, Math.random()-.5);
      direction.normalize();
      direction.x += (Math.random()-.5) * .9; direction.y += (Math.random()-.5) * .9; direction.z += (Math.random()-.5) * .9; direction.normalize();
      collapseDirection[base] = direction.x; collapseDirection[base+1] = direction.y; collapseDirection[base+2] = direction.z;
      collapseVelocity[base] = (Math.random()-.5) * 1.5; collapseVelocity[base+1] = Math.random() * .9; collapseVelocity[base+2] = (Math.random()-.5) * 1.5;
    }
    collapseGeometry = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(count * 3);
    collapseGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    collapseGeometry.setDrawRange(0, 0);
    collapseMaterial = new THREE.PointsMaterial({ color: '#ffffff', size: 2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    collapsePoints = new THREE.Points(collapseGeometry, collapseMaterial);
    collapsePoints.frustumCulled = false; collapsePoints.visible = false;
    modelHolder.add(collapsePoints);
  }
  function startCollapse() {
    if (!modelReady || !collapsePoints) return;
    collapseFrom = collapseProgress;
    collapseStarted = performance.now() / 1000;
    collapseAge = 0; collapseMode = 'collapsing';
  }
  function startReform() {
    if (!modelReady || collapseProgress <= .001) return;
    collapseFrom = collapseProgress;
    collapseStarted = performance.now() / 1000;
    collapseMode = 'reforming';
  }
  function updateCollapse(settings, audio) {
    const now = performance.now() / 1000;
    if (!settings.collapseEnabled) {
      collapseProgress = 0; collapseMode = 'idle'; collapseAge = 0;
      if (collapsePoints) { collapsePoints.visible = false; collapseGeometry.setDrawRange(0, 0); }
      return 0;
    }
    ensureSurfaceParticles(settings.quality);
    if (!collapsePoints) return 0;
    const band = audio?.[settings.collapseBand] ?? 0;
    const sensitivity = (settings.collapseSensitivity ?? 65) / 100;
    const baseThreshold = (settings.collapseThreshold ?? 38) / 100;
    const threshold = Math.max(.025, baseThreshold * (1.15 - sensitivity * .85));
    const beat = audio?.beatId ?? 0;
    const beatHit = beat > 0 && beat !== lastCollapseBeat && band >= threshold;
    const bandHit = band >= threshold && lastCollapseBand < threshold && collapseMode === 'idle';
    if (beat > 0 && beat !== lastCollapseBeat) lastCollapseBeat = beat;
    if (!beat) lastCollapseBeat = 0;
    if (settings.collapseAudio && (beatHit || bandHit) && collapseMode === 'idle') startCollapse();
    lastCollapseBand = band;

    const duration = Math.max(.1, (settings.collapseDuration ?? 650) / 1000);
    const elapsed = Math.max(0, now - collapseStarted);
    collapseAge = elapsed;
    const easeOut = value => 1 - Math.pow(1 - value, 3);
    const easeInOut = value => value < .5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
    if (collapseMode === 'collapsing') {
      const t = Math.min(1, elapsed / (duration * Math.max(.06, 1 - collapseFrom)));
      collapseProgress = collapseFrom + (1 - collapseFrom) * easeOut(t);
      if (t >= 1) {
        collapseProgress = 1;
        collapseMode = settings.collapseAutoReform ? 'waiting' : 'dissolved';
        collapseStarted = now; collapseAge = 0;
      }
    } else if (collapseMode === 'waiting') {
      if (!settings.collapseAutoReform) collapseMode = 'dissolved';
      else if (elapsed >= (settings.collapseReformDelay ?? 350) / 1000) startReform();
    } else if (collapseMode === 'reforming') {
      const t = Math.min(1, elapsed / (duration * Math.max(.06, collapseFrom)));
      collapseProgress = collapseFrom * (1 - easeInOut(t));
      if (t >= 1) { collapseProgress = 0; collapseMode = 'idle'; }
    }

    const attribute = collapseGeometry.getAttribute('position');
    const desired = Math.max(1, Math.min(attribute.count, Math.round(settings.collapseCount ?? 3600)));
    collapseGeometry.setDrawRange(0, desired);
    const intensity = (settings.collapseIntensity ?? 72) / 100;
    const spread = (settings.collapseSpread ?? 64) / 100 * 2.1 * intensity / Math.max(.000001, modelNormalization);
    const drift = (settings.collapseDrift ?? 34) / 100 / Math.max(.000001, modelNormalization);
    const gravity = (settings.collapseGravity ?? 22) / 100 / Math.max(.000001, modelNormalization);
    const age = Math.min(collapseAge, (settings.collapseFade ?? 900) / 1000);
    const pointAlpha = collapseMode === 'dissolved'
      ? Math.max(0, 1 - collapseAge / Math.max(.1, (settings.collapseFade ?? 900) / 1000))
      : collapseProgress;
    collapsePoints.visible = collapseProgress > .001 && desired > 0 && pointAlpha > .001;
    collapseMaterial.color.set(settings.collapseUseDust ? settings.colors?.dust?.hex ?? '#ffffff' : settings.collapseColor || '#ffffff');
    collapseMaterial.size = settings.collapseSize ?? 2;
    const dustOpacity = settings.collapseUseDust ? (settings.colors?.dust?.opacity ?? 1) : 1;
    collapseMaterial.opacity = ((settings.collapseOpacity ?? 90) / 100) * pointAlpha * dustOpacity;
    const time = now;
    for (let i = 0; i < desired; i++) {
      const k = i * 3;
      const p = collapseProgress;
      attribute.array[k] = collapseBase[k] + collapseDirection[k] * spread * p + collapseVelocity[k] * drift * age * p;
      attribute.array[k+1] = collapseBase[k+1] + collapseDirection[k+1] * spread * p + collapseVelocity[k+1] * drift * age * p - gravity * age * age * p;
      attribute.array[k+2] = collapseBase[k+2] + collapseDirection[k+2] * spread * p + collapseVelocity[k+2] * drift * age * p;
      if (settings.collapseDrift) {
        attribute.array[k] += Math.sin(time * 2.1 + i * .73) * drift * .08 * p;
        attribute.array[k+2] += Math.cos(time * 1.7 + i * .51) * drift * .08 * p;
      }
    }
    attribute.needsUpdate = true;
    return collapseProgress;
  }
  function clearModel() {
    clearCollapseParticles();
    const children = [...modelHolder.children];
    children.forEach(child => modelHolder.remove(child));
    disposeNodes(children);
    modelReady = false;
  }
  function sampleCube() {
    clearModel();
    modelHolder.position.set(0, 0, 0); modelHolder.scale.set(1, 1, 1);
    rotationRoot.rotation.set(0, 0, 0); scaleRoot.scale.set(1, 1, 1); modelNormalization = 1;
    const geometry = new THREE.BoxGeometry(1.25, 1.25, 1.25, 1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: .55, roughness: .28 });
    const mesh = new THREE.Mesh(geometry, material); modelHolder.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8 }));
    mesh.add(edges);
    loadedName = 'Sample cube'; modelReady = true; centerAndNormalize(); captureMaterialDefaults();
  }
  function centerAndNormalize() {
    // Translation is inside scaleRoot, so the centering offset is scaled along
    // with the geometry. This prevents distant source origins from causing orbiting.
    modelNormalization = centerModelPivot(modelHolder).normalization;
    const triangles = countTriangles(modelHolder);
    const triangleLimit = activeQuality === 'low' ? 900000 : activeQuality === 'high' ? 350000 : 600000;
    if (triangles > triangleLimit) throw new Error(`This model exceeds the ${triangleLimit.toLocaleString()} triangle budget for ${activeQuality} quality. Choose Low quality or use a decimated model.`);
  }
  function countTriangles(group) {
    let count = 0;
    group.traverse(node => { if (node.isMesh) count += (node.geometry.index?.count ?? node.geometry.attributes.position?.count ?? 0) / 3; });
    return Math.ceil(count);
  }
  function createManager(files) {
    const byName = new Map();
    for (const file of files) {
      const url = URL.createObjectURL(file); objectUrls.add(url);
      byName.set(file.name.toLowerCase(), url);
      byName.set(file.name.split('/').pop().toLowerCase(), url);
      byName.set(file.webkitRelativePath?.toLowerCase(), url);
    }
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(requested => {
      const clean = decodeURIComponent(requested).split(/[?#]/)[0].replaceAll('\\', '/').toLowerCase();
      const exact = byName.get(clean) || byName.get(clean.split('/').pop());
      return exact || requested;
    });
    return manager;
  }
  function parseWithCallback(loader, data, ...args) {
    return new Promise((resolve, reject) => {
      try { loader.parse(data, ...args, resolve, reject); }
      catch (error) { reject(error); }
    });
  }
  async function expandZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(bytes);
    const files = [];
    let total = 0;
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      total += data.byteLength;
      if (total > 160 * 1024 * 1024) throw new Error('The ZIP expands beyond 160 MB. Use a smaller bundle.');
      files.push(new File([data], name, { type: mimeFor(name) }));
    }
    if (!files.length) throw new Error('The ZIP is empty or contains no supported model assets.');
    return files;
  }
  function mimeFor(name) {
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', tga: 'image/x-tga', gif: 'image/gif', mtl: 'text/plain' };
    return types[ext(name)] || 'application/octet-stream';
  }
  async function load(filesInput, onProgress, quality = 'balanced') {
    const token = ++loadToken;
    const previousChildren = [...modelHolder.children];
    const previousPosition = modelHolder.position.clone();
    const previousScale = modelHolder.scale.clone();
    const previousNormalization = modelNormalization;
    const previousReady = modelReady;
    const previousName = loadedName;
    const previousUrls = new Set(objectUrls);
    activeQuality = quality;
    let files = [...filesInput];
    if (!files.length) throw new Error('Select a model file first.');
    if (files.some(file => file.size > 100 * 1024 * 1024)) throw new Error('A selected file is larger than 100 MB. Try Low quality or a lighter model.');
    report(onProgress, 'Reading files on this device…', 8);
    const zips = files.filter(file => ext(file.name) === 'zip');
    if (zips.length) {
      if (files.length !== 1) throw new Error('Choose either one ZIP bundle or select the model and its linked files together.');
      files = await expandZip(zips[0]);
    }
    const modelFile = files.find(file => SUPPORTED.has(ext(file.name)));
    if (!modelFile) throw new Error('No supported model found. Choose FBX, USDZ, GLB/glTF, or OBJ.');
    const format = ext(modelFile.name);
    const textures = files.filter(file => ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'].includes(ext(file.name)));
    const mtlFile = files.find(file => ext(file.name) === 'mtl');
    if (format === 'obj' && /mtllib\s+/i.test(await modelFile.slice(0, Math.min(modelFile.size, 2 * 1024 * 1024)).text()) && !mtlFile) {
      throw new Error('The OBJ references an MTL file that is missing. Select the OBJ, MTL, and texture images together, or use a ZIP bundle.');
    }
    if (token !== loadToken) return;
    report(onProgress, `Preparing ${format.toUpperCase()}…`, 26);
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
    if (token !== loadToken) return;
    const manager = createManager(files);
    const ownedUrls = new Set([...objectUrls].filter(url => !previousUrls.has(url)));
    let parsed;
    try {
      if (format === 'obj') {
        const text = await modelFile.text();
        const obj = new OBJLoader(manager);
        if (mtlFile) {
          const materials = new MTLLoader(manager).parse(await mtlFile.text(), '');
          materials.preload(); obj.setMaterials(materials);
        }
        parsed = obj.parse(text);
      } else if (format === 'fbx') {
        // FBXLoader.parse returns its scene synchronously; yield above so the UI can paint progress first.
        parsed = new FBXLoader(manager).parse(await modelFile.arrayBuffer(), '');
      } else if (format === 'glb' || format === 'gltf') {
        const loader = new GLTFLoader(manager);
        const source = format === 'glb' ? await modelFile.arrayBuffer() : await modelFile.text();
        const gltf = await parseWithCallback(loader, source, '');
        parsed = gltf.scene || gltf.scenes?.[0];
      } else {
        parsed = await parseWithCallback(new USDLoader(manager), await modelFile.arrayBuffer(), '');
      }
    } catch (error) {
      releaseUrlSet(ownedUrls);
      throw error;
    }
    if (token !== loadToken) { disposeNodes(parsed ? [parsed] : []); releaseUrlSet(ownedUrls); return; }
    if (!parsed) { releaseUrlSet(ownedUrls); throw new Error('The model file did not contain a scene.'); }
    previousChildren.forEach(child => modelHolder.remove(child));
    modelHolder.position.set(0, 0, 0);
    modelHolder.scale.set(1, 1, 1);
    modelHolder.add(parsed);
    try {
      centerAndNormalize();
    } catch (error) {
      modelHolder.remove(parsed);
      previousChildren.forEach(child => modelHolder.add(child));
      modelHolder.position.copy(previousPosition);
      modelHolder.scale.copy(previousScale);
      modelNormalization = previousNormalization;
      modelReady = previousReady; loadedName = previousName;
      disposeNodes([parsed]); releaseUrlSet(ownedUrls);
      throw error;
    }
    const previousParticles = collapsePoints;
    clearCollapseParticles();
    captureMaterialDefaults();
    loadedName = modelFile.name; modelReady = true;
    disposeNodes(previousChildren.filter(child => child !== previousParticles));
    releaseUrlsExcept(new Set([...objectUrls].filter(url => !previousUrls.has(url))));
    report(onProgress, `Loaded ${format.toUpperCase()} · ${countTriangles(modelHolder).toLocaleString()} triangles${textures.length ? ` · ${textures.length} texture${textures.length === 1 ? '' : 's'}` : ''}`, 100);
  }
  function reset() { clearModel(); releaseUrls(); sampleCube(); }
  function remove() { ++loadToken; clearModel(); releaseUrls(); loadedName = ''; }
  function resize(width, height, quality = 'balanced') {
    if (!renderer) return;
    const ratio = quality === 'low' ? .5 : quality === 'high' ? 1 : .75;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * ratio);
    renderer.setSize(width, height, false);
    camera.left = -width / height; camera.right = width / height;
    camera.top = 1; camera.bottom = -1; camera.updateProjectionMatrix();
  }
  function update(settings, time, audio, tracks = []) {
    if (!renderer || !modelReady || !settings?.enabled) return;
    const rotationClock = performance.now() / 1000;
    rotationElapsed += Math.min(.1, Math.max(0, rotationClock - lastRotationClock));
    lastRotationClock = rotationClock;
    const [tw, th] = [targetCanvas.width, targetCanvas.height];
    if (renderer.domElement.width !== Math.round(tw * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(th * renderer.getPixelRatio())) resize(tw, th, settings.quality);
    const motion = (settings.motionIntensity ?? 34) / 100;
    const band = audio?.[settings.band] ?? audio?.level ?? 0;
    const hit = settings.beatId && settings.beatId !== lastBeat;
    if (hit) lastBeat = settings.beatId;
    if (lastVideoTime >= 0 && time < lastVideoTime - .25) smoothed = { x: .5, y: .5, w: .22, h: .22 };
    lastVideoTime = time;
    let x = (settings.x ?? 50) / 100, y = (settings.y ?? 50) / 100;
    let track = null;
    if (settings.anchor === 'blob' && tracks.length) {
      const requested = settings.track === 'largest' ? null : Number(settings.track);
      track = requested ? tracks.find(item => item.id === requested) : [...tracks].sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      if (track) { x = track.x; y = track.y; }
    } else if (settings.anchor === 'free') {
      x += Math.sin(time * 2.7) * motion * .12;
      y += Math.cos(time * 2.1) * motion * .12;
    }
    const smoothing = (settings.smoothing ?? 24) / 100;
    const follow = 1 - Math.pow(.03, 1 / Math.max(1, 1 + smoothing * 36));
    smoothed.x += (x - smoothed.x) * follow; smoothed.y += (y - smoothed.y) * follow;
    if (settings.bounce) { smoothed.x += Math.sin(time * 13) * motion * .025; smoothed.y += Math.cos(time * 11) * motion * .025; }
    const aspect = tw / Math.max(1, th);
    const depthSample = settings.depthAssist ? settings.depthSampler?.(smoothed.x, smoothed.y) : null;
    const depthOffset = Number.isFinite(depthSample) ? (depthSample - .5) * .65 : 0;
    root.position.set((smoothed.x - .5) * aspect * 2, (.5 - smoothed.y) * 2, (50 - (settings.depth ?? 50)) / 30 + depthOffset);
    const scale = ((settings.scale ?? 72) / 100) * 1.2 * (track ? .55 + Math.min(1.5, Math.sqrt(track.w * track.h) * 2.2) : 1);
    const audioScale = settings.audioSync ? 1 + band * (settings.audioResponse / 100) * .4 : 1;
    const pulse = settings.pulse ? 1 + Math.sin(time * 8) * motion * .13 : 1;
    const hitPulse = hit && settings.audioSync ? 1.16 : 1;
    scaleRoot.scale.set(
      modelNormalization * scale * (settings.width ?? 100) / 100 * audioScale * pulse * hitPulse,
      modelNormalization * scale * (settings.height ?? 100) / 100 * audioScale * pulse * hitPulse,
      modelNormalization * scale * (settings.zscale ?? 100) / 100 * audioScale * pulse * hitPulse
    );
    const acceleration = (settings.rotationAcceleration ?? 0) / 100;
    const elapsedRotation = rotationElapsed + acceleration * rotationElapsed * rotationElapsed * .18;
    if (settings.rotateMotion && hit) {
      const rotationBand = audio?.[settings.rotationBand] ?? 0;
      const sensitivity = (settings.rotationSensitivity ?? 65) / 100;
      if (rotationBand >= Math.max(.025, .38 * (1 - sensitivity * .78))) lastRotationKick = rotationElapsed;
    }
    const rotationKick = Math.max(0, Math.min(1, Math.exp(-(rotationElapsed - lastRotationKick) * 7)));
    const axisRotation = (axis, base) => {
      let degrees = base;
      if (settings.autoRotate && settings[`rotate${axis.toUpperCase()}Enabled`]) {
        degrees += Number(settings[`rotate${axis.toUpperCase()}Direction`] ?? 1) *
          Number(settings[`rotate${axis.toUpperCase()}Speed`] ?? 0) *
          Number(settings[`rotate${axis.toUpperCase()}Intensity`] ?? 100) / 100 * elapsedRotation;
      }
      if (settings.rotateMotion && rotationKick > 0 && axis === 'y') degrees += rotationKick * 36;
      if (settings.rotateMotion && rotationKick > 0 && axis === 'z') degrees += rotationKick * 14;
      return THREE.MathUtils.degToRad(((degrees % 360) + 360) % 360);
    };
    rotationRoot.rotation.set(axisRotation('x', settings.rx ?? 12), axisRotation('y', settings.ry ?? 28), axisRotation('z', settings.rz ?? 0));
    activeCollapseSettings = settings;
    const collapse = updateCollapse(settings, audio);
    shadow.visible = Boolean(settings.shadow);
    shadow.material.opacity = .27 * (1 - collapse);
    const tint = new THREE.Color(settings.tint || '#ffffff');
    modelHolder.traverse(node => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material) continue;
        const shownTint = tint.clone();
        if (hit && settings.audioSync && settings.hitFlash) shownTint.lerp(new THREE.Color('#ffffff'), .88);
        if (material.color) material.color.set(shownTint).multiplyScalar((settings.brightness ?? 100) / 100);
        // Keep thin and single-sided imported surfaces visible while they turn.
        const defaults = modelMaterials.get(material) ?? { opacity: 1, transparent: Boolean(material.transparent), depthWrite: material.depthWrite };
        const alpha = (settings.opacity ?? 100) / 100 * defaults.opacity * (1 - collapse);
        const transparent = defaults.transparent || alpha < .999;
        const needsShaderUpdate = material.side !== THREE.DoubleSide || material.wireframe !== Boolean(settings.wireframe) || material.transparent !== transparent;
        material.side = THREE.DoubleSide;
        material.transparent = transparent;
        material.opacity = alpha;
        material.depthWrite = collapse > .001 ? false : defaults.depthWrite;
        material.wireframe = Boolean(settings.wireframe);
        material.roughness = (settings.roughness ?? 55) / 100;
        if (needsShaderUpdate) material.needsUpdate = true;
      }
    });
    renderer.render(scene, camera);
  }
  function drawPivot(ctx, settings, width, height) {
    if (!settings?.showPivot || (settings.isExporting && !settings.pivotExport)) return;
    const x = (smoothed.x ?? .5) * width, y = (smoothed.y ?? .5) * height;
    const radius = Math.max(7, Math.min(12, Math.min(width, height) * .018));
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.moveTo(x - radius - 4, y); ctx.lineTo(x + radius + 4, y);
    ctx.moveTo(x, y - radius - 4); ctx.lineTo(x, y + radius + 4); ctx.stroke();
    ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillText('PIVOT', x + radius + 5, y - radius - 3);
    ctx.restore();
  }
  function drawWireGlow(ctx, settings, width, height) {
    if (!renderer || !glowCtx || !glowInnerCtx || !settings?.wireframe || !settings?.glowEnabled || collapseProgress > .001) return;
    if (glowCanvas.width !== width || glowCanvas.height !== height) { glowCanvas.width = width; glowCanvas.height = height; }
    if (glowInnerCanvas.width !== width || glowInnerCanvas.height !== height) { glowInnerCanvas.width = width; glowInnerCanvas.height = height; }
    const color = settings.colors?.wireGlow ?? { hex: '#ffffff', opacity: 1 };
    const intensity = (settings.glowIntensity ?? 65) / 100;
    const opacity = (settings.glowOpacity ?? 75) / 100 * (color.opacity ?? 1);
    const radius = Math.max(0, Number(settings.glowRadius) || 0);
    const source = renderer.domElement;
    const style = settings.glowStyle ?? 'bright';
    const placement = settings.glowPlacement ?? 'outside';
    const tint = target => {
      target.save(); target.globalCompositeOperation = 'source-in'; target.fillStyle = color.hex || '#ffffff';
      target.fillRect(0, 0, width, height); target.restore();
    };
    glowCtx.clearRect(0, 0, width, height);
    if (placement !== 'inside') {
      const haze = style === 'gloomy';
      glowCtx.save();
      glowCtx.filter = radius ? `blur(${radius * (haze ? 2.8 : 1)}px)` : 'none';
      glowCtx.globalAlpha = intensity * opacity * (haze ? .34 : 1);
      glowCtx.drawImage(source, 0, 0, width, height);
      glowCtx.restore(); tint(glowCtx);
      if (haze && radius > 0) {
        glowCtx.save(); glowCtx.filter = `blur(${radius * 1.15}px)`;
        glowCtx.globalAlpha = intensity * opacity * .38;
        glowCtx.drawImage(source, 0, 0, width, height); glowCtx.restore(); tint(glowCtx);
      }
    }
    glowInnerCtx.clearRect(0, 0, width, height);
    if (placement !== 'outside') {
      glowInnerCtx.drawImage(source, 0, 0, width, height); tint(glowInnerCtx);
      glowInnerCtx.globalCompositeOperation = 'source-atop';
      glowInnerCtx.globalAlpha = intensity * opacity * (style === 'gloomy' ? .24 : .42);
      glowInnerCtx.fillStyle = color.hex || '#ffffff'; glowInnerCtx.fillRect(0, 0, width, height);
      glowInnerCtx.globalCompositeOperation = 'source-over'; glowInnerCtx.globalAlpha = 1;
    }
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    if (placement !== 'inside') ctx.drawImage(glowCanvas, 0, 0, width, height);
    if (placement !== 'outside') ctx.drawImage(glowInnerCanvas, 0, 0, width, height);
    ctx.restore();
  }
  sampleCube();
  return {
    load, reset, remove, update,
    draw(ctx, settings, time, audio, tracks) {
      this.update(settings, time, audio, tracks);
      if (renderer && modelReady && settings?.enabled) {
        drawWireGlow(ctx, settings, targetCanvas.width, targetCanvas.height);
        ctx.drawImage(renderer.domElement, 0, 0, targetCanvas.width, targetCanvas.height);
      }
      drawPivot(ctx, settings, targetCanvas.width, targetCanvas.height);
    },
    collapseNow() { if (activeCollapseSettings?.collapseEnabled) { ensureSurfaceParticles(activeCollapseSettings.quality); startCollapse(); } },
    reformNow() { startReform(); },
    get name() { return loadedName; }, get ready() { return modelReady; }, get available() { return Boolean(renderer); }, get error() { return renderError; }, get canvas() { return renderer?.domElement ?? null; }
  };
}
