// Read-only checkpoint: production retains its live scheduler, RNG and sizing policies.
function nativeProcessingCheckpoint() {
    const fail = reason => ({ ok: false, reason });
    if (document.readyState !== 'complete' || !drawReadyAttempted) return fail('not-ready');
    if (isMiniVariant) return fail('not-full');
    if (window.devicePixelRatio !== 1) return fail('dpr');
    const bounds = canvas.getBoundingClientRect();
    const backgroundBounds = nebulaCanvas.getBoundingClientRect();
    if (bounds.width !== 3440 || bounds.height !== 1440 ||
        backgroundBounds.width !== 3440 || backgroundBounds.height !== 1440) return fail('css');
    if (!ctx || canvas.width !== 3440 || canvas.height !== 1440) return fail('foreground');
    const gl = nebulaRenderer && nebulaRenderer.gl;
    if (!gl || gl.isContextLost() || NEBULA_DPR_CAP !== 0.45 ||
        nebulaCanvas.width !== 1548 || nebulaCanvas.height !== 648 ||
        gl.drawingBufferWidth !== nebulaCanvas.width ||
        gl.drawingBufferHeight !== nebulaCanvas.height) return fail('nebula');
    return { ok: true, dpr: window.devicePixelRatio, css: [bounds.width, bounds.height],
        foreground: [canvas.width, canvas.height],
        nebula: [gl.drawingBufferWidth, gl.drawingBufferHeight], nebulaCap: NEBULA_DPR_CAP };
}

// Synchronous elapsed time includes submission and incidental blocking, not just JS.
// No asynchronous raster/GPU completion or fullscreen equivalence can be inferred.
// Thirty warmup draws do not guarantee all lazy caches are warm; overlay is normally idle.
// Frame/residual include wrapper, clock and bookkeeping overhead; nothing is subtracted.
// Instrumentation can perturb submission/blocking. Residual also includes non-stage work.
const nativeProcessingAttribution = (() => {
    'use strict'; // Preserve null/primitive receivers for strict original functions too.
    const names = ['renderNebula', 'ensureSprites', 'drawSoftOvalFields', 'drawStars',
        'drawRadialStreaks', 'drawLensFlares', 'drawChromaticSideLoops', 'drawSegmentedSphere',
        'drawAtomicOrbits', 'drawOrbitBlocks', 'drawCentralOctagon', 'drawTriangularPrism',
        'drawPerspectiveRays', 'drawCentralCore', 'drawFilmGrain', 'drawVignette', 'renderAlertOverlay'];
    const warmup = 30, count = 120;
    const metrics = ['meanMs', 'medianMs', 'p95Ms', 'firstHalfMeanMs', 'secondHalfMeanMs'];
    const keys = (value, expected) => value !== null && typeof value === 'object' &&
        !Array.isArray(value) && Object.keys(value).length === expected.length &&
        expected.every(key => Object.hasOwn(value, key));
    const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 15000;
    const near = (a, b) => Math.abs(a - b) <= 1e-7; // Arithmetic consistency, not a timing error bound.
    function validStats(value, stage = false) {
        return keys(value, ['count', ...metrics, ...(stage ? ['name'] : [])]) && value.count === count &&
            metrics.every(key => duration(value[key])) && value.medianMs <= value.p95Ms &&
            near(value.meanMs, (value.firstHalfMeanMs + value.secondHalfMeanMs) / 2);
    }
    function valid(summary) {
        if (!keys(summary, ['version', 'warmup', 'count', 'timestampRangeMs', 'clock', 'frame', 'stages', 'residual']) ||
            summary.version !== 1 || summary.warmup !== warmup || summary.count !== count) return false;
        const range = summary.timestampRangeMs, clock = summary.clock;
        if (!Array.isArray(range) || range.length !== 2 ||
            !range.every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) ||
            range[1] <= range[0] || range[1] - range[0] > 15000 ||
            !keys(clock, ['reads', 'zeroDeltas', 'minimumPositiveDeltaMs', 'residualToleranceMs']) ||
            clock.reads !== 5400 || !Number.isInteger(clock.zeroDeltas) || clock.zeroDeltas < 0 ||
            clock.zeroDeltas >= 5399 || !duration(clock.minimumPositiveDeltaMs) ||
            clock.minimumPositiveDeltaMs === 0 || clock.residualToleranceMs !== 0) return false;
        if (!validStats(summary.frame) || !validStats(summary.residual) ||
            summary.frame.firstHalfMeanMs <= 0 || summary.frame.secondHalfMeanMs <= 0 ||
            !Array.isArray(summary.stages) || summary.stages.length !== names.length ||
            !summary.stages.every((stage, i) => validStats(stage, true) && stage.name === names[i])) return false;
        return ['meanMs', 'firstHalfMeanMs', 'secondHalfMeanMs'].every(key =>
            near(summary.frame[key], summary.residual[key] + summary.stages.reduce((sum, stage) => sum + stage[key], 0)));
    }
    function stats(values) {
        const sorted = Array.from(values).sort((a, b) => a - b);
        let first = 0, second = 0;
        for (let i = 0; i < count / 2; i++) { first += values[i]; second += values[i + count / 2]; }
        return { count, meanMs: (first + second) / count,
            medianMs: (sorted[59] + sorted[60]) / 2, p95Ms: sorted[113],
            firstHalfMeanMs: first / 60, secondHalfMeanMs: second / 60 };
    }

    let started = false, stopped = false, consumed = false, active = false;
    let report = null, frameError = null, next = 0, depth = 0, completed = 0;
    let lastTimestamp = -1, lastClock = null, reads = 0, zeroDeltas = 0, minimumPositiveDeltaMs = Infinity;
    let rows, current, timestamps;
    function clock() {
        try {
            const value = performance.now();
            reads++;
            if (!Number.isFinite(value) || value < 0 || (lastClock !== null && value < lastClock)) throw new Error('clock');
            if (lastClock !== null) {
                const delta = value - lastClock;
                if (delta === 0) zeroDeltas++;
                else minimumPositiveDeltaMs = Math.min(minimumPositiveDeltaMs, delta);
            }
            lastClock = value;
            return value;
        } catch (_) { frameError = 'clock'; return NaN; }
    }
    function stop(value) {
        if (stopped) return;
        stopped = true;
        report = value;
        // A failed logger must not replace an original render/stage exception.
        try { console.log('CIELINUX_NATIVE_PROCESSING_ATTRIBUTION_READY_V1'); } catch (_) {}
    }
    function finishFrame(begin, timestamp) {
        const elapsed = clock() - begin;
        active = false;
        if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp <= lastTimestamp ||
            timestamp > Number.MAX_SAFE_INTEGER) frameError = 'timestamp';
        if (next !== names.length || depth !== 0) frameError = frameError || 'partial-stage-order';
        if (frameError) { stop({ error: frameError }); return; }
        const sum = current.reduce((total, value) => total + value, 0);
        const residual = elapsed - sum;
        // Zero tolerance: never clamp negative residuals or infer a clock resolution.
        // A conservative failure is preferable to fabricating valid-looking samples.
        if (!duration(elapsed) || !duration(residual) || !current.every(duration)) {
            stop({ error: 'duration-or-residual' }); return;
        }
        lastTimestamp = timestamp;
        if (completed >= warmup) {
            const index = completed - warmup;
            rows[0][index] = elapsed;
            for (let i = 0; i < names.length; i++) rows[i + 1][index] = current[i];
            rows[18][index] = residual;
            timestamps[index] = timestamp;
        }
        completed++;
        if (completed !== warmup + count) return;
        // All allocation/sorting/summary work is after the frame's end clock read.
        const summary = { version: 1, warmup, count, timestampRangeMs: [timestamps[0], timestamps[119]],
            // Minimum observed positive step is NOT a calibrated timer resolution.
            // Zero deltas expose quantization; the strict residual policy can reject tiny negatives.
            clock: { reads, zeroDeltas, minimumPositiveDeltaMs, residualToleranceMs: 0 },
            frame: stats(rows[0]), stages: names.map((name, i) => ({ name, ...stats(rows[i + 1]) })),
            residual: stats(rows[18]) };
        stop(valid(summary) ? summary : { error: 'summary-or-clock' });
    }
    function start() {
        if (started || !nativeProcessingCheckpoint().ok) return false;
        const originalRender = globalThis.render;
        const originals = names.map(name => globalThis[name]);
        if (typeof originalRender !== 'function' || originals.some(fn => typeof fn !== 'function')) return false;
        started = true;
        rows = Array.from({ length: 19 }, () => new Float64Array(count));
        current = new Float64Array(names.length);
        timestamps = new Float64Array(count);
        names.forEach((name, index) => {
            const original = originals[index];
            globalThis[name] = function (...args) {
                // Includes stages called by the already-queued, unwrapped original render.
                if (!active || stopped) return Reflect.apply(original, this, args);
                if (next !== index || depth !== 0) frameError = 'stage-order';
                next++;
                depth++;
                const begin = clock();
                try { return Reflect.apply(original, this, args); }
                catch (error) { frameError = 'stage-exception'; throw error; }
                finally { current[index] = clock() - begin; depth--; }
            };
        });
        globalThis.render = function (...args) {
            if (stopped) return Reflect.apply(originalRender, this, args);
            if (active) {
                frameError = 'nested-render';
                return Reflect.apply(originalRender, this, args);
            }
            active = true;
            frameError = null;
            next = 0;
            depth = 0;
            current.fill(0);
            const begin = clock();
            try { return Reflect.apply(originalRender, this, args); }
            catch (error) { frameError = 'render-exception'; throw error; }
            finally {
                // Observational failures must never mask the original return or exception.
                try { finishFrame(begin, args[0]); }
                catch (_) { active = false; stop({ error: 'observer' }); }
            }
        };
        return true;
    }
    function take() {
        if (!stopped || consumed) return null;
        consumed = true;
        return { checkpoint: nativeProcessingCheckpoint(), attribution: report };
    }
    return { start, take, valid };
})();

function nativeProcessingStart() { return nativeProcessingAttribution.start(); }
function nativeProcessingResult() { return nativeProcessingAttribution.take(); }
function nativeProcessingValidSummary(value) { return nativeProcessingAttribution.valid(value); }
