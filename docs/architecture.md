# Meetbowl stt-server 아키텍처

## 1. 목적

`meetbowl-stt`는 Meetbowl의 실시간 음성 처리와 STT 연동을 담당하는 내부 서버다.

LiveKit 회의 음성 트랙을 수신하고, STT Provider로 전달하여 실시간 자막과 최종 Transcript를 생성한다.

`meetbowl-stt`는 회의 업무 데이터의 기준 저장소가 아니며, MariaDB에 직접 접근하지 않는다.

---

## 2. 책임 범위

`meetbowl-stt`가 담당하는 책임은 다음과 같다.

- LiveKit Room/Track 연결
- 회의 참가자 음성 트랙 수신
- STT Provider 실시간 스트리밍 연결
- Interim/Partial Transcript 처리
- Final Transcript 처리
- 한국어/영어 자막 이벤트 발행
- KOR/ENG 자막 표시 언어 전환 지원
- 회의 녹음 세션 제어 보조
- LiveKit DataChannel로 화면 자막과 실시간 피드백 전달
- Redis Stream으로 실시간 분석 이벤트 발행
- RabbitMQ로 Final Transcript 저장 요청 발행
- STT 세션 상태 관리
- STT Provider 장애 감지 및 오류 이벤트 발행

`meetbowl-stt`는 회의 생성, 회의실 예약, 사용자 권한 최종 판단, 회의록 AI 생성, 내부 메일 발송을 담당하지 않는다.

---

## 3. 외부 시스템 관계

```text
LiveKit
  ↓ audio track
meetbowl-stt
  ↓ STT Provider
  ├─ LiveKit DataChannel → meetbowl-fe
  ├─ Redis Stream → meetbowl-ai
  ├─ RabbitMQ → meetbowl-be
  └─ Object Storage
```

### LiveKit

회의 음성 트랙의 출처다.

`meetbowl-stt`는 LiveKit Room에 server participant로 참여하고 모든 remote participant
audio track을 개별 subscribe한다. Room 전체 mixed audio는 처리하지 않는다.

### STT Provider

음성을 텍스트로 변환하는 외부 Provider다.

초기 Provider는 OpenAI Realtime Translation이다. participant audio track마다 한국어
target과 영어 target Translation session을 두며, Provider 호출은 adapter 내부에
숨긴다.

### LiveKit DataChannel

회의 화면에 표시되는 실시간 자막, 실시간 피드백, 실시간 채팅 전달 채널이다.

사용 예시:

- 한국어 자막 표시
- 영어 번역 자막 표시
- KOR/ENG 표시 언어 전환 결과 전달
- AI 실시간 피드백 표시
- 회의 참여자 간 실시간 채팅 표시

단, 회의 참여자 간 채팅은 `meetbowl-fe`가 송수신하며 `meetbowl-stt`는 채팅 내용을 생성하거나 저장하지 않는다.
- AI 실시간 피드백 표시

### Redis Stream

서버 내부 실시간 이벤트 흐름에 사용한다.

사용 예시:

- AI 피드백 입력용 finalized segment
- 회의 중 상태 이벤트
- 실시간 피드백 요청

### RabbitMQ

최종적으로 저장되어야 하는 Transcript 이벤트에 사용한다.

사용 예시:

- `transcript.final.created`
- `recording.completed`

---

## 4. 레이어 구조

`meetbowl-stt`는 다음 구조를 따른다.

```text
transport
  ↓
session service
  ↓
stt pipeline
  ↓
provider adapter
  ↓
event publisher
```

### transport

외부 요청 진입점이다.

예시:

- Internal REST API
- WebSocket
- LiveKit callback
- system event consumer

### session service

회의별 STT 세션 상태를 관리한다.

역할:

- STT 세션 시작
- STT 세션 종료
- 회의 ID와 LiveKit Room 매핑
- 참가자 audio track과 내부 pipeline 매핑
- Provider 연결 상태 관리
- 자막 표시 언어 관리

### stt pipeline

음성 스트림을 STT Provider에 전달하고 결과를 표준 Transcript 이벤트로 변환한다.

역할:

- audio frame 수신
- provider stream 전송
- Translation input/output delta 병합
- Meetbowl finalization 기준 적용
- timestamp 정규화
- 언어 코드 정규화

### provider adapter

STT Provider SDK 또는 API 연동을 담당한다.

Provider별 구현은 adapter 내부에 숨긴다.

### event publisher

Transcript와 AI 피드백 결과를 LiveKit DataChannel, Redis Stream, RabbitMQ로 발행한다.

---

## 5. 권장 모듈 구조

```text
src
  app
  livekit
  sessions
  stt
  providers
  events
  config
  utils
```

---

## 6. 데이터 접근 원칙

`meetbowl-stt`는 MariaDB에 직접 접근하지 않는다.

Final Transcript 저장은 다음 방식으로 처리한다.

```text
meetbowl-stt
  ↓ transcript.final.created event
RabbitMQ
  ↓
meetbowl-be
  ↓
MariaDB
```

필요한 회의 정보는 `meetbowl-be`의 internal API 또는 시작 이벤트 payload로 전달받는다.

---

## 7. Transcript 처리 원칙

Transcript는 두 종류로 구분한다.

### Interim / Partial Transcript

회의 중 실시간 자막 표시용이다.

특징:

- 빠르게 전달되어야 한다.
- 내용이 바뀔 수 있다.
- DB 저장 대상이 아니다.
- 사용자 화면 전달은 LiveKit DataChannel을 기본으로 한다.
- 서버 내부 AI 피드백 입력으로 발행하지 않는다.

### Final Transcript

회의 원문 저장과 AI 회의록 생성의 기준 데이터다.

특징:

- Meetbowl finalizer가 VAD silence, no delta timeout, translation grace time,
  max segment duration 또는 meeting 종료로 확정한 segment다.
- DB 저장 대상이다.
- RabbitMQ 이벤트로 `meetbowl-be`에 전달한다.
- AI 피드백 입력용 `meeting.feedback.segment.created` Redis Stream 이벤트의 기준 데이터다.
- 중복 저장 방지를 위한 idempotency key가 필요하다.

---

## 8. 실시간 STT / 자막 흐름

관련 요구사항:

```text
FR-129
FR-130
NFR-042
```

```text
LiveKit Room
  ↓ participant별 audio track
meetbowl-stt
  ├─ OpenAI Translation target=ko
  └─ OpenAI Translation target=en
  ↓ sourceText/koText/enText 병합
  ├─ LiveKit DataChannel: caption.updated
  ├─ RabbitMQ: transcript.final.created(finalized only)
  └─ Redis Stream: meeting.feedback.segment.created(finalized only)
```

KOR/ENG 버튼은 화면 표시 언어를 변경한다.

STT 원문 언어와 표시 언어는 분리한다.

---

## 9. Final Transcript 저장 흐름

관련 요구사항:

```text
FR-038
FR-039
```

```text
Meetbowl segment finalizer
  ↓ finalized segment
meetbowl-stt
  ↓ transcript.final.created event
RabbitMQ
  ↓
meetbowl-be
  ↓ save transcript
MariaDB
```

---

## 10. 실시간 피드백 입력 흐름

관련 요구사항:

```text
FR-037
FR-147
FR-148
FR-149
```

```text
meetbowl-stt
  ↓ meeting.feedback.segment.created(finalized segment)
Redis Stream
  ↓
meetbowl-ai
```

`meetbowl-stt`는 피드백을 생성하지 않는다.

피드백 생성은 `meetbowl-ai`가 담당한다.

AI 피드백 입력에는 Meetbowl finalizer가 확정한 segment만 사용한다. Interim/Partial
Transcript는 사용자 화면 자막 표시용이며 AI 피드백 입력으로 발행하지 않는다.
`meetbowl-stt`는 transcript window를 구성하지 않으며 `meetbowl-ai`가 meeting별
rolling buffer/window를 구성한다.

## 10.1 실시간 피드백 화면 전달 흐름

```text
meetbowl-ai
  ↓ meeting.feedback.generated
Redis Stream
  ↓
meetbowl-stt
  ↓ LiveKit DataChannel: feedback.generated
meetbowl-fe
```

`meetbowl-stt`는 피드백을 생성하지 않지만, AI 서버가 생성한 피드백 결과를 구독해 회의 참여자에게 LiveKit DataChannel로 전달한다.

---

## 11. 회의 종료 흐름

```text
LiveKit participant all left or meetbowl-be meeting end request
  ↓
meetbowl-stt stop session
  ↓ Translation session.close
  ↓ pending final transcript flush
  ↓ transcript.final.created events
  ↓ recording.completed event
RabbitMQ
  ↓
meetbowl-be
```

회의 종료 시점에는 Provider stream을 안전하게 닫고, 남은 final 결과를 최대한 발행해야 한다.

---

## 12. STT Provider 교체 원칙

Provider 교체를 쉽게 하기 위해 공통 interface를 둔다.

```text
TranslationProvider interface
  └─ OpenAiRealtimeTranslationProvider
```

Session Service는 특정 Provider SDK에 직접 의존하지 않는다.

---

## 13. 언어 및 번역 처리

STT 원문 언어와 표시 언어를 분리한다.

각 participant pipeline은 동일 audio를 한국어 target과 영어 target Translation
session에 전달한다.

```text
sourceLanguage=ko -> koText=sourceText, enText=영어 target 출력
sourceLanguage=en -> koText=한국어 target 출력, enText=sourceText
sourceLanguage=unknown -> koText=한국어 target 출력, enText=영어 target 출력
```

source transcript는 한국어 target session의 input transcript를 우선 사용하고 영어
target session의 input transcript를 fallback으로 사용한다.

## 14. 메모리 및 화자 식별 원칙

- participant identity와 track SID는 내부 pipeline 구분에만 사용한다.
- 화자 식별자와 이름을 DataChannel, RabbitMQ, Redis Stream payload에 포함하지 않는다.
- speaker별 active segment, sequence counter, 연결 상태만 메모리에 유지한다.
- 회의 전체 원문, finalized segment 전체 목록, AI 피드백 window를 보관하지 않는다.

---

## 15. 장애 처리 원칙

STT Provider 오류 발생 시 다음을 수행한다.

- 세션 상태를 FAILED 또는 DEGRADED로 변경
- 오류 이벤트 발행
- `meetbowl-be`에 상태 전달
- 사용자에게 자막 지연 또는 중단 상태를 표시할 수 있게 함

오류가 발생해도 회의 자체가 중단되어서는 안 된다.

---

## 16. 금지 사항

- MariaDB 직접 접근 금지
- Interim/Partial Transcript DB 저장 금지
- Provider SDK 호출을 여러 레이어에 분산 금지
- STT Final 이벤트 payload 임의 변경 금지
- 회의 권한을 `meetbowl-stt` 단독으로 최종 판단 금지
- `meetbowl-stt`의 회의 채팅 내용 저장 금지
- 장기 보관 데이터를 Redis Stream에 의존 금지
- LiveKit Room 전체 mixed audio 처리 금지
- 화자 식별자를 외부 자막/메시지 계약에 노출 금지
- AI 피드백용 rolling window 구성 금지
