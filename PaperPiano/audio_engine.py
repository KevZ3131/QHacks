"""
AudioEngine — Pure-Python tone synthesis using the built-in audioop / wave
approach piped through PyAudio *or* a cross-platform fallback via
winsound (Windows) or simpleaudio.

Uses numpy to generate ADSR-enveloped waveforms in real time.
Each note-on spawns a background thread that writes samples
continuously until note-off requests a release.
"""

import math
import threading
import struct
import time
import numpy as np

# ── Note frequencies (C4-B4) ──────────────────────────────────────────────────
NOTE_FREQUENCIES = {
    'C': 261.63, 'C#': 277.18, 'Db': 277.18,
    'D': 293.66, 'D#': 311.13, 'Eb': 311.13,
    'E': 329.63,
    'F': 349.23, 'F#': 369.99, 'Gb': 369.99,
    'G': 392.00, 'G#': 415.30, 'Ab': 415.30,
    'A': 440.00, 'A#': 466.16, 'Bb': 466.16,
    'B': 493.88,
}

# ── Waveform helpers ──────────────────────────────────────────────────────────
def _sine(t, freq):
    return np.sin(2 * np.pi * freq * t)

def _triangle(t, freq):
    return 2 * np.abs(2 * (t * freq - np.floor(t * freq + 0.5))) - 1

def _sawtooth(t, freq):
    return 2 * (t * freq - np.floor(t * freq + 0.5))

def _square(t, freq):
    return np.sign(np.sin(2 * np.pi * freq * t))

WAVE_FN = {
    'sine': _sine,
    'triangle': _triangle,
    'sawtooth': _sawtooth,
    'square': _square,
}

# ── Presets (mirror the JS version) ──────────────────────────────────────────
PRESETS = {
    'piano': {
        'oscillators': [
            {'type': 'triangle', 'detune': 0, 'gain': 0.35},
            {'type': 'sine', 'freq_mul': 2, 'gain': 0.08},
            {'type': 'sine', 'freq_mul': 0.5, 'gain': 0.04},
        ],
        'attack': 0.008,
        'decay': 0.25,
        'sustain': 0.15,
        'release': 0.2,
    },
    'organ': {
        'oscillators': [
            {'type': 'sine', 'detune': 0, 'gain': 0.25},
            {'type': 'sine', 'freq_mul': 2, 'gain': 0.15},
            {'type': 'sine', 'freq_mul': 3, 'gain': 0.08},
            {'type': 'sine', 'freq_mul': 4, 'gain': 0.04},
        ],
        'attack': 0.05,
        'decay': 0.1,
        'sustain': 0.3,
        'release': 0.1,
    },
    'synth': {
        'oscillators': [
            {'type': 'sawtooth', 'detune': 0, 'gain': 0.2},
            {'type': 'sawtooth', 'detune': 7, 'gain': 0.15},
            {'type': 'square', 'freq_mul': 0.5, 'gain': 0.05},
        ],
        'attack': 0.005,
        'decay': 0.15,
        'sustain': 0.25,
        'release': 0.3,
    },
}

SAMPLE_RATE = 44100
CHUNK = 1024

# ── Try to import a suitable audio backend ───────────────────────────────────
_backend = None
try:
    import pyaudio                       # pip install pyaudio
    _backend = 'pyaudio'
except ImportError:
    pass

if _backend is None:
    try:
        import simpleaudio               # pip install simpleaudio
        _backend = 'simpleaudio'
    except ImportError:
        pass


class AudioEngine:
    """Low-latency multi-note synthesiser with ADSR envelope."""

    def __init__(self):
        self.preset_name = 'piano'
        self._active: dict[str, dict] = {}   # shape_id → control dict
        self._lock = threading.Lock()
        self._stream = None
        self._pa = None
        self._running = False
        self._audio_thread = None

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def init(self):
        if self._running:
            return
        self._running = True
        if _backend == 'pyaudio':
            self._pa = pyaudio.PyAudio()
            self._stream = self._pa.open(
                format=pyaudio.paFloat32,
                channels=1,
                rate=SAMPLE_RATE,
                output=True,
                frames_per_buffer=CHUNK,
                stream_callback=self._pyaudio_cb,
            )
            self._stream.start_stream()
        else:
            # Real-time fallback: generate chunks in a thread
            self._audio_thread = threading.Thread(target=self._audio_loop, daemon=True)
            self._audio_thread.start()

    def _pyaudio_cb(self, in_data, frame_count, time_info, status):
        import pyaudio as _pa
        data = self._render(frame_count)
        return (data.tobytes(), _pa.paContinue)

    def _audio_loop(self):
        """Fallback loop for simpleaudio / winsound — not ideal latency."""
        if _backend == 'simpleaudio':
            while self._running:
                with self._lock:
                    if not self._active:
                        time.sleep(0.01)
                        continue
                samples = self._render(CHUNK * 4)
                pcm = (samples * 32767).astype(np.int16)
                try:
                    play = simpleaudio.play_buffer(pcm, 1, 2, SAMPLE_RATE)
                    play.wait_done()
                except Exception:
                    time.sleep(0.01)

    def _render(self, n_frames: int) -> np.ndarray:
        """Mix all active notes into a single float32 buffer."""
        buf = np.zeros(n_frames, dtype=np.float32)
        t = np.arange(n_frames, dtype=np.float64) / SAMPLE_RATE
        dead = []
        with self._lock:
            for sid, ctrl in self._active.items():
                phase = ctrl['phase']
                freq = ctrl['freq']
                preset = ctrl['preset']
                releasing = ctrl['releasing']

                osc_sum = np.zeros(n_frames, dtype=np.float64)
                for odef in preset['oscillators']:
                    fn = WAVE_FN.get(odef['type'], _sine)
                    f = odef.get('freq_mul', 1.0) * freq
                    detune_cents = odef.get('detune', 0)
                    if detune_cents:
                        f *= 2 ** (detune_cents / 1200)
                    osc_sum += fn(t + phase, f) * odef['gain']

                # Simple ADSR envelope
                env = self._envelope(ctrl, n_frames, preset)
                osc_sum *= env

                buf += osc_sum.astype(np.float32)
                ctrl['phase'] += n_frames / SAMPLE_RATE
                ctrl['env_pos'] += n_frames

                if releasing and ctrl.get('env_done', False):
                    dead.append(sid)

            for sid in dead:
                self._active.pop(sid, None)

        # Soft-clip
        buf = np.tanh(buf * 0.8) * 0.6
        return buf

    def _envelope(self, ctrl, n_frames, preset):
        """Per-sample ADSR envelope."""
        a = int(preset['attack'] * SAMPLE_RATE)
        d = int(preset['decay'] * SAMPLE_RATE)
        s = preset['sustain']
        r = int(preset['release'] * SAMPLE_RATE)

        env = np.ones(n_frames, dtype=np.float64)
        pos = ctrl['env_pos']

        if ctrl['releasing']:
            rel_pos = ctrl.get('rel_pos', 0)
            for i in range(n_frames):
                p = rel_pos + i
                if p < r:
                    env[i] = ctrl['rel_level'] * (1.0 - p / r)
                else:
                    env[i] = 0.0
                    ctrl['env_done'] = True
            ctrl['rel_pos'] = rel_pos + n_frames
        else:
            for i in range(n_frames):
                p = pos + i
                if p < a:
                    env[i] = p / a if a > 0 else 1.0
                elif p < a + d:
                    frac = (p - a) / d if d > 0 else 1.0
                    env[i] = 1.0 - frac * (1.0 - s)
                else:
                    env[i] = s

        return env

    # ── public API ────────────────────────────────────────────────────────────
    def set_preset(self, name: str):
        if name in PRESETS:
            self.preset_name = name

    def note_on(self, shape_id: str, note_name: str):
        if not self._running:
            self.init()
        freq = self.get_frequency(note_name)
        if freq is None:
            return
        with self._lock:
            if shape_id in self._active:
                return  # already playing
            self._active[shape_id] = {
                'freq': freq,
                'preset': PRESETS[self.preset_name],
                'phase': 0.0,
                'env_pos': 0,
                'releasing': False,
                'rel_level': PRESETS[self.preset_name]['sustain'],
                'rel_pos': 0,
                'env_done': False,
            }

    def note_off(self, shape_id: str):
        with self._lock:
            ctrl = self._active.get(shape_id)
            if ctrl and not ctrl['releasing']:
                ctrl['releasing'] = True
                ctrl['rel_pos'] = 0
                # Capture current envelope level for smooth release
                preset = ctrl['preset']
                a = int(preset['attack'] * SAMPLE_RATE)
                d = int(preset['decay'] * SAMPLE_RATE)
                s = preset['sustain']
                pos = ctrl['env_pos']
                if pos < a:
                    ctrl['rel_level'] = pos / a if a > 0 else 1.0
                elif pos < a + d:
                    frac = (pos - a) / d if d > 0 else 1.0
                    ctrl['rel_level'] = 1.0 - frac * (1.0 - s)
                else:
                    ctrl['rel_level'] = s

    def note_off_all(self):
        with self._lock:
            for sid in list(self._active.keys()):
                ctrl = self._active[sid]
                if not ctrl['releasing']:
                    ctrl['releasing'] = True
                    ctrl['rel_pos'] = 0
                    ctrl['rel_level'] = PRESETS[self.preset_name]['sustain']

    def get_frequency(self, note_name: str):
        if not note_name:
            return None
        name = note_name.strip()
        if name in NOTE_FREQUENCIES:
            return NOTE_FREQUENCIES[name]
        upper = name.upper()
        for k, v in NOTE_FREQUENCIES.items():
            if k.upper() == upper:
                return v
        letter = upper[0] if upper else ''
        return NOTE_FREQUENCIES.get(letter)

    def destroy(self):
        self._running = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
        if self._pa:
            self._pa.terminate()
