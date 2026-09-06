import React from "react";
import { Dialog, Btn } from "./common.jsx";
import { helpFor } from "../help.js";

// The "?" in the top bar. One panel per screen, written out in help.js —
// what the screen is for, what its buttons do, and the rules that catch
// people out.
//
// It reads the screen key rather than being told what to say, so the panel
// and the section name in the bar can never disagree: they are the same
// `screen` value.
//
// Nothing is fetched and nothing is written. A person opening this has a
// question, quite possibly with no signal, which is the whole reason the
// words are shipped with the app instead of living in the repository's
// markdown.
export function HelpDialog({ screenKey, onClose }) {
  const entry = helpFor(screenKey);
  // The button that opens this is already hidden without an entry; this is
  // the same answer given twice, so a future caller cannot open an empty
  // dialog somebody then has to work out how to close.
  if (!entry) return null;

  return (
    <Dialog title="How this screen works" maxWidth={620} onClose={onClose}
      actions={<Btn variant="primary" onClick={onClose}>Close</Btn>}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 18 }}>
        {entry.heading}
      </div>
      {/* Paragraphs, not a list: these are sentences about how the screen
          behaves, and bullets would invite them to be trimmed to fragments
          that no longer say why. The line height is loose because this is
          read on a phone, in daylight, standing up. */}
      {entry.body.map((para, i) => (
        <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{para}</p>
      ))}
    </Dialog>
  );
}
