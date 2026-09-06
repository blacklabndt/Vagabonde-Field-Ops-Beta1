// What each screen is for, in the words you would use to a new hire.
//
// The three markdown files that explain this app live in the repository,
// where nobody in the field or the office will ever read them. This is the
// same knowledge where the question actually gets asked: behind the "?" in
// the top bar, on the screen it is about.
//
// Pure data on purpose — no imports, no JSX, nothing to render. That keeps
// it testable next door (help.test.mjs checks every screen in TABS has an
// entry) and keeps the wording in one file rather than sprinkled through
// fifteen components.
//
// House style is the Admin screen's inline notes: short honest paragraphs,
// plain English, what the screen is for, what the buttons do, and the one
// or two rules that surprise people. Where a rule depends on the account's
// role, say so — "Admins and Technicians see prices" is the answer to a
// question people otherwise ask as "why is my screen broken".

// Keyed by the screen key in TABS. Each entry: the screen's own name, and
// the paragraphs, in reading order.
export const HELP = {
  board: {
    heading: "Home",
    body: [
      "From this screen you see and open any of the created jobs, you can search through them, filter them and create new jobs using the +Job button on the top right of your screen. You can also create a new ticket within any active job using the +Ticket button also located at the top of your screen next to the +Job button. Press the hamburger menu button to see the other available tabs."
    ]
  },
  job: {
    heading: "Job detail",
    body: [
      "From this screen you can see the job details, open, create and send JHAs, and Tickets as well as upload and send reports. When you upload a report the numbers should be automatically read and displayed but please double check they are correct for the next technician"
    ]
  },
  jha: {
    heading: "JHA builder",
    body: [
      "From this screen you can build your JHA... Self explanitory"
    ]
  },
  upload: {
    heading: "Report upload",
    body: [
      "Upload and send your report from this screen"
    ]
  },
  ticket: {
    heading: "Billing ticket",
    body: [
      "From here you build your ticket that will be sent to the client. Be sure to add your helper on to this as well as his hours are calculated from this screen"
    ]
  },
  mytickets: {
    heading: "Open tickets",
    body: [
      "Your own tickets that still have to go out to the client. Once a ticket is sent for approval it leaves this list — this is the to-do, not the archive. The Billing tracker is where every ticket lives.",
      "Above the list, \"Half-entered on this device\" is work that was never saved at all: a ticket or an assessment the phone closed on you. Open the job and start the ticket or assessment there and it comes back with what you typed.",
      "Open assessments ride along too — hazard assessments filed but not closed out at the end of the day.",
      "Discarding a half-entered copy cannot be undone, and it is only on this device. Deleting drafts deletes the saved records."
    ]
  },
  chat: {
    heading: "Team chat",
    body: [
      "One room for the whole crew: text, pictures, voice notes, GIFs, replies and pins. The drawer carries an unread badge, and a line marks where you left off.",
      "Messages are permanent once sent — the wording cannot be edited by anyone. Pinning and unpinning is an Admin's.",
      "The room forgets. Anything not pinned is deleted after 30 days, pictures and voice notes with it. Pin what has to stay.",
      "A job number in a message becomes a link only if it is a real job on file. Numbers are freeform here, so nothing is guessed from the shape of the text.",
      "Push notifications go to the devices signed in on this account. On a shared tablet the notifications follow whoever signed in last."
    ]
  },
  files: {
    heading: "Files",
    body: [
      "The crew's shared documents — procedures, forms, certificates — in a private bucket that only signed-in staff can read.",
      "Folders are part of a file's path rather than records of their own, so the listing cannot drift from what is actually stored. + New folder makes one as soon as a file goes into it.",
      "Upload files, or drop them onto the table, and they land in the folder you are looking at. The breadcrumb walks back up.",
      "The search box searches every folder, not just this one, and lists the matches from elsewhere above the table with an Open folder button.",
      "These are shared documents. Job paperwork — assessments, reports, invoices — belongs on the job, not here."
    ]
  },
  contacts: {
    heading: "Contacts",
    body: [
      "The directory of people at each client and contractor: who signs, who approves, who to phone at 02:00.",
      "This is what every other screen pre-fills a rep from. A new job, a ticket's approval email and a report's recipient all start from the primary contact for that organisation, so keeping one person marked primary is what stops the app guessing.",
      "The toggle switches between clients and contractors; the search finds a person by name, email or phone across both.",
      "Technicians can edit this, not only the office — the person who finds out the site rep's new number is usually the one standing on the lease.",
      "Changing a contact does not rewrite tickets or jobs already filed. Those keep the name and address they were sent to."
    ]
  },
  equipment: {
    heading: "Equipment",
    body: [
      "The fleet: exposure devices, survey meters, dosimeters and tools, with serials, calibration dates and who has each one.",
      "The two tiles at the top only appear when there is something to act on — anything overdue for calibration, and anything due inside 30 days. Overdue means pull it from service.",
      "Assigning equipment to a person is what makes the JHA builder pre-fill their kit. If a worker's dosimeter is wrong on an assessment, it is wrong here.",
      "The filters are by kind; the search covers serial, type and the person it is assigned to.",
      "Adding and editing is for the office. Everyone with the screen can read it, which is the point — a serial number is needed on the lease, not at a desk."
    ]
  },
  timesheets: {
    heading: "Timesheets",
    body: [
      "Hours, solo hours, dose and mileage per person per pay period. None of it is typed here: every figure comes from the crew rows on billing tickets, so a wrong number is fixed on the ticket it came from, not on this screen.",
      "Technicians, Helpers and Coordinators see their own hours here. Admins see everyone. The screen shows you your own even where the database would allow a little more.",
      "An Admin approves a period, which is what marks it done for payroll. Export to Excel builds a two-sheet workbook of the period.",
      "The dose ledger beside it is milliroentgens per person per calendar quarter and year — the figures a nuclear energy worker's record needs. The database adds it up, so a whole year is a few dozen numbers rather than tens of thousands of rows.",
      "Solo hours appear here and are never billed to a client."
    ]
  },
  rates: {
    heading: "Rate admin",
    body: [
      "The rate cards. This screen is not a reference — it is the billing menu: the lines here, in this order, are the dropdowns a technician gets on the ticket screen and the line order on the invoice the client sees.",
      "There is a house card, and each client can have their own. A client set to follow the default takes the house prices live, so a change to the house card moves them too. A client with their own card is on their own prices.",
      "Publish matters exactly once per card. After it has been published, edits go live as they save — which is why the button disappears. There is no second confirmation.",
      "\"Restore removed lines\" puts back any standard line missing from a schedule at zero, ready to be priced. A job override prices one line differently for one job. Every price change is logged with who made it; the history is on each line.",
      "Prices are for Admins and Technicians: the screen opens for anyone given the Rate admin section, but the database hands other roles no figures and refuses their edits."
    ]
  },
  tracker: {
    heading: "Billing tracker",
    body: [
      "Every ticket across every job, paged on the server, with the four running totals worked out by the database rather than by adding up the rows on screen.",
      "Per row: resend the approval link, flag a ticket as chased, cancel an approval request so the ticket can be re-priced, and mark approved tickets as invoiced.",
      "\"Chase all unsigned\" re-sends the approval link to everything still waiting. It leaves alone anything chased in the last three days or carrying an open client query, sends three at a time so the mail service is not overrun, waits out a rate limit instead of writing the ticket off, has a Stop, and names by number anything that failed.",
      "A client rep can send a question back from the approval page. That query shows on the row, and resending the link clears it.",
      "The money, the chase and the accounting export are for Admins and Technicians only. Other roles are handed no totals at all, which is exactly why the buttons are hidden — a chase from an account that cannot see prices would mail every client a $0.00 approval."
    ]
  },
  users: {
    heading: "Users & access",
    body: [
      "Accounts, their role, and which screens each one gets. New accounts are created here and arrive with a link to set their own password; nobody has to be told a password.",
      "The tick boxes are permission, not decoration. A screen someone does not hold is a screen the database refuses them, buckets and all — so removing a tab to tidy up a menu also revokes access to that work. Strip every tab and the account can read nothing at all.",
      "Job detail, the JHA builder, report upload and the billing ticket never appear in anybody's menu; they open from a job. Their permissions are still set here, and still matter.",
      "Changing somebody's role is an Admin's act. Holding this screen lets you grant screens, never rank.",
      "An account with work on file is locked rather than deleted — the foreign keys are what keep their name on tickets and assessments. Unlock account lifts the ban and puts the role's usual screens back."
    ]
  },
  mail: {
    heading: "Admin",
    body: [
      "The settings the app needs to be fully working. Admin-only; a save applies at once.",
      "Email: the Resend key, the sending addresses, and the base address approval links are built from. Without a verified sending address, every send goes out under the mail service's test sender, which delivers only to the inbox the account was opened with. Test before trusting it.",
      "Invoices: the terms, GST number and remit-to block the field invoice prints. The number is the app's own, stamped when a ticket is invoiced.",
      "The error panel lists recent failures from the server-side functions, the log Home's attention strip counts.",
      "Archive builds a year or a date range as one zip. It reads every PDF and renders every invoice, so a busy year takes an hour. Clearing those jobs afterwards is gated three ways: the zip is checked against the build, the jobs are counted again just before the delete, and CLEAR has to be typed.",
      "Automatic backup writes every record and every PDF to a drive of the business's own, on a schedule, server-side. It restores two ways: chosen jobs, which deletes and overwrites nothing, or everything, which empties the database first behind four gates."
    ]
  }
};

// The screen's entry, or null. Null is a real answer — it is what hides the
// "?" rather than opening an empty dialog.
export function helpFor(screenKey) {
  return HELP[screenKey] || null;
}
