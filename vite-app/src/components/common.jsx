import React, { useState, useEffect, useRef, useCallback } from "react";
import { Db } from "../db.js";
import { nonNegative } from "../data.js";

// Re-exported from data.js, which is where they live now — the sign-in path
// needs them and cannot import a file that pulls in React. Kept here so the
// screens that already import them from this module carry on working.
export { UNIVERSAL_TABS, tabList } from "../data.js";

// The wireframe frame every card/figure/primary-button wears: a transparent,
// hairline-bordered box with four "+" registration marks at the corners.
// Never drop the corners, never round it, never give it a surface fill.
export const Blueprint = React.forwardRef(function Blueprint({ style, className = "", children, as: Tag = "div", ...rest }, ref) {
  return (
    <Tag ref={ref} className={`blueprint ${className}`} style={style} {...rest}>
      <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
      {children}
    </Tag>
  );
});

// `type="button"` by default: these buttons live inside forms (the sign-in
// panel, for one), where the HTML default of `submit` makes any of them
// submit the form.
export function Btn({ variant = "secondary", block, style, children, type = "button", ...rest }) {
  const cls = `btn btn-${variant}${block ? " btn-block" : ""}`;
  return <button type={type} className={cls} style={style} {...rest}>{children}</button>;
}

// Wide tables scroll inside their card rather than stretching the page.
export function TableScroll({ children }) {
  return <div className="table-scroll">{children}</div>;
}

// A square tick-box that is actually operable from a keyboard. The screens
// were drawing these as bare <div onClick>, which no keyboard or screen
// reader could reach — including the hazard list on the JHA, where the whole
// point of the screen is recording what was ticked.
export function CheckBox({ on, onChange, label, size = 24, disabled }) {
  return (
    <div
      className={`hazard-check${on ? " on" : ""}`}
      style={{ width: size, height: size, cursor: disabled ? "not-allowed" : "pointer" }}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onChange(); }}
      onKeyDown={e => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(); }
      }}
    >{on ? "✓" : ""}</div>
  );
}

// Runs `fn` once the user stops typing. The rate-admin grid was writing to
// Supabase on every keystroke — "104" was three round trips, and the last one
// to land won, so a fast typist could persist a half-typed rate.
export function useDebounced(fn, delay = 500) {
  const timers = useRef({});
  const pending = useRef({});
  const latest = useRef(fn);
  latest.current = fn;
  // On unmount, run whatever is still waiting rather than dropping it. The
  // cleanup used to only clear the timers, so a rate typed and then navigated
  // away from inside the debounce window was silently never written.
  useEffect(() => () => {
    Object.keys(timers.current).forEach(key => {
      clearTimeout(timers.current[key]);
      delete timers.current[key];
      const args = pending.current[key];
      delete pending.current[key];
      if (args) { try { latest.current(key, ...args); } catch (e) { /* nothing left to show it on */ } }
    });
  }, []);
  const debounced = useCallback((key, ...args) => {
    pending.current[key] = args;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      delete timers.current[key];
      delete pending.current[key];
      latest.current(key, ...args);
    }, delay);
  }, [delay]);
  debounced.flush = useCallback(() => {
    const results = [];
    Object.keys(timers.current).forEach(key => {
      clearTimeout(timers.current[key]);
      delete timers.current[key];
      const args = pending.current[key];
      delete pending.current[key];
      if (args) results.push(latest.current(key, ...args));
    });
    return Promise.all(results);
  }, []);
  return debounced;
}

// `...rest` is forwarded so a tag can carry a `title` — the queued-items badge
// in the top bar passes one to explain itself, and it was being dropped.
export function TagX({ variant = "neutral", style, children, ...rest }) {
  const cls = variant === "dashed" ? "tag tag-dashed" : `tag tag-${variant}`;
  return <span className={cls} style={style} {...rest}>{children}</span>;
}

// `missing` tints the label to match the box below it, so the flagged field
// is identifiable without relying on the border colour on its own.
export function Field({ label, children, style, missing }) {
  return (
    <div className="field" style={style}>
      {label && <label className={missing ? "field-label-missing" : undefined}>{label}</label>}
      {children}
    </div>
  );
}

// Which fields a form is still waiting on.
//
// Every form here already refuses to submit and writes a sentence into the
// error box. That sentence says what is wrong but not where, so on anything
// longer than a couple of boxes you end up reading labels to find the one it
// means. This marks the actual fields.
//
// Usage: flag the keys when validation fails, spread props(key) onto the
// input, and pass missing={is(key)} to its Field.
export function useMissingFields() {
  const [missing, setMissing] = useState({});

  const flag = (...keys) => setMissing(Object.fromEntries(keys.filter(Boolean).map(k => [k, true])));
  const clear = () => setMissing({});
  // Drops the highlight the moment a field is filled, rather than leaving it
  // lit until the next submit — otherwise fixing the problem looks like it
  // didn't work.
  const fixed = key => setMissing(p => (p[key] ? { ...p, [key]: false } : p));
  const is = key => !!missing[key];

  const props = (key, base = "input") => ({
    className: is(key) ? `${base} invalid` : base,
    "aria-invalid": is(key) || undefined
  });

  // Jumps to the first flagged field. On a phone the offending box is often
  // below the fold, so the error box appears at the top and nothing visibly
  // happens where the user is looking.
  useEffect(() => {
    if (!Object.values(missing).some(Boolean)) return;
    const el = document.querySelector(".input.invalid");
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // preventScroll so focus doesn't fight the smooth scroll above.
    if (el.focus) el.focus({ preventScroll: true });
  }, [missing]);

  return { is, props, flag, clear, fixed };
}

// Pick one thing out of many by typing its name.
//
// Paging is the wrong shape for a picker: you already know what you want, and
// clicking through pages to reach it is slower than typing three letters. The
// search runs wherever the caller says — normally the server — so it matches
// everything on file rather than what happens to be on screen.
//
// The caller owns the query and how a row is drawn; this owns the input, the
// dropdown, the keyboard and the cap. `searchKey` is anything outside the
// typed text that changes the results (a scope toggle, say) — change it and
// the search re-runs.
export function SearchSelect({
  search, renderOption, optionKey, onPick, onError,
  placeholder, ariaLabel, listId = "search-select-list",
  searchKey = "", maxSuggestions = 25, style
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // Which row the keyboard is on. Kept apart from the mouse so hovering
  // doesn't fight arrow keys.
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  // Debounced so a fast typist makes one request, not one per letter.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      Promise.resolve(search(text, maxSuggestions))
        .then(res => {
          if (!live) return;
          const list = Array.isArray(res) ? res : res.rows;
          setRows(list || []);
          setTotal(Array.isArray(res) ? (list || []).length : res.total);
          setActive(0);
        })
        .catch(e => { if (live) { setRows([]); if (onError) onError(e.message || "Couldn't search."); } })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [text, searchKey, open]);

  // Close when the click lands anywhere else. mousedown rather than click, so
  // it closes before a button underneath receives its own press.
  useEffect(() => {
    const away = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const choose = o => { onPick(o); setText(""); setOpen(false); if (inputRef.current) inputRef.current.blur(); };

  const onKeyDown = e => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) choose(rows[active]); }
  };

  return (
    <div ref={boxRef} style={{ position: "relative", flex: "1 1 320px", maxWidth: 460, ...style }}>
      <input
        ref={inputRef}
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={e => { setText(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        style={{ width: "100%", minHeight: 38 }}
      />
      {open && (
        <div id={listId} role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 40,
            background: "var(--color-surface)", border: "1px solid var(--color-divider)",
            boxShadow: "var(--shadow-md)", maxHeight: 320, overflowY: "auto"
          }}>
          {loading && !rows.length && (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Searching…</div>
          )}
          {!loading && !rows.length && (
            <div style={{ padding: "10px 12px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {text ? `Nothing matches "${text}".` : "Nothing on file."}
            </div>
          )}
          {rows.map((o, i) => (
            <div key={optionKey(o)} role="option" aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); choose(o); }}
              onMouseEnter={() => setActive(i)}
              style={{
                padding: "8px 12px", cursor: "pointer",
                background: i === active ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "transparent"
              }}>
              {renderOption(o)}
            </div>
          ))}
          {total > rows.length && (
            <div style={{ padding: "8px 12px", fontSize: 11, borderTop: "1px solid var(--color-divider)", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Showing {rows.length} of {total} — keep typing to narrow it down.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZES = [10, 20, 40, 60, 80, 100];

// How many rows every paged screen shows, remembered across all of them.
//
// One preference rather than one per screen: somebody who wants 100 rows wants
// it because of their monitor, not because of the billing tracker, and having
// to set it again on each screen would be the annoying half of the feature.
// Stored in localStorage so it survives a reload — it is a display preference,
// not data, so it stays on the device rather than the profile.
const ROWS_KEY = "ui.rowsPerPage";
export function useRowsPerPage() {
  const [rows, setRows] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem(ROWS_KEY), 10);
      return PAGE_SIZES.includes(saved) ? saved : PAGE_SIZES[0];
    } catch (e) {
      // Private mode, or storage disabled. Not worth failing a screen over.
      return PAGE_SIZES[0];
    }
  });
  const choose = n => {
    setRows(n);
    try { localStorage.setItem(ROWS_KEY, String(n)); } catch (e) { /* as above */ }
  };
  return [rows, choose];
}

// The control itself. Sits with the filters at the top of a screen, not down
// by the pager, so it reads as "how this page is shown" rather than as part of
// stepping through it.
export function RowsPerPage({ value, onChange, style }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", ...style }}>
      Show
      <select className="input" aria-label="Rows per page"
        style={{ width: "auto", minHeight: 34, padding: "4px 8px", fontSize: 13 }}
        value={value} onChange={e => onChange(Number(e.target.value))}>
        {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      rows
    </label>
  );
}

export function PdfGlyph({ w = 16, h = 20 }) {
  return <span className="pdf-glyph" style={{ width: w, height: h }}>PDF</span>;
}

// Opens the stored PDF. The storage buckets are private, so there is no
// durable URL to put in href — we mint a short-lived signed URL on click and
// open that. A row with no pdfKey (e.g. a JHA recorded before PDF rendering
// exists) renders as plain muted text rather than a link that goes nowhere.
export function PdfLink({ file, pdfKey, bucket = "reports", style }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!pdfKey) {
    return (
      <span
        title="No PDF stored for this record yet"
        style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: 0.55, ...style }}
      >
        <PdfGlyph />{file}
      </span>
    );
  }

  const open = async e => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const url = await Db.signedUrl(bucket, pdfKey);
      // Opened synchronously-ish after an await, so some browsers treat this
      // as a non-user gesture and block it — fall back to same-tab navigation.
      const win = window.open(url, "_blank", "noopener");
      if (!win) window.location.href = url;
    } catch (e2) {
      console.error("Couldn't open PDF:", e2);
      setErr("Couldn't open");
    }
    setBusy(false);
  };

  return (
    <a href="#" onClick={open} style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}>
      <PdfGlyph />{file}
      {busy && <span style={{ fontSize: 11, opacity: 0.6 }}>opening…</span>}
      {err && <span style={{ fontSize: 11, color: "var(--color-accent-700)" }}>{err}</span>}
    </a>
  );
}

// Modal: backdrop + Blueprint frame. The field grid (not the shell) scrolls
// so corner marks stay put — pass `maxWidth` and put your form in children.
let dialogSeq = 0;
export function Dialog({ title, maxWidth = 520, onClose, children, actions }) {
  const shell = useRef(null);
  const titleId = useRef("dlg-" + (++dialogSeq)).current;

  useEffect(() => {
    const opener = document.activeElement;
    // Keep the page behind from scrolling under the dialog.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the first field so the dialog is usable without a mouse, and keep
    // Tab inside it — otherwise focus walks off into the page underneath and
    // the keyboard user has no way back.
    const focusable = () => Array.from(shell.current
      ? shell.current.querySelectorAll('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')
      : []).filter(el => !el.disabled && el.offsetParent !== null);
    const first = focusable()[0];
    if (first) first.focus();

    const onKey = e => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && opener.focus) opener.focus();
    };
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <Blueprint className="dialog" ref={shell} role="dialog" aria-modal="true" aria-labelledby={titleId}
        style={{ width: `min(${maxWidth}px, 100%)`, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div className="dialog-title" id={titleId}>{title}</div>
        <div className="dialog-field-grid" style={{ maxHeight: "64vh", display: "flex", flexDirection: "column", gap: 12 }}>
          {children}
        </div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </Blueprint>
    </div>
  );
}

// role="alert" so the message is announced, not just drawn. Always rendered
// (hidden when empty) because a node that appears from nothing is announced
// less reliably than one that changes.
export function ErrorBox({ children }) {
  return <div className="error-box" role="alert" hidden={!children}>{children}</div>;
}

export function Switch({ on, onClick, label }) {
  return (
    <div className={`switch${on ? " on" : ""}`} onClick={onClick} role="switch" aria-checked={on}
      aria-label={label} tabIndex={0}
      // preventDefault on Space, or the page scrolls a screenful every time
      // someone toggles a switch from the keyboard.
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}>
      <div className="knob" />
    </div>
  );
}

// A short confirmation that something reached the database, for screens that
// save without a save button. It floats above the page and takes itself away
// — nothing here is worth a click to dismiss.
//
// aria-live="polite" rather than "assertive": a screen reader should mention
// it at the next natural pause, not interrupt what someone is typing.
// Waiting, visibly.
//
// Every screen used to render the bare word "Loading…", which is
// indistinguishable from a screen that has stopped responding — and on field
// data a read can genuinely take several seconds, so people were left
// guessing. This is a moving bar and the same words.
//
// Indeterminate on purpose: none of these reads know how many rows are
// coming, and a progress bar that invents a percentage is worse than one that
// admits it cannot say.
//
// role="status" so a screen reader announces the wait rather than sitting in
// silence; aria-live is polite so it does not interrupt whatever is being read.
export function Loading({ label = "Loading…", style }) {
  return (
    <div className="loading" role="status" aria-live="polite" style={style}>
      <div className="loading-bar" />
      <span>{label}</span>
    </div>
  );
}

// The same thing inside a table, where a bare <div> would break the row
// structure. Spans the full width so the bar is not squeezed into one column.
export function LoadingRow({ cols = 1, label = "Loading…" }) {
  return (
    <tr>
      <td colSpan={cols} style={{ padding: "14px 10px" }}>
        <Loading label={label} />
      </td>
    </tr>
  );
}

export function Toast({ message, tone = "ok", onDone, duration = 2600 }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, duration);
    // Re-armed per message, so a second save mid-fade resets the clock
    // instead of inheriting the tail of the first one's timer.
    return () => clearTimeout(t);
  }, [message, duration, onDone]);

  if (!message) return null;
  const bad = tone === "error";
  return (
    <div aria-live="polite" style={{
      position: "fixed", left: "50%", transform: "translateX(-50%)",
      // Clear of the iOS home indicator and any bottom bar on a phone.
      bottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
      zIndex: 60, pointerEvents: "none",
      display: "flex", alignItems: "center", gap: 8,
      padding: "10px 16px", borderRadius: 999,
      fontSize: 14, fontWeight: 600,
      fontFamily: "var(--font-heading)",
      color: bad ? "#fff" : "var(--color-text)",
      background: bad ? "var(--color-accent-700)" : "var(--color-surface, #fff)",
      border: `1px solid ${bad ? "transparent" : "var(--color-divider)"}`,
      boxShadow: "0 6px 24px rgba(0,0,0,.18)",
      animation: "toast-in .18s ease-out"
    }}>
      <span aria-hidden="true">{bad ? "!" : "✓"}</span>
      <span>{message}</span>
    </div>
  );
}

// The number box for anything that feeds a bill; its figures are floored at
// zero by nonNegative (see data.js). Zero stays typeable — it is a real value
// everywhere this is used ("not priced yet", "no hours today").
//
// The box keeps its own text while it is being edited, which is the fix for a
// field you could not overwrite. Bound straight to a number, clearing it put
// a 0 straight back, so typing 8 over a 0 gave you 80 — you had to select the
// contents first, on a phone, with gloves on. Now an emptied box stays empty
// on screen and reads as 0 to everything downstream, so the running total
// never shows NaN mid-edit, and blur settles it back to a plain number.
// A text input with a decimal keypad, not type="number" — the same lesson
// the dose dialog learned, now applied where the money is. On a phone,
// type="number" raises the full keyboard, and hands back "" for anything
// the browser considers half-typed or locale-wrong (a comma decimal, a
// stray key) — so a quantity that was visibly on screen reached the total
// as zero, with no error anywhere. Beta testing found ten of these on the
// billing ticket alone. The keystroke filter below replaces the old
// minus/e key blocking: nothing but digits and separators ever lands.
export function NumField({ value, onChange, step, style, ...rest }) {
  const [text, setText] = useState(() => String(value == null ? 0 : value));
  const [editing, setEditing] = useState(false);

  // Follow the value from outside only while it isn't being typed into —
  // otherwise the round trip through the parent overwrites a half-typed
  // figure on every keystroke.
  useEffect(() => {
    if (!editing) setText(String(value == null ? 0 : value));
  }, [value, editing]);

  const commit = raw => { setText(String(nonNegative(raw))); onChange(nonNegative(raw)); };

  return (
    <input className="input tabular" type="text" inputMode="decimal" value={text}
      style={style}
      // Selecting the contents on focus means one tap then type, rather than
      // clear-then-type, which is what people actually do with these.
      onFocus={e => { setEditing(true); e.target.select(); }}
      onBlur={e => { setEditing(false); commit(e.target.value); }}
      onChange={e => {
        const raw = e.target.value.replace(/[^\d.,]/g, "");
        setText(raw);
        // Floored on the way out, which also catches a pasted "-5".
        onChange(nonNegative(raw));
      }}
      {...rest} />
  );
}

// The job record keeps a contact as one display string ("T. Beaudry · (780)
// 555-0142 · t.beaudry@…"), so anything that needs to email them has to pull
// the address back out rather than mailing the whole label.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const emailIn = s => { const m = EMAIL_RE.exec(s || ""); return m ? m[0] : ""; };

// One place that turns a directory contact into the single display string the
// job record and tickets carry ("T. Beaudry · (780) 555-0142 · t.b@…"). The
// ticket keeps a string rather than a contact id on purpose: it is a record of
// who was named that day, and must not change when the directory does.
export const contactLabel = c => c ? [c.name, c.phone, c.email].filter(Boolean).join(" · ") : "";

// And the inverse, for editing one that was already stored as a string: the
// email is whichever part looks like an address, the phone is whichever of the
// rest carries digits, and anything left is the name.
export const splitContact = s => {
  const parts = String(s || "").split("·").map(p => p.trim()).filter(Boolean);
  const email = parts.find(p => EMAIL_RE.test(p)) || "";
  const phone = parts.find(p => p !== email && /\d/.test(p)) || "";
  return { name: parts.filter(p => p !== email && p !== phone).join(" · "), phone, email };
};

// Critical outranks High outranks the rest, and has to read that way at a
// glance on a phone in daylight.
export const hazardTagVariant = level =>
  level === "Critical" ? "solid" : level === "High" ? "accent" : "neutral";

// Shown wherever a screen needs an open job and hasn't got one. The JHA,
// upload and ticket screens all dereferenced `job.id` on their first line, so
// reaching any of them without a job selected blanked the whole app.
export function NoJobSelected({ what }) {
  return (
    <div className="page">
      <Blueprint style={{ padding: "22px 20px", maxWidth: 520 }}>
        <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>No job open</h4>
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Pick a job on Home first — {what} is always raised against one.
        </div>
      </Blueprint>
    </div>
  );
}

// Shown when a field screen couldn't reach the network and put the work in
// the offline queue instead — the reassurance that nothing was lost.
export function QueuedPanel({ what, onDone }) {
  return (
    <div className="page">
      <Blueprint style={{ padding: "22px 20px", maxWidth: 520 }}>
        <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>Saved on this device</h4>
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 16 }}>
          No signal right now, so {what} is queued here and will send automatically the moment you're back in range — even if you close the app and come back later.
        </div>
        <Btn variant="primary" onClick={onDone}>Done</Btn>
      </Blueprint>
    </div>
  );
}

// CSV rather than a print view: it opens in Excel, which is where these
// exports end up anyway. Quotes are doubled per RFC 4180 so a project name
// with a comma in it doesn't shift every column after it.
const csvCell = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

export function downloadCsv(filename, rows) {
  // The BOM is what makes Excel read this as UTF-8 — without it, accented
  // client and site names arrive mangled.
  const body = "\ufeff" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick — revoking immediately cancels the download in
  // Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// One screen throwing used to take the whole page to white, with the reason
// only in a console nobody has open in a truck. This keeps the app shell up
// and offers a way back.
export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Screen crashed:", error, info); }
  componentDidUpdate(prev) {
    // A new screen gets a clean slate, so one bad screen doesn't wedge the
    // rest of the app behind it.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <Blueprint style={{ padding: "22px 20px", maxWidth: 560 }}>
          <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>This screen hit a problem</h4>
          <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12 }}>
            Nothing you entered elsewhere has been lost. Switch tabs to carry on, or reload if it keeps happening.
          </div>
          <div className="tabular" style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 50%, transparent)", marginBottom: 12 }}>
            {String(this.state.error && this.state.error.message || this.state.error)}
          </div>
          <Btn variant="secondary" onClick={() => window.location.reload()}>Reload</Btn>
        </Blueprint>
      </div>
    );
  }
}

// Real connectivity and a real clock. `navigator.onLine` only tells you the
// device has *a* network, not that Supabase is reachable — so this claims no
// more than "offline" when the browser is certain, and stays quiet otherwise.
export function ConnectionBar({ label }) {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" || navigator.onLine !== false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(t);
    };
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", fontSize: 11, textTransform: "uppercase" }}>
      <span aria-hidden="true" style={{
        width: 7, height: 7, marginRight: 6, flex: "none",
        background: online ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 40%, transparent)"
      }} />
      {online ? (label || "Online") : "Offline — will send when back in range"}
      <span className="tabular" style={{ marginLeft: "auto" }}>
        {now.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}
      </span>
    </div>
  );
}

export function StatusTag({ status }) {
  // Two vocabularies, one tag: jobs are Active or Complete, tickets run Draft →
  // Awaiting approval → Approved → Invoiced.
  const map = {
    Active: { v: "accent" }, Complete: { v: "neutral" },
    Draft: { v: "neutral" }, "Awaiting approval": { v: "outline" },
    Approved: { v: "accent" }, Invoiced: { v: "neutral" }
  };
  const v = (map[status] || { v: "neutral" }).v;
  return <TagX variant={v}>{status}</TagX>;
}

