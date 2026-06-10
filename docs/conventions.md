# STT Server 개발 컨벤션

## 목적

본 문서는 `meetbowl-stt`에서 사용하는 개발 규칙을 정의한다.

모든 개발자와 AI Agent는 기능 구현 시 본 문서의 규칙을 준수해야 한다.

---

# 1. 기본 원칙

`meetbowl-stt`는 실시간 음성 처리 서버이다.

담당 범위:

- LiveKit 연동
- 오디오 수집
- STT 처리
- 실시간 자막 생성
- Transcript 이벤트 발행
- 실시간 피드백 입력 이벤트 발행
- AI 피드백 결과 구독 및 LiveKit DataChannel 전달

다음 기능은 구현하지 않는다.

- 회의 CRUD
- 사용자 관리
- 메일 기능
- 회의록 생성
- 챗봇
- 임베딩
- MariaDB 저장

---

# 2. 프로젝트 구조

권장 구조:

```text
src
├── app
├── modules
│   ├── livekit
│   ├── stt
│   ├── transcript
│   └── events
├── providers
│   ├── deepgram
│   ├── clova
│   └── ...
├── shared
└── config
```

---

# 3. 네이밍 규칙

## 파일명

kebab-case 사용.

예시:

```text
stt-session.service.ts
deepgram-client.ts
transcript-publisher.ts
```

## 클래스명

PascalCase 사용.

예시:

```typescript
SttSessionService
TranscriptPublisher
DeepgramClient
```

## 함수명

camelCase 사용.

예시:

```typescript
startSession()
stopSession()
publishTranscript()
```

---

# 4. DTO / Event Schema 규칙

API DTO와 Event DTO는 분리한다.

| DTO | 용도 |
|---|---|
| Session Request/Response DTO | 내부 REST API |
| Transcript Event DTO | Redis Stream / RabbitMQ |
| Caption Event DTO | LiveKit DataChannel |
| Feedback Event DTO | LiveKit DataChannel |
| Provider DTO | STT Provider adapter |

금지:

- Provider 응답을 그대로 외부 이벤트로 발행
- API DTO와 Event DTO 혼용
- Final Transcript payload 임의 변경

---

# 5. Provider 규칙

STT Provider는 직접 사용하지 않는다.

반드시 Provider Adapter를 사용한다.

예시:

```typescript
interface SttProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

허용:

```text
Deepgram
Clova
AssemblyAI
Tiro
Whisper API
```

---

# 6. Transcript 규칙

## Partial Transcript

목적:

```text
실시간 자막 표시
```

규칙:

```text
DB 저장 금지
장기 보관 금지
```

사용자 화면 자막의 기본 전달 채널은 LiveKit DataChannel이다.

Partial Transcript는 서버 내부 AI 피드백 입력으로 발행하지 않는다.

## Final Transcript

목적:

```text
회의 원문 생성
AI 회의록 생성 기반 데이터
```

규칙:

```text
RabbitMQ 이벤트 발행
AI 피드백 입력용 Redis Stream 이벤트 발행
```

eventType:

```text
transcript.final.created
meeting.feedback.segment.created
```

---

# 7. 이벤트 규칙

발행 가능 이벤트:

```text
transcript.final.created
recording.completed
meeting.feedback.segment.created
```

이 외 이벤트는 루트 `docs/event-contract.md`에 정의된 경우에만 추가한다.

이벤트 포맷은 공통 Envelope를 사용한다.

```json
{
  "eventId": "uuid",
  "eventType": "event.name",
  "occurredAt": "2026-06-02T01:00:00Z",
  "producer": "stt-server",
  "version": 1,
  "correlationId": "uuid",
  "payload": {}
}
```

---

# 8. LiveKit 규칙

회의 참가자 오디오는 LiveKit Track에서 수신한다.

오디오를 파일로 모두 저장한 뒤 처리하지 않는다.

반드시 스트리밍 방식으로 처리한다.

```text
LiveKit Track
↓
Audio Frame
↓
STT Provider
```

Room 전체 audio mix를 사용하지 않는다. participant audio track마다 독립 pipeline을
생성하고 한국어 target과 영어 target Translation session에 동일 audio frame을 전달한다.

---

# 9. DataChannel / Redis Stream 규칙

사용자 화면 자막과 AI 실시간 피드백은 LiveKit DataChannel을 기본으로 사용한다. 회의 참여자 간 실시간 채팅도 LiveKit DataChannel을 사용하지만, `meetbowl-stt`가 채팅 내용을 생성하거나 저장하지 않는다.

```text
meetbowl-stt
↓
LiveKit DataChannel
↓
meetbowl-fe
```

회의 채팅 이벤트:

```text
meetbowl-fe
↓
LiveKit DataChannel: chat.message.sent
↓
meetbowl-fe
```

Redis Stream은 서버 내부 실시간 처리 흐름에 사용한다.

```text
meetbowl-stt
↓
Redis Stream
↓
meetbowl-ai
```

Redis Stream을 장기 저장소로 사용하지 않는다.

Finalized segment는 한 건씩 `meeting.feedback.segment.created`로 발행한다.
AI 피드백용 rolling window는 `meetbowl-ai`가 구성한다.

---

# 10. 메모리 규칙

오디오 파일 전체를 메모리에 적재하지 않는다.

회의 전체 원문 문자열, finalized segment 전체 목록, AI 피드백용 transcript window도
메모리에 보관하지 않는다.

금지:

```typescript
readEntireAudioFile()
```

권장:

```typescript
streamAudio()
```

---

# 11. 로그 규칙

Transcript 전체 내용을 INFO 로그에 출력하지 않는다.

허용:

```text
meetingId
sessionId
provider
latency
status
```

금지:

```text
회의 원문 전체
개인정보 포함 발화
JWT
API Key
```

---

# 12. 오류 처리 규칙

STT Provider 장애가 발생해도 서버 전체가 중단되면 안 된다.

Provider 연결 실패:

```text
재연결 시도
오류 로그 기록
세션 DEGRADED 또는 FAILED 처리
```

Transcript 발행 실패:

```text
재시도
DLQ 처리
```

---

# 13. Error Code 규칙

STT 서버 에러 코드는 `STT_` prefix를 사용한다.

예시:

```text
STT_SESSION_NOT_FOUND
STT_PROVIDER_UNAVAILABLE
STT_STREAM_DISCONNECTED
STT_TRANSCRIPT_PUBLISH_FAILED
STT_RECORDING_FAILED
STT_CAPTION_LANGUAGE_UNSUPPORTED
```

---

# 14. 성능 규칙

실시간 처리 성능을 우선한다.

실시간 STT 및 번역 자막은 회의 흐름을 크게 방해하지 않는 수준의 지연 시간으로 제공한다.

---

# 15. 금지 사항

- MariaDB 직접 접근 금지
- Interim/Partial Transcript DB 저장 금지
- Provider SDK 호출을 여러 레이어에 분산 금지
- STT Final 이벤트 payload 임의 변경 금지
- 회의 권한을 `meetbowl-stt` 단독으로 최종 판단 금지
- 회의 채팅 내용 저장 금지
- 장기 보관 데이터를 Redis Stream에 의존 금지
