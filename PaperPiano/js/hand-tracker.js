/* =========================================================
   HandTracker — MediaPipe Hands wrapper
   =========================================================
   Tracks up to 2 hands using the MediaPipe Hands
   *Solutions* API loaded from CDN.  Exposes only EXTENDED
   fingertip positions (curled fingers are ignored).

   Includes:
     • Finger-curl detection (only report extended fingers)
     • 1-Euro filter smoothing on landmarks (adaptive:
       heavy smoothing when still, responsive when moving)
     • Grace period — keeps last-known hand for a few frames
       when MediaPipe briefly drops detection
   ========================================================= */
'use strict';

/* ----------------------------------------------------------
   1-Euro Filter — adaptive low-pass filter for jitter removal
   Reference: Casiez et al. 2012
   "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy
   Input in Interactive Systems"

   - When the signal is steady (low speed), the cutoff is low
     → heavy smoothing, no jitter.
   - When the signal moves fast (tap gesture), the cutoff
     rises → the filter lets the movement through instantly.
   ---------------------------------------------------------- */
class OneEuroFilter {
    /**
     * @param {number} freq      – sampling frequency estimate (Hz)
     * @param {number} minCutoff – minimum cutoff freq (lower = smoother when still)
     * @param {number} beta      – speed coefficient (higher = more responsive to movement)
     * @param {number} dCutoff   – cutoff freq for the derivative filter
     */
    constructor(freq = 30, minCutoff = 1.5, beta = 0.5, dCutoff = 1.0) {
        this.freq = freq;
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;

        this._xPrev = null;
        this._dxPrev = 0;
        this._lastTime = null;
        this._initialized = false;
    }

    static _alpha(cutoff, dt) {
        const tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / dt);
    }

    /** Filter a single scalar value. Returns the smoothed value. */
    filter(x, timestamp) {
        if (!this._initialized) {
            this._xPrev = x;
            this._dxPrev = 0;
            this._lastTime = timestamp;
            this._initialized = true;
            return x;
        }

        let dt = timestamp - this._lastTime;
        if (dt <= 0 || dt > 1.0) dt = 1 / this.freq;  // fallback; also reset on long gaps
        this._lastTime = timestamp;

        // Derivative (speed) of the signal
        const dx = (x - this._xPrev) / dt;
        const aDeriv = OneEuroFilter._alpha(this.dCutoff, dt);
        const dxSmoothed = this._dxPrev + aDeriv * (dx - this._dxPrev);
        this._dxPrev = dxSmoothed;

        // Adaptive cutoff: raise when moving fast
        const cutoff = this.minCutoff + this.beta * Math.abs(dxSmoothed);
        const aSignal = OneEuroFilter._alpha(cutoff, dt);

        const xSmoothed = this._xPrev + aSignal * (x - this._xPrev);
        this._xPrev = xSmoothed;

        return xSmoothed;
    }

    /** Reset the filter state. */
    reset() {
        this._xPrev = null;
        this._dxPrev = 0;
        this._lastTime = null;
        this._initialized = false;
    }
}


class HandTracker {
    constructor() {
        /** @type {Hands|null} */
        this.hands = null;
        this.results = null;
        this.ready = false;
        this.processing = false;
        /** External callback — set by main.js */
        this.onResults = null;

        /* ---- 1-Euro filter state ---- */
        /**
         * Per-hand, per-landmark, per-axis filter instances.
         * Map<handIndex, Array<{ x: OneEuroFilter, y: OneEuroFilter, z: OneEuroFilter }>>
         */
        this._filters = new Map();

        /** 1-Euro filter tuning (optimised for close-up hands):
         *  minCutoff: low → aggressive smoothing when still
         *             (close-up amplifies jitter so we need more)
         *  beta:      tuned → responsive to intentional taps without over-reacting
         *  dCutoff:   low → smooth out noisy derivative estimates
         */
        this._filterFreq = 30;   // approx FPS of MediaPipe callbacks
        this._filterMinCutoff = 0.3;   // even stronger smoothing when still
        this._filterBeta = 1.2;   // more responsive to intentional taps
        this._filterDCutoff = 0.5;   // smoother derivative to avoid false speed spikes

        /* ---- grace period ---- */
        /** How many consecutive empty frames before we drop a hand */
        this._graceFrames = 6;
        /** Counter of frames since we last saw hands */
        this._missCount = 0;
        /** Cached last valid results (for grace period) */
        this._lastGoodResults = null;

        /* ---- landmark confidence tracking ---- */
        /** Per-hand smoothed landmarks from previous frame (for interpolation during grace) */
        this._prevSmoothed = new Map();
    }

    /* ---------- lifecycle ---------- */

    async init() {
        // eslint-disable-next-line no-undef
        this.hands = new Hands({
            locateFile: file =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,      // 1 = Full (better accuracy, still real-time)
            minDetectionConfidence: 0.60,
            minTrackingConfidence: 0.55,
        });

        this.hands.onResults(r => {
            clearTimeout(this._watchdog);
            try {
                this._processResults(r);
                if (this.onResults) this.onResults(this.results);
            } catch (e) {
                console.warn('[HandTracker] onResults error:', e);
            } finally {
                this.processing = false;
            }
        });

        await this.hands.initialize();
        this.ready = true;
    }

    /** Send a video frame for processing. */
    async send(videoEl) {
        if (!this.ready || this.processing) return;
        this.processing = true;
        // Watchdog: force-reset if MediaPipe never calls back
        this._watchdog = setTimeout(() => {
            if (this.processing) {
                console.warn('[HandTracker] watchdog: processing stuck, resetting');
                this.processing = false;
            }
        }, 1500);
        try {
            await this.hands.send({ image: videoEl });
        } catch (e) {
            this.processing = false;
            clearTimeout(this._watchdog);
        }
    }

    /* ---------- internal: smoothing + grace ---------- */

    _processResults(raw) {
        const hasHands = raw.multiHandLandmarks && raw.multiHandLandmarks.length > 0;

        if (hasHands) {
            this._missCount = 0;
            this._lastGoodResults = raw;

            // Apply 1-Euro filter smoothing to each hand's landmarks
            const smoothedLandmarks = raw.multiHandLandmarks.map((lm, hi) => {
                const smoothed = this._smoothLandmarks(hi, lm);
                this._prevSmoothed.set(hi, smoothed);
                return smoothed;
            });

            this.results = {
                multiHandLandmarks: smoothedLandmarks,
                multiHandedness: raw.multiHandedness,
                image: raw.image,
            };
        } else {
            this._missCount++;

            if (this._missCount <= this._graceFrames && this._lastGoodResults) {
                // During grace period, keep last smoothed landmarks
                // (they're already filtered, so they remain stable)
                const graceLandmarks = [];
                for (let hi = 0; hi < this._lastGoodResults.multiHandLandmarks.length; hi++) {
                    graceLandmarks.push(this._prevSmoothed.get(hi) ||
                        this._lastGoodResults.multiHandLandmarks[hi]);
                }
                this.results = {
                    multiHandLandmarks: graceLandmarks,
                    multiHandedness: this._lastGoodResults.multiHandedness,
                    image: raw.image,
                };
            } else {
                // Truly lost — clear everything
                this.results = raw;
                this._filters.clear();
                this._prevSmoothed.clear();
                this._lastGoodResults = null;
            }
        }
    }

    /**
     * Apply 1-Euro filters to each landmark coordinate.
     * Creates filter instances on first sight of a hand.
     */
    _smoothLandmarks(handIndex, rawLandmarks) {
        const now = performance.now() / 1000;   // seconds

        // Ensure we have a filter bank for this hand
        if (!this._filters.has(handIndex) ||
            this._filters.get(handIndex).length !== rawLandmarks.length) {
            const bank = rawLandmarks.map(() => ({
                x: new OneEuroFilter(this._filterFreq, this._filterMinCutoff, this._filterBeta, this._filterDCutoff),
                y: new OneEuroFilter(this._filterFreq, this._filterMinCutoff, this._filterBeta, this._filterDCutoff),
                z: new OneEuroFilter(this._filterFreq, this._filterMinCutoff, this._filterBeta, this._filterDCutoff),
            }));
            this._filters.set(handIndex, bank);
        }

        const bank = this._filters.get(handIndex);

        return rawLandmarks.map((p, i) => ({
            x: bank[i].x.filter(p.x, now),
            y: bank[i].y.filter(p.y, now),
            z: bank[i].z.filter(p.z, now),
        }));
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
    getFingerTips() {
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
            { name: 'index', tip: 8, dip: 7, pip: 6, mcp: 5 },
            { name: 'middle', tip: 12, dip: 11, pip: 10, mcp: 9 },
            { name: 'ring', tip: 16, dip: 15, pip: 14, mcp: 13 },
            { name: 'pinky', tip: 20, dip: 19, pip: 18, mcp: 17 },
        ];

        const tips = [];
        this.results.multiHandLandmarks.forEach((lm, hi) => {
            const wrist = lm[0];

            for (const f of FINGERS) {
                // --- Multi-criteria extension test ---
                // 1. Distance test: tip must be farther from wrist than PIP
                const tipDist = Math.hypot(lm[f.tip].x - wrist.x,
                    lm[f.tip].y - wrist.y);
                const pipDist = Math.hypot(lm[f.pip].x - wrist.x,
                    lm[f.pip].y - wrist.y);
                const distExtended = tipDist > pipDist;

                // 2. Angle test: angle at PIP joint (tip-pip-mcp)
                //    Extended finger → angle close to 180° (> ~140°)
                //    Curled finger → angle much smaller
                const angle = this._jointAngle(lm[f.tip], lm[f.pip], lm[f.mcp]);
                const angleExtended = angle > 135;

                // 3. DIP straightness: tip-dip-pip angle > 130° means last
                //    segment isn't curled inward
                const dipAngle = this._jointAngle(lm[f.tip], lm[f.dip], lm[f.pip]);
                const dipStraight = dipAngle > 120;

                // Require at least 2 of 3 criteria (robust to noise)
                const score = (distExtended ? 1 : 0) + (angleExtended ? 1 : 0) + (dipStraight ? 1 : 0);
                if (score < 2) continue; // finger is curled

                tips.push({
                    x: lm[f.tip].x,
                    y: lm[f.tip].y,
                    z: lm[f.tip].z,
                    finger: f.name,
                    hand: hi,
                });
            }
        });
        return tips;
    }

    /**
     * Compute angle (in degrees) at point B formed by vectors BA and BC.
     * Used for finger extension detection.
     */
    _jointAngle(a, b, c) {
        const bax = a.x - b.x, bay = a.y - b.y;
        const bcx = c.x - b.x, bcy = c.y - b.y;
        const dot = bax * bcx + bay * bcy;
        const magBA = Math.hypot(bax, bay);
        const magBC = Math.hypot(bcx, bcy);
        if (magBA === 0 || magBC === 0) return 180;
        const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
        return Math.acos(cosAngle) * (180 / Math.PI);
    }

    /**
     * Returns the full set of 21 landmarks per hand (for debug drawing).
     */
    getLandmarks() {
        if (!this.results) return [];
        return this.results.multiHandLandmarks || [];
    }
}

window.HandTracker = HandTracker;
