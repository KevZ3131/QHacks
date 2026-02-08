/* =========================================================
   NoteRecognizer — maps detected shapes → musical notes
   =========================================================
   • Rectangles → piano keys (white or black)
   • Circles    → drum pads
   Handles overlapping shapes (black keys sit on top of
   white keys) and resolves finger presses to the most
   specific (highest-priority, smallest) shape.
   ========================================================= */
'use strict';

class NoteRecognizer {
    constructor () {
        this.WHITE_NOTES = ['C','D','E','F','G','A','B'];
        this.BLACK_NOTES = ['C#','D#','F#','G#','A#'];
        this.DRUM_NAMES  = ['kick','snare','hihat','tom1','tom2','crash'];

        /** Assigned shapes with note labels.  Set by assignNotes(). */
        this.assignedShapes = [];
    }

    /* ---------- note assignment ---------- */

    /**
     * Takes raw rectangles & circles from ShapeDetector and
     * assigns musical notes / drum sounds to each one.
     * @param {{ rectangles: object[], circles: object[] }} shapes
     * @param {number} [octave=4]
     * @returns {object[]} – assigned shapes
     */
    assignNotes (shapes, octave = 4) {
        const { rectangles, circles } = shapes;
        const { whites, blacks } = this._classifyKeys(rectangles);

        // Sort left → right
        whites.sort((a, b) => a.centerX - b.centerX);
        blacks.sort((a, b) => a.centerX - b.centerX);
        const sortedCircles = [...circles].sort((a, b) => a.centerX - b.centerX);

        const assigned = [];

        // ---- white piano keys ----
        whites.forEach((k, i) => {
            const ni  = i % this.WHITE_NOTES.length;
            const oct = octave + Math.floor(i / this.WHITE_NOTES.length);
            assigned.push(Object.assign({}, k, {
                id:         'w' + i,
                note:       this.WHITE_NOTES[ni] + oct,
                instrument: 'piano',
                isBlack:    false,
                priority:   0,
            }));
        });

        // ---- black piano keys ----
        blacks.forEach((k, i) => {
            // Try to derive note from neighbouring white keys
            const note = this._deriveBlackNote(k, assigned.filter(s => !s.isBlack), i, octave);
            assigned.push(Object.assign({}, k, {
                id:         'b' + i,
                note:       note,
                instrument: 'piano',
                isBlack:    true,
                priority:   1,     // higher = always chosen over white key
            }));
        });

        // ---- drum pads ----
        sortedCircles.forEach((c, i) => {
            assigned.push(Object.assign({}, c, {
                id:         'd' + i,
                note:       this.DRUM_NAMES[i % this.DRUM_NAMES.length],
                instrument: 'drums',
                priority:   0,
            }));
        });

        this.assignedShapes = assigned;
        return assigned;
    }

    /* ---------- key classification ---------- */

    /**
     * Separate rectangles into white and black keys.
     *
     * Heuristic – in a hand-drawn piano:
     *   • White keys are taller / larger rectangles
     *   • Black keys are smaller and overlap at least one white key
     *
     * Falls back to area-based split when overlap check is insufficient.
     */
    _classifyKeys (rects) {
        if (rects.length <= 1) return { whites: rects, blacks: [] };

        // Sort descending by area
        const sorted = [...rects].sort((a, b) => b.area - a.area);
        const maxArea = sorted[0].area;

        // Threshold: anything < 65 % of the largest rectangle is a black key candidate
        const threshold = maxArea * 0.65;

        const whites = [];
        const blacks = [];

        for (const r of sorted) {
            if (r.area < threshold) {
                blacks.push(r);
            } else {
                whites.push(r);
            }
        }

        // If all ended up in one bucket, fall back to height-based split
        if (blacks.length === 0 && rects.length > 2) {
            const heights = rects.map(r => r.height).sort((a, b) => a - b);
            const medH    = heights[Math.floor(heights.length / 2)];
            return {
                whites: rects.filter(r => r.height >= medH * 0.75),
                blacks: rects.filter(r => r.height <  medH * 0.75),
            };
        }

        return { whites, blacks };
    }

    /**
     * Derive a black key's note from the white key to its left.
     * If there is a white key whose center is left of this black key,
     * we use that white key's note + '#'.
     */
    _deriveBlackNote (blackKey, whiteKeys, fallbackIdx, octave) {
        let leftWhite = null;
        for (const w of whiteKeys) {
            if (w.centerX < blackKey.centerX) {
                if (!leftWhite || w.centerX > leftWhite.centerX) leftWhite = w;
            }
        }
        if (leftWhite) {
            const base = leftWhite.note.replace(/\d+$/, '');
            const oct  = leftWhite.note.match(/\d+$/)?.[0] ?? octave;
            // Only add '#' if the note isn't already a sharp
            if (!base.includes('#')) return base + '#' + oct;
        }
        // Fallback: cycle through standard black notes
        const ni  = fallbackIdx % this.BLACK_NOTES.length;
        const oct = octave + Math.floor(fallbackIdx / this.BLACK_NOTES.length);
        return this.BLACK_NOTES[ni] + oct;
    }

    /* ---------- press detection ---------- */

    /**
     * Given an array of fingertip positions (normalised 0-1) and
     * the overlay canvas dimensions, return which shapes are pressed.
     *
     * Overlap resolution: black keys win over white keys;
     * smaller shapes win over larger shapes at the same priority.
     *
     * @param {Array<{x:number,y:number}>} tips – normalised coords
     * @param {number} cw – canvas (video) width in px
     * @param {number} ch – canvas (video) height in px
     * @param {number} [padPx=0] – extra hit-area padding in px
     * @returns {Array<{shape: object, tipX: number, tipY: number}>}
     */
    getPresses (tips, cw, ch, padPx = 0) {
        const pressed = [];

        for (const tip of tips) {
            const px = tip.x * cw;
            const py = tip.y * ch;

            // Collect every shape that contains this point
            const hits = this.assignedShapes.filter(s => {
                const pad = padPx;
                if (s.type === 'rectangle') {
                    return px >= s.x - pad && px <= s.x + s.width + pad &&
                           py >= s.y - pad && py <= s.y + s.height + pad;
                } else if (s.type === 'circle') {
                    const dx = px - s.centerX;
                    const dy = py - s.centerY;
                    return Math.hypot(dx, dy) <= s.radius + pad;
                }
                return false;
            });

            if (hits.length === 0) continue;

            // Sort: highest priority first, then smallest area
            hits.sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority;
                return a.area - b.area;
            });

            pressed.push({ shape: hits[0], tipX: px, tipY: py });
        }

        return pressed;
    }
}

window.NoteRecognizer = NoteRecognizer;
