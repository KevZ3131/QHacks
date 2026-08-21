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

test('perspective-distorted white keys are not misclassified by area alone', () => {
    const recognizer = new NoteRecognizer();
    const rectangles = [
        rectangle(0, 1000),
        rectangle(30, 900),
        rectangle(60, 600),
        rectangle(90, 950),
    ];

    const notes = recognizer.assignNotes({ rectangles, circles: [] }, 4);

    assert.equal(notes.filter(shape => shape.isBlack).length, 0);
    assert.deepEqual(notes.map(shape => shape.note), ['C4', 'D4', 'E4', 'F4']);
});

test('clearly shorter and smaller rectangles are classified as black keys', () => {
    const recognizer = new NoteRecognizer();
    const whites = Array.from({ length: 5 }, (_, index) => rectangle(index * 40, 1000));
    const blacks = [
        { ...rectangle(20, 300), width: 12, height: 25 },
        { ...rectangle(100, 300), width: 12, height: 25 },
    ];

    const assigned = recognizer.assignNotes({ rectangles: [...whites, ...blacks], circles: [] }, 4);

    assert.equal(assigned.filter(shape => shape.isBlack).length, 2);
});

test('custom notes survive a nearby re-scan', () => {
    const recognizer = new NoteRecognizer();
    recognizer.assignNotes({ rectangles: [rectangle(20), rectangle(60)], circles: [] }, 4);
    recognizer.setShapeNote('w0', 'G5');

    const rescanned = recognizer.assignNotes({
        rectangles: [rectangle(23), rectangle(63)],
        circles: [],
    }, 4);

    assert.equal(rescanned[0].note, 'G5');
    assert.equal(rescanned[0].customNote, true);
    assert.equal(rescanned[1].note, 'D4');
});

test('polygon presses reject points outside the actual contour', () => {
    const recognizer = new NoteRecognizer();
    recognizer.assignedShapes = [{
        id: 'w0', type: 'rectangle', priority: 0, area: 200,
        x: 0, y: 0, width: 20, height: 20,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 20 }],
    }];

    assert.equal(recognizer.getPresses([{ x: 0.5, y: 0.25 }], 20, 20).length, 1);
    assert.equal(recognizer.getPresses([{ x: 0.05, y: 0.95 }], 20, 20).length, 0);
});
