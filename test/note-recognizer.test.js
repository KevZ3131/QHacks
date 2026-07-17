'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
require('../js/note-recognizer.js');

function rectangle(centerX, area = 1000) {
    return { type: 'rectangle', centerX, centerY: 50, width: 20, height: 50, area };
}

test('assignNotes maps white keys left-to-right and advances octaves', () => {
    const recognizer = new NoteRecognizer();
    const rectangles = Array.from({ length: 8 }, (_, i) => rectangle(i * 30));

    const notes = recognizer.assignNotes({ rectangles, circles: [] }, 4);

    assert.deepEqual(notes.map(shape => shape.note),
        ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5']);
});

test('assignNotes cycles drum sounds predictably', () => {
    const recognizer = new NoteRecognizer();
    const circles = Array.from({ length: 7 }, (_, i) => ({
        type: 'circle', centerX: i * 30, centerY: 50, radius: 12, area: 450,
    }));

    const notes = recognizer.assignNotes({ rectangles: [], circles }, 4);

    assert.deepEqual(notes.map(shape => shape.note),
        ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'crash', 'kick']);
});

test('black-key mapping never produces unsupported E# or B# notes', () => {
    const recognizer = new NoteRecognizer();
    const whiteKeys = [
        { centerX: 0, note: 'C4' },
        { centerX: 30, note: 'D4' },
        { centerX: 60, note: 'E4' },
    ];

    assert.equal(recognizer._deriveBlackNote({ centerX: 70 }, whiteKeys, 0, 4), 'D#4');
});
