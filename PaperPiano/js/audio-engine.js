/**
 * AudioEngine - Web Audio API synthesis for musical notes.
 * Uses multiple oscillators with ADSR envelope for rich, low-latency sound.
 */

const NOTE_FREQUENCIES = {
    'C': 261.63, 'C#': 277.18, 'Db': 277.18,
    'D': 293.66, 'D#': 311.13, 'Eb': 311.13,
    'E': 329.63,
    'F': 349.23, 'F#': 369.99, 'Gb': 369.99,
    'G': 392.00, 'G#': 415.30, 'Ab': 415.30,
    'A': 440.00, 'A#': 466.16, 'Bb': 466.16,
    'B': 493.88
};

// Waveform presets for different instruments
const PRESETS = {
    piano: {
        oscillators: [
            { type: 'triangle', detune: 0, gain: 0.35 },
            { type: 'sine', freqMul: 2, gain: 0.08 },
            { type: 'sine', freqMul: 0.5, gain: 0.04 }
        ],
        attack: 0.008,
        decay: 0.25,
        sustain: 0.15,
        release: 0.2
    },
    organ: {
        oscillators: [
            { type: 'sine', detune: 0, gain: 0.25 },
            { type: 'sine', freqMul: 2, gain: 0.15 },
            { type: 'sine', freqMul: 3, gain: 0.08 },
            { type: 'sine', freqMul: 4, gain: 0.04 }
        ],
        attack: 0.05,
        decay: 0.1,
        sustain: 0.3,
        release: 0.1
    },
    synth: {
        oscillators: [
            { type: 'sawtooth', detune: 0, gain: 0.2 },
            { type: 'sawtooth', detune: 7, gain: 0.15 },
            { type: 'square', freqMul: 0.5, gain: 0.05 }
        ],
        attack: 0.005,
        decay: 0.15,
        sustain: 0.25,
        release: 0.3
    }
};

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.compressor = null;
        this.activeNotes = new Map();
        this.preset = 'piano';
    }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'interactive',
            sampleRate: 44100
        });

        // Dynamics compressor prevents clipping with many simultaneous notes
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -20;
        this.compressor.knee.value = 20;
        this.compressor.ratio.value = 8;
        this.compressor.attack.value = 0.002;
        this.compressor.release.value = 0.15;

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.6;

        this.compressor.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);
    }

    resume() {
        if (this.ctx?.state === 'suspended') {
            this.ctx.resume();
        }
    }

    setPreset(name) {
        if (PRESETS[name]) this.preset = name;
    }

    /**
     * Start playing a note for a given shape.
     * If the shape is already playing, this is a no-op (prevents re-triggering).
     */
    noteOn(shapeId, noteName) {
        if (!this.ctx) this.init();
        this.resume();

        if (this.activeNotes.has(shapeId)) return;

        const freq = this.getFrequency(noteName);
        if (!freq) return;

        const preset = PRESETS[this.preset];
        const now = this.ctx.currentTime;
        const nodes = [];

        for (const oscDef of preset.oscillators) {
            const osc = this.ctx.createOscillator();
            osc.type = oscDef.type;

            const oscFreq = oscDef.freqMul ? freq * oscDef.freqMul : freq;
            osc.frequency.setValueAtTime(oscFreq, now);
            if (oscDef.detune) osc.detune.setValueAtTime(oscDef.detune, now);

            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, now);
            // Attack
            gain.gain.linearRampToValueAtTime(oscDef.gain, now + preset.attack);
            // Decay to sustain
            gain.gain.exponentialRampToValueAtTime(
                Math.max(oscDef.gain * (preset.sustain / 0.35), 0.001),
                now + preset.attack + preset.decay
            );

            osc.connect(gain);
            gain.connect(this.compressor);
            osc.start(now);

            nodes.push({ osc, gain });
        }

        this.activeNotes.set(shapeId, { nodes, preset });
    }

    /**
     * Stop a note for a given shape with a smooth release.
     */
    noteOff(shapeId) {
        const entry = this.activeNotes.get(shapeId);
        if (!entry) return;

        const now = this.ctx.currentTime;
        const release = entry.preset.release;

        for (const { osc, gain } of entry.nodes) {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(0.001, now + release);
            osc.stop(now + release + 0.02);
        }

        this.activeNotes.delete(shapeId);
    }

    noteOffAll() {
        for (const id of [...this.activeNotes.keys()]) {
            this.noteOff(id);
        }
    }

    getFrequency(noteName) {
        if (!noteName) return null;
        const name = noteName.trim();

        if (NOTE_FREQUENCIES[name]) return NOTE_FREQUENCIES[name];

        // Try uppercase
        const upper = name.toUpperCase();
        for (const [key, val] of Object.entries(NOTE_FREQUENCIES)) {
            if (key.toUpperCase() === upper) return val;
        }

        // Try just the first letter
        const letter = upper.charAt(0);
        if (NOTE_FREQUENCIES[letter]) return NOTE_FREQUENCIES[letter];

        return null;
    }
}
