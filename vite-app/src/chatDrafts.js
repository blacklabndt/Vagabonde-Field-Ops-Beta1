// The chat composer's unsent state, per account, held across screen changes.
//
// A module of its own rather than a Map inside teamChat.jsx, because the one
// other thing that has to reach it is sign-out, which lives in App.jsx and
// loads the chat screen lazily: importing a name from the chat chunk would
// pull the whole screen into the shell bundle. Keyed by profile id, so a
// shared tablet never shows one person another's draft; forgotten when a
// session ends, so the rule that sign-out clears everything stays true.
//
// It holds everything the composer had, not only the words: the message
// being answered, a picture chosen and not yet sent, a voice note recorded
// and not yet listened to. A technician who taps a job number in chat to
// check something and comes back used to find the words and nothing else —
// the reply had lost its parent and the picture had to be chosen again. The
// files are held as Files, not object URLs: a URL belongs to the document
// that minted it and the screen revokes its own on unmount, so the screen
// mints a fresh one from the held File when it comes back.
const held = new Map();
const EMPTY = Object.freeze({ text: "", reply: null, attachFile: null, voiceFile: null });

export const heldComposerFor = profileId => held.get(profileId) || EMPTY;
export const heldDraftFor = profileId => heldComposerFor(profileId).text;
export function holdComposer(profileId, patch) {
  const next = { ...heldComposerFor(profileId), ...patch };
  if (!next.text && !next.reply && !next.attachFile && !next.voiceFile) held.delete(profileId);
  else held.set(profileId, next);
}
export function holdDraft(profileId, text) { holdComposer(profileId, { text: text || "" }); }
export function forgetHeldDrafts() { held.clear(); }
