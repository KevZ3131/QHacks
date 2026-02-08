"""
HandTracker — Real-time hand landmark detection using MediaPipe Tasks Vision.
Tracks fingertip positions and detects tap gestures for top-down camera setups.

Tap detection works by tracking each fingertip's z-coordinate (depth) over time.
A tap is registered when a finger moves downward (z increases) past a threshold
and the fingertip is over a target area. Uses a per-finger state machine:
  UP → PRESSING (z moving down) → DOWN (tap triggered) → UP (z moving back up)
"""

import os
import time
import urllib.request

import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    HandLandmarker,
    HandLandmarkerOptions,
    RunningMode,
)


# Fingertip landmark indices: thumb=4, index=8, middle=12, ring=16, pinky=20
TIP_IDS = [4, 8, 12, 16, 20]

# Hand skeleton connections for drawing
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),           # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),           # index
    (5, 9), (9, 10), (10, 11), (11, 12),      # middle
    (9, 13), (13, 14), (14, 15), (15, 16),    # ring
    (13, 17), (17, 18), (18, 19), (19, 20),   # pinky
    (0, 17),                                    # palm base
]

MODEL_URL = (
    'https://storage.googleapis.com/mediapipe-models/'
    'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
)
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'hand_landmarker.task')


class HandTracker:
    def __init__(self):
        self.landmarker: HandLandmarker | None = None
        self.ready = False
        self._last_result = None
        self._timestamp_ms = 0

        # Tap detection state
        self._finger_z: dict[tuple, tuple[float, float]] = {}  # (hand, tip) → (z, time)
        self._tap_cooldown: dict[tuple, float] = {}  # (hand, tip) → last_tap_time
        self._last_cleanup = 0.0

    def init(self):
        """Initialize MediaPipe HandLandmarker (Tasks API)."""
        try:
            # Download model if not cached locally
            if not os.path.exists(MODEL_PATH):
                print('Downloading hand-tracking model…')
                urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
                print('Model downloaded ✓')

            options = HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=MODEL_PATH),
                running_mode=RunningMode.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.5,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self.landmarker = HandLandmarker.create_from_options(options)
            self.ready = True
            print('Hand tracking ready ✓')
        except Exception as e:
            print(f'HandTracker init failed: {e}')
            self.ready = False

    def detect(self, frame_rgb):
        """
        Run detection on an RGB frame (numpy array).
        Returns a HandLandmarkerResult or None.
        """
        if not self.ready or not self.landmarker:
            return None
        try:
            # MediaPipe Tasks requires monotonically increasing timestamps
            self._timestamp_ms += 33  # ~30 fps
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            result = self.landmarker.detect_for_video(mp_image, self._timestamp_ms)
            return result
        except Exception:
            return None

    def get_finger_tips(self, results, frame_width: int, frame_height: int) -> list[dict]:
        """
        Extract all fingertip positions from hand results.
        Returns a list of hand dicts, each with 'tips' and 'landmarks'.
        """
        if not results or not results.hand_landmarks:
            return []

        hands = []
        for hand_lms in results.hand_landmarks:
            tips = []
            for tid in TIP_IDS:
                lm = hand_lms[tid]
                tips.append({
                    'x': lm.x * frame_width,
                    'y': lm.y * frame_height,
                    'z': lm.z,
                })

            landmarks = []
            for lm in hand_lms:
                landmarks.append({
                    'x': lm.x * frame_width,
                    'y': lm.y * frame_height,
                    'z': lm.z,
                })

            hands.append({
                'x': hand_lms[8].x * frame_width,   # index finger primary
                'y': hand_lms[8].y * frame_height,
                'tips': tips,
                'landmarks': landmarks,
            })

        return hands

    # ── Tap detection ───────────────────────────────────────────────────────
    # For top-down camera: detect finger taps by checking if a finger is
    # extended and pressing downward (tip below its PIP joint = curling down).
    # We use a per-finger state machine with cooldown.

    def get_tapping_tips(self, results, frame_width: int,
                         frame_height: int) -> list[dict]:
        """
        Return only the fingertips that are currently in a 'tap' state.
        A tap = the finger is extended and pressing down (tip is far from
        the wrist relative to MCP, AND the finger is reasonably straight).

        For a top-down camera, we detect taps by checking:
          1. Finger is extended (tip further from wrist than PIP in image-y)
          2. Fingertip moved downward recently (z-delta tracking)
          3. Cooldown prevents re-triggering

        Returns list of dicts with 'x', 'y', 'finger_id', 'hand_idx'.
        """
        if not results or not results.hand_landmarks:
            return []

        now = time.time()
        taps = []

        # PIP landmark indices for each finger (used to check extension)
        # thumb=4→IP=3, index=8→PIP=6, middle=12→PIP=10, ring=16→PIP=14, pinky=20→PIP=18
        PIP_IDS = [3, 6, 10, 14, 18]
        MCP_IDS = [2, 5, 9, 13, 17]

        for hand_idx, hand_lms in enumerate(results.hand_landmarks):
            for i, (tip_id, pip_id, mcp_id) in enumerate(
                zip(TIP_IDS, PIP_IDS, MCP_IDS)
            ):
                tip = hand_lms[tip_id]
                pip = hand_lms[pip_id]
                mcp = hand_lms[mcp_id]

                tip_x = tip.x * frame_width
                tip_y = tip.y * frame_height

                # Check if finger is extended:
                # For index/middle/ring/pinky: tip.y > pip.y means pointing
                # down in image space (camera facing down on table).
                # For thumb: use x-distance instead.
                if i == 0:  # thumb
                    extended = abs(tip.x - mcp.x) > abs(pip.x - mcp.x)
                else:
                    # Finger is extended if tip is further from MCP than PIP
                    # in the image y-axis (downward = toward table)
                    tip_dist = ((tip.x - mcp.x)**2 + (tip.y - mcp.y)**2) ** 0.5
                    pip_dist = ((pip.x - mcp.x)**2 + (pip.y - mcp.y)**2) ** 0.5
                    extended = tip_dist > pip_dist * 0.85

                if not extended:
                    continue

                # Z-based tap: track z over time per finger
                fkey = (hand_idx, tip_id)
                prev = self._finger_z.get(fkey)
                cur_z = tip.z

                if prev is not None:
                    prev_z, prev_time = prev
                    z_delta = cur_z - prev_z  # positive = moving toward table

                    # Tap trigger: z moved down enough AND cooldown passed
                    cooldown_key = fkey
                    last_tap = self._tap_cooldown.get(cooldown_key, 0)

                    if z_delta > 0.008 and (now - last_tap) > 0.25:
                        taps.append({
                            'x': tip_x,
                            'y': tip_y,
                            'finger_id': tip_id,
                            'hand_idx': hand_idx,
                        })
                        self._tap_cooldown[cooldown_key] = now

                self._finger_z[fkey] = (cur_z, now)

        # Clean up stale entries (hands that disappeared)
        if now - self._last_cleanup > 2.0:
            self._last_cleanup = now
            stale = [k for k, (_, t) in self._finger_z.items() if now - t > 1.0]
            for k in stale:
                del self._finger_z[k]
                self._tap_cooldown.pop(k, None)

        return taps

    def destroy(self):
        if self.landmarker:
            self.landmarker.close()
