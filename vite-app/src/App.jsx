import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import { sbClient } from "./config.js";
import { TABS, CONTEXT_TABS, EMPTY_JOB_RECORD, Store } from "./data.js";
import { Db } from "./db.js";
import { tabList, Blueprint, Btn, ErrorBox, ErrorBoundary, TagX, Toast, Loading } from "./components/common.jsx";
import { Toasts } from "./toastBus.js";
import { QueueBadge, QueueDialog } from "./components/queuePanel.jsx";
import { OfflineQueue } from "./offlineQueue.js";
import { OfflineCache } from "./offlineCache.js";
import { restoreSession, IDENTITY_KEY } from "./session.js";
import { SignInScreen } from "./components/auth.jsx";
import { HomeScreen } from "./components/home.jsx";
import { JobDetailScreen } from "./components/jobDetail.jsx";
import { JhaBuilderScreen } from "./components/jhaMobile.jsx";
import { UploadMobileScreen } from "./components/uploadMobile.jsx";
import { TicketMobileScreen } from "./components/ticketMobile.jsx";
import { OpenTicketsScreen } from "./components/openTickets.jsx";

// The core field flow (Home, Job detail, JHA/upload/ticket) loads eagerly —
// it's what every session opens with. The office-facing screens below are
// visited far less often per session, so they're split into their own
// chunks: a technician who never opens Rate admin or Users & access no
// longer downloads that code on first load, which matters most on a phone
// on field data.
const FilesScreen = lazy(() => import("./components/files.jsx").then(m => ({ default: m.FilesScreen })));
const ContactsScreen = lazy(() => import("./components/contacts.jsx").then(m => ({ default: m.ContactsScreen })));
const EquipmentScreen = lazy(() => import("./components/equipment.jsx").then(m => ({ default: m.EquipmentScreen })));
const RateAdminScreen = lazy(() => import("./components/rateAdmin.jsx").then(m => ({ default: m.RateAdminScreen })));
const BillingTrackerScreen = lazy(() => import("./components/billingTracker.jsx").then(m => ({ default: m.BillingTrackerScreen })));
const TimesheetsScreen = lazy(() => import("./components/timesheets.jsx").then(m => ({ default: m.TimesheetsScreen })));
const UsersAccessScreen = lazy(() => import("./components/usersAccess.jsx").then(m => ({ default: m.UsersAccessScreen })));
const TeamChatScreen = lazy(() => import("./components/teamChat.jsx").then(m => ({ default: m.TeamChatScreen })));
// Not screens. Each its own chunk so a technician on field data never
// downloads a game they have not gone looking for — the first lives behind
// the drawer-footer name, the second behind the top-bar one.
const Flappy880 = lazy(() => import("./components/flappy880.jsx").then(m => ({ default: m.Flappy880 })));

const ScreenFallback = () => (
  <div className="page"><Loading /></div>
);

// The egg renders outside the screen ErrorBoundary, so a crash inside it —
// or its chunk failing to load — would unmount the whole shell to a white
// screen. The screen boundary's full-page fallback is wrong here too: with
// the backdrop gone there is nothing to click to dismiss it. A game earns
// the same treatment its scoreboard gets — log it, close it, carry on.
class EggBoundary extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(error) {
    console.error("Easter egg crashed:", error);
    this.props.onBroken();
  }
  render() { return this.state.broken ? null : this.props.children; }
}

export function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  // A push notification's click lands on /?goto=chat — honoured here so
  // tapping "Kyle — Team chat" opens the room, not the board.
  const [screen, setScreen] = useState(() =>
    new URLSearchParams(window.location.search).get("goto") === "chat" ? "chat" : "board"
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(() => Store.load("theme", "light"));

  // The drawer is the only navigation now, at every width, so there is no
  // breakpoint at which an open menu becomes stray buttons — but Escape should
  // still close it, the same as a dialog.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = e => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Wired to Supabase (see db.js):
  const [clients, setClients] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [myTickets, setMyTickets] = useState([]);
  const [myTicketsLoading, setMyTicketsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Sourced from the open job (see Db.getJobRecord) — Job detail fills this in
  // as soon as a job is opened.
  const [jobRecord, setJobRecord] = useState(EMPTY_JOB_RECORD);
  // The draft being edited on the billing screen, when it was opened from a
  // job rather than from the menu.
  const [activeTicket, setActiveTicket] = useState(null);
  // A screen reached from a button inside another screen, which stays reachable
  // even when it isn't one of the sections in this account's menu.
  const [contextScreen, setContextScreen] = useState("");
  const [queued, setQueued] = useState([]);
  const [showQueue, setShowQueue] = useState(false);
  const [egg, setEgg] = useState(false);
  // Every save in the app arrives here, from db.js by way of the toast bus.
  const [toast, setToast] = useState(null);
  useEffect(() => Toasts.subscribe(setToast), []);

  // Replays anything saved locally while offline, the moment the browser is
  // back — and once on load, in case items were queued in a previous session
  // that ended before the signal came back. Held in a memo rather than inlined
  // so "Try again now" in the queue panel replays through the same handlers.
  const queueHandlers = useMemo(() => ({
    // Jobs replay before anything raised against them: the queue is walked in
    // the order things were saved, and a job is always saved before the JHA
    // or ticket that names it.
    job: payload => Db.createJob(payload),
    jha: payload => Db.createJha(payload),
    // The two multi-step handlers checkpoint after the write that creates a
    // row, because everything after that point can be safely repeated and
    // that first step cannot. Signal dropping between step one and step two
    // is ordinary out there, and without the checkpoint the retry starts
    // from the top and files the work a second time.
    report: async (payload, checkpoint) => {
      let reportId = payload.reportId;
      if (!reportId) {
        const report = await Db.uploadReport({
          jobDbId: payload.jobDbId, jobNumber: payload.jobNumber, file: payload.file,
          welds: payload.welds, result: "Accept", interpretedBy: payload.interpretedBy,
          send: false, sendTo: payload.recipient
        });
        reportId = report.id;
        await checkpoint({ reportId });
      }
      if (payload.recipient) {
        try { await Db.sendReportEmail({ reportId, to: payload.recipient, cc: "", message: "" }); }
        catch (e) { console.warn("Queued report synced, but its email didn't send:", e.message); }
      }
    },
    ticket: async (payload, checkpoint) => {
      // A ticket that never reached the database gets its number now, on the
      // way in — not when it was built in the field hours ago.
      let id = payload.ticketId;
      if (!payload.alreadyCreated) {
        const saved = await Db.createTicket({
          initials: payload.initials, jobDbId: payload.jobDbId, technicianId: payload.technicianId,
          workDate: payload.workDate, clientContact: payload.clientContact, contractorContact: payload.contractorContact,
          lines: payload.lines, status: payload.status, delays: payload.delays
        });
        id = saved.id;
        // The row and its number exist now. Anything that fails below this
        // line must resume against *this* ticket, not mint another one.
        await checkpoint({ alreadyCreated: true, ticketId: id });
      } else {
        await Db.updateTicket({ ticketId: id, lines: payload.lines, status: payload.status, delays: payload.delays });
      }
      // Crew is a delete-then-insert, so replaying it is harmless.
      await Db.saveCrewForTicket(id, payload.crew);
      if (payload.sendForApproval) await Db.sendTicketApproval({ ticketId: id, to: payload.approvalTo });
    }
  }), []);

  useEffect(() => OfflineQueue.attachAutoFlush(queueHandlers), [queueHandlers]);
  useEffect(() => OfflineQueue.subscribe(setQueued), []);
  const [cacheState, setCacheState] = useState({ servingCached: false, at: null });
  useEffect(() => OfflineCache.subscribe(setCacheState), []);
  const retryQueue = () => OfflineQueue.flush(queueHandlers);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    Store.save("theme", theme);
  }, [theme]);

  // Hiding a section is not locking a door: if the screen someone is on stops
  // being one of theirs, move them to the first section they do have rather
  // than parking them on a "not available" panel.
  useEffect(() => {
    if (!currentUser) return;
    const tabs = tabList(currentUser.tabs);
    if (tabs.length && !tabs.includes(screen) && screen !== contextScreen) setScreen(tabs[0]);
  }, [currentUser, screen, contextScreen]);

  // True when this session was restored from what the device remembered
  // rather than from a live token — see the recheck below.
  const restoredOffline = useRef(false);

  // Coming back into range. Usually supabase-js refreshes the token and
  // everything carries on. If it can't, the account really is signed out, and
  // saying so beats leaving someone looking signed in while every save fails.
  // Nothing queued is lost by this: the queue is separate from the identity
  // and survives until it syncs.
  useEffect(() => {
    const recheck = async () => {
      if (!restoredOffline.current) return;
      const { data } = await sbClient.auth.getSession().catch(() => ({ data: { session: null } }));
      restoredOffline.current = false;
      if (data && data.session) { OfflineCache.markLive(); return; }
      console.warn("Back online, but the session had lapsed — signing in again is needed.");
      setCurrentUser(null);
    };
    window.addEventListener("online", recheck);
    return () => window.removeEventListener("online", recheck);
  }, []);

  // Restore an existing session on load. Bounded at every step and tolerant of
  // having no network — see session.js for why each of those matters.
  useEffect(() => {
    (async () => {
      try {
        const { user, offline, reason } = await restoreSession({
          getSession: () => sbClient.auth.getSession(),
          fetchProfile: id => sbClient.from("profiles").select("*").eq("id", id).single(),
          signOut: () => sbClient.auth.signOut(),
          readIdentity: () => OfflineCache.read(IDENTITY_KEY).then(hit => (hit ? hit.value : null)),
          writeIdentity: identity => OfflineCache.put(IDENTITY_KEY, identity),
          isNetworkError: OfflineQueue.isNetworkError
        });
        if (offline) {
          console.warn("Starting without a connection (" + reason + ")" + (user ? " — signed in from this device's last session." : "."));
          if (user) {
            OfflineCache.noteServingCached(Date.now());
            restoredOffline.current = true;
          }
        }
        if (user) {
          setCurrentUser(user);
          setScreen(user.tabs[0]);
        }
      } catch (e) {
        console.error("Couldn't restore the session:", e.message);
      }
      setCheckingSession(false);
    })();
  }, []);

  const loadReferenceData = async () => {
    setLoadError("");
    try {
      const [clientList, contractorList, contactList] = await Promise.all([
        Db.listClients(), Db.listContractors(), Db.listContacts()
      ]);
      setClients(clientList);
      setContractors(contractorList);
      setContacts(contactList);
    } catch (e) {
      console.error("Failed to load reference data:", e.message);
      setLoadError(e.message || "Couldn't reach the database. Check your connection and reload.");
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    loadReferenceData();
    Db.getMostRecentJob().then(j => { if (j) setActiveJob(j); }).catch(e => console.error("Couldn't load the most recent job:", e.message));
    // Warmed on sign-in so the JHA builder still opens with this person's
    // usual hazard ratings when they're out of range.
    Db.lastHazardRatings(currentUser.id).catch(() => {});
  }, [currentUser]);

  const loadMyTickets = async () => {
    setMyTicketsLoading(true);
    try { setMyTickets(await Db.listMyTickets(currentUser.id)); }
    catch (e) { console.error("Failed to load your tickets:", e.message); }
    setMyTicketsLoading(false);
  };
  // Once on sign-in, because the drawer badge needs a count before the screen
  // has been opened…
  useEffect(() => { if (currentUser) loadMyTickets(); }, [currentUser]);
  // …and again on arriving at the screen. Keyed on `screen` alone: keyed on
  // both, signing in ran this a second time for the same list.
  useEffect(() => { if (currentUser && screen === "mytickets") loadMyTickets(); }, [screen]);
  const openMyTicketsCount = myTickets.filter(t => t.status !== "Invoiced").length;

  if (checkingSession) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <Loading label="Signing you in…" style={{ width: "min(280px, 80vw)" }} />
      </div>
    );
  }
  if (!currentUser) {
    return <SignInScreen onSignIn={u => { setCurrentUser(u); setScreen(tabList(u.tabs).filter(t => !CONTEXT_TABS.includes(t))[0] || "board"); }} />;
  }

  const myTabs = tabList(currentUser.tabs);
  // The drawer never lists the contextual screens, whatever the account may
  // access — see CONTEXT_TABS. They are reached from a job, deliberately.
  const allowedTabs = TABS.filter(t => myTabs.includes(t.key) && !CONTEXT_TABS.includes(t.key));
  const goto = key => { if (myTabs.includes(key)) { if (key === "ticket") setActiveTicket(null); setContextScreen(""); setScreen(key); setMenuOpen(false); } };
  // Reached from a button inside another screen (a job card, "Start JHA",
  // "New ticket") rather than the tab menu — always allowed, even when the
  // account's admin has hidden that tab from the menu. Hiding a tab only
  // hides the shortcut; it was never meant to block the work itself.
  const gotoContext = key => { setContextScreen(key); setScreen(key); setMenuOpen(false); };
  // Signing out drops what this device remembered. These are shared tablets:
  // the next person to pick one up should not be able to page through the
  // last crew's jobs and rates without signing in.
  const signOut = async () => {
    await sbClient.auth.signOut();
    // Signing out always completes — nobody gets trapped in a session because
    // a cache would not empty. But a wipe that failed is not a wipe, and the
    // person holding the tablet is the only one who can act on it, so it is
    // said out loud rather than swallowed.
    try {
      await OfflineCache.clear();
    } catch (e) {
      Toasts.show(e.message || "Couldn't clear this device's cached data.", "error");
      console.error("Sign-out could not clear the offline cache:", e);
    }
    setCurrentUser(null);
  };

  // Opening a specific ticket from a job. Deliberately not gated on the tab:
  // the button on the job is the way tickets are meant to be reached, whether
  // or not the billing section is in this person's menu.
  const openTicketDraft = ticketId => {
    setActiveTicket(ticketId);
    setContextScreen("ticket");
    setScreen("ticket");
    setMenuOpen(false);
  };

  const openJob = job => { setActiveJob(job); gotoContext("job"); };

  // Straight from the board to a blank ticket for a chosen job.
  //
  // The job record is loaded here rather than left to the billing screen for
  // the same reason openTicket does it: going directly to a ticket skips the
  // job screen, which is what normally loads the record — and a stale one
  // would put the previous job's client rep on this ticket.
  const startTicketForJob = async job => {
    if (!job) return;
    setActiveJob(job);
    try { setJobRecord(await Db.getJobRecord(job)); }
    catch (e) { console.error("Couldn't load the job record for the new ticket:", e.message); }
    setActiveTicket(null);
    setContextScreen("ticket");
    setScreen("ticket");
    setMenuOpen(false);
  };
  // From the billing tracker: a draft opens in the billing screen to be
  // finished, anything already sent opens its job (there is nothing left to
  // edit on it). The job record is loaded here rather than left to the job
  // screen, because going straight to the ticket skips it — and a stale record
  // would show the previous job's rep on this ticket.
  const openTicket = async t => {
    let job = activeJob;
    try { job = await Db.getJobByNumber(t.job); } catch (e) { console.error("Couldn't load that ticket's job:", e.message); }
    setActiveJob(job);
    if (t.status === "Draft" && job) {
      try { setJobRecord(await Db.getJobRecord(job)); }
      catch (e) { console.error("Couldn't load the job record for that ticket:", e.message); }
      openTicketDraft(t.id);
      return;
    }
    gotoContext("job");
  };
  const createJob = async ({ id, job }) => {
    // A job started with no signal comes back already shaped — there is
    // nothing to fetch, and fetching is exactly what didn't work.
    if (job) { setActiveJob(job); return; }
    try {
      const created = await Db.getJobByNumber(id);
      setActiveJob(created);
      Db.listContractors().then(setContractors).catch(() => {});
    } catch (e) {
      console.error("Couldn't load the new job:", e.message);
    }
  };

  let body;
  switch (screen) {
    case "board":
      body = (
        <HomeScreen
          onCreateJob={createJob} onOpenJob={openJob} onStartTicket={startTicketForJob}
          currentUser={currentUser} clients={clients} contractors={contractors} contacts={contacts}
        />
      );
      break;
    case "job":
      body = activeJob ? (
        <JobDetailScreen
          job={activeJob} currentUser={currentUser}
          onStartJha={() => gotoContext("jha")}
          onOpenTicket={openTicketDraft}
          // The screen you are standing on has just been deleted. Move to the
          // job its contents went to if there was one — that is where the work
          // now lives — otherwise back to the board.
          onJobDeleted={movedTo => {
            setJobRecord(EMPTY_JOB_RECORD);
            setActiveTicket(null);
            if (movedTo) { setActiveJob(movedTo); gotoContext("job"); }
            else { setActiveJob(null); setContextScreen(""); setScreen("board"); }
          }}
          jobRecord={jobRecord} setJobRecord={setJobRecord}
          onJobChanged={async () => {
            // Patch this one job's row in place instead of refetching every
            // job, client, contractor and contact to get it. If that read
            // fails the job on screen simply stays as it was — the previous
            // fallback here called loadReferenceData(), which returns nothing
            // and loads no jobs, so it threw inside the error path.
            try {
              setActiveJob(await Db.getJob(activeJob.dbId));
            } catch (e) {
              console.error("Couldn't refresh this job:", e.message);
            }
          }}
        />
      ) : <div className="page">No job selected — pick one from Home.</div>;
      break;
    case "jha":
      body = <JhaBuilderScreen job={activeJob} jobRecord={jobRecord} contacts={contacts} currentUser={currentUser} onSubmitted={() => gotoContext("job")} onCancel={() => gotoContext("job")} />;
      break;
    case "upload":
      body = <UploadMobileScreen job={activeJob} jobRecord={jobRecord} currentUser={currentUser} onSent={() => gotoContext("job")} />;
      break;
    case "ticket":
      body = <TicketMobileScreen key={activeTicket || "new"} job={activeJob} jobRecord={jobRecord} currentUser={currentUser} ticket={activeTicket} onSaved={() => gotoContext("job")} />;
      break;
    case "files":
      body = <FilesScreen />;
      break;
    case "contacts":
      body = <ContactsScreen currentUser={currentUser} />;
      break;
    case "equipment":
      body = <EquipmentScreen currentUser={currentUser} />;
      break;
    case "rates":
      body = <RateAdminScreen />;
      break;
    case "tracker":
      body = <BillingTrackerScreen onOpenTicket={openTicket} />;
      break;
    case "mytickets":
      body = <OpenTicketsScreen tickets={myTickets} loading={myTicketsLoading} onOpenTicket={openTicket} currentUser={currentUser} />;
      break;
    case "timesheets":
      body = <TimesheetsScreen currentUser={currentUser} />;
      break;
    case "users":
      body = <UsersAccessScreen currentUser={currentUser} />;
      break;
    case "chat":
      body = <TeamChatScreen currentUser={currentUser} />;
      break;
    default:
      body = (
        <div className="page">
          <Blueprint style={{ padding: "22px 20px", maxWidth: 480 }}>
            <h4 style={{ margin: "0 0 6px", fontSize: 19 }}>Not one of your sections</h4>
            <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
              This one isn't in your menu. Open the menu beside the wordmark to pick another, or ask an admin to add it.
            </div>
          </Blueprint>
        </div>
      );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <header className="topbar">
        <button className="nav-toggle" aria-label="Sections" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)}>
          <span /><span /><span />
        </button>
        <button
          type="button"
          className="topbar-brand"
          aria-label="VagaboNDE — go to home"
          title="VagaboNDE"
          onClick={() => goto("board")}
          style={{ appearance: "none", border: "none", padding: 0, cursor: "pointer" }}
        />
        {/* The current section, named in the bar — with the tabs gone there is
            otherwise nothing telling you where you are. */}
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--color-accent)" }}>
          {(TABS.find(t => t.key === screen) || {}).label || ""}
        </span>
        {cacheState.servingCached && (
          <TagX variant="outline" title={`No connection. Showing what this device saved at ${new Date(cacheState.at).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}.`}>
            Offline
          </TagX>
        )}
        <QueueBadge items={queued} onOpen={() => setShowQueue(true)} />
        {/* Just who is signed in. Signing out lives in the drawer, which is
            the only place it exists on a phone anyway — `.topbar-who` is
            hidden at that width — so having it in both was a second button
            for the same job on exactly one screen size. */}
        <div className="topbar-who" style={{ fontSize: 13, display: "flex", alignItems: "center", marginLeft: "auto" }}>
          <span>{currentUser.name}</span>
        </div>
      </header>

      {/* The drawer, phone only. Rendered outside the bar so it can cover the
          screen, and only when open so its buttons are not in the tab order
          on a desktop where it is invisible. */}
      {menuOpen && (
        <div className="drawer-backdrop" onClick={() => setMenuOpen(false)}>
          <nav className="drawer" aria-label="Sections" onClick={e => e.stopPropagation()}>
            <div className="topbar-brand" aria-hidden="true" style={{ margin: "18px auto 8px" }} />
            {allowedTabs.map(t => (
              <button key={t.key} className={screen === t.key ? "active" : ""}
                aria-current={screen === t.key ? "page" : undefined}
                onClick={() => goto(t.key)}>
                {t.label}
                {t.key === "mytickets" && openMyTicketsCount > 0 && (
                  <TagX variant="accent" style={{ marginLeft: 8 }}>{openMyTicketsCount}</TagX>
                )}
              </button>
            ))}
            <div className="drawer-foot">
              {/* Double-click your own name. Nothing announces it and nothing
                  depends on it; a double-click on a label is not something
                  anyone does by accident on the way to signing out. */}
              <span onDoubleClick={() => setEgg(true)} style={{ userSelect: "none" }}>
                {currentUser.name}
              </span>
              <Btn variant="secondary" onClick={signOut}>Sign out</Btn>
            </div>
            {/* The bar drops the theme switch on the narrowest phones, so the
                drawer carries it — otherwise it becomes unreachable. */}
            <div className="drawer-foot">
              <div className="seg-theme" role="group" aria-label="Colour theme" style={{ display: "flex" }}>
                <button className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button>
                <button className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button>
              </div>
            </div>
          </nav>
        </div>
      )}
      {egg && (
        <EggBoundary onBroken={() => setEgg(false)}>
          <Suspense fallback={null}>
            <Flappy880 onClose={() => setEgg(false)} me={currentUser} />
          </Suspense>
        </EggBoundary>
      )}

      {loadError && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <ErrorBox>{loadError}</ErrorBox>
        </div>
      )}
      {showQueue && (
        <QueueDialog items={queued} onRetry={retryQueue} onClose={() => setShowQueue(false)} />
      )}
      <main>
        {/* Keyed on the screen so switching tabs clears a crash rather than
            leaving the app stuck on the boundary's fallback. */}
        <ErrorBoundary resetKey={screen}>
          <Suspense fallback={<ScreenFallback />}>{body}</Suspense>
        </ErrorBoundary>
      </main>
      {/* The app's only save confirmation. It lives here rather than on each
          screen so every write is announced the same way and in the same
          place — and outside the ErrorBoundary and Suspense, so it survives a
          screen swap and isn't torn down mid-fade by a lazy chunk loading. */}
      <Toast message={toast && toast.text} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
