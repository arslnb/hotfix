# Hotfix

Solid + Vite+ frontend, Axum + Postgres backend, and server-side OAuth sessions for GitHub and Sentry.

## Stack

- Frontend: SolidJS, Tailwind CSS, Vite+
- Backend: Rust, Axum, SQLx, Postgres
- Session storage: encrypted cookie session IDs backed by Postgres

## Local setup

1. Start Postgres locally on your machine and make sure `HOTFIX_DATABASE_URL` points to it.

2. Copy the environment file and fill in the OAuth credentials:

   ```bash
   cp .env.example .env
   ```

3. Generate a strong session secret:

   ```bash
   openssl rand -base64 32
   ```

4. Register these callback URLs in your OAuth apps:

   - GitHub: `http://localhost:5173/api/auth/github/callback`
   - Sentry: `http://localhost:5173/api/auth/sentry/callback`

## Run in development

Migrations are applied automatically when the API backend starts via `sqlx::migrate!()`. In practice, running the backend once is your migration step.

Run the full local stack:

```bash
make dev
```

That starts:

- the mock sandbox on `127.0.0.1:4001`
- the API backend on `127.0.0.1:3000`
- the frontend dev server

You can also run pieces individually:

```bash
make dev-api
make dev-sandbox
make dev-frontend
```

The frontend proxies `/api` to `VITE_API_PROXY_TARGET`, which defaults to `http://127.0.0.1:3000`.

Stop the local processes with:

```bash
make stop
```

## Production-style build

Build the frontend:

```bash
cd frontend
vp build
```

Then start the backend again. If `frontend/dist/index.html` exists, the Rust server will serve the built SPA itself.

## Repo layout

- `frontend/` contains the Solid app
- `backend/` contains the Rust API and auth/session logic

If you deploy the frontend and backend as separate services on Railway, point the frontend service at `frontend/` and the backend service at `backend/`.
