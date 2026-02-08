# Paper Piano — Draw & Play

> Draw instruments on paper, point your camera, and play them with your fingers in real time.

---

## High-Level Architecture

```
┌──────────┐   frames    ┌──────────────┐  landmarks  ┌────────────────┐
│  Camera   │───────────▶│ MediaPipe     │────────────▶│ NoteRecognizer │
│ (WebRTC)  │            │ Hands         │             │ (overlap logic)│
└──────────┘             └──────────────┘             └───────┬────────┘
      │                                                       │ pressed shapes
      │  on demand        ┌──────────────┐  shapes            ▼
      └──────────────────▶│ OpenCV.js    │───────────▶ NoteRecognizer
                          │ ShapeDetector│                    │
                          └──────────────┘                    │ note-on / note-off
                                                              ▼
                                                      ┌──────────────┐
                                                      │ AudioEngine  │
                                                      │ (Web Audio)  │
                                                      └──────────────┘
```

| Component | Technology | Purpose |
|---|---|---|
| **Camera** | WebRTC `getUserMedia` | Live video feed |
| **Hand tracking** | MediaPipe Hands (Solutions API) | 21-landmark hand skeleton at ~30 fps |
| **Shape detection** | OpenCV.js (contours, polygon approx) | Rectangles → keys, Circles → drum pads |
| **Note mapping** | Custom JS | Classify white/black keys, assign notes, resolve overlaps |
| **Audio** | Web Audio API (oscillators + noise) | Real-time piano & drum synthesis |

### Why a web app?

* Zero install — works in any modern browser
* WebRTC + Web Audio API give native access to camera and low-latency sound
* MediaPipe & OpenCV.js run entirely client-side (no server needed)
* Easily shareable via a URL for a hackathon demo

---

## Computer Vision Approach

### Shape Detection (OpenCV.js)

1. **Downsample** the video frame to 640 px wide (speed over fidelity).
2. **Grayscale → Gaussian blur → Adaptive threshold** produces a clean binary image of dark ink on white paper.
3. **Morphological close** merges broken contour segments from imperfect drawings.
4. **`findContours`** extracts external contours only.
5. For each contour:
   * **`approxPolyDP`** simplifies vertices.
   * **Circularity** = 4π · area / perimeter². High → circle. Low → rectangle.
   * **Extent** = contour area / bounding-rect area. Rejects noisy blobs.

### Handling imperfect & overlapping shapes

* `approxPolyDP` with ε = 3 % of perimeter tolerates wobbly lines.
* Rectangles are accepted with 4–7 vertices (hand-drawn corners are never perfect).
* Circles need circularity ≥ 0.55 — generous enough for ovals.

### White vs Black Key Classification

* Keys are sorted by area. Anything below 65 % of the largest rectangle is classified as a **black key**.
* A fallback checks height ratios if area alone isn't conclusive.
* Black keys receive `priority = 1`; white keys `priority = 0`.

### Finger Press Detection (MediaPipe Hands)

* Every frame, the index/middle/ring/pinky/thumb tips' normalised (x, y) are mapped to pixel coordinates.
* A **point-in-shape** test (rectangle bounds or circle radius) determines if a fingertip overlaps a shape.
* An extra **sensitivity padding** (slider-controlled, 0–30 px) enlarges the hit area for ease of use.
* **Overlap resolution**: if a tip is inside both a white and black key, the black key wins (higher priority, smaller area).

---

## Audio Generation

### Piano

Each key triggers a multi-partial **additive synthesiser**:

* **Fundamental** (triangle wave) + **2nd, 3rd, 5th harmonics** (sine) with decreasing gain.
* An **ADSR envelope** (attack 8 ms, decay 180 ms, sustain at 0.30, release 120 ms) shapes the amplitude for a natural piano-like timbre.
* Multiple notes can sound simultaneously — a `DynamicsCompressor` node prevents clipping.

### Drums

Synthesised one-shot sounds:

| Pad | Technique |
|---|---|
| **Kick** | Sine oscillator with fast pitch sweep 150 → 35 Hz |
| **Snare** | White noise burst (HP-filtered) + triangle body tone |
| **Hi-hat** | HP-filtered noise, very short (50 ms) |
| **Tom** | Sine with pitch drop, medium decay |
| **Crash** | Band-pass noise, long decay (0.5 s) |

---

## Running Locally

### Prerequisites

* A modern browser (Chrome / Edge recommended)
* A working webcam
* A simple local HTTP server (required for camera access — `file://` won't work)

### Quick start

```bash
# Navigate to the project folder
cd PaperPiano

# Option 1: Python
python -m http.server 8000

# Option 2: Node / npx
npx serve .

# Option 3: VS Code Live Server extension
# Right-click index.html → "Open with Live Server"
```

Then open **http://localhost:8000** (or the port shown).

### Steps

1. Click **Start Camera** and grant camera permission.
2. Wait for the three status dots (Camera / Hands / Vision) to turn green.
3. Draw **rectangles** (piano keys) and/or **circles** (drum pads) on white paper with a dark marker.
4. Point the camera at the paper and click **Scan Shapes**.
5. The detected shapes appear as colored overlays with note labels.
6. Press the shapes with your fingertips — notes play instantly!

### Controls

| Control | Effect |
|---|---|
| **Scan Shapes** | Run shape detection on the current frame |
| **Auto: ON/OFF** | Re-scan every 2.5 s automatically |
| **Mirror** | Flip the video horizontally (useful for front-facing webcam) |
| **Octave** | Shift the piano mapping (2–6) |
| **Sensitivity** | Expand the touch hit-area |
| **Debug** | Show the thresholded image and shape assignments |

---

## Performance Considerations

* **Hand tracking** is the bottleneck (~20–40 ms per frame). Using `modelComplexity: 0` (Lite) keeps latency under 40 ms on most devices.
* **Shape detection** is expensive (~50–100 ms) but only runs on demand (button click or 2.5 s interval), never every frame.
* **Audio latency** is minimal — the Web Audio API schedules oscillator start within 1–2 ms of the call.
* The processing canvas is **downsampled to 640 px** wide to keep contour detection fast.
* Rendering uses a simple 2-D canvas overlay — no heavy GPU compositing.

---

## Limitations & Future Improvements

### Current limitations

* **No OCR** — notes are auto-assigned left-to-right, not read from handwriting inside shapes.
* **Perspective distortion** — works best with the camera directly above the paper. Angled views may distort bounding boxes.
* **Lighting sensitivity** — adaptive thresholding helps, but very uneven lighting or glossy paper can confuse contour detection.
* **No velocity sensitivity** — all notes play at the same volume (MediaPipe z-depth is not reliable enough for pressure mapping).
* **OpenCV.js load time** — the library is ~8 MB and can take a few seconds to download on slower connections.

### Possible improvements

* **Tesseract.js OCR** to read handwritten note names inside shapes.
* **Perspective correction** — detect the paper quadrilateral and warp to a top-down view before scanning.
* **WebGL compute** or **TensorFlow.js** custom model for faster, more accurate shape classification.
* **Sampled audio** — replace oscillator synth with actual piano / drum samples for higher fidelity.
* **Multi-octave layout** detection based on physical key arrangement.
* **Web Worker** for OpenCV processing to keep the main thread free.
* **PWA packaging** for offline use and "install to home screen" on mobile.

---

## Tech Stack

* **HTML5 / CSS3 / Vanilla JS** — no build tools, no frameworks
* **MediaPipe Hands** — real-time hand landmark detection
* **OpenCV.js 4.9** — computer-vision contour analysis
* **Web Audio API** — low-latency sound synthesis
* **WebRTC** — live camera access

---

*Built for QHacks 2026*
