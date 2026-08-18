import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, ErrorBox, Loading } from "./common.jsx";

// Team chat — one room for the whole crew.
//
// Three feeds keep the room current, cheapest first: the realtime
// subscription carries messages as they land; a 30-second merge-refresh
// catches anything a silently dropped websocket missed, which on a lease
// with one bar of signal is a when, not an if; and regaining focus
// refreshes immediately, because that is the moment somebody is looking.
// Everything funnels through one id-keyed merge, so no path can double a
// message another path already delivered.
//
// Deliberately online-only (see Db.listChatMessages): a message that
// cannot send right now fails softly and stays in the composer, rather
// than joining the offline queue to be said hours out of turn.

const REFRESH_MS = 30000;

// Messages sorted as the room reads them: oldest first, ties on the id so
// the order is stable however they arrived.
const inOrder = (a, b) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

// Every path into the list goes through here. Known ids are kept (or have
// a late-arriving name filled in); new ones are added in order. Returning
// `prev` untouched when nothing changed keeps the timer's refresh from
// re-rendering a quiet room every 30 seconds.
function mergeIn(prev, incoming) {
  const by = new Map(prev.map(m => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const cur = by.get(m.id);
    if (!cur) { by.set(m.id, m); changed = true; }
    else if (!cur.name && m.name) { by.set(m.id, { ...cur, name: m.name }); changed = true; }
  }
  return changed ? [...by.values()].sort(inOrder) : prev;
}

export function TeamChatScreen({ currentUser }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const listRef = useRef(null);
  // Follow the conversation while the reader is at (or near) the bottom;
  // stop the moment they scroll up to read back, so an arriving message
  // cannot yank the history out from under them.
  const stickToBottom = useRef(true);
  // Set to the list's previous scrollHeight just before older messages are
  // prepended — the layout effect uses it to hold the reader's place.
  const restoreHeight = useRef(null);
  // Sender names for realtime arrivals, whose rows come without the join.
  const nameOf = useRef(new Map());

  useEffect(() => {
    let live = true;

    Db.listProfiles()
      .then(people => {
        if (!live) return;
        nameOf.current = new Map(people.map(p => [p.id, p.displayName]));
        // Anyone who arrived over realtime before the directory did.
        setMessages(prev => {
          const named = prev.map(m => m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" });
          return named.some((m, i) => m !== prev[i]) ? named : prev;
        });
      })
      .catch(() => {}); // names degrade to "Someone", the room still works

    const loadLatest = initial => Db.listChatMessages()
      .then(({ messages: page, hasMore: more }) => {
        if (!live) return;
        setMessages(prev => mergeIn(prev, page));
        if (initial) setHasMore(more);
        setLoadError("");
      })
      .catch(e => {
        if (!live) return;
        if (initial) setLoadError(e.message || "Couldn't load the chat.");
      })
      .finally(() => { if (live && initial) setLoading(false); });

    loadLatest(true);

    const unsubscribe = Db.subscribeChatMessages({
      onInsert: m => {
        if (!live) return;
        const named = m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" };
        setMessages(prev => mergeIn(prev, [named]));
        // A sender the directory doesn't know yet — an account created
        // since sign-in. Fetch the row with its join and patch the name.
        if (!named.name) {
          Db.getChatMessage(m.id)
            .then(full => { if (live && full && full.name) setMessages(prev => mergeIn(prev, [full])); })
            .catch(() => {});
        }
      },
      onDelete: id => { if (live) setMessages(prev => prev.filter(m => m.id !== id)); }
    });

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadLatest(false);
    }, REFRESH_MS);
    const onFocus = () => loadLatest(false);
    window.addEventListener("focus", onFocus);

    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // One scroll rule for every way the list changes: restore the reader's
  // place after a prepend, otherwise follow the bottom if they were there.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (restoreHeight.current != null) {
      el.scrollTop += el.scrollHeight - restoreHeight.current;
      restoreHeight.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const loadOlder = async () => {
    const el = listRef.current;
    if (loadingOlder || !messages.length || !el) return;
    setLoadingOlder(true);
    try {
      const { messages: older, hasMore: more } = await Db.listChatMessages(messages[0].createdAt);
      restoreHeight.current = el.scrollHeight;
      setMessages(prev => mergeIn(prev, older));
      setHasMore(more);
    } catch (e) {
      setSendError(e.message || "Couldn't load earlier messages.");
    }
    setLoadingOlder(false);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError("");
    try {
      const sent = await Db.sendChatMessage(currentUser.id, text);
      setDraft("");
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
    } catch (e) {
      // The draft stays in the composer — nothing was said, nothing is lost.
      setSendError(e.message || "Couldn't send that — check the connection and try again.");
    }
    setSending(false);
  };

  const remove = async id => {
    try {
      await Db.deleteChatMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (e) {
      setSendError(e.message || "Couldn't remove that message.");
    }
  };

  const isAdmin = currentUser.role === "Admin";
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <Blueprint style={{ display: "flex", flexDirection: "column", height: "min(72vh, 640px)", minHeight: 320 }}>
        <div ref={listRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
          {loading ? (
            <Loading label="Loading the chat…" />
          ) : loadError ? (
            <ErrorBox>{loadError}</ErrorBox>
          ) : (
            <>
              {hasMore && (
                <div style={{ textAlign: "center", marginBottom: 12 }}>
                  <Btn variant="secondary" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "Loading…" : "Show earlier messages"}
                  </Btn>
                </div>
              )}
              {messages.length === 0 && (
                <div style={{ color: muted, textAlign: "center", padding: "40px 0" }}>
                  Nothing here yet — say hello.
                </div>
              )}
              {messages.map((m, i) => {
                const mine = m.profileId === currentUser.id;
                const prev = messages[i - 1];
                // A name-and-time line starts each run of messages: a new
                // sender, or the same one back after half an hour away.
                const newRun = !prev || prev.profileId !== m.profileId ||
                  new Date(m.createdAt) - new Date(prev.createdAt) > 30 * 60000;
                return (
                  <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", marginTop: newRun ? 14 : 3 }}>
                    {newRun && (
                      <div style={{ fontSize: 11, color: muted, padding: "0 2px", marginBottom: 3 }}>
                        {mine ? "You" : (m.name || "Someone")} · {m.at}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexDirection: mine ? "row-reverse" : "row", maxWidth: "86%" }}>
                      <div style={{
                        padding: "8px 12px", fontSize: 14, lineHeight: 1.45,
                        whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                        background: mine
                          ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                          : "color-mix(in srgb, var(--color-text) 7%, transparent)",
                        border: "1px solid " + (mine
                          ? "color-mix(in srgb, var(--color-accent) 35%, transparent)"
                          : "var(--color-divider)")
                      }}>
                        {m.body}
                      </div>
                      {(mine || isAdmin) && (
                        <button
                          onClick={() => remove(m.id)}
                          aria-label="Remove this message"
                          title="Remove this message"
                          style={{ background: "transparent", border: "none", cursor: "pointer", color: muted, fontSize: 15, padding: 2, lineHeight: 1 }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-divider)", padding: 12 }}>
          {sendError && <div style={{ marginBottom: 8 }}><ErrorBox>{sendError}</ErrorBox></div>}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                // Enter sends; Shift+Enter makes a line break.
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Message the crew…"
              rows={2}
              maxLength={4000}
              className="input"
              style={{ flex: 1, resize: "none", minHeight: 46, lineHeight: 1.45 }}
            />
            <Btn variant="primary" onClick={send} disabled={sending || !draft.trim()}>
              {sending ? "Sending…" : "Send"}
            </Btn>
          </div>
        </div>
      </Blueprint>
    </div>
  );
}
