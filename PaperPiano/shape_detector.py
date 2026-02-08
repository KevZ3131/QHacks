"""
ShapeDetector — Detects drawn shapes on paper using OpenCV.
Finds rectangular contours, returns bounding rects and polygon points.
Direct port of the JS ShapeDetector.
"""

import cv2
import numpy as np


class ShapeDetector:
    def __init__(self):
        self.ready = True  # OpenCV is always available once imported

    # ── Detection ────────────────────────────────────────────────────────────
    def detect(self, frame: np.ndarray) -> list[dict]:
        """
        Detect rectangular shapes drawn on the given frame (BGR).
        Returns list of shape dicts with rect, points, center, area, id.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Adaptive threshold handles uneven lighting on paper
        thresh = cv2.adaptiveThreshold(
            blurred, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, 19, 6,
        )

        # Close small gaps in drawn lines, then dilate slightly
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        thresh = cv2.dilate(thresh, kernel, iterations=1)

        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        h, w = frame.shape[:2]
        frame_area = w * h
        MIN_AREA = frame_area * 0.005   # 0.5 %
        MAX_AREA = frame_area * 0.20    # 20 %

        shapes = []

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_AREA or area > MAX_AREA:
                continue

            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)

            verts = len(approx)
            if verts < 4 or verts > 8:
                continue

            x, y, rw, rh = cv2.boundingRect(cnt)
            aspect = rw / rh if rh > 0 else 0
            if aspect < 0.25 or aspect > 4.0:
                continue

            if rw < 25 or rh < 25:
                continue

            # Solidity check
            hull = cv2.convexHull(cnt)
            hull_area = cv2.contourArea(hull)
            solidity = area / hull_area if hull_area > 0 else 0
            if solidity < 0.6:
                continue

            # Rectangularity
            rect_area = rw * rh
            rectangularity = area / rect_area
            if rectangularity < 0.45:
                continue

            points = [{'x': int(p[0][0]), 'y': int(p[0][1])} for p in approx]

            shapes.append({
                'rect': {'x': x, 'y': y, 'width': rw, 'height': rh},
                'points': points,
                'area': area,
                'center': {'x': x + rw // 2, 'y': y + rh // 2},
            })

        # Sort: top-to-bottom rows, then left-to-right within a row
        def sort_key(s):
            return s['center']['y'], s['center']['x']

        shapes.sort(key=sort_key)

        # Re-sort with row awareness
        def row_sort(shapes_list):
            if not shapes_list:
                return shapes_list
            result = sorted(shapes_list, key=lambda s: s['center']['y'])
            # Stable row-aware sort
            for i in range(len(result)):
                for j in range(i + 1, len(result)):
                    si, sj = result[i], result[j]
                    row_thresh = min(si['rect']['height'], sj['rect']['height']) * 0.5
                    if abs(si['center']['y'] - sj['center']['y']) < row_thresh:
                        if si['center']['x'] > sj['center']['x']:
                            result[i], result[j] = result[j], result[i]
            return result

        shapes = row_sort(shapes)

        for idx, s in enumerate(shapes):
            s['id'] = f'shape_{idx}'

        return shapes

    # ── Region extraction for OCR ────────────────────────────────────────────
    def extract_region(self, frame: np.ndarray, rect: dict, padding: int = 10) -> np.ndarray | None:
        """
        Crop and preprocess a region for OCR.
        Scales up and binarises to improve Tesseract accuracy.
        Returns a preprocessed grayscale image or None.
        """
        h, w = frame.shape[:2]
        x = max(0, rect['x'] + padding)
        y = max(0, rect['y'] + padding)
        rw = min(rect['width'] - padding * 2, w - x)
        rh = min(rect['height'] - padding * 2, h - y)
        if rw <= 4 or rh <= 4:
            return None

        crop = frame[y:y + rh, x:x + rw]

        # Scale up for better OCR
        scale = max(2, 64 / min(rw, rh))
        new_w = int(rw * scale)
        new_h = int(rh * scale)
        crop = cv2.resize(crop, (new_w, new_h), interpolation=cv2.INTER_NEAREST)

        # Convert to grayscale and binarise
        if len(crop.shape) == 3:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        else:
            gray = crop

        _, binary = cv2.threshold(gray, 130, 255, cv2.THRESH_BINARY)
        return binary
