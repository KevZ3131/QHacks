/* =========================================================
   AudioEngine — Web Audio API synthesizer for piano & drums
   ========================================================= */
'use strict';

class AudioEngine {
    constructor () {
        /** @type {AudioContext|null} */
        this.ctx          = null;
        this.masterGain   = null;
        this.compressor   = null;
        this.initialized  = false;
        this.volume       = 0.75;
        this.muted        = false;
        /** Map<shapeId, {stop:Function}> */
        this.activeNotes  = new Map();
        /** Pre-computed note → frequency table */
        this.freq         = {};
        this._buildFrequencyTable();
    }

    /* ---------- public ---------- */

    /** Must be called from a user-gesture handler (click / tap). */
    init () {
        if (this.initialized) return true;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;

        this.ctx = new AudioContextClass();

        // Compressor → prevents clipping when many notes play at once
        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(-18, this.ctx.currentTime);
        this.compressor.knee.setValueAtTime(30, this.ctx.currentTime);
        this.compressor.ratio.setValueAtTime(12, this.ctx.currentTime);
        this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
        this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);

        // Master gain
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : this.volume;

        this.compressor.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);

        this.initialized = true;
        return true;
    }

    /** Resume context if it was suspended (autoplay policy). */
    async resume () {
        if (this.ctx && this.ctx.state === 'suspended') {
            try {
                await this.ctx.resume();
            } catch (error) {
                console.warn('[AudioEngine] could not resume audio:', error);
            }
        }
    }

    setVolume (value) {
        this.volume = Math.max(0, Math.min(1, Number(value) || 0));
        if (!this.masterGain || !this.ctx) return;
        this.masterGain.gain.setTargetAtTime(
            this.muted ? 0 : this.volume,
            this.ctx.currentTime,
            0.015
        );
    }

    setMuted (muted) {
        this.muted = Boolean(muted);
        this.setVolume(this.volume);
    }

    /**
     * Trigger a note.
     * @param {string} id       – unique shape id
     * @param {string} note     – e.g. 'C4', 'kick', 'snare'
     * @param {string} instrument – 'piano' | 'drums'
     */
    play (id, note, instrument) {
        if (!this.initialized) return false;
        if (instrument !== 'drums' && this.activeNotes.has(id)) return false;
        this.resume();

        if (instrument === 'piano') return this._pianoOn(id, note);
        if (instrument === 'drums') return this._drumHit(id, note);
        return false;
    }

    /** Release a sustained note. */
    stop (id) {
        if (!this.initialized) return;
        const entry = this.activeNotes.get(id);
        if (!entry) return;
        entry.stop();
        this.activeNotes.delete(id);
    }

    /** Release every sounding note. */
    stopAll () {
        for (const [id] of this.activeNotes) this.stop(id);
    }

    /* ---------- piano ---------- */

    _pianoOn (id, noteName) {
        const f = this.freq[noteName];
        if (!f) return false;

        const t  = this.ctx.currentTime;
        const out = this.compressor;

        // Envelope gain node
        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.55, t + 0.008);    // attack
        env.gain.exponentialRampToValueAtTime(0.30, t + 0.18); // decay → sustain
        env.connect(out);

        // Harmonics: fundamental + 2nd + 3rd + soft 5th partial
        const partials = [
            { type: 'triangle', detune:  0, gain: 0.50 },
            { type: 'sine',     detune:  0, gain: 0.18, ratio: 2 },
            { type: 'sine',     detune:  0, gain: 0.06, ratio: 3 },
            { type: 'sine',     detune: -5, gain: 0.03, ratio: 5 },
        ];

        const oscs = partials.map(p => {
            const o = this.ctx.createOscillator();
            o.type = p.type;
            o.frequency.value = f * (p.ratio || 1);
            o.detune.value = p.detune;
            const g = this.ctx.createGain();
            g.gain.value = p.gain;
            o.connect(g).connect(env);
            o.start(t);
            return o;
        });

        this.activeNotes.set(id, {
            stop: () => {
                const now = this.ctx.currentTime;
                env.gain.cancelScheduledValues(now);
                env.gain.setValueAtTime(env.gain.value, now);
                env.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
                oscs.forEach(o => o.stop(now + 0.15));
            },
        });
        return true;
    }

    /* ---------- drums ---------- */

    _drumHit (id, type) {
        const t = this.ctx.currentTime;
        switch (type) {
            case 'kick':   this._kick(t);   break;
            case 'snare':  this._snare(t);  break;
            case 'hihat':  this._hihat(t);  break;
            case 'tom1':   this._tom(t, 160); break;
            case 'tom2':   this._tom(t, 110); break;
            case 'crash':  this._crash(t);  break;
            default:       this._kick(t);   break;
        }
        // Drums are retriggerable one-shots. A token prevents an older
        // cleanup timer from deleting a newer hit that reused the same id.
        const token = Symbol(id);
        this.activeNotes.set(id, { stop: () => {}, token });
        setTimeout(() => {
            if (this.activeNotes.get(id)?.token === token) this.activeNotes.delete(id);
        }, 600);
        return true;
    }

    _kick (t) {
        const osc  = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain).connect(this.compressor);
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(35, t + 0.12);
        gain.gain.setValueAtTime(1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.start(t); osc.stop(t + 0.35);
    }

    _snare (t) {
        // Noise burst
        const buf   = this._noiseBuffer(0.18);
        const noise = this.ctx.createBufferSource();
        noise.buffer = buf;
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 1200;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.75, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        noise.connect(hp).connect(ng).connect(this.compressor);
        noise.start(t); noise.stop(t + 0.18);

        // Body tone
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle'; osc.frequency.value = 180;
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(0.6, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        osc.connect(og).connect(this.compressor);
        osc.start(t); osc.stop(t + 0.08);
    }

    _hihat (t) {
        const buf   = this._noiseBuffer(0.06);
        const noise = this.ctx.createBufferSource();
        noise.buffer = buf;
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 7500;
        const g  = this.ctx.createGain();
        g.gain.setValueAtTime(0.45, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        noise.connect(hp).connect(g).connect(this.compressor);
        noise.start(t); noise.stop(t + 0.06);
    }

    _tom (t, freq) {
        const osc  = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain).connect(this.compressor);
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.45, t + 0.18);
        gain.gain.setValueAtTime(0.75, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.start(t); osc.stop(t + 0.28);
    }

    _crash (t) {
        const buf   = this._noiseBuffer(0.55);
        const noise = this.ctx.createBufferSource();
        noise.buffer = buf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 5500; bp.Q.value = 0.6;
        const g  = this.ctx.createGain();
        g.gain.setValueAtTime(0.55, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
        noise.connect(bp).connect(g).connect(this.compressor);
        noise.start(t); noise.stop(t + 0.55);
    }

    /* ---------- helpers ---------- */

    _noiseBuffer (seconds) {
        const len = this.ctx.sampleRate * seconds;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d   = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        return buf;
    }

    _buildFrequencyTable () {
        const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        for (let oct = 0; oct <= 8; oct++) {
            names.forEach((n, i) => {
                const midi = (oct + 1) * 12 + i;          // C4 = MIDI 60
                this.freq[n + oct] = 440 * Math.pow(2, (midi - 69) / 12);
            });
        }
    }
}

// Expose globally (no-build setup)
window.AudioEngine = AudioEngine;
