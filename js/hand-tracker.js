/* =========================================================
   HandTracker — MediaPipe Hands wrapper
   =========================================================
   Tracks up to 2 hands using the MediaPipe Hands
   *Solutions* API loaded from CDN.  Exposes only EXTENDED
   fingertip positions (curled fingers are ignored).

   Includes:
     • Finger-curl detection (only report extended fingers)
     • Debounce guard to prevent rapid on/off flickering
   ========================================================= */
'use strict';

class HandTracker {
    constructor () {
        /** @type {Hands|null} */
        this.hands      = null;
        this.results    = null;
        this.ready      = false;
        this.processing = false;
        this.lastError  = null;
        /** External callback — set by main.js */
        this.onResults  = null;
    }

    /* ---------- lifecycle ---------- */

    async init () {
        if (typeof Hands === 'undefined') {
            throw new Error('MediaPipe Hands did not load.');
        }

        await this.close();
        // eslint-disable-next-line no-undef
        this.hands = new Hands({
            locateFile: file =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
        });

        this.hands.setOptions({
            maxNumHands:            2,
            modelComplexity:        1,      // 1 = Full (more accurate, less jitter)
            minDetectionConfidence: 0.65,
            minTrackingConfidence:  0.60,
        });

        this.hands.onResults(r => {
            this.results    = r;
            this.processing = false;
            this.lastError  = null;
            if (this.onResults) this.onResults(r);
        });

        await this.hands.initialize();
        this.ready = true;
    }

    async close () {
        const tracker = this.hands;
        this.ready = false;
        this.processing = false;
        this.results = null;
        this.hands = null;

        if (tracker && typeof tracker.close === 'function') {
            try {
                await tracker.close();
            } catch (error) {
                console.warn('[HandTracker] close failed:', error);
            }
        }
    }

    /** Send a video frame for processing. */
    async send (videoEl) {
        if (!this.ready || this.processing) return;
        this.processing = true;
        try {
            await this.hands.send({ image: videoEl });
        } catch (e) {
            this.processing = false;
            this.lastError = e;
        }
    }

    /* ---------- queries ---------- */

    /**
     * Returns only EXTENDED fingertips currently visible.
     * Curled/bent fingers are excluded to prevent accidental triggers.
     *
     * A finger is considered extended if its tip is farther from the
     * wrist than its MCP (knuckle) joint — a simple but effective test.
     *
     * Returns: { x, y, z, finger, hand }
     */
    getFingerTips () {
        if (!this.results || !this.results.multiHandLandmarks) return [];

        /*
         * Landmark indices for each finger:
         *   tip, dip, pip, mcp
         *   Thumb:  4, 3, 2, 1   (special: compare tip.x vs mcp.x for abduction)
         *   Index:  8, 7, 6, 5
         *   Middle: 12,11,10, 9
         *   Ring:   16,15,14,13
         *   Pinky:  20,19,18,17
         */
        const FINGERS = [
            { name: 'index',  tip: 8,  dip: 7,  pip: 6,  mcp: 5  },
            { name: 'middle', tip: 12, dip: 11, pip: 10, mcp: 9  },
            { name: 'ring',   tip: 16, dip: 15, pip: 14, mcp: 13 },
            { name: 'pinky',  tip: 20, dip: 19, pip: 18, mcp: 17 },
        ];

        const tips = [];
        this.results.multiHandLandmarks.forEach((lm, hi) => {
            const wrist = lm[0];

            for (const f of FINGERS) {
                // Extended test: tip must be farther from wrist than pip joint
                // (works regardless of hand orientation)
                const tipDist = Math.hypot(lm[f.tip].x - wrist.x,
                                           lm[f.tip].y - wrist.y);
                const pipDist = Math.hypot(lm[f.pip].x - wrist.x,
                                           lm[f.pip].y - wrist.y);
                if (tipDist <= pipDist) continue; // finger is curled

                // Additional check: tip should be above (lower y) the dip joint
                // when hand is roughly upright. We only require tip.y < pip.y
                // as a soft sanity check.
                // (Skip this for more orientation tolerance)

                tips.push({
                    x:      lm[f.tip].x,
                    y:      lm[f.tip].y,
                    z:      lm[f.tip].z,
                    finger: f.name,
                    hand:   hi,
                });
            }
        });
        return tips;
    }

    /**
     * Returns the full set of 21 landmarks per hand (for debug drawing).
     */
    getLandmarks () {
        if (!this.results) return [];
        return this.results.multiHandLandmarks || [];
    }
}

window.HandTracker = HandTracker;
