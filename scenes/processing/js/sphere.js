// html-wallpaper-demo D2: verbatim port of docs/great-sage/backgroud-processing/js/sphere.js (that
// tree is reference-only, excluded from git -- see the feature doc, "Source material"). Not
// restyled: only this header comment was added, the source's own header/body follow unchanged.
//
// sphere.js — foreground inclined-ray generation, segmented-sphere candidate/descriptor
// generation, and its assembly/rotation/projection math and invariants. Loads after
// config.js and math.js. Uses only per-index local mulberry32 instances, never the
// shared rnd() stream, so it has no ordering dependency on scene-data.js.
// Per-index local seeds keep this optional layer from consuming or shifting any other scene seed.
// Alternating signed speeds deliberately let rays cross rather than rotate in lockstep.
function createForegroundInclinedRays(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Foreground inclined ray count must be a non-negative integer.');
  }
  return Array.from({ length: count }, (_, index) => {
    const random = mulberry32((0x7f4a7c15 + index * 0x9e3779b9) >>> 0);
    const direction = index % 2 === 0 ? 1 : -1;
    return {
      // A golden-angle distribution keeps existing indexed descriptors stable when density changes.
      angularOffset: fract(index * 0.6180339887498949 + (random() - 0.5) * 0.035) * TAU,
      angularSpeed: direction * (0.10 + random() * 0.32 + index * 1e-6),
      inclination: (45 + random() * 15) * Math.PI / 180,
    };
  });
}

const PERSPECTIVE_RAYS = createForegroundInclinedRays(FOREGROUND_INCLINED_RAY_COUNT);

// The candidate pool grows with the piece total so enough candidates survive the omissions (384 for the default 144).
const SPHERE_CANDIDATE_COUNT = Math.max(384, Math.ceil(TOTAL_SPHERE_PIECE_COUNT * 384 / 144));
const SPHERE_MIN_PROJECTED_RADIUS = 0.085;
const SPHERE_ORIENTATION = [0.72, -0.52, 0.17];
// One normalized object-space axis makes every segmented-sphere style turn as one rigid globe.
const SEGMENTED_SPHERE_ROTATION_AXIS = [0.38, 0.81, 0.44];

function rotateSpherePoint([x, y, z]) {
  const [ax, ay, az] = SPHERE_ORIENTATION;
  const y1 = y * Math.cos(ax) - z * Math.sin(ax);
  const z1 = y * Math.sin(ax) + z * Math.cos(ax);
  const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
  const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
  return [x2 * Math.cos(az) - y1 * Math.sin(az), x2 * Math.sin(az) + y1 * Math.cos(az), z2];
}

// Rodrigues' rotation keeps each stored unit-surface point on the same sphere while it turns.
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

function fibonacciSphereCandidate(index, count) {
  const y = 1 - 2 * (index + 0.5) / count;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  const unitSurfacePoint = [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  const projected = rotateSpherePoint(unitSurfacePoint);
  const projectedRadius = Math.hypot(projected[0], projected[1]);
  const projectedAngle = Math.atan2(projected[1], projected[0]);
  const omittedByWedge = projectedAngle > 0.30 && projectedAngle < 0.98;
  const omittedByCap = unitSurfacePoint[1] > 0.88;
  const omittedByCenter = projectedRadius * SPHERE_ASSEMBLED_RADIUS < SPHERE_MIN_PROJECTED_RADIUS;
  return {
    index,
    unitSurfacePoint,
    projected,
    projectedRadius,
    omittedByWedge,
    omittedByCap,
    omittedByCenter,
    omitted: omittedByWedge || omittedByCap || omittedByCenter,
  };
}

function segmentedSphereVariation(seed) {
  const random = mulberry32(seed);
  return {
    variationSeed: seed,
    sizeVariation: 0.84 + random() * 0.30,
    rotationVariation: (random() - 0.5) * 0.24,
  };
}

const SPHERE_STYLE_PATTERN = ['solid-square', 'outline-rectangle', 'gridded-rectangle'];

// Spreads the three styles evenly along the piece list in proportion to their counts. With equal
// counts this is exactly the repeating solid, outline, gridded cycle.
function sphereStyleSequence() {
  return SPHERE_STYLE_PATTERN
    .flatMap((style, styleIndex) => Array.from({ length: SPHERE_STYLE_COUNTS[styleIndex] }, (_, slot) => ({
      style,
      styleIndex,
      position: (slot + 0.5) * TOTAL_SPHERE_PIECE_COUNT / SPHERE_STYLE_COUNTS[styleIndex],
    })))
    .sort((a, b) => a.position - b.position || a.styleIndex - b.styleIndex)
    .map((entry) => entry.style);
}
const SPHERE_STYLE_SEQUENCE = sphereStyleSequence();

function sphereCandidateOrderKey(index) {
  return mulberry32((2 + index * 0x9e3779b9) >>> 0)();
}

const SPHERE_CANDIDATES = Array.from(
  { length: SPHERE_CANDIDATE_COUNT },
  (_, index) => fibonacciSphereCandidate(index, SPHERE_CANDIDATE_COUNT)
);
const SEGMENTED_SPHERE_DESCRIPTORS = SPHERE_CANDIDATES
  .filter((candidate) => !candidate.omitted)
  .sort((a, b) => sphereCandidateOrderKey(a.index) - sphereCandidateOrderKey(b.index))
  .slice(0, TOTAL_SPHERE_PIECE_COUNT)
  .map((candidate, index) => {
    const projectedTarget = [
      candidate.projected[0] * SPHERE_ASSEMBLED_RADIUS,
      candidate.projected[1] * SPHERE_ASSEMBLED_RADIUS,
    ];
    const targetRadius = Math.hypot(...projectedTarget);
    return {
      candidateIndex: candidate.index,
      unitSurfacePoint: candidate.unitSurfacePoint,
      normalizedAssembledTarget: projectedTarget,
      projectedDepth: candidate.projected[2],
      outwardDirection: [projectedTarget[0] / targetRadius, projectedTarget[1] / targetRadius],
      tangentRotation: Math.atan2(projectedTarget[1], projectedTarget[0]) + Math.PI / 2,
      style: SPHERE_STYLE_SEQUENCE[index],
      parity: index % 2,
      ...segmentedSphereVariation((0x5f3759df + candidate.index * 0x9e3779b9) >>> 0),
    };
  });

function sphereRange(values) {
  return { min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}

function sphereStyleRunLength() {
  return SEGMENTED_SPHERE_DESCRIPTORS.reduce((result, descriptor, index, descriptors) => {
    const run = index > 0 && descriptor.style === descriptors[index - 1].style ? result.current + 1 : 1;
    return { current: run, max: Math.max(result.max, run) };
  }, { current: 0, max: 0 }).max;
}



// C1 endpoint rounding for a triangle wave: only a narrow endpoint fraction eases, while the
// central span remains linear. The quartic's derivative grows monotonically from zero to the
// shared linear rate, avoiding a dwell plateau at either assembled/exploded reversal.
function roundedSphereTurnaround(linearTravel, fraction = SPHERE_TURNAROUND_FRACTION) {
  const travel = clamp01(linearTravel);
  const gain = 1 / (1 - fraction);
  if (travel < fraction) {
    const u = travel / fraction;
    return gain * fraction * (u * u * u - 0.5 * u * u * u * u);
  }
  if (travel > 1 - fraction) return 1 - roundedSphereTurnaround(1 - travel, fraction);
  return gain * (travel - fraction * 0.5);
}

function roundedSphereTurnaroundDerivative(linearTravel, fraction = SPHERE_TURNAROUND_FRACTION) {
  const travel = clamp01(linearTravel);
  const gain = 1 / (1 - fraction);
  if (travel < fraction || travel > 1 - fraction) {
    const u = (travel < fraction ? travel : 1 - travel) / fraction;
    return gain * (3 * u * u - 2 * u * u * u);
  }
  return gain;
}

function segmentedSphereTravel(progress, parity, speed = SPHERE_ASSEMBLY_EXPLOSION_SPEED) {
  const linearTravel = pingpong01(Math.abs(progress) * Math.abs(speed) * 2);
  const sharedTravel = roundedSphereTurnaround(linearTravel);
  return parity === 0 ? sharedTravel : 1 - sharedTravel;
}

function segmentedSphereRotationAngle(progress, speed = SEGMENTED_SPHERE_ROTATION_SPEED) {
  return progress * TAU * speed;
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
// Linux mini optimization begin (O2): segmentedSpherePieceState allocates ~8 arrays/objects per piece and
// frame (rotated point, surface point, target, outward direction, projection, spread state, position).
// Mini evaluates the same expressions, in the same order, into reused scratch objects. Values that only
// depend on the frame (travel per parity, the rotation's cosine/sine and unit axis) or on constants (the
// orientation's cosines/sines) are computed once with the identical expressions, so every piece state is
// bit-identical to the reference (tested against a verbatim copy).
const miniSphereFrameScratch = { travel0: 0, travel1: 0, cosine: 0, sine: 0, ux: 0, uy: 0, uz: 0 };
const miniSpherePieceScratch = { travel: 0, projectedDepth: 0, normalizedPositionX: 0, normalizedPositionY: 0, rotation: 0, depthAlpha: 0 };
const miniSphereOrientation = {
  cosX: Math.cos(SPHERE_ORIENTATION[0]), sinX: Math.sin(SPHERE_ORIENTATION[0]),
  cosY: Math.cos(SPHERE_ORIENTATION[1]), sinY: Math.sin(SPHERE_ORIENTATION[1]),
  cosZ: Math.cos(SPHERE_ORIENTATION[2]), sinZ: Math.sin(SPHERE_ORIENTATION[2]),
};

function miniSegmentedSphereFrame(progress) {
  const frame = miniSphereFrameScratch;
  const [ax, ay, az] = SEGMENTED_SPHERE_ROTATION_AXIS;
  const axisLength = Math.hypot(ax, ay, az);
  const angle = segmentedSphereRotationAngle(progress, SEGMENTED_SPHERE_ROTATION_SPEED);
  frame.travel0 = segmentedSphereTravel(progress, 0, SPHERE_ASSEMBLY_EXPLOSION_SPEED);
  frame.travel1 = segmentedSphereTravel(progress, 1, SPHERE_ASSEMBLY_EXPLOSION_SPEED);
  frame.ux = ax / axisLength;
  frame.uy = ay / axisLength;
  frame.uz = az / axisLength;
  frame.cosine = Math.cos(angle);
  frame.sine = Math.sin(angle);
  return frame;
}

function miniSegmentedSpherePieceState(frame, descriptor) {
  const state = miniSpherePieceScratch;
  const o = miniSphereOrientation;
  const travel = descriptor.parity === 0 ? frame.travel0 : frame.travel1;
  // rotateAroundAxis(descriptor.unitSurfacePoint, SEGMENTED_SPHERE_ROTATION_AXIS, angle)
  const { ux, uy, uz, cosine, sine } = frame;
  const point = descriptor.unitSurfacePoint;
  const x = point[0], y = point[1], z = point[2];
  const dot = x * ux + y * uy + z * uz;
  const rx = x * cosine + (uy * z - uz * y) * sine + ux * dot * (1 - cosine);
  const ry = y * cosine + (uz * x - ux * z) * sine + uy * dot * (1 - cosine);
  const rz = z * cosine + (ux * y - uy * x) * sine + uz * dot * (1 - cosine);
  // rotateSpherePoint([rx, ry, rz])
  const y1 = ry * o.cosX - rz * o.sinX;
  const z1 = ry * o.sinX + rz * o.cosX;
  const x2 = rx * o.cosY + z1 * o.sinY;
  const z2 = -rx * o.sinY + z1 * o.cosY;
  const surfaceX = x2 * o.cosZ - y1 * o.sinZ;
  const surfaceY = x2 * o.sinZ + y1 * o.cosZ;
  // segmentedSphereProjection
  const targetX = surfaceX * SPHERE_ASSEMBLED_RADIUS;
  const targetY = surfaceY * SPHERE_ASSEMBLED_RADIUS;
  const targetRadius = Math.hypot(targetX, targetY);
  const outwardX = targetRadius > Number.EPSILON ? targetX / targetRadius : descriptor.outwardDirection[0];
  const outwardY = targetRadius > Number.EPSILON ? targetY / targetRadius : descriptor.outwardDirection[1];
  const tangentRotation = Math.atan2(outwardY, outwardX) + Math.PI / 2;
  // segmentedSpherePieceState
  const normalizedDisplacement = SPHERE_EXPLOSION_DISTANCE * travel;
  state.travel = travel;
  state.projectedDepth = z2;
  state.normalizedPositionX = targetX + outwardX * normalizedDisplacement;
  state.normalizedPositionY = targetY + outwardY * normalizedDisplacement;
  state.rotation = tangentRotation + descriptor.rotationVariation * travel;
  state.depthAlpha = 0.72 + (z2 + 1) * 0.14;
  return state;
}
// Linux mini optimization end.
