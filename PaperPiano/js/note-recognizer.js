/**
 * NoteRecognizer - OCR-based musical-note recognition using Tesseract.js.
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

            // Tesseract is loaded globally via <script>
            if (typeof Tesseract === 'undefined') {
                console.warn('Tesseract.js not loaded; OCR unavailable');
                return;
            }

            this.worker = await Tesseract.createWorker('eng', 1, {
                logger: m => {
                    if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
                        if (onProgress) onProgress(`OCR: ${m.status}`);
                    }
                }
            });

            await this.worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGabcdefg#',
                tessedit_pageseg_mode: '8'   // PSM.SINGLE_WORD
            });

            this.ready = true;
            if (onProgress) onProgress('OCR ready ✓');
        } catch (err) {
            console.warn('NoteRecognizer init failed (OCR optional):', err);
        }
    }

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

        let cleaned = text.trim().toUpperCase().replace(/[^A-G#]/g, '');
        if (!cleaned) return null;

        const letter = cleaned.charAt(0);
        if (!'ABCDEFG'.includes(letter)) return null;

        let note = letter;
        if (cleaned.length > 1 && cleaned.charAt(1) === '#') {
            note += '#';
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
