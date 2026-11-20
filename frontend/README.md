# Threadline Frontend

React 18 + Vite + Tailwind single-page app for the Threadline handover API.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:4000` (override with
`VITE_API_PROXY`). Start the backend first — see the root
[README](../README.md#demo-in-60-seconds) for the 60-second setup and demo seed.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Deployed API origin. Leave empty in development to use the proxy. |
| `VITE_API_PROXY` | Local API target for the dev proxy (default `http://localhost:4000`). |

## Build

```bash
npm run build      # output in dist/
npm run preview    # serve the production build locally
```

When hosting, configure SPA fallback rewrites so deep links such as
`/projects/:id/audit` and `/shared/:token` resolve to `index.html`.

## Structure

- `src/pages/` — Login and registration, the public `/verify-email` landing
  page, Projects, project workspace (Overview, Sources, Claims, Handovers,
  Review, People, Audit) and the shared handover view.
- `src/components/` — shell/navigation, claim cards, evidence drawer, UI kit.
- `src/context/` — auth session, workspace data, toasts.
- `src/lib/` — API client, formatters, role and claim constants.

All demo data is synthetic and supplied by the backend seeder; the frontend never
fabricates claims or evidence.
