/* =========================================================
   ShapeDetector — OpenCV.js-based contour analysis
   =========================================================
   Detects hand-drawn rectangles (→ piano keys) and circles
   (→ drum pads) from a live video frame.

   Pipeline:
     1. Detect the paper (largest bright quadrilateral)
     2. Mask / crop to the paper region only
     3. Multi-strategy thresholding within the paper
     4. Contour → shape classification
   ========================================================= */
'use strict';

class ShapeDetector {
    constructor () {
        /** Cached detected shapes (array of shape objects). */
        this.shapes         = [];
        this.ready          = false;
        /** Last debug log string */
        this.lastLog        = '';
        /** Cached paper contour (in processing-canvas coords) for overlay drawing. */
        this.paperContour   = null;
        /** Intermediate canvas used to feed frames to OpenCV */
        this._canvas        = null;
        this._ctx           = null;
        /** Width / height of the processing canvas (can be down-scaled). */
        this._w             = 0;
        this._h             = 0;
        /** Scale factors from processing canvas → original video size. */
        this._sx            = 1;
        this._sy            = 1;
    }

    /* ---------- lifecycle ---------- */

    /**
     * @param {number} videoW – native video width
     * @param {number} videoH – native video height
     */
    init (videoW, videoH) {
        // Down-scale for speed (process at max 640 wide)
        const maxW = 640;
        const scale = videoW > maxW ? maxW / videoW : 1;
        this._w  = Math.round(videoW * scale);
        this._h  = Math.round(videoH * scale);
        this._sx = videoW / this._w;
        this._sy = videoH / this._h;

        this._canvas        = document.createElement('canvas');
        this._canvas.width  = this._w;
        this._canvas.height = this._h;
        this._ctx           = this._canvas.getContext('2d', { willReadFrequently: true });
        this.ready          = true;
        console.log('[ShapeDetector] init', this._w, 'x', this._h,
                    'scale', this._sx.toFixed(2), this._sy.toFixed(2));
    }

    /** Release OpenCV resources retained for the overlay. */
    destroy () {
        if (this.paperContour) this.paperContour.delete();
        this.paperContour = null;
        this.ready = false;
    }

    /**
     * Run shape detection on the current video frame.
     * @param {HTMLVideoElement} video
     * @param {HTMLCanvasElement} [debugCanvas] – optional canvas for debug vis
     * @returns {{ rectangles: object[], circles: object[] }}
     */
    detect (video, debugCanvas) {
        if (!this.ready) {
            console.warn('[ShapeDetector] not ready (.init not called)');
            return { rectangles: [], circles: [] };
        }
        if (typeof cv === 'undefined') {
            console.warn('[ShapeDetector] cv is undefined — OpenCV.js not loaded');
            return { rectangles: [], circles: [] };
        }
        if (!cv.Mat) {
            console.warn('[ShapeDetector] cv.Mat missing — OpenCV runtime not initialised');
            return { rectangles: [], circles: [] };
        }

        // Draw down-scaled frame
        this._ctx.drawImage(video, 0, 0, this._w, this._h);
        const src = cv.imread(this._canvas);

        let result;
        try {
            result = this._detectWithPaperIsolation(src, debugCanvas);
        } catch (e) {
            console.error('[ShapeDetector] detection error:', e);
            result = { rectangles: [], circles: [] };
        } finally {
            src.delete();
        }

        this.shapes = [...result.rectangles, ...result.circles];
        console.log('[ShapeDetector] found', result.rectangles.length,
                    'rects,', result.circles.length, 'circles');
        return result;
    }

    /* ================================================================
       Paper isolation — find the piece of paper first, then only
       detect shapes inside it.
       ================================================================ */

    _detectWithPaperIsolation (src, debugCanvas) {
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // --- Step 1: find the paper contour ---
        const paperCnt = this._findPaper(gray);

        let log = '';
        if (!paperCnt) {
            log += 'Paper: NOT FOUND (scanning full frame)  ';
            if (this.paperContour) this.paperContour.delete();
            this.paperContour = null;
        } else {
            const paperRect = cv.boundingRect(paperCnt);
            log += `Paper: ${paperRect.width}x${paperRect.height} @(${paperRect.x},${paperRect.y})  `;
            if (this.paperContour) this.paperContour.delete();
            this.paperContour = paperCnt;
        }

        // --- Step 2: create a mask that is white only inside the paper ---
        const mask = cv.Mat.zeros(this._h, this._w, cv.CV_8UC1);
        if (paperCnt) {
            const cnts = new cv.MatVector();
            cnts.push_back(paperCnt);
            cv.drawContours(mask, cnts, 0, new cv.Scalar(255), -1); // filled
            cnts.delete();
        } else {
            // No paper found → allow full frame (all-white mask)
            mask.setTo(new cv.Scalar(255));
        }

        // --- Step 3: blur the gray image, then apply mask ---
        const blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

        // --- Step 4: multi-strategy threshold within the masked region ---
        const strategies = [];

        // Strategy A – Adaptive threshold
        try {
            const thA = new cv.Mat();
            cv.adaptiveThreshold(blurred, thA, 255,
                cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5);
            cv.bitwise_and(thA, mask, thA);           // zero out everything outside paper
            const resA = this._extractShapes(thA, 'Adaptive', paperCnt, mask);
            log += `A(adapt): ${resA.rectangles.length}r ${resA.circles.length}c  `;
            strategies.push({ result: resA, thresh: thA });
        } catch (e) { log += 'A:err  '; }

        // Strategy B – Otsu
        try {
            const thB = new cv.Mat();
            cv.threshold(blurred, thB, 0, 255,
                         cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
            cv.bitwise_and(thB, mask, thB);
            const resB = this._extractShapes(thB, 'Otsu', paperCnt, mask);
            log += `B(otsu): ${resB.rectangles.length}r ${resB.circles.length}c  `;
            strategies.push({ result: resB, thresh: thB });
        } catch (e) { log += 'B:err  '; }

        // Strategy C – Canny
        try {
            const edges = new cv.Mat();
            cv.Canny(blurred, edges, 30, 100);
            const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
            cv.dilate(edges, edges, k);
            k.delete();
            cv.bitwise_and(edges, mask, edges);
            const resC = this._extractShapes(edges, 'Canny', paperCnt, mask);
            log += `C(canny): ${resC.rectangles.length}r ${resC.circles.length}c`;
            strategies.push({ result: resC, thresh: edges });
        } catch (e) { log += 'C:err'; }

        // Best = most shapes
        strategies.sort((a, b) => {
            const tA = a.result.rectangles.length + a.result.circles.length;
            const tB = b.result.rectangles.length + b.result.circles.length;
            return tB - tA;
        });

        const best = strategies[0] ||
                     { result: { rectangles: [], circles: [] }, thresh: null };

        // Debug canvas: show threshold + overlay detected shapes
        if (debugCanvas && best.thresh) {
            debugCanvas.width  = this._w;
            debugCanvas.height = this._h;

            // Convert grayscale threshold to color for colored overlay
            const color = new cv.Mat();
            cv.cvtColor(best.thresh, color, cv.COLOR_GRAY2RGBA);

            // Draw detected rectangles in blue
            for (const r of best.result.rectangles) {
                if (r.points && r.points.length >= 3) {
                    // Draw polygon
                    for (let i = 0; i < r.points.length; i++) {
                        const p1 = r.points[i];
                        const p2 = r.points[(i + 1) % r.points.length];
                        // Scale back to processing coords
                        const x1 = p1.x / this._sx, y1 = p1.y / this._sy;
                        const x2 = p2.x / this._sx, y2 = p2.y / this._sy;
                        cv.line(color, new cv.Point(x1, y1), new cv.Point(x2, y2),
                                new cv.Scalar(0, 150, 255, 255), 2);
                    }
                }
            }
            // Draw detected circles in green
            for (const c of best.result.circles) {
                if (c.points && c.points.length >= 3) {
                    for (let i = 0; i < c.points.length; i++) {
                        const p1 = c.points[i];
                        const p2 = c.points[(i + 1) % c.points.length];
                        const x1 = p1.x / this._sx, y1 = p1.y / this._sy;
                        const x2 = p2.x / this._sx, y2 = p2.y / this._sy;
                        cv.line(color, new cv.Point(x1, y1), new cv.Point(x2, y2),
                                new cv.Scalar(0, 255, 100, 255), 2);
                    }
                }
            }

            cv.imshow(debugCanvas, color);
            color.delete();
        }

        // Cleanup
        for (const s of strategies) { if (s.thresh) s.thresh.delete(); }
        gray.delete();
        blurred.delete();
        mask.delete();

        this.lastLog = log;
        console.log('[ShapeDetector]', log);
        return best.result;
    }

    /* ================================================================
       _findPaper – detect a piece of paper as the largest bright
       quadrilateral in the scene.
       ================================================================ */

    _findPaper (gray) {
        const imgArea = this._w * this._h;

        // 1. Threshold: paper is bright → keep bright pixels
        const bright = new cv.Mat();
        cv.threshold(gray, bright, 160, 255, cv.THRESH_BINARY);

        // 2. Close small gaps (text, lines on the paper)
        const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
        cv.morphologyEx(bright, bright, cv.MORPH_CLOSE, k);
        k.delete();

        // 3. Find contours
        const contours  = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(bright, contours, hierarchy,
                        cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let bestCnt  = null;
        let bestArea = 0;

        for (let i = 0; i < contours.size(); i++) {
            const cnt  = contours.get(i);
            const area = cv.contourArea(cnt);

            // Paper must be at least 5% of the image and no more than 95%
            if (area < imgArea * 0.05 || area > imgArea * 0.95) continue;

            const peri   = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.04 * peri, true);

            const verts = approx.rows;
            const rect  = cv.boundingRect(cnt);
            const extent = area / (rect.width * rect.height);

            // Accept quadrilateral-ish shapes (4-8 verts) with decent fill
            if (verts >= 4 && verts <= 8 && extent > 0.6 && area > bestArea) {
                bestArea = area;
                bestCnt  = cnt.clone();   // clone — original will be freed
            }
            approx.delete();
        }

        // Cleanup
        bright.delete();
        contours.delete();
        hierarchy.delete();

        if (bestCnt) {
            console.log('[ShapeDetector] paper found, area',
                        bestArea, '/', imgArea,
                        '(' + (bestArea / imgArea * 100).toFixed(1) + '%)');
        } else {
            console.log('[ShapeDetector] no paper detected');
        }
        return bestCnt;
    }

    /* ---------- contour extraction from a binary image ---------- */

    /**
     * Find shapes by detecting their INTERIOR regions (negative space).
     *
     * Instead of finding contours of pen strokes, we invert the binary
     * so that the white spaces *inside* each drawn shape become separate
     * white regions.  Shared walls between adjacent shapes (e.g. piano
     * keys drawn as one big rectangle with lines through it) act as
     * black barriers in the inverted image, naturally separating each
     * interior into its own contour.
     *
     * @param {cv.Mat} binaryImg – strokes=255, rest=0 (already masked to paper)
     * @param {string} label
     * @param {cv.Mat|null} paperCnt – paper contour (for center-in-paper test)
     * @param {cv.Mat|null} paperMask – 255 inside paper, 0 outside
     */
    _extractShapes (binaryImg, label, paperCnt, paperMask) {

        // Try multiple gap-closing strengths and pick the one finding the most shapes.
        // Hand-drawn piano keys have thin/broken dividing lines — stronger closing
        // bridges the gaps so each key interior becomes a separate white region.
        const kernelSizes = [3, 5, 7, 9];
        let bestResult = { rectangles: [], circles: [] };
        let bestCount  = 0;
        let bestMats   = [];   // track mats to clean up later

        for (const ks of kernelSizes) {
            // 1. Morphological CLOSE (dilate then erode) — bridges gaps in
            //    hand-drawn lines without permanently thickening them.
            const closed = new cv.Mat();
            const closeK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ks, ks));
            cv.morphologyEx(binaryImg, closed, cv.MORPH_CLOSE, closeK);
            closeK.delete();

            // Also dilate slightly after closing to ensure solid barriers
            const dilated = new cv.Mat();
            const dilK    = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
            cv.dilate(closed, dilated, dilK);
            dilK.delete();
            closed.delete();

            // 2. Invert: interiors → 255, strokes → 0
            const inverted = new cv.Mat();
            cv.bitwise_not(dilated, inverted);
            dilated.delete();

            // 3. Mask to paper region
            if (paperMask) {
                const shrunk  = new cv.Mat();
                const shrunkK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
                cv.erode(paperMask, shrunk, shrunkK);
                cv.bitwise_and(inverted, shrunk, inverted);
                shrunk.delete();
                shrunkK.delete();
            }

            // 4. Find contours
            const result = this._classifyContours(inverted, label + '.inv.k' + ks, paperCnt);
            const count  = result.rectangles.length + result.circles.length;

            console.log(`[Shapes ${label}] kernel=${ks} → ${result.rectangles.length}r ${result.circles.length}c`);

            if (count > bestCount) {
                bestCount  = count;
                bestResult = result;
                // clean up previous best mats
                for (const m of bestMats) m.delete();
                bestMats = [inverted];
            } else {
                inverted.delete();
            }
        }

        // 5. Also try DIRECT contour detection via hierarchy (RETR_CCOMP).
        //    This finds holes/children inside outer contours — works for
        //    shapes drawn as an outer boundary with inner regions.
        const directResult = this._extractShapesDirect(binaryImg, label + '.direct', paperCnt, paperMask);
        const directCount  = directResult.rectangles.length + directResult.circles.length;
        console.log(`[Shapes ${label}] direct hierarchy → ${directResult.rectangles.length}r ${directResult.circles.length}c`);

        // Merge: take whichever approach found more shapes
        if (directCount > bestCount) {
            bestResult = directResult;
        } else if (directCount > 0 && bestCount > 0) {
            // Merge unique shapes from direct that don't overlap with inverted results
            for (const ds of [...directResult.rectangles, ...directResult.circles]) {
                const isDupe = [...bestResult.rectangles, ...bestResult.circles].some(s => {
                    const dx = Math.abs(s.centerX - ds.centerX);
                    const dy = Math.abs(s.centerY - ds.centerY);
                    return dx < s.width * 0.4 && dy < s.height * 0.4;
                });
                if (!isDupe) {
                    if (ds.type === 'circle') bestResult.circles.push(ds);
                    else bestResult.rectangles.push(ds);
                }
            }
        }

        // Clean up
        for (const m of bestMats) m.delete();

        return bestResult;
    }

    /**
     * Direct contour detection using hierarchy (RETR_CCOMP).
     * Finds inner contours (holes) inside outer contours.
     * Works for piano keys drawn as one big rectangle subdivided by lines.
     */
    _extractShapesDirect (binaryImg, label, paperCnt, paperMask) {
        // Use the binary image directly (strokes are white)
        // RETR_CCOMP gives two-level hierarchy: outer contours and their direct children
        const contours  = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(binaryImg, contours, hierarchy,
                        cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

        const refArea    = paperCnt ? cv.contourArea(paperCnt) : (this._w * this._h);
        const rectangles = [];
        const circles    = [];

        // hierarchy: [next, prev, firstChild, parent] for each contour
        // We want contours that HAVE a parent (hierarchy[i*4+3] >= 0)
        // OR outer contours that have children (subdivided shapes)
        for (let i = 0; i < contours.size(); i++) {
            const h3 = hierarchy.intPtr(0, i)[3]; // parent index
            // Only process inner contours (holes inside strokes)
            if (h3 < 0) continue;  // skip outer contours

            const cnt  = contours.get(i);
            const area = cv.contourArea(cnt);

            if (area < refArea * 0.001 || area > refArea * 0.50) continue;

            const peri = cv.arcLength(cnt, true);
            if (peri < 15) continue;

            // Centre-in-paper check
            if (paperCnt) {
                const r  = cv.boundingRect(cnt);
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                if (cv.pointPolygonTest(paperCnt, new cv.Point(cx, cy), false) < 0)
                    continue;
            }

            // Edge-touch filter
            if (paperCnt) {
                let touchesEdge = false;
                for (let p = 0; p < cnt.data32S.length; p += 8) {
                    const px = cnt.data32S[p];
                    const py = cnt.data32S[p + 1];
                    const dist = cv.pointPolygonTest(paperCnt, new cv.Point(px, py), true);
                    if (Math.abs(dist) < 5) { touchesEdge = true; break; }
                }
                if (touchesEdge) continue;
            }

            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            const verts       = approx.rows;
            const circularity = (4 * Math.PI * area) / (peri * peri);
            const rect        = cv.boundingRect(cnt);
            const aspect      = rect.width / rect.height;
            approx.delete();

            console.log(`[Shape ${label}#${i}] v=${verts} circ=${circularity.toFixed(3)} asp=${aspect.toFixed(2)} area=${area.toFixed(0)} (child contour)`);

            const cntPoints = [];
            for (let p = 0; p < cnt.data32S.length; p += 2) {
                cntPoints.push({ x: cnt.data32S[p], y: cnt.data32S[p + 1] });
            }
            const simplePts = this._simplifyContour(cntPoints, 0.01 * peri);

            const isCircular = circularity >= 0.65 && aspect >= 0.5 && aspect <= 2.0;
            if (isCircular) {
                circles.push(this._scaleCircle(rect, area, simplePts));
            } else {
                rectangles.push(this._scaleRect(rect, area, simplePts));
            }
        }

        contours.delete(); hierarchy.delete();
        return { rectangles, circles };
    }

    /**
     * Classify contours from an inverted/processed image into shapes.
     * Shared logic used by _extractShapes for each kernel attempt.
     */
    _classifyContours (processedImg, label, paperCnt) {
        const contours  = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(processedImg, contours, hierarchy,
                        cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        const refArea    = paperCnt ? cv.contourArea(paperCnt) : (this._w * this._h);
        const rectangles = [];
        const circles    = [];

        for (let i = 0; i < contours.size(); i++) {
            const cnt  = contours.get(i);
            const area = cv.contourArea(cnt);

            if (area < refArea * 0.001 || area > refArea * 0.50) continue;

            const peri = cv.arcLength(cnt, true);
            if (peri < 15) continue;

            // Centre-in-paper check
            if (paperCnt) {
                const r  = cv.boundingRect(cnt);
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                if (cv.pointPolygonTest(paperCnt, new cv.Point(cx, cy), false) < 0)
                    continue;
            }

            // Edge-touch filter
            if (paperCnt) {
                let touchesEdge = false;
                for (let p = 0; p < cnt.data32S.length; p += 8) {
                    const px = cnt.data32S[p];
                    const py = cnt.data32S[p + 1];
                    const dist = cv.pointPolygonTest(paperCnt, new cv.Point(px, py), true);
                    if (Math.abs(dist) < 5) { touchesEdge = true; break; }
                }
                if (touchesEdge) continue;
            }

            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
            const verts       = approx.rows;
            const circularity = (4 * Math.PI * area) / (peri * peri);
            const rect        = cv.boundingRect(cnt);
            const extent      = area / (rect.width * rect.height);
            const aspect      = rect.width / rect.height;
            approx.delete();

            console.log(`[Shape ${label}#${i}] v=${verts} circ=${circularity.toFixed(3)} ext=${extent.toFixed(3)} asp=${aspect.toFixed(2)} area=${area.toFixed(0)}`);

            const cntPoints = [];
            for (let p = 0; p < cnt.data32S.length; p += 2) {
                cntPoints.push({ x: cnt.data32S[p], y: cnt.data32S[p + 1] });
            }
            const simplePts = this._simplifyContour(cntPoints, 0.01 * peri);

            const isCircular = circularity >= 0.65 && aspect >= 0.5 && aspect <= 2.0;
            if (isCircular) {
                circles.push(this._scaleCircle(rect, area, simplePts));
            } else {
                rectangles.push(this._scaleRect(rect, area, simplePts));
            }
        }

        contours.delete(); hierarchy.delete();
        return { rectangles, circles };
    }

    /* ---------- coordinate helpers ---------- */

    /** Return the paper contour scaled to the full video resolution (for overlay). */
    getPaperOutline () {
        if (!this.paperContour) return null;
        const cnt  = this.paperContour;
        const pts  = [];
        for (let i = 0; i < cnt.data32S.length; i += 2) {
            pts.push({
                x: cnt.data32S[i]     * this._sx,
                y: cnt.data32S[i + 1] * this._sy,
            });
        }
        return pts;
    }

    _scaleRect (r, area, contourPts) {
        return {
            type:    'rectangle',
            x:       r.x * this._sx,
            y:       r.y * this._sy,
            width:   r.width  * this._sx,
            height:  r.height * this._sy,
            centerX: (r.x + r.width / 2)  * this._sx,
            centerY: (r.y + r.height / 2) * this._sy,
            area:    area * this._sx * this._sy,
            points:  contourPts ? contourPts.map(p => ({ x: p.x * this._sx, y: p.y * this._sy })) : null,
        };
    }

    _scaleCircle (r, area, contourPts) {
        return {
            type:    'circle',
            centerX: (r.x + r.width / 2)  * this._sx,
            centerY: (r.y + r.height / 2) * this._sy,
            radius:  Math.max(r.width, r.height) / 2 * Math.max(this._sx, this._sy),
            x:       r.x * this._sx,
            y:       r.y * this._sy,
            width:   r.width  * this._sx,
            height:  r.height * this._sy,
            area:    area * this._sx * this._sy,
            points:  contourPts ? contourPts.map(p => ({ x: p.x * this._sx, y: p.y * this._sy })) : null,
        };
    }

    /** Simplify a polygon using Douglas-Peucker (Ramer) algorithm */
    _simplifyContour (points, epsilon) {
        if (points.length <= 4) return points;

        let maxDist = 0, maxIdx = 0;
        const first = points[0], last = points[points.length - 1];
        for (let i = 1; i < points.length - 1; i++) {
            const d = this._perpDist(points[i], first, last);
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }

        if (maxDist > epsilon) {
            const left  = this._simplifyContour(points.slice(0, maxIdx + 1), epsilon);
            const right = this._simplifyContour(points.slice(maxIdx), epsilon);
            return left.slice(0, -1).concat(right);
        }
        return [first, last];
    }

    _perpDist (p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
        return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
    }
}

window.ShapeDetector = ShapeDetector;
