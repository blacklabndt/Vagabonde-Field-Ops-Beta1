// Loading a ticket into the shape the invoice renderer wants.
//
// Three functions need this now — the page a client signs, the copy attached
// to the approval email, and the office view on Job detail — and they must
// agree down to the column list. Two of them had already been written out by
// hand and the third would have made a set of three that nothing keeps in
// step: a field added to the select in one place and forgotten in the others
// prints on one copy of a bill and not another.
//
// Deliberately takes the client rather than making one. approve-ticket reads
// with the service role because the person following the link has no account;
// the other two read as the signed-in user so row-level security still
// decides what they can see. Same shape either way.

import type { InvoiceData } from "./invoice.ts";
import { LEVEL_LEGEND } from "./levels.ts";

// Everything the invoice prints, and nothing else.
export const TICKET_INVOICE_SELECT =
  "id, work_date, total, status, delays, client_contact, approved_at, approved_by_email, approved_signature, approval_sent_to, " +
  "jobs(job_number, project, lsd, afe, area, clients(name), contractors(name)), " +
  "ticket_lines(kind, label, unit, quantity, unit_rate)";

// The embed above comes back in whatever order the heap holds the rows,
// which drifts once vacuum reuses the space a re-saved ticket's old lines
// left behind. line_order is the insertion sequence — the app saves lines
// in the rate card's order — so ordering by it keeps the printed bill in
// the order the client agreed the card in. Every reader of the select
// applies this; a copy that forgets prints the charges shuffled.
export const TICKET_LINES_ORDER = ["line_order", { referencedTable: "ticket_lines" }] as const;

const CREW_SELECT =
  "straight_hours, ot_hours, mileage_km, profiles(name, level, id_code)";

// deno-lint-ignore no-explicit-any
type Client = any;

export async function loadInvoice(
  client: Client,
  ticketId: string,
  fallbackContact = ""
): Promise<{ data: InvoiceData | null; error: string | null }> {
  const { data: ticket, error } = await client
    .from("tickets")
    .select(TICKET_INVOICE_SELECT)
    .order(...TICKET_LINES_ORDER)
    .eq("id", ticketId)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  if (!ticket) return { data: null, error: "Ticket not found, or you don't have access to it." };

  // Crew is read separately because ticket_crew is not reachable through the
  // ticket's own embed. Best-effort: a ticket with no crew recorded still has
  // a bill on it, and failing to list who was there must not stop it printing.
  const { data: crewRows } = await client
    .from("ticket_crew")
    .select(CREW_SELECT)
    .eq("ticket_id", ticketId);

  return {
    error: null,
    data: {
      ticket: ticket as InvoiceData["ticket"],
      // deno-lint-ignore no-explicit-any
      job: ((ticket as any).jobs ?? {}) as InvoiceData["job"],
      // deno-lint-ignore no-explicit-any
      contact: ((ticket as any).client_contact?.name as string) || fallbackContact,
      // deno-lint-ignore no-explicit-any
      lines: ((ticket as any).ticket_lines ?? []) as InvoiceData["lines"],
      // deno-lint-ignore no-explicit-any
      crew: (crewRows ?? []).map((c: any) => ({
        name: c.profiles?.name ?? "",
        level: c.profiles?.level ?? "",
        certNo: c.profiles?.id_code ?? "",
        straight: Number(c.straight_hours ?? 0),
        ot: Number(c.ot_hours ?? 0),
        mileage: Number(c.mileage_km ?? 0)
      })),
      levelLegend: LEVEL_LEGEND
    }
  };
}
