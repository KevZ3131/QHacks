/* =========================================================
   main.js — Paper Piano application controller
   ========================================================= */
'use strict';

(function () {

    /* ==============================================================
       DOM handles
       ============================================================== */
    const $splash = document.getElementById('splash');
    const $app = document.getElementById('app');
    const $startBtn = document.getElementById('startBtn');
    const $demoBtn = document.getElementById('demoBtn');
    const $startNote = document.getElementById('startNote');

    const $cameraContainer = document.getElementById('cameraContainer');
    const $video = document.getElementById('video');
    const $overlay = document.getElementById('overlay');
    const $loadingOverlay = document.getElementById('loadingOverlay');
    const $loadingText = document.getElementById('loadingText');
    const $stageHint = document.getElementById('stageHint');

    const $scanBtn = document.getElementById('scanBtn');
    const $autoScanBtn = document.getElementById('autoScanBtn');
    const $mirrorBtn = document.getElementById('mirrorBtn');
    const $switchCameraBtn = document.getElementById('switchCameraBtn');
    const $sampleBtn = document.getElementById('sampleBtn');
    const $endBtn = document.getElementById('endBtn');

    const $octaveSlider = document.getElementById('octaveSlider');
    const $octaveVal = document.getElementById('octaveVal');
    const $sensitivitySlider = document.getElementById('sensitivitySlider');
    const $sensitivityVal = document.getElementById('sensitivityVal');
    const $volumeSlider = document.getElementById('volumeSlider');
    const $volumeVal = document.getElementById('volumeVal');

    const $debugBtn = document.getElementById('debugBtn');
    const $debugPanel = document.getElementById('debugPanel');
    const $debugCanvas = document.getElementById('debugCanvas');
    const $debugInfo = document.getElementById('debugInfo');

    const $noteHUD = document.getElementById('noteHUD');
    const $announcement = document.getElementById('announcement');
    const $shapeBadge = document.getElementById('shapeBadge');
    const $keyCount = document.getElementById('keyCount');
    const $padCount = document.getElementById('padCount');
    const $fpsEl = document.getElementById('fps');

    const $cameraStatusText = document.getElementById('cameraStatusText');
    const $handStatusText = document.getElementById('handStatusText');
    const $cvStatusText = document.getElementById('cvStatusText');
    const $cameraDot = document.querySelector('#cameraStatus .dot');
    const $handDot = document.querySelector('#handStatus .dot');
    const $cvDot = document.querySelector('#cvStatus .dot');

    const $shapeEditor = document.getElementById('shapeEditor');
    const $editorTitle = document.getElementById('editorTitle');
    const $editorBody = document.getElementById('editorBody');
    const $editorClose = document.getElementById('editorClose');

    /* ==============================================================
       Subsystems and constants
       ============================================================== */
    const audio = new AudioEngine();
    const hands = new HandTracker();
    const shapes = new ShapeDetector();
    const notes = new NoteRecognizer();
    const interaction = new InteractionEngine({
        historySize: 4,
        velocityThreshold: 0.008,
        cooldownMs: 250,
    });

    const octx = $overlay.getContext('2d');
    const PIANO_KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j'];
    const DRUM_KEYS = ['1', '2', '3', '4', '5', '6'];
    const ALL_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const DRUM_OPTIONS = ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'crash'];
    const TAP_SUSTAIN = 300;

    /* ==============================================================
       State
       ============================================================== */
    let running = false;
    let demoMode = false;
    let mirrored = readSetting('mirror', true);
    let facingMode = 'user';
    let autoScan = false;
    let autoScanTimer = null;
    let animationFrameId = null;
    let isScanning = false;
    let showDebug = false;
    let cameraStream = null;
    let visionReady = false;
    let openCvPromise = null;
    let sessionGeneration = 0;
    let currentRawShapes = null;
    let editingShape = null;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    const pressedShapes = new Set();
    const releaseTimers = new Map();
    const activeHUD = new Map();
    const heldKeyboard = new Map();

    initialiseSettings();
    setMirror(mirrored, false);
    setStatus($cameraDot, $cameraStatusText, 'Camera off');
    setStatus($handDot, $handStatusText, 'Hand tracker off');
    setStatus($cvDot, $cvStatusText, 'Vision off');

    /* ==============================================================
       Session lifecycle
       ============================================================== */
    $startBtn.addEventListener('click', startCameraSession);
    $demoBtn.addEventListener('click', startDemoSession);
    $endBtn.addEventListener('click', () => endSession(true));

    async function startCameraSession () {
        const generation = ++sessionGeneration;
        const audioReady = initialiseAudio();

        demoMode = false;
        facingMode = 'user';
        setMirror(readSetting('mirror', true), false);
        prepareAppView();
        setLoading('Starting camera…', true);
        setStatus($cameraDot, $cameraStatusText, 'Starting camera', 'warn');
        setStatus($handDot, $handStatusText, 'Loading hand tracker', 'warn');
        setStatus($cvDot, $cvStatusText, 'Loading vision', 'warn');
        setCapabilityControls(false);

        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('This browser does not support camera access.');
            }

            const stream = await requestCamera(facingMode);
            if (generation !== sessionGeneration) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            await attachCameraStream(stream);
            $sampleBtn.disabled = false;
            setStatus($cameraDot, $cameraStatusText, 'Camera live', 'ok');
            setLoading('', false);
            showStageHint('Camera ready. Load the sample now, or scan your drawing when Vision is ready.');
            startRenderLoop();

            if (!audioReady) announce('Audio is not supported in this browser.');
            initialiseCapabilities(generation);
        } catch (error) {
            stopRuntime();
            showApp(false);
            $startBtn.disabled = false;
            $demoBtn.disabled = false;
            $startBtn.textContent = 'Retry Camera';
            $startNote.textContent = cameraErrorMessage(error) + ' You can still try the sample layout.';
            console.error('[Camera] startup failed:', error);
        }
    }

    function startDemoSession () {
        ++sessionGeneration;
        initialiseAudio();
        demoMode = true;
        visionReady = false;
        currentRawShapes = null;
        prepareAppView();

        $video.classList.add('hidden');
        $cameraContainer.classList.add('demo-mode');
        $overlay.width = 1280;
        $overlay.height = 720;
        setMirror(false, false);
        syncOverlay();

        setStatus($cameraDot, $cameraStatusText, 'Sample mode', 'ok');
        setStatus($handDot, $handStatusText, 'Pointer + keyboard', 'ok');
        setStatus($cvDot, $cvStatusText, 'Sample layout', 'ok');
        setLoading('', false);
        setCapabilityControls(false);
        $sampleBtn.disabled = false;
        loadSampleLayout();
        showStageHint('Play with pointer or keyboard. Click a shape to customize its sound.');
        startRenderLoop();
        $overlay.focus();
    }

    function prepareAppView () {
        stopActiveNotes();
        notes.clear();
        currentRawShapes = null;
        interaction.reset();
        closeEditor();
        updateShapeCounts();
        showApp(true);
        $startBtn.disabled = true;
        $demoBtn.disabled = true;
        $video.classList.remove('hidden');
        $cameraContainer.classList.remove('demo-mode');
        $debugInfo.textContent = 'No scan has run yet.';
    }

    function showApp (visible) {
        $splash.classList.toggle('hidden', visible);
        $splash.setAttribute('aria-hidden', String(visible));
        $splash.inert = visible;
        $app.classList.toggle('hidden', !visible);
        $app.setAttribute('aria-hidden', String(!visible));
        $app.inert = !visible;
    }

    function startRenderLoop () {
        running = true;
        if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
        lastFpsTime = performance.now();
        frameCount = 0;
        animationFrameId = requestAnimationFrame(frame);
    }

    function endSession (returnToSplash) {
        ++sessionGeneration;
        stopRuntime();
        setStatus($cameraDot, $cameraStatusText, 'Camera off');
        setStatus($handDot, $handStatusText, 'Hand tracker off');
        setStatus($cvDot, $cvStatusText, 'Vision off');
        setLoading('', false);
        setMirror(readSetting('mirror', true), false);

        if (returnToSplash) {
            showApp(false);
            $startBtn.disabled = false;
            $demoBtn.disabled = false;
            $startBtn.textContent = 'Start Camera';
            $startNote.textContent = 'Camera stays in your browser and stops when you end the session.';
            setTimeout(() => $startBtn.focus(), 0);
        }
    }

    function stopRuntime () {
        running = false;
        if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        setAutoScan(false);
        stopActiveNotes();
        for (const entry of activeHUD.values()) {
            clearTimeout(entry.timer);
            entry.element.remove();
        }
        activeHUD.clear();
        audio.stopAll();
        interaction.reset();
        hands.onResults = null;
        hands.close();
        shapes.destroy();
        stopCamera();
        notes.clear();
        currentRawShapes = null;
        visionReady = false;
        demoMode = false;
        showDebug = false;
        $debugPanel.classList.add('hidden');
        $debugBtn.classList.remove('active');
        $debugBtn.setAttribute('aria-expanded', 'false');
        showStageHint('');
        closeEditor();
        updateShapeCounts();
        $video.classList.remove('hidden');
        $cameraContainer.classList.remove('demo-mode');
        $overlay.width = 1;
        $overlay.height = 1;
    }

    async function initialiseCapabilities (generation) {
        hands.onResults = results => {
            if (generation !== sessionGeneration) return;
            const count = results.multiHandLandmarks?.length || 0;
            setStatus(
                $handDot,
                $handStatusText,
                count > 0 ? (count === 1 ? '1 hand visible' : count + ' hands visible') : 'Tracker ready — show a hand',
                count > 0 ? 'ok' : 'warn'
            );
        };

        const handTask = (async () => {
            try {
                await hands.init();
                if (generation !== sessionGeneration) return;
                setStatus($handDot, $handStatusText, 'Tracker ready — show a hand', 'warn');
            } catch (error) {
                if (generation !== sessionGeneration) return;
                setStatus($handDot, $handStatusText, 'Hand tracking unavailable', 'err');
                console.warn('[Hands] unavailable:', error);
            }
        })();

        const visionTask = (async () => {
            const ready = await waitForOpenCV();
            if (generation !== sessionGeneration) return;

            visionReady = ready;
            if (ready) {
                shapes.init($video.videoWidth, $video.videoHeight);
                setStatus($cvDot, $cvStatusText, 'Vision ready', 'ok');
                setCapabilityControls(true);
                showStageHint('Point the camera at your drawing, then choose Scan Shapes.');
                announce('Vision ready. You can scan shapes now.');
            } else {
                setStatus($cvDot, $cvStatusText, 'Vision unavailable', 'err');
                setCapabilityControls(false);
                showStageHint('Vision did not load. Load the sample to keep playing, or retry the session.');
            }
        })();

        await Promise.allSettled([handTask, visionTask]);
    }

    async function requestCamera (mode) {
        return navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: { ideal: mode },
            },
            audio: false,
        });
    }

    async function attachCameraStream (stream) {
        const oldStream = cameraStream;
        $video.srcObject = stream;
        try {
            await $video.play();
        } catch (error) {
            stream.getTracks().forEach(track => track.stop());
            $video.srcObject = oldStream;
            if (oldStream) await $video.play().catch(() => {});
            throw error;
        }
        cameraStream = stream;
        if (oldStream && oldStream !== stream) {
            oldStream.getTracks().forEach(track => track.stop());
        }

        $overlay.width = $video.videoWidth || 1280;
        $overlay.height = $video.videoHeight || 720;
        syncOverlay();
    }

    function stopCamera () {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
        $video.pause();
        $video.srcObject = null;
    }

    /* ==============================================================
       Render and interaction
       ============================================================== */
    function frame () {
        if (!running) return;

        if (!demoMode && hands.ready && !hands.processing && $video.readyState >= 2) {
            hands.send($video);
        }
        processHandInteraction();
        draw();
        updateFPS();
        animationFrameId = requestAnimationFrame(frame);
    }

    function processHandInteraction () {
        if (demoMode || !hands.ready) return;
        const tips = hands.getFingerTips();
        const pad = (+$sensitivitySlider.value / 100) * 30;
        interaction.prune(tips);

        for (const tip of tips) {
            if (!interaction.updateTap(tip)) continue;
            const px = tip.x * $overlay.width;
            const py = tip.y * $overlay.height;
            const shape = interaction.hitTest(notes.assignedShapes, px, py, pad);
            if (shape) triggerShape(shape, TAP_SUSTAIN);
        }
    }

    function triggerShape (shape, sustainMs = TAP_SUSTAIN) {
        if (!shape) return;

        if (shape.instrument === 'piano' && pressedShapes.has(shape.id)) {
            audio.stop(shape.id);
        }
        const played = audio.play(shape.id, shape.note, shape.instrument);
        if (!played && shape.instrument === 'piano') return;

        pressedShapes.add(shape.id);
        showNoteHUD(shape);
        announce(shape.note);

        if (releaseTimers.has(shape.id)) clearTimeout(releaseTimers.get(shape.id));
        if (sustainMs !== null) {
            const timer = setTimeout(() => releaseShape(shape.id), sustainMs);
            releaseTimers.set(shape.id, timer);
        }
    }

    function releaseShape (shapeId) {
        audio.stop(shapeId);
        pressedShapes.delete(shapeId);
        if (releaseTimers.has(shapeId)) clearTimeout(releaseTimers.get(shapeId));
        releaseTimers.delete(shapeId);
    }

    function stopActiveNotes () {
        for (const timer of releaseTimers.values()) clearTimeout(timer);
        releaseTimers.clear();
        heldKeyboard.clear();
        pressedShapes.clear();
        audio.stopAll();
    }

    function draw () {
        const width = $overlay.width;
        const height = $overlay.height;
        octx.clearRect(0, 0, width, height);

        if (demoMode) drawSampleBackdrop(width, height);
        drawPaperOutline();

        for (const shape of notes.assignedShapes) drawShape(shape);

        if (!demoMode) {
            for (const tip of hands.getFingerTips()) {
                const x = tip.x * width;
                const y = tip.y * height;
                octx.beginPath();
                octx.arc(x, y, 9, 0, Math.PI * 2);
                octx.fillStyle = 'rgba(255,80,65,0.7)';
                octx.fill();
                octx.strokeStyle = '#fff';
                octx.lineWidth = 2;
                octx.stroke();
            }
        }

        if (showDebug && typeof drawConnectors !== 'undefined' &&
            typeof HAND_CONNECTIONS !== 'undefined') {
            for (const landmarks of hands.getLandmarks()) {
                drawConnectors(octx, landmarks, HAND_CONNECTIONS, { color: '#00e676', lineWidth: 1 });
                drawLandmarks(octx, landmarks, { color: '#ff604f', lineWidth: 1, radius: 3 });
            }
        }
    }

    function drawSampleBackdrop (width, height) {
        octx.fillStyle = '#ece8dc';
        octx.fillRect(0, 0, width, height);
        octx.strokeStyle = 'rgba(29,33,27,0.08)';
        octx.lineWidth = 1;
        for (let y = 40; y < height; y += 40) {
            octx.beginPath();
            octx.moveTo(0, y);
            octx.lineTo(width, y);
            octx.stroke();
        }
    }

    function drawPaperOutline () {
        if (demoMode) return;
        const points = shapes.getPaperOutline();
        if (!points || points.length < 3) return;

        octx.beginPath();
        octx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) octx.lineTo(points[i].x, points[i].y);
        octx.closePath();
        octx.strokeStyle = 'rgba(0,230,118,0.75)';
        octx.lineWidth = 2;
        octx.setLineDash([8, 6]);
        octx.stroke();
        octx.setLineDash([]);
    }

    function drawShape (shape) {
        const active = pressedShapes.has(shape.id);
        const editing = editingShape?.id === shape.id;
        let strokeColor;
        let fillColor;

        if (active) {
            strokeColor = '#ff604f';
            fillColor = 'rgba(255,96,79,0.34)';
        } else if (editing) {
            strokeColor = '#f5c542';
            fillColor = 'rgba(245,197,66,0.22)';
        } else if (shape.type === 'circle') {
            strokeColor = 'rgba(24,130,73,0.95)';
            fillColor = 'rgba(34,160,92,0.18)';
        } else if (shape.isBlack) {
            strokeColor = 'rgba(69,78,63,0.95)';
            fillColor = 'rgba(32,37,29,0.45)';
        } else {
            strokeColor = 'rgba(52,93,139,0.95)';
            fillColor = 'rgba(61,123,187,0.16)';
        }

        octx.lineWidth = active || editing ? 4 : 2;
        octx.strokeStyle = strokeColor;
        octx.fillStyle = fillColor;

        if (shape.points && shape.points.length >= 3) {
            octx.beginPath();
            octx.moveTo(shape.points[0].x, shape.points[0].y);
            for (let i = 1; i < shape.points.length; i++) {
                octx.lineTo(shape.points[i].x, shape.points[i].y);
            }
            octx.closePath();
            octx.fill();
            octx.stroke();
        } else if (shape.type === 'circle') {
            octx.beginPath();
            octx.arc(shape.centerX, shape.centerY, shape.radius, 0, Math.PI * 2);
            octx.fill();
            octx.stroke();
        } else {
            octx.fillRect(shape.x, shape.y, shape.width, shape.height);
            octx.strokeRect(shape.x, shape.y, shape.width, shape.height);
        }

        drawShapeLabel(shape, active);
    }

    function drawShapeLabel (shape, active) {
        const x = shape.centerX || shape.x + shape.width / 2;
        const y = shape.centerY || shape.y + shape.height / 2;
        const shortcut = shortcutForShape(shape);
        const label = shortcut ? shape.note + '  [' + shortcut.toUpperCase() + ']' : shape.note;

        octx.save();
        // The overlay is CSS-mirrored with the video. Pre-mirroring only the
        // glyphs keeps note labels readable while geometry stays aligned.
        if (mirrored) {
            octx.translate(x * 2, 0);
            octx.scale(-1, 1);
        }
        octx.font = `bold ${active ? 22 : 17}px sans-serif`;
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        octx.strokeStyle = 'rgba(0,0,0,0.82)';
        octx.lineWidth = 4;
        octx.strokeText(label, x, y);
        octx.fillStyle = '#fff';
        octx.fillText(label, x, y);
        octx.restore();
    }

    /* ==============================================================
       Shape scanning and sample layout
       ============================================================== */
    $scanBtn.addEventListener('click', scanShapes);
    $sampleBtn.addEventListener('click', loadSampleLayout);

    async function scanShapes () {
        if (!visionReady || isScanning || demoMode) return;
        isScanning = true;
        $scanBtn.disabled = true;
        $scanBtn.textContent = 'Scanning…';
        announce('Scanning shapes.');
        closeEditor();
        stopActiveNotes();
        await new Promise(resolve => requestAnimationFrame(resolve));

        try {
            const raw = shapes.detect($video, showDebug ? $debugCanvas : null);
            currentRawShapes = raw;
            const assigned = notes.assignNotes(raw, +$octaveSlider.value);
            updateShapeCounts();

            $debugInfo.textContent =
                `Method: OpenCV\n${shapes.lastLog || '(no strategies ran)'}\n` +
                `Detected: ${raw.rectangles.length} rectangles, ${raw.circles.length} circles\n` +
                `Assigned: ${assigned.length} shapes\n` +
                assigned.map(shape =>
                    `  ${shape.id} → ${shape.note} (${shape.instrument})`
                ).join('\n');

            if (assigned.length === 0) {
                showStageHint('No playable shapes found. Improve lighting, darken the outlines, or load the sample.');
                announce('No playable shapes found.');
            } else {
                showStageHint('Layout ready. Tap with a fingertip, use the keyboard, or click a shape to edit it.');
                announce(`${assigned.length} playable shapes found.`);
            }
        } catch (error) {
            $debugInfo.textContent = 'Scan failed: ' + error.message;
            showStageHint('Scan failed. Open Debug for details, or load the sample layout.');
            announce('Shape scan failed.');
            console.error('[Scan] failed:', error);
        } finally {
            isScanning = false;
            $scanBtn.textContent = '🔍 Scan Shapes';
            $scanBtn.disabled = !visionReady;
        }
    }

    function loadSampleLayout () {
        stopActiveNotes();
        closeEditor();
        const raw = makeSampleShapes($overlay.width, $overlay.height);
        currentRawShapes = raw;
        notes.assignNotes(raw, +$octaveSlider.value);
        updateShapeCounts();
        $debugInfo.textContent = 'Sample layout loaded. Vision was not used.';
        showStageHint('Sample ready. Pointer, touch, and keyboard controls are active.');
        announce('Sample layout loaded with ' + notes.assignedShapes.length + ' playable shapes.');
    }

    function makeSampleShapes (width, height) {
        const rectangles = [];
        const circles = [];
        const pianoX = width * 0.08;
        const pianoY = height * 0.42;
        const whiteWidth = width * 0.115;
        const whiteHeight = height * 0.48;
        const gap = width * 0.006;

        for (let i = 0; i < 7; i++) {
            rectangles.push(rectangleShape(
                pianoX + i * (whiteWidth + gap),
                pianoY,
                whiteWidth,
                whiteHeight
            ));
        }

        for (const boundary of [1, 2, 4, 5, 6]) {
            const blackWidth = whiteWidth * 0.48;
            rectangles.push(rectangleShape(
                pianoX + boundary * (whiteWidth + gap) - blackWidth / 2,
                pianoY,
                blackWidth,
                whiteHeight * 0.52
            ));
        }

        for (let i = 0; i < 4; i++) {
            const radius = Math.min(width, height) * 0.075;
            const centerX = width * (0.22 + i * 0.19);
            const centerY = height * 0.19;
            circles.push({
                type: 'circle',
                centerX,
                centerY,
                radius,
                x: centerX - radius,
                y: centerY - radius,
                width: radius * 2,
                height: radius * 2,
                area: Math.PI * radius * radius,
            });
        }
        return { rectangles, circles };
    }

    function rectangleShape (x, y, width, height) {
        return {
            type: 'rectangle',
            x,
            y,
            width,
            height,
            centerX: x + width / 2,
            centerY: y + height / 2,
            area: width * height,
            points: [
                { x, y },
                { x: x + width, y },
                { x: x + width, y: y + height },
                { x, y: y + height },
            ],
        };
    }

    function updateShapeCounts () {
        const keyCount = notes.assignedShapes.filter(shape => shape.instrument === 'piano').length;
        const padCount = notes.assignedShapes.filter(shape => shape.instrument === 'drums').length;
        $keyCount.textContent = keyCount;
        $padCount.textContent = padCount;
        $shapeBadge.classList.toggle('hidden', keyCount + padCount === 0);
    }

    /* ==============================================================
       Controls
       ============================================================== */
    $autoScanBtn.addEventListener('click', () => setAutoScan(!autoScan));
    $mirrorBtn.addEventListener('click', () => setMirror(!mirrored));
    $switchCameraBtn.addEventListener('click', switchCamera);

    function setAutoScan (enabled) {
        autoScan = Boolean(enabled && visionReady && !demoMode);
        if (autoScanTimer) clearInterval(autoScanTimer);
        autoScanTimer = null;
        $autoScanBtn.textContent = autoScan ? 'Auto-scan: ON' : 'Auto-scan: OFF';
        $autoScanBtn.classList.toggle('active', autoScan);
        $autoScanBtn.setAttribute('aria-pressed', String(autoScan));

        if (autoScan) {
            scanShapes();
            autoScanTimer = setInterval(scanShapes, 8000);
        }
    }

    function setMirror (enabled, persist = true) {
        mirrored = Boolean(enabled);
        $video.classList.toggle('mirrored', mirrored);
        $overlay.classList.toggle('mirrored', mirrored);
        $mirrorBtn.textContent = mirrored ? 'Mirror: ON' : 'Mirror: OFF';
        $mirrorBtn.classList.toggle('active', mirrored);
        $mirrorBtn.setAttribute('aria-pressed', String(mirrored));
        if (persist) writeSetting('mirror', mirrored);
    }

    async function switchCamera () {
        if (!cameraStream || demoMode) return;
        const nextMode = facingMode === 'user' ? 'environment' : 'user';
        $switchCameraBtn.disabled = true;
        setStatus($cameraDot, $cameraStatusText, 'Switching camera', 'warn');

        try {
            const stream = await requestCamera(nextMode);
            await attachCameraStream(stream);
            facingMode = nextMode;
            setMirror(facingMode === 'user');
            if (visionReady) shapes.init($video.videoWidth, $video.videoHeight);
            currentRawShapes = null;
            notes.clear();
            updateShapeCounts();
            setStatus($cameraDot, $cameraStatusText, 'Camera live', 'ok');
            showStageHint('Camera switched. Scan the drawing again.');
        } catch (error) {
            setStatus($cameraDot, $cameraStatusText, 'Camera live', 'ok');
            announce('Could not switch cameras. The current camera is still active.');
            console.warn('[Camera] switch failed:', error);
        } finally {
            $switchCameraBtn.disabled = false;
        }
    }

    $octaveSlider.addEventListener('input', () => {
        $octaveVal.textContent = $octaveSlider.value;
        writeSetting('octave', $octaveSlider.value);
        if (currentRawShapes) {
            stopActiveNotes();
            notes.assignNotes(currentRawShapes, +$octaveSlider.value);
            updateShapeCounts();
        }
    });

    $sensitivitySlider.addEventListener('input', () => {
        $sensitivityVal.textContent = $sensitivitySlider.value;
        writeSetting('sensitivity', $sensitivitySlider.value);
    });

    $volumeSlider.addEventListener('input', () => {
        $volumeVal.textContent = $volumeSlider.value;
        audio.setVolume(+$volumeSlider.value / 100);
        writeSetting('volume', $volumeSlider.value);
    });

    $debugBtn.addEventListener('click', () => {
        showDebug = !showDebug;
        $debugPanel.classList.toggle('hidden', !showDebug);
        $debugBtn.classList.toggle('active', showDebug);
        $debugBtn.setAttribute('aria-expanded', String(showDebug));
    });

    function setCapabilityControls (ready) {
        $scanBtn.disabled = !ready;
        $autoScanBtn.disabled = !ready;
        $switchCameraBtn.disabled = demoMode || !cameraStream;
        $mirrorBtn.disabled = demoMode;
        $sampleBtn.disabled = !demoMode && !cameraStream;
        if (!ready) setAutoScan(false);
    }

    /* ==============================================================
       Pointer, keyboard, and shape editor
       ============================================================== */
    $overlay.addEventListener('pointerdown', event => {
        if (notes.assignedShapes.length === 0) return;
        $overlay.focus({ preventScroll: true });
        const point = overlayEventToVideoPx(event);
        const shape = interaction.hitTest(notes.assignedShapes, point.x, point.y, 0);
        if (shape) triggerShape(shape, TAP_SUSTAIN);
    });

    $overlay.addEventListener('click', event => {
        if (notes.assignedShapes.length === 0) return;
        const point = overlayEventToVideoPx(event);
        const shape = interaction.hitTest(notes.assignedShapes, point.x, point.y, 0);
        if (shape) openEditor(shape, event);
        else closeEditor();
    });

    document.addEventListener('keydown', event => {
        if (!running || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLTextAreaElement) return;

        if (event.key === 'Escape' && editingShape) {
            closeEditor();
            return;
        }

        const key = event.key.toLowerCase();
        const shape = keyboardShapeMap().get(key);
        if (!shape) return;
        event.preventDefault();
        heldKeyboard.set(key, shape.id);
        triggerShape(shape, shape.instrument === 'piano' ? null : TAP_SUSTAIN);
    });

    document.addEventListener('keyup', event => {
        const key = event.key.toLowerCase();
        const shapeId = heldKeyboard.get(key);
        if (!shapeId) return;
        heldKeyboard.delete(key);
        releaseShape(shapeId);
    });

    document.addEventListener('pointerdown', event => {
        if (editingShape && !$shapeEditor.contains(event.target) && event.target !== $overlay) {
            closeEditor();
        }
    });

    $editorClose.addEventListener('click', closeEditor);

    function keyboardShapeMap () {
        const map = new Map();
        const piano = notes.assignedShapes
            .filter(shape => shape.instrument === 'piano')
            .sort((a, b) => a.centerX - b.centerX);
        const drums = notes.assignedShapes
            .filter(shape => shape.instrument === 'drums')
            .sort((a, b) => a.centerX - b.centerX);
        piano.slice(0, PIANO_KEYS.length).forEach((shape, index) => map.set(PIANO_KEYS[index], shape));
        drums.slice(0, DRUM_KEYS.length).forEach((shape, index) => map.set(DRUM_KEYS[index], shape));
        return map;
    }

    function shortcutForShape (shape) {
        for (const [key, candidate] of keyboardShapeMap()) {
            if (candidate.id === shape.id) return key;
        }
        return '';
    }

    function overlayEventToVideoPx (event) {
        const rect = $overlay.getBoundingClientRect();
        const localX = (event.clientX - rect.left) * ($overlay.width / rect.width);
        return {
            x: mirrored ? $overlay.width - localX : localX,
            y: (event.clientY - rect.top) * ($overlay.height / rect.height),
        };
    }

    function openEditor (shape, clickEvent) {
        editingShape = shape;
        $shapeEditor.classList.remove('hidden');
        positionEditor(clickEvent);
        if (shape.instrument === 'piano') buildPianoEditor(shape);
        else buildDrumEditor(shape);
        setTimeout(() => $editorClose.focus(), 0);
    }

    function positionEditor (clickEvent) {
        const containerRect = $cameraContainer.getBoundingClientRect();
        let left = clickEvent.clientX - containerRect.left + 12;
        let top = clickEvent.clientY - containerRect.top + 12;
        const editorWidth = 280;
        const editorHeight = 300;
        left = Math.max(4, Math.min(left, containerRect.width - editorWidth - 8));
        top = Math.max(4, Math.min(top, containerRect.height - editorHeight - 8));
        $shapeEditor.style.left = left + 'px';
        $shapeEditor.style.top = top + 'px';
    }

    function closeEditor () {
        $shapeEditor.classList.add('hidden');
        editingShape = null;
    }

    function buildPianoEditor (shape) {
        const base = shape.note.replace(/\d+$/, '');
        const octave = parseInt(shape.note.match(/\d+$/)?.[0] ?? '4', 10);
        $editorTitle.textContent = 'Piano key — ' + shape.id;

        let html = '<div class="editor-section-label">Octave</div><div class="editor-grid">';
        for (let value = 2; value <= 6; value++) {
            html += `<button class="note-btn${value === octave ? ' selected' : ''}" ` +
                `data-action="set-octave" data-value="${value}">${value}</button>`;
        }
        html += '</div><div class="editor-section-label">Note</div><div class="editor-grid">';
        for (const note of ALL_NOTES) {
            html += `<button class="note-btn${note === base ? ' selected' : ''}${note.includes('#') ? ' sharp' : ''}" ` +
                `data-action="set-note" data-value="${note}">${note}</button>`;
        }
        html += '</div>' + removeShapeButton();
        $editorBody.innerHTML = html;

        bindEditorActions(shape);
    }

    function buildDrumEditor (shape) {
        $editorTitle.textContent = 'Drum pad — ' + shape.id;
        let html = '<div class="editor-section-label">Drum sound</div><div class="editor-grid">';
        for (const drum of DRUM_OPTIONS) {
            html += `<button class="note-btn drum-btn${drum === shape.note ? ' selected' : ''}" ` +
                `data-action="set-drum" data-value="${drum}">${drum}</button>`;
        }
        html += '</div>' + removeShapeButton();
        $editorBody.innerHTML = html;
        bindEditorActions(shape);
    }

    function removeShapeButton () {
        return '<button class="editor-remove" data-action="remove">Remove detection</button>';
    }

    function bindEditorActions (shape) {
        $editorBody.querySelectorAll('[data-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.action;
                if (action === 'remove') {
                    removeShape(shape);
                    return;
                }

                let nextNote = shape.note;
                if (action === 'set-note') {
                    const octave = shape.note.match(/\d+$/)?.[0] ?? '4';
                    nextNote = button.dataset.value + octave;
                } else if (action === 'set-octave') {
                    nextNote = shape.note.replace(/\d+$/, '') + button.dataset.value;
                } else if (action === 'set-drum') {
                    nextNote = button.dataset.value;
                }

                notes.setShapeNote(shape.id, nextNote);
                const previewId = '__preview_' + performance.now();
                audio.play(previewId, nextNote, shape.instrument);
                if (shape.instrument === 'piano') {
                    setTimeout(() => audio.stop(previewId), TAP_SUSTAIN);
                    buildPianoEditor(shape);
                } else {
                    buildDrumEditor(shape);
                }
            });
        });
    }

    function removeShape (shape) {
        notes.removeShape(shape.id);
        if (currentRawShapes) {
            const bucket = shape.type === 'circle' ? 'circles' : 'rectangles';
            currentRawShapes[bucket] = currentRawShapes[bucket].filter(raw =>
                Math.hypot(raw.centerX - shape.centerX, raw.centerY - shape.centerY) > 1
            );
        }
        releaseShape(shape.id);
        updateShapeCounts();
        closeEditor();
        announce('Shape removed. Scan again to restore detections.');
    }

    /* ==============================================================
       Layout, feedback, and helpers
       ============================================================== */
    function syncOverlay () {
        const sourceWidth = demoMode ? $overlay.width : $video.videoWidth;
        const sourceHeight = demoMode ? $overlay.height : $video.videoHeight;
        if (!sourceWidth || !sourceHeight) return;

        const container = $cameraContainer.getBoundingClientRect();
        const containerRatio = container.width / container.height;
        const sourceRatio = sourceWidth / sourceHeight;
        let renderWidth;
        let renderHeight;
        let offsetX;
        let offsetY;

        if (sourceRatio > containerRatio) {
            renderWidth = container.width;
            renderHeight = container.width / sourceRatio;
            offsetX = 0;
            offsetY = (container.height - renderHeight) / 2;
        } else {
            renderHeight = container.height;
            renderWidth = container.height * sourceRatio;
            offsetX = (container.width - renderWidth) / 2;
            offsetY = 0;
        }

        $overlay.style.left = offsetX + 'px';
        $overlay.style.top = offsetY + 'px';
        $overlay.style.width = renderWidth + 'px';
        $overlay.style.height = renderHeight + 'px';
    }

    function showNoteHUD (shape) {
        if (activeHUD.has(shape.id)) {
            clearTimeout(activeHUD.get(shape.id).timer);
            activeHUD.get(shape.id).element.remove();
        }
        const element = document.createElement('div');
        element.className = 'note-bubble' + (shape.instrument === 'drums' ? ' drum' : '');
        element.textContent = shape.note;
        $noteHUD.appendChild(element);
        const timer = setTimeout(() => {
            element.remove();
            activeHUD.delete(shape.id);
        }, 600);
        activeHUD.set(shape.id, { element, timer });
    }

    function showStageHint (message) {
        $stageHint.textContent = message;
        $stageHint.classList.toggle('hidden', !message);
    }

    function setLoading (message, visible) {
        $loadingText.textContent = message;
        $loadingOverlay.classList.toggle('hidden', !visible);
    }

    function setStatus (dot, text, message, state = '') {
        dot.classList.remove('ok', 'warn', 'err');
        if (state) dot.classList.add(state);
        text.textContent = message;
    }

    function announce (message) {
        $announcement.textContent = '';
        requestAnimationFrame(() => { $announcement.textContent = message; });
    }

    function initialiseAudio () {
        try {
            const ready = audio.init();
            audio.setVolume(+$volumeSlider.value / 100);
            return ready;
        } catch (error) {
            console.warn('[AudioEngine] unavailable:', error);
            return false;
        }
    }

    function initialiseSettings () {
        $octaveSlider.value = readSetting('octave', 4);
        $octaveVal.textContent = $octaveSlider.value;
        $sensitivitySlider.value = readSetting('sensitivity', 50);
        $sensitivityVal.textContent = $sensitivitySlider.value;
        $volumeSlider.value = readSetting('volume', 75);
        $volumeVal.textContent = $volumeSlider.value;
    }

    function readSetting (key, fallback) {
        try {
            const value = localStorage.getItem('paperPiano.' + key);
            if (value === null) return fallback;
            if (typeof fallback === 'boolean') return value === 'true';
            return value;
        } catch (error) {
            return fallback;
        }
    }

    function writeSetting (key, value) {
        try {
            localStorage.setItem('paperPiano.' + key, String(value));
        } catch (error) {
            // The app remains fully usable when storage is disabled.
        }
    }

    function cameraErrorMessage (error) {
        switch (error?.name) {
            case 'NotAllowedError':
            case 'SecurityError':
                return 'Camera permission was denied.';
            case 'NotFoundError':
            case 'OverconstrainedError':
                return 'No compatible camera was found.';
            case 'NotReadableError':
                return 'The camera is already in use by another application.';
            default:
                return error?.message || 'Unable to start the camera.';
        }
    }

    function waitForOpenCV () {
        if (typeof cv !== 'undefined' && typeof cv.Mat === 'function') {
            return Promise.resolve(true);
        }
        if (openCvPromise) return openCvPromise;

        openCvPromise = new Promise(resolve => {
            const script = document.getElementById('opencvScript');
            let settled = false;
            let poll = null;

            const finish = ready => {
                if (settled) return;
                settled = true;
                if (poll) clearInterval(poll);
                clearTimeout(timeout);
                if (!ready) openCvPromise = null;
                resolve(ready);
            };

            const timeout = setTimeout(() => finish(false), 20000);
            script?.addEventListener('error', () => finish(false), { once: true });

            poll = setInterval(() => {
                if (typeof cv === 'undefined') return;
                if (typeof cv.Mat === 'function') {
                    finish(true);
                    return;
                }
                if (typeof cv === 'function') {
                    clearInterval(poll);
                    Promise.resolve(cv())
                        .then(module => {
                            if (module) window.cv = module;
                            finish(typeof window.cv?.Mat === 'function');
                        })
                        .catch(() => finish(false));
                    return;
                }
                if (cv && !cv.onRuntimeInitialized) {
                    cv.onRuntimeInitialized = () => finish(typeof cv.Mat === 'function');
                }
            }, 250);
        });
        return openCvPromise;
    }

    function updateFPS () {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime < 1000) return;
        $fpsEl.textContent = frameCount + ' fps';
        frameCount = 0;
        lastFpsTime = now;
    }

    window.addEventListener('resize', syncOverlay);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopActiveNotes();
        else audio.resume();
    });
    window.addEventListener('beforeunload', () => endSession(false));

})();
