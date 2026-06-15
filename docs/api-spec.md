# Meetbowl stt-server API 명세서

## 1. 역할

`meetbowl-stt`는 Meetbowl의 실시간 음성 처리 서버다.

담당 범위:

- LiveKit 회의 오디오 트랙 수신
- STT Provider 연동
- 실시간 Interim/Partial Transcript 생성
- Final Transcript 생성
- 실시간 자막 전달
- AI 실시간 피드백 결과 전달
- 실시간 STT 자막과 보조 번역 자막 전달
- KOR/ENG 자막 표시 언어 전환
- 회의 종료 후 Final Transcript 전달
- 녹음 파일 저장 요청 또는 녹음 메타데이터 전달

`meetbowl-stt`는 원칙적으로 프론트엔드의 일반 REST 호출 대상이 아니다.

회의 참여와 권한 검증은 `meetbowl-be`가 담당한다.

---

## 2. 공통 규칙

### Base URL

```text
/api/v1
```

### 내부 인증

```http
X-Internal-Token: {internalToken}
```

### 공통 성공 응답

```json
{
  "success": true,
  "data": {},
  "message": null
}
```

### 공통 실패 응답

```json
{
  "success": false,
  "error": {
    "code": "STT_ERROR_CODE",
    "message": "오류 메시지",
    "details": []
  }
}
```

---

## 3. Error Code

| Code | HTTP | 설명 |
|---|---:|---|
| `STT_SESSION_NOT_FOUND` | 404 | STT 세션 없음 |
| `STT_PROVIDER_UNAVAILABLE` | 503 | STT Provider 장애 |
| `STT_STREAM_DISCONNECTED` | 503 | 음성 스트림 연결 끊김 |
| `STT_TRANSCRIPT_PUBLISH_FAILED` | 500 | Transcript 이벤트 발행 실패 |
| `STT_RECORDING_FAILED` | 500 | 녹음 처리 실패 |
| `STT_CAPTION_LANGUAGE_UNSUPPORTED` | 400 | 지원하지 않는 자막 언어 |

---

## 4. Health API

| Method | Endpoint | 설명 | 호출 주체 |
|---|---|---|---|
| GET | `/health` | 서버 상태 확인 | Infra/API Server |
| GET | `/health/provider` | STT Provider 연결 상태 확인 | Infra/API Server |
| GET | `/health/livekit` | LiveKit 연결 상태 확인 | Infra/API Server |

---

## 5. STT Session API

| Method | Endpoint | 설명 | 호출 주체 |
|---|---|---|---|
| POST | `/sessions` | STT 세션 생성 | meetbowl-be |
| POST | `/sessions/{sessionId}/start` | STT 세션 시작 | meetbowl-be/System |
| POST | `/sessions/{sessionId}/stop` | STT 세션 종료 | meetbowl-be/System |
| GET | `/sessions/{sessionId}` | STT 세션 상태 조회 | meetbowl-be |

### POST `/sessions`

#### Request

```json
{
  "meetingId": "uuid",
  "organizationId": "uuid",
  "participantUserIds": ["uuid", "uuid"],
  "roomName": "livekit-room-name",
  "recordingEnabled": true
}
```

#### Response

```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "meetingId": "uuid",
    "organizationId": "uuid",
    "status": "CREATED"
  },
  "message": null
}
```

---

## 6. Transcript API

Final Transcript는 `meetbowl-be`에 저장해야 한다.

Interim/Partial Transcript는 저장하지 않는다.

운영 기본 경로는 RabbitMQ `transcript.final.created` 이벤트 발행이다.

STT 서버는 finalized segment 전체 목록을 보관하지 않는다. REST API는 session 상태와
현재 active segment flush를 위한 장애 대응 용도로만 사용한다.

| Method | Endpoint | 설명 | 호출 주체 |
|---|---|---|---|
| POST | `/sessions/{sessionId}/transcripts/final/flush` | active segment 강제 확정/전달 | meetbowl-be/System |

### Final Transcript Event Payload

```json
{
  "eventId": "uuid",
  "eventType": "transcript.final.created",
  "occurredAt": "2026-06-02T01:00:00Z",
  "producer": "stt-server",
  "version": 1,
  "correlationId": "uuid",
  "payload": {
    "meetingId": "uuid",
    "sessionId": "uuid",
    "segmentId": "uuid",
    "sequence": 12,
    "language": "ko",
    "text": "오늘 회의 안건은 배포 일정입니다.",
    "startedAtMs": 1000,
    "endedAtMs": 5000,
    "provider": "openai-realtime-transcription",
    "finalizationReason": "VAD_SILENCE",
    "idempotencyKey": "segmentId"
  }
}
```

---

## 7. Caption / Translation API

실시간 자막 화면 전달은 LiveKit DataChannel을 기본으로 한다. AI 실시간 피드백도 `meetbowl-stt`가 LiveKit DataChannel로 전달한다.

각 segment의 `text`를 원문 자막 기준으로 생성한다. 이전 클라이언트 호환 기간에는
`sourceText`, `sourceLanguage`, `sourceTranscript`를 함께 제공할 수 있지만 저장과
피드백 입력은 `text`, `language`를 기준으로 한다.

### Caption Event

```json
{
  "eventType": "caption.updated",
  "meetingId": "uuid",
  "sessionId": "uuid",
  "segmentId": "uuid",
  "sequence": 12,
  "status": "STREAMING",
  "language": "ko",
  "text": "오늘 회의 안건은 배포 일정입니다.",
  "startedAtMs": 1000,
  "endedAtMs": null,
  "updatedAt": "2026-06-02T01:00:00Z"
}
```

---

## 8. LiveKit DataChannel Producer

`meetbowl-stt`는 사용자 화면 자막과 AI 실시간 피드백을 LiveKit DataChannel로 전달한다.

회의 참여자 간 실시간 채팅은 `meetbowl-fe`가 LiveKit DataChannel `chat.message.sent` 이벤트로 송수신한다. `meetbowl-stt`는 채팅 내용을 생성하거나 저장하지 않는다.

| Event | 설명 |
|---|---|
| `caption.updated` | 화면 표시용 실시간 자막 |
| `caption.language.changed` | 자막 표시 언어 변경 |
| `stt.status.changed` | STT 상태 변경 |
| `feedback.generated` | 화면 표시용 AI 실시간 피드백 |

---

## 9. Redis Stream Producer

`meetbowl-stt`는 서버 내부 실시간성이 필요한 이벤트를 Redis Stream으로 발행한다.

AI 피드백 입력에는 Meetbowl finalizer가 확정한 segment만 사용한다. Interim/Partial
Transcript는 LiveKit DataChannel을 통한 화면 자막 표시용이며 Redis Stream으로
AI 서버에 발행하지 않는다.

| Stream | Event | 설명 |
|---|---|---|
| `meeting:{meetingId}:feedback-source` | `meeting.feedback.segment.created` | Finalized segment 단위 AI 피드백 입력 |
| `meeting:{meetingId}:status` | `stt.status.changed` | 회의 중 STT 상태 이벤트 |

Redis Stream은 장기 보관 용도로 사용하지 않는다.

### Feedback Segment Event Payload

```json
{
  "eventId": "uuid",
  "eventType": "meeting.feedback.segment.created",
  "occurredAt": "2026-06-02T01:00:00Z",
  "producer": "stt-server",
  "version": 1,
  "correlationId": "uuid",
  "payload": {
    "meetingId": "uuid",
    "sessionId": "uuid",
    "organizationId": "uuid",
    "participantUserIds": ["uuid", "uuid"],
    "segmentId": "uuid",
    "sequence": 12,
    "language": "ko",
    "text": "오늘 회의 안건은 배포 일정입니다.",
    "isFinal": true,
    "startedAtMs": 1000,
    "endedAtMs": 5000
  }
}
```

## 9.1 Redis Stream Consumer

`meetbowl-stt`는 AI 서버가 생성한 실시간 피드백 결과를 Redis Stream에서 구독하고, LiveKit DataChannel로 회의 참여자에게 전달한다.

| Stream | Event | 처리 |
|---|---|---|
| `meeting:{meetingId}:feedback-result` | `meeting.feedback.generated` | LiveKit DataChannel `feedback.generated`로 전달 |

---

## 10. RabbitMQ Producer

`meetbowl-stt`는 안정적으로 처리되어야 하는 작업을 RabbitMQ로 발행한다.

Final Transcript 저장과 녹음 파일 메타데이터 저장은 RabbitMQ 발행이 운영 기본 경로이며, 내부 REST 호출은 수동 재처리나 점검 목적으로만 사용한다.

| Queue | Event | 설명 |
|---|---|---|
| `api.transcript.final.save` | `transcript.final.created` | Final Transcript 저장 요청 |

---

## 11. 저장 원칙

- Interim/Partial Transcript는 DB에 저장하지 않는다.
- Final Transcript만 저장 대상으로 본다.
- `meetbowl-stt`는 회의 중 채팅 내용을 저장하지 않는다.
- MariaDB 저장은 `meetbowl-be`를 통해 수행한다.
