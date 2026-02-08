/* =========================================================
   SongPlayer — Falling-notes Synthesia-style song learning
   =========================================================
   Parses MIDI files client-side using @tonejs/midi, drives a
   falling-notes animation synced to AudioContext time, and
   auto-plays notes through the AudioEngine.

   No backend required — loads MIDI files as static assets and
   reads a songs.json manifest for the song list.

   Usage:
     const sp = new SongPlayer(audioEngine);
     await sp.loadSong('twinkle.mid');
     sp.start();            // begins playback
     sp.stop();             // stops
     sp.draw(ctx, w, h);    // call every frame from render loop
   ========================================================= */
'use strict';

class SongPlayer {
    /**
     * @param {AudioEngine} audio     – reference to the app's AudioEngine
     * @param {string}      [midiDir='midi_songs'] – folder containing .mid files + songs.json
     */
    constructor(audio, midiDir = 'midi_songs') {
        this.audio = audio;
        this.midiDir = midiDir;

        /** Parsed note events from the MIDI file */
        this.events = [];
        /** Song metadata */
        this.songName = '';
        this.tempoBpm = 120;
        this.duration = 0;

        /** Playback state */
        this.playing = false;
        this._lastTickTime = 0;      // AudioContext.currentTime at last tick
        this.pauseTime = 0;          // elapsed time when paused
        this.elapsed = 0;            // current elapsed time in seconds
        this.speed = 1.0;            // playback speed multiplier (0.25 – 2.0)

        /** Set of event indices currently sounding */
        this.activeSet = new Set();
        /** Set of event indices already played */
        this.playedSet = new Set();

        /* ---- visual configuration ---- */
        /** How many seconds of look-ahead to show in the falling lane */
        this.lookAhead = 3.0;
        /** Speed scaling — pixels per second (calculated from canvas height) */
        this.pxPerSec = 0;

        /** Score tracking */
        this.hits = 0;
        this.misses = 0;
    }

    /* ==============================================================
       Song list — loaded from static songs.json
       ============================================================== */

    /** Fetch the list of available songs from the static manifest. */
    async fetchSongList() {
        const res = await fetch(this.midiDir + '/songs.json');
        const data = await res.json();
        return data || [];
    }

    /** Filter songs by name (client-side). */
    async searchSongs(query) {
        const all = await this.fetchSongList();
        if (!query) return all;
        const q = query.toLowerCase();
        return all.filter(s => s.name.toLowerCase().includes(q));
    }

    /* ==============================================================
       MIDI loading + client-side parsing
       ============================================================== */

    /** MIDI note number → name like 'C4' */
    static _noteName(midi) {
        const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const octave = Math.floor(midi / 12) - 1;
        return NAMES[midi % 12] + octave;
    }

    /**
     * Load and parse a MIDI file entirely in the browser.
     * Uses @tonejs/midi (global `Midi` class from CDN).
     * @param {string} filename – e.g. 'twinkle.mid'
     */
    async loadSong(filename) {
        this.stop();

        const url = this.midiDir + '/' + filename;
        const res = await fetch(url);
        if (!res.ok) throw new Error('Could not fetch ' + filename);

        const buf = await res.arrayBuffer();
        const midi = new Midi(buf);

        // Extract note events from all tracks
        this.events = [];
        for (let t = 0; t < midi.tracks.length; t++) {
            const track = midi.tracks[t];
            for (const note of track.notes) {
                this.events.push({
                    note: note.midi,
                    name: SongPlayer._noteName(note.midi),
                    start: note.time,
                    duration: note.duration,
                    velocity: Math.round(note.velocity * 127),
                    track: t,
                });
            }
        }

        // Sort by start time
        this.events.sort((a, b) => a.start - b.start);

        this.songName = filename.replace(/\.(mid|midi)$/i, '').replace(/[_-]/g, ' ');
        this.tempoBpm = midi.header.tempos.length > 0 ? Math.round(midi.header.tempos[0].bpm) : 120;
        this.duration = Math.max(...this.events.map(e => e.start + e.duration), 0);
        this.hits = 0;
        this.misses = 0;
        this.activeSet.clear();
        this.playedSet.clear();

        console.log(`[SongPlayer] loaded "${this.songName}" — ${this.events.length} notes, ${this.duration.toFixed(1)}s, ${this.tempoBpm} BPM`);
    }

    /* ==============================================================
       Playback control
       ============================================================== */

    start() {
        if (this.events.length === 0) return;
        if (!this.audio.ctx) return;

        this.playing = true;
        this._lastTickTime = this.audio.ctx.currentTime;
        if (this.pauseTime === 0) {
            this.elapsed = 0;
            this.activeSet.clear();
            this.playedSet.clear();
            this.hits = 0;
            this.misses = 0;
        }
        console.log('[SongPlayer] playback started at speed', this.speed);
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        this.pauseTime = this.elapsed;
        // Silence any notes that were triggered
        for (const i of this.activeSet) {
            this.audio.stop('song_' + i);
        }
        console.log('[SongPlayer] paused at', this.pauseTime.toFixed(2) + 's');
    }

    stop() {
        // Stop all notes that are currently sounding from song mode
        for (const i of this.activeSet) {
            this.audio.stop('song_' + i);
        }
        this.playing = false;
        this.pauseTime = 0;
        this.elapsed = 0;
        this.activeSet.clear();
        this.playedSet.clear();
    }

    /** Call from main loop to advance playback clock. */
    tick() {
        if (!this.playing || !this.audio.ctx) return;

        const now = this.audio.ctx.currentTime;
        const delta = now - this._lastTickTime;
        this._lastTickTime = now;
        this.elapsed += delta * this.speed;

        // Check if song is over
        if (this.elapsed > this.duration + 1.0) {
            this.playing = false;
            console.log(`[SongPlayer] song finished — hits: ${this.hits}, misses: ${this.misses}`);
            return;
        }

        // Track which notes are currently "active" (for visual highlighting only)
        for (let i = 0; i < this.events.length; i++) {
            if (this.playedSet.has(i)) continue;

            const ev = this.events[i];

            // Note start has arrived — mark as active (visual only, no audio)
            if (this.elapsed >= ev.start && !this.activeSet.has(i)) {
                this.activeSet.add(i);
            }

            // Note has ended — mark as played
            if (this.activeSet.has(i) && this.elapsed >= ev.start + ev.duration) {
                this.activeSet.delete(i);
                this.playedSet.add(i);
            }
        }
    }

    /**
     * Check if a played note matches an upcoming event (for scoring).
     * @param {string} noteName – e.g. 'C4'
     * @returns {boolean} true if the note matched an expected event
     */
    checkHit(noteName) {
        if (!this.playing) return false;

        const hitWindow = 0.3; // 300ms tolerance
        for (let i = 0; i < this.events.length; i++) {
            if (this.playedSet.has(i)) continue;
            const ev = this.events[i];
            if (ev.name !== noteName) continue;
            if (Math.abs(this.elapsed - ev.start) <= hitWindow) {
                this.hits++;
                this.playedSet.add(i);
                return true;
            }
        }
        return false;
    }

    /* ==============================================================
       Drawing — falling notes visualization
       ============================================================== */

    /**
     * Draw the falling-notes overlay on a canvas context.
     *
     * Notes fall from the top of a lane area toward a "hit line"
     * near the bottom.  Notes that have passed are dimmed.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cw – canvas width
     * @param {number} ch – canvas height
     * @param {Array}  assignedShapes – notes.assignedShapes for position mapping
     */
    draw(ctx, cw, ch, assignedShapes) {
        if (this.events.length === 0) return;

        this.pxPerSec = ch / this.lookAhead;

        // The "hit line" is at the bottom of the canvas (where shapes are)
        const hitLineY = ch - 40;

        // Draw hit line
        ctx.save();
        ctx.strokeStyle = 'rgba(108, 99, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, hitLineY);
        ctx.lineTo(cw, hitLineY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Build a note name -> x position map from assigned shapes
        const noteXMap = new Map();
        if (assignedShapes) {
            for (const s of assignedShapes) {
                if (s.instrument === 'piano') {
                    const cx = s.type === 'circle' ? s.centerX : s.x + s.width / 2;
                    const w = s.type === 'circle' ? s.radius * 2 : s.width;
                    noteXMap.set(s.note, { x: cx, w: w, isBlack: s.isBlack });
                }
            }
        }

        // Fallback: if no shapes are scanned, distribute notes across the canvas
        const allNoteNames = [...new Set(this.events.map(e => e.name))].sort();
        if (noteXMap.size === 0 && allNoteNames.length > 0) {
            const laneW = cw / allNoteNames.length;
            allNoteNames.forEach((name, i) => {
                noteXMap.set(name, {
                    x: laneW * i + laneW / 2,
                    w: laneW * 0.8,
                    isBlack: name.includes('#'),
                });
            });
        }

        // Draw each note event as a falling rectangle
        for (let i = 0; i < this.events.length; i++) {
            const ev = this.events[i];

            // Time until this note reaches the hit line
            const timeUntilHit = ev.start - this.elapsed;

            // Only draw notes within visible range
            if (timeUntilHit < -1.0 || timeUntilHit > this.lookAhead) continue;

            const info = noteXMap.get(ev.name);
            if (!info) continue;

            // Y position: hitLineY when timeUntilHit=0, above when positive
            const noteY = hitLineY - (timeUntilHit * this.pxPerSec);
            const noteH = Math.max(ev.duration * this.pxPerSec, 8);
            const noteTopY = noteY - noteH;
            const noteW = Math.min(info.w * 0.85, 50);
            const noteX = info.x - noteW / 2;

            const isActive = this.activeSet.has(i);
            const isDone = this.playedSet.has(i);

            // Color coding
            let fillColor, strokeColor;
            if (isDone) {
                fillColor = 'rgba(76, 175, 80, 0.25)';
                strokeColor = 'rgba(76, 175, 80, 0.4)';
            } else if (isActive) {
                fillColor = 'rgba(255, 87, 34, 0.7)';
                strokeColor = '#FF5722';
            } else {
                fillColor = info.isBlack
                    ? 'rgba(156, 39, 176, 0.55)'
                    : 'rgba(108, 99, 255, 0.55)';
                strokeColor = info.isBlack
                    ? 'rgba(156, 39, 176, 0.8)'
                    : 'rgba(108, 99, 255, 0.8)';
            }

            // Draw rounded rectangle
            const r = 4;
            ctx.beginPath();
            ctx.moveTo(noteX + r, noteTopY);
            ctx.lineTo(noteX + noteW - r, noteTopY);
            ctx.quadraticCurveTo(noteX + noteW, noteTopY, noteX + noteW, noteTopY + r);
            ctx.lineTo(noteX + noteW, noteY - r);
            ctx.quadraticCurveTo(noteX + noteW, noteY, noteX + noteW - r, noteY);
            ctx.lineTo(noteX + r, noteY);
            ctx.quadraticCurveTo(noteX, noteY, noteX, noteY - r);
            ctx.lineTo(noteX, noteTopY + r);
            ctx.quadraticCurveTo(noteX, noteTopY, noteX + r, noteTopY);
            ctx.closePath();

            ctx.fillStyle = fillColor;
            ctx.fill();
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = isActive ? 2.5 : 1.5;
            ctx.stroke();

            // Note name label (only if tall enough)
            if (noteH > 16) {
                ctx.font = 'bold 11px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = isDone ? 'rgba(255,255,255,0.4)' : '#fff';
                ctx.fillText(ev.name, noteX + noteW / 2, noteTopY + noteH / 2);
            }
        }

        // Draw progress bar at the top
        if (this.duration > 0) {
            const progress = Math.min(this.elapsed / this.duration, 1);
            const barH = 3;

            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fillRect(0, 0, cw, barH);

            ctx.fillStyle = 'rgba(108, 99, 255, 0.8)';
            ctx.fillRect(0, 0, cw * progress, barH);
        }

        // Song info text
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        const timeStr = this._formatTime(this.elapsed) + ' / ' + this._formatTime(this.duration);
        ctx.fillText(this.songName + '  ' + timeStr, 8, 8);

        ctx.restore();
    }

    /* ---------- helpers ---------- */

    _formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }
}

window.SongPlayer = SongPlayer;
