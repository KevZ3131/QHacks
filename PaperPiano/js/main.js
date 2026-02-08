/**
 * PaperPiano - Main application orchestrator.
 *
 * Flow:
 *   1. Load → camera + all ML models in parallel
 *   2. Ready → live camera feed, user can scan
 *   3. Scanning → freeze frame, detect shapes, run OCR
 *   4. Editing → shapes visible, user edits note assignments
 *   5. Playing → hand tracking active, fingertip-in-shape → note plays
 *
 * Graceful degradation:
 *   - OpenCV fails → "Add Demo Shapes" still works
 *   - Tesseract fails → default note assignment (C D E F G A B)
 *   - MediaPipe fails → touch / click to play
 */

import { AudioEngine } from './audio-engine.js';
import { ShapeDetector } from './shape-detector.js';
import { NoteRecognizer } from './note-recognizer.js';
import { HandTracker } from './hand-tracker.js';

// ── Shape colours ──────────────────────────────────────────────────────────────
const SHAPE_COLORS = [
    '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB',
    '#0ABDE3', '#A29BFE', '#FD79A8', '#00B894',
    '#6C5CE7', '#E17055', '#00CEC9', '#FDCB6E'
];

// ── Hand-skeleton connections for drawing ──────────────────────────────────────
const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],           // index
    [5, 9], [9, 10], [10, 11], [11, 12],      // middle
    [9, 13], [13, 14], [14, 15], [15, 16],    // ring
    [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
    [0, 17]                              // palm base
];

class PaperPianoApp {
    constructor() {
        // Modules
        this.audio = new AudioEngine();
        this.shapes_ = new ShapeDetector();
        this.ocr = new NoteRecognizer();
        this.hands = new HandTracker();

        // State
        this.shapes = [];          // detected / manually added shapes
        this.activeShapes = new Set();   // currently pressed shape IDs
        this.state = 'loading';   // loading | ready | scanning | playing
        this.lastHandRes = null;
        this.animId = null;
        this.mirrored = false;       // true when using front-facing camera

        // FPS counter
        this._fpsFrames = 0;
        this._fpsLast = 0;
        this.fps = 0;

        // DOM refs (bound in bindElements)
        this.video = null;
        this.overlay = null;
        this.octx = null;
        this.proc = null;
        this.pctx = null;
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────────
    async init() {
        this.bindElements();
        this.bindEvents();

        const results = await Promise.allSettled([
            this.initCamera(),
            this.shapes_.init(s => this.status(s)),
            this.ocr.init(s => this.status(s)),
            this.hands.init(s => this.status(s))
        ]);

        const [cam, ocv, ocrRes, handsRes] = results;

        if (cam.status === 'rejected') {
            this.showError('Camera access denied. Allow camera and reload the page.');
            return;
        }

        // Log which optional modules failed
        if (ocv.status === 'rejected') console.warn('OpenCV unavailable:', ocv.reason);
        if (ocrRes.status === 'rejected') console.warn('OCR unavailable:', ocrRes.reason);
        if (handsRes.status === 'rejected') console.warn('Hand tracking unavailable:', handsRes.reason);

        this.hideLoading();
        this.state = 'ready';
        this.status(
            this.shapes_.ready
                ? 'Ready — point at paper and tap Scan.'
                : 'OpenCV unavailable — try Demo instead.'
        );
        this.startRenderLoop();
    }

    // ── DOM binding ────────────────────────────────────────────────────────────
    bindElements() {
        this.video = document.getElementById('video');
        this.overlay = document.getElementById('overlay-canvas');
        this.octx = this.overlay.getContext('2d');
        this.proc = document.getElementById('processing-canvas');
        this.pctx = this.proc.getContext('2d');
    }

    bindEvents() {
        const $ = id => document.getElementById(id);

        // Primary action button — dispatches based on current state
        $('btn-primary').addEventListener('click', () => {
            if (this.state === 'playing') {
                this.exitPlayMode();
            } else if (this.shapes.length > 0) {
                this.enterPlayMode();
            } else {
                this.scanShapes();
            }
        });

        $('btn-demo').addEventListener('click', () => this.addDemoShapes());
        $('btn-clear').addEventListener('click', () => this.clearShapes());
        $('btn-close-editor').addEventListener('click', () => this.closeNoteEditor());

        // Instrument picker — segmented toggle
        for (const btn of document.querySelectorAll('.inst-btn')) {
            btn.addEventListener('click', () => {
                document.querySelector('.inst-btn.active')?.classList.remove('active');
                btn.classList.add('active');
                this.audio.setPreset(btn.dataset.inst);
            });
        }

        // Bottom sheet backdrop tap to close
        document.querySelector('.sheet-backdrop')?.addEventListener('click', () => {
            this.closeNoteEditor();
        });

        // Canvas interaction (click to edit notes, or play via click/touch)
        this.overlay.addEventListener('click', e => this.onCanvasClick(e));
        this.overlay.addEventListener('touchstart', e => this.onCanvasTouch(e), { passive: false });
        this.overlay.addEventListener('touchmove', e => this.onCanvasTouch(e), { passive: false });
        this.overlay.addEventListener('touchend', e => { e.preventDefault(); this.releaseAllTouch(); }, { passive: false });
        this.overlay.addEventListener('touchcancel', e => { e.preventDefault(); this.releaseAllTouch(); }, { passive: false });

        // Resume AudioContext on first user gesture
        const resumeAudio = () => { this.audio.init(); this.audio.resume(); };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('touchstart', resumeAudio, { once: true });
    }

    // ── Camera ─────────────────────────────────────────────────────────────────
    async initCamera() {
        this.status('Requesting camera…');

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 30, min: 15 },
                    facingMode: 'environment'
                },
                audio: false
            });
            this.mirrored = false;
        } catch {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 30, min: 15 }
                },
                audio: false
            });
            this.mirrored = true;
        }

        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings?.() || {};
        if (settings.facingMode === 'user') this.mirrored = true;
        if (!settings.facingMode) this.mirrored = true;

        this.video.srcObject = stream;
        await this.video.play();

        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        this.overlay.width = vw;
        this.overlay.height = vh;
        this.proc.width = vw;
        this.proc.height = vh;

        this.status('Camera ready');
    }

    // ── Scanning ───────────────────────────────────────────────────────────────
    async scanShapes() {
        if (!this.shapes_.ready) {
            this.status('OpenCV is not loaded. Use "Demo Shapes" instead.');
            return;
        }
        this.state = 'scanning';
        this.status('Scanning for shapes…');

        // Draw current video frame to hidden processing canvas
        this.pctx.drawImage(this.video, 0, 0);

        const found = this.shapes_.detect(this.proc);

        if (found.length === 0) {
            this.status('No shapes found. Draw dark-outlined rectangles on white paper.');
            this.state = 'ready';
            return;
        }

        this.status(`Found ${found.length} shape(s) — running OCR…`);

        for (let i = 0; i < found.length; i++) {
            const s = found[i];
            s.color = SHAPE_COLORS[i % SHAPE_COLORS.length];
            s.isActive = false;

            // Try OCR
            const crop = this.shapes_.extractRegion(this.proc, s.rect);
            if (crop && this.ocr.ready) {
                const note = await this.ocr.recognize(crop);
                s.note = note || this.ocr.getDefaultNote(i);
            } else {
                s.note = this.ocr.getDefaultNote(i);
            }
        }

        this.shapes = found;
        this.state = 'ready';
        this.updateUI();
        this.status(`${found.length} shape(s) found. Tap a shape to edit, then Play.`);
    }

    // ── Demo shapes (fallback / instant test) ──────────────────────────────────
    addDemoShapes() {
        const W = this.overlay.width;
        const H = this.overlay.height;

        const notes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        const gap = 4;
        const kw = Math.floor((W - gap * (notes.length + 1)) / notes.length);
        const kh = Math.floor(H * 0.28);
        const startY = Math.floor(H * 0.65);
        const startX = Math.floor((W - (kw * notes.length + gap * (notes.length - 1))) / 2);

        this.shapes = notes.map((note, i) => ({
            id: `shape_${i}`,
            rect: { x: startX + i * (kw + gap), y: startY, width: kw, height: kh },
            points: [],
            note,
            color: SHAPE_COLORS[i % SHAPE_COLORS.length],
            center: { x: startX + i * (kw + gap) + kw / 2, y: startY + kh / 2 },
            isActive: false,
            area: kw * kh
        }));

        this.updateUI();
        this.status('Demo piano ready. Press Play!');
    }

    // ── Play / Stop mode ───────────────────────────────────────────────────────
    enterPlayMode() {
        if (!this.shapes.length) return;
        this.audio.init();
        this.audio.resume();
        this.state = 'playing';
        this.updateUI();

        if (this.hands.ready) {
            this.status('Play mode — touch the shapes!');
        } else {
            this.status('Play mode — tap shapes to play.');
        }
    }

    exitPlayMode() {
        this.audio.noteOffAll();
        this.activeShapes.clear();
        this.shapes.forEach(s => s.isActive = false);
        this.state = 'ready';
        this.updateUI();
        this.status('Stopped. Tap a shape to edit, or press Play.');
    }

    clearShapes() {
        this.audio.noteOffAll();
        this.activeShapes.clear();
        this.shapes = [];
        this.state = 'ready';
        this.updateUI();
        this.status('Cleared. Scan paper or try Demo.');
    }

    // ── Unified UI state ────────────────────────────────────────────────────────
    updateUI() {
        const btn = document.getElementById('btn-primary');
        const label = document.getElementById('primary-label');
        const demo = document.getElementById('btn-demo');
        const clear = document.getElementById('btn-clear');

        // Primary button state
        btn.classList.remove('state-scan', 'state-play', 'state-stop');
        btn.disabled = false;

        if (this.state === 'playing') {
            btn.classList.add('state-stop');
            label.textContent = 'Stop';
        } else if (this.shapes.length > 0) {
            btn.classList.add('state-play');
            label.textContent = 'Play';
        } else {
            btn.classList.add('state-scan');
            label.textContent = 'Scan';
        }

        // Secondary buttons
        const hasShapes = this.shapes.length > 0;
        const isPlaying = this.state === 'playing';

        // Demo: only when no shapes and not playing
        if (!hasShapes && !isPlaying) {
            demo.classList.remove('hidden');
        } else {
            demo.classList.add('hidden');
        }

        // Clear: only when shapes exist
        if (hasShapes) {
            clear.classList.remove('hidden');
        } else {
            clear.classList.add('hidden');
        }
    }

    // ── Canvas interaction ─────────────────────────────────────────────────────
    onCanvasClick(e) {
        const pos = this.canvasPos(e.clientX, e.clientY);
        const shape = this.shapeAt(pos.x, pos.y);
        if (!shape) return;

        if (this.state === 'playing') {
            // Quick click-to-play
            this.audio.init();
            this.audio.noteOn(shape.id, shape.note);
            shape.isActive = true;
            setTimeout(() => {
                this.audio.noteOff(shape.id);
                shape.isActive = false;
            }, 250);
        } else {
            this.openNoteEditor(shape.id);
        }
    }

    onCanvasTouch(e) {
        e.preventDefault();
        if (this.state !== 'playing') return;

        const nowActive = new Set();
        for (const touch of e.touches) {
            const pos = this.canvasPos(touch.clientX, touch.clientY);
            const shape = this.shapeAt(pos.x, pos.y);
            if (shape) {
                nowActive.add(shape.id);
                if (!this.activeShapes.has(shape.id)) {
                    this.audio.noteOn(shape.id, shape.note);
                }
                shape.isActive = true;
            }
        }
        // Release shapes not in current touches
        for (const id of this.activeShapes) {
            if (!nowActive.has(id)) {
                this.audio.noteOff(id);
                const s = this.shapes.find(sh => sh.id === id);
                if (s) s.isActive = false;
            }
        }
        this.activeShapes = nowActive;
    }

    releaseAllTouch() {
        if (this.state !== 'playing') return;
        this.audio.noteOffAll();
        this.shapes.forEach(s => s.isActive = false);
        this.activeShapes.clear();
    }

    canvasPos(cx, cy) {
        const r = this.overlay.getBoundingClientRect();
        let x = (cx - r.left) * (this.overlay.width / r.width);
        const y = (cy - r.top) * (this.overlay.height / r.height);
        // When mirrored, screen-left = internal-right
        if (this.mirrored) x = this.overlay.width - x;
        return { x, y };
    }

    shapeAt(x, y) {
        return this.shapes.find(s =>
            x >= s.rect.x && x <= s.rect.x + s.rect.width &&
            y >= s.rect.y && y <= s.rect.y + s.rect.height
        );
    }

    // ── Note editor modal ──────────────────────────────────────────────────────
    openNoteEditor(shapeId) {
        this._editingId = shapeId;
        const container = document.getElementById('note-buttons');
        container.innerHTML = '';

        const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const shape = this.shapes.find(s => s.id === shapeId);

        for (const n of notes) {
            const btn = document.createElement('button');
            btn.className = 'note-btn' + (shape?.note === n ? ' active' : '');
            btn.textContent = n;
            btn.addEventListener('click', () => {
                if (shape) shape.note = n;
                this.closeNoteEditor();
            });
            container.appendChild(btn);
        }

        document.getElementById('note-editor').classList.add('open');
    }

    closeNoteEditor() {
        this._editingId = null;
        document.getElementById('note-editor').classList.remove('open');
    }

    // ── Render loop ────────────────────────────────────────────────────────────
    startRenderLoop() {
        const loop = (ts) => {
            this.animId = requestAnimationFrame(loop);
            this.update(ts);
            this.draw(ts);
            this.countFps(ts);
        };
        this.animId = requestAnimationFrame(loop);
    }

    // ── Update (hand tracking + collision) ───────────────────────────────────
    update(ts) {
        if (this.state !== 'playing' || !this.hands.ready) return;

        const res = this.hands.detect(this.video, ts);
        this.lastHandRes = res;
        if (!res) return;

        const fingers = this.hands.getFingerTips(res, this.overlay.width, this.overlay.height);
        const nowActive = new Set();

        for (const hand of fingers) {
            // Check every fingertip
            for (const tip of hand.tips) {
                const shape = this.shapeAt(tip.x, tip.y);
                if (shape) {
                    nowActive.add(shape.id);
                    if (!this.activeShapes.has(shape.id)) {
                        this.audio.noteOn(shape.id, shape.note);
                    }
                }
            }
        }

        // Release shapes no longer active
        for (const id of this.activeShapes) {
            if (!nowActive.has(id)) {
                this.audio.noteOff(id);
            }
        }

        this.shapes.forEach(s => { s.isActive = nowActive.has(s.id); });
        this.activeShapes = nowActive;
    }

    // ── Draw ───────────────────────────────────────────────────────────────────
    draw() {
        const ctx = this.octx;
        const W = this.overlay.width;
        const H = this.overlay.height;

        ctx.clearRect(0, 0, W, H);

        // Mirror the entire scene for front-facing cameras so it feels natural
        ctx.save();
        if (this.mirrored) {
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
        }

        // Video frame as background
        ctx.drawImage(this.video, 0, 0, W, H);

        // ─ Shapes ──────────────────────────────────────────────────────────────
        for (const s of this.shapes) {
            const { rect, note, isActive, color } = s;

            // Fill
            ctx.fillStyle = isActive ? (color + 'AA') : (color + '40');
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

            // Border
            ctx.save();
            if (isActive) {
                ctx.shadowColor = color;
                ctx.shadowBlur = 22;
            }
            ctx.strokeStyle = isActive ? '#FFF' : color;
            ctx.lineWidth = isActive ? 3 : 2;
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            ctx.restore();

            // Note label — un-mirror text so it reads correctly
            const fz = Math.max(14, Math.min(rect.width, rect.height) * 0.45);
            ctx.font = `bold ${fz}px "Segoe UI", Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;

            ctx.save();
            if (this.mirrored) {
                ctx.translate(cx, cy);
                ctx.scale(-1, 1);
                ctx.translate(-cx, -cy);
            }
            ctx.fillStyle = '#000';
            ctx.fillText(note, cx + 1, cy + 1);
            ctx.fillStyle = isActive ? '#FFF' : '#EEE';
            ctx.fillText(note, cx, cy);
            ctx.restore();
        }

        // ─ Hand skeleton ───────────────────────────────────────────────────────
        if (this.state === 'playing' && this.lastHandRes?.landmarks) {
            for (const rawHand of this.lastHandRes.landmarks) {
                const lm = rawHand.map(p => ({ x: p.x * W, y: p.y * H }));

                // Connections
                ctx.strokeStyle = 'rgba(0,255,136,0.35)';
                ctx.lineWidth = 1.5;
                for (const [a, b] of HAND_CONNECTIONS) {
                    ctx.beginPath();
                    ctx.moveTo(lm[a].x, lm[a].y);
                    ctx.lineTo(lm[b].x, lm[b].y);
                    ctx.stroke();
                }

                // Fingertips (larger dot for index)
                const TIP_IDS = [4, 8, 12, 16, 20];
                for (const ti of TIP_IDS) {
                    const r = ti === 8 ? 8 : 5;
                    ctx.beginPath();
                    ctx.arc(lm[ti].x, lm[ti].y, r, 0, Math.PI * 2);
                    ctx.fillStyle = ti === 8 ? '#00FF88' : 'rgba(0,255,136,0.5)';
                    ctx.fill();
                    ctx.strokeStyle = '#FFF';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }
        }

        // Close the mirrored context
        ctx.restore();
    }

    // ── FPS counter ────────────────────────────────────────────────────────────
    countFps(ts) {
        this._fpsFrames++;
        if (ts - this._fpsLast >= 1000) {
            this.fps = this._fpsFrames;
            this._fpsFrames = 0;
            this._fpsLast = ts;
        }
    }

    // ── UI helpers ─────────────────────────────────────────────────────────────
    status(msg) {
        document.getElementById('status-text').textContent = msg;
        const ls = document.getElementById('loading-status');
        if (ls) ls.textContent = msg;
    }

    hideLoading() {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('main-interface').classList.remove('hidden');
    }

    showError(msg) {
        this.status(msg);
        const p = document.querySelector('#loading-screen p');
        if (p) { p.textContent = msg; p.style.color = '#ff5555'; }
    }
}

// ── Launch ─────────────────────────────────────────────────────────────────────
const app = new PaperPianoApp();
app.init().catch(err => {
    console.error('PaperPiano fatal error:', err);
    document.getElementById('loading-status').textContent = 'Fatal: ' + err.message;
});
