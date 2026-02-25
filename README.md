# API Hub

A universal API hub. Connect any REST API, make requests, view responses with syntax highlighting, save favorites, and track history — all from your phone.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

1. Push this repo to GitHub
2. Go to [railway.com](https://railway.com) → New Project → Deploy from GitHub repo
3. Railway auto-detects Node.js and runs `npm start`
4. Done — open the Railway URL on your phone

No environment variables required. Data persists in the `data/` directory on the Railway volume.

## Run Locally

```bash
npm install
npm start
```

Opens on `http://localhost:4800`.

## Features

- **Connect any API** — add a name, base URL, and auth (Bearer, API Key, Basic, or None)
- **Request builder** — GET/POST/PUT/PATCH/DELETE with query params, body, custom headers
- **Response viewer** — syntax-highlighted JSON with colored keys, strings, numbers
- **Request history** — every request logged with status, response time, full details
- **Saved requests** — bookmark requests you use often
- **Real-time** — WebSocket updates via Socket.IO
- **Mobile-first** — designed for phone screens

## Stack

- Express + Socket.IO
- Vanilla JS frontend (zero build step)
- JSON file storage
