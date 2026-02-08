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
    const $splash = document.getElementById('splash');
    const $app = document.getElementById('app');
    const $startBtn = document.getElementById('startBtn');

    const $video = document.getElementById('video');
    const $overlay = document.getElementById('overlay');
    const $loadingOvr = document.getElementById('loadingOverlay');
    const $loadingTxt = document.getElementById('loadingText');

    const $scanBtn = document.getElementById('scanBtn');
    const $autoScanBtn = document.getElementById('autoScanBtn');
    const $mirrorBtn = document.getElementById('mirrorBtn');

    const $octaveSlider = document.getElementById('octaveSlider');
    const $octaveVal = document.getElementById('octaveVal');
    const $sensSlider = document.getElementById('sensitivitySlider');

    const $debugBtn = document.getElementById('debugBtn');
    const $debugPanel = document.getElementById('debugPanel');
    const $debugCanvas = document.getElementById('debugCanvas');
    const $debugInfo = document.getElementById('debugInfo');

    const $noteHUD = document.getElementById('noteHUD');
    const $shapeBadge = document.getElementById('shapeBadge');
    const $keyCount = document.getElementById('keyCount');
    const $padCount = document.getElementById('padCount');
    const $fpsEl = document.getElementById('fps');

    const $camDot = document.querySelector('#cameraStatus .dot');
    const $handDot = document.querySelector('#handStatus .dot');
    const $cvDot = document.querySelector('#cvStatus .dot');

    /* ==============================================================
       Subsystems
       ============================================================== */
    /* ==============================================================
       Subsystems
       ============================================================== */
    const audio = new AudioEngine();
    const hands = new HandTracker();
    const shapes = new ShapeDetector();
    const notes = new NoteRecognizer();

    // Dynamic import to avoid module issues if not using type="module" in HTML yet
    // But since we are using es6 modules for songs, we need to treat main as module or dynamic import
    // The user's HTML has script src="js/main.js" without type="module".
    // We should probably change index.html to type="module" or use dynamic import.
    // Let's use dynamic import for the song player.
    let songPlayer = null;
    let SONGS = [];

    import('./song-player.js').then(m => {
        songPlayer = new m.SongPlayer(audio);
        import('./songs.js').then(s => {
            SONGS = s.SONGS;
            initSongUI();
        });
    });

    /* ==============================================================
       State
       ============================================================== */
    let running = false;
    let mirrored = false;
    let autoScan = false;
    let autoScanTimer = null;
    let showDebug = false;

    let prevPressed = new Set();      // shape ids currently held
    let activeHUD = new Map();      // id → timeout handle
    let debounceMap = new Map();      // shape id → timestamp of last release

    /* ==============================================================
       Song UI Elements
       ============================================================== */
    const $songMenu = document.getElementById('songMenu');
    const $songsBtn = document.getElementById('songsBtn');
    const $closeSongsBtn = document.getElementById('closeSongsBtn');
    const $songList = document.getElementById('songList');

    function initSongUI() {
        $songsBtn.addEventListener('click', () => {
            $songMenu.classList.remove('hidden');
            renderSongList();
        });

        $closeSongsBtn.addEventListener('click', () => {
            $songMenu.classList.add('hidden');
        });

        // Close when clicking overlay
        $songMenu.querySelector('.menu-overlay').addEventListener('click', () => {
            $songMenu.classList.add('hidden');
        });
    }

    function renderSongList() {
        $songList.innerHTML = '';
        SONGS.forEach(song => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.textContent = song.title;
            div.onclick = () => {
                playSong(song.id);
                $songMenu.classList.add('hidden');
            };
            $songList.appendChild(div);
        });
    }

    function playSong(id) {
        if (!notes.assignedShapes || notes.assignedShapes.length === 0) {
            alert('Please scan your piano keys first so we know where to drop the notes!');
            return;
        }
        // If the menu is open, maybe close it or let the user close it?
        // The click handler closes it.
        if (songPlayer) songPlayer.start(id);
    }

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
     * After a tap fires we add a cooldown so the same finger
     * can't re-trigger for a short period.
     * ---------------------------------------------------------- */
    const tapState = {};   // key → { yHist: number[], lastTapTime: number }

    const TAP_HISTORY = 4;      // frames of history to keep
    const TAP_VEL_THRESH = 0.008;  // min downward y-delta (normalised) over history window
    const TAP_COOLDOWN = 250;    // ms before same finger can tap again
    const TAP_SUSTAIN = 300;    // ms to hold a note after tap

    /**
     * Update tap tracking for a single fingertip.
     * @returns {boolean} true if a tap was just detected this frame
     */
    function updateTap(tip) {
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
        const vel = newest - oldest;   // >0 means finger moved down

        if (vel > TAP_VEL_THRESH) {
            st.lastTapTime = now;
            st.yHist.length = 0;          // reset so we don't re-trigger
            return true;
        }

        return false;
    }

    /** Clean up tap state for fingers that disappeared. */
    function pruneOldTaps(activeTips) {
        const activeKeys = new Set(activeTips.map(t => t.hand + ':' + t.finger));
        for (const key of Object.keys(tapState)) {
            if (!activeKeys.has(key)) delete tapState[key];
        }
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

    async function boot() {
        try {
            /* ---- camera ---- */
            setLoading('Starting camera…');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'environment',
                },
                audio: false,
            });
            $video.srcObject = stream;
            await $video.play();
            $camDot.classList.add('ok');

            // Match canvas to video native resolution
            $overlay.width = $video.videoWidth;
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

    function frame() {
        if (!running) { requestAnimationFrame(frame); return; }

        // Send frame to hand tracker (non-blocking)
        if (hands.ready && !hands.processing) {
            hands.send($video);
        }

        processInteraction();
        draw();
        updateFPS();

        requestAnimationFrame(frame);
    }

    /* ==============================================================
       Interaction: finger → shape → sound
       ============================================================== */
    function processInteraction() {
        const tips = hands.getFingerTips();
        const cw = $overlay.width;
        const ch = $overlay.height;
        const pad = (+$sensSlider.value / 100) * 30;
        const now = performance.now();

        pruneOldTaps(tips);

        // For each visible fingertip, check for a tap gesture
        for (const tip of tips) {
            const tapped = updateTap(tip);
            if (!tapped) continue;

            // Finger just tapped — see which shape it's inside
            const px = tip.x * cw;
            const py = tip.y * ch;
            const hits = notes.assignedShapes.filter(s => {
                if (s.type === 'rectangle') {
                    return px >= s.x - pad && px <= s.x + s.width + pad &&
                        py >= s.y - pad && py <= s.y + s.height + pad;
                } else if (s.type === 'circle') {
                    return Math.hypot(px - s.centerX, py - s.centerY) <= s.radius + pad;
                }
                return false;
            });

            if (hits.length === 0) continue;

            // Resolve overlaps: highest priority, then smallest area
            hits.sort((a, b) => {
                if (a.priority !== b.priority) return b.priority - a.priority;
                return a.area - b.area;
            });

            const shape = hits[0];

            // Play note & schedule auto-stop after sustain period
            audio.play(shape.id, shape.note, shape.instrument);
            showNoteHUD(shape);
            prevPressed.add(shape.id);

            // Auto-release after TAP_SUSTAIN ms
            const sid = shape.id;
            debounceMap.set(sid, now);
            setTimeout(() => {
                audio.stop(sid);
                prevPressed.delete(sid);
            }, TAP_SUSTAIN);
        }
    }

    /* ==============================================================
       Drawing overlay
       ============================================================== */
    function draw() {
        const cw = $overlay.width;
        const ch = $overlay.height;
        octx.clearRect(0, 0, cw, ch);

        // ---- draw falling notes (underground) ----
        if (songPlayer) {
            songPlayer.draw(octx, notes.assignedShapes, cw, ch);
        }

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
            octx.lineWidth = 2;
            octx.setLineDash([8, 6]);
            octx.stroke();
            octx.setLineDash([]);
        }

        // ---- draw shapes ----
        for (const s of notes.assignedShapes) {
            const active = prevPressed.has(s.id);
            const editing = editingShape && editingShape.id === s.id;

            if (s.type === 'rectangle') {
                octx.lineWidth = (active || editing) ? 4 : 2;
                octx.strokeStyle = active ? '#FF5722'
                    : editing ? '#FFD600'
                        : (s.isBlack ? 'rgba(180,180,255,0.7)' : 'rgba(100,180,255,0.7)');
                octx.fillStyle = active ? 'rgba(255,87,34,0.30)'
                    : editing ? 'rgba(255,214,0,0.18)'
                        : (s.isBlack ? 'rgba(100,100,200,0.12)' : 'rgba(70,150,255,0.10)');

                if (s.poly && s.poly.length > 0) {
                    octx.beginPath();
                    octx.moveTo(s.poly[0].x, s.poly[0].y);
                    for (let i = 1; i < s.poly.length; i++) {
                        octx.lineTo(s.poly[i].x, s.poly[i].y);
                    }
                    octx.closePath();
                    octx.fill();
                    octx.stroke();
                } else {
                    octx.fillRect(s.x, s.y, s.width, s.height);
                    octx.strokeRect(s.x, s.y, s.width, s.height);
                }
            } else if (s.type === 'circle') {
                octx.beginPath();
                octx.arc(s.centerX, s.centerY, s.radius, 0, Math.PI * 2);
                octx.lineWidth = (active || editing) ? 4 : 2;
                octx.strokeStyle = active ? '#FF5722' : editing ? '#FFD600' : 'rgba(76,175,80,0.8)';
                octx.fillStyle = active ? 'rgba(255,87,34,0.30)' : editing ? 'rgba(255,214,0,0.18)' : 'rgba(76,175,80,0.12)';
                octx.fill();
                octx.stroke();
            }

            // Note label
            const tx = s.type === 'circle' ? s.centerX : s.x + s.width / 2;
            const ty = s.type === 'circle' ? s.centerY : s.y + s.height / 2;
            octx.font = `bold ${active ? 22 : 17}px sans-serif`;
            octx.textAlign = 'center';
            octx.textBaseline = 'middle';
            octx.strokeStyle = 'rgba(0,0,0,0.7)';
            octx.lineWidth = 3;
            octx.strokeText(s.note, tx, ty);
            octx.fillStyle = active ? '#FFF' : '#e0e0ff';
            octx.fillText(s.note, tx, ty);
        }

        // ---- draw fingertips ----
        const tips = hands.getFingerTips();
        for (const t of tips) {
            const x = t.x * cw;
            const y = t.y * ch;
            octx.beginPath();
            octx.arc(x, y, 9, 0, Math.PI * 2);
            octx.fillStyle = 'rgba(255,60,60,0.6)';
            octx.fill();
            octx.strokeStyle = '#fff';
            octx.lineWidth = 2;
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
       Shape scanning
       ============================================================== */
    function scanShapes() {
        const oct = +$octaveSlider.value;
        // Always pass debug canvas so we can inspect threshold if needed
        const dbgCvs = showDebug ? $debugCanvas : null;

        console.log('[Scan] scanning shapes… octave=' + oct);
        const raw = shapes.detect($video, dbgCvs);
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
        // Re-assign notes at new octave if shapes already detected
        if (notes.assignedShapes.length) scanShapes();
    });

    $debugBtn.addEventListener('click', () => {
        showDebug = !showDebug;
        $debugPanel.classList.toggle('hidden', !showDebug);
        $debugBtn.classList.toggle('active', showDebug);
    });

    /* ==============================================================
       Shape Editor — click a shape on the overlay to change its sound
       ============================================================== */
    const $shapeEditor = document.getElementById('shapeEditor');
    const $editorTitle = document.getElementById('editorTitle');
    const $editorBody = document.getElementById('editorBody');
    const $editorClose = document.getElementById('editorClose');

    let editingShape = null;  // reference into notes.assignedShapes

    // All chromatic notes across one octave
    const ALL_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const DRUM_OPTIONS = ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'crash'];

    /** Convert overlay-canvas click to video-pixel coordinates. */
    function overlayClickToVideoPx(e) {
        const rect = $overlay.getBoundingClientRect();
        const scaleX = $overlay.width / rect.width;
        const scaleY = $overlay.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }

    /** Hit-test a click against assigned shapes (same priority rules as finger presses). */
    function hitTestShapes(px, py) {
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
    function openEditor(shape, clickEvt) {
        editingShape = shape;
        $shapeEditor.classList.remove('hidden');

        // Position: near the click, but keep inside the camera container
        const container = document.getElementById('cameraContainer');
        const cRect = container.getBoundingClientRect();
        let left = clickEvt.clientX - cRect.left + 12;
        let top = clickEvt.clientY - cRect.top + 12;

        // Clamp so popup doesn't overflow
        const edW = 260, edH = 240;
        if (left + edW > cRect.width) left = cRect.width - edW - 8;
        if (top + edH > cRect.height) top = cRect.height - edH - 8;
        if (left < 4) left = 4;
        if (top < 4) top = 4;

        $shapeEditor.style.left = left + 'px';
        $shapeEditor.style.top = top + 'px';

        // Build content based on instrument type
        if (shape.instrument === 'piano') {
            buildPianoEditor(shape);
        } else {
            buildDrumEditor(shape);
        }
    }

    function closeEditor() {
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
    function buildPianoEditor(shape) {
        // Parse current note & octave
        const curBase = shape.note.replace(/\d+$/, '');
        const curOct = parseInt(shape.note.match(/\d+$/)?.[0] ?? '4', 10);

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
            const sel = n === curBase ? ' selected' : '';
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
    function buildDrumEditor(shape) {
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
    function showNoteHUD(shape) {
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
    function setLoading(msg) {
        $loadingTxt.textContent = msg;
    }

    function waitForOpenCV() {
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

            function onReady() {
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

    function updateFPS() {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            $fpsEl.textContent = frameCount + ' fps';
            frameCount = 0;
            lastFpsTime = now;
        }
    }

})();
