# Swell Studio

Swell Studio turns a brand name, product name, description and USD price into a 794 × 794 PNG marketing poster. Choose from five illustrated templates, preview the result and manage saved posters in a private library.

## Run locally on Windows

Install Python 3.9–3.13 (available as `python`), Node.js 22 with npm, and Docker Desktop with Docker Compose. Start Docker Desktop. The first run needs internet access to install dependencies.

From the directory containing `start.cmd`, run this command in PowerShell:

```powershell
.\start.cmd
```

The launcher starts PostgreSQL 17, creates a Python virtual environment, installs dependencies, builds the frontend and starts Waitress. When the terminal prints **Swell Studio is ready**, open [the studio](http://127.0.0.1:5086).

Press Ctrl+C to stop the application. Run `docker compose stop db` to stop PostgreSQL. The named volume keeps saved posters between runs.

The default database listens on local port 55436. To use an existing PostgreSQL database, set `$env:DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DBNAME'` before running the launcher. Create the database first and give its application user permission to create tables.

## Linux and frontend development

Install Python, Node.js, npm, Docker Compose, and the DejaVu and Noto CJK fonts. From the project root, run:

```sh
docker compose up -d --wait db
python -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements.txt
(cd frontend && npm ci && npm run build)
python backend/app.py
```

For frontend hot reload, keep the backend running and execute `npm run dev` in `frontend/`. Open the URL printed by Vite. Run `npm run build` there to type-check the frontend and create a production bundle.

## Reviewer walkthrough

1. Choose **Continue as guest** for immediate access. Alternatively, register with an email address and enter the password twice. Registered users sign in with their password and an image CAPTCHA. Each user has a private library. Guests lose access to theirs when they sign out, clear their session cookie or let the session expire.
2. In **Templates**, use the prefilled product or enter your own details. Select a template and click **Generate poster**. The button and preview show a loading state. The completed poster appears automatically and is saved to the library.
3. To check validation, clear the product name or enter a price such as `14.999`. The relevant field explains what to correct. Prices range from USD 0 to 999999.99 with up to two decimal places. If generation fails, the form retains the input and offers a retry.
4. Open **Library** to inspect, enlarge, download or delete a saved poster. Repeat the workflow at a mobile viewport width to check the responsive layout.
5. Select **AI generation** to try the simulated progress display. This preview makes no model request and creates no library entry.

## Technology and design decisions

| Component | Choice | Reason |
| --- | --- | --- |
| Frontend | React, TypeScript, Vite | Form, preview and library state update without a page reload. |
| Backend | Python, Flask, Waitress | One service validates input, checks ownership and serves the local UI and API from the same origin. |
| Rendering | Pillow and local templates | Deterministic layout preserves the submitted product copy and price, supports Chinese and English text wrapping, and needs no model credentials. |
| Storage | PostgreSQL 17 | A transaction saves the PNG and its metadata together. Request IDs prevent duplicate posters on retries. Paginated library queries omit image bytes. |

The UI lives in `frontend/src/`, and the API and renderer live in `backend/`. The template catalog is in `templates.json`. Local database configuration is in `compose.yaml`.

## Known limitations and future work

- **Email verification.** Email currently serves as a login identifier. Configure a sending domain and a server-side SMTP account to support registration codes and password resets. Use expiring, single-use codes and rate-limit delivery. Exclude local `.env` and `smtp.ini` files when sharing a ZIP.
- **AI integration and model selection.** The reserved `POST /api/posters/ai` endpoint currently returns HTTP 501. A first integration could use a hosted image model that accepts a visual reference to generate backgrounds, then overlay product details with Pillow. Compare candidate models on the same product briefs for style consistency, space for text, latency and cost per usable poster. Keep the API key on the backend and make the model configurable. Optional copywriting could use a separate text model with user approval before rendering.
- **Formats and scale.** The renderer currently supports square posters and USD prices. For slower AI jobs, add a background queue and persist job states so the progress display can report actual results. At higher image volumes, move PNGs to object storage and keep ownership and metadata in PostgreSQL.
- **Hosting.** The assignment accepts a repository or ZIP for local review. To publish the frontend on GitHub Pages, host Flask and PostgreSQL separately. Before building, set `VITE_API_BASE_URL` to the backend HTTPS origin without a trailing `/api`. Set the backend's `FRONTEND_ORIGIN` to the frontend origin and `COOKIE_SECURE=1` for HTTPS. Cross-site sessions also require `COOKIE_CROSS_SITE=1`. Use same-site domains or a same-origin reverse proxy when browsers restrict third-party cookies.

## AI tools and artwork credits

OpenAI Codex assisted with implementation, interface adjustments, startup configuration and verification. Ocean Breeze uses supplied artwork. Four companion illustrations were created with an image generation tool using the original beach style as a reference. At runtime, Pillow composes each template poster locally.

Older photographic templates are archived in the catalog for compatibility with existing posters and API clients. The photographs were sourced from the [elementary wallpaper collection](https://github.com/elementary/wallpapers). The files are cropped, resized, and composed into product layouts. See the [upstream licensing notes](https://github.com/elementary/wallpapers/blob/deb-packaging/debian/copyright).

| Template | Photograph | License per collection |
| --- | --- | --- |
| Golden Petal | [Martin Adams](https://unsplash.com/photos/MpTdvXlAsVE) | Unsplash License |
| Canyon Clay | [Ashim D’Silva](https://unsplash.com/photos/WeYamle9fDM) | CC0 |
| Alpine Field | [Canazei Granite Ridges](https://unsplash.com/photos/yrwpJwDNSHE) | CC0 |
| Violet Pier | [Sunset by the Pier](https://unsplash.com/photos/ces8_Bo7bhQ) | CC0 |
