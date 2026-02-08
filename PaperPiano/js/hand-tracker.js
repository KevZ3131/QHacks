/* =========================================================
   HandTracker — MediaPipe Hands wrapper
   =========================================================
   Tracks up to 2 hands using the MediaPipe Hands
   *Solutions* API loaded from CDN.  Exposes only EXTENDED
   fingertip positions (curled fingers are ignored).

   Includes:
     • Finger-curl detection (only report extended fingers)
     • Exponential-moving-average smoothing on landmarks
     • Grace period — keeps last-known hand for a few frames
       when MediaPipe briefly drops detection
   ========================================================= */
'use strict';

class HandTracker {
    constructor () {
        /** @type {Hands|null} */
        this.hands      = null;
        this.results    = null;
        this.ready      = false;
        this.processing = false;
        /** External callback — set by main.js */
        this.onResults  = null;

        /* ---- smoothing state ---- */
        /** Smoothed landmarks per hand index: Map<handIndex, landmark array> */
        this._smoothed  = new Map();
        /** EMA factor: 0 = ignore new data, 1 = no smoothing */
        this._alpha     = 0.45;

        /* ---- grace period ---- */
        /** How many consecutive empty frames before we drop a hand */
        this._graceFrames = 5;
        /** Counter of frames since we last saw hands */
        this._missCount   = 0;
        /** Cached last valid results (for grace period) */
        this._lastGoodResults = null;
    }

    /* ---------- lifecycle ---------- */

    async init () {
        // eslint-disable-next-line no-undef
        this.hands = new Hands({
            locateFile: file =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        this.hands.setOptions({
            maxNumHands:            2,
            modelComplexity:        1,      // 1 = Full (more accurate, less jitter)
            minDetectionConfidence: 0.5,
            minTrackingConfidence:  0.45,
        });

        this.hands.onResults(r => {
            this._processResults(r);
            this.processing = false;
            if (this.onResults) this.onResults(this.results);
        });

        await this.hands.initialize();
        this.ready = true;
    }

    /** Send a video frame for processing. */
    async send (videoEl) {
        if (!this.ready || this.processing) return;
        this.processing = true;
        try {
            await this.hands.send({ image: videoEl });
        } catch (e) {
            this.processing = false;
        }
    }

    /* ---------- internal: smoothing + grace ---------- */

    _processResults (raw) {
        const hasHands = raw.multiHandLandmarks && raw.multiHandLandmarks.length > 0;

        if (hasHands) {
            this._missCount = 0;
            this._lastGoodResults = raw;

            // Apply EMA smoothing to each hand's landmarks
            const smoothedLandmarks = raw.multiHandLandmarks.map((lm, hi) => {
                return this._smoothLandmarks(hi, lm);
            });

            this.results = {
                multiHandLandmarks:  smoothedLandmarks,
                multiHandedness:     raw.multiHandedness,
                image:               raw.image,
            };
        } else {
            this._missCount++;

            if (this._missCount <= this._graceFrames && this._lastGoodResults) {
                // Keep showing last known hand positions during brief drops
                this.results = this._lastGoodResults;
            } else {
                // Truly lost — clear everything
                this.results = raw;
                this._smoothed.clear();
                this._lastGoodResults = null;
            }
        }
    }

    /**
     * Exponential moving average on landmark positions.
     * Reduces jitter while keeping responsiveness.
     */
    _smoothLandmarks (handIndex, rawLandmarks) {
        const prev = this._smoothed.get(handIndex);

        if (!prev || prev.length !== rawLandmarks.length) {
            // First frame for this hand — just store raw
            const copy = rawLandmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
            this._smoothed.set(handIndex, copy);
            return copy;
        }

        const smoothed = rawLandmarks.map((p, i) => ({
            x: prev[i].x + this._alpha * (p.x - prev[i].x),
            y: prev[i].y + this._alpha * (p.y - prev[i].y),
            z: prev[i].z + this._alpha * (p.z - prev[i].z),
        }));

        this._smoothed.set(handIndex, smoothed);
        return smoothed;
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
