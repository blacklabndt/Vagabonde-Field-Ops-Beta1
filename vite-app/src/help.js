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
      "The dispatch board: every job, searched on the server rather than pulled down whole, so a long list is paged instead of slow. The pills filter by status; the box beside them searches one field at a time — pick which field from the dropdown next to it.",
      "Tap a job to open Job detail, which is where its assessments, reports and tickets live. The buttons at the right raise new work: + Job creates the job record, + Ticket starts a billing ticket. + Ticket needs the ticket screen and the price permission, so it is not on every account.",
      "Admins also get a \"Needs attention\" strip above the filters when something needs saying — a backup that failed, a drive whose consent lapsed, a run of background errors. On an ordinary morning it is not there at all.",
      "With no signal the board shows what this device last saved, and says Offline in the top bar. Searching still works over the saved copy; new jobs wait for a connection."
    ]
  },
  job: {
    heading: "Job detail",
    body: [
      "Everything filed against one job: its hazard assessments, its radiographic reports and its billing tickets, each card reloading only itself after you change something.",
      "The buttons here are how the field screens are meant to be reached. Start JHA, + Upload report and Create ticket all open with this job already under them — that is why those screens are not in the menu: one opened from a menu operates on whichever job happened to be active, which is how the wrong job gets written up.",
      "+ Upload report only appears for accounts with the upload permission. A Helper cannot file a radiographic report; the database refuses it too, so the missing button is the honest answer rather than a hidden one.",
      "Create ticket saves nothing by itself. It hands the work date and this job's reps to the ticket screen, which saves — and queues, if you are out of range — exactly like a ticket started from Home.",
      "Delete job is an Admin's, and it asks what should happen to the work underneath first. An approved ticket cannot be deleted this way at all."
    ]
  },
  jha: {
    heading: "JHA builder",
    body: [
      "The field level hazard assessment as the crew fills it: site information, the hazards with their ratings, the equipment on the job, and both nuclear energy workers with their dosimetry. Filing it writes a real record and renders the PDF.",
      "The date of the assessment is editable. One missed on site can be written up afterwards for the day it actually covers, rather than for the day you typed it.",
      "Each hazard starts at the rating you last gave it, read back out of assessments you filed yourself. There is no preferences list behind that — it is your own filed work, so it cannot drift from what was actually signed.",
      "The equipment section pre-fills from what the Equipment screen has assigned to each worker. Fix it there and the next assessment is right.",
      "Close-out is a separate step later on Job detail: end readings off each dosimeter at the end of the day. The dose is worked out from those readings rather than taken from the screen, and the PDF is redrawn."
    ]
  },
  upload: {
    heading: "Report upload",
    body: [
      "Files a finished radiographic report against this job. The PDF goes into a private bucket and a report record is written; nothing here is public.",
      "Uploading and emailing are two steps on purpose. The file is stored first, then sent to the contractor's contact on the job. If the email fails the report is still on file and shows as Pending — send it again from Job detail rather than uploading a second copy.",
      "If the job has no contractor email, the upload still happens and the screen says nothing was sent. Add the address to the job record and send from Job detail.",
      "This screen needs the upload permission. A Helper holds the job screen but not this one, and the database enforces that, not just the menu."
    ]
  },
  ticket: {
    heading: "Billing ticket",
    body: [
      "The field ticket: every weld and charge priced from the client's rate schedule, plus the crew's hours, dose and mileage.",
      "The dropdowns are the client's own rate card — its lines, in its order — so a charge that is not on their card is not offered. A saved ticket can still hold a line the card no longer sells: those sit read-only under \"No longer on the rate card\", at the rate they were filed at, and their money is still in the total. Use the × to drop one.",
      "Save draft keeps it yours. Email for approval sends the client rep a link to sign. After that the ticket is locked for pricing — a later save is refused until Cancel approval on Job detail (yours if you raised it, or the office's) kills the client's link and makes it a draft again. Crew hours stay writable, because they are the day's pay.",
      "Solo hours are for the timesheet only and are never billed. Billing is per truck, not per technician.",
      "Out of range, the whole ticket queues and sends itself when you have signal. The top bar's outbox badge is where it waits."
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
      "Technicians and Helpers see their own hours and nobody else's. Admins see everyone. That is the database's rule, not the screen's.",
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
      "Prices are for Admins and Technicians. Other roles cannot open this screen, and the database will not hand them the figures either."
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
