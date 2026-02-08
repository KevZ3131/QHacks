/**
 * NoteRecognizer - OCR-based musical-note recognition using Tesseract.js.
 *
 * Two modes:
 *   1. recognize(canvas) — single-region OCR (legacy, for cropped shapes)
 *   2. detectAll(canvas)  — full-frame OCR that returns ALL detected note
 *      labels with their bounding boxes.  This is the text-first seed source
 *      for the new shape-detection pipeline.
 *
 * Falls back to sequential default notes when OCR is unavailable or uncertain.
 */

const VALID_NOTES = [
    'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
    'Db', 'Eb', 'Gb', 'Ab', 'Bb'
];

const DEFAULT_SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export class NoteRecognizer {
    constructor() {
        this.worker = null;
        this.ready = false;
    }

    async init(onProgress) {
        try {
            if (onProgress) onProgress('Loading OCR engine…');

            // Wait for the Tesseract.js <script async> tag to load (max 15s)
            await new Promise((resolve, reject) => {
                if (typeof Tesseract !== 'undefined') { resolve(); return; }
                const t = setTimeout(() => reject(new Error('Tesseract script load timeout')), 15000);
                const poll = () => {
                    if (typeof Tesseract !== 'undefined') { clearTimeout(t); resolve(); return; }
                    setTimeout(poll, 200);
                };
                poll();
            });

            // Create the worker with a 20-second timeout so it doesn't hang forever
            const workerPromise = Tesseract.createWorker('eng', 1, {
                logger: m => {
                    if (m.status && onProgress) onProgress(`OCR: ${m.status}`);
                }
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Tesseract worker creation timed out (20 s)')), 20000)
            );

            this.worker = await Promise.race([workerPromise, timeoutPromise]);

            // Default to single-character mode; detectAll overrides per-call
            await this.worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGabcdefg#b',
                tessedit_pageseg_mode: '8'   // PSM.SINGLE_WORD
            });

            this.ready = true;
            if (onProgress) onProgress('OCR ready ✓');
        } catch (err) {
            console.warn('NoteRecognizer init failed (OCR optional):', err);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Full-frame OCR — returns all detected note labels with positions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Run OCR on the full canvas and return every recognized note label,
     * along with its bounding box and centroid.
     *
     * @param {HTMLCanvasElement} canvas — binarised / preprocessed frame
     * @returns {Promise<Array<{note, bbox, center}>>}
     *   note:   validated note string (e.g. 'C#')
     *   bbox:   {x, y, width, height} in canvas coordinates
     *   center: {x, y} centroid of the text bounding box
     */
    async detectAll(canvas) {
        if (!this.ready || !this.worker) return [];

        try {
            // Switch to sparse-text mode for full-page scanning
            await this.worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGabcdefg#b',
                tessedit_pageseg_mode: '11'   // PSM.SPARSE_TEXT — find as much text as possible
            });

            const { data } = await this.worker.recognize(canvas);

            // Restore single-word mode for future per-region calls
            await this.worker.setParameters({
                tessedit_pageseg_mode: '8'
            });

            const results = [];

            if (!data?.words?.length) return results;

            for (const word of data.words) {
                const note = this.parse(word.text);
                if (!note) continue;

                const bb = word.bbox;   // { x0, y0, x1, y1 }
                const bbox = {
                    x:      bb.x0,
                    y:      bb.y0,
                    width:  bb.x1 - bb.x0,
                    height: bb.y1 - bb.y0
                };

                // Reject implausibly large "words" (> 20% of frame)
                if (bbox.width * bbox.height > canvas.width * canvas.height * 0.20) continue;
                // Reject tiny noise
                if (bbox.width < 6 || bbox.height < 6) continue;

                results.push({
                    note,
                    bbox,
                    center: {
                        x: bbox.x + bbox.width  / 2,
                        y: bbox.y + bbox.height / 2
                    },
                    confidence: word.confidence ?? 0
                });
            }

            // Deduplicate notes that are very close together (OCR double-detections)
            return this._deduplicateLabels(results);
        } catch (err) {
            console.warn('detectAll OCR error:', err);
            return [];
        }
    }

    /** Merge labels whose centres are within mergeDist pixels. */
    _deduplicateLabels(labels, mergeDist = 30) {
        const kept = [];
        for (const lbl of labels) {
            let dominated = false;
            for (const k of kept) {
                const dx = lbl.center.x - k.center.x;
                const dy = lbl.center.y - k.center.y;
                if (Math.sqrt(dx * dx + dy * dy) < mergeDist) {
                    // Keep the one with higher confidence
                    if (lbl.confidence > k.confidence) {
                        kept[kept.indexOf(k)] = lbl;
                    }
                    dominated = true;
                    break;
                }
            }
            if (!dominated) kept.push(lbl);
        }
        return kept;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Single-region OCR (legacy / fallback)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt to recognize a note name from a cropped canvas region.
     * @param {HTMLCanvasElement} canvas - pre-processed crop
     * @returns {string|null} recognized note or null
     */
    async recognize(canvas) {
        if (!this.ready || !this.worker) return null;
        try {
            const { data } = await this.worker.recognize(canvas);
            return this.parse(data.text);
        } catch {
            return null;
        }
    }

    /**
     * Parse raw OCR text into a valid musical note name.
     */
    parse(text) {
        if (!text) return null;

        let cleaned = text.trim().toUpperCase().replace(/[^A-G#B]/g, '');
        if (!cleaned) return null;

        const letter = cleaned.charAt(0);
        if (!'ABCDEFG'.includes(letter)) return null;

        let note = letter;
        if (cleaned.length > 1) {
            const mod = cleaned.charAt(1);
            if (mod === '#') note += '#';
            // 'b' for flat — e.g. 'Bb', 'Eb'
            if (mod === 'B' && letter !== 'B' && cleaned.length === 2) {
                note += 'b';
            }
        }

        return VALID_NOTES.includes(note) ? note : (VALID_NOTES.includes(letter) ? letter : null);
    }

    /**
     * Return a sensible default note for a given shape index.
     */
    getDefaultNote(index) {
        return DEFAULT_SCALE[index % DEFAULT_SCALE.length];
    }

    destroy() {
        this.worker?.terminate();
    }
}
