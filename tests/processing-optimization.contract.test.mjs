import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { SRC, readText, source } from './paths.mjs';

// O2 (odd/tasks/mini-scene-optimization.md): processing mini CPU/memory optimizations. Each change is
// compared against verbatim copies of the pre-optimization CielWin functions (REFERENCE below) on
// recorded Canvas2D call streams. The mocks record API calls and property sets; they do not model
// pixels or the JavaScript heap, so allocation savings are shown through proxies (calls into the
// allocating reference helpers and string-keyed cache lookups per frame).

const read = name => readText(source(name));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const strip = source => source.replace(/^[ \t]*\/\/ Linux mini optimization begin[^\n]*\n[\s\S]*?^[ \t]*\/\/ Linux mini optimization end\.\n/gm, '');

// Verbatim pre-O2 sprites.js/layers.js/sphere.js functions (CielWin c06df99). They draw on the
// module-global `ctx`, so they are wrapped in a factory whose `ctx` parameter points them at a recorder.
const REFERENCE = String.raw`
function referenceLayers(ctx) {
function stampSprite(sprite, unit, alpha) {
  const w = sprite.hw * 2 * unit;
  const h = sprite.hh * 2 * unit;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite.canvas, -w / 2, -h / 2, w, h);
}
function glowSprite(name, width, height) {
  const step = Math.round(Math.log(width / GLOW_BUCKET_BASE) / Math.log(GLOW_BUCKET_RATIO));
  const key = ` + '`${name}:${step}`' + String.raw`;
  let entry = glowCache.get(key);
  if (!entry) {
    const style = GLOW_STYLES[name];
    const bucketWidth = GLOW_BUCKET_BASE * GLOW_BUCKET_RATIO ** step;
    const bucketHeight = bucketWidth * height / width;
    const pad = structurePx(style.blur, 1) * 1.5 + structurePx(style.lineWidth || 0, 0.5);
    entry = {
      bucketWidth,
      sprite: bakeSprite(bucketWidth / 2 + pad, bucketHeight / 2 + pad,
        (g, k) => paintGlowRect(g, k, style, bucketWidth, bucketHeight), GLOW_SPRITE_MAX_DIM),
    };
    glowCache.set(key, entry);
  }
  return entry;
}
function stampGlow(name, width, height, alpha) {
  const { sprite, bucketWidth } = glowSprite(name, width, height);
  stampSprite(sprite, width / bucketWidth, alpha);
}
function drawGlowSegments(segments, width, alpha, blur = 8) {
  if (segments.length === 0) return;
  ctx.save();
  ctx.strokeStyle = ` + '`rgba(${CENTRAL_RAY_STROKE_COLOR},${alpha})`' + String.raw`;
  ctx.lineWidth = structurePx(width, 0.5);
  ctx.lineCap = 'round';
  ctx.shadowColor = CENTRAL_RAY_GLOW_COLOR;
  ctx.shadowBlur = structurePx(blur, 1);
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  ctx.restore();
}
function foldingBandGeometry(rx, ry, width, foldPhase) {
  const segmentCount = Math.max(48, Math.min(84, Math.round(Math.min(W, H) * 0.075)));
  const points = [];

  for (let i = 0; i <= segmentCount; i++) {
    const a = (i / segmentCount) * TAU;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    const tx = -Math.sin(a) * rx;
    const ty = Math.cos(a) * ry;
    const tangentLength = Math.hypot(tx, ty);
    const nx = -ty / tangentLength;
    const ny = tx / tangentLength;
    const fold = a * 2 + foldPhase;
    const compression = foldingBandCompression(fold);
    const bandWidth = width * compression;
    const skew = Math.sin(fold) * width * 0.22;

    points.push({
      left: [x + nx * bandWidth + (tx / tangentLength) * skew, y + ny * bandWidth + (ty / tangentLength) * skew],
      right: [x - nx * bandWidth - (tx / tangentLength) * skew, y - ny * bandWidth - (ty / tangentLength) * skew],
      front: 0.5 + 0.5 * Math.cos(fold),
    });
  }
  return points;
}
function drawFoldingBand(cx, cy, rx, ry, rot, width, foldPhase) {
  const points = foldingBandGeometry(rx, ry, width, foldPhase);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const front = (a.front + b.front) * 0.5;
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.beginPath();
    ctx.moveTo(a.left[0], a.left[1]);
    ctx.lineTo(b.left[0], b.left[1]);
    ctx.lineTo(b.right[0], b.right[1]);
    ctx.lineTo(a.right[0], a.right[1]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = ` + '`rgba(18,36,44,${0.08 + (1 - front) * 0.22})`' + String.raw`;
    ctx.lineWidth = Math.max(structurePx(0.75, 0.4), width * 0.045);
    ctx.beginPath();
    ctx.moveTo(a.right[0], a.right[1]);
    ctx.lineTo(b.right[0], b.right[1]);
    ctx.stroke();
  }

  ctx.shadowColor = 'rgba(255,255,255,0.78)';
  ctx.shadowBlur = structurePx(12, 1);
  ctx.lineWidth = Math.max(structurePx(1.15, 0.5), width * 0.11);
  ctx.strokeStyle = 'rgb(255,255,255)';
  ctx.beginPath();
  ctx.moveTo(points[0].left[0], points[0].left[1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].left[0], points[i].left[1]);
  for (let i = 0; i < points.length; i++) ctx.lineTo(points[i].right[0], points[i].right[1]);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}
function drawAtomicOrbits(cx, cy, progress) {
  for (const [rx, ry, rot, width, foldPhase] of foldingBandParameters(progress)) {
    drawFoldingBand(cx, cy, rx, ry, rot, width, foldPhase);
  }
}
function segmentedSpherePieceDimensions(descriptor, minD, projectedDepth = descriptor.projectedDepth) {
  const depthScale = 0.86 + (projectedDepth + 1) * 0.10;
  const styleScale = descriptor.style === 'solid-square' ? SOLID_SQUARE_SIZE_MULTIPLIER : 1;
  const width = minD * SEGMENTED_SPHERE_BASE_WIDTH * descriptor.sizeVariation * depthScale * styleScale;
  return {
    width,
    height: descriptor.style === 'solid-square' ? width : width / SPHERE_RECTANGLE_ASPECT_RATIO,
  };
}
function drawSolidSquareSpherePiece(x, y, dimensions, state) {
  const fillAlpha = (SOLID_SQUARE_SPHERE_ALPHA - state.travel * 0.10) * state.depthAlpha;
  const strokeAlpha = SOLID_SQUARE_SPHERE_STROKE_ALPHA * state.depthAlpha;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(state.rotation);
  stampGlow('solid-fill', dimensions.width, dimensions.height, SEGMENTED_SPHERE_GLOW_ALPHA * fillAlpha);
  stampGlow('solid-stroke', dimensions.width, dimensions.height, SEGMENTED_SPHERE_GLOW_ALPHA * strokeAlpha);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ` + '`rgba(255,255,255,${fillAlpha})`' + String.raw`;
  ctx.fillRect(-dimensions.width / 2, -dimensions.height / 2, dimensions.width, dimensions.height);
  ctx.strokeStyle = ` + '`rgba(255,255,255,${strokeAlpha})`' + String.raw`;
  ctx.lineWidth = structurePx(1.0, 0.5);
  ctx.strokeRect(-dimensions.width / 2, -dimensions.height / 2, dimensions.width, dimensions.height);
  ctx.restore();
}
function drawOutlineRectangleSpherePiece(x, y, dimensions, state) {
  const strokeAlpha = (OUTLINE_RECTANGLE_SPHERE_STROKE_ALPHA - state.travel * 0.16) * state.depthAlpha;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(state.rotation);
  stampGlow('outline-stroke', dimensions.width, dimensions.height, SEGMENTED_SPHERE_GLOW_ALPHA * strokeAlpha);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ` + '`rgba(218,250,255,${strokeAlpha})`' + String.raw`;
  ctx.lineWidth = structurePx(0.8, 0.5);
  ctx.strokeRect(-dimensions.width / 2, -dimensions.height / 2, dimensions.width, dimensions.height);
  ctx.restore();
}
function griddedRectangleInternalLineCoordinates(dimensions) {
  const left = -dimensions.width / 2;
  const right = dimensions.width / 2;
  const top = -dimensions.height / 2;
  const bottom = dimensions.height / 2;
  return {
    left,
    right,
    top,
    bottom,
    vertical: Array.from({ length: GRIDDED_RECTANGLE_VERTICAL_LINE_COUNT }, (_, index) =>
      left + (index + 1) / (GRIDDED_RECTANGLE_VERTICAL_LINE_COUNT + 1) * dimensions.width
    ),
    horizontal: Array.from({ length: GRIDDED_RECTANGLE_HORIZONTAL_LINE_COUNT }, (_, index) =>
      top + (index + 1) / (GRIDDED_RECTANGLE_HORIZONTAL_LINE_COUNT + 1) * dimensions.height
    ),
  };
}
function drawGriddedRectangleSpherePiece(x, y, dimensions, state) {
  const grid = griddedRectangleInternalLineCoordinates(dimensions);
  const fillAlpha = (GRIDDED_RECTANGLE_SPHERE_FILL_ALPHA - state.travel * 0.08) * state.depthAlpha;
  const strokeAlpha = (GRIDDED_RECTANGLE_SPHERE_STROKE_ALPHA - state.travel * 0.12) * state.depthAlpha;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(state.rotation);
  stampGlow('gridded-fill', dimensions.width, dimensions.height, SEGMENTED_SPHERE_GLOW_ALPHA * fillAlpha);
  stampGlow('gridded-stroke', dimensions.width, dimensions.height, SEGMENTED_SPHERE_GLOW_ALPHA * strokeAlpha);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ` + '`rgba(255,255,255,${fillAlpha})`' + String.raw`;
  ctx.fillRect(grid.left, grid.top, dimensions.width, dimensions.height);
  ctx.strokeStyle = ` + '`rgba(255,255,255,${strokeAlpha})`' + String.raw`;
  ctx.lineWidth = structurePx(0.72, 0.5);
  ctx.strokeRect(grid.left, grid.top, dimensions.width, dimensions.height);
  ctx.beginPath();
  for (const xCoordinate of grid.vertical) {
    ctx.moveTo(xCoordinate, grid.top);
    ctx.lineTo(xCoordinate, grid.bottom);
  }
  for (const yCoordinate of grid.horizontal) {
    ctx.moveTo(grid.left, yCoordinate);
    ctx.lineTo(grid.right, yCoordinate);
  }
  ctx.stroke();
  ctx.restore();
}
function rotateSpherePoint([x, y, z]) {
  const [ax, ay, az] = SPHERE_ORIENTATION;
  const y1 = y * Math.cos(ax) - z * Math.sin(ax);
  const z1 = y * Math.sin(ax) + z * Math.cos(ax);
  const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
  const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
  return [x2 * Math.cos(az) - y1 * Math.sin(az), x2 * Math.sin(az) + y1 * Math.cos(az), z2];
}
function rotateAroundAxis([x, y, z], [ax, ay, az], angle) {
  const axisLength = Math.hypot(ax, ay, az);
  const ux = ax / axisLength;
  const uy = ay / axisLength;
  const uz = az / axisLength;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dot = x * ux + y * uy + z * uz;
  return [
    x * cosine + (uy * z - uz * y) * sine + ux * dot * (1 - cosine),
    y * cosine + (uz * x - ux * z) * sine + uy * dot * (1 - cosine),
    z * cosine + (ux * y - uy * x) * sine + uz * dot * (1 - cosine),
  ];
}
function segmentedSphereProjection(progress, descriptor, rotationSpeed = SEGMENTED_SPHERE_ROTATION_SPEED) {
  const rotatedUnitSurfacePoint = rotateAroundAxis(
    descriptor.unitSurfacePoint,
    SEGMENTED_SPHERE_ROTATION_AXIS,
    segmentedSphereRotationAngle(progress, rotationSpeed)
  );
  const surfacePoint = rotateSpherePoint(rotatedUnitSurfacePoint);
  const normalizedAssembledTarget = [
    surfacePoint[0] * SPHERE_ASSEMBLED_RADIUS,
    surfacePoint[1] * SPHERE_ASSEMBLED_RADIUS,
  ];
  const targetRadius = Math.hypot(...normalizedAssembledTarget);
  const outwardDirection = targetRadius > Number.EPSILON
    ? [normalizedAssembledTarget[0] / targetRadius, normalizedAssembledTarget[1] / targetRadius]
    : descriptor.outwardDirection;
  return {
    surfacePoint,
    normalizedAssembledTarget,
    projectedDepth: surfacePoint[2],
    outwardDirection,
    tangentRotation: Math.atan2(outwardDirection[1], outwardDirection[0]) + Math.PI / 2,
  };
}
function segmentedSpherePieceState(progress, descriptor, speed = SPHERE_ASSEMBLY_EXPLOSION_SPEED, rotationSpeed = SEGMENTED_SPHERE_ROTATION_SPEED) {
  const travel = segmentedSphereTravel(progress, descriptor.parity, speed);
  const projection = segmentedSphereProjection(progress, descriptor, rotationSpeed);
  const normalizedDisplacement = SPHERE_EXPLOSION_DISTANCE * travel;
  return {
    ...projection,
    travel,
    normalizedDisplacement,
    normalizedPosition: [
      projection.normalizedAssembledTarget[0] + projection.outwardDirection[0] * normalizedDisplacement,
      projection.normalizedAssembledTarget[1] + projection.outwardDirection[1] * normalizedDisplacement,
    ],
    rotation: projection.tangentRotation + descriptor.rotationVariation * travel,
    depthAlpha: 0.72 + (projection.projectedDepth + 1) * 0.14,
  };
}
function drawSegmentedSphere(cx, cy, progress) {
  const minD = Math.min(W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (const descriptor of SEGMENTED_SPHERE_DESCRIPTORS) {
    const state = segmentedSpherePieceState(progress, descriptor);
    const dimensions = segmentedSpherePieceDimensions(descriptor, minD, state.projectedDepth);
    const x = cx + state.normalizedPosition[0] * minD;
    const y = cy + state.normalizedPosition[1] * minD;
    if (descriptor.style === 'solid-square') {
      drawSolidSquareSpherePiece(x, y, dimensions, state);
    } else if (descriptor.style === 'outline-rectangle') {
      drawOutlineRectangleSpherePiece(x, y, dimensions, state);
    } else {
      drawGriddedRectangleSpherePiece(x, y, dimensions, state);
    }
  }
  ctx.restore();
}
function orbitBlockState(cx, cy, phase, block) {
  const ring = ORBIT_BLOCK_RINGS[block.ring];
  const angle = block.phase + phase * ORBIT_BLOCK_RING_SPEEDS[block.ring];
  const baseR = Math.min(W, H) * 0.205;
  const rx = baseR * ring.radiusX * block.radialJitter;
  const ry = baseR * ring.radiusY * block.radialJitter;
  const localX = Math.cos(angle) * rx;
  const localY = Math.sin(angle) * ry;
  const planeCos = Math.cos(ring.planeTilt);
  const planeSin = Math.sin(ring.planeTilt);
  const front = 0.5 + 0.5 * Math.sin(angle);
  return {
    x: cx + localX * planeCos - localY * planeSin,
    y: cy + localX * planeSin + localY * planeCos,
    angle,
    front,
    size: structurePx(block.size, 1.5) * (0.90 + front * 0.74),
    opacity: 0.50 + front * 0.40,
    rotation: angle + ring.planeTilt + block.tilt,
  };
}
function drawOrbitBlocks(cx, cy, phase) {
  ctx.save();
  for (const block of orbitBlocks) {
    const state = orbitBlockState(cx, cy, phase, block);

    ctx.save();
    ctx.translate(state.x, state.y);
    ctx.rotate(state.rotation);
    ctx.fillStyle = ` + '`rgba(255,252,238,${state.opacity})`' + String.raw`;
    stampGlow('orbit-block', state.size * 1.64, state.size * 1.08, ORBIT_BLOCK_GLOW_ALPHA * state.opacity);
    ctx.globalAlpha = 1;
    ctx.fillRect(-state.size * 0.82, -state.size * 0.54, state.size * 1.64, state.size * 1.08);
    ctx.restore();
  }
  ctx.restore();
}
function perspectiveRayDirection(phase, ray, speed = FOREGROUND_INCLINED_RAY_SPEED) {
  const angle = perspectiveRayAngle(phase, ray, speed);
  return [Math.cos(angle), Math.sin(angle) * Math.sin(ray.inclination)];
}
function perspectiveRayEndpoint(cx, cy, phase, ray, width = W, height = H, zoom = viewZoom, speed = FOREGROUND_INCLINED_RAY_SPEED) {
  const [dx, dy] = perspectiveRayDirection(phase, ray, speed);
  const length = firstRayBoundaryLength(cx, cy, dx, dy, visibleCanvasBounds(cx, cy, width, height, zoom));
  return [cx + dx * length, cy + dy * length];
}
function perspectiveRayStart(cx, cy, phase, ray, speed = FOREGROUND_INCLINED_RAY_SPEED) {
  const [dx, dy] = perspectiveRayDirection(phase, ray, speed);
  const innerRadius = Math.min(W, H) * normalizedCentralCoreRadius(phase) * CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR;
  return [cx + dx * innerRadius, cy + dy * innerRadius];
}
function drawPerspectiveRays(cx, cy, phase) {
  const segments = PERSPECTIVE_RAYS.map((ray) => {
    const [x1, y1] = perspectiveRayStart(cx, cy, phase, ray);
    const [x2, y2] = perspectiveRayEndpoint(cx, cy, phase, ray);
    return [x1, y1, x2, y2];
  });
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let start = 0; start < segments.length; start += FOREGROUND_INCLINED_RAY_BATCH_SIZE) {
    drawGlowSegments(segments.slice(start, start + FOREGROUND_INCLINED_RAY_BATCH_SIZE), CENTRAL_RAY_LINE_WIDTH, CENTRAL_RAY_OPACITY, CENTRAL_RAY_GLOW_BLUR);
  }
  ctx.restore();
}
function drawCentralCore(cx, cy, phase) {
  const minD = Math.min(W, H);
  const r = minD * normalizedCentralCoreRadius(phase);

  if (CENTRAL_CORE_PROMINENT_RAY_COUNT > 0) {
    const prominentSegments = [];
    for (let i = 0; i < CENTRAL_CORE_PROMINENT_RAY_COUNT; i++) {
      const a = i * TAU / CENTRAL_CORE_PROMINENT_RAY_COUNT + Math.sin(phase) * 0.04;
      const desiredLength = r * mix(
        CENTRAL_CORE_PROMINENT_MIN_REACH_FACTOR,
        CENTRAL_CORE_PROMINENT_MAX_REACH_FACTOR,
        prominentRayGrowthEnvelope(phase, i)
      );
      const l = Math.min(desiredLength, centralCoreRaySafeLength(cx, cy, a));
      prominentSegments.push([
        cx + Math.cos(a) * r * CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR,
        cy + Math.sin(a) * r * CENTRAL_CORE_RAY_INNER_RADIUS_FACTOR,
        cx + Math.cos(a) * l,
        cy + Math.sin(a) * l,
      ]);
    }
    drawGlowSegments(prominentSegments, CENTRAL_RAY_LINE_WIDTH, CENTRAL_RAY_OPACITY, CENTRAL_RAY_GLOW_BLUR);

    const minorSegments = [];
    for (let i = 0; i < CENTRAL_CORE_MINOR_RAY_COUNT; i++) {
      const a = (i + 0.5) * TAU / CENTRAL_CORE_MINOR_RAY_COUNT - Math.sin(phase) * 0.025;
      const l = r * CENTRAL_CORE_MINOR_RAY_FACTOR;
      minorSegments.push([
        cx + Math.cos(a) * r * 0.20,
        cy + Math.sin(a) * r * 0.20,
        cx + Math.cos(a) * l,
        cy + Math.sin(a) * l,
      ]);
    }
    drawGlowSegments(minorSegments, 0.70, 0.22, 5);
  }

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 5.1);
  g.addColorStop(0.00, 'rgba(255,255,247,1.00)');
  g.addColorStop(0.16, 'rgba(255,255,242,0.98)');
  g.addColorStop(0.30, 'rgba(240,255,245,0.72)');
  g.addColorStop(0.55, 'rgba(120,255,230,0.28)');
  g.addColorStop(1.00, 'rgba(40,220,220,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 5.1, 0, TAU);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,245,0.96)';
  ctx.shadowColor = 'rgba(255,255,245,0.80)';
  ctx.shadowBlur = structurePx(20, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
}
return { drawAtomicOrbits, drawSegmentedSphere, segmentedSpherePieceState, segmentedSpherePieceDimensions,
  drawOrbitBlocks, drawPerspectiveRays, drawCentralCore };
}
`;

// Recording Canvas2D mock: every method call and property set lands in one ordered stream per context.
function harness({ variant = 'mini', width = 240, height = 240, dpr = 1 } = {}) {
    const streams = new Map(), frames = [], events = {}, errors = [], created = [];
    let nextId = 0;
    const makeContext = () => {
        const id = nextId++, ops = [];
        streams.set(id, ops);
        const state = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
        const proxy = new Proxy(state, {
            get(target, name) {
                if (name in target) return target[name];
                return (...args) => {
                    ops.push([name, ...args]);
                    if (String(name).startsWith('create'))
                        return { gradient: name, args, stops: [], addColorStop(stop, color) { this.stops.push([stop, color]); } };
                };
            },
            set(target, name, value) { ops.push([`=${String(name)}`, value]); target[name] = value; return true; }
        });
        return { id, ops, proxy };
    };
    const scene0 = makeContext();
    const bounds = { width, height };
    const canvas = { width: 0, height: 0, getContext: () => scene0.proxy, getBoundingClientRect: () => bounds };
    const nebula = { width: 0, height: 0, getContext: () => null, addEventListener() {} };
    const window = { devicePixelRatio: dpr, innerWidth: width, innerHeight: height,
        requestAnimationFrame: fn => frames.push(fn), addEventListener: (name, fn) => { events[name] = fn; } };
    const sandbox = vm.createContext({ window, URLSearchParams, performance: { now: () => 0 },
        location: { search: `?variant=${variant}&fps=30`, hash: '' },
        console: { log() {}, info() {}, warn() {}, error: (...args) => {
            if (!/synthetic transport probe|\[processing-nebula\] unavailable/.test(String(args[0]))) errors.push(args);
        } },
        document: {
            getElementById: name => name === 'scene' ? canvas : nebula,
            createElement: () => {
                const element = { width: 0, height: 0, contextId: null };
                let c = null;
                element.getContext = () => { if (!c) { c = makeContext(); element.contextId = c.id; } return c.proxy; };
                created.push(element);
                return element;
            },
            documentElement: { classList: { add() {} } },
            addEventListener: (name, fn) => { events[name] = fn; } } });
    const html = read('processing/index.html');
    for (const [, script] of html.matchAll(/<script src="([^"]+)"><\/script>/g))
        vm.runInContext(read(`processing/${script}`), sandbox, { filename: `processing/${script}` });
    vm.runInContext(REFERENCE, sandbox, { filename: 'reference.js' });
    const main = streams.get(scene0.id);
    const tick = ms => {
        assert.equal(frames.length, 1);
        const start = main.length, createdBefore = created.length;
        frames.shift()(ms);
        return { ops: main.slice(start), created: created.slice(createdBefore) };
    };
    // Runs fn against the real scene ctx and returns only the ops it recorded there.
    const capture = fn => { const start = main.length; fn(); return main.slice(start); };
    const reference = (name, ...args) => {
        const recorder = makeContext();
        sandbox.referenceLayers(recorder.proxy)[name](...args);
        return recorder.ops;
    };
    // Counts calls the optimized code makes into a global (reference) helper while fn runs.
    const callsTo = (names, fn) => {
        const counts = Object.fromEntries(names.map(name => [name, 0]));
        const originals = names.map(name => sandbox[name]);
        names.forEach((name, i) => { sandbox[name] = (...args) => { counts[name]++; return originals[i](...args); }; });
        try { fn(); } finally { names.forEach((name, i) => { sandbox[name] = originals[i]; }); }
        return counts;
    };
    const resize = (w, h) => { bounds.width = w; bounds.height = h; window.innerWidth = w; window.innerHeight = h; events.resize(); };
    return { sandbox, main, streams, created, errors, tick, capture, reference, callsTo, resize,
        evaluate: source => vm.runInContext(source, sandbox) };
}

const json = value => JSON.parse(JSON.stringify(value));
const count = (ops, name) => ops.filter(op => op[0] === name).length;
const centre = h => [h.evaluate('W') * 0.505, h.evaluate('H') * 0.515];
const TIMESTAMPS = [0, 1234, 4567, 9999, 17321, 29870];
const progressAt = (h, ms) => h.sandbox.animationProgress(ms);

// Replays a call stream with its own transform stack and reports each fill/stroke in canvas space:
// mapped path points, mapped gradient geometry, device-space line width and the paint state.
function flatten(ops) {
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const map = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const scaleOf = m => Math.hypot(m[0], m[1]);
    let m = [1, 0, 0, 1, 0, 0], state = {}, path = [];
    const stack = [], out = [];
    const style = (value, matrix) => {
        if (!value || typeof value !== 'object') return value;
        const a = value.args, s = scaleOf(matrix);
        const geometry = value.gradient === 'createRadialGradient'
            ? [...map(matrix, a[0], a[1]), a[2] * s, ...map(matrix, a[3], a[4]), a[5] * s]
            : [...map(matrix, a[0], a[1]), ...map(matrix, a[2], a[3])];
        return { gradient: value.gradient, geometry, stops: value.stops };
    };
    for (const [name, ...a] of ops) {
        if (name === 'save') stack.push([m, { ...state }]);
        else if (name === 'restore') [m, state] = stack.pop();
        else if (name === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1]]);
        else if (name === 'scale') m = mul(m, [a[0], 0, 0, a[1], 0, 0]);
        else if (name === 'rotate') m = mul(m, [Math.cos(a[0]), Math.sin(a[0]), -Math.sin(a[0]), Math.cos(a[0]), 0, 0]);
        else if (name === 'setTransform') m = a.slice(0, 6);
        else if (name.startsWith('=')) state[name.slice(1)] = a[0];
        else if (name === 'beginPath') path = [];
        else if (name === 'moveTo' || name === 'lineTo') path.push([name, ...map(m, a[0], a[1])]);
        else if (name === 'arc') path.push(['arc', ...map(m, a[0], a[1]), a[2] * scaleOf(m), a[4] - a[3]]);
        else if (name === 'closePath') path.push([name]);
        else if (name === 'fill' || name === 'stroke') {
            const blur = state.shadowBlur || 0;
            out.push({ name, path, composite: state.globalCompositeOperation ?? 'source-over',
                alpha: state.globalAlpha ?? 1, lineCap: state.lineCap, lineJoin: state.lineJoin,
                style: style(name === 'fill' ? state.fillStyle : state.strokeStyle, m),
                lineWidth: name === 'stroke' ? state.lineWidth * scaleOf(m) : undefined,
                shadow: blur > 0 ? [blur, state.shadowColor] : null });
        }
    }
    return out;
}

function assertClose(actual, expected, where = '') {
    if (typeof expected === 'number') {
        assert.equal(typeof actual, 'number', where);
        assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${where}: ${actual} vs ${expected}`);
    } else if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual), where);
        assert.equal(actual.length, expected.length, `${where} length`);
        expected.forEach((value, i) => assertClose(actual[i], value, `${where}[${i}]`));
    } else if (expected && typeof expected === 'object') {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
        for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${where}.${key}`);
    } else assert.equal(actual, expected, where);
}

// Exact-stream layers: same calls, same arguments, same property sets, in the same order.
const EXACT = [
    ['drawAtomicOrbits', (h, ms) => [...centre(h), progressAt(h, ms)], ['foldingBandGeometry']],
    ['drawSegmentedSphere', (h, ms) => [...centre(h), progressAt(h, ms)],
        ['segmentedSpherePieceState', 'segmentedSpherePieceDimensions', 'griddedRectangleInternalLineCoordinates']],
    ['drawOrbitBlocks', (h, ms) => [...centre(h), progressAt(h, ms) * Math.PI * 2], ['orbitBlockState']],
    ['drawPerspectiveRays', (h, ms) => [...centre(h), progressAt(h, ms) * Math.PI * 2],
        ['perspectiveRayStart', 'perspectiveRayEndpoint', 'visibleCanvasBounds']],
];

// O2b (P5): mini quantizes every rgba alpha to 0.001 (clamped to 0..1 like CSS) and reuses cached strings.
const quantizedAlpha = alpha => alpha >= 1 ? 1000 : alpha > 0 ? Math.round(alpha * 1000) : 0;
// The O2b colour for a reference rgba(...) value; a value whose alpha is already a multiple of 0.001 keeps
// its exact spelling (the reference literals such as 'rgba(255,255,255,0.78)').
const quantizeRgba = value => typeof value !== 'string' ? value
    : value.replace(/^rgba\(([^,()]+,[^,()]+,[^,()]+),([^,()]+)\)$/, (whole, rgb, alpha) => {
        const q = quantizedAlpha(Number(alpha)) / 1000;
        return Number(alpha) === q ? whole : `rgba(${rgb},${q})`;
    });
const quantizeStream = ops => ops.map(op => op[0].startsWith('=') ? [op[0], quantizeRgba(op[1])] : op);
const SEGMENT_OPS = ['=fillStyle', 'beginPath', 'moveTo', 'lineTo', 'lineTo', 'lineTo', 'closePath', 'fill',
    '=strokeStyle', '=lineWidth', 'beginPath', 'moveTo', 'lineTo', 'stroke'];
// O2b (P2): the reference band stream with each band's 48 quads moved into one path (same vertices, same
// order, one subpath per quad) filled once, followed by the unchanged per-segment edge strokes.
function o2bBands(ops, quantize = true) {
    const out = [];
    for (let i = 0; i < ops.length;) {
        if (ops[i][0] !== '=fillStyle' || ops[i + 1]?.[0] !== 'beginPath') { out.push(ops[i++]); continue; }
        const quads = [], strokes = [], fillStyle = ops[i][1];
        while (ops[i]?.[0] === '=fillStyle') {
            assert.deepEqual(ops.slice(i, i + SEGMENT_OPS.length).map(op => op[0]), SEGMENT_OPS);
            assert.equal(ops[i][1], fillStyle);
            quads.push(...ops.slice(i + 2, i + 7));
            strokes.push(...ops.slice(i + 8, i + 14));
            i += SEGMENT_OPS.length;
        }
        out.push(['=fillStyle', fillStyle], ['beginPath'], ...quads, ['fill'], ...strokes);
    }
    return quantize ? quantizeStream(out) : out;
}
const o2bExpected = (name, ops, quantize = true) => name === 'drawAtomicOrbits' ? o2bBands(ops, quantize)
    : quantize ? quantizeStream(ops) : ops;

test('processing mini: bands, sphere, orbit blocks and perspective rays replay the reference stream (O2b-adjusted) without the allocating helpers', () => {
    for (const dpr of [1, 2]) {
        const h = harness({ dpr });
        h.tick(0);
        assert.deepEqual(h.errors, []);
        for (const [name, argsAt, helpers] of EXACT) {
            for (const ms of TIMESTAMPS) {
                const args = argsAt(h, ms);
                const expected = o2bExpected(name, h.reference(name, ...args));
                let ops;
                const calls = h.callsTo(helpers, () => { ops = h.capture(() => h.sandbox[name](...args)); });
                assert.deepEqual(json(ops), json(expected), `${name} at ${ms} ms, dpr ${dpr}`);
                for (const helper of helpers) assert.equal(calls[helper], 0, `${name} calls ${helper}`);
            }
        }
        assert.deepEqual(h.errors, []);
    }
});

test('processing mini: scratch sphere piece state equals the reference piece state bit for bit', () => {
    const h = harness();
    h.tick(0);
    const reference = h.sandbox.referenceLayers(null);
    const descriptors = h.evaluate('SEGMENTED_SPHERE_DESCRIPTORS');
    for (const progress of [0, 0.0371, 0.25, 0.5, 0.61803, 0.9, 1, 1.37]) {
        const frame = h.sandbox.miniSegmentedSphereFrame(progress);
        for (const descriptor of descriptors) {
            const expected = reference.segmentedSpherePieceState(progress, descriptor);
            const state = h.sandbox.miniSegmentedSpherePieceState(frame, descriptor);
            assert.ok(Object.is(state.travel, expected.travel));
            assert.ok(Object.is(state.projectedDepth, expected.projectedDepth));
            assert.ok(Object.is(state.normalizedPositionX, expected.normalizedPosition[0]));
            assert.ok(Object.is(state.normalizedPositionY, expected.normalizedPosition[1]));
            assert.ok(Object.is(state.rotation, expected.rotation));
            assert.ok(Object.is(state.depthAlpha, expected.depthAlpha));
        }
    }
});

test('processing mini: central core paints the reference geometry from one cached unit gradient', () => {
    const h = harness();
    h.tick(0);
    const [cx, cy] = centre(h);
    let radials = 0;
    for (const phase of [0, 0.7, 2.9, 4.4, 5.5, 6.2]) {
        const expected = h.reference('drawCentralCore', cx, cy, phase);
        const ops = h.capture(() => h.sandbox.drawCentralCore(cx, cy, phase));
        assertClose(flatten(ops), flatten(expected), `phase ${phase}`);
        assert.equal(count(expected, 'createRadialGradient'), 1);
        radials += count(ops, 'createRadialGradient');
        // The glow segments are the reference stream; only the gradient fill moves under translate/scale.
        const segmentsEnd = expected.findIndex(op => op[0] === 'createRadialGradient');
        assert.ok(segmentsEnd > 0);
        assert.deepEqual(json(ops.slice(0, segmentsEnd)), json(expected.slice(0, segmentsEnd)));
        // State left behind for later layers matches the reference.
        const last = (stream, property) => stream.filter(op => op[0] === `=${property}`).at(-1)?.[1];
        const after = flatten([...ops, ['fill']]).at(-1), afterReference = flatten([...expected, ['fill']]).at(-1);
        assert.deepEqual([after.style, after.shadow], [afterReference.style, afterReference.shadow]);
        assert.equal(last(ops, 'shadowBlur'), 0);
    }
    assert.equal(radials, 0, 'the unit gradient was created by the first frame');
    assert.deepEqual(h.errors, []);
});

test('processing mini: glow sprites are looked up without per-stamp string keys and rebuilt on resize', () => {
    const h = harness();
    h.tick(0);
    const glowCache = h.evaluate('glowCache');
    const get = glowCache.get;
    let lookups = 0;
    glowCache.get = function (key) { lookups++; return get.call(this, key); };
    const [cx, cy] = centre(h);
    const p = progressAt(h, 1234);
    h.capture(() => { h.sandbox.drawSegmentedSphere(cx, cy, p); h.sandbox.drawOrbitBlocks(cx, cy, p * Math.PI * 2); });
    assert.equal(lookups, 0, 'warm glow sprites need no string-keyed lookup');
    glowCache.get = get;
    const sizeBefore = glowCache.size;
    assert.ok(sizeBefore > 0);
    h.resize(200, 200);
    h.tick(1000);
    assert.deepEqual(h.errors, []);
    const [cx2, cy2] = centre(h);
    for (const ms of [1234, 4567]) {
        for (const [name, args] of [['drawSegmentedSphere', [cx2, cy2, progressAt(h, ms)]],
            ['drawOrbitBlocks', [cx2, cy2, progressAt(h, ms) * Math.PI * 2]]]) {
            const expected = o2bExpected(name, h.reference(name, ...args));
            assert.deepEqual(json(h.capture(() => h.sandbox[name](...args))), json(expected), `${name} after resize`);
        }
    }
});

test('processing mini bakes no full-scene sprites; full still bakes every sprite', () => {
    const mini = harness();
    mini.tick(0);
    assert.deepEqual(mini.errors, []);
    assert.deepEqual(Object.keys(mini.evaluate('sprites')), []);
    const miniCanvases = mini.created.length;
    const full = harness({ variant: 'full' });
    full.tick(0);
    assert.deepEqual(full.errors, []);
    assert.deepEqual(Object.keys(full.evaluate('sprites')).sort(), ['chromaRings', 'flareBodies', 'flareRings', 'halo', 'softOvals']);
    // The reference bake list run in the mini page (sprites.js with its O2 blocks stripped).
    const before = mini.created.length;
    mini.evaluate(`(function () {\n${strip(read('processing/js/sprites.js'))}\nreturn buildSprites;\n})()()`);
    const referenceBakes = mini.created.length - before;
    assert.ok(referenceBakes >= 20, `${referenceBakes} reference sprite canvases`);
    assert.ok(miniCanvases < referenceBakes, `${miniCanvases} mini canvases (glow sprites only) vs ${referenceBakes}`);
});

test('processing mini: a steady frame creates no gradients and no offscreen canvases', () => {
    const h = harness();
    h.tick(0);
    for (const ms of [34, 1234, 4567]) {
        const { ops, created } = h.tick(ms);
        assert.equal(count(ops, 'createRadialGradient'), 0, `radial gradients at ${ms}`);
        assert.equal(count(ops, 'createLinearGradient'), 0, `linear gradients at ${ms}`);
        assert.equal(created.length, 0, `offscreen canvases at ${ms}`);
    }
    assert.deepEqual(h.errors, []);
});

// B5 (wallpaper optimizations): the wallpaper (full variant) runs the exact-stream O2 layers
// too, with the reference colour strings and the reference per-quad band fills (the O2b alpha rounding and
// merged band fill stay mini-only). Sizes include a 1080p wallpaper (81 band segments).
// PERF-5: the wallpaper bands and rays stamp baked glows instead of their canvas shadows, so their
// streams differ from the reference by design; blur-free-glow.contract.test.mjs checks that they keep
// every reference shape. They still run without the allocating helpers.
const PERF5_GLOW_LAYERS = new Set(['drawAtomicOrbits', 'drawPerspectiveRays']);
test('processing wallpaper (B5): sphere and orbit blocks keep the exact reference stream; no layer calls the allocating helpers', () => {
    for (const [width, height, dpr] of [[320, 200, 1], [1920, 1080, 1], [1280, 720, 2]]) {
        const h = harness({ variant: 'full', width, height, dpr });
        h.tick(0);
        for (const ms of [1234, 9999, 17321]) {
            for (const [name, argsAt, helpers] of EXACT) {
                const args = argsAt(h, ms);
                const expected = h.reference(name, ...args);
                let ops;
                const calls = h.callsTo(helpers, () => { ops = h.capture(() => h.sandbox[name](...args)); });
                if (!PERF5_GLOW_LAYERS.has(name))
                    assert.deepEqual(json(ops), json(expected), `${name} at ${ms}, ${width}x${height}@${dpr}`);
                for (const helper of helpers) assert.equal(calls[helper], 0, `${name} calls ${helper}`);
            }
        }
        assert.deepEqual(h.errors, []);
    }
});

// PERF-5: the wallpaper core stamps its spoke and disc glows, so the reference shapes are compared without shadows.
const withoutShadows = paints => paints.map(paint => ({ ...paint, shadow: null }));
test('processing wallpaper (B5): central core paints the reference geometry from one cached unit gradient', () => {
    const h = harness({ variant: 'full', width: 1920, height: 1080 });
    h.tick(0);
    const [cx, cy] = centre(h);
    let radials = 0;
    for (const phase of [0, 0.7, 2.9, 4.4, 5.5, 6.2]) {
        const expected = h.reference('drawCentralCore', cx, cy, phase);
        const ops = h.capture(() => h.sandbox.drawCentralCore(cx, cy, phase));
        assertClose(flatten(ops), withoutShadows(flatten(expected)), `phase ${phase}`);
        radials += count(ops, 'createRadialGradient');
    }
    assert.equal(radials, 0, 'the unit gradient was created by the first frame');
    assert.deepEqual(h.errors, []);
});

test('processing wallpaper (B5): glow sprites are looked up without per-stamp string keys; full sprites still baked and rebuilt on resize', () => {
    const h = harness({ variant: 'full', width: 1920, height: 1080 });
    h.tick(0);
    assert.deepEqual(Object.keys(h.evaluate('sprites')).sort(), ['chromaRings', 'flareBodies', 'flareRings', 'halo', 'softOvals']);
    const glowCache = h.evaluate('glowCache');
    const get = glowCache.get;
    let lookups = 0;
    glowCache.get = function (key) { lookups++; return get.call(this, key); };
    const [cx, cy] = centre(h);
    const p = progressAt(h, 1234);
    h.capture(() => { h.sandbox.drawSegmentedSphere(cx, cy, p); h.sandbox.drawOrbitBlocks(cx, cy, p * Math.PI * 2); });
    assert.equal(lookups, 0, 'warm glow sprites need no string-keyed lookup');
    glowCache.get = get;
    h.resize(1280, 720);
    h.tick(1000);
    assert.deepEqual(h.errors, []);
    assert.equal(h.evaluate('miniGlowEntries.size') <= h.evaluate('glowCache.size'), true);
    const [cx2, cy2] = centre(h);
    for (const ms of [1234, 4567]) {
        for (const [name, args] of [['drawSegmentedSphere', [cx2, cy2, progressAt(h, ms)]],
            ['drawOrbitBlocks', [cx2, cy2, progressAt(h, ms) * Math.PI * 2]]]) {
            assert.deepEqual(json(h.capture(() => h.sandbox[name](...args))), json(h.reference(name, ...args)), `${name} after resize`);
        }
    }
});

test('processing O2 changes are removable marked blocks over the CielWin reference', () => {
    const reference = {
        sphere: '0ae7e1443c5da47f92a0434adbd87bc1a7ef1a59a69f8f0a6bb55a1dc4788bf8',
        sprites: 'cd1c36857f4504393befb6c53b12e562d458f461860b1d366f4b24c9b5b0094b',
        layers: '84cce57bef22a17d9a41f4f9b91cd7c7bfeaa0f485ed082a76643aa7f0c3a405',
    };
    for (const [name, hash] of Object.entries(reference)) {
        const source = read(`processing/js/${name}.js`);
        assert.match(source, /\/\/ Linux mini optimization begin \(O2\)/, name);
        assert.equal(sha256(strip(source)), hash, name);
    }
    assert.match(read('processing/js/layers.js'), /\/\/ Linux mini optimization begin \(O2b\)/, 'O2b block');
});

// The mini layers that build per-frame rgba colours, run directly so a frame can be repeated exactly
// (the central core's 2 constant-alpha spoke strokes use the same table as the perspective rays; its O2
// gradient transform makes its stream differ from the reference, so it is left out here).
const miniLayers = (h, ms) => {
    const [cx, cy] = centre(h), p = progressAt(h, ms), phase = p * Math.PI * 2;
    return h.capture(() => {
        h.sandbox.drawSegmentedSphere(cx, cy, p);
        h.sandbox.drawAtomicOrbits(cx, cy, p);
        h.sandbox.drawOrbitBlocks(cx, cy, phase);
        h.sandbox.drawPerspectiveRays(cx, cy, phase);
    });
};
const referenceLayersAt = (h, ms) => {
    const [cx, cy] = centre(h), p = progressAt(h, ms), phase = p * Math.PI * 2;
    return [['drawSegmentedSphere', p], ['drawAtomicOrbits', p], ['drawOrbitBlocks', phase],
        ['drawPerspectiveRays', phase]]
        .flatMap(([name, t]) => o2bExpected(name, h.reference(name, cx, cy, t), false));
};
const isRgbaSet = op => op[0].startsWith('=') && typeof op[1] === 'string' && op[1].startsWith('rgba(');

test('processing mini O2b: each folding band fills its quads as one path (3 fills per frame, was 144)', () => {
    for (const dpr of [1, 2]) {
        const h = harness({ dpr });
        h.tick(0);
        for (const ms of TIMESTAMPS) {
            const args = [...centre(h), progressAt(h, ms)];
            const reference = h.reference('drawAtomicOrbits', ...args);
            const ops = h.capture(() => h.sandbox.drawAtomicOrbits(...args));
            assert.equal(count(reference, 'fill'), 144);
            assert.equal(count(ops, 'fill'), 3, `fills at ${ms}`);
            assert.equal(count(ops, 'stroke'), count(reference, 'stroke'), 'every edge stroke and outline kept');
            assert.equal(count(ops, 'beginPath'), count(reference, 'beginPath') - 141);
            const fills = flatten(ops).filter(paint => paint.name === 'fill');
            for (const paint of fills) {
                assert.equal(paint.path.filter(op => op[0] === 'moveTo').length, 48);
                assert.equal(paint.path.filter(op => op[0] === 'closePath').length, 48);
                assert.deepEqual([paint.style, paint.composite, paint.alpha, paint.shadow], ['rgb(255,255,255)', 'source-over', 1, null]);
            }
        }
        assert.deepEqual(h.errors, []);
    }
});

test('processing mini O2b: rgba colours are built once per (colour, 0.001 alpha step), not per frame', () => {
    const h = harness();
    h.tick(0);
    const built = [], build = h.sandbox.miniRgbaString;
    assert.equal(typeof build, 'function');
    h.sandbox.miniRgbaString = (...args) => { const value = build(...args); built.push(value); return value; };
    for (let k = 0; k < 120; k++) {
        const ms = 37 + k * 251;
        const sets = miniLayers(h, ms).filter(isRgbaSet);
        // The reference builds one template string per dynamic colour set; mini sets the same colours.
        assert.equal(sets.length, referenceLayersAt(h, ms).filter(isRgbaSet).length);
        // 144 band edges + 70 sphere fills/strokes + 32 orbit blocks + 1 ray stroke, plus constant literals.
        assert.ok(sets.length >= 247, `rgba sets at ${ms}`);
        const before = built.length;
        miniLayers(h, ms);
        assert.equal(built.length, before, `a repeated frame builds no colour string (${ms})`);
    }
    assert.ok(built.length > 0);
    assert.equal(new Set(built).size, built.length, 'no colour string is ever built twice');
    assert.ok(built.length < 120 * 247 / 10, `${built.length} strings built over 120 frames`);
    h.sandbox.miniRgbaString = build;
    assert.deepEqual(h.errors, []);
});

test('processing mini O2b: quantized alphas stay within 0.0005 of the exact alpha', () => {
    const h = harness();
    h.tick(0);
    const parse = value => value.match(/^rgba\(([^)]*),([^,()]+)\)$/).slice(1);
    for (const table of ['MINI_BAND_EDGE_RGBA', 'MINI_SPHERE_WHITE_RGBA', 'MINI_SPHERE_OUTLINE_RGBA',
        'MINI_ORBIT_BLOCK_RGBA', 'MINI_CENTRAL_RAY_RGBA']) {
        for (let k = -20; k <= 10020; k++) {
            const alpha = k / 10000 + (k % 7) * 1e-6;
            const [, quantized] = parse(h.evaluate(`miniRgba(${table}, ${alpha})`));
            assert.ok(Math.abs(Number(quantized) - Math.min(1, Math.max(0, alpha))) <= 0.0005 + 1e-12, `${table} ${alpha}`);
        }
    }
    let maxError = 0, changed = 0;
    for (const ms of TIMESTAMPS) {
        const ops = miniLayers(h, ms), exact = referenceLayersAt(h, ms);
        assert.equal(ops.length, exact.length);
        ops.forEach((op, i) => {
            if (JSON.stringify(op) === JSON.stringify(exact[i])) return;
            assert.ok(isRgbaSet(op) && isRgbaSet(exact[i]) && op[0] === exact[i][0], `only colours differ: ${op} vs ${exact[i]}`);
            const [rgb, a] = parse(op[1]), [rgbExact, aExact] = parse(exact[i][1]);
            assert.equal(rgb, rgbExact);
            maxError = Math.max(maxError, Math.abs(Number(a) - Number(aExact)));
            changed++;
        });
    }
    assert.ok(changed > 0 && maxError <= 0.0005 + 1e-12, `max alpha error ${maxError}`);
});
