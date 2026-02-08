"""
PaperPiano — Main application (Python / OpenCV version).

Flow:
  1. Open camera
  2. Live camera feed, user presses keys to act
  3. 's' = Scan shapes, 'd' = Demo shapes, 'p' = Play/Stop, 'c' = Clear
  4. Play mode: hand tracking active, fingertip-in-shape → note plays
  5. Click a shape in ready mode → cycle through notes

Controls:
  s  — Scan paper for drawn shapes
  d  — Add demo piano keys
  p  — Toggle play mode
  c  — Clear all shapes
  1/2/3 — Switch instrument (piano / organ / synth)
  q / ESC — Quit
  Click shape (ready mode) — Cycle note assignment
"""

import sys
import time
import cv2
import numpy as np

from audio_engine import AudioEngine
from shape_detector import ShapeDetector
from note_recognizer import NoteRecognizer
from hand_tracker import HandTracker, HAND_CONNECTIONS

# ── Shape colours (BGR for OpenCV) ──────────────────────────────────────────
SHAPE_COLORS_HEX = [
    '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB',
    '#0ABDE3', '#A29BFE', '#FD79A8', '#00B894',
    '#6C5CE7', '#E17055', '#00CEC9', '#FDCB6E',
]

def hex_to_bgr(h: str) -> tuple[int, int, int]:
    h = h.lstrip('#')
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (b, g, r)

SHAPE_COLORS = [hex_to_bgr(c) for c in SHAPE_COLORS_HEX]

ALL_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
WINDOW_NAME = 'Paper Piano'


class PaperPianoApp:
    def __init__(self):
        # Modules
        self.audio = AudioEngine()
        self.detector = ShapeDetector()
        self.ocr = NoteRecognizer()
        self.tracker = HandTracker()

        # State
        self.shapes: list[dict] = []
        self.active_shapes: set[str] = set()
        self.state = 'ready'   # ready | playing
        self.last_hand_res = None

        # Camera
        self.cap = None
        self.frame_w = 640
        self.frame_h = 480
        self.mirrored = True  # default webcam is front-facing

        # FPS
        self._fps_frames = 0
        self._fps_last = time.time()
        self.fps = 0

        # Throttle
        self._last_detect_time = 0.0
        self._detect_interval = 0.05  # 50 ms ≈ 20 fps

    # ── Initialisation ──────────────────────────────────────────────────────
    def init(self):
        """Open camera and initialise all modules."""
        print('Opening camera…')
        self.cap = cv2.VideoCapture(0)
        if not self.cap.isOpened():
            print('ERROR: Cannot open camera.')
            sys.exit(1)

        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        self.cap.set(cv2.CAP_PROP_FPS, 30)

        self.frame_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.frame_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        print(f'Camera ready: {self.frame_w}×{self.frame_h}')

        # Audio
        self.audio.init()
        print('Audio engine ready ✓')

        # Hand tracking
        self.tracker.init()

        # OCR
        if self.ocr.ready:
            print('OCR ready ✓')
        else:
            print('OCR unavailable (pytesseract not installed). Default notes will be used.')

        # Window + mouse callback
        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
        cv2.setMouseCallback(WINDOW_NAME, self._on_mouse)

        self._print_help()

    # ── Main loop ───────────────────────────────────────────────────────────
    def run(self):
        """Main application loop."""
        self.init()

        while True:
            ret, frame = self.cap.read()
            if not ret:
                print('Camera read failed.')
                break

            # Mirror for front-facing camera
            if self.mirrored:
                frame = cv2.flip(frame, 1)

            # Run hand detection in play mode (throttled)
            if self.state == 'playing' and self.tracker.ready:
                now = time.time()
                if now - self._last_detect_time >= self._detect_interval:
                    self._last_detect_time = now
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    self.last_hand_res = self.tracker.detect(rgb)
                    self._update_hand_collision()

            # Draw overlays
            display = self._draw(frame)

            # Show
            cv2.imshow(WINDOW_NAME, display)

            # FPS
            self._count_fps()

            # Key handling
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:  # q or ESC
                break
            elif key == ord('s'):
                self._scan_shapes(frame)
            elif key == ord('d'):
                self._add_demo_shapes()
            elif key == ord('p'):
                self._toggle_play()
            elif key == ord('c'):
                self._clear_shapes()
            elif key == ord('1'):
                self.audio.set_preset('piano')
                self._status('Instrument: Piano')
            elif key == ord('2'):
                self.audio.set_preset('organ')
                self._status('Instrument: Organ')
            elif key == ord('3'):
                self.audio.set_preset('synth')
                self._status('Instrument: Synth')

        self._cleanup()

    # ── Hand collision detection ────────────────────────────────────────────
    def _update_hand_collision(self):
        if not self.last_hand_res:
            return

        fingers = self.tracker.get_finger_tips(
            self.last_hand_res, self.frame_w, self.frame_h
        )
        now_active = set()

        for hand in fingers:
            for tip in hand['tips']:
                shape = self._shape_at(tip['x'], tip['y'])
                if shape:
                    now_active.add(shape['id'])
                    if shape['id'] not in self.active_shapes:
                        self.audio.note_on(shape['id'], shape['note'])

        # Release shapes no longer active
        for sid in self.active_shapes:
            if sid not in now_active:
                self.audio.note_off(sid)

        for s in self.shapes:
            s['is_active'] = s['id'] in now_active
        self.active_shapes = now_active

    # ── Shape scanning ──────────────────────────────────────────────────────
    def _scan_shapes(self, frame: np.ndarray):
        self._status('Scanning for shapes…')
        found = self.detector.detect(frame)

        if not found:
            self._status('No shapes found. Draw dark-outlined rectangles on white paper.')
            return

        self._status(f'Found {len(found)} shape(s) — running OCR…')

        for i, s in enumerate(found):
            s['color'] = SHAPE_COLORS[i % len(SHAPE_COLORS)]
            s['is_active'] = False

            # Try OCR
            crop = self.detector.extract_region(frame, s['rect'])
            if crop is not None and self.ocr.ready:
                note = self.ocr.recognize(crop)
                s['note'] = note or self.ocr.get_default_note(i)
            else:
                s['note'] = self.ocr.get_default_note(i)

        self.shapes = found
        self._status(f'{len(found)} shape(s) found. Click a shape to change note, press P to play.')

    # ── Demo shapes ─────────────────────────────────────────────────────────
    def _add_demo_shapes(self):
        W, H = self.frame_w, self.frame_h
        notes = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
        gap = 4
        kw = (W - gap * (len(notes) + 1)) // len(notes)
        kh = int(H * 0.28)
        start_y = int(H * 0.65)
        start_x = (W - (kw * len(notes) + gap * (len(notes) - 1))) // 2

        self.shapes = []
        for i, note in enumerate(notes):
            x = start_x + i * (kw + gap)
            self.shapes.append({
                'id': f'shape_{i}',
                'rect': {'x': x, 'y': start_y, 'width': kw, 'height': kh},
                'points': [],
                'note': note,
                'color': SHAPE_COLORS[i % len(SHAPE_COLORS)],
                'center': {'x': x + kw // 2, 'y': start_y + kh // 2},
                'is_active': False,
                'area': kw * kh,
            })

        self._status('Demo piano ready. Press P to play!')

    # ── Play / Stop ─────────────────────────────────────────────────────────
    def _toggle_play(self):
        if self.state == 'playing':
            self._exit_play()
        else:
            self._enter_play()

    def _enter_play(self):
        if not self.shapes:
            self._status('No shapes. Press S to scan or D for demo first.')
            return
        self.state = 'playing'
        if self.tracker.ready:
            self._status('🎵 Play mode — touch the shapes with your finger!')
        else:
            self._status('🎵 Play mode — click shapes to play (hand tracking unavailable).')

    def _exit_play(self):
        self.audio.note_off_all()
        self.active_shapes.clear()
        for s in self.shapes:
            s['is_active'] = False
        self.state = 'ready'
        self._status('Stopped. Click a shape to edit, press P to play again.')

    def _clear_shapes(self):
        self.audio.note_off_all()
        self.active_shapes.clear()
        self.shapes = []
        self.state = 'ready'
        self._status('Cleared. Press S to scan or D for demo.')

    # ── Mouse callback ──────────────────────────────────────────────────────
    def _on_mouse(self, event, x, y, flags, param):
        if event != cv2.EVENT_LBUTTONDOWN:
            return

        shape = self._shape_at(x, y)
        if not shape:
            return

        if self.state == 'playing':
            # Click-to-play
            self.audio.note_on(shape['id'], shape['note'])
            shape['is_active'] = True
            # Schedule note-off after 250ms via a flag checked in the loop
            import threading
            def release():
                time.sleep(0.25)
                self.audio.note_off(shape['id'])
                shape['is_active'] = False
            threading.Thread(target=release, daemon=True).start()
        else:
            # Cycle note assignment
            current = shape['note']
            idx = ALL_NOTES.index(current) if current in ALL_NOTES else -1
            shape['note'] = ALL_NOTES[(idx + 1) % len(ALL_NOTES)]
            self._status(f"Shape → {shape['note']}")

    # ── Hit testing ─────────────────────────────────────────────────────────
    def _shape_at(self, x: float, y: float) -> dict | None:
        for s in self.shapes:
            r = s['rect']
            if r['x'] <= x <= r['x'] + r['width'] and r['y'] <= y <= r['y'] + r['height']:
                return s
        return None

    # ── Drawing ─────────────────────────────────────────────────────────────
    def _draw(self, frame: np.ndarray) -> np.ndarray:
        display = frame.copy()

        # Draw shapes
        for s in self.shapes:
            r = s['rect']
            color = s['color']
            is_active = s['is_active']
            note = s['note']

            x, y, w, h = r['x'], r['y'], r['width'], r['height']

            # Semi-transparent fill
            overlay = display.copy()
            alpha = 0.65 if is_active else 0.25
            cv2.rectangle(overlay, (x, y), (x + w, y + h), color, -1)
            cv2.addWeighted(overlay, alpha, display, 1 - alpha, 0, display)

            # Border
            border_color = (255, 255, 255) if is_active else color
            thickness = 3 if is_active else 2
            cv2.rectangle(display, (x, y), (x + w, y + h), border_color, thickness)

            # Glow border when active
            if is_active:
                cv2.rectangle(display, (x - 3, y - 3), (x + w + 3, y + h + 3), color, 2)

            # Note label
            font = cv2.FONT_HERSHEY_SIMPLEX
            fz = max(0.5, min(w, h) * 0.015)
            text_size = cv2.getTextSize(note, font, fz, 2)[0]
            tx = x + (w - text_size[0]) // 2
            ty = y + (h + text_size[1]) // 2

            # Shadow
            cv2.putText(display, note, (tx + 1, ty + 1), font, fz, (0, 0, 0), 3, cv2.LINE_AA)
            # Main text
            text_col = (255, 255, 255) if is_active else (240, 240, 240)
            cv2.putText(display, note, (tx, ty), font, fz, text_col, 2, cv2.LINE_AA)

        # Draw hand skeleton
        if self.state == 'playing' and self.last_hand_res and self.last_hand_res.hand_landmarks:
            for hand_lms in self.last_hand_res.hand_landmarks:
                pts = [(int(lm.x * self.frame_w), int(lm.y * self.frame_h)) for lm in hand_lms]

                # Connections
                for a, b in HAND_CONNECTIONS:
                    cv2.line(display, pts[a], pts[b], (136, 255, 0), 1, cv2.LINE_AA)

                # Fingertips
                tip_ids = [4, 8, 12, 16, 20]
                for ti in tip_ids:
                    r = 6 if ti == 8 else 4
                    col = (136, 255, 0) if ti == 8 else (100, 200, 0)
                    cv2.circle(display, pts[ti], r, col, -1, cv2.LINE_AA)
                    cv2.circle(display, pts[ti], r, (255, 255, 255), 1, cv2.LINE_AA)

        # Status bar
        bar_h = 32
        cv2.rectangle(display, (0, 0), (self.frame_w, bar_h), (30, 30, 30), -1)
        cv2.putText(display, self._status_msg, (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
        fps_text = f'{self.fps} FPS'
        tw = cv2.getTextSize(fps_text, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0][0]
        cv2.putText(display, fps_text, (self.frame_w - tw - 8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 136), 1, cv2.LINE_AA)

        # Help hint at bottom
        help_text = 'S:Scan  D:Demo  P:Play/Stop  C:Clear  1/2/3:Instrument  Q:Quit'
        cv2.putText(display, help_text, (8, self.frame_h - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (150, 150, 150), 1, cv2.LINE_AA)

        return display

    # ── FPS counter ─────────────────────────────────────────────────────────
    def _count_fps(self):
        self._fps_frames += 1
        now = time.time()
        if now - self._fps_last >= 1.0:
            self.fps = self._fps_frames
            self._fps_frames = 0
            self._fps_last = now

    # ── Helpers ─────────────────────────────────────────────────────────────
    _status_msg = 'Ready — press S to scan, D for demo'

    def _status(self, msg: str):
        self._status_msg = msg
        print(f'[PaperPiano] {msg}')

    def _print_help(self):
        print('\n╔══════════════════════════════════════╗')
        print('║         🎹 Paper Piano               ║')
        print('╠══════════════════════════════════════╣')
        print('║  S — Scan paper for shapes           ║')
        print('║  D — Add demo piano keys             ║')
        print('║  P — Toggle play mode                ║')
        print('║  C — Clear all shapes                ║')
        print('║  1/2/3 — Piano / Organ / Synth       ║')
        print('║  Click shape — Cycle note            ║')
        print('║  Q / ESC — Quit                      ║')
        print('╚══════════════════════════════════════╝\n')

    def _cleanup(self):
        self.audio.note_off_all()
        self.audio.destroy()
        self.tracker.destroy()
        if self.cap:
            self.cap.release()
        cv2.destroyAllWindows()
        print('Bye!')


# ── Launch ──────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    app = PaperPianoApp()
    try:
        app.run()
    except KeyboardInterrupt:
        app._cleanup()
