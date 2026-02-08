/**
 * ShapeDetector — Text-first, contour-based shape detection for Paper Piano.
 *
 * New pipeline (camera → ink → text → shape → hitbox):
 *
 *   1. PREPROCESS  — Grayscale → blur → adaptive threshold → morphological
 *                    cleanup to get a clean ink mask.
 *
 *   2. TEXT SEEDS  — NoteRecognizer.detectAll() provides note labels with
 *                    positions.  Each label becomes a *seed*.
 *
 *   3. CONTOUR EXTRACTION — Find all contours in the ink mask.  For each
 *                    text seed, find the contour that encloses (or is nearest
 *                    to) the label centre.  That contour becomes the key.
 *
 *   4. OWNERSHIP RESOLUTION — If two seeds land inside the same large contour
 *                    (merged keys), subdivide with a Voronoi-style nearest-
 *                    centroid split on the contour's ink pixels.
 *
 *   5. POLYGON SIMPLIFICATION — Douglas-Peucker on each contour for a clean
 *                    polygon suitable for rendering and point-in-polygon.
 *
 *   6. FALLBACK    — If OCR produces no seeds, fall back to the original
 *                    contour-only pipeline so the app still works without text.
 *
 * Each shape now carries:
 *   - polygon: simplified contour vertices (the actual hitbox)
 *   - rect:    bounding rect (for quick spatial tests & OCR crops)
 *   - center, area, note, color, isActive  (same as before)
 *
 * All tunable parameters live in this.params.
 */

export class ShapeDetector {
    constructor() {
        this.ready = false;

        this.params = {
            // ── Preprocessing ──────────────────────────────────────────────
            blurSize:           5,
            adaptiveBlockSize: 19,
            adaptiveC:          6,

            // ── Morphology ─────────────────────────────────────────────────
            closeKernel:        3,       // kernel size for MORPH_CLOSE
            closeIter:          1,
            openKernel:         3,       // kernel size for MORPH_OPEN
            openIter:           1,

            // ── Area filters (fractions of total frame area) ───────────────
            minAreaFrac:       0.003,
            maxAreaFrac:       0.30,

            // ── Single-shape validation ────────────────────────────────────
            minDimPx:          20,
            minSolidity:       0.45,
            dpEpsilon:         0.015,    // Douglas-Peucker epsilon (× perimeter)

            // ── Merged-contour subdivision ──────────────────────────────────
            projSmooth:         5,
            projContrastMin:    0.12,
            projThreshBias:     0.40,
            subMinDimPx:       15,

            // ── Seed matching ──────────────────────────────────────────────
            maxSeedDist:      120,       // max px distance from seed to contour centre
        };
    }

    async init(onProgress) {
        if (onProgress) onProgress('Loading OpenCV…');

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('OpenCV load timeout (30 s)')), 30000);
            const check = () => {
                if (typeof cv !== 'undefined') {
                    try {
                        if (cv.Mat) { clearTimeout(timeout); this.ready = true; resolve(); return; }
                    } catch { /* not ready yet */ }
                }
                setTimeout(check, 100);
            };
            check();
        });

        if (onProgress) onProgress('OpenCV ready ✓');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Main entry: text-first detection
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Full text-first detection pipeline.
     *
     * @param {HTMLCanvasElement} canvas — current video frame
     * @param {Array<{note, bbox, center}>} textSeeds — from NoteRecognizer.detectAll()
     * @returns {Array<Object>} shapes with polygon hitboxes
     */
    detectWithSeeds(canvas, textSeeds) {
        if (!this.ready) return [];

        const mats = [];
        const mat = m => { mats.push(m); return m; };

        try {
            const P = this.params;

            // ── 1. Preprocess ──────────────────────────────────────────────
            const src     = mat(cv.imread(canvas));
            const gray    = mat(new cv.Mat());
            const blurred = mat(new cv.Mat());
            const thresh  = mat(new cv.Mat());

            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(P.blurSize, P.blurSize), 0);
            cv.adaptiveThreshold(
                blurred, thresh, 255,
                cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv.THRESH_BINARY_INV,
                P.adaptiveBlockSize, P.adaptiveC
            );

            const kC = mat(cv.getStructuringElement(cv.MORPH_RECT,
                new cv.Size(P.closeKernel, P.closeKernel)));
            cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kC,
                new cv.Point(-1, -1), P.closeIter);

            const kO = mat(cv.getStructuringElement(cv.MORPH_RECT,
                new cv.Size(P.openKernel, P.openKernel)));
            const opened = mat(new cv.Mat());
            cv.morphologyEx(thresh, opened, cv.MORPH_OPEN, kO,
                new cv.Point(-1, -1), P.openIter);

            // ── 2. Find all contours ───────────────────────────────────────
            const contours = mat(new cv.MatVector());
            const hier     = mat(new cv.Mat());
            cv.findContours(opened, contours, hier,
                cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            const frameArea = src.cols * src.rows;
            const MIN_AREA  = frameArea * P.minAreaFrac;
            const MAX_AREA  = frameArea * P.maxAreaFrac;

            // Build usable contour list with metadata
            const contourList = [];
            for (let i = 0; i < contours.size(); i++) {
                const cnt  = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area < MIN_AREA || area > MAX_AREA) continue;
                const rect = cv.boundingRect(cnt);
                if (rect.width < P.minDimPx || rect.height < P.minDimPx) continue;
                contourList.push({ cnt, area, rect, center: {
                    x: rect.x + rect.width  / 2,
                    y: rect.y + rect.height / 2
                }});
            }

            // ── 3. Match seeds → contours ──────────────────────────────────
            let shapes;

            if (textSeeds && textSeeds.length > 0) {
                shapes = this._matchSeedsToContours(textSeeds, contourList, thresh, MIN_AREA, mat);
            } else {
                // Fallback: contour-only pipeline (no OCR available)
                shapes = this._contourOnlyFallback(contourList, thresh, MIN_AREA, mat);
            }

            // ── 4. Extract simplified polygon for each shape ───────────────
            for (const s of shapes) {
                if (s._cnt) {
                    s.polygon = this._simplifyContour(s._cnt, P.dpEpsilon);
                    delete s._cnt;
                }
                if (!s.polygon || s.polygon.length < 3) {
                    // Fallback: rectangle polygon
                    const r = s.rect;
                    s.polygon = [
                        { x: r.x,           y: r.y },
                        { x: r.x + r.width, y: r.y },
                        { x: r.x + r.width, y: r.y + r.height },
                        { x: r.x,           y: r.y + r.height }
                    ];
                }
            }

            // ── 5. Deduplicate ─────────────────────────────────────────────
            shapes = this._deduplicateShapes(shapes);

            // ── 6. Sort and assign IDs ─────────────────────────────────────
            shapes.sort((a, b) => {
                const rowH = Math.min(a.rect.height, b.rect.height) * 0.5;
                if (Math.abs(a.center.y - b.center.y) < rowH) {
                    return a.center.x - b.center.x;
                }
                return a.center.y - b.center.y;
            });
            shapes.forEach((s, idx) => { s.id = `shape_${idx}`; });

            return shapes;

        } finally {
            for (const m of mats) {
                try { m.delete(); } catch { /* already freed */ }
            }
        }
    }

    /**
     * Legacy API — detect without OCR seeds (used when OCR is unavailable).
     */
    detect(canvas) {
        return this.detectWithSeeds(canvas, null);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Seed-to-contour matching
    // ═══════════════════════════════════════════════════════════════════════════

    _matchSeedsToContours(seeds, contourList, threshMat, minArea, mat) {
        const P = this.params;
        const shapes = [];
        const usedContours = new Set();

        // Map: contour index → list of seeds inside it
        const contourSeeds = new Map();

        for (const seed of seeds) {
            let bestIdx = -1;
            let bestDist = Infinity;

            for (let ci = 0; ci < contourList.length; ci++) {
                const c = contourList[ci];

                // Check if seed centre is inside contour
                const inside = cv.pointPolygonTest(
                    c.cnt,
                    new cv.Point(seed.center.x, seed.center.y),
                    false
                );

                if (inside >= 0) {
                    // Point is inside or on edge — perfect match
                    const dx = seed.center.x - c.center.x;
                    const dy = seed.center.y - c.center.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = ci;
                    }
                }
            }

            // If no contour contains the seed, find nearest contour centre
            if (bestIdx < 0) {
                for (let ci = 0; ci < contourList.length; ci++) {
                    const c = contourList[ci];
                    const dx = seed.center.x - c.center.x;
                    const dy = seed.center.y - c.center.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < bestDist && dist < P.maxSeedDist) {
                        bestDist = dist;
                        bestIdx = ci;
                    }
                }
            }

            if (bestIdx >= 0) {
                if (!contourSeeds.has(bestIdx)) contourSeeds.set(bestIdx, []);
                contourSeeds.get(bestIdx).push(seed);
            }
        }

        // Process each contour that has seeds
        for (const [ci, seedList] of contourSeeds.entries()) {
            const c = contourList[ci];
            usedContours.add(ci);

            if (seedList.length === 1) {
                // Single seed → single shape, use the full contour
                shapes.push({
                    _cnt:    c.cnt,
                    rect:    c.rect,
                    area:    c.area,
                    center:  c.center,
                    note:    seedList[0].note,
                    textPos: seedList[0].center,
                    polygon: null  // filled later
                });
            } else {
                // Multiple seeds in one contour → need to subdivide
                const subs = this._subdivideContourBySeeds(
                    c, seedList, threshMat, minArea, mat
                );
                shapes.push(...subs);
            }
        }

        return shapes;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Multi-seed contour subdivision
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * When multiple note labels land inside a single (merged) contour,
     * split it by nearest-centroid assignment.
     *
     * Strategy:
     *   1. Try projection-profile subdivision along the dominant axis
     *      (works great for piano-key rows).
     *   2. Assign each sub-region to the nearest seed.
     *   3. If projection fails, fall back to Voronoi-style bounding-box split.
     */
    _subdivideContourBySeeds(contour, seeds, threshMat, minArea, mat) {
        const P     = this.params;
        const rect  = contour.rect;
        const shapes = [];

        // ── Try projection-profile split ───────────────────────────────────
        const axis = rect.width >= rect.height ? 'vertical' : 'horizontal';
        const subs = this._splitAlongAxis(threshMat, rect, axis, minArea);

        if (subs.length >= seeds.length) {
            // Assign each sub-region to the nearest seed
            const assigned = new Set();
            for (const sub of subs) {
                let bestSeed = null;
                let bestDist = Infinity;
                for (let si = 0; si < seeds.length; si++) {
                    if (assigned.has(si)) continue;
                    const dx = seeds[si].center.x - sub.center.x;
                    const dy = seeds[si].center.y - sub.center.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestSeed = si;
                    }
                }
                if (bestSeed !== null) {
                    assigned.add(bestSeed);
                    sub.note    = seeds[bestSeed].note;
                    sub.textPos = seeds[bestSeed].center;
                    shapes.push(sub);
                }
            }
            // Any unmatched seeds: create minimal rect shapes
            for (let si = 0; si < seeds.length; si++) {
                if (assigned.has(si)) continue;
                const s = seeds[si];
                const bb = s.bbox;
                const pad = 15;
                shapes.push({
                    rect:    { x: bb.x - pad, y: bb.y - pad, width: bb.width + pad*2, height: bb.height + pad*2 },
                    area:    (bb.width + pad*2) * (bb.height + pad*2),
                    center:  s.center,
                    note:    s.note,
                    textPos: s.center,
                    polygon: null
                });
            }
            return shapes;
        }

        // ── Fallback: Voronoi-style split along dominant axis ──────────────
        //    Sort seeds by position on the dominant axis, then split evenly.
        const sorted = [...seeds].sort((a, b) =>
            axis === 'vertical'
                ? a.center.x - b.center.x
                : a.center.y - b.center.y
        );

        const total = axis === 'vertical' ? rect.width : rect.height;
        const step  = total / sorted.length;

        for (let i = 0; i < sorted.length; i++) {
            const s    = sorted[i];
            const off  = Math.round(i * step);
            const size = Math.round(step);

            let subRect;
            if (axis === 'vertical') {
                subRect = { x: rect.x + off, y: rect.y, width: size, height: rect.height };
            } else {
                subRect = { x: rect.x, y: rect.y + off, width: rect.width, height: size };
            }

            shapes.push({
                rect:    subRect,
                area:    subRect.width * subRect.height,
                center:  { x: subRect.x + subRect.width / 2, y: subRect.y + subRect.height / 2 },
                note:    s.note,
                textPos: s.center,
                polygon: null
            });
        }

        return shapes;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Contour-only fallback (when OCR is not available)
    // ═══════════════════════════════════════════════════════════════════════════

    _contourOnlyFallback(contourList, threshMat, minArea, mat) {
        const P         = this.params;
        const frameArea = threshMat.cols * threshMat.rows;
        const MERGE     = frameArea * 0.035;
        const shapes    = [];

        for (const c of contourList) {
            // Try subdivision if large & elongated
            if (c.area > MERGE) {
                const aspect = c.rect.width / c.rect.height;
                if (aspect > 1.6 || aspect < 0.625) {
                    const subs = this._trySubdivide(threshMat, c.rect, minArea);
                    if (subs.length > 1) {
                        shapes.push(...subs);
                        continue;
                    }
                }
            }

            // Validate single contour
            const shape = this._validateContourFallback(c, mat);
            if (shape) shapes.push(shape);
        }

        return shapes;
    }

    _validateContourFallback(c, mat) {
        const P = this.params;
        const { cnt, rect, area } = c;

        // Solidity check
        const hull = mat(new cv.Mat());
        cv.convexHull(cnt, hull);
        const hullArea = cv.contourArea(hull);
        if (hullArea > 0 && area / hullArea < P.minSolidity) return null;

        return {
            _cnt:    cnt,
            rect,
            area,
            center:  c.center,
            note:    null,   // will be assigned later by main.js
            textPos: null,
            polygon: null
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Projection-profile subdivision (from previous version)
    // ═══════════════════════════════════════════════════════════════════════════

    _trySubdivide(threshMat, rect, minArea) {
        const primary   = rect.width >= rect.height ? 'vertical' : 'horizontal';
        const secondary = primary === 'vertical' ? 'horizontal' : 'vertical';
        let subs = this._splitAlongAxis(threshMat, rect, primary, minArea);
        if (subs.length > 1) return subs;
        subs = this._splitAlongAxis(threshMat, rect, secondary, minArea);
        return subs;
    }

    _splitAlongAxis(threshMat, rect, axis, minArea) {
        const P  = this.params;
        const { x: rx, y: ry, width: rw, height: rh } = rect;
        const data = threshMat.data;
        const cols = threshMat.cols;

        const len     = axis === 'vertical' ? rw : rh;
        const profile = new Float32Array(len);

        if (axis === 'vertical') {
            for (let c = 0; c < rw; c++) {
                let sum = 0;
                for (let r = 0; r < rh; r++) {
                    if (data[(ry + r) * cols + (rx + c)] > 128) sum++;
                }
                profile[c] = sum / rh;
            }
        } else {
            for (let r = 0; r < rh; r++) {
                let sum = 0;
                for (let c = 0; c < rw; c++) {
                    if (data[(ry + r) * cols + (rx + c)] > 128) sum++;
                }
                profile[r] = sum / rw;
            }
        }

        const smoothed = this._smoothArray(profile, P.projSmooth);

        const margin = Math.max(2, Math.floor(len * 0.05));
        const inner  = Array.from(smoothed.slice(margin, len - margin));
        inner.sort((a, b) => a - b);

        const minVal   = inner[0] ?? 0;
        const maxVal   = inner[inner.length - 1] ?? 0;
        const contrast = maxVal - minVal;
        if (contrast < P.projContrastMin) return [];

        const sepThreshold = minVal + contrast * P.projThreshBias;

        const interiors = [];
        let start = -1;
        for (let i = 0; i < len; i++) {
            const isSep = smoothed[i] >= sepThreshold;
            if (!isSep && start === -1) { start = i; }
            else if (isSep && start !== -1) { interiors.push({ start, end: i }); start = -1; }
        }
        if (start !== -1) interiors.push({ start, end: len });

        const valid = interiors.filter(r => (r.end - r.start) >= P.subMinDimPx);
        if (valid.length <= 1) return [];

        const subShapes = [];
        for (const region of valid) {
            const s = region.start, e = region.end;
            let subRect;
            if (axis === 'vertical') {
                subRect = { x: rx + s, y: ry, width: e - s, height: rh };
            } else {
                subRect = { x: rx, y: ry + s, width: rw, height: e - s };
            }
            const subArea = subRect.width * subRect.height;
            if (subArea < minArea || subRect.width < P.subMinDimPx || subRect.height < P.subMinDimPx) continue;

            subShapes.push({
                rect:    subRect,
                area:    subArea,
                center:  { x: subRect.x + subRect.width / 2, y: subRect.y + subRect.height / 2 },
                note:    null,
                textPos: null,
                polygon: null
            });
        }
        return subShapes;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Polygon & geometry utilities
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Douglas-Peucker simplification of an OpenCV contour.
     * @returns {Array<{x,y}>} simplified polygon vertices
     */
    _simplifyContour(cnt, epsilonFrac) {
        const peri    = cv.arcLength(cnt, true);
        const approx  = new cv.Mat();
        cv.approxPolyDP(cnt, approx, epsilonFrac * peri, true);

        const pts = [];
        for (let i = 0; i < approx.rows; i++) {
            pts.push({
                x: approx.data32S[i * 2],
                y: approx.data32S[i * 2 + 1]
            });
        }
        approx.delete();
        return pts;
    }

    /**
     * Point-in-polygon test (ray-casting algorithm).
     * Works with arbitrary convex/concave polygons.
     * @param {{x,y}} pt
     * @param {Array<{x,y}>} polygon
     * @returns {boolean}
     */
    static pointInPolygon(pt, polygon) {
        if (!polygon || polygon.length < 3) return false;
        let inside = false;
        const n = polygon.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            if (((yi > pt.y) !== (yj > pt.y)) &&
                (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /** Quick bounding-rect hit test (pre-filter before polygon test). */
    static pointInRect(pt, rect) {
        return pt.x >= rect.x && pt.x <= rect.x + rect.width &&
               pt.y >= rect.y && pt.y <= rect.y + rect.height;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    _smoothArray(arr, windowSize) {
        const out  = new Float32Array(arr.length);
        const half = Math.floor(windowSize / 2);
        for (let i = 0; i < arr.length; i++) {
            let sum = 0, n = 0;
            const lo = Math.max(0, i - half);
            const hi = Math.min(arr.length - 1, i + half);
            for (let j = lo; j <= hi; j++) { sum += arr[j]; n++; }
            out[i] = sum / n;
        }
        return out;
    }

    _deduplicateShapes(shapes) {
        const kept = [];
        for (const s of shapes) {
            let dominated = false;
            for (const k of kept) {
                if (this._rectOverlap(s.rect, k.rect) > 0.5) {
                    dominated = true;
                    break;
                }
            }
            if (!dominated) kept.push(s);
        }
        return kept;
    }

    _rectOverlap(a, b) {
        const x1 = Math.max(a.x, b.x);
        const y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width,  b.x + b.width);
        const y2 = Math.min(a.y + a.height, b.y + b.height);
        if (x2 <= x1 || y2 <= y1) return 0;
        const inter   = (x2 - x1) * (y2 - y1);
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        return smaller > 0 ? inter / smaller : 0;
    }

    /**
     * Crop and preprocess a region for OCR.
     */
    extractRegion(canvas, rect, padding = 10) {
        const x = Math.max(0, rect.x + padding);
        const y = Math.max(0, rect.y + padding);
        const w = Math.min(rect.width  - padding * 2, canvas.width  - x);
        const h = Math.min(rect.height - padding * 2, canvas.height - y);
        if (w <= 4 || h <= 4) return null;

        const tmp = document.createElement('canvas');
        const ctx = tmp.getContext('2d');
        const scale = Math.max(2, 64 / Math.min(w, h));
        tmp.width  = Math.round(w * scale);
        tmp.height = Math.round(h * scale);

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);

        const imgData = ctx.getImageData(0, 0, tmp.width, tmp.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            const v = lum < 130 ? 0 : 255;
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
        return tmp;
    }

    /**
     * Preprocess the full frame for OCR (higher contrast, scaled).
     */
    prepareForOCR(canvas) {
        const tmp = document.createElement('canvas');
        const ctx = tmp.getContext('2d');
        // Scale up 2x for better OCR accuracy
        const scale = 2;
        tmp.width  = canvas.width  * scale;
        tmp.height = canvas.height * scale;

        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);

        // Binarise
        const imgData = ctx.getImageData(0, 0, tmp.width, tmp.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            const v = lum < 140 ? 0 : 255;
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
        return { canvas: tmp, scale };
    }
}
