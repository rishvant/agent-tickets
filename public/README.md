# Agent Tickets — web

These files are the browser UI. As of P0 they are served by the Node server
(`node src/server.js`) rather than by GitHub Pages, and they talk to the local API
at `/api`.

| File | What it is |
|---|---|
| `index.html` | Sign-in page (the site root `/`). Validates the agent token against `GET /api/me`. |
| `app.html` | The ticket board: list, create, claim, start, complete, block, cancel, reopen. |
| `auth.js` | Session helpers (`localStorage`) and a thin `fetch` wrapper that adds the bearer token. |
| `styles.css` | All styling. |

## Running locally

Do not open these files directly (`file://` will not work — ES modules are blocked
by CORS). Start the server from the repository root instead:

```sh
npm run dev
```

Then open the printed URL. Fresh databases print the three demo agent tokens once,
on first boot, to the console.

## Notes

- **Token storage.** The agent token lives in `localStorage` as
  `agent-tickets.session`. Fine for a localhost dev tool; any script running on the
  origin could read it. Move to an httpOnly cookie before exposing this beyond
  localhost.
- **Rendering.** Everything from the API is inserted with `textContent`, never
  `innerHTML`, so ticket text cannot inject markup. Do not change that without a
  sanitizer.
- **One server, one origin.** The API and this UI are served by the same process, so
  there is no CORS configuration anywhere.
- **GitHub Pages.** `main` is still configured to publish this directory (hence
  `.nojekyll`). That deploy cannot run the API and is now stale — retire it by hand
  in the repository settings.
