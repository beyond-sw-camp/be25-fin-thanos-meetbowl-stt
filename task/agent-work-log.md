## 2026-06-22 현재 회의 피드백 UI fixture 추가

- 목적: 브라우저에서 접속 중인 실제 회의에 `meeting.feedback.generated` fixture를 전달해 피드백 패널을 검증한다.
- 변경 근거: 기존 `probe:livekit-feedback`는 임의 회의와 자체 참가자를 생성하므로 현재 브라우저 UI를 대상으로 사용할 수 없었다.
- 변경 파일: `scripts/publish-feedback-ui-fixture.mjs`, `package.json`, `README.md`
- 변경 동작: meeting ID와 인증 사용자 LiveKit identity를 인자로 받아 기존 STT 세션을 확인하고, Redis 결과 Stream에 계약을 만족하는 테스트 이벤트를 발행한다.
- 제외 범위: AI 분석, Qdrant 검색 및 회의록 색인은 우회한다. 해당 전체 흐름은 기존 `probe:livekit-feedback`로 검증한다.
- 검증: `npm run build`, `node --check scripts/publish-feedback-ui-fixture.mjs`, `git diff --check` 통과. STT `/api/v1/health` 200 응답 확인.
- 후속 수정: 로컬에 Redis `6379`와 `6381`이 동시에 실행될 수 있으므로 UI fixture 명령에서 포트 강제를 제거했다. 실행 중 STT와 동일한 `.env`의 `REDIS_URL`을 사용해야 한다.
