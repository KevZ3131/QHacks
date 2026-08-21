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
        const customAssignments = this.assignedShapes.filter(shape => shape.customNote);
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

        this._restoreCustomAssignments(assigned, customAssignments);
        this.assignedShapes = assigned;
        return assigned;
    }

    setShapeNote (shapeId, note) {
        const shape = this.assignedShapes.find(candidate => candidate.id === shapeId);
        if (!shape) return false;
        shape.note = note;
        shape.customNote = true;
        return true;
    }

    removeShape (shapeId) {
        const before = this.assignedShapes.length;
        this.assignedShapes = this.assignedShapes.filter(shape => shape.id !== shapeId);
        return this.assignedShapes.length !== before;
    }

    clear () {
        this.assignedShapes = [];
    }

    _restoreCustomAssignments (assigned, previous) {
        const used = new Set();
        for (const shape of assigned) {
            let best = null;
            let bestScore = Infinity;

            previous.forEach((candidate, index) => {
                if (used.has(index) || candidate.type !== shape.type ||
                    Boolean(candidate.isBlack) !== Boolean(shape.isBlack)) return;

                const distance = Math.hypot(
                    candidate.centerX - shape.centerX,
                    candidate.centerY - shape.centerY
                );
                const scale = Math.max(
                    shape.width || shape.radius * 2 || 1,
                    shape.height || shape.radius * 2 || 1,
                    candidate.width || candidate.radius * 2 || 1,
                    candidate.height || candidate.radius * 2 || 1
                );
                const sameIdBonus = candidate.id === shape.id ? 0.35 : 0;
                const score = distance / scale - sameIdBonus;
                if (score < bestScore) {
                    best = { candidate, index };
                    bestScore = score;
                }
            });

            if (best && bestScore <= 1.25) {
                shape.note = best.candidate.note;
                shape.customNote = true;
                used.add(best.index);
            }
        }
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

        const median = values => {
            const sorted = [...values].sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[middle] :
                (sorted[middle - 1] + sorted[middle]) / 2;
        };
        const medianArea = median(rects.map(rect => rect.area));
        const medianHeight = median(rects.map(rect => rect.height));

        // A black key must be clearly shorter AND smaller. Requiring both
        // avoids treating a perspective-distorted white key as black.
        const blacks = rects.filter(rect =>
            rect.height < medianHeight * 0.78 && rect.area < medianArea * 0.72
        );
        if (blacks.length === 0 || blacks.length >= rects.length / 2) {
            return { whites: [...rects], blacks: [] };
        }

        const blackSet = new Set(blacks);
        return {
            whites: rects.filter(rect => !blackSet.has(rect)),
            blacks,
        };
    }

    /**
     * Derive a black key's note from the white key to its left.
     * If there is a white key whose center is left of this black key,
     * we use that white key's note + '#'.
     */
    _deriveBlackNote (blackKey, whiteKeys, fallbackIdx, octave) {
        const sharpable = new Set(['C', 'D', 'F', 'G', 'A']);
        const leftWhites = whiteKeys
            .filter(w => w.centerX < blackKey.centerX)
            .sort((a, b) => b.centerX - a.centerX);

        // E and B do not have black keys above them. If a contour is slightly
        // misplaced, use the closest valid black-key boundary to avoid a
        // silent E# or B# note.
        for (const white of leftWhites) {
            const base = white.note.replace(/\d+$/, '');
            const oct = white.note.match(/\d+$/)?.[0] ?? octave;
            if (sharpable.has(base)) return base + '#' + oct;
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
                return this._contains(s, px, py, padPx);
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

    _contains (shape, px, py, pad) {
        if (shape.points && shape.points.length >= 3) {
            let inside = false;
            const points = shape.points;
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                const a = points[i];
                const b = points[j];
                if ((a.y > py) !== (b.y > py) &&
                    px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) {
                    inside = !inside;
                }
            }
            if (inside) return true;
            if (pad <= 0) return false;
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                if (this._distanceToSegment(px, py, points[j], points[i]) <= pad) return true;
            }
            return false;
        }

        if (shape.type === 'circle') {
            return Math.hypot(px - shape.centerX, py - shape.centerY) <= shape.radius + pad;
        }
        return px >= shape.x - pad && px <= shape.x + shape.width + pad &&
               py >= shape.y - pad && py <= shape.y + shape.height + pad;
    }

    _distanceToSegment (px, py, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared === 0) return Math.hypot(px - a.x, py - a.y);
        const ratio = ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared;
        const t = Math.max(0, Math.min(1, ratio));
        return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    }
}

window.NoteRecognizer = NoteRecognizer;
