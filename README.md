
# meetbowl-stt

Meetbowl STT server built with TypeScript and Fastify.

The server joins LiveKit rooms as a server participant, subscribes to every
remote participant audio track, and runs independent Korean/English OpenAI
Realtime Translation sessions per track.

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

The development server starts at `http://127.0.0.1:3000`.

- Health check: `http://127.0.0.1:3000/api/v1/health`
- WebSocket health echo: `ws://127.0.0.1:3000/api/v1/ws/health`

Session APIs require `X-Internal-Token`.

```text
POST /api/v1/sessions
POST /api/v1/sessions/{sessionId}/start
POST /api/v1/sessions/{sessionId}/stop
POST /api/v1/sessions/{sessionId}/transcripts/final/flush
GET  /api/v1/sessions/{sessionId}
```

## Runtime flow

```text
LiveKit participant audio track
  -> OpenAI Translation target=ko and target=en
  -> LiveKit DataChannel caption.updated
  -> RabbitMQ transcript.final.created
  -> Redis Stream meeting.feedback.segment.created
```

The server keeps only active segments and connection state in memory. It does
not retain the full meeting transcript or build the AI feedback rolling window.

## Required environment

```text
OPENAI_API_KEY
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
RABBITMQ_URL
REDIS_URL
INTERNAL_TOKEN
```

Use `.env.example` for the complete configurable timeout and stream settings.
Do not expose `OPENAI_API_KEY` or `LIVEKIT_API_SECRET` to the frontend.

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
  config/          # Environment validation
  events/          # RabbitMQ, Redis Stream, event envelopes
  livekit/         # Room sessions and participant audio pipelines
  providers/       # OpenAI Translation adapter
  sessions/        # STT session lifecycle
  transcript/      # Segment, VAD, language and finalization logic
test/              # API tests
```
