"""
HandTracker — Real-time hand landmark detection using MediaPipe Tasks Vision.
Tracks fingertip positions for each detected hand.
"""

import os
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

    def destroy(self):
        if self.landmarker:
            self.landmarker.close()
