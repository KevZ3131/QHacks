/**
 * HandTracker - Real-time hand landmark detection using MediaPipe Tasks-Vision.
 * Tracks fingertip positions for each detected hand.
 */

export class HandTracker {
    constructor() {
        this.handLandmarker = null;
        this.ready = false;
    }

    async init(onProgress) {
        try {
            if (onProgress) onProgress('Downloading hand-tracking model…');

            const vision = await import(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
            );

            const filesetResolver = await vision.FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
            );

            this.handLandmarker = await vision.HandLandmarker.createFromOptions(filesetResolver, {
                baseOptions: {
                    modelAssetPath:
                        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
                    delegate: 'GPU'
                },
                runningMode: 'VIDEO',
                numHands: 2,
                minHandDetectionConfidence: 0.5,
                minHandPresenceConfidence: 0.5,
                minTrackingConfidence: 0.5
            });

            this.ready = true;
            if (onProgress) onProgress('Hand tracking ready ✓');
        } catch (err) {
            console.error('HandTracker init failed:', err);
            throw err;
        }
    }

    /**
     * Run detection on a video frame.
     * @param {HTMLVideoElement} video
     * @param {number} timestamp - monotonically increasing (performance.now())
     * @returns {Object|null} MediaPipe hand results
     */
    detect(video, timestamp) {
        if (!this.ready || !this.handLandmarker) return null;
        try {
            return this.handLandmarker.detectForVideo(video, timestamp);
        } catch {
            return null;
        }
    }

    /**
     * Extract all fingertip positions from hand results.
     * Returns an array of hand objects, each with an array of 5 fingertip coords.
     * Landmark indices: thumb=4, index=8, middle=12, ring=16, pinky=20
     */
    getFingerTips(results, canvasWidth, canvasHeight) {
        if (!results?.landmarks?.length) return [];

        const TIP_IDS = [4, 8, 12, 16, 20];

        return results.landmarks.map(hand => ({
            // Primary: index finger tip
            x: hand[8].x * canvasWidth,
            y: hand[8].y * canvasHeight,
            z: hand[8].z,
            // All five fingertips
            tips: TIP_IDS.map(i => ({
                x: hand[i].x * canvasWidth,
                y: hand[i].y * canvasHeight,
                z: hand[i].z
            })),
            // Full landmark set for drawing
            landmarks: hand.map(lm => ({
                x: lm.x * canvasWidth,
                y: lm.y * canvasHeight,
                z: lm.z
            }))
        }));
    }
}
