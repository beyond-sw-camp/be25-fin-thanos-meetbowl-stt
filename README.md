# meetbowl-sst

Meetbowl SST API server.

## Local setup

```bash
npm install
npm run dev
```

The development server starts at `http://127.0.0.1:3000`.

- Health check: `http://127.0.0.1:3000/api/v1/health`

## Test

```bash
npm test
```

## Layout

```text
src/
  app.js           # Express application setup
  server.js        # Local HTTP server entrypoint
  routes/          # API routers
test/              # API tests
```
