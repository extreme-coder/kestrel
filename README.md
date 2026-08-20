# Kestrel

WebXR viewer for spatial scientific data, and the wind-modelling API that feeds it.

## Run locally

Node 22.22.1 (see `.nvmrc`).

```bash
npm install
npm run dev:server   # API on :8787
npm run dev          # viewer on :5173
```

Each in its own terminal. The viewer proxies `/api` to the server, so start the
server first. SQLite creates itself at `server/data/kestrel.sqlite` on first run.
