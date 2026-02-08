/**
 * ShapeDetector - Detects drawn shapes on paper using OpenCV.js.
 * Finds rectangular contours, returns bounding rects and polygon points.
 */

export class ShapeDetector {
    constructor() {
        this.ready = false;
    }

    async init(onProgress) {
        if (onProgress) onProgress('Loading OpenCV…');

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('OpenCV load timeout (15 s)')), 15000);

            const check = () => {
                if (typeof cv !== 'undefined') {
                    try {
                        // Verify WASM runtime is initialised
                        if (cv.Mat) {
                            clearTimeout(timeout);
                            this.ready = true;
                            resolve();
                            return;
                        }
                    } catch { /* not ready yet */ }
                }
                setTimeout(check, 250);
            };
            check();
        });

        if (onProgress) onProgress('OpenCV ready ✓');
    }

    /**
     * Detect rectangular shapes drawn on the given canvas frame.
     * @param {HTMLCanvasElement} canvas - frame source
     * @returns {Array<Object>} detected shapes with rect, points, center, area
     */
    detect(canvas) {
        if (!this.ready) return [];

        const mats = [];                       // track for cleanup
        const mat = (m) => { mats.push(m); return m; };

        try {
            const src      = mat(cv.imread(canvas));
            const gray     = mat(new cv.Mat());
            const blurred  = mat(new cv.Mat());
            const thresh   = mat(new cv.Mat());
            const contours = mat(new cv.MatVector());
            const hier     = mat(new cv.Mat());
            const kernel   = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));

            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

            // Adaptive threshold handles uneven lighting on paper
            cv.adaptiveThreshold(
                blurred, thresh, 255,
                cv.ADAPTIVE_THRESH_GAUSSIAN_C,
                cv.THRESH_BINARY_INV, 19, 6
            );

            // Close small gaps in drawn lines, then dilate slightly
            cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);
            cv.dilate(thresh, thresh, kernel, new cv.Point(-1, -1), 1);

            cv.findContours(thresh, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            const frameArea = src.cols * src.rows;
            const MIN_AREA  = frameArea * 0.005;   // 0.5 % of frame (was 0.2%)
            const MAX_AREA  = frameArea * 0.20;    // 20 %

            const shapes = [];

            for (let i = 0; i < contours.size(); i++) {
                const cnt  = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area < MIN_AREA || area > MAX_AREA) continue;

                const peri   = cv.arcLength(cnt, true);
                const approx = mat(new cv.Mat());
                cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

                const verts = approx.rows;
                if (verts < 4 || verts > 8) continue;  // tighter: 4-8 sides only

                const rect   = cv.boundingRect(cnt);
                const aspect = rect.width / rect.height;
                if (aspect < 0.25 || aspect > 4.0) continue;  // tighter ratio

                // Minimum absolute dimension: ignore tiny noise contours
                if (rect.width < 25 || rect.height < 25) continue;

                // Solidity check: area vs convex hull area (hand-drawn shapes ≥ 0.6)
                const hull = mat(new cv.Mat());
                cv.convexHull(cnt, hull);
                const hullArea = cv.contourArea(hull);
                const solidity = hullArea > 0 ? area / hullArea : 0;
                if (solidity < 0.6) continue;

                // Rectangularity: area vs bounding rect area (drawn rects ≥ 0.45)
                const rectArea   = rect.width * rect.height;
                const rectangularity = area / rectArea;
                if (rectangularity < 0.45) continue;

                // Collect polygon vertices
                const points = [];
                for (let j = 0; j < verts; j++) {
                    points.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
                }

                shapes.push({
                    rect,
                    points,
                    area,
                    center: {
                        x: rect.x + rect.width  / 2,
                        y: rect.y + rect.height / 2
                    }
                });
            }

            // Sort: top-to-bottom rows, then left-to-right within a row
            shapes.sort((a, b) => {
                const rowThresh = Math.min(a.rect.height, b.rect.height) * 0.5;
                if (Math.abs(a.center.y - b.center.y) < rowThresh) {
                    return a.center.x - b.center.x;
                }
                return a.center.y - b.center.y;
            });

            shapes.forEach((s, idx) => { s.id = `shape_${idx}`; });
            return shapes;

        } finally {
            // Release ALL OpenCV mats to prevent memory leaks
            for (const m of mats) {
                try { m.delete(); } catch { /* already freed */ }
            }
        }
    }

    /**
     * Crop and preprocess a region for OCR.
     * Scales up and binarises to improve Tesseract accuracy.
     */
    extractRegion(canvas, rect, padding = 10) {
        const x = Math.max(0, rect.x + padding);
        const y = Math.max(0, rect.y + padding);
        const w = Math.min(rect.width  - padding * 2, canvas.width  - x);
        const h = Math.min(rect.height - padding * 2, canvas.height - y);
        if (w <= 4 || h <= 4) return null;

        const tmp = document.createElement('canvas');
        const ctx = tmp.getContext('2d');
        // Scale up for better OCR
        const scale = Math.max(2, 64 / Math.min(w, h));
        tmp.width  = Math.round(w * scale);
        tmp.height = Math.round(h * scale);

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);

        // Binarise: high-contrast black text on white bg
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
}
