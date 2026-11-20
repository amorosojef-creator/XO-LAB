const vertexShader = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = position * .5 + .5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragmentShader = `
precision mediump float;
varying vec2 uv;
uniform sampler2D image;
uniform sampler2D depth;
uniform float phase;
uniform float strength;
uniform float perspective;
uniform float aspect;
void main() {
  vec2 point = vec2(uv.x, 1.0 - uv.y);
  vec2 centered = point - .5;
  vec2 shift;
  if (perspective > .5) {
    float near = texture2D(depth, point).r;
    float layer = near * near;
    vec2 orbit = vec2(cos(phase) / aspect, sin(phase * .86) * .63);
    shift = orbit * (.17 + layer * .83) - centered * (.22 + layer * .68);
  } else {
    shift = vec2(sin(point.y * 13.0 + phase) * .40 / aspect,
                 cos(point.x * 10.0 - phase * .83) * .26);
    shift += centered * sin(phase) * .30;
  }
  point = .5 + centered * (1.0 - strength * .7) + shift * strength;
  gl_FragColor = texture2D(image, clamp(point, .001, .999));
}`;

export function createWarp(canvas) {
  const output = document.createElement('canvas');
  const gl = output.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;

  function compile(type, code) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  const program = gl.createProgram();
  for (const [type, code] of [[gl.VERTEX_SHADER, vertexShader], [gl.FRAGMENT_SHADER, fragmentShader]]) {
    const shader = compile(type, code);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(['phase', 'strength', 'perspective', 'aspect'].map(name => [name, gl.getUniformLocation(program, name)]));
  for (const [unit, name] of ['image', 'depth'].entries()) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([128]));
  let bytes;

  return (ctx, depth, w, h, phase, strength) => {
    if (gl.isContextLost()) return false;
    if (output.width !== canvas.width || output.height !== canvas.height) {
      output.width = canvas.width;
      output.height = canvas.height;
    }
    gl.viewport(0, 0, output.width, output.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    if (depth) {
      if (bytes?.length !== depth.length) bytes = new Uint8Array(depth.length);
      for (let i = 0; i < depth.length; i++) bytes[i] = Math.round(depth[i] * 255);
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
    }
    gl.uniform1f(uniforms.phase, phase);
    gl.uniform1f(uniforms.strength, strength);
    gl.uniform1f(uniforms.perspective, depth ? 1 : 0);
    gl.uniform1f(uniforms.aspect, canvas.width / canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(output, 0, 0);
    return true;
  };
}

export function createCanvasWarp(canvas) {
  const copy = document.createElement('canvas');
  const context = copy.getContext('2d', { alpha: false, willReadFrequently: true });
  const small = document.createElement('canvas');
  const smallCtx = small.getContext('2d', { alpha: false, willReadFrequently: true });
  let frame;

  function depthWarp(ctx, depth, depthWidth, depthHeight, phase, strength) {
    const scale = 384 / Math.max(canvas.width, canvas.height);
    const width = Math.max(2, Math.round(canvas.width * Math.min(1, scale)));
    const height = Math.max(2, Math.round(canvas.height * Math.min(1, scale)));
    if (!frame || small.width !== width || small.height !== height) {
      small.width = width;
      small.height = height;
      frame = smallCtx.createImageData(width, height);
    }
    smallCtx.drawImage(canvas, 0, 0, width, height);
    const input = smallCtx.getImageData(0, 0, width, height).data;
    const output = frame.data;
    const xOrbit = Math.cos(phase) * height / width;
    const yOrbit = Math.sin(phase * .86) * .63;
    for (let y = 0; y < height; y++) {
      const v = y / height;
      const depthRow = Math.floor(v * depthHeight) * depthWidth;
      for (let x = 0; x < width; x++) {
        const u = x / width;
        const near = depth[depthRow + Math.floor(u * depthWidth)];
        const plane = near * near;
        const motion = .17 + plane * .83;
        const zoom = 1 - strength * (.92 + plane * .68);
        const sampleX = Math.min(width - 1, Math.max(0, (.5 + (u - .5) * zoom + xOrbit * motion * strength) * width));
        const sampleY = Math.min(height - 1, Math.max(0, (.5 + (v - .5) * zoom + yOrbit * motion * strength) * height));
        const left = Math.floor(sampleX), top = Math.floor(sampleY);
        const right = Math.min(width - 1, left + 1), bottom = Math.min(height - 1, top + 1);
        const dx = sampleX - left, dy = sampleY - top;
        const a = (top * width + left) * 4, b = (top * width + right) * 4;
        const c = (bottom * width + left) * 4, d = (bottom * width + right) * 4;
        const i = (y * width + x) * 4;
        for (let color = 0; color < 3; color++) {
          const upper = input[a + color] * (1 - dx) + input[b + color] * dx;
          const lower = input[c + color] * (1 - dx) + input[d + color] * dx;
          output[i + color] = upper * (1 - dy) + lower * dy;
        }
        output[i + 3] = 255;
      }
    }
    smallCtx.putImageData(frame, 0, 0);
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    return true;
  }

  return (ctx, depth, w, h, phase, strength) => {
    if (depth && smallCtx) return depthWarp(ctx, depth, w, h, phase, strength);
    if (!context) return false;
    const { width, height } = canvas;
    if (copy.width !== width || copy.height !== height) {
      copy.width = width;
      copy.height = height;
    }
    context.drawImage(canvas, 0, 0);
    const margin = Math.round(strength * Math.min(width, height) * .48);
    const band = Math.ceil(height / 54);
    for (let y = 0; y < height; y += band) {
      const rows = Math.min(band, height - y);
      const offset = Math.sin(y / height * 13 + phase) * margin;
      ctx.drawImage(copy, margin + offset, y, width - margin * 2, rows, 0, y, width, rows);
    }
    return true;
  };
}
