"""
NoteRecognizer — OCR-based musical-note recognition using pytesseract.
Falls back to sequential default notes when OCR is unavailable or uncertain.
"""

import re

VALID_NOTES = [
    'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
    'Db', 'Eb', 'Gb', 'Ab', 'Bb',
]

DEFAULT_SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

# Try to import pytesseract
_tesseract_available = False
try:
    import pytesseract
    _tesseract_available = True
except ImportError:
    pass


class NoteRecognizer:
    def __init__(self):
        self.ready = _tesseract_available

    def recognize(self, image) -> str | None:
        """
        Attempt to recognize a note name from a preprocessed image (numpy array).
        Returns recognized note or None.
        """
        if not self.ready:
            return None
        try:
            text = pytesseract.image_to_string(
                image,
                config='--psm 8 -c tessedit_char_whitelist=ABCDEFGabcdefg#',
            )
            return self.parse(text)
        except Exception:
            return None

    def parse(self, text: str) -> str | None:
        """Parse raw OCR text into a valid musical note name."""
        if not text:
            return None

        cleaned = re.sub(r'[^A-Ga-g#]', '', text.strip().upper())
        if not cleaned:
            return None

        letter = cleaned[0]
        if letter not in 'ABCDEFG':
            return None

        note = letter
        if len(cleaned) > 1 and cleaned[1] == '#':
            note += '#'

        if note in VALID_NOTES:
            return note
        if letter in VALID_NOTES:
            return letter
        return None

    def get_default_note(self, index: int) -> str:
        """Return a sensible default note for a given shape index."""
        return DEFAULT_SCALE[index % len(DEFAULT_SCALE)]
