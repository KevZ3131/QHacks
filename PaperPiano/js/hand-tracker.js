/* =========================================================
   HandTracker — MediaPipe Hands wrapper
   =========================================================
   Tracks up to 2 hands at ~30 fps using the MediaPipe Hands
   *Solutions* API loaded from CDN.  Exposes fingertip
   positions in normalised image coordinates (0-1).
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
            modelComplexity:        0,      // 0 = Lite (fastest)
            minDetectionConfidence: 0.55,
            minTrackingConfidence:  0.50,
        });

        this.hands.onResults(r => {
            this.results    = r;
            this.processing = false;
            if (this.onResults) this.onResults(r);
        });

        await this.hands.initialize();
        this.ready = true;
    }

    /** Send a video frame for processing.  Resolves when the model finishes. */
    async send (videoEl) {
        if (!this.ready || this.processing) return;
        this.processing = true;
        try {
            await this.hands.send({ image: videoEl });
        } catch (e) {
            this.processing = false;
        }
    }

    /* ---------- queries ---------- */

    /**
     * Returns every fingertip currently visible.
     * Each entry: { x, y, z, finger, hand }
     *   x, y ∈ [0,1] normalised image coordinates
     *   z    — relative depth (smaller = closer to camera)
     *   finger — 'index' | 'middle' | 'ring' | 'pinky' | 'thumb'
     */
    getFingerTips () {
        if (!this.results || !this.results.multiHandLandmarks) return [];

        // Landmark indices:  4=thumb-tip  8=index  12=middle  16=ring  20=pinky
        const TIPS = [
            { idx:  8, name: 'index'  },
            { idx: 12, name: 'middle' },
            { idx: 16, name: 'ring'   },
            { idx: 20, name: 'pinky'  },
            { idx:  4, name: 'thumb'  },
        ];

        const tips = [];
        this.results.multiHandLandmarks.forEach((lm, hi) => {
            for (const { idx, name } of TIPS) {
                tips.push({
                    x:      lm[idx].x,
                    y:      lm[idx].y,
                    z:      lm[idx].z,
                    finger: name,
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
