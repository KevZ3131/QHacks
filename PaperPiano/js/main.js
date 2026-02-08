/**
 * PaperPiano - Main application orchestrator.
 *
 * Pipeline:
 *   1. Load → camera + OpenCV + Tesseract + MediaPipe in parallel
 *   2. Ready → live camera feed, user can scan
 *   3. Scanning → freeze frame → OCR full frame → shape detect with seeds
 *   4. Editing → contour-based shapes visible, user edits note assignments
 *   5. Playing → hand tracking, point-in-polygon hit test → note plays
 *
 * Key improvements over v1:
 *   - Text-first: OCR finds note labels first, shapes grow from those seeds
 *   - Contour-based hitboxes (not bounding rectangles)
 *   - Point-in-polygon for finger presses
 *   - Debug overlay shows text anchors, contour outlines, hand skeleton
 */

import { AudioEngine }    from './audio-engine.js';
import { ShapeDetector }  from './shape-detector.js';
import { NoteRecognizer } from './note-recognizer.js';
import { HandTracker }    from './hand-tracker.js';

// ── Shape colours ──────────────────────────────────────────────────────────────
const SHAPE_COLORS = [
    '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB',
    '#0ABDE3', '#A29BFE', '#FD79A8', '#00B894',
    '#6C5CE7', '#E17055', '#00CEC9', '#FDCB6E'
];

// ── Hand-skeleton connections for drawing ──────────────────────────────────────
const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],
    [0,17]
];

class PaperPianoApp {
    constructor() {
        // Modules
        this.audio     = new AudioEngine();
        this.shapes_   = new ShapeDetector();
        this.ocr       = new NoteRecognizer();
        this.hands     = new HandTracker();

        // State
        this.shapes       = [];
        this.activeShapes = new Set();
        this.state        = 'loading';
        this.lastHandRes  = null;
        this.animId       = null;
        this.mirrored     = false;

        // FPS counter
        this._fpsFrames = 0;
        this._fpsLast   = 0;
        this.fps        = 0;

        // DOM refs
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

        // ── Load camera + all ML libraries in parallel, show progress ──────
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

        if (ocv.status === 'rejected')     console.warn('OpenCV unavailable:', ocv.reason);
        if (ocrRes.status === 'rejected')  console.warn('OCR unavailable:', ocrRes.reason);
        if (handsRes.status === 'rejected') console.warn('Hand tracking unavailable:', handsRes.reason);

        this.hideLoading();
        this.state = 'ready';
        this.status(
            this.shapes_.ready
                ? 'Ready — point camera at drawn shapes, then press Scan.'
                : 'OpenCV unavailable — use "Demo Shapes" to start.'
        );
        this.startRenderLoop();
    }

    // ── DOM binding ────────────────────────────────────────────────────────────
    bindElements() {
        this.video   = document.getElementById('video');
        this.overlay = document.getElementById('overlay-canvas');
        this.octx    = this.overlay.getContext('2d');
        this.proc    = document.getElementById('processing-canvas');
        this.pctx    = this.proc.getContext('2d');
    }

    bindEvents() {
        const $ = id => document.getElementById(id);

        $('btn-scan').addEventListener('click',  () => this.scanShapes());
        $('btn-demo').addEventListener('click',  () => this.addDemoShapes());
        $('btn-play').addEventListener('click',  () => this.enterPlayMode());
        $('btn-stop').addEventListener('click',  () => this.exitPlayMode());
        $('btn-clear').addEventListener('click', () => this.clearShapes());
        $('btn-close-editor').addEventListener('click', () => this.closeNoteEditor());

        $('instrument-select').addEventListener('change', e => {
            this.audio.setPreset(e.target.value);
        });

        this.overlay.addEventListener('click', e => this.onCanvasClick(e));
        this.overlay.addEventListener('touchstart', e => this.onCanvasTouch(e), { passive: false });
        this.overlay.addEventListener('touchmove',  e => this.onCanvasTouch(e), { passive: false });
        this.overlay.addEventListener('touchend',   e => { e.preventDefault(); this.releaseAllTouch(); }, { passive: false });
        this.overlay.addEventListener('touchcancel', e => { e.preventDefault(); this.releaseAllTouch(); }, { passive: false });

        const resumeAudio = () => { this.audio.init(); this.audio.resume(); };
        document.addEventListener('click',      resumeAudio, { once: true });
        document.addEventListener('touchstart', resumeAudio, { once: true });
    }

    // ── Camera ─────────────────────────────────────────────────────────────────
    async initCamera() {
        this.status('Requesting camera…');

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 },
                         frameRate: { ideal: 30, min: 15 }, facingMode: 'environment' },
                audio: false
            });
            this.mirrored = false;
        } catch {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 },
                         frameRate: { ideal: 30, min: 15 } },
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
        this.overlay.width  = vw;
        this.overlay.height = vh;
        this.proc.width     = vw;
        this.proc.height    = vh;

        this.status(`Camera active ✓${this.mirrored ? ' (mirrored)' : ''}`);
    }

    // ── Scanning (text-first pipeline) ─────────────────────────────────────────
    async scanShapes() {
        if (!this.shapes_.ready) {
            this.status('OpenCV is still loading… please wait a moment, then try again.');
            return;
        }
        this.state = 'scanning';
        this.status('Scanning for shapes…');

        // Draw current video frame to hidden processing canvas
        this.pctx.drawImage(this.video, 0, 0);

        // ── Step 1: Run full-frame OCR to find text seeds ──────────────────
        let textSeeds = [];
        if (this.ocr.ready) {
            this.status('Running OCR to find note labels…');
            const ocrPrep = this.shapes_.prepareForOCR(this.proc);
            const rawSeeds = await this.ocr.detectAll(ocrPrep.canvas);

            // Scale seed coordinates back to original frame size
            const invScale = 1 / ocrPrep.scale;
            textSeeds = rawSeeds.map(s => ({
                ...s,
                bbox: {
                    x:      Math.round(s.bbox.x * invScale),
                    y:      Math.round(s.bbox.y * invScale),
                    width:  Math.round(s.bbox.width * invScale),
                    height: Math.round(s.bbox.height * invScale)
                },
                center: {
                    x: Math.round(s.center.x * invScale),
                    y: Math.round(s.center.y * invScale)
                }
            }));

            if (textSeeds.length > 0) {
                this.status(`Found ${textSeeds.length} note label(s) — detecting shapes…`);
            } else {
                this.status('No note labels found — trying contour-only detection…');
            }
        }

        // ── Step 2: Detect shapes using text seeds ─────────────────────────
        const found = this.shapes_.detectWithSeeds(this.proc, textSeeds);

        if (found.length === 0) {
            this.status('No shapes found. Draw dark-outlined rectangles on white paper with note names inside.');
            this.state = 'ready';
            return;
        }

        // ── Step 3: Assign notes (from seeds, per-region OCR, or defaults) ─
        for (let i = 0; i < found.length; i++) {
            const s = found[i];
            s.color    = SHAPE_COLORS[i % SHAPE_COLORS.length];
            s.isActive = false;

            // If the text-first pipeline already assigned a note, use it
            if (s.note) continue;

            // Otherwise try per-region OCR fallback
            if (this.ocr.ready) {
                const crop = this.shapes_.extractRegion(this.proc, s.rect);
                if (crop) {
                    const note = await this.ocr.recognize(crop);
                    s.note = note || this.ocr.getDefaultNote(i);
                    continue;
                }
            }

            // Last resort: default scale
            s.note = this.ocr.getDefaultNote(i);
        }

        this.shapes = found;
        this.state  = 'ready';
        this.showPlayControls();
        this.status(`${found.length} shape(s) detected. Click a shape to change its note, then press Play.`);
    }

    // ── Demo shapes ────────────────────────────────────────────────────────────
    addDemoShapes() {
        const W = this.overlay.width;
        const H = this.overlay.height;

        const notes  = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        const gap    = 4;
        const kw     = Math.floor((W - gap * (notes.length + 1)) / notes.length);
        const kh     = Math.floor(H * 0.28);
        const startY = Math.floor(H * 0.65);
        const startX = Math.floor((W - (kw * notes.length + gap * (notes.length - 1))) / 2);

        this.shapes = notes.map((note, i) => {
            const lx = startX + i * (kw + gap);
            const ly = startY;
            return {
                id:       `shape_${i}`,
                rect:     { x: lx, y: ly, width: kw, height: kh },
                polygon:  [
                    { x: lx,          y: ly },
                    { x: lx + kw,     y: ly },
                    { x: lx + kw,     y: ly + kh },
                    { x: lx,          y: ly + kh }
                ],
                note,
                color:    SHAPE_COLORS[i % SHAPE_COLORS.length],
                center:   { x: lx + kw / 2, y: ly + kh / 2 },
                textPos:  null,
                isActive: false,
                area:     kw * kh
            };
        });

        this.showPlayControls();
        this.status('Demo piano ready. Press Play!');
    }

    // ── Play / Stop mode ───────────────────────────────────────────────────────
    enterPlayMode() {
        if (!this.shapes.length) return;
        this.audio.init();
        this.audio.resume();
        this.state = 'playing';

        document.getElementById('btn-scan').classList.add('hidden');
        document.getElementById('btn-demo').classList.add('hidden');
        document.getElementById('btn-play').classList.add('hidden');
        document.getElementById('btn-stop').classList.remove('hidden');
        document.getElementById('btn-clear').classList.remove('hidden');

        this.status(this.hands.ready
            ? '🎵 Play mode — touch the shapes with your finger!'
            : '🎵 Play mode — tap / click shapes to play (hand tracking unavailable).');
    }

    exitPlayMode() {
        this.audio.noteOffAll();
        this.activeShapes.clear();
        this.shapes.forEach(s => s.isActive = false);
        this.state = 'ready';

        document.getElementById('btn-scan').classList.remove('hidden');
        document.getElementById('btn-demo').classList.remove('hidden');
        this.showPlayControls();
        document.getElementById('btn-stop').classList.add('hidden');

        this.status('Stopped. Edit note assignments or press Play again.');
    }

    clearShapes() {
        this.audio.noteOffAll();
        this.activeShapes.clear();
        this.shapes = [];
        this.state  = 'ready';

        document.getElementById('btn-scan').classList.remove('hidden');
        document.getElementById('btn-demo').classList.remove('hidden');
        document.getElementById('btn-play').classList.add('hidden');
        document.getElementById('btn-stop').classList.add('hidden');
        document.getElementById('btn-clear').classList.add('hidden');

        this.status('Cleared. Scan paper or add demo shapes.');
    }

    showPlayControls() {
        document.getElementById('btn-play').disabled = false;
        document.getElementById('btn-play').classList.remove('hidden');
        document.getElementById('btn-clear').classList.remove('hidden');
    }

    // ── Canvas interaction ─────────────────────────────────────────────────────
    onCanvasClick(e) {
        const pos = this.canvasPos(e.clientX, e.clientY);
        const shape = this.shapeAt(pos.x, pos.y);
        if (!shape) return;

        if (this.state === 'playing') {
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
        let x = (cx - r.left) * (this.overlay.width  / r.width);
        const y = (cy - r.top)  * (this.overlay.height / r.height);
        if (this.mirrored) x = this.overlay.width - x;
        return { x, y };
    }

    /**
     * Hit test — point-in-polygon, with bounding-rect pre-filter for speed.
     */
    shapeAt(x, y) {
        const pt = { x, y };
        return this.shapes.find(s => {
            // Quick bounding-rect rejection
            if (!ShapeDetector.pointInRect(pt, s.rect)) return false;
            // Precise polygon test
            return ShapeDetector.pointInPolygon(pt, s.polygon);
        });
    }

    // ── Note editor modal ──────────────────────────────────────────────────────
    openNoteEditor(shapeId) {
        this._editingId = shapeId;
        const container = document.getElementById('note-buttons');
        container.innerHTML = '';

        const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
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

        document.getElementById('note-editor').classList.remove('hidden');
    }

    closeNoteEditor() {
        this._editingId = null;
        document.getElementById('note-editor').classList.add('hidden');
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

    // ── Update (hand tracking + polygon collision) ────────────────────────────
    update(ts) {
        if (this.state !== 'playing' || !this.hands.ready) return;

        const res = this.hands.detect(this.video, ts);
        this.lastHandRes = res;
        if (!res) return;

        const fingers = this.hands.getFingerTips(res, this.overlay.width, this.overlay.height);
        const nowActive = new Set();

        for (const hand of fingers) {
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

        for (const id of this.activeShapes) {
            if (!nowActive.has(id)) {
                this.audio.noteOff(id);
            }
        }

        this.shapes.forEach(s => { s.isActive = nowActive.has(s.id); });
        this.activeShapes = nowActive;
    }

    // ── Draw (contour-based rendering) ─────────────────────────────────────────
    draw() {
        const ctx = this.octx;
        const W   = this.overlay.width;
        const H   = this.overlay.height;

        ctx.clearRect(0, 0, W, H);

        // Mirror for front-facing cameras
        ctx.save();
        if (this.mirrored) {
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
        }

        // Video background
        ctx.drawImage(this.video, 0, 0, W, H);

        // ─ Draw shapes as filled/stroked polygons ──────────────────────────
        for (const s of this.shapes) {
            const { polygon, note, isActive, color, rect, textPos } = s;

            if (polygon && polygon.length >= 3) {
                // ── Filled polygon ─────────────────────────────────────────
                ctx.beginPath();
                ctx.moveTo(polygon[0].x, polygon[0].y);
                for (let i = 1; i < polygon.length; i++) {
                    ctx.lineTo(polygon[i].x, polygon[i].y);
                }
                ctx.closePath();

                ctx.fillStyle = isActive ? (color + 'AA') : (color + '40');
                ctx.fill();

                // ── Stroked polygon border ─────────────────────────────────
                ctx.save();
                if (isActive) {
                    ctx.shadowColor = color;
                    ctx.shadowBlur  = 22;
                }
                ctx.strokeStyle = isActive ? '#FFF' : color;
                ctx.lineWidth   = isActive ? 3 : 2;
                ctx.stroke();
                ctx.restore();
            } else {
                // Fallback to rect if no polygon
                ctx.fillStyle = isActive ? (color + 'AA') : (color + '40');
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
                ctx.save();
                if (isActive) { ctx.shadowColor = color; ctx.shadowBlur = 22; }
                ctx.strokeStyle = isActive ? '#FFF' : color;
                ctx.lineWidth   = isActive ? 3 : 2;
                ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
                ctx.restore();
            }

            // ── Note label — un-mirror text ────────────────────────────────
            const cx = rect.x + rect.width  / 2;
            const cy = rect.y + rect.height / 2;
            const fz = Math.max(14, Math.min(rect.width, rect.height) * 0.45);
            ctx.font         = `bold ${fz}px "Segoe UI", Arial, sans-serif`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';

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

            // ── Debug: text anchor dot ──────────────────────────────────────
            if (textPos) {
                ctx.beginPath();
                ctx.arc(textPos.x, textPos.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#FF0';
                ctx.fill();
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // ─ Hand skeleton ───────────────────────────────────────────────────
        if (this.state === 'playing' && this.lastHandRes?.landmarks) {
            for (const rawHand of this.lastHandRes.landmarks) {
                const lm = rawHand.map(p => ({ x: p.x * W, y: p.y * H }));

                ctx.strokeStyle = 'rgba(0,255,136,0.35)';
                ctx.lineWidth   = 1.5;
                for (const [a, b] of HAND_CONNECTIONS) {
                    ctx.beginPath();
                    ctx.moveTo(lm[a].x, lm[a].y);
                    ctx.lineTo(lm[b].x, lm[b].y);
                    ctx.stroke();
                }

                const TIP_IDS = [4, 8, 12, 16, 20];
                for (const ti of TIP_IDS) {
                    const r = ti === 8 ? 8 : 5;
                    ctx.beginPath();
                    ctx.arc(lm[ti].x, lm[ti].y, r, 0, Math.PI * 2);
                    ctx.fillStyle   = ti === 8 ? '#00FF88' : 'rgba(0,255,136,0.5)';
                    ctx.fill();
                    ctx.strokeStyle = '#FFF';
                    ctx.lineWidth   = 1.5;
                    ctx.stroke();
                }
            }
        }

        ctx.restore();   // close mirrored context
    }

    // ── FPS counter ────────────────────────────────────────────────────────────
    countFps(ts) {
        this._fpsFrames++;
        if (ts - this._fpsLast >= 1000) {
            this.fps = this._fpsFrames;
            this._fpsFrames = 0;
            this._fpsLast   = ts;
            document.getElementById('fps-counter').textContent = `${this.fps} FPS`;
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
