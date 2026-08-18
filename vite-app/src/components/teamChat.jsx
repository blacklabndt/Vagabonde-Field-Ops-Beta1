import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Dialog, ErrorBox, Loading, Switch } from "./common.jsx";

// Team chat — one room for the whole crew.
//
// Three feeds keep the room current, cheapest first: the realtime
// subscription carries messages (and pin changes) as they land; a
// 30-second merge-refresh catches anything a silently dropped websocket
// missed, which on a lease with one bar of signal is a when, not an if;
// and regaining focus refreshes immediately, because that is the moment
// somebody is looking. Everything funnels through one id-keyed merge, so
// no path can double a message another path already delivered.
//
// Admins can pin a message to a strip at the top of the room. A message
// can also carry a picture — photos and GIFs — which big phone cameras
// make worth shrinking before they cross a field connection.
//
// Deliberately online-only (see Db.listChatMessages): a message that
// cannot send right now fails softly and stays in the composer, rather
// than joining the offline queue to be said hours out of turn.

const REFRESH_MS = 30000;

// What the storage bucket accepts. Anything else the browser can still
// decode (a HEIC off an iPhone, a BMP) is transcoded to JPEG on the way.
const CHAT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_EDGE_PX = 1600;
const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;

// A phone photo is 10MB+ of pixels nobody needs at chat size. Shrink to
// 1600px JPEG before upload — except GIFs, whose animation a canvas
// would freeze, so they go up as they are (the bucket caps them at 8MB).
async function shrinkForChat(file) {
  if (file.type === "image/gif") return file;
  try {
    const bmp = await createImageBitmap(file);
    const oversized = bmp.width > MAX_EDGE_PX || bmp.height > MAX_EDGE_PX;
    if (!oversized && file.size <= KEEP_AS_IS_BYTES && CHAT_IMAGE_TYPES.has(file.type)) {
      bmp.close();
      return file;
    }
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return file;
    const stem = (file.name || "photo").replace(/\.[^.]*$/, "");
    return new File([blob], stem + ".jpg", { type: "image/jpeg" });
  } catch (_) {
    // A format this browser can't decode — send as-is and let the bucket
    // rules give the real answer.
    return file;
  }
}

// Messages sorted as the room reads them: oldest first, ties on the id so
// the order is stable however they arrived.
const inOrder = (a, b) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

// Every path into the list goes through here. New ids are added in order;
// known ids keep their name when the incoming copy lacks the join, and
// take the incoming pin state. Returning `prev` untouched when nothing
// changed keeps the timer's refresh from re-rendering a quiet room.
function mergeIn(prev, incoming) {
  const by = new Map(prev.map(m => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const cur = by.get(m.id);
    if (!cur) { by.set(m.id, m); changed = true; continue; }
    const merged = { ...m, name: m.name || cur.name };
    if (merged.name !== cur.name || merged.pinnedAt !== cur.pinnedAt) {
      by.set(m.id, merged);
      changed = true;
    }
  }
  return changed ? [...by.values()].sort(inOrder) : prev;
}

// The GIF search. Opens on what's trending, then searches as you type —
// straight against KLIPY from this browser, as their terms require; the
// Edge Function only hands over the app key (see Db.searchGifs). Tapping
// a GIF sends it on its own; whatever is typed in the composer stays
// there.
function GifPicker({ onPick, onClose, busy }) {
  const [term, setTerm] = useState("");
  const [gifs, setGifs] = useState([]);
  const [searching, setSearching] = useState(true);
  const [error, setError] = useState("");
  // A request token, so a slow earlier search cannot land after a newer one.
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      Db.searchGifs(term)
        .then(list => { if (mine === seq.current) { setGifs(list); setError(""); } })
        .catch(e => { if (mine === seq.current) { setGifs([]); setError(e.message || "Couldn't search for GIFs."); } })
        .finally(() => { if (mine === seq.current) setSearching(false); });
    }, term ? 350 : 0);
    return () => clearTimeout(timer);
  }, [term]);

  return (
    <Dialog title="Send a GIF" maxWidth={560} onClose={onClose}>
      <input
        className="input"
        value={term}
        onChange={e => setTerm(e.target.value)}
        placeholder="Search GIFs…"
        autoFocus
        style={{ marginBottom: 10 }}
      />
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : searching && gifs.length === 0 ? (
        <Loading label="Finding GIFs…" />
      ) : gifs.length === 0 ? (
        <div style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "16px 0" }}>
          Nothing for that — try another word.
        </div>
      ) : (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: 8, maxHeight: "50vh", overflowY: "auto", opacity: searching ? 0.6 : 1
        }}>
          {gifs.map(g => (
            <button
              key={g.id}
              onClick={() => onPick(g.full)}
              disabled={busy}
              aria-label="Send this GIF"
              style={{ padding: 0, border: "1px solid var(--color-divider)", background: "transparent", cursor: "pointer" }}
            >
              <img src={g.preview} alt="" loading="lazy"
                style={{ display: "block", width: "100%", height: 110, objectFit: "cover" }} />
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginTop: 8 }}>
        Powered by KLIPY
      </div>
    </Dialog>
  );
}

// A picture in a bubble. The bucket is private, so viewing means a signed
// URL — minted on mount for the inline copy; opening it big goes through
// onOpen, which mints its own fresh link (see openImage below).
function ChatImage({ imageKey, onSized, onOpen }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Db.signedUrl("chat-media", imageKey)
      .then(u => { if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [imageKey]);

  if (failed) {
    return <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "6px 0" }}>Couldn't load the picture.</div>;
  }
  if (!url) {
    return <div style={{ width: 200, height: 130, background: "color-mix(in srgb, var(--color-text) 6%, transparent)" }} />;
  }
  return (
    <img
      src={url} alt="Shared picture" loading="lazy"
      onLoad={onSized}
      onClick={onOpen}
      style={{ display: "block", maxWidth: "100%", maxHeight: 320, cursor: "zoom-in" }}
    />
  );
}

// The pinned strip's thumbnail. While the signed URL is on its way — or
// if it never arrives — the old "(picture)" label stands in, so the row
// always says what it holds.
function PinThumb({ pin, onOpen }) {
  const [url, setUrl] = useState(pin.gifUrl || "");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (pin.gifUrl) { setUrl(pin.gifUrl); return; }
    let live = true;
    Db.signedUrl("chat-media", pin.imageKey)
      .then(u => { if (live) setUrl(u); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [pin.imageKey, pin.gifUrl]);

  if (failed || !url) {
    return <span style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)", flex: "none" }}>{pin.gifUrl ? "(GIF)" : "(picture)"}</span>;
  }
  return (
    <img
      src={url} alt={pin.gifUrl ? "Pinned GIF" : "Pinned picture"} loading="lazy"
      onClick={onOpen}
      style={{ height: 34, width: 48, objectFit: "cover", border: "1px solid var(--color-divider)", cursor: "zoom-in", flex: "none" }}
    />
  );
}

// Any picture or GIF, the full screen. Tapping anywhere — or Escape —
// puts the room back.
function Lightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      role="dialog" aria-label="Picture, full screen"
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10, 11, 12, .9)", display: "grid", placeItems: "center", cursor: "zoom-out", padding: 14 }}
    >
      <img src={src} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      <button
        onClick={onClose}
        aria-label="Close the picture"
        style={{ position: "absolute", top: 10, right: 14, background: "transparent", border: "none", color: "#f2f2f3", fontSize: 30, lineHeight: 1, cursor: "pointer", padding: 6 }}
      >
        ×
      </button>
    </div>
  );
}

export function TeamChatScreen({ currentUser }) {
  const [messages, setMessages] = useState([]);
  const [pins, setPins] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [attach, setAttach] = useState(null);   // { file, url } awaiting send
  const [gifOpen, setGifOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  // Whether the realtime feed is actually delivering. False is not an
  // error state — the 30-second refresh still carries the room — but it
  // is said out loud below the composer instead of being invisible.
  const [feedLive, setFeedLive] = useState(false);
  // The full-screen viewer: the URL it shows, or null when closed.
  const [lightbox, setLightbox] = useState(null);
  // "unsupported" hides the switch; "blocked"/"off"/"on" render it.
  const [pushState, setPushState] = useState("unsupported");
  const [pushBusy, setPushBusy] = useState(false);

  const listRef = useRef(null);
  const fileRef = useRef(null);
  // Follow the conversation while the reader is at (or near) the bottom;
  // stop the moment they scroll up to read back, so an arriving message
  // cannot yank the history out from under them.
  const stickToBottom = useRef(true);
  // Set to the list's previous scrollHeight just before older messages are
  // prepended — the layout effect uses it to hold the reader's place.
  const restoreHeight = useRef(null);
  // Sender names for realtime arrivals, whose rows come without the join.
  const nameOf = useRef(new Map());
  // Rows that must mount without the entrance animation: everything the
  // initial load and the "Show earlier" pages bring in. A message not in
  // this set is one that arrived while you were watching — those rise in.
  const quietIds = useRef(new Set());

  const named = m => m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" };

  // Pin state changes arrive as updates; the strip mirrors them. The list
  // is rebuilt rather than patched — it is at most twenty rows.
  const applyPinChange = m => {
    setPins(prev => {
      const rest = prev.filter(p => p.id !== m.id);
      if (!m.pinnedAt) return rest.length === prev.length ? prev : rest;
      const was = prev.find(p => p.id === m.id);
      const withName = m.name || !was ? named(m) : { ...m, name: was.name };
      return [...rest, withName].sort((a, b) => (a.pinnedAt < b.pinnedAt ? 1 : -1));
    });
  };

  useEffect(() => {
    let live = true;

    Db.listProfiles()
      .then(people => {
        if (!live) return;
        nameOf.current = new Map(people.map(p => [p.id, p.displayName]));
        // Anyone who arrived over realtime before the directory did.
        setMessages(prev => {
          const filled = prev.map(m => m.name ? m : { ...m, name: nameOf.current.get(m.profileId) || "" });
          return filled.some((m, i) => m !== prev[i]) ? filled : prev;
        });
      })
      .catch(() => {}); // names degrade to "Someone", the room still works

    const loadLatest = initial => Promise.all([Db.listChatMessages(), Db.listPinnedChatMessages()])
      .then(([{ messages: page, hasMore: more }, pinned]) => {
        if (!live) return;
        // The room you walk into holds still; only what arrives after
        // you is animated.
        if (initial) page.forEach(m => quietIds.current.add(m.id));
        setMessages(prev => mergeIn(prev, page));
        setPins(pinned);
        if (initial) setHasMore(more);
        setLoadError("");
      })
      .catch(e => {
        if (!live) return;
        if (initial) setLoadError(e.message || "Couldn't load the chat.");
      })
      .finally(() => { if (live && initial) setLoading(false); });

    loadLatest(true);

    // The feed is rebuilt whenever its channel reports failure — the
    // socket reconnects itself after a network drop or a realtime
    // service restart, but a channel that errored stays errored, and a
    // dead channel is indistinguishable from a quiet room. Each rebuild
    // takes a sequence number so a late status report from a torn-down
    // channel cannot trigger a rebuild loop.
    let unsubscribe = null;
    let resubTimer = null;
    let feedSeq = 0;
    const startFeed = () => {
      const mine = ++feedSeq;
      unsubscribe = Db.subscribeChatMessages({
        onInsert: m => {
          if (!live) return;
          const withName = named(m);
          setMessages(prev => mergeIn(prev, [withName]));
          // A sender the directory doesn't know yet — an account created
          // since sign-in. Fetch the row with its join and patch the name.
          if (!withName.name) {
            Db.getChatMessage(m.id)
              .then(full => { if (live && full && full.name) setMessages(prev => mergeIn(prev, [full])); })
              .catch(() => {});
          }
        },
        onUpdate: m => {
          if (!live) return;
          setMessages(prev => mergeIn(prev, [named(m)]));
          applyPinChange(m);
        },
        onDelete: id => {
          if (!live) return;
          setMessages(prev => prev.filter(m => m.id !== id));
          setPins(prev => prev.some(p => p.id === id) ? prev.filter(p => p.id !== id) : prev);
        },
        onStatus: status => {
          if (!live || mine !== feedSeq) return;
          setFeedLive(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") {
            // Whatever was said while the feed was down arrived nowhere —
            // pull it now rather than waiting out the poll interval.
            loadLatest(false);
            return;
          }
          if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") && !resubTimer) {
            resubTimer = setTimeout(() => {
              resubTimer = null;
              if (!live) return;
              if (unsubscribe) unsubscribe();
              startFeed();
            }, 5000);
          }
        }
      });
    };
    startFeed();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadLatest(false);
    }, REFRESH_MS);
    const onFocus = () => loadLatest(false);
    // Phones coming back from sleep fire visibilitychange, not focus —
    // and that return is exactly when the socket is most likely dead.
    const onVisible = () => { if (document.visibilityState === "visible") loadLatest(false); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      if (resubTimer) clearTimeout(resubTimer);
      if (unsubscribe) unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The preview URL belongs to the browser until it's given back.
  useEffect(() => () => { if (attach) URL.revokeObjectURL(attach.url); }, [attach]);

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

  // Pictures finish loading after the scroll rule has run and push the
  // list taller — follow them down if the reader was at the bottom.
  const restick = () => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  };

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
      older.forEach(m => quietIds.current.add(m.id));
      restoreHeight.current = el.scrollHeight;
      setMessages(prev => mergeIn(prev, older));
      setHasMore(more);
    } catch (e) {
      setSendError(e.message || "Couldn't load earlier messages.");
    }
    setLoadingOlder(false);
  };

  const pickFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // so choosing the same photo again still fires
    if (!file) return;
    setSendError("");
    setAttach(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file) };
    });
  };

  const dropAttachment = () => {
    setAttach(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !attach) || sending) return;
    setSending(true);
    setSendError("");
    try {
      const imageFile = attach ? await shrinkForChat(attach.file) : null;
      const sent = await Db.sendChatMessage(currentUser.id, text, { imageFile });
      setDraft("");
      dropAttachment();
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
    } catch (e) {
      // The draft and the picture stay in the composer — nothing was
      // said, nothing is lost.
      setSendError(e.message || "Couldn't send that — check the connection and try again.");
    }
    setSending(false);
  };

  // A GIF goes on its own the moment it's tapped; whatever is typed in
  // the composer stays there for its own send.
  const sendGif = async gifUrl => {
    if (sending) return;
    setSending(true);
    setSendError("");
    try {
      const sent = await Db.sendChatMessage(currentUser.id, "", { gifUrl });
      setGifOpen(false);
      stickToBottom.current = true;
      setMessages(prev => mergeIn(prev, [sent]));
    } catch (e) {
      setGifOpen(false);
      setSendError(e.message || "Couldn't send that GIF — check the connection and try again.");
    }
    setSending(false);
  };

  const remove = async id => {
    try {
      await Db.deleteChatMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
      setPins(prev => prev.some(p => p.id === id) ? prev.filter(p => p.id !== id) : prev);
    } catch (e) {
      setSendError(e.message || "Couldn't remove that message.");
    }
  };

  // Once, on arrival: where this device stands on notifications.
  useEffect(() => {
    let live = true;
    Db.getChatPushState()
      .then(s => { if (live) setPushState(s); })
      .catch(() => { if (live) setPushState("off"); });
    return () => { live = false; };
  }, []);

  // Enable-only: the switch hides itself once this device is subscribed
  // (turning notifications off again is the phone's own settings).
  const enablePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setSendError("");
    try {
      await Db.enableChatPush();
      setPushState("on");
    } catch (e) {
      setSendError(e.message || "Couldn't turn notifications on.");
      // Permission may have just been denied for good — re-read reality.
      Db.getChatPushState().then(setPushState).catch(() => {});
    }
    setPushBusy(false);
  };

  // Full screen for any message's picture or GIF. A stored picture gets
  // a fresh signed URL at tap time — the one its thumbnail was minted
  // with may be minutes old, and an expired link at full screen is a
  // broken image, not a picture.
  const openImage = async m => {
    try {
      const src = m.gifUrl || await Db.signedUrl("chat-media", m.imageKey);
      setLightbox(src);
    } catch (e) {
      setSendError(e.message || "Couldn't open the picture.");
    }
  };

  const togglePin = async m => {
    try {
      if (m.pinnedAt) await Db.unpinChatMessage(m.id);
      else await Db.pinChatMessage(m.id, currentUser.id);
      const flipped = { ...m, pinnedAt: m.pinnedAt ? null : new Date().toISOString() };
      setMessages(prev => mergeIn(prev, [flipped]));
      applyPinChange(flipped);
    } catch (e) {
      setSendError(e.message || "Couldn't change that pin.");
    }
  };

  const isAdmin = currentUser.role === "Admin";
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";
  const tinyBtn = { background: "transparent", border: "none", cursor: "pointer", color: muted, padding: 2, lineHeight: 1 };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <Blueprint className="chat-card">
        {pins.length > 0 && (
          <div style={{
            borderBottom: "1px solid var(--color-divider)", padding: "10px 16px",
            maxHeight: 150, overflowY: "auto", flex: "none",
            background: "color-mix(in srgb, var(--color-accent) 5%, transparent)"
          }}>
            <div className="kicker" style={{ marginBottom: 6 }}>Pinned</div>
            {pins.map(p => (
              <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 4 }}>
                <span style={{ color: muted, flex: "none" }}>{p.name || "Someone"}:</span>
                {(p.imageKey || p.gifUrl) && <PinThumb pin={p} onOpen={() => openImage(p)} />}
                <span
                  title={p.body}
                  style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {p.body}
                </span>
                {isAdmin && (
                  <button onClick={() => togglePin(p)} aria-label="Take this pin down" title="Take this pin down"
                    style={{ ...tinyBtn, fontSize: 15, flex: "none" }}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

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
                  <div key={m.id}
                    className={quietIds.current.has(m.id) ? undefined : "chat-msg-in"}
                    style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", marginTop: newRun ? 14 : 3 }}>
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
                        {m.gifUrl && (
                          // Straight off KLIPY's CDN — the constraint on the
                          // column is what keeps this an image host, not a
                          // tracking pixel.
                          <img src={m.gifUrl} alt="GIF" loading="lazy" onLoad={restick}
                            onClick={() => openImage(m)}
                            style={{ display: "block", maxWidth: "100%", maxHeight: 320, cursor: "zoom-in" }} />
                        )}
                        {m.imageKey && <ChatImage imageKey={m.imageKey} onSized={restick} onOpen={() => openImage(m)} />}
                        {m.body && <div style={m.imageKey || m.gifUrl ? { marginTop: 6 } : null}>{m.body}</div>}
                      </div>
                      {(mine || isAdmin) && (
                        <span style={{ display: "flex", gap: 2, flexDirection: mine ? "row-reverse" : "row", flex: "none" }}>
                          {isAdmin && (
                            <button onClick={() => togglePin(m)}
                              aria-label={m.pinnedAt ? "Unpin this message" : "Pin this message"}
                              title={m.pinnedAt ? "Unpin this message" : "Pin this message"}
                              style={{ ...tinyBtn, fontSize: 11, fontWeight: 600 }}>
                              {m.pinnedAt ? "Unpin" : "Pin"}
                            </button>
                          )}
                          <button onClick={() => remove(m.id)} aria-label="Remove this message" title="Remove this message"
                            style={{ ...tinyBtn, fontSize: 15 }}>
                            ×
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-divider)", padding: 12, flex: "none" }}>
          {sendError && <div style={{ marginBottom: 8 }}><ErrorBox>{sendError}</ErrorBox></div>}
          {attach && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <img src={attach.url} alt="Ready to send" style={{ height: 56, maxWidth: 120, objectFit: "cover", border: "1px solid var(--color-divider)" }} />
              <span style={{ fontSize: 12, color: muted, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {attach.file.name}
              </span>
              <button onClick={dropAttachment} aria-label="Remove the picture" title="Remove the picture" style={{ ...tinyBtn, fontSize: 15 }}>×</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <input ref={fileRef} type="file" accept="image/*" onChange={pickFile} style={{ display: "none" }} />
            <Btn variant="secondary" onClick={() => fileRef.current && fileRef.current.click()} disabled={sending} title="Attach a picture">
              Photo
            </Btn>
            <Btn variant="secondary" onClick={() => setGifOpen(true)} disabled={sending} title="Search and send a GIF">
              GIF
            </Btn>
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
            <Btn variant="primary" onClick={send} disabled={sending || (!draft.trim() && !attach)}>
              {sending ? "Sending…" : "Send"}
            </Btn>
          </div>
          {/* Said here because history quietly ending mid-scroll would
              otherwise read as a bug, not a policy — and likewise a live
              feed that is down reconnecting should say so, not just go
              quiet. One line, never wrapping: the text swapping was
              re-wrapping this line on phones, and the whole message pane
              pumped up and down with it. Truncation beats jitter. */}
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)", marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {loading || feedLive
              ? "Messages clear after 30 days — pinned messages stay."
              : "Live updates connecting — the room refreshes every 30 seconds meanwhile."}
          </div>
        </div>
      </Blueprint>
      {/* Below the room rather than in it: settings are not conversation.
          Shown only while there is something to do — a device that can't
          push (an iPhone not installed to the home screen) never sees it,
          and a device already subscribed is done with it. Turning
          notifications back off is the phone's own settings; a blocked
          permission invalidates the subscription, and the sender prunes
          it on the next push. */}
      {pushState !== "unsupported" && pushState !== "on" && (
        <div style={{ marginTop: 14, opacity: pushBusy ? 0.6 : 1 }}>
          <Switch on={false} onClick={enablePush} label="Notify me about new messages" />
          <div style={{ fontSize: 12, color: muted, marginTop: 4, maxWidth: 520 }}>
            Sends a notification to this device when someone posts in the team chat — even with the
            app closed. The switch is per device: turn it on on every phone or tablet that should buzz.
          </div>
        </div>
      )}
      {gifOpen && <GifPicker onPick={sendGif} onClose={() => setGifOpen(false)} busy={sending} />}
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
