# Paper Band

> Draw instruments on paper, point your camera, and play them with your fingers in real time.

https://github.com/user-attachments/assets/b5359d2a-ccfd-45c1-9dd5-7456fb068898

---

## What It Does

Paper Band turns any sheet of paper into a musical instrument. Draw rectangles for piano keys and circles for drum pads with a marker, point your webcam at the paper, and tap the shapes with your fingertips to play sounds — no special hardware required.

---

## How It Works

```
Camera (WebRTC)
      │
      ├── on every frame ──▶ MediaPipe Hands ──▶ Fingertip positions
      │
      └── on "Scan" click ──▶ OpenCV.js ──▶ Detected shapes
                                                  │
                                     NoteRecognizer assigns notes
                                                  │
                              Finger + Shape match → AudioEngine plays sound
```

| Layer | Technology | Role |
|---|---|---|
| **Camera** | WebRTC `getUserMedia` | Live video feed |
| **Hand tracking** | [MediaPipe Hands](https://google.github.io/mediapipe/solutions/hands) | Real-time 21-landmark hand skeleton |
| **Shape detection** | [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) | Contour analysis to find rectangles & circles |
| **Note mapping** | Custom JS (`NoteRecognizer`) | Assigns notes (C, D, E…) left-to-right, resolves overlaps |
| **Audio** | Web Audio API | Synthesized piano tones & drum hits |

---

## Project Structure

```
PaperPiano/
├── index.html              # Single-page app entry point
├── css/
│   └── style.css           # All styles
├── js/
│   ├── main.js             # App controller — boot, render loop, UI wiring
│   ├── hand-tracker.js     # MediaPipe Hands wrapper
│   ├── shape-detector.js   # OpenCV.js contour analysis pipeline
│   ├── note-recognizer.js  # Maps shapes → musical notes
│   └── audio-engine.js     # Web Audio synthesizer (piano + drums)
├── package.json            # npm scripts & dev dependencies
├── .gitignore
└── README.md
```

---

## Getting Started

### Prerequisites

- A modern browser (**Chrome** or **Edge** recommended)
- A webcam
- [Node.js](https://nodejs.org/) (for the dev server)

### Install & Run

```bash
git clone <repo-url>
cd PaperPiano
npm install
npm start
```

This starts a local server at **http://localhost:8000** with live-reload.

> **Note:** Camera access requires `http://localhost` or HTTPS — opening `index.html` as a `file://` URL won't work.

### Usage

1. Click **Start Camera** and allow camera permissions.
2. Wait for the three status dots (Camera / Hands / Vision) to turn green.
3. Draw **rectangles** (piano keys) and/or **circles** (drum pads) on white paper with a dark marker.
4. Point the camera at the paper and click **Scan Shapes**.
5. Detected shapes appear as colored overlays with note labels.
6. Tap the shapes with your fingertips to play!

### Controls

| Control | Effect |
|---|---|
| **Scan Shapes** | Run shape detection on the current frame |
| **Auto: ON/OFF** | Re-scan automatically every 8 seconds |
| **Mirror** | Flip video horizontally (useful for front-facing cameras) |
| **Octave** (2–6) | Shift the piano note range |
| **Sensitivity** | Expand the fingertip hit-area |
| **Debug** | Show the thresholded binary image and detection log |

---

## Technical Details

### Shape Detection Pipeline (OpenCV.js)

1. Downsample frame to 640 px wide
2. Grayscale → Gaussian blur → multi-strategy thresholding (adaptive, Otsu, Canny)
3. Morphological close to bridge broken pen strokes
4. `findContours` → `approxPolyDP` for vertex simplification
5. Classify by **circularity** (4π·area/perimeter²): high → circle, low → rectangle
6. Filter by area, aspect ratio, and extent to reject noise
7. Paper isolation: detect the largest bright quadrilateral as the paper boundary, only look for shapes inside it

### Hand Tracking (MediaPipe Hands)

- Tracks up to 2 hands at ~30 fps
- Reports only **extended** fingertips (curled fingers are filtered out using distance-from-wrist vs. PIP joint comparison)
- Tap detection via vertical velocity threshold with cooldown to prevent retriggering

### Audio Synthesis (Web Audio API)

**Piano:** Additive synthesis — triangle fundamental + sine harmonics (2nd, 3rd, 5th partials) shaped by an ADSR envelope. A `DynamicsCompressor` prevents clipping when multiple notes sound simultaneously.

**Drums:** One-shot synthesized hits — kick (pitch-swept sine), snare (noise burst + body tone), hi-hat (HP-filtered noise), tom (pitch-drop sine), crash (bandpass noise).

---

## Limitations

- Works best with the camera **directly above** the paper (perspective distortion reduces accuracy)
- Requires good, even lighting — glossy paper or strong shadows may confuse detection
- All notes play at the same volume (no velocity sensitivity)
- OpenCV.js is ~8 MB and may take a few seconds to load on slow connections

---

## Tech Stack

- **HTML / CSS / Vanilla JS** — no frameworks, no build step
- **MediaPipe Hands** — ML-based hand landmark detection (CDN)
- **OpenCV.js** — computer vision contour analysis (CDN)
- **Web Audio API** — low-latency sound synthesis
- **WebRTC** — live camera access
