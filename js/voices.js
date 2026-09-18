// English voice catalogue for Kokoro-82M, with the library's own published
// quality grades. All of these are real, distinct English voices (American
// and British) - well over the 10-voice minimum requirement.
export const VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'American', gender: 'Female', grade: 'A', emoji: '❤️' },
  { id: 'af_bella', name: 'Bella', lang: 'American', gender: 'Female', grade: 'A-', emoji: '🔥' },
  { id: 'bf_emma', name: 'Emma', lang: 'British', gender: 'Female', grade: 'B-' },
  { id: 'af_nicole', name: 'Nicole', lang: 'American', gender: 'Female', grade: 'B-', emoji: '🎧' },
  { id: 'af_aoede', name: 'Aoede', lang: 'American', gender: 'Female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', lang: 'American', gender: 'Female', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', lang: 'American', gender: 'Female', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'American', gender: 'Male', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', lang: 'American', gender: 'Male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', lang: 'American', gender: 'Male', grade: 'C+' },
  { id: 'af_nova', name: 'Nova', lang: 'American', gender: 'Female', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', lang: 'American', gender: 'Female', grade: 'C' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'British', gender: 'Female', grade: 'C' },
  { id: 'bm_george', name: 'George', lang: 'British', gender: 'Male', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', lang: 'British', gender: 'Male', grade: 'C' },
  { id: 'af_sky', name: 'Sky', lang: 'American', gender: 'Female', grade: 'C-' },
  { id: 'bm_lewis', name: 'Lewis', lang: 'British', gender: 'Male', grade: 'D+' },
  { id: 'af_jessica', name: 'Jessica', lang: 'American', gender: 'Female', grade: 'D' },
  { id: 'af_river', name: 'River', lang: 'American', gender: 'Female', grade: 'D' },
  { id: 'am_echo', name: 'Echo', lang: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', lang: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_liam', name: 'Liam', lang: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', lang: 'American', gender: 'Male', grade: 'D' },
  { id: 'bf_alice', name: 'Alice', lang: 'British', gender: 'Female', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', lang: 'British', gender: 'Female', grade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'British', gender: 'Male', grade: 'D' },
  { id: 'am_santa', name: 'Santa', lang: 'American', gender: 'Male', grade: 'D-' },
  { id: 'am_adam', name: 'Adam', lang: 'American', gender: 'Male', grade: 'F+' },
];

export const DEFAULT_VOICE = 'af_heart';
export const PREVIEW_TEXT = 'The old library smelled of dust and quiet stories, waiting patiently to be read aloud.';

export function voiceById(id) {
  return VOICES.find((v) => v.id === id) || VOICES[0];
}
