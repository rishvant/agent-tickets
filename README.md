# Agent Tickets — web

Minimal login → landing page. Static HTML/CSS/JS, no build step, no dependencies.

| File | What it is |
|---|---|
| `index.html` | Sign-in page (the site root) |
| `app.html` | Landing page, guarded — redirects to `index.html` without a session |
| `auth.js` | Session helpers backed by `localStorage` |
| `styles.css` | All styling |

## Running locally

Any static server works:

```sh
npx serve .
# or
python -m http.server 8000
```

Open the printed URL. `file://` will not work — ES modules are blocked by CORS on
that origin.

## What is deliberately not here

- **No real auth.** `auth.js` writes a session object to `localStorage` after
  client-side validation. Nothing is sent anywhere, and nothing is verified. It
  guards the landing page against a stray navigation, not against a person.
  Replacing `signIn()` with a real API call is the whole migration.
- **No backend.** There is no ticket data because there is no store yet.

## Deploying

Hosted on GitHub Pages from `main` (repo root). Any static host works — Builderlab
Apps, Netlify, Cloudflare Pages — the files have no platform-specific config.
