import { SONGS } from './songs.js';

export class SongPlayer {
    constructor(audioEngine) {
        this.audio = audioEngine;
        this.activeSong = null;
        this.startTime = 0;
        this.isPlaying = false;
        this.noteQueue = []; // notes that define the song
        this.visualQueue = []; // notes currently falling

        // Settings
        this.fallSpeed = 200; // pixels per second
        this.lookahead = 3000; // ms to see into the future (window height basically)
    }

    start(songId) {
        const songData = SONGS.find(s => s.id === songId);
        if (!songData) {
            console.error('Song not found:', songId);
            return;
        }

        this.activeSong = songData;
        this.noteQueue = songData.notes.map(n => ({
            ...n,
            hasPlayed: false,
            // Convert beat start/duration to milliseconds
            timeMs: n.s * (60000 / songData.bpm),
            durMs: n.d * (60000 / songData.bpm)
        }));

        // Sort by time just in case
        this.noteQueue.sort((a, b) => a.timeMs - b.timeMs);

        this.startTime = performance.now() + 2000; // 2 sec delay start
        this.isPlaying = true;
        console.log(`[SongPlayer] Started: ${songData.title}`);
    }

    stop() {
        this.isPlaying = false;
        this.activeSong = null;
        this.noteQueue = [];
    }

    update(currentTime) {
        if (!this.isPlaying) return;

        const songTime = currentTime - this.startTime;

        // 1. Check for notes that should play (audio)
        // Actually, in Guitar Hero style, the USER plays the note.
        // But maybe we should play a guide melody? 
        // Or just let the user see them. 
        // For now, let's just do visuals. If the user hits it, great.

        // However, we might want to discard notes from the visual queue when they pass the bottom
    }

    /**
     * Draw falling notes
     * @param {CanvasRenderingContext2D} ctx 
     * @param {Array} assignedShapes - the detected keys from main.js
     * @param {number} cvsWidth 
     * @param {number} cvsHeight 
     */
    draw(ctx, assignedShapes, cvsWidth, cvsHeight) {
        if (!this.isPlaying || !this.activeSong) return;

        const now = performance.now();
        const songTime = now - this.startTime;

        // Window of time we want to render: [songTime, songTime + lookahead]
        // We look through the entire noteQueue (or optimize index)

        // We need a helper to find the target X/Width for a note
        // assignedShapes has { id, x, y, width, height, note, ... }

        for (const note of this.noteQueue) {
            // If note is too far in past, skip (or remove)
            if (note.timeMs + note.durMs < songTime - 500) continue;

            // If note is too far in future, stop (sorted list)
            // But we display ahead of time.
            // visual start Y is determined by (noteTime - songTime)

            // Wait, we want the note to HIT the target at timeMs.
            // Distance = Speed * Time
            // Y_target = keyboard_y
            // Y_current = Y_target - (Time_Until_Hit * Speed)

            // If Time_Until_Hit is 0 (now), Y_current = Y_target
            // If Time_Until_Hit is 2s, Y_current = Y_target - 2 * Speed

            const timeUntilHit = (note.timeMs - songTime) / 1000; // seconds

            // If it's way down the screen, skip
            // e.g. if timeUntilHit is -5 (5 seconds ago), it's gone.

            // Find target shape
            const targetShape = this.findBestShape(note.n, assignedShapes);
            if (!targetShape) continue; // No keys to play on?

            const keyY = targetShape.y; // Top of the key
            const dist = timeUntilHit * this.fallSpeed;
            const y = keyY - dist;

            // Calculate height of the block based on duration
            // durMs -> length in px
            const blockHeight = (note.durMs / 1000) * this.fallSpeed;

            // The "bottom" of the block hits at timeMs.
            // So we draw the rect from (y - blockHeight) to y?

            // Wait.
            // At t=0, note should start playing.
            // This means the BLOCK's BOTTOM EDGE should define the "start" of the note.
            // So the bottom edge is at `y`.
            // The top edge is at `y - blockHeight`.

            const bottomY = y;
            const topY = y - blockHeight;

            // Cull if off screen
            if (bottomY < 0) continue; // Above screen
            if (topY > cvsHeight) continue; // Below screen

            // Draw
            ctx.fillStyle = this.getNoteColor(note.n);
            ctx.globalAlpha = 0.8;

            // Make it slightly narrower than the key
            const pad = 4;
            const x = targetShape.x + pad;
            const w = Math.max(4, targetShape.width - pad * 2);

            // Drawing the rect
            // rect(x, topY, w, blockHeight)
            ctx.fillRect(x, topY, w, blockHeight);

            // Add a border
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, topY, w, blockHeight);

            ctx.globalAlpha = 1.0;

            // Debug text
            // ctx.fillStyle = 'white';
            // ctx.font = '10px sans-serif';
            // ctx.fillText(note.n, x, topY + 12);
        }
    }

    findBestShape(targetNote, shapes) {
        // 1. constant comparison helper
        const parse = (n) => {
            const match = n.match(/^([A-Ga-g]#?)(\d+)$/);
            if (!match) return null;
            return { raw: n, base: match[1], oct: parseInt(match[2]), val: this.midiVal(match[1], match[2]) };
        };

        const target = parse(targetNote);
        if (!target) return null;

        // Filter only rectangle keys (not drum pads)
        const keys = shapes.filter(s => s.type === 'rectangle');

        if (keys.length === 0) return null;

        // Try exact match
        let match = keys.find(s => s.note === targetNote);
        if (match) return match;

        // Try finding closest note
        let best = null;
        let minDiff = Infinity;

        for (const s of keys) {
            const sNote = parse(s.note);
            if (!sNote) continue;

            const diff = Math.abs(sNote.val - target.val);
            if (diff < minDiff) {
                minDiff = diff;
                best = s;
            }
        }

        return best;
    }

    midiVal(base, oct) {
        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const idx = notes.indexOf(base);
        return (parseInt(oct) + 1) * 12 + idx;
    }

    getNoteColor(note) {
        // Simple color mapping based on note name (ignore octave)
        const base = note.replace(/\d+/, '');
        const colors = {
            'C': '#FF5252', 'C#': '#FF4081',
            'D': '#E040FB', 'D#': '#7C4DFF',
            'E': '#536DFE',
            'F': '#448AFF', 'F#': '#40C4FF',
            'G': '#18FFFF', 'G#': '#64FFDA',
            'A': '#69F0AE', 'A#': '#B2FF59',
            'B': '#EEFF41'
        };
        return colors[base] || '#ffffff';
    }
}
