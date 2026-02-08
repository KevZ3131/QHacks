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
            this.paperContour = null;
        } else {
            const paperRect = cv.boundingRect(paperCnt);
            log += `Paper: ${paperRect.width}x${paperRect.height} @(${paperRect.x},${paperRect.y})  `;
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
            const resA = this._extractShapes(thA, 'Adaptive', paperCnt);
            log += `A(adapt): ${resA.rectangles.length}r ${resA.circles.length}c  `;
            strategies.push({ result: resA, thresh: thA });
        } catch (e) { log += 'A:err  '; }

        // Strategy B – Otsu
        try {
            const thB = new cv.Mat();
            cv.threshold(blurred, thB, 0, 255,
                         cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
            cv.bitwise_and(thB, mask, thB);
            const resB = this._extractShapes(thB, 'Otsu', paperCnt);
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
            const resC = this._extractShapes(edges, 'Canny', paperCnt);
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

        // Debug canvas
        if (debugCanvas && best.thresh) {
            debugCanvas.width  = this._w;
            debugCanvas.height = this._h;
            cv.imshow(debugCanvas, best.thresh);
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
     * @param {cv.Mat} binaryImg – already masked to paper region
     * @param {string} label
     * @param {cv.Mat|null} paperCnt – paper contour (used for size filtering)
     */
    _extractShapes (binaryImg, label, paperCnt) {
        // Morphological close → merge broken pen strokes within a single shape.
        // Keep the kernel small (3×3) so adjacent shapes don't merge together.
        // No dilation — it bridges gaps between neighbouring keys.
        const closed = new cv.Mat();
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.morphologyEx(binaryImg, closed, cv.MORPH_CLOSE, kernel);

        const contours  = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(closed, contours, hierarchy,
                        cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // Reference area: use the paper area if we have it, else full image
        const refArea = paperCnt ? cv.contourArea(paperCnt) : (this._w * this._h);

        const rectangles = [];
        const circles    = [];

        for (let i = 0; i < contours.size(); i++) {
            const cnt  = contours.get(i);
            const area = cv.contourArea(cnt);

            // Too small (<0.5 % of paper) or too large (>60 % of paper → it's the paper itself)
            if (area < refArea * 0.005 || area > refArea * 0.60) continue;

            const peri = cv.arcLength(cnt, true);
            if (peri < 20) continue;

            // If we have a paper contour, reject shapes whose center is outside it
            if (paperCnt) {
                const rect  = cv.boundingRect(cnt);
                const cx    = rect.x + rect.width / 2;
                const cy    = rect.y + rect.height / 2;
                const inside = cv.pointPolygonTest(paperCnt,
                                   new cv.Point(cx, cy), false);
                if (inside < 0) continue; // center is outside paper
            }

            // Use a tighter epsilon (2%) so rectangle corners are preserved
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

            const verts       = approx.rows;
            const circularity = (4 * Math.PI * area) / (peri * peri);
            const rect        = cv.boundingRect(cnt);
            const extent      = area / (rect.width * rect.height);
            const aspect      = rect.width / rect.height;

            console.log(`[Shape ${label}#${i}] v=${verts} circ=${circularity.toFixed(3)} ext=${extent.toFixed(3)} asp=${aspect.toFixed(2)} area=${area.toFixed(0)}`);

            /*
             * Classification strategy — vertex count is the primary signal:
             *
             * CIRCLE:  high circularity (>= 0.75) AND aspect close to 1:1
             *          OR many vertices (>= 8) with circularity >= 0.60
             *
             * RECTANGLE: 4-6 vertices (tight approxPolyDP preserves corners)
             *            with low circularity (< 0.75) and decent fill (extent > 0.35)
             *
             * The key insight is: with a 2% epsilon, a rectangle keeps exactly
             * 4 vertices while a circle/ellipse has 8+ vertices.
             */

            // PRIMARY: vertex count is the strongest signal
            if (verts === 4 || verts === 5) {
                // Almost certainly a rectangle (4 corners, maybe 5 with a wobbly edge)
                if (extent > 0.30) {
                    rectangles.push(this._scaleRect(rect, area));
                }
            } else if (verts === 6 || verts === 7) {
                // Ambiguous zone: could be a rounded rect or an irregular circle
                if (circularity >= 0.75 && aspect >= 0.65 && aspect <= 1.55) {
                    circles.push(this._scaleCircle(rect, area));
                } else if (extent > 0.30) {
                    rectangles.push(this._scaleRect(rect, area));
                }
            } else if (verts >= 8) {
                // Many vertices → likely a circle/ellipse
                if (circularity >= 0.55 && aspect >= 0.45 && aspect <= 2.2) {
                    circles.push(this._scaleCircle(rect, area));
                } else if (extent > 0.30) {
                    // Very irregular but still filled → rectangle fallback
                    rectangles.push(this._scaleRect(rect, area));
                }
            }
            // verts < 4: skip (triangle or noise)

            approx.delete();
        }

        // Cleanup
        closed.delete(); kernel.delete();
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

    _scaleRect (r, area) {
        return {
            type:    'rectangle',
            x:       r.x * this._sx,
            y:       r.y * this._sy,
            width:   r.width  * this._sx,
            height:  r.height * this._sy,
            centerX: (r.x + r.width / 2)  * this._sx,
            centerY: (r.y + r.height / 2) * this._sy,
            area:    area * this._sx * this._sy,
        };
    }

    _scaleCircle (r, area) {
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
        };
    }
}

window.ShapeDetector = ShapeDetector;
