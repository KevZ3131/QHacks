'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../js/interaction-engine.js');

test('tap detection requires deliberate downward motion and enforces cooldown', () => {
    const engine = new InteractionEngine({
        historySize: 3,
        velocityThreshold: 0.01,
        cooldownMs: 250,
    });
    const tip = y => ({ hand: 0, finger: 'index', x: 0.5, y });

    assert.equal(engine.updateTap(tip(0.20), 0), false);
    assert.equal(engine.updateTap(tip(0.205), 16), false);
    assert.equal(engine.updateTap(tip(0.225), 32), true);
    assert.equal(engine.updateTap(tip(0.24), 48), false);
    assert.equal(engine.updateTap(tip(0.27), 64), false);
    assert.equal(engine.updateTap(tip(0.31), 300), true);
});

test('hitTest respects polygons, padding, priority, and smallest-area ordering', () => {
    const engine = new InteractionEngine();
    const white = {
        id: 'white', type: 'rectangle', priority: 0, area: 400,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    };
    const black = {
        id: 'black', type: 'rectangle', priority: 1, area: 100,
        x: 5, y: 0, width: 10, height: 10,
    };

    assert.equal(engine.hitTest([white, black], 8, 5).id, 'black');
    assert.equal(engine.hitTest([white], 23, 10, 3).id, 'white');
    assert.equal(engine.hitTest([white], 24, 10, 3), null);
});

test('prune removes histories for fingertips that disappear', () => {
    const engine = new InteractionEngine();
    engine.updateTap({ hand: 0, finger: 'index', y: 0.2 }, 0);
    engine.updateTap({ hand: 1, finger: 'middle', y: 0.2 }, 0);

    engine.prune([{ hand: 1, finger: 'middle' }]);

    assert.deepEqual([...engine.tapState.keys()], ['1:middle']);
});
