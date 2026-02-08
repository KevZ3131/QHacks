"""
ShapeDetector — Detects drawn shapes on paper using OpenCV.
  • Rectangles → piano keys
  • Circles   → drum pads
  • Triangles → additional instrument type
Classifies via contour geometry (circularity, corner angles, vertex count).
Each shape gets an inner boundary at 50% scale for tap-trigger zones.
"""

import cv2
import numpy as np


# Inner boundary scale factor — note only triggers inside this zone
INNER_SCALE = 0.50


class ShapeDetector:
    def __init__(self):
        self.ready = True

    # ── Main detection ───────────────────────────────────────────────────────
    def detect(self, frame: np.ndarray) -> list[dict]:
        """
        Detect circles, rectangles, and triangles drawn on paper.
        Returns list of shape dicts, each including an 'inner' sub-dict
        describing the 50%-scaled trigger zone.
        """
        h, w = frame.shape[:2]
        frame_area = w * h
        MIN_AREA = frame_area * 0.005
        MAX_AREA = frame_area * 0.25

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (7, 7), 0)

        # Single adaptive threshold — good for pen on paper
        thresh = cv2.adaptiveThreshold(
            blurred, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, 21, 6,
        )

        # Close gaps in hand-drawn lines, then a small dilate
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
        kernel_sm = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        thresh = cv2.dilate(thresh, kernel_sm, iterations=1)

        contours, _ = cv2.findContours(
            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        shapes = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_AREA or area > MAX_AREA:
                continue

            x, y, rw, rh = cv2.boundingRect(cnt)
            if rw < 20 or rh < 20:
                continue

            hull = cv2.convexHull(cnt)
            hull_area = cv2.contourArea(hull)
            solidity = area / hull_area if hull_area > 0 else 0
            if solidity < 0.40:
                continue

            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)

            shape_type, confidence = self._classify(cnt, approx, area, rw, rh, peri, solidity)
            if shape_type is None:
                continue

            cx_center = x + rw // 2
            cy_center = y + rh // 2

            entry = {
                'rect': {'x': x, 'y': y, 'width': rw, 'height': rh},
                'points': [{'x': int(p[0][0]), 'y': int(p[0][1])} for p in approx],
                'area': area,
                'center': {'x': cx_center, 'y': cy_center},
                'shape_type': shape_type,
                'confidence': confidence,
            }

            if shape_type == 'circle':
                (cx, cy), radius = cv2.minEnclosingCircle(cnt)
                entry['circle_center'] = {'x': int(cx), 'y': int(cy)}
                entry['radius'] = int(radius)
                # Inner boundary: 50% radius circle
                entry['inner'] = {
                    'type': 'circle',
                    'cx': int(cx), 'cy': int(cy),
                    'radius': int(radius * INNER_SCALE),
                }

            elif shape_type == 'triangle':
                # Use the 3 approx points as triangle vertices
                tri_pts = [(int(p[0][0]), int(p[0][1])) for p in approx[:3]]
                entry['tri_points'] = tri_pts
                # Inner boundary: triangle scaled 50% toward centroid
                inner_pts = self._scale_polygon(tri_pts, INNER_SCALE)
                entry['inner'] = {
                    'type': 'triangle',
                    'points': inner_pts,
                }

            else:  # rect
                # Inner boundary: 50% rect centered
                iw = int(rw * INNER_SCALE)
                ih = int(rh * INNER_SCALE)
                ix = cx_center - iw // 2
                iy = cy_center - ih // 2
                entry['inner'] = {
                    'type': 'rect',
                    'x': ix, 'y': iy,
                    'width': iw, 'height': ih,
                }

            shapes.append(entry)

        # Sort: top-to-bottom rows, then left-to-right
        shapes = self._row_sort(shapes)

        for idx, s in enumerate(shapes):
            s['id'] = f'shape_{idx}'

        return shapes

    # ── Shape classification ─────────────────────────────────────────────────
    def _classify(self, cnt, approx, area, rw, rh, peri, solidity) -> tuple[str | None, float]:
        """
        Return (shape_type, confidence) or (None, 0).
        Circle  : smooth contour, high circularity, low aspect variance
        Rectangle: 4 corners with ~90° angles
        Triangle : exactly 3 corners
        """
        verts = len(approx)
        aspect = rw / rh if rh > 0 else 0
        circularity = (4 * np.pi * area) / (peri * peri) if peri > 0 else 0
        rect_area = rw * rh
        rectangularity = area / rect_area if rect_area > 0 else 0

        # ── Circle: high circularity, roughly square bounding box, smooth ──
        if circularity > 0.65 and 0.55 < aspect < 1.8 and verts >= 6:
            return 'circle', min(1.0, circularity)
        if circularity > 0.55 and 0.5 < aspect < 2.0 and solidity > 0.80:
            return 'circle', circularity * 0.9

        # ── Triangle: exactly 3 vertices after approximation ───────────────
        if verts == 3:
            # Verify angles: all should be between 20° and 160°
            angles = self._polygon_angles(approx)
            if angles and all(20 < a < 160 for a in angles):
                conf = solidity * (min(angles) / 60.0)  # penalise very acute
                return 'triangle', min(1.0, conf)

        # ── Rectangle: 4 corners with near-right angles ────────────────────
        if 4 <= verts <= 6:
            angles = self._polygon_angles(approx)
            if angles:
                right_count = sum(1 for a in angles if 60 < a < 120)
                if right_count >= 3 and rectangularity >= 0.50:
                    conf = rectangularity * (right_count / len(angles))
                    return 'rect', min(1.0, conf)

        # ── Fallback rectangle: high fill ratio ────────────────────────────
        if rectangularity >= 0.45 and 0.15 < aspect < 6.0 and solidity > 0.60:
            return 'rect', rectangularity * 0.8

        return None, 0.0

    # ── Polygon angle calculation ────────────────────────────────────────────
    @staticmethod
    def _polygon_angles(approx) -> list[float]:
        """Return interior angles (degrees) for each vertex in the polygon."""
        n = len(approx)
        if n < 3:
            return []
        angles = []
        for i in range(n):
            p1 = approx[i - 1][0].astype(float)
            p2 = approx[i][0].astype(float)
            p3 = approx[(i + 1) % n][0].astype(float)
            v1 = p1 - p2
            v2 = p3 - p2
            cos_a = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-8)
            cos_a = np.clip(cos_a, -1.0, 1.0)
            angles.append(float(np.degrees(np.arccos(cos_a))))
        return angles

    # ── Scale polygon toward its centroid ────────────────────────────────────
    @staticmethod
    def _scale_polygon(pts: list[tuple], scale: float) -> list[tuple]:
        """Scale polygon points toward centroid by `scale` factor."""
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        return [
            (int(cx + (p[0] - cx) * scale), int(cy + (p[1] - cy) * scale))
            for p in pts
        ]

    # ── Inner-boundary hit test (static, used by paper_piano) ────────────────
    @staticmethod
    def point_in_inner(shape: dict, x: float, y: float) -> bool:
        """Return True if (x, y) is inside the shape's inner boundary."""
        inner = shape.get('inner')
        if not inner:
            return False

        itype = inner['type']

        if itype == 'circle':
            dx = x - inner['cx']
            dy = y - inner['cy']
            return dx * dx + dy * dy <= inner['radius'] * inner['radius']

        if itype == 'rect':
            return (inner['x'] <= x <= inner['x'] + inner['width'] and
                    inner['y'] <= y <= inner['y'] + inner['height'])

        if itype == 'triangle':
            return ShapeDetector._point_in_triangle(
                (x, y), inner['points'][0], inner['points'][1], inner['points'][2]
            )

        return False

    @staticmethod
    def _point_in_triangle(p, a, b, c) -> bool:
        """Barycentric point-in-triangle test."""
        def sign(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1 = sign(p, a, b)
        d2 = sign(p, b, c)
        d3 = sign(p, c, a)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    # ── Row-aware sorting ────────────────────────────────────────────────────
    def _row_sort(self, shapes: list[dict]) -> list[dict]:
        if not shapes:
            return shapes
        result = sorted(shapes, key=lambda s: s['center']['y'])
        for i in range(len(result)):
            for j in range(i + 1, len(result)):
                si, sj = result[i], result[j]
                row_thresh = min(
                    si['rect']['height'], sj['rect']['height']
                ) * 0.5
                if abs(si['center']['y'] - sj['center']['y']) < row_thresh:
                    if si['center']['x'] > sj['center']['x']:
                        result[i], result[j] = result[j], result[i]
        return result

    # ── Extract region INSIDE a shape for OCR ────────────────────────────────
    def extract_region(self, frame: np.ndarray, rect: dict,
                       padding: int = 10) -> np.ndarray | None:
        h, w = frame.shape[:2]
        x = max(0, rect['x'] + padding)
        y = max(0, rect['y'] + padding)
        rw = min(rect['width'] - padding * 2, w - x)
        rh = min(rect['height'] - padding * 2, h - y)
        if rw <= 4 or rh <= 4:
            return None
        crop = frame[y:y + rh, x:x + rw]
        scale = max(2, 64 / min(rw, rh))
        crop = cv2.resize(crop, (int(rw * scale), int(rh * scale)),
                          interpolation=cv2.INTER_NEAREST)
        if len(crop.shape) == 3:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        else:
            gray = crop
        _, binary = cv2.threshold(gray, 130, 255, cv2.THRESH_BINARY)
        return binary

    # ── Extract the region ABOVE a shape for note-label OCR ──────────────────
    def extract_label_above(self, frame: np.ndarray, rect: dict,
                            margin: int = 5) -> np.ndarray | None:
        """
        Grab the strip of pixels above this shape (where the user wrote the
        note name) and return a preprocessed image for OCR.
        Looks at a region: same width as the shape, height = 60% of shape
        height, ending just above the shape's top edge.
        """
        h_frame, w_frame = frame.shape[:2]
        label_h = max(20, int(rect['height'] * 0.6))
        x1 = max(0, rect['x'] - margin)
        x2 = min(w_frame, rect['x'] + rect['width'] + margin)
        y2 = max(0, rect['y'] - margin)
        y1 = max(0, y2 - label_h)

        rw = x2 - x1
        rh = y2 - y1
        if rw < 8 or rh < 8:
            return None

        crop = frame[y1:y2, x1:x2]
        scale = max(2, 64 / min(rw, rh))
        crop = cv2.resize(crop, (int(rw * scale), int(rh * scale)),
                          interpolation=cv2.INTER_NEAREST)
        if len(crop.shape) == 3:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        else:
            gray = crop
        _, binary = cv2.threshold(gray, 130, 255, cv2.THRESH_BINARY)
        return binary
