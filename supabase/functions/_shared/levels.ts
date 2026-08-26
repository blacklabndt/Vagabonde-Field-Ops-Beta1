// The certification levels printed beside a technician's name on the client
// field invoice, and the legend that explains them at the foot of the crew
// block.
//
// The same six codes are the CHECK constraint on profiles.level and the
// picker in Users & access (see TECH_LEVELS in vite-app/src/data.js). Kept in
// step by hand across the two runtimes — the app is bundled by Vite and this
// runs in Deno, so they cannot import each other — which is why the constraint
// exists: the database refuses anything these two do not both know about.

export const LEVELS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "S", label: "Specialist" },
  { code: "T2", label: "Level 2 Certified Technician" },
  { code: "T1", label: "Level 1 Certified Technician" },
  { code: "C", label: "CEDO" },
  { code: "T", label: "Trainee" },
  { code: "A", label: "Administrative" }
];

export const LEVEL_LEGEND =
  "Cert codes: " + LEVELS.map(l => `${l.code} = ${l.label}`).join(" · ");
