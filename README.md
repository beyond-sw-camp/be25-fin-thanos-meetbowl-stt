
# meetbowl-stt

Meetbowl STT server built with TypeScript and Fastify.

The server joins LiveKit rooms as a server participant, subscribes to every
remote participant audio track, and runs a transcription-first STT pipeline
with optional Korean/English OpenAI Realtime Translation sessions per track.

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
  -> OpenAI Transcription source transcript
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

## OpenAI transcription probe

LiveKit을 거치지 않고 OpenAI file transcription API만 확인할 수 있다.

```bash
npm run probe:transcription -- /path/to/audio.wav
```

기본 모델은 `whisper-1`이다. 다른 모델을 확인하려면 두 번째 인자로 전달한다.

```bash
npm run probe:transcription -- /path/to/audio.wav gpt-4o-mini-transcribe
```

Realtime WebSocket 경로는 24 kHz mono PCM16 WAV 파일로 별도 확인한다.

```bash
npm run probe:realtime-transcription -- /path/to/audio-24khz.wav
```

로컬 STT 서버가 실행 중일 때 테스트 Room의 세션을 생성하고 시작한다.

```bash
npm run session:start:local -- stt-test-room
```

세션 종료와 마지막 active segment flush를 확인한다.

```bash
npm run session:stop:local -- <session-id>
```

실행 중인 STT 세션에 테스트 오디오를 publish하고 `caption.updated` 수신까지 확인한다.

```bash
npm run probe:livekit-caption -- /path/to/audio-24khz.wav stt-test-room
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
  providers/       # OpenAI Transcription/Translation adapters
  sessions/        # STT session lifecycle
  transcript/      # Segment, VAD, language and finalization logic
test/              # API tests
```
