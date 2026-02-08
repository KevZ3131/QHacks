export const SONGS = [
    {
        id: 'twinkle',
        title: 'Twinkle Twinkle Little Star',
        bpm: 100,
        // simple format: [note, duration_beats]
        // or [note, start_beat, duration_beats]
        // Let's use [note, start_beat, duration_beats] for polyphony support
        notes: [
            { n: 'C4', s: 0, d: 1 }, { n: 'C4', s: 1, d: 1 }, { n: 'G4', s: 2, d: 1 }, { n: 'G4', s: 3, d: 1 },
            { n: 'A4', s: 4, d: 1 }, { n: 'A4', s: 5, d: 1 }, { n: 'G4', s: 6, d: 2 },
            { n: 'F4', s: 8, d: 1 }, { n: 'F4', s: 9, d: 1 }, { n: 'E4', s: 10, d: 1 }, { n: 'E4', s: 11, d: 1 },
            { n: 'D4', s: 12, d: 1 }, { n: 'D4', s: 13, d: 1 }, { n: 'C4', s: 14, d: 2 }
        ]
    },
    {
        id: 'ode_to_joy',
        title: 'Ode to Joy',
        bpm: 120,
        notes: [
            { n: 'E4', s: 0, d: 1 }, { n: 'E4', s: 1, d: 1 }, { n: 'F4', s: 2, d: 1 }, { n: 'G4', s: 3, d: 1 },
            { n: 'G4', s: 4, d: 1 }, { n: 'F4', s: 5, d: 1 }, { n: 'E4', s: 6, d: 1 }, { n: 'D4', s: 7, d: 1 },
            { n: 'C4', s: 8, d: 1 }, { n: 'C4', s: 9, d: 1 }, { n: 'D4', s: 10, d: 1 }, { n: 'E4', s: 11, d: 1 },
            { n: 'E4', s: 12, d: 1.5 }, { n: 'D4', s: 13.5, d: 0.5 }, { n: 'D4', s: 14, d: 2 }
        ]
    },
    {
        id: 'happy_birthday',
        title: 'Happy Birthday',
        bpm: 100,
        notes: [
            { n: 'C4', s: 0, d: 0.5 }, { n: 'C4', s: 0.5, d: 0.5 }, { n: 'D4', s: 1, d: 1 }, { n: 'C4', s: 2, d: 1 }, { n: 'F4', s: 3, d: 1 }, { n: 'E4', s: 4, d: 2 },
            { n: 'C4', s: 6, d: 0.5 }, { n: 'C4', s: 6.5, d: 0.5 }, { n: 'D4', s: 7, d: 1 }, { n: 'C4', s: 8, d: 1 }, { n: 'G4', s: 9, d: 1 }, { n: 'F4', s: 10, d: 2 }
        ]
    }
];
