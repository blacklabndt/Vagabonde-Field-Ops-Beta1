# VagaboNDE Field Ops — the app

The app itself. Everything about what it does, how the Supabase project
behind it is put together, and what still needs setting up lives in the
[parent README](../README.md) — this file is just the commands.

```
npm install
cp .env.example .env      # already has the public URL + publishable key
npm run dev               # http://localhost:5173
npm run build             # -> dist/, static files to host anywhere
npm run preview           # serve that build locally
```

Two things worth knowing before editing:

- `public/_ds/industry-…/styles.css` is the design system, copied here so it
  is served at the path `index.html` expects. It is unmodified from the
  handoff — app-specific styling goes in `src/app.css`.
- `.env` is gitignored. The values in `.env.example` are the project's public
  URL and publishable key, safe to commit and safe in a browser: access
  control is row-level security in Postgres, never key secrecy. A service-role
  key must never appear in this folder.
