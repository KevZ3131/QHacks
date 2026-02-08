"""
PaperPiano — Main application (Python / OpenCV version).

Flow:
  1. Open camera
  2. Live camera feed, user presses keys to act
  3. 's' = Scan shapes, 'd' = Demo shapes, 'p' = Play/Stop, 'c' = Clear
  4. Play mode: hand tracking active, fingertip-in-shape → note plays
  5. Click a shape in ready mode → opens note picker to assign note

Shapes:
  • Rectangles → piano / organ / synth (selected instrument)
  • Circles   → drums (kick / snare / hihat / tom)

Controls:
  s  — Scan paper for drawn shapes
  d  — Add demo shapes (piano + drums)
  p  — Toggle play mode
  c  — Clear all shapes
  1/2/3 — Switch instrument (piano / organ / synth) for rectangles
  q / ESC — Quit
  Click shape (ready mode) — Open note picker
"""

import sys
import os
import time
import math
import threading
import cv2
import numpy as np

from audio_engine import AudioEngine
from shape_detector import ShapeDetector, INNER_SCALE
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
DRUM_SOUNDS = ['kick', 'snare', 'hihat', 'tom']
DRUM_NOTES  = ['C', 'D', 'E', 'F']   # frequencies for the drum oscillators
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

        # Note picker state
        self._picker_shape_id: str | None = None  # shape being edited
        self._picker_buttons: list[dict] = []     # clickable note regions

        # Camera
        self.cap = None
        self.frame_w = 640
        self.frame_h = 480
        self.mirrored = False  # top-down camera doesn't need mirror

        # FPS
        self._fps_frames = 0
        self._fps_last = time.time()
        self.fps = 0

        # Throttle
        self._last_detect_time = 0.0
        self._detect_interval = 0.05

    # ── Initialisation ──────────────────────────────────────────────────────
    def init(self):
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

        self.audio.init()
        print('Audio engine ready ✓')
        self.tracker.init()

        if self.ocr.ready:
            print('OCR ready ✓')
        else:
            print('OCR unavailable — default notes will be used.')

        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
        cv2.setMouseCallback(WINDOW_NAME, self._on_mouse)
        self._print_help()

    # ── Main loop ───────────────────────────────────────────────────────────
    def run(self):
        self.init()

        while True:
            ret, frame = self.cap.read()
            if not ret:
                print('Camera read failed.')
                break

            if self.mirrored:
                frame = cv2.flip(frame, 1)

            # Hand detection in play mode (throttled)
            if self.state == 'playing' and self.tracker.ready:
                now = time.time()
                if now - self._last_detect_time >= self._detect_interval:
                    self._last_detect_time = now
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    self.last_hand_res = self.tracker.detect(rgb)
                    self._update_hand_collision()

            display = self._draw(frame)
            cv2.imshow(WINDOW_NAME, display)
            self._count_fps()

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:
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
            elif key == 27 and self._picker_shape_id:
                self._close_picker()

        self._cleanup()

    # ── Hand collision (tap-based, inner boundary) ──────────────────────
    def _update_hand_collision(self):
        if not self.last_hand_res:
            return

        # Detect tap gestures (finger pressing down toward table)
        taps = self.tracker.get_tapping_tips(
            self.last_hand_res, self.frame_w, self.frame_h
        )

        for tap in taps:
            shape = self._shape_in_inner(tap['x'], tap['y'])
            if shape and shape['id'] not in self.active_shapes:
                preset = self._preset_for(shape)
                self.audio.note_on(shape['id'], shape['note'], preset)
                shape['is_active'] = True
                self.active_shapes.add(shape['id'])

                # Auto-release after a short duration
                sid = shape['id']
                def release(sid=sid):
                    time.sleep(0.3)
                    self.audio.note_off(sid)
                    self.active_shapes.discard(sid)
                    for s in self.shapes:
                        if s['id'] == sid:
                            s['is_active'] = False
                threading.Thread(target=release, daemon=True).start()

    def _preset_for(self, shape: dict) -> str:
        """Return the audio preset for a shape based on its type."""
        if shape.get('shape_type') == 'circle':
            return shape.get('drum_preset', 'kick')
        return self.audio.preset_name  # current instrument for rectangles & triangles

    # ── Scanning ────────────────────────────────────────────────────────────
    def _scan_shapes(self, frame: np.ndarray):
        self._status('Scanning for shapes…')
        found = self.detector.detect(frame)

        if not found:
            self._status('No shapes found. Draw rectangles, circles, or triangles on paper.')
            return

        self._status(f'Found {len(found)} shape(s)…')

        drum_idx = 0
        note_idx = 0
        for i, s in enumerate(found):
            s['color'] = SHAPE_COLORS[i % len(SHAPE_COLORS)]
            s['is_active'] = False

            if s['shape_type'] == 'circle':
                s['drum_preset'] = DRUM_SOUNDS[drum_idx % len(DRUM_SOUNDS)]
                s['note'] = DRUM_NOTES[drum_idx % len(DRUM_NOTES)]
                s['label'] = s['drum_preset'].upper()
                drum_idx += 1
            elif s['shape_type'] == 'triangle':
                s['note'] = self.ocr.get_default_note(note_idx)
                s['label'] = s['note']
                note_idx += 1
            else:
                # Try OCR for rectangles
                crop = self.detector.extract_region(frame, s['rect'])
                if crop is not None and self.ocr.ready:
                    note = self.ocr.recognize(crop)
                    s['note'] = note or self.ocr.get_default_note(note_idx)
                else:
                    s['note'] = self.ocr.get_default_note(note_idx)
                s['label'] = s['note']
                note_idx += 1

        self.shapes = found
        self._status(f'{len(found)} shape(s) found. Click to set notes, press P to play.')

    # ── Demo shapes ─────────────────────────────────────────────────────────
    def _add_demo_shapes(self):
        W, H = self.frame_w, self.frame_h

        # Piano keys (rectangles) — bottom row
        notes = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
        gap = 4
        kw = (W - gap * (len(notes) + 1)) // len(notes)
        kh = int(H * 0.25)
        start_y = int(H * 0.68)
        start_x = (W - (kw * len(notes) + gap * (len(notes) - 1))) // 2

        self.shapes = []
        for i, note in enumerate(notes):
            x = start_x + i * (kw + gap)
            # Inner boundary for rectangles
            iw = int(kw * INNER_SCALE)
            ih = int(kh * INNER_SCALE)
            ix = x + (kw - iw) // 2
            iy = start_y + (kh - ih) // 2
            self.shapes.append({
                'id': f'shape_{i}',
                'rect': {'x': x, 'y': start_y, 'width': kw, 'height': kh},
                'points': [],
                'note': note,
                'label': note,
                'color': SHAPE_COLORS[i % len(SHAPE_COLORS)],
                'center': {'x': x + kw // 2, 'y': start_y + kh // 2},
                'is_active': False,
                'area': kw * kh,
                'shape_type': 'rect',
                'inner': {'type': 'rect', 'x': ix, 'y': iy,
                          'width': iw, 'height': ih},
            })

        # Drum pads (circles) — top row
        drums = [('kick', 'C'), ('snare', 'D'), ('hihat', 'E'), ('tom', 'F')]
        radius = min(int(H * 0.08), int(W / (len(drums) * 3)))
        drum_y = int(H * 0.50)
        drum_spacing = W // (len(drums) + 1)

        for j, (drum_name, drum_note) in enumerate(drums):
            cx = drum_spacing * (j + 1)
            idx = len(notes) + j
            ir = int(radius * INNER_SCALE)
            self.shapes.append({
                'id': f'shape_{idx}',
                'rect': {'x': cx - radius, 'y': drum_y - radius,
                         'width': radius * 2, 'height': radius * 2},
                'points': [],
                'note': drum_note,
                'label': drum_name.upper(),
                'color': SHAPE_COLORS[idx % len(SHAPE_COLORS)],
                'center': {'x': cx, 'y': drum_y},
                'circle_center': {'x': cx, 'y': drum_y},
                'radius': radius,
                'is_active': False,
                'area': int(math.pi * radius * radius),
                'shape_type': 'circle',
                'drum_preset': drum_name,
                'inner': {'type': 'circle', 'cx': cx, 'cy': drum_y, 'radius': ir},
            })

        # Triangle demo shapes — middle row
        tri_notes = ['C#', 'D#', 'F#']
        tri_size = int(min(W, H) * 0.07)
        tri_y_center = int(H * 0.35)
        tri_spacing = W // (len(tri_notes) + 1)
        for k, tn in enumerate(tri_notes):
            tcx = tri_spacing * (k + 1)
            # Equilateral triangle points
            p1 = (tcx, tri_y_center - tri_size)
            p2 = (tcx - tri_size, tri_y_center + tri_size)
            p3 = (tcx + tri_size, tri_y_center + tri_size)
            tri_pts = [p1, p2, p3]
            # Inner triangle
            inner_pts = [(int(tcx + (px - tcx) * INNER_SCALE),
                          int(tri_y_center + (py - tri_y_center) * INNER_SCALE))
                         for px, py in tri_pts]
            idx = len(notes) + len(drums) + k
            bx = min(p[0] for p in tri_pts)
            by = min(p[1] for p in tri_pts)
            bw = max(p[0] for p in tri_pts) - bx
            bh = max(p[1] for p in tri_pts) - by
            self.shapes.append({
                'id': f'shape_{idx}',
                'rect': {'x': bx, 'y': by, 'width': bw, 'height': bh},
                'points': tri_pts,
                'tri_points': tri_pts,
                'note': tn,
                'label': tn,
                'color': SHAPE_COLORS[idx % len(SHAPE_COLORS)],
                'center': {'x': tcx, 'y': tri_y_center},
                'is_active': False,
                'area': int(0.5 * abs((p2[0]-p1[0])*(p3[1]-p1[1]) - (p3[0]-p1[0])*(p2[1]-p1[1]))),
                'shape_type': 'triangle',
                'inner': {'type': 'triangle', 'points': inner_pts},
            })

        self._status('Demo ready — piano + drums + triangles. Press P to play!')

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
        self._close_picker()
        self.state = 'playing'
        if self.tracker.ready:
            self._status('🎵 Play mode — touch the shapes with your finger!')
        else:
            self._status('🎵 Play mode — click shapes to play.')

    def _exit_play(self):
        self.audio.note_off_all()
        self.active_shapes.clear()
        for s in self.shapes:
            s['is_active'] = False
        self.state = 'ready'
        self._status('Stopped. Click a shape to set its note, press P to play again.')

    def _clear_shapes(self):
        self.audio.note_off_all()
        self.active_shapes.clear()
        self.shapes = []
        self.state = 'ready'
        self._close_picker()
        self._status('Cleared. Press S to scan or D for demo.')

    # ── Note Picker ─────────────────────────────────────────────────────────
    def _open_picker(self, shape_id: str):
        """Open a note picker overlay for the given shape."""
        shape = next((s for s in self.shapes if s['id'] == shape_id), None)
        if not shape:
            return

        self._picker_shape_id = shape_id
        self._picker_buttons = []

        if shape.get('shape_type') == 'circle':
            options = [(d.upper(), d) for d in DRUM_SOUNDS]
        else:  # rect or triangle
            options = [(n, n) for n in ALL_NOTES]

        # Build button grid for the picker panel
        cols = 4
        rows = math.ceil(len(options) / cols)
        btn_w, btn_h = 60, 36
        pad = 6
        panel_w = cols * (btn_w + pad) + pad
        panel_h = rows * (btn_h + pad) + pad + 30  # +30 for title
        panel_x = (self.frame_w - panel_w) // 2
        panel_y = (self.frame_h - panel_h) // 2

        self._picker_panel = {
            'x': panel_x, 'y': panel_y,
            'w': panel_w, 'h': panel_h,
        }

        for i, (label, value) in enumerate(options):
            r = i // cols
            c = i % cols
            bx = panel_x + pad + c * (btn_w + pad)
            by = panel_y + 30 + pad + r * (btn_h + pad)
            self._picker_buttons.append({
                'x': bx, 'y': by, 'w': btn_w, 'h': btn_h,
                'label': label, 'value': value,
            })

    def _close_picker(self):
        self._picker_shape_id = None
        self._picker_buttons = []

    def _picker_click(self, mx: int, my: int) -> bool:
        """Handle click inside the picker. Returns True if consumed."""
        if not self._picker_shape_id:
            return False

        for btn in self._picker_buttons:
            if (btn['x'] <= mx <= btn['x'] + btn['w'] and
                    btn['y'] <= my <= btn['y'] + btn['h']):
                shape = next(
                    (s for s in self.shapes if s['id'] == self._picker_shape_id), None
                )
                if shape:
                    if shape.get('shape_type') == 'circle':
                        shape['drum_preset'] = btn['value']
                        shape['label'] = btn['label']
                        self._status(f"Drum → {btn['label']}")
                    else:  # rect or triangle
                        shape['note'] = btn['value']
                        shape['label'] = btn['label']
                        self._status(f"Note → {btn['label']}")
                self._close_picker()
                return True

        # Click outside the panel → close picker
        p = self._picker_panel
        if not (p['x'] <= mx <= p['x'] + p['w'] and
                p['y'] <= my <= p['y'] + p['h']):
            self._close_picker()
            return True

        return True  # consumed, inside panel but not on a button

    # ── Mouse callback ──────────────────────────────────────────────────────
    def _on_mouse(self, event, x, y, flags, param):
        if event != cv2.EVENT_LBUTTONDOWN:
            return

        # If picker is open, handle it first
        if self._picker_shape_id:
            self._picker_click(x, y)
            return

        shape = self._shape_at(x, y)
        if not shape:
            return

        if self.state == 'playing':
            # Click-to-play
            preset = self._preset_for(shape)
            self.audio.note_on(shape['id'], shape['note'], preset)
            shape['is_active'] = True
            def release():
                time.sleep(0.25)
                self.audio.note_off(shape['id'])
                shape['is_active'] = False
            threading.Thread(target=release, daemon=True).start()
        else:
            # Open note picker
            self._open_picker(shape['id'])

    # ── Hit testing ─────────────────────────────────────────────────────────
    def _shape_at(self, x: float, y: float) -> dict | None:
        """Hit test against OUTER boundary (for mouse clicks / UI)."""
        for s in self.shapes:
            if s.get('shape_type') == 'circle':
                cc = s.get('circle_center', s['center'])
                r = s.get('radius', s['rect']['width'] // 2)
                dx = x - cc['x']
                dy = y - cc['y']
                if dx * dx + dy * dy <= r * r:
                    return s
            elif s.get('shape_type') == 'triangle':
                tri = s.get('tri_points')
                if tri and ShapeDetector._point_in_triangle(
                    (x, y), tri[0], tri[1], tri[2]
                ):
                    return s
            else:
                r = s['rect']
                if (r['x'] <= x <= r['x'] + r['width'] and
                        r['y'] <= y <= r['y'] + r['height']):
                    return s
        return None

    def _shape_in_inner(self, x: float, y: float) -> dict | None:
        """Hit test against INNER boundary only (for finger tap triggers)."""
        for s in self.shapes:
            if ShapeDetector.point_in_inner(s, x, y):
                return s
        return None

    # ── Drawing ─────────────────────────────────────────────────────────────
    def _draw(self, frame: np.ndarray) -> np.ndarray:
        display = frame.copy()

        for s in self.shapes:
            color = s['color']
            is_active = s['is_active']
            label = s.get('label', s['note'])
            stype = s.get('shape_type', 'rect')

            if stype == 'circle':
                self._draw_circle_shape(display, s, color, is_active, label)
            elif stype == 'triangle':
                self._draw_triangle_shape(display, s, color, is_active, label)
            else:
                self._draw_rect_shape(display, s, color, is_active, label)

        # Hand skeleton
        if self.state == 'playing' and self.last_hand_res and self.last_hand_res.hand_landmarks:
            for hand_lms in self.last_hand_res.hand_landmarks:
                pts = [(int(lm.x * self.frame_w), int(lm.y * self.frame_h)) for lm in hand_lms]
                for a, b in HAND_CONNECTIONS:
                    cv2.line(display, pts[a], pts[b], (136, 255, 0), 1, cv2.LINE_AA)
                for ti in [4, 8, 12, 16, 20]:
                    r = 6 if ti == 8 else 4
                    col = (136, 255, 0) if ti == 8 else (100, 200, 0)
                    cv2.circle(display, pts[ti], r, col, -1, cv2.LINE_AA)
                    cv2.circle(display, pts[ti], r, (255, 255, 255), 1, cv2.LINE_AA)

        # Note picker overlay
        if self._picker_shape_id:
            self._draw_picker(display)

        # Status bar
        bar_h = 32
        cv2.rectangle(display, (0, 0), (self.frame_w, bar_h), (30, 30, 30), -1)
        cv2.putText(display, self._status_msg, (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
        fps_text = f'{self.fps} FPS'
        tw = cv2.getTextSize(fps_text, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)[0][0]
        cv2.putText(display, fps_text, (self.frame_w - tw - 8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 136), 1, cv2.LINE_AA)

        # Help
        help_text = 'S:Scan D:Demo P:Play/Stop C:Clear 1/2/3:Inst Q:Quit'
        cv2.putText(display, help_text, (8, self.frame_h - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.33, (150, 150, 150), 1, cv2.LINE_AA)

        return display

    def _draw_rect_shape(self, display, s, color, is_active, label):
        r = s['rect']
        x, y, w, h = r['x'], r['y'], r['width'], r['height']

        overlay = display.copy()
        alpha = 0.65 if is_active else 0.25
        cv2.rectangle(overlay, (x, y), (x + w, y + h), color, -1)
        cv2.addWeighted(overlay, alpha, display, 1 - alpha, 0, display)

        border_color = (255, 255, 255) if is_active else color
        thickness = 3 if is_active else 2
        cv2.rectangle(display, (x, y), (x + w, y + h), border_color, thickness)
        if is_active:
            cv2.rectangle(display, (x - 3, y - 3), (x + w + 3, y + h + 3), color, 2)

        # Inner boundary (dashed-style thin rect)
        inner = s.get('inner')
        if inner and inner['type'] == 'rect':
            ix, iy = inner['x'], inner['y']
            iw, ih = inner['width'], inner['height']
            inner_col = (255, 255, 255) if is_active else (180, 180, 180)
            cv2.rectangle(display, (ix, iy), (ix + iw, iy + ih), inner_col, 1)

        # "PIANO" type label (small, top-left)
        cv2.putText(display, 'PIANO', (x + 4, y + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (200, 200, 200), 1, cv2.LINE_AA)

        # Note label centered
        fz = max(0.5, min(w, h) * 0.015)
        text_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fz, 2)[0]
        tx = x + (w - text_size[0]) // 2
        ty = y + (h + text_size[1]) // 2
        cv2.putText(display, label, (tx + 1, ty + 1), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, (0, 0, 0), 3, cv2.LINE_AA)
        text_col = (255, 255, 255) if is_active else (240, 240, 240)
        cv2.putText(display, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, text_col, 2, cv2.LINE_AA)

    def _draw_circle_shape(self, display, s, color, is_active, label):
        cc = s.get('circle_center', s['center'])
        radius = s.get('radius', s['rect']['width'] // 2)
        cx, cy = cc['x'], cc['y']

        overlay = display.copy()
        alpha = 0.65 if is_active else 0.25
        cv2.circle(overlay, (cx, cy), radius, color, -1, cv2.LINE_AA)
        cv2.addWeighted(overlay, alpha, display, 1 - alpha, 0, display)

        border_color = (255, 255, 255) if is_active else color
        thickness = 3 if is_active else 2
        cv2.circle(display, (cx, cy), radius, border_color, thickness, cv2.LINE_AA)
        if is_active:
            cv2.circle(display, (cx, cy), radius + 4, color, 2, cv2.LINE_AA)

        # Inner boundary circle
        inner = s.get('inner')
        if inner and inner['type'] == 'circle':
            inner_col = (255, 255, 255) if is_active else (180, 180, 180)
            cv2.circle(display, (inner['cx'], inner['cy']), inner['radius'],
                       inner_col, 1, cv2.LINE_AA)

        # "DRUM" type label
        cv2.putText(display, 'DRUM', (cx - 18, cy - radius + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (200, 200, 200), 1, cv2.LINE_AA)

        # Drum name centered
        fz = max(0.4, radius * 0.02)
        text_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fz, 2)[0]
        tx = cx - text_size[0] // 2
        ty = cy + text_size[1] // 2
        cv2.putText(display, label, (tx + 1, ty + 1), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, (0, 0, 0), 3, cv2.LINE_AA)
        text_col = (255, 255, 255) if is_active else (240, 240, 240)
        cv2.putText(display, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, text_col, 2, cv2.LINE_AA)

    def _draw_triangle_shape(self, display, s, color, is_active, label):
        tri = s.get('tri_points')
        if not tri or len(tri) < 3:
            return
        pts_np = np.array(tri, dtype=np.int32)
        cx_t = sum(p[0] for p in tri) // 3
        cy_t = sum(p[1] for p in tri) // 3

        # Fill
        overlay = display.copy()
        alpha = 0.65 if is_active else 0.25
        cv2.fillPoly(overlay, [pts_np], color)
        cv2.addWeighted(overlay, alpha, display, 1 - alpha, 0, display)

        # Outer border
        border_color = (255, 255, 255) if is_active else color
        thickness = 3 if is_active else 2
        cv2.polylines(display, [pts_np], True, border_color, thickness, cv2.LINE_AA)
        if is_active:
            # Glow
            scale_pts = np.array(
                [(int(cx_t + (p[0] - cx_t) * 1.06), int(cy_t + (p[1] - cy_t) * 1.06))
                 for p in tri], dtype=np.int32)
            cv2.polylines(display, [scale_pts], True, color, 2, cv2.LINE_AA)

        # Inner boundary
        inner = s.get('inner')
        if inner and inner['type'] == 'triangle':
            inner_pts = np.array(inner['points'], dtype=np.int32)
            inner_col = (255, 255, 255) if is_active else (180, 180, 180)
            cv2.polylines(display, [inner_pts], True, inner_col, 1, cv2.LINE_AA)

        # Type label
        cv2.putText(display, 'TRI', (cx_t - 12, cy_t - 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, (200, 200, 200), 1, cv2.LINE_AA)

        # Note label centered
        fz = 0.55
        text_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fz, 2)[0]
        tx = cx_t - text_size[0] // 2
        ty = cy_t + text_size[1] // 2
        cv2.putText(display, label, (tx + 1, ty + 1), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, (0, 0, 0), 3, cv2.LINE_AA)
        text_col = (255, 255, 255) if is_active else (240, 240, 240)
        cv2.putText(display, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX,
                    fz, text_col, 2, cv2.LINE_AA)

    def _draw_picker(self, display):
        """Draw the note/drum picker overlay."""
        p = self._picker_panel

        # Dim background
        overlay = display.copy()
        cv2.rectangle(overlay, (0, 0), (self.frame_w, self.frame_h), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.5, display, 0.5, 0, display)

        # Panel background
        cv2.rectangle(display,
                      (p['x'], p['y']),
                      (p['x'] + p['w'], p['y'] + p['h']),
                      (40, 40, 40), -1)
        cv2.rectangle(display,
                      (p['x'], p['y']),
                      (p['x'] + p['w'], p['y'] + p['h']),
                      (100, 100, 100), 2)

        # Title
        shape = next((s for s in self.shapes if s['id'] == self._picker_shape_id), None)
        title = 'Select Drum Sound' if shape and shape.get('shape_type') == 'circle' else 'Select Note'
        cv2.putText(display, title, (p['x'] + 10, p['y'] + 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

        # Buttons
        current = shape.get('drum_preset' if shape.get('shape_type') == 'circle' else 'note', '') if shape else ''
        for btn in self._picker_buttons:
            is_selected = btn['value'] == current
            bg = (80, 180, 80) if is_selected else (70, 70, 70)
            cv2.rectangle(display,
                          (btn['x'], btn['y']),
                          (btn['x'] + btn['w'], btn['y'] + btn['h']),
                          bg, -1)
            cv2.rectangle(display,
                          (btn['x'], btn['y']),
                          (btn['x'] + btn['w'], btn['y'] + btn['h']),
                          (150, 150, 150), 1)

            tsz = cv2.getTextSize(btn['label'], cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)[0]
            tx = btn['x'] + (btn['w'] - tsz[0]) // 2
            ty = btn['y'] + (btn['h'] + tsz[1]) // 2
            cv2.putText(display, btn['label'], (tx, ty),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

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
        print('║  D — Demo (piano + drums + triangles) ║')
        print('║  P — Toggle play mode                ║')
        print('║  C — Clear all shapes                ║')
        print('║  1/2/3 — Piano / Organ / Synth       ║')
        print('║  Click shape — Set note / drum       ║')
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
