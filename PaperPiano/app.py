"""
Paper Piano — Flask backend
Serves static files and provides MIDI song parsing API.
"""
import os
import glob
import json

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import mido

app = Flask(__name__, static_url_path='', static_folder='.')
CORS(app)

MIDI_DIR = os.path.join(os.path.dirname(__file__), 'midi_songs')


# ── Static file serving ──────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


# ── MIDI API ─────────────────────────────────────────────────────────

@app.route('/api/songs', methods=['GET'])
def list_songs():
    """Return a list of available MIDI files in midi_songs/."""
    if not os.path.isdir(MIDI_DIR):
        return jsonify({'songs': []})

    files = []
    for ext in ('*.mid', '*.midi'):
        files.extend(glob.glob(os.path.join(MIDI_DIR, ext)))

    songs = []
    for f in sorted(files):
        name = os.path.splitext(os.path.basename(f))[0]
        songs.append({'name': name, 'file': os.path.basename(f)})

    return jsonify({'songs': songs})


@app.route('/api/songs/search', methods=['POST'])
def search_songs():
    """Search available MIDI files by name substring."""
    data = request.get_json(silent=True) or {}
    query = data.get('query', '').strip().lower()

    if not os.path.isdir(MIDI_DIR):
        return jsonify({'songs': []})

    files = []
    for ext in ('*.mid', '*.midi'):
        files.extend(glob.glob(os.path.join(MIDI_DIR, ext)))

    songs = []
    for f in sorted(files):
        name = os.path.splitext(os.path.basename(f))[0]
        if query and query not in name.lower():
            continue
        songs.append({'name': name, 'file': os.path.basename(f)})

    return jsonify({'songs': songs})


@app.route('/api/songs/parse', methods=['POST'])
def parse_song():
    """
    Parse a MIDI file and return note events as JSON.

    Request body: { "file": "filename.mid", "track": null }
      - track: optional track index. null/omitted = merge all tracks.

    Response: {
        "name": "...",
        "tempo_bpm": 120,
        "duration": 45.2,
        "events": [
            {"note": 60, "name": "C4", "start": 0.5, "duration": 1.2, "velocity": 80, "track": 0},
            ...
        ]
    }
    """
    data = request.get_json(silent=True) or {}
    filename = data.get('file', '')

    if not filename:
        return jsonify({'error': 'Missing "file" parameter'}), 400

    filepath = os.path.join(MIDI_DIR, filename)

    # Prevent directory traversal
    filepath = os.path.realpath(filepath)
    if not filepath.startswith(os.path.realpath(MIDI_DIR)):
        return jsonify({'error': 'Invalid file path'}), 400

    if not os.path.isfile(filepath):
        return jsonify({'error': f'File not found: {filename}'}), 404

    try:
        events, tempo_bpm, duration = _parse_midi(filepath, data.get('track'))
    except Exception as e:
        return jsonify({'error': f'MIDI parse error: {str(e)}'}), 500

    return jsonify({
        'name': os.path.splitext(filename)[0],
        'tempo_bpm': round(tempo_bpm, 1),
        'duration': round(duration, 3),
        'events': events,
    })


# ── MIDI parsing helpers ─────────────────────────────────────────────

NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def _midi_note_name(note_number):
    """Convert MIDI note number (0-127) to name like 'C4'."""
    octave = (note_number // 12) - 1
    name = NOTE_NAMES[note_number % 12]
    return f'{name}{octave}'


def _parse_midi(filepath, track_filter=None):
    """
    Parse a MIDI file into a list of note events.

    Returns: (events, tempo_bpm, total_duration_seconds)
    """
    mid = mido.MidiFile(filepath)

    # Get tempo (default 120 BPM = 500000 microseconds per beat)
    tempo = 500000
    for track in mid.tracks:
        for msg in track:
            if msg.type == 'set_tempo':
                tempo = msg.tempo
                break

    tempo_bpm = mido.tempo2bpm(tempo)
    ticks_per_beat = mid.ticks_per_beat

    events = []
    active_notes = {}  # (track_idx, note) → (start_time, velocity)

    for track_idx, track in enumerate(mid.tracks):
        if track_filter is not None and track_idx != track_filter:
            continue

        abs_time = 0  # in ticks

        for msg in track:
            abs_time += msg.time

            # Convert ticks to seconds
            time_sec = mido.tick2second(abs_time, ticks_per_beat, tempo)

            if msg.type == 'note_on' and msg.velocity > 0:
                key = (track_idx, msg.note)
                active_notes[key] = (time_sec, msg.velocity)

            elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                key = (track_idx, msg.note)
                if key in active_notes:
                    start, velocity = active_notes.pop(key)
                    duration = time_sec - start
                    if duration > 0:
                        events.append({
                            'note': msg.note,
                            'name': _midi_note_name(msg.note),
                            'start': round(start, 4),
                            'duration': round(duration, 4),
                            'velocity': velocity,
                            'track': track_idx,
                        })

    # Sort by start time
    events.sort(key=lambda e: e['start'])

    # Total duration
    total_duration = max((e['start'] + e['duration'] for e in events), default=0)

    return events, tempo_bpm, total_duration


if __name__ == '__main__':
    print(f'[Paper Piano] MIDI directory: {MIDI_DIR}')
    midi_count = len(glob.glob(os.path.join(MIDI_DIR, '*.mid'))) + len(glob.glob(os.path.join(MIDI_DIR, '*.midi')))
    print(f'[Paper Piano] Found {midi_count} MIDI file(s)')
    app.run(host='0.0.0.0', port=5000, debug=True)
