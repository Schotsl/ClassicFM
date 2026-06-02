export async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

export function setupCanvas(canvas, countryData) {
  if (canvas.width !== countryData.baseWidth) {
    canvas.width = countryData.baseWidth;
  }
  if (canvas.height !== countryData.baseHeight) {
    canvas.height = countryData.baseHeight;
  }
}

export function defaultCalibration(countryData) {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    fill: "#ffffff",
    background: "#000000",
    baseWidth: countryData.baseWidth,
    baseHeight: countryData.baseHeight,
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hexColor(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const color = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return fallback;
  }

  return color.toLowerCase();
}

export function normalizeCalibration(calibration, countryData) {
  const fallback = defaultCalibration(countryData);
  const legacyScale = finiteNumber(calibration.scale, fallback.scaleX);
  let fill = calibration.fill;
  let background = calibration.background;
  if (fill === undefined) {
    fill = calibration.background;
    background = fallback.background;
  }

  return {
    x: finiteNumber(calibration.x, fallback.x),
    y: finiteNumber(calibration.y, fallback.y),
    scaleX: finiteNumber(calibration.scaleX, legacyScale),
    scaleY: finiteNumber(calibration.scaleY, legacyScale),
    rotation: finiteNumber(calibration.rotation, fallback.rotation),
    opacity: finiteNumber(calibration.opacity, fallback.opacity),
    fill: hexColor(fill, fallback.fill),
    background: hexColor(background, fallback.background),
    baseWidth: countryData.baseWidth,
    baseHeight: countryData.baseHeight,
  };
}

export function drawCountries(canvas, countryData, options) {
  const ctx = canvas.getContext("2d");
  setupCanvas(canvas, countryData);
  const calibration = options.calibration;
  const selectedIds = new Set(options.selectedIds);
  const fill = options.fill || calibration.fill;
  const background = options.background || calibration.background;
  const clear = options.clear !== false;

  if (clear) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.save();
  ctx.translate(calibration.x, calibration.y);
  ctx.scale(calibration.scaleX, calibration.scaleY);
  ctx.translate(countryData.baseWidth / 2, countryData.baseHeight / 2);
  ctx.rotate(calibration.rotation * Math.PI / 180);
  ctx.translate(-countryData.baseWidth / 2, -countryData.baseHeight / 2);
  ctx.globalAlpha = calibration.opacity;
  ctx.fillStyle = fill;

  for (const country of countryData.countries) {
    if (!selectedIds.has(country.id)) {
      continue;
    }

    ctx.beginPath();
    for (const ring of country.rings) {
      if (!ring.length) {
        continue;
      }

      ctx.moveTo(ring[0][0], ring[0][1]);
      for (const point of ring.slice(1)) {
        ctx.lineTo(point[0], point[1]);
      }
      ctx.closePath();
    }
    ctx.fill("evenodd");
  }

  ctx.restore();
}

export function renderLoop(canvas, countryData, getOptions) {
  let frame = null;

  function render() {
    frame = null;
    drawCountries(canvas, countryData, getOptions());
  }

  function requestRender() {
    if (frame === null) {
      frame = requestAnimationFrame(render);
    }
  }

  window.addEventListener("resize", requestRender);
  requestRender();

  return requestRender;
}
