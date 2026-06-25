## 2026-06-22 현재 회의 피드백 UI fixture 추가

- 목적: 브라우저에서 접속 중인 실제 회의에 `meeting.feedback.generated` fixture를 전달해 피드백 패널을 검증한다.
- 변경 근거: 기존 `probe:livekit-feedback`는 임의 회의와 자체 참가자를 생성하므로 현재 브라우저 UI를 대상으로 사용할 수 없었다.
- 변경 파일: `scripts/publish-feedback-ui-fixture.mjs`, `package.json`, `README.md`
- 변경 동작: meeting ID와 인증 사용자 LiveKit identity를 인자로 받아 기존 STT 세션을 확인하고, Redis 결과 Stream에 계약을 만족하는 테스트 이벤트를 발행한다.
- 제외 범위: AI 분석, Qdrant 검색 및 회의록 색인은 우회한다. 해당 전체 흐름은 기존 `probe:livekit-feedback`로 검증한다.
- 검증: `npm run build`, `node --check scripts/publish-feedback-ui-fixture.mjs`, `git diff --check` 통과. STT `/api/v1/health` 200 응답 확인.
- 후속 수정: 로컬에 Redis `6379`와 `6381`이 동시에 실행될 수 있으므로 UI fixture 명령에서 포트 강제를 제거했다. 실행 중 STT와 동일한 `.env`의 `REDIS_URL`을 사용해야 한다.

## 2026-06-25 LiveKit 참가자 수집 재동기화 강화

- 목적: 실시간 피드백이 일부 참석자에게만 전달되는 문제를 줄이기 위해 STT 세션의 인증 참가자 수집을 현재 Room 상태 기준으로 다시 맞춘다.
- 변경 근거: 기존 구현은 `ParticipantConnected`/`TrackSubscribed` 이벤트 누적에 의존해 재연결이나 이벤트 유실 뒤 registry가 일부 사용자만 남을 수 있었다.
- 변경 파일: `src/livekit/livekit-participant-registry.ts`, `src/livekit/livekit-meeting-session.ts`, `test/livekit-participant-registry.test.ts`
- 변경 동작: Room 연결 직후, 재연결 직후, finalized segment participant snapshot 직전, 피드백 전달 직전에 현재 `remoteParticipants` 집합으로 registry를 다시 구성한다. 연결이 불안정할 때는 빈 스냅샷으로 덮어쓰지 않고 마지막 정상 registry를 유지한다.
- 관측성: 피드백 전달 시 `audienceCount`, `destinationCount`, `excludedAudienceCount`, `authenticatedParticipantCount`를 로그에 남겨 누락 구간을 바로 추적할 수 있게 한다.
