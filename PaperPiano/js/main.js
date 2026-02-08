/* =========================================================
   main.js — Paper Piano application controller
   =========================================================
   Boots every subsystem, runs the render loop, and wires
   UI controls.
   ========================================================= */
'use strict';

(function () {

    /* ==============================================================
       DOM handles
       ============================================================== */
    const $splash        = document.getElementById('splash');
    const $app           = document.getElementById('app');
    const $startBtn      = document.getElementById('startBtn');

    const $video         = document.getElementById('video');
    const $overlay       = document.getElementById('overlay');
    const $loadingOvr    = document.getElementById('loadingOverlay');
    const $loadingTxt    = document.getElementById('loadingText');

    const $scanBtn       = document.getElementById('scanBtn');
    const $autoScanBtn   = document.getElementById('autoScanBtn');
    const $mirrorBtn     = document.getElementById('mirrorBtn');

    const $octaveSlider  = document.getElementById('octaveSlider');
    const $octaveVal     = document.getElementById('octaveVal');
    const $sensSlider    = document.getElementById('sensitivitySlider');

    const $debugBtn      = document.getElementById('debugBtn');
    const $debugPanel    = document.getElementById('debugPanel');
    const $debugCanvas   = document.getElementById('debugCanvas');
    const $debugInfo     = document.getElementById('debugInfo');

    const $noteHUD       = document.getElementById('noteHUD');
    const $shapeBadge    = document.getElementById('shapeBadge');
    const $keyCount      = document.getElementById('keyCount');
    const $padCount      = document.getElementById('padCount');
    const $fpsEl         = document.getElementById('fps');

    const $camDot        = document.querySelector('#cameraStatus .dot');
    const $handDot       = document.querySelector('#handStatus .dot');
    const $cvDot         = document.querySelector('#cvStatus .dot');

    /* Song mode DOM handles */
    const $songModeBtn   = document.getElementById('songModeBtn');
    const $songPanel     = document.getElementById('songPanel');
    const $songPanelClose = document.getElementById('songPanelClose');
    const $songSearch    = document.getElementById('songSearch');
    const $songSearchBtn = document.getElementById('songSearchBtn');
    const $songRefreshBtn = document.getElementById('songRefreshBtn');
    const $songList      = document.getElementById('songList');
    const $songControls  = document.getElementById('songControls');
    const $songNowPlaying = document.getElementById('songNowPlaying');
    const $songPlayBtn   = document.getElementById('songPlayBtn');
    const $songPauseBtn  = document.getElementById('songPauseBtn');
    const $songStopBtn   = document.getElementById('songStopBtn');
    const $songSpeedSlider = document.getElementById('songSpeedSlider');
    const $songSpeedVal  = document.getElementById('songSpeedVal');

    /* ==============================================================
       Subsystems
       ============================================================== */
    const audio  = new AudioEngine();
    const hands  = new HandTracker();
    const shapes = new ShapeDetector();
    const notes  = new NoteRecognizer();
    const songPlayer = new SongPlayer(audio);

    /* ==============================================================
       State
       ============================================================== */
    let running       = false;
    let mirrored      = false;
    let autoScan      = false;
    let autoScanTimer = null;
    let showDebug     = false;
    let songMode      = false;

    let prevPressed   = new Set();      // shape ids currently held
    let activeHUD     = new Map();      // id → timeout handle

    /* ----------------------------------------------------------
     * Tap detector — tracks fingertip vertical motion and fires
     * a tap event when a quick downward movement is detected.
     *
     * For each finger (keyed by "hand:finger") we store a short
     * history of y-positions.  A tap is recognised when:
     *   1. The finger moved DOWN (y increased) significantly
     *      over the last few frames (velocity > threshold).
     *   2. On this frame the finger is inside a shape.
     *
     * After a tap fires the note sustains as long as the finger
     * remains on the shape.  When the finger lifts off (leaves
     * the shape), the note stops.
     * ---------------------------------------------------------- */
    const tapState = {};   // key → { yHist: number[], lastTapTime: number }

    const TAP_HISTORY    = 4;      // frames of history to keep
    const TAP_VEL_THRESH = 0.008;  // min downward y-delta (normalised) over history window
    const TAP_COOLDOWN   = 250;    // ms before same finger can tap again
    const MIN_SUSTAIN    = 150;    // ms minimum hold time to prevent flicker

    /**
     * Held notes: maps fingerKey → { shapeId, startTime }
     * Tracks which finger is currently holding which shape.
     */
    const heldNotes = new Map();

    /**
     * Update tap tracking for a single fingertip.
     * @returns {boolean} true if a tap was just detected this frame
     */
    function updateTap (tip) {
        const key = tip.hand + ':' + tip.finger;
        const now = performance.now();

        if (!tapState[key]) {
            tapState[key] = { yHist: [tip.y], lastTapTime: 0 };
            return false;
        }

        const st = tapState[key];
        st.yHist.push(tip.y);
        if (st.yHist.length > TAP_HISTORY) st.yHist.shift();

        // Need at least 2 frames of history
        if (st.yHist.length < 2) return false;

        // Cooldown check
        if (now - st.lastTapTime < TAP_COOLDOWN) return false;

        // Compute downward velocity:  positive = moving down in screen coords
        const oldest = st.yHist[0];
        const newest = st.yHist[st.yHist.length - 1];
        const vel    = newest - oldest;   // >0 means finger moved down

        if (vel > TAP_VEL_THRESH) {
            st.lastTapTime = now;
            st.yHist.length = 0;          // reset so we don't re-trigger
            return true;
        }

        return false;
    }

    /** Clean up tap state for fingers that disappeared. */
    function pruneOldTaps (activeTips) {
        const activeKeys = new Set(activeTips.map(t => t.hand + ':' + t.finger));
        for (const key of Object.keys(tapState)) {
            if (!activeKeys.has(key)) delete tapState[key];
        }
    }

    /**
     * Hit-test a pixel position against all assigned shapes.
     * Returns the best matching shape or null.
     */
    function hitTestShapeAt (px, py, pad) {
        const hits = notes.assignedShapes.filter(s => {
            if (s.type === 'rectangle') {
                return px >= s.x - pad && px <= s.x + s.width + pad &&
                       py >= s.y - pad && py <= s.y + s.height + pad;
            } else if (s.type === 'circle') {
                return Math.hypot(px - s.centerX, py - s.centerY) <= s.radius + pad;
            }
            return false;
        });
        if (hits.length === 0) return null;
        hits.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.area - b.area;
        });
        return hits[0];
    }

    // FPS tracking
    let frameCount = 0;
    let lastFpsTime = performance.now();

    /* ==============================================================
       Boot
       ============================================================== */
    $startBtn.addEventListener('click', async () => {
        audio.init();                    // must happen inside user gesture
        $splash.classList.add('hidden');
        $app.classList.remove('hidden');
        await boot();
    });

    async function boot () {
        try {
            /* ---- camera ---- */
            setLoading('Starting camera…');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width:      { ideal: 1280 },
                    height:     { ideal: 720 },
                    facingMode: 'environment',
                },
                audio: false,
            });
            $video.srcObject = stream;
            await $video.play();
            $camDot.classList.add('ok');

            // Match canvas to video native resolution
            $overlay.width  = $video.videoWidth;
            $overlay.height = $video.videoHeight;

            /* ---- hand tracker ---- */
            setLoading('Loading hand-tracking model… (may take a moment)');
            await hands.init();
            $handDot.classList.add('ok');

            /* ---- OpenCV ---- */
            setLoading('Loading OpenCV.js…');
            await waitForOpenCV();
            shapes.init($video.videoWidth, $video.videoHeight);
            $cvDot.classList.add('ok');

            /* ---- ready ---- */
            $loadingOvr.classList.add('hidden');
            $scanBtn.disabled = false;
            running = true;

            // Create a default on-screen piano so users can play immediately
            createDefaultPiano();

            requestAnimationFrame(frame);
        } catch (err) {
            setLoading('Error: ' + err.message);
            console.error(err);
        }
    }

    /* ==============================================================
       Main render loop
       ============================================================== */
    const octx = $overlay.getContext('2d');

    function frame () {
        if (!running) { requestAnimationFrame(frame); return; }

        // Send frame to hand tracker (non-blocking)
        if (hands.ready && !hands.processing) {
            hands.send($video);
        }

        processInteraction();
        draw();

        // Song mode: tick playback and draw falling notes
        if (songMode && songPlayer.playing) {
            songPlayer.tick();
            songPlayer.draw(octx, $overlay.width, $overlay.height, notes.assignedShapes);
        }

        updateFPS();

        requestAnimationFrame(frame);
    }

    /* ==============================================================
       Interaction: finger → shape → sound
       ============================================================== */
    function processInteraction () {
        const tips = hands.getFingerTips();
        const cw   = $overlay.width;
        const ch   = $overlay.height;
        const pad  = (+$sensSlider.value / 100) * 30;
        const now  = performance.now();

        pruneOldTaps(tips);

        // Build a set of active finger keys this frame
        const activeFingers = new Set(tips.map(t => t.hand + ':' + t.finger));

        // --- Phase 1: detect new taps and start holding ---
        for (const tip of tips) {
            const fingerKey = tip.hand + ':' + tip.finger;

            // If this finger is already holding a note, skip tap detection
            if (heldNotes.has(fingerKey)) continue;

            const tapped = updateTap(tip);
            if (!tapped) continue;

            const px = tip.x * cw;
            const py = tip.y * ch;
            const shape = hitTestShapeAt(px, py, pad);
            if (!shape) continue;

            // Start holding this note
            audio.play(shape.id, shape.note, shape.instrument);
            showNoteHUD(shape);
            prevPressed.add(shape.id);
            heldNotes.set(fingerKey, { shapeId: shape.id, startTime: now });
        }

        // --- Phase 2: sustain or release held notes ---
        for (const [fingerKey, held] of heldNotes) {
            // Find the current position of this finger
            const tip = tips.find(t => (t.hand + ':' + t.finger) === fingerKey);

            // Finger disappeared entirely — release after min sustain
            if (!tip) {
                if (now - held.startTime >= MIN_SUSTAIN) {
                    audio.stop(held.shapeId);
                    prevPressed.delete(held.shapeId);
                    heldNotes.delete(fingerKey);
                }
                continue;
            }

            // Finger still visible — check if it's still on the same shape
            const px = tip.x * cw;
            const py = tip.y * ch;
            const shape = hitTestShapeAt(px, py, pad);

            if (!shape || shape.id !== held.shapeId) {
                // Finger moved off the shape — release (after min sustain)
                if (now - held.startTime >= MIN_SUSTAIN) {
                    audio.stop(held.shapeId);
                    prevPressed.delete(held.shapeId);
                    heldNotes.delete(fingerKey);
                }
            }
            // else: finger is still on the shape, keep sustaining
        }
    }

    /* ==============================================================
       Drawing overlay
       ============================================================== */
    function draw () {
        const cw = $overlay.width;
        const ch = $overlay.height;
        octx.clearRect(0, 0, cw, ch);

        // ---- draw paper outline ----
        const paperPts = shapes.getPaperOutline();
        if (paperPts && paperPts.length >= 3) {
            octx.beginPath();
            octx.moveTo(paperPts[0].x, paperPts[0].y);
            for (let i = 1; i < paperPts.length; i++) {
                octx.lineTo(paperPts[i].x, paperPts[i].y);
            }
            octx.closePath();
            octx.strokeStyle = 'rgba(0,255,180,0.55)';
            octx.lineWidth   = 2;
            octx.setLineDash([8, 6]);
            octx.stroke();
            octx.setLineDash([]);
        }

        // ---- draw shapes ----
        for (const s of notes.assignedShapes) {
            const active   = prevPressed.has(s.id);
            const editing  = editingShape && editingShape.id === s.id;

            if (s.type === 'rectangle') {
                octx.lineWidth   = (active || editing) ? 4 : 2;
                octx.strokeStyle = active ? '#FF5722'
                    : editing ? '#FFD600'
                    : (s.isBlack ? 'rgba(180,180,255,0.7)' : 'rgba(100,180,255,0.7)');
                octx.fillStyle   = active ? 'rgba(255,87,34,0.30)'
                    : editing ? 'rgba(255,214,0,0.18)'
                    : (s.isBlack ? 'rgba(100,100,200,0.12)' : 'rgba(70,150,255,0.10)');
                octx.fillRect(s.x, s.y, s.width, s.height);
                octx.strokeRect(s.x, s.y, s.width, s.height);
            } else if (s.type === 'circle') {
                octx.beginPath();
                octx.arc(s.centerX, s.centerY, s.radius, 0, Math.PI * 2);
                octx.lineWidth   = (active || editing) ? 4 : 2;
                octx.strokeStyle = active ? '#FF5722' : editing ? '#FFD600' : 'rgba(76,175,80,0.8)';
                octx.fillStyle   = active ? 'rgba(255,87,34,0.30)' : editing ? 'rgba(255,214,0,0.18)' : 'rgba(76,175,80,0.12)';
                octx.fill();
                octx.stroke();
            }

            // Note label
            const tx = s.type === 'circle' ? s.centerX : s.x + s.width / 2;
            const ty = s.type === 'circle' ? s.centerY : s.y + s.height / 2;
            octx.font         = `bold ${active ? 22 : 17}px sans-serif`;
            octx.textAlign    = 'center';
            octx.textBaseline = 'middle';
            octx.strokeStyle  = 'rgba(0,0,0,0.7)';
            octx.lineWidth    = 3;
            octx.strokeText(s.note, tx, ty);
            octx.fillStyle    = active ? '#FFF' : '#e0e0ff';
            octx.fillText(s.note, tx, ty);
        }

        // ---- draw fingertips ----
        const tips = hands.getFingerTips();
        for (const t of tips) {
            const x = t.x * cw;
            const y = t.y * ch;
            octx.beginPath();
            octx.arc(x, y, 9, 0, Math.PI * 2);
            octx.fillStyle   = 'rgba(255,60,60,0.6)';
            octx.fill();
            octx.strokeStyle = '#fff';
            octx.lineWidth   = 2;
            octx.stroke();
        }

        // ---- debug: draw hand skeleton ----
        if (showDebug && typeof drawConnectors !== 'undefined') {
            const landmarks = hands.getLandmarks();
            for (const lm of landmarks) {
                // drawConnectors & drawLandmarks come from @mediapipe/drawing_utils
                drawConnectors(octx, lm, HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 1 });
                drawLandmarks(octx, lm, { color: '#FF0000', lineWidth: 1, radius: 3 });
            }
        }
    }

    /* ==============================================================
       Default on-screen piano
       ============================================================== */

    /**
     * Generate a virtual piano keyboard at the bottom of the overlay.
     * Creates 14 white keys (2 octaves) + 10 black keys that plug
     * directly into notes.assignedShapes so all existing interaction,
     * drawing, and song-mode code works automatically.
     */
    function createDefaultPiano () {
        const cw  = $overlay.width  || 1280;
        const ch  = $overlay.height || 720;
        const oct = +$octaveSlider.value;

        const WHITE = ['C','D','E','F','G','A','B'];
        // Which white-key indices have a black key to their right
        const BLACK_AFTER = { 0:'C#', 1:'D#', 3:'F#', 4:'G#', 5:'A#' };

        const numWhites = 14; // 2 full octaves
        const gap  = 8;      // px gap between white keys
        const keyW = Math.floor((cw - gap * (numWhites - 1)) / numWhites);
        const whiteH = Math.floor(ch * 0.28);
        const blackH = Math.floor(whiteH * 0.6);
        const blackW = Math.floor(keyW * 0.55);
        const topY   = ch - whiteH;
        const stride = keyW + gap;  // center-to-edge distance between keys

        const assigned = [];

        // ---- white keys ----
        for (let i = 0; i < numWhites; i++) {
            const ni  = i % WHITE.length;
            const o   = oct + Math.floor(i / WHITE.length);
            const x   = i * stride;
            assigned.push({
                type:       'rectangle',
                x:          x,
                y:          topY,
                width:      keyW,
                height:     whiteH,
                centerX:    x + keyW / 2,
                centerY:    topY + whiteH / 2,
                area:       keyW * whiteH,
                id:         'w' + i,
                note:       WHITE[ni] + o,
                instrument: 'piano',
                isBlack:    false,
                priority:   0,
            });
        }

        // ---- black keys ----
        let bi = 0;
        for (let i = 0; i < numWhites; i++) {
            const ni = i % WHITE.length;
            if (!(ni in BLACK_AFTER)) continue;

            const o  = oct + Math.floor(i / WHITE.length);
            const x  = i * stride + keyW + gap / 2 - blackW / 2;
            const blackY = topY - Math.floor(blackH * 0.4);
            assigned.push({
                type:       'rectangle',
                x:          x,
                y:          blackY,
                width:      blackW,
                height:     blackH,
                centerX:    x + blackW / 2,
                centerY:    blackY + blackH / 2,
                area:       blackW * blackH,
                id:         'b' + bi,
                note:       BLACK_AFTER[ni] + o,
                instrument: 'piano',
                isBlack:    true,
                priority:   1,
            });
            bi++;
        }

        notes.assignedShapes = assigned;

        const nKeys = assigned.filter(s => !s.isBlack).length;
        const nBlack = assigned.filter(s => s.isBlack).length;
        $keyCount.textContent = nKeys + nBlack;
        $padCount.textContent = 0;
        $shapeBadge.classList.remove('hidden');

        console.log(`[Piano] default keyboard: ${nKeys} white + ${nBlack} black keys, octave ${oct}`);
    }

    /* ==============================================================
       Shape scanning
       ============================================================== */
    function scanShapes () {
        const oct    = +$octaveSlider.value;
        // Always pass debug canvas so we can inspect threshold if needed
        const dbgCvs = showDebug ? $debugCanvas : null;

        console.log('[Scan] scanning shapes… octave=' + oct);
        const raw    = shapes.detect($video, dbgCvs);
        const assigned = notes.assignNotes(raw, oct);

        const nKeys = assigned.filter(s => s.type === 'rectangle').length;
        const nPads = assigned.filter(s => s.type === 'circle').length;

        $keyCount.textContent = nKeys;
        $padCount.textContent = nPads;
        $shapeBadge.classList.toggle('hidden', nKeys + nPads === 0);

        // Always update debug info (visible when debug panel open)
        const strategyLog = shapes.lastLog || '(no strategies ran)';
        $debugInfo.textContent =
            `Strategies: ${strategyLog}\n` +
            `Result → Rects: ${raw.rectangles.length}  Circles: ${raw.circles.length}\n` +
            assigned.map(s => `  ${s.id} → ${s.note} (${s.instrument})`).join('\n');

        if (nKeys + nPads === 0) {
            console.warn('[Scan] No shapes found. Tips: use a thick dark marker on white paper, ensure good lighting, hold camera steady.');
        }

        console.log('[Scan] paper detected:', !!shapes.paperContour);
    }

    /* ==============================================================
       UI wiring
       ============================================================== */
    $scanBtn.addEventListener('click', scanShapes);

    $autoScanBtn.addEventListener('click', () => {
        autoScan = !autoScan;
        $autoScanBtn.textContent = autoScan ? '🔄 Auto: ON' : '🔄 Auto: OFF';
        $autoScanBtn.classList.toggle('active', autoScan);
        if (autoScan) {
            autoScanTimer = setInterval(scanShapes, 2500);
        } else {
            clearInterval(autoScanTimer);
        }
    });

    $mirrorBtn.addEventListener('click', () => {
        mirrored = !mirrored;
        $video.classList.toggle('mirrored', mirrored);
        $overlay.classList.toggle('mirrored', mirrored);
    });

    $octaveSlider.addEventListener('input', () => {
        $octaveVal.textContent = $octaveSlider.value;
        // Re-assign notes at new octave
        if (notes.assignedShapes.length) {
            // If shapes came from a scan, re-scan; otherwise regenerate default piano
            if (shapes.lastLog) {
                scanShapes();
            } else {
                createDefaultPiano();
            }
        }
    });

    $debugBtn.addEventListener('click', () => {
        showDebug = !showDebug;
        $debugPanel.classList.toggle('hidden', !showDebug);
        $debugBtn.classList.toggle('active', showDebug);
    });

    /* ==============================================================
       Song Mode — MIDI song learning with falling notes
       ============================================================== */

    $songModeBtn.addEventListener('click', () => {
        songMode = !songMode;
        $songPanel.classList.toggle('hidden', !songMode);
        $songModeBtn.classList.toggle('active', songMode);
        if (songMode) refreshSongList();
    });

    $songPanelClose.addEventListener('click', () => {
        songMode = false;
        songPlayer.stop();
        $songPanel.classList.add('hidden');
        $songModeBtn.classList.remove('active');
    });

    async function refreshSongList () {
        $songList.innerHTML = '<div style="color: var(--text-dim); font-size:.78rem;">Loading…</div>';
        try {
            const songs = await songPlayer.fetchSongList();
            renderSongList(songs);
        } catch (e) {
            $songList.innerHTML = '<div style="color: var(--accent); font-size:.78rem;">Could not connect to server. Run: python3 app.py</div>';
        }
    }

    function renderSongList (songs) {
        if (songs.length === 0) {
            $songList.innerHTML = '<div style="color: var(--text-dim); font-size:.78rem;">No songs found. Add .mid files to midi_songs/</div>';
            return;
        }
        let html = '';
        for (const s of songs) {
            html += `<div class="song-item" data-file="${s.file}">
                <span class="song-item-name">${s.name}</span>
            </div>`;
        }
        $songList.innerHTML = html;

        $songList.querySelectorAll('.song-item').forEach(el => {
            el.addEventListener('click', async () => {
                const file = el.dataset.file;
                try {
                    await songPlayer.loadSong(file);
                    $songControls.classList.remove('hidden');
                    $songNowPlaying.textContent = 'Loaded: ' + songPlayer.songName;
                    // Highlight active item
                    $songList.querySelectorAll('.song-item').forEach(e => e.classList.remove('active'));
                    el.classList.add('active');
                } catch (err) {
                    $songNowPlaying.textContent = 'Error: ' + err.message;
                }
            });
        });
    }

    $songSearchBtn.addEventListener('click', async () => {
        const query = $songSearch.value.trim();
        try {
            const songs = await songPlayer.searchSongs(query);
            renderSongList(songs);
        } catch (e) {
            $songList.innerHTML = '<div style="color: var(--accent); font-size:.78rem;">Search failed — is the server running?</div>';
        }
    });

    $songSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $songSearchBtn.click();
    });

    $songRefreshBtn.addEventListener('click', refreshSongList);

    $songPlayBtn.addEventListener('click', () => {
        songPlayer.start();
        $songNowPlaying.textContent = 'Playing: ' + songPlayer.songName;
    });

    $songPauseBtn.addEventListener('click', () => {
        songPlayer.pause();
        $songNowPlaying.textContent = 'Paused: ' + songPlayer.songName;
    });

    $songStopBtn.addEventListener('click', () => {
        songPlayer.stop();
        $songNowPlaying.textContent = 'Stopped: ' + songPlayer.songName;
    });

    $songSpeedSlider.addEventListener('input', () => {
        const speed = +$songSpeedSlider.value / 100;
        songPlayer.speed = speed;
        $songSpeedVal.textContent = speed.toFixed(2) + 'x';
    });

    /* ==============================================================
       Shape Editor — click a shape on the overlay to change its sound
       ============================================================== */
    const $shapeEditor  = document.getElementById('shapeEditor');
    const $editorTitle  = document.getElementById('editorTitle');
    const $editorBody   = document.getElementById('editorBody');
    const $editorClose  = document.getElementById('editorClose');

    let editingShape    = null;  // reference into notes.assignedShapes

    // All chromatic notes across one octave
    const ALL_NOTES     = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const DRUM_OPTIONS  = ['kick','snare','hihat','tom1','tom2','crash'];

    /** Convert overlay-canvas click to video-pixel coordinates. */
    function overlayClickToVideoPx (e) {
        const rect = $overlay.getBoundingClientRect();
        const scaleX = $overlay.width  / rect.width;
        const scaleY = $overlay.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top)  * scaleY,
        };
    }

    /** Hit-test a click against assigned shapes (same priority rules as finger presses). */
    function hitTestShapes (px, py) {
        const hits = notes.assignedShapes.filter(s => {
            if (s.type === 'rectangle') {
                return px >= s.x && px <= s.x + s.width &&
                       py >= s.y && py <= s.y + s.height;
            } else if (s.type === 'circle') {
                return Math.hypot(px - s.centerX, py - s.centerY) <= s.radius;
            }
            return false;
        });
        if (hits.length === 0) return null;
        hits.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.area - b.area;
        });
        return hits[0];
    }

    /** Open the editor popup anchored near the click position. */
    function openEditor (shape, clickEvt) {
        editingShape = shape;
        $shapeEditor.classList.remove('hidden');

        // Position: near the click, but keep inside the camera container
        const container = document.getElementById('cameraContainer');
        const cRect     = container.getBoundingClientRect();
        let left = clickEvt.clientX - cRect.left + 12;
        let top  = clickEvt.clientY - cRect.top  + 12;

        // Clamp so popup doesn't overflow
        const edW = 260, edH = 240;
        if (left + edW > cRect.width)  left = cRect.width  - edW - 8;
        if (top  + edH > cRect.height) top  = cRect.height - edH - 8;
        if (left < 4) left = 4;
        if (top  < 4) top  = 4;

        $shapeEditor.style.left = left + 'px';
        $shapeEditor.style.top  = top  + 'px';

        // Build content based on instrument type
        if (shape.instrument === 'piano') {
            buildPianoEditor(shape);
        } else {
            buildDrumEditor(shape);
        }
    }

    function closeEditor () {
        $shapeEditor.classList.add('hidden');
        editingShape = null;
    }

    $editorClose.addEventListener('click', closeEditor);

    // Close when clicking outside
    document.addEventListener('mousedown', (e) => {
        if (editingShape && !$shapeEditor.contains(e.target) && e.target !== $overlay) {
            closeEditor();
        }
    });

    /** Build a piano-note picker (chromatic, with octave selector). */
    function buildPianoEditor (shape) {
        // Parse current note & octave
        const curBase = shape.note.replace(/\d+$/, '');
        const curOct  = parseInt(shape.note.match(/\d+$/)?.[0] ?? '4', 10);

        $editorTitle.textContent = '🎹 Piano Key — ' + shape.id;

        let html = '';

        // Octave row
        html += '<div class="editor-section-label">Octave</div>';
        html += '<div class="editor-grid">';
        for (let o = 2; o <= 6; o++) {
            const sel = o === curOct ? ' selected' : '';
            html += `<button class="note-btn${sel}" data-action="set-octave" data-oct="${o}">${o}</button>`;
        }
        html += '</div>';

        // Note row
        html += '<div class="editor-section-label">Note</div>';
        html += '<div class="editor-grid">';
        for (const n of ALL_NOTES) {
            const sel   = n === curBase ? ' selected' : '';
            const sharp = n.includes('#') ? ' sharp' : '';
            html += `<button class="note-btn${sel}${sharp}" data-action="set-note" data-note="${n}">${n}</button>`;
        }
        html += '</div>';

        $editorBody.innerHTML = html;

        // Bind clicks
        $editorBody.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'set-note') {
                    const newBase = btn.dataset.note;
                    const oct = parseInt(shape.note.match(/\d+$/)?.[0] ?? '4', 10);
                    shape.note = newBase + oct;
                    // Preview the sound
                    audio.play('__preview', shape.note, 'piano');
                    setTimeout(() => audio.stop('__preview'), 300);
                    buildPianoEditor(shape); // refresh selection
                } else if (action === 'set-octave') {
                    const base = shape.note.replace(/\d+$/, '');
                    shape.note = base + btn.dataset.oct;
                    audio.play('__preview', shape.note, 'piano');
                    setTimeout(() => audio.stop('__preview'), 300);
                    buildPianoEditor(shape);
                }
            });
        });
    }

    /** Build a drum-type picker. */
    function buildDrumEditor (shape) {
        $editorTitle.textContent = '🥁 Drum Pad — ' + shape.id;

        let html = '<div class="editor-section-label">Drum Sound</div>';
        html += '<div class="editor-grid">';
        for (const d of DRUM_OPTIONS) {
            const sel = d === shape.note ? ' selected' : '';
            html += `<button class="note-btn drum-btn${sel}" data-drum="${d}">${d}</button>`;
        }
        html += '</div>';

        $editorBody.innerHTML = html;

        $editorBody.querySelectorAll('[data-drum]').forEach(btn => {
            btn.addEventListener('click', () => {
                shape.note = btn.dataset.drum;
                // Preview
                audio.play('__preview_d', shape.note, 'drums');
                buildDrumEditor(shape); // refresh selection
            });
        });
    }

    /** Handle clicks on the overlay canvas. */
    $overlay.addEventListener('click', (e) => {
        // Ignore if no shapes assigned yet
        if (notes.assignedShapes.length === 0) return;

        const { x, y } = overlayClickToVideoPx(e);
        const shape = hitTestShapes(x, y);

        if (shape) {
            openEditor(shape, e);
        } else {
            closeEditor();
        }
    });

    /* ==============================================================
       HUD (floating note names on play)
       ============================================================== */
    function showNoteHUD (shape) {
        // Remove old bubble for this id if it exists
        if (activeHUD.has(shape.id)) {
            clearTimeout(activeHUD.get(shape.id).timer);
            activeHUD.get(shape.id).el.remove();
        }
        const el = document.createElement('div');
        el.className = 'note-bubble' + (shape.instrument === 'drums' ? ' drum' : '');
        el.textContent = shape.note;
        $noteHUD.appendChild(el);
        const timer = setTimeout(() => { el.remove(); activeHUD.delete(shape.id); }, 600);
        activeHUD.set(shape.id, { el, timer });
    }

    /* ==============================================================
       Helpers
       ============================================================== */
    function setLoading (msg) {
        $loadingTxt.textContent = msg;
    }

    function waitForOpenCV () {
        return new Promise((resolve) => {
            console.log('[OpenCV] waiting for cv to load…');

            // Check if already fully loaded
            if (typeof cv !== 'undefined' && typeof cv.Mat === 'function') {
                console.log('[OpenCV] already loaded');
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                clearInterval(poll);
                console.warn('[OpenCV] timed out after 45s — shape detection will be unavailable');
                $cvDot.classList.add('warn');
                resolve();
            }, 45000);

            function onReady () {
                clearInterval(poll);
                clearTimeout(timeout);
                console.log('[OpenCV] runtime ready — cv.Mat exists:', typeof cv.Mat === 'function');
                resolve();
            }

            const poll = setInterval(() => {
                if (typeof cv === 'undefined') return;

                // New builds: cv might be a function / promise-like
                if (typeof cv === 'function') {
                    clearInterval(poll);
                    console.log('[OpenCV] cv is a function — calling cv() to init');
                    cv().then(module => {
                        // Some builds replace global cv, some return a module
                        if (module) window.cv = module;
                        clearTimeout(timeout);
                        console.log('[OpenCV] initialized via cv()');
                        resolve();
                    }).catch(e => {
                        console.error('[OpenCV] init error:', e);
                        clearTimeout(timeout);
                        $cvDot.classList.add('warn');
                        resolve();
                    });
                    return;
                }

                // cv exists as an object
                if (typeof cv.Mat === 'function') {
                    onReady();
                    return;
                }

                // cv exists but isn't ready yet — try setting onRuntimeInitialized
                if (typeof cv.onRuntimeInitialized === 'undefined' ||
                    cv.onRuntimeInitialized === null) {
                    cv.onRuntimeInitialized = onReady;
                }
            }, 300);
        });
    }

    function updateFPS () {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            $fpsEl.textContent = frameCount + ' fps';
            frameCount = 0;
            lastFpsTime = now;
        }
    }

})();
