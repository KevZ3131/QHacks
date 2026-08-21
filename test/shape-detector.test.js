'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../js/shape-detector.js');

test('geometry classifier accepts intended shapes and rejects contour noise', () => {
    const detector = new ShapeDetector();

    assert.equal(detector._classifyGeometry(8, 0.82, 0.74, 1.02), 'circle');
    assert.equal(detector._classifyGeometry(4, 0.63, 0.91, 0.35), 'rectangle');
    assert.equal(detector._classifyGeometry(18, 0.21, 0.25, 3.5), null);
    assert.equal(detector._classifyGeometry(3, 0.55, 0.72, 1.0), null);
});
