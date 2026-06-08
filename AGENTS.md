# Meetbowl STT Server AGENTS

## 목적

본 문서는 `meetbowl-stt`에서 작업하는 모든 개발자와 AI Agent가 반드시 따라야 하는 규칙을 정의한다.

---

## 필수 문서

작업 전 반드시 아래 문서를 읽는다.

```text
../AGENTS.md
../docs/architecture.md
../docs/conventions.md
../docs/event-contract.md
../docs/communication-decision.md
docs/architecture.md
docs/conventions.md
docs/api-spec.md
```

---

## 역할

`meetbowl-stt`는 실시간 음성 처리 서버이다.

담당 기능:

- LiveKit 연동
- 음성 수집
- STT 처리
- 실시간 자막 생성
- KOR/ENG 자막 표시 언어 전환
- Final Transcript 생성
- 실시간 피드백 입력 이벤트 발행
- AI 피드백 결과 구독 및 LiveKit DataChannel 전달

---

## 데이터 소유권

`meetbowl-stt`는 업무 데이터를 저장하지 않는다.

허용:

```text
Redis
Memory Cache
Object Storage recording write
```

금지:

```text
MariaDB 직접 접근
Qdrant 접근
회의 저장
회의록 저장
메일 저장
```

---

## STT 규칙

Interim / Partial Transcript:

- DB 저장 금지
- 화면 표시용
- 사용자 화면 자막 전달은 LiveKit DataChannel을 기본으로 사용
- 서버 내부 AI 피드백 입력으로 사용하지 않음

Final Transcript:

- RabbitMQ 이벤트 발행 가능
- 저장 요청 이벤트는 `transcript.final.created`를 사용
- 영구 저장은 `meetbowl-be` 담당
- AI 피드백 입력은 Final Transcript 기반 `meeting.feedback.requested` Redis Stream 이벤트를 사용

---

## Provider 규칙

STT Provider 추상화를 사용한다.

허용:

```text
Deepgram
Clova
AssemblyAI
Tiro
Whisper API
```

Provider SDK 호출은 adapter 내부에 숨긴다.

---

## 이벤트 규칙

이벤트 이름과 payload는 루트 `docs/event-contract.md`를 따른다.

발행:

```text
transcript.final.created
recording.completed
meeting.feedback.requested
```

구독:

```text
meeting.feedback.generated
```

임의 이벤트 추가 금지.

---

## 금지 사항

- 회의록 생성
- 챗봇 구현
- 임베딩 생성
- Qdrant 접근
- MariaDB 접근
- 회의 채팅 내용 저장
- Interim Transcript DB 저장
- 회의 권한 최종 판단

---

## 구현 원칙

- Audio는 스트리밍 처리한다.
- 파일 전체 메모리 로딩을 금지한다.
- 실시간 처리 성능을 우선한다.
- Provider 장애가 발생해도 회의 자체가 중단되면 안 된다.
