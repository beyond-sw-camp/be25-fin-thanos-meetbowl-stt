
# meetbowl-stt

Meetbowl STT API server built with TypeScript, Fastify, and `@fastify/websocket`.

## Local setup

```bash
npm install
npm run dev
```

The development server starts at `http://127.0.0.1:3000`.

- Health check: `http://127.0.0.1:3000/api/v1/health`
- WebSocket health echo: `ws://127.0.0.1:3000/api/v1/ws/health`

## Test

```bash
npm test
```

## Build

```bash
npm run build
npm start
```

## Layout

```text
src/
  app.ts           # Fastify application setup
  server.ts        # Local HTTP server entrypoint
  routes/          # API routers
test/              # API tests
```
