// The chat composer's unsent words, per account, held across screen changes.
//
// A module of its own rather than a Map inside teamChat.jsx, because the one
// other thing that has to reach it is sign-out, which lives in App.jsx and
// loads the chat screen lazily: importing a name from the chat chunk would
// pull the whole screen into the shell bundle. Keyed by profile id, so a
// shared tablet never shows one person another's draft; forgotten when a
// session ends, so the rule that sign-out clears everything stays true.
const held = new Map();

export const heldDraftFor = profileId => held.get(profileId) || "";
export function holdDraft(profileId, text) {
  if (text) held.set(profileId, text);
  else held.delete(profileId);
}
export function forgetHeldDrafts() { held.clear(); }
