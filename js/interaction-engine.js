/* =========================================================
   InteractionEngine — tap tracking and shape hit-testing
   ========================================================= */
'use strict';

class InteractionEngine {
    constructor (options = {}) {
        this.historySize = options.historySize || 4;
        this.velocityThreshold = options.velocityThreshold || 0.008;
        this.cooldownMs = options.cooldownMs || 250;
        this.tapState = new Map();
    }

    /** Track a fingertip and report a quick downward tap. */
    updateTap (tip, now = performance.now()) {
        const key = tip.hand + ':' + tip.finger;
        let state = this.tapState.get(key);

        if (!state) {
            state = { yHistory: [tip.y], lastTapTime: -Infinity };
            this.tapState.set(key, state);
            return false;
        }

        state.yHistory.push(tip.y);
        if (state.yHistory.length > this.historySize) state.yHistory.shift();
        if (state.yHistory.length < 2) return false;
        if (now - state.lastTapTime < this.cooldownMs) return false;

        const velocity = state.yHistory[state.yHistory.length - 1] - state.yHistory[0];
        if (velocity <= this.velocityThreshold) return false;

        state.lastTapTime = now;
        state.yHistory.length = 0;
        return true;
    }

    /** Remove histories for fingers no longer visible. */
    prune (activeTips) {
        const activeKeys = new Set(activeTips.map(tip => tip.hand + ':' + tip.finger));
        for (const key of this.tapState.keys()) {
            if (!activeKeys.has(key)) this.tapState.delete(key);
        }
    }

    reset () {
        this.tapState.clear();
    }

    /** Select the highest-priority, smallest shape at a point. */
    hitTest (shapes, px, py, pad = 0) {
        const hits = shapes.filter(shape => this.contains(shape, px, py, pad));
        if (hits.length === 0) return null;

        hits.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.area - b.area;
        });
        return hits[0];
    }

    contains (shape, px, py, pad = 0) {
        if (shape.points && shape.points.length >= 3) {
            return this._pointInPolygon(px, py, shape.points, pad);
        }

        if (shape.type === 'circle') {
            return Math.hypot(px - shape.centerX, py - shape.centerY) <= shape.radius + pad;
        }

        return px >= shape.x - pad && px <= shape.x + shape.width + pad &&
               py >= shape.y - pad && py <= shape.y + shape.height + pad;
    }

    _pointInPolygon (px, py, points, pad) {
        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);
        const minX = Math.min(...xs) - pad;
        const maxX = Math.max(...xs) + pad;
        const minY = Math.min(...ys) - pad;
        const maxY = Math.max(...ys) + pad;
        if (px < minX || px > maxX || py < minY || py > maxY) return false;

        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const a = points[i];
            const b = points[j];
            const crosses = (a.y > py) !== (b.y > py);
            if (crosses && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }

        if (!inside && pad > 0) {
            for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
                if (this._distanceToSegment(px, py, points[j], points[i]) <= pad) return true;
            }
        }
        return inside;
    }

    _distanceToSegment (px, py, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared === 0) return Math.hypot(px - a.x, py - a.y);

        const ratio = ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared;
        const t = Math.max(0, Math.min(1, ratio));
        return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    }
}

window.InteractionEngine = InteractionEngine;
