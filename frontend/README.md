# Frontend — DSA/CP Trainer

A designed client over the API in [`../backend`](../backend). It adds **no endpoints, no schema
changes and no business logic** — every number on screen comes from an endpoint the backend
already exposes.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · `motion` · shadcn/ui

---

## Running it

The backend must be running first, on port 5000.

```bash
cd ../backend && npx tsx src/server.ts    # :5000

cd frontend
npm install
npm run dev                                # :3000
```

**It must be served from exactly `http://localhost:3000`.** The backend's `requireSameOrigin`
middleware compares the browser's `Origin` header against its `FRONTEND_URL` byte for byte and
fails closed, so any other port makes every write return `403`.

Point at a different API with `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:5000`).

```bash
npm run build     # production build, includes a typecheck
npx eslint .      # React 19 compiler rules — kept clean
```

---

## The one thing to know before changing anything

**Authenticated data is fetched in the browser, and that is forced rather than chosen.**

The backend sets its session cookie with no `Domain` attribute, which makes it **host-only**: it
belongs to `localhost:5000` and the browser will not send it to `localhost:3000`. The Next.js
server process — a different machine in production — cannot read it at all.

So there is no Server Component data fetching anywhere in this app, and `router.refresh()` is a
no-op for our data, because it refetches Server Components and none of them hold any. Protected
pages are Client Components; Next still server-renders their shell, which is the designed skeleton.

Two consequences worth internalising:

- **Every request goes through `lib/api.ts`.** It is the only place `credentials: "include"` is
  written. Omitting that flag does not throw or warn — the browser silently drops the cookie, the
  request arrives unauthenticated, and you get a `401` that looks like an auth bug and is a fetch
  bug.
- **`GET /api/auth/me` is exempt from the global 401 redirect** (`ME_OPTIONS`). Its `401` is the
  expected answer for a signed-out visitor, not an expired session; routing it through the handler
  makes `/login` loop with itself.

Client-side route protection is **UX, not security**. The backend's `requireAuth` is the
enforcement and rejects every unauthenticated request regardless of what the client does.

---

## Layout

```
app/
  globals.css            the design system — @theme tokens, one dark media query
  layout.tsx             fonts (Archivo width axis + IBM Plex Mono), AuthProvider
  login/  register/      the two auth forms, carrying Plate I
  (app)/                 route group — everything behind requireAuth
    layout.tsx           client auth gate, readout bar, AI + integrations providers
    page.tsx             the instrument: the Spread beside the Queue
    revision/  integrations/
components/
  spread.tsx             the signature element — 32 topics as deviations from a neutral axis
  plate.tsx              Plate I — hand-written SVG drawn from a real measured profile
  queue.tsx  explain.tsx  readout-bar.tsx  sync-panel.tsx  states.tsx
  ui/                    shadcn: button, input, label only
lib/
  api.ts                 the single fetch wrapper
  auth-context.tsx       three-state auth (loading / authed / anon), no auth library
  use-resource.ts  types.ts  format.ts  motion.ts
```

## Design

The visual system is **Calibrated Absence**, specified in
[`.claude/skills/trainer-design/`](../.claude/skills/trainer-design/). Its governing rule is that
**colour is reserved for data semantics** — eight tokens, five achromatic, and the three coloured
ones encode a single axis, so `HARD` and `weak` are the same red and `EASY` and `strong` the same
teal. Nothing else in the interface is coloured.

The rule that matters most when editing: **a topic with no data is never rendered as zero.**
`UnknownTopicView` has no `masteryScore` field, so that mistake is a compile error rather than a
matter of discipline.
