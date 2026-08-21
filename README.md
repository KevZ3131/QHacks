# Paper Band

> Draw instruments on paper, point your camera, and play them with your fingers in real time.

https://github.com/user-attachments/assets/b5359d2a-ccfd-45c1-9dd5-7456fb068898

---

## What It Does

Paper Band turns any sheet of paper into a musical instrument. Draw rectangles for piano keys and circles for drum pads with a marker, point your webcam at the paper, and tap the shapes with your fingertips to play sounds — no special hardware required.

No camera handy? **Try Sample Layout** opens a complete playable instrument with pointer, touch, and keyboard controls. The camera and vision features fail independently, so a slow or unavailable model does not lock up the rest of the app.

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
                       Tap / pointer / keyboard → AudioEngine plays sound
```

| Layer | Technology | Role |
|---|---|---|
| **Camera** | WebRTC `getUserMedia` | Live video feed |
| **Hand tracking** | [MediaPipe Hands](https://google.github.io/mediapipe/solutions/hands) | Real-time 21-landmark hand skeleton |
| **Shape detection** | [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html) | Contour analysis to find rectangles & circles |
| **Note mapping** | Custom JS (`NoteRecognizer`) | Assigns notes (C, D, E…) left-to-right, resolves overlaps |
| **Audio** | Web Audio API | Synthesized piano tones & drum hits |
| **Interaction** | Custom `InteractionEngine` | Tap velocity, polygon hit-testing, overlap priority |

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
│   ├── interaction-engine.js # Tap detection and precise hit-testing
│   └── audio-engine.js     # Web Audio synthesizer (piano + drums)
├── scripts/
│   └── dev-server.js       # Dependency-free localhost server + live reload
├── package.json            # npm scripts
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

This starts the dependency-free local server at **http://localhost:8000** with live reload. Set `PORT` to use a different port.

> **Note:** Camera access requires `http://localhost` or HTTPS — opening `index.html` as a `file://` URL won't work.

### Usage

1. Click **Start Camera** and allow camera permissions, or choose **Try Sample Layout** for camera-free mode.
2. Wait for the three status dots (Camera / Hands / Vision) to turn green.
3. Draw **rectangles** (piano keys) and/or **circles** (drum pads) on white paper with a dark marker.
4. Point the camera at the paper and click **Scan Shapes**.
5. Detected shapes appear as colored overlays with note labels.
6. Tap the shapes with your fingertips to play. Pointer/touch and keyboard controls work too.

Click a detected shape to preview it, change its note or drum sound, or remove a false detection. Custom sounds are matched back to nearby shapes on later scans during the same session.

### Controls

| Control | Effect |
|---|---|
| **Scan Shapes** | Run shape detection on the current frame |
| **Auto: ON/OFF** | Re-scan automatically every 8 seconds |
| **Mirror** | Flip the front-camera view while keeping note labels readable |
| **Switch Camera** | Move between front and rear cameras when available |
| **Load Sample** | Load a known-good 12-key / 4-pad layout without replacing the camera session |
| **End Session** | Stop every camera track, clear the stage, and return to the start screen |
| **Octave** (2–6) | Shift the piano note range |
| **Sensitivity** | Expand the fingertip hit-area |
| **Volume** | Set the master Web Audio output level |
| **Debug** | Show the thresholded binary image and detection log |

Keyboard piano controls are `A W S E D F T G Y H U J`; drum pads use `1` through `6`. Octave, sensitivity, volume, and mirror preferences are stored locally in the browser.

---

## Technical Details

### Shape Detection Pipeline (OpenCV.js)

1. Downsample frame to 640 px wide
2. Grayscale → Gaussian blur → multi-strategy thresholding (adaptive, Otsu, Canny)
3. Morphological close to bridge broken pen strokes
4. `findContours` → `approxPolyDP` for vertex simplification
5. Classify by **circularity** (4π·area/perimeter²), vertex count, extent, and aspect ratio
6. Reject contours that do not resemble a hand-drawn rectangle or circle
7. Paper isolation: detect the largest bright quadrilateral as the paper boundary, only look for shapes inside it

### Hand Tracking (MediaPipe Hands)

- Tracks up to 2 hands at ~30 fps
- Reports only **extended** fingertips (curled fingers are filtered out using distance-from-wrist vs. PIP joint comparison)
- Tap detection via vertical velocity threshold with cooldown to prevent retriggering
- The status bar distinguishes a loaded tracker from a hand that is actually visible

### Audio Synthesis (Web Audio API)

**Piano:** Additive synthesis — triangle fundamental + sine harmonics (2nd, 3rd, 5th partials) shaped by an ADSR envelope. A `DynamicsCompressor` prevents clipping when multiple notes sound simultaneously.

**Drums:** One-shot synthesized hits — kick (pitch-swept sine), snare (noise burst + body tone), hi-hat (HP-filtered noise), tom (pitch-drop sine), crash (bandpass noise).

## Testing

```bash
npm test
```

The deterministic suite covers note assignment, black-key classification, custom-note preservation, polygon hit-testing, tap cooldowns, overlap resolution, and contour filtering. Camera behavior still needs a manual Chrome or Edge check with a real webcam because headless fake-camera pipelines do not reproduce hardware frame delivery reliably.

---

## Limitations

- Works best with the camera **directly above** the paper (perspective distortion reduces accuracy)
- Requires good, even lighting — glossy paper or strong shadows may confuse detection
- Notes do not yet use tap velocity for per-note dynamics
- OpenCV.js is ~8 MB and may take a few seconds to load on slow connections
- Camera and hand-tracking verification remains hardware/browser dependent

---

## Tech Stack

- **HTML / CSS / Vanilla JS** — no frameworks, no build step
- **MediaPipe Hands** — ML-based hand landmark detection (CDN)
- **OpenCV.js** — computer vision contour analysis (CDN)
- **Web Audio API** — low-latency sound synthesis
- **WebRTC** — live camera access
