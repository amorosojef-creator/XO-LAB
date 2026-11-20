export function createStrobe() {
  let lastTime, lastFlash = -Infinity, count = 0, previousBeat = 0;

  function reset() {
    lastTime = undefined;
    lastFlash = -Infinity;
    count = 0;
    previousBeat = 0;
  }

  function update(time, beat, settings) {
    if (lastTime !== undefined && (time < lastTime || time - lastTime > 1)) reset();
    const wentForward = time !== lastTime;
    lastTime = time;
    const hit = beat > 0 && beat !== previousBeat;
    if (beat > 0) previousBeat = beat;
    if (wentForward && time - lastFlash >= 1 / settings.rate && (!settings.sync || hit)) {
      lastFlash = time;
      count++;
    }
    if (time - lastFlash >= settings.duration || settings.intensity === 0) return null;
    return {
      inverted: settings.mode === 'invert' || (settings.mode === 'alternate' && count % 2 === 0),
      intensity: settings.intensity
    };
  }

  return { reset, update };
}

export function drawStrobe(ctx, width, height, flash, tint = '#fff', tintOpacity = 1) {
  if (!flash) return;
  ctx.save();
  ctx.fillStyle = tint;
  // Difference against white inverts each color channel on the opaque base.
  ctx.globalCompositeOperation = flash.inverted ? 'difference' : 'source-over';
  ctx.globalAlpha = flash.intensity * (flash.inverted ? 1 : tintOpacity);
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
