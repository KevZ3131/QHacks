'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../js/audio-engine.js');

test('frequency table uses concert pitch and supports the configured octaves', () => {
    const audio = new AudioEngine();

    assert.equal(audio.freq.A4, 440);
    assert.ok(Math.abs(audio.freq.C4 - 261.6256) < 0.001);
    assert.ok(audio.freq.C2 > 0 && audio.freq.B6 > audio.freq.C2);
});

test('volume clamps safely before an audio context exists', () => {
    const audio = new AudioEngine();

    audio.setVolume(2);
    assert.equal(audio.volume, 1);
    audio.setVolume(-1);
    assert.equal(audio.volume, 0);
});
