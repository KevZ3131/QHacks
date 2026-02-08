/* =========================================================
   GeminiDetector — Gemini AI-powered shape detection
   =========================================================
   Uses Google's Gemini 2.0 Flash vision model to:
     1. Detect the paper in a camera frame
     2. Classify hand-drawn shapes despite perspective distortion
     3. Return bounding boxes in video-pixel coordinates

   Replaces fragile OpenCV contour analysis with a single
   API call that naturally handles perspective, lighting,
   and occlusion.

   Usage:
     const gemini = new GeminiDetector();
     gemini.setApiKey('YOUR_KEY');
     const { rectangles, circles, triangles } = await gemini.detect(videoEl);
   ========================================================= */
'use strict';

class GeminiDetector {
    constructor () {
        this.apiKey         = 'AIzaSyBQyDbd6mGwf2ZKxheT2SG39mO0GPAdjLg';
        this.model          = 'gemini-2.5-flash';
        this.lastResponse   = null;
        this.lastLog        = '';
        this.paperCorners   = null;     // [{x,y}, ...] in video px
        this._captureCanvas = null;
        /** Locked shapes — once classified, they stay until a clear. */
        this.lockedShapes   = null;
        /** Rate-limit management */
        this._lastCallTime  = 0;
        this._minInterval   = 4000;  // min 4s between calls
        this._backoffUntil  = 0;     // timestamp — skip calls until this time
    }

    /* ---------- configuration ---------- */

    setApiKey (key) { this.apiKey = (key || '').trim(); }

    get ready () { return this.apiKey.length > 10; }

    /* ---------- main detection ---------- */

    /**
     * Capture a frame from the video and send it to Gemini for
     * shape detection.  Returns data in the same format as
     * ShapeDetector so NoteRecognizer can consume it directly.
     *
     * @param {HTMLVideoElement} video
     * @returns {Promise<{rectangles: object[], circles: object[], triangles: object[]}>}
     */
    async detect (video) {
        if (!this.ready) throw new Error('Gemini API key not set');

        // Rate-limit guard — enforce minimum interval between calls
        const now = Date.now();
        if (now < this._backoffUntil) {
            const wait = Math.ceil((this._backoffUntil - now) / 1000);
            throw new Error(`Rate-limited — retry in ${wait}s`);
        }
        const sinceLastCall = now - this._lastCallTime;
        if (sinceLastCall < this._minInterval) {
            throw new Error('Too fast — wait ' + Math.ceil((this._minInterval - sinceLastCall) / 1000) + 's');
        }
        this._lastCallTime = now;

        const vw = video.videoWidth;
        const vh = video.videoHeight;

        // 1. Capture & encode frame
        console.log('[Gemini] capturing frame…');
        const base64 = this._captureFrame(video);
        console.log('[Gemini] frame captured, base64 length:', base64.length);

        // 2. Build the prompt
        const prompt = this._buildPrompt();

        // 3. Call Gemini API
        console.log('[Gemini] calling API with model:', this.model);
        const t0 = performance.now();

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        const body = {
            contents: [{
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: 'image/jpeg',
                            data:      base64,
                        },
                    },
                ],
            }],
            generationConfig: {
                temperature:      0.1,
                maxOutputTokens:  4096,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        paper: {
                            type: 'object',
                            properties: {
                                detected: { type: 'boolean' },
                                corners: {
                                    type: 'array',
                                    items: {
                                        type: 'array',
                                        items: { type: 'number' }
                                    }
                                }
                            },
                            required: ['detected', 'corners']
                        },
                        shapes: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string', enum: ['rectangle', 'circle', 'triangle'] },
                                    points: {
                                        type: 'array',
                                        items: {
                                            type: 'array',
                                            items: { type: 'number' }
                                        }
                                    },
                                    confidence: { type: 'number' }
                                },
                                required: ['type', 'points']
                            }
                        }
                    },
                    required: ['paper', 'shapes']
                },
            },
        };

        let res;
        try {
            res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
            });
        } catch (netErr) {
            throw new Error('Network error calling Gemini: ' + netErr.message);
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('[Gemini] API error response:', errText);
            const status  = res.status;
            if (status === 401 || status === 403) throw new Error('Invalid Gemini API key');
            if (status === 429) {
                // Back off for 30 seconds on rate limit
                this._backoffUntil = Date.now() + 30000;
                console.warn('[Gemini] 429 rate limit — backing off 30s');
                throw new Error('Gemini rate limit — waiting 30s before retry');
            }
            throw new Error(`Gemini API error ${status}: ${errText.slice(0, 300)}`);
        }

        const data = await res.json();
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        console.log('[Gemini] API responded in', elapsed, 's');

        // 4. Extract text from response
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const finishReason = data?.candidates?.[0]?.finishReason;
        console.log('[Gemini] finishReason:', finishReason);

        if (!rawText) {
            console.error('[Gemini] Full API response:', JSON.stringify(data, null, 2));
            throw new Error('Empty response from Gemini (finishReason: ' + finishReason + ')');
        }

        console.log('[Gemini] raw response text:', rawText.substring(0, 500));
        this.lastResponse = rawText;

        // 5. Parse JSON — handle various response formats
        let parsed;
        try {
            // Try direct parse first
            parsed = JSON.parse(rawText);
        } catch (_e1) {
            // Try extracting from markdown code block
            const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) {
                try {
                    parsed = JSON.parse(match[1].trim());
                } catch (_e2) {
                    console.error('[Gemini] Failed to parse extracted JSON:', match[1]);
                    throw new Error('Could not parse JSON from Gemini code block');
                }
            } else {
                // Try finding JSON object in the response
                const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        parsed = JSON.parse(jsonMatch[0]);
                    } catch (_e3) {
                        console.error('[Gemini] Could not parse any JSON from response');
                        throw new Error('No valid JSON in Gemini response');
                    }
                } else {
                    console.error('[Gemini] No JSON found in response:', rawText);
                    throw new Error('Gemini response contains no JSON');
                }
            }
        }

        console.log('[Gemini] parsed response:', JSON.stringify(parsed, null, 2));

        // 6. Convert normalised coordinates → video-pixel coordinates
        const result = this._parseShapes(parsed, vw, vh);

        // 7. Store paper outline
        if (parsed.paper && parsed.paper.detected && parsed.paper.corners) {
            this.paperCorners = parsed.paper.corners.map(c => {
                // Handle both [x,y] arrays and {x,y} objects
                const nx = Array.isArray(c) ? c[0] : c.x;
                const ny = Array.isArray(c) ? c[1] : c.y;
                return { x: nx * vw, y: ny * vh };
            });
        } else {
            this.paperCorners = null;
        }

        // 8. Lock classification
        this.lockedShapes = result;

        this.lastLog =
            `Gemini (${elapsed}s): ${result.rectangles.length}r ` +
            `${result.circles.length}c ${result.triangles.length}t  ` +
            `paper=${parsed.paper?.detected ?? '?'}`;
        console.log('[Gemini]', this.lastLog);

        return result;
    }

    /* ---------- paper outline for overlay drawing ---------- */

    /** Returns paper corners in video-pixel coords (same interface as ShapeDetector). */
    getPaperOutline () {
        return this.paperCorners;
    }

    /* ---------- prompt ---------- */

    _buildPrompt () {
        return `You are a shape detector for a "Paper Piano" app. Users draw piano keys on paper and play them by tapping.

SCENE:
A webcam image of a white sheet of paper on a desk, viewed at an angle (perspective distortion).
The user has drawn shapes with a dark pen/pencil/marker.

TASK 1 — FIND THE PAPER:
Locate the white paper. Return its 4 corners as fractions of image size (0.0-1.0), clockwise from top-left.

TASK 2 — TRACE THE OUTLINE OF EVERY INDIVIDUAL CLOSED REGION:
For each closed drawn region on the paper, return the POLYGON VERTICES that trace its outline.
Return coordinates as fractions of the full image (0.0-1.0).

CRITICAL RULES:
• A big rectangle divided by internal lines = MULTIPLE separate shapes, one per cell/key
• Each cell between dividing lines is ONE shape with its OWN polygon
• Trace the actual drawn edges of each cell — the polygon should follow the pen strokes
• Because the camera is at an angle, shapes will be trapezoids/parallelograms, NOT perfect rectangles — that's correct, trace them as they actually appear
• Return 4 vertices for quadrilateral cells (piano keys), ~8-12 vertices for round shapes
• Vertices should go clockwise around the shape outline
• Tall/narrow cells → type "rectangle" (piano keys)
• Round/oval regions → type "circle" (drum pads)
• 3-sided regions → type "triangle"

EXAMPLE: A drawn piano keyboard |_|_|_|_|_| = 5 separate shapes, each with 4 polygon vertices tracing that cell's edges as they appear in the image (with perspective distortion).

POLYGON FORMAT — each shape has a "points" array of [x, y] pairs (fractions 0.0-1.0):
{
  "paper": {"detected": true, "corners": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]},
  "shapes": [
    {
      "type": "rectangle",
      "points": [[0.15,0.25],[0.20,0.24],[0.21,0.55],[0.16,0.56]],
      "confidence": 0.9
    }
  ]
}

If no paper: {"paper":{"detected":false,"corners":[]},"shapes":[]}
Trace EVERY individual cell/region. Follow the actual drawn lines precisely.`;
    }

    /* ---------- response parsing ---------- */

    /**
     * Convert Gemini's normalised JSON into pixel-coordinate shape objects
     * compatible with NoteRecognizer.
     */
    _parseShapes (parsed, vw, vh) {
        const rectangles = [];
        const circles    = [];
        const triangles  = [];

        if (!parsed.shapes || !Array.isArray(parsed.shapes)) {
            console.warn('[Gemini] No shapes array in parsed response');
            return { rectangles, circles, triangles };
        }

        console.log('[Gemini] Processing', parsed.shapes.length, 'shapes from response');

        for (const s of parsed.shapes) {
            console.log('[Gemini] Shape raw:', JSON.stringify(s));

            const type = (s.type || '').toLowerCase().trim();
            if (!type) { console.warn('[Gemini] Skipping shape with no type'); continue; }
            if (s.confidence != null && s.confidence < 0.2) continue;

            // Convert polygon points to pixel coordinates
            let points = s.points;
            if (!points || !Array.isArray(points) || points.length < 3) {
                // Fallback: if Gemini returned bounding box instead of polygon
                if (s.x != null && s.y != null && s.width != null && s.height != null) {
                    let sx = s.x, sy = s.y, sw = s.width, sh = s.height;
                    if (sx > 2 || sy > 2) { sx /= vw; sy /= vh; sw /= vw; sh /= vh; }
                    points = [[sx, sy], [sx+sw, sy], [sx+sw, sy+sh], [sx, sy+sh]];
                } else {
                    console.warn('[Gemini] Skipping shape with no points:', s);
                    continue;
                }
            }

            // Normalise: detect pixel vs fractional coords
            const maxCoord = Math.max(...points.flat());
            const isPixels = maxCoord > 2;

            const pixelPoints = points.map(p => ({
                x: isPixels ? p[0] : p[0] * vw,
                y: isPixels ? p[1] : p[1] * vh,
            }));

            // Compute bounding box from polygon
            const xs = pixelPoints.map(p => p.x);
            const ys = pixelPoints.map(p => p.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const width  = maxX - minX;
            const height = maxY - minY;
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            const area = this._polygonArea(pixelPoints);

            const base = {
                x: minX, y: minY, width, height,
                centerX, centerY, area,
                points: pixelPoints,
                confidence: s.confidence ?? 0.8,
            };

            if (type === 'rectangle') {
                rectangles.push({ ...base, type: 'rectangle' });
            } else if (type === 'circle') {
                const r = Math.max(width, height) / 2;
                circles.push({ ...base, type: 'circle', radius: r });
            } else if (type === 'triangle') {
                triangles.push({ ...base, type: 'triangle' });
            } else {
                // Default to rectangle
                rectangles.push({ ...base, type: 'rectangle' });
            }
        }

        return { rectangles, circles, triangles };
    }

    /** Compute polygon area using the shoelace formula */
    _polygonArea (pts) {
        let area = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
        }
        return Math.abs(area / 2);
    }

    /* ---------- frame capture ---------- */

    /**
     * Draw the current video frame onto a temp canvas and export
     * as base64 JPEG.  Down-scales to max 1024px wide to reduce
     * API payload size.
     */
    _captureFrame (video) {
        if (!this._captureCanvas) {
            this._captureCanvas = document.createElement('canvas');
        }
        const c = this._captureCanvas;

        // Down-scale for faster upload (max 1280 wide — keep detail)
        const maxW  = 1280;
        const scale = video.videoWidth > maxW ? maxW / video.videoWidth : 1;
        c.width  = Math.round(video.videoWidth  * scale);
        c.height = Math.round(video.videoHeight * scale);

        const ctx = c.getContext('2d');
        ctx.drawImage(video, 0, 0, c.width, c.height);

        // Export as JPEG base64, higher quality for better detection
        return c.toDataURL('image/jpeg', 0.90).split(',')[1];
    }
}

window.GeminiDetector = GeminiDetector;
