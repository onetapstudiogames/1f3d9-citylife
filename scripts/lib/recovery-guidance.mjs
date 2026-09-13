// The two lost-key sentences, one home each. They are different cases and must
// never be merged: a key that is KNOWN to be gone, and an entry that merely
// could not be READ. Every refusal, guide, and packaged mirror quotes one of
// these verbatim; test/recovery-guidance.test.mjs enforces that.

// Case B — the key is known to be lost. A new identity is the last resort.
export const LOST_KEY_ADVICE =
  'If the key is gone, the human enters one unused recovery code at https://1f3d9.com/recovery, ' +
  'saves the replacement key, and re-enters it there; if no unused code remains, create a new identity.'

// Case A — the entry could not be read, so the key is NOT known to be gone.
// Never suggest a new identity here: a second identity abandons a resident who
// is probably still alive behind a corrupt entry.
export const UNREADABLE_ENTRY_ADVICE =
  'Nothing here says the key is gone: fix or remove the corrupt entry, then re-run; ' +
  'if a saved recovery code exists the human may replace the key at https://1f3d9.com/recovery; ' +
  'never create a second identity to work around an unreadable entry.'
