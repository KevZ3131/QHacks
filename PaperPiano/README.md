# 🎹 Paper Piano

**Draw instruments on paper and play them with your hands — in real time, in a browser.**

Paper Piano uses your webcam to detect shapes drawn on paper, reads the note names written inside them, and plays musical notes when you touch the shapes with your fingers. It turns any piece of paper into a playable instrument.

---

## High-Level Architecture

```
┌────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Camera    │────▶│  Shape Detection  │────▶│ Note Labels │
│  (WebRTC)  │     │  (OpenCV.js)      │     │ (Tesseract) │
└────────────┘     └──────────────────┘     └─────────────┘
       │                                           │
       ▼                                           ▼
┌────────────────┐     ┌──────────────┐     ┌─────────────┐
│  Hand Tracking  │────▶│   Collision   │────▶│   Audio     │
│  (MediaPipe)   │     │   Detection   │     │  (Web Audio) │
└────────────────┘     └──────────────┘     └─────────────┘
```

| Layer            | Technology                                             | Purpose                               |
| ---------------- | ------------------------------------------------------ | ------------------------------------- |
| Camera           | WebRTC `getUserMedia`                                  | Live video feed                       |
| Shape Detection  | OpenCV.js (adaptive threshold + contour approximation) | Find drawn rectangles on paper        |
| Note Recognition | Tesseract.js (OCR, single-word mode)                   | Read note names (C, D#, F, etc.)      |
| Hand Tracking    | MediaPipe Tasks-Vision `HandLandmarker`                | Real-time finger position tracking    |
| Audio Synthesis  | Web Audio API (multi-oscillator + ADSR envelope)       | Low-latency musical note playback     |
| Rendering        | Canvas 2D                                              | Overlay shapes, labels, hand skeleton |

### Why a Web App?

- **Zero install** — works in any modern browser (Chrome, Edge, Firefox).
- **Instant camera access** via WebRTC.
- **Web Audio API** delivers ≈5–20 ms audio latency (interactive-quality).
- **MediaPipe runs in-browser** with GPU acceleration via WebAssembly + WebGL.
- **Perfect for demos** — share a URL, not a binary.

---

## Computer Vision Approach

### Shape Detection (OpenCV.js)

1. Capture a single frame when the user clicks **Scan Paper**.
2. Convert to grayscale → Gaussian blur (5×5) → adaptive threshold (Gaussian, block 15, C=4).
3. Morphological close + dilate to fill gaps in hand-drawn lines.
4. `findContours` with `RETR_EXTERNAL` to get outer contours only.
5. `approxPolyDP` to simplify each contour to a polygon.
6. Filter: 4–10 vertices, area between 0.2%–25% of frame, reasonable aspect ratio.
7. Sort shapes left-to-right, top-to-bottom for consistent note assignment.

### Note Recognition (Tesseract.js)

1. For each detected shape, crop the interior (with padding to exclude borders).
2. Scale up 2–4× and binarise (threshold at luminance 130) for high-contrast input.
3. Run Tesseract in single-word mode with a whitelist of `A-G` and `#`.
4. Parse the result into a valid note name (e.g., `C`, `F#`, `Bb`).
5. **Fallback**: if OCR fails or is unavailable, assign C-D-E-F-G-A-B sequentially.
6. Users can click any shape to manually reassign its note.

### Finger Press Detection (MediaPipe)

1. `HandLandmarker` runs on every frame in `VIDEO` mode at up to 30 fps.
2. For each detected hand, extract all 5 fingertip landmarks (indices 4, 8, 12, 16, 20).
3. Convert normalised (0–1) coordinates to canvas pixel space.
4. Test each fingertip against each shape's bounding rectangle.
5. **Note-on** when a fingertip enters a shape that wasn't active; **note-off** when it leaves.
6. Multiple fingers and hands are supported simultaneously.

---

## Audio Generation Approach

- **Web Audio API** with `OscillatorNode` for zero-download, zero-decode latency.
- Each note is synthesised from **3 oscillators** (fundamental + octave harmonic + sub-harmonic) for a richer timbre.
- **ADSR envelope** via `GainNode` scheduling:
  - Attack: 8 ms (near-instant onset)
  - Decay: 250 ms
  - Sustain: held while finger is in shape
  - Release: 200 ms smooth fade-out
- A `DynamicsCompressorNode` prevents clipping when many notes play simultaneously.
- `AudioContext` is created with `latencyHint: 'interactive'` for minimum buffer size.
- Three instrument presets: **Piano** (triangle wave), **Organ** (sine harmonics), **Synth** (sawtooth + detuning).

---

## How to Run

### Prerequisites

- A modern browser (Chrome 90+ or Edge recommended for best MediaPipe support).
- A webcam or phone camera.
- Python 3 (for the local server) — or any static HTTP server.

### Steps

```bash
# 1. Clone / download into a folder
cd PaperPiano

# 2. Start a local HTTP server (required for ES modules + camera)
python -m http.server 8000

# 3. Open in your browser
#    Navigate to: http://localhost:8000
```

> **Important:** Camera access requires `localhost` or HTTPS. Opening `index.html` directly via `file://` will not work.

### Quick Test (No Paper Needed)

1. Open the app → wait for models to load (10–30 seconds first time; cached after).
2. Click **Demo Shapes** — seven piano keys appear on screen.
3. Click **Play** → move your hand in front of the camera.
4. Your fingertips touching the on-screen key regions will play notes!

### Full Paper Mode

1. Draw dark-outlined rectangles on white paper with a marker.
2. Write a note name inside each: **C**, **D**, **E**, **F**, **G**, **A**, **B** (or **C#**, **Db**, etc.).
3. Hold paper up to the camera (or place on desk with camera looking down).
4. Click **Scan Paper** → shapes are detected and notes are read.
5. Click any shape to correct its note if OCR was wrong.
6. Click **Play** → touch the paper shapes with your finger!

---

## Performance Considerations

| Concern                  | Mitigation                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- |
| **Audio latency**        | `latencyHint: 'interactive'` + OscillatorNode (no decode step) → ~5–20 ms    |
| **Shape detection cost** | Run once on scan, not per-frame; shapes are cached                           |
| **OCR cost**             | Run once per shape after detection; cached results                           |
| **Hand tracking FPS**    | MediaPipe uses GPU via WebGL/WebGPU; typically 25–45 fps on laptops          |
| **Memory (OpenCV)**      | All cv.Mat objects tracked and explicitly deleted to prevent WASM heap leaks |
| **Large downloads**      | Libraries loaded async + cached by browser; loading screen shown             |

---

## Limitations

1. **Handwriting OCR** is unreliable for messy or small text. The manual note-assignment UI mitigates this.
2. **Shape detection** works best with dark, closed rectangles on clean white paper. Complex or overlapping shapes may not be detected.
3. **Finger-shape mapping** is 2D only — it checks if the fingertip's projection overlaps the shape's projection. Extreme camera angles may reduce accuracy.
4. **Paper must stay still** after scanning. If you move the paper, the cached shape positions become invalid (re-scan to fix).
5. **First load** downloads ~15 MB of models (OpenCV WASM + Tesseract language data + MediaPipe hand model). Subsequent loads are cached.
6. **Mobile browser support** varies — Chrome on Android works best; Safari on iOS has limited MediaPipe support.

---

## Future Improvements

- **Continuous shape tracking** using optical flow or feature matching to handle paper movement.
- **Custom ML model** (e.g., a small CNN) trained specifically for handwritten note recognition, replacing Tesseract.
- **Velocity sensitivity** based on finger approach speed (faster = louder).
- **Multi-octave support** — recognise octave numbers (C4, C5) or detect shape size → octave mapping.
- **Sampled instruments** — load real piano/drum samples instead of oscillator synthesis.
- **MIDI output** — send detected notes as MIDI messages to external synthesisers.
- **Collaborative mode** — multiple people around a table, each scanning their section.
- **Shape types** — circles for drum pads, triangles for effects, rectangles for melodic notes.
- **Recording & playback** — record performances and export as audio or MIDI.
- **AR overlay** — use WebXR to project the overlay directly onto the paper.

---

## Project Structure

```
PaperPiano/
├── index.html              Main page (loads libraries + app module)
├── css/
│   └── style.css           Dark theme UI styling
├── js/
│   ├── main.js             App orchestrator (state, events, render loop)
│   ├── audio-engine.js     Web Audio synthesis + ADSR + presets
│   ├── shape-detector.js   OpenCV.js contour-based shape detection
│   ├── note-recognizer.js  Tesseract.js OCR + note parsing
│   └── hand-tracker.js     MediaPipe hand landmark tracking
└── README.md               This file
```

---

## License

MIT — built for QHacks 2026. Have fun making music! 🎶
