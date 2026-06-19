/**
 * STT 서버의 엔트리 포인트(Entry Point)입니다.
 * 환경 설정을 로드하고, 애플리케이션 엔진(AppRuntime) 및 웹 서버(Fastify)를 구동합니다.
 */
import { loadEnvFile } from "node:process";

import { AppRuntime } from "./app-runtime.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

try {
  /**
   * Node.js 표준 환경 변수 파일(.env)을 로드합니다.
   * 파일이 존재하지 않는 경우(ENOENT)를 제외한 나머지 구문 오류 등은 예외로 처리합니다.
   */
  loadEnvFile();
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

/**
 * 환경 변수 스키마를 검증하고 설정 객체(AppConfig)를 생성합니다.
 * 필수 설정값이 누락된 경우 서버 실행을 즉시 중단합니다.
 */
const config = loadConfig();

/**
 * 애플리케이션 부트스트랩(Bootstrap) 단계입니다.
 * 런타임 엔진에 필요한 로거(Logger)를 확보하기 위해 임시 앱 인스턴스를 생성하고 닫습니다.
 */
const bootstrapApp = createApp();
const runtime = new AppRuntime(config, bootstrapApp.log);
await bootstrapApp.close();

/**
 * 실제 요청을 처리할 메인 애플리케이션 인스턴스를 생성합니다.
 * 조립된 AppRuntime을 주입하여 각 라우트에서 비즈니스 로직에 접근할 수 있게 합니다.
 */
const app = createApp({ runtime });

try {
  /**
   * [비동기 시작 프로세스]
   * 1. runtime.start(): RabbitMQ, Redis 등 외부 브로커와의 연결을 비동기로 수립합니다.
   * 2. onClose Hook: 서버가 정상 종료될 때 리소스를 안전하게 해제하도록 등록합니다.
   * 3. app.listen(): 지정된 호스트와 포트에서 HTTP 요청 대기를 시작합니다.
   */
  await runtime.start();
  
  app.addHook("onClose", async () => {
    // 서버 종료 시 진행 중인 모든 STT 세션 및 연결을 정리합니다.
    await runtime.close();
  });

  // 서버 바인딩 및 수신 시작
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  /**
   * 서버 구동 중 치명적인 오류 발생 시 로그를 남기고 프로세스를 종료합니다.
   * (예: 포트 충돌, 외부 브로커 연결 실패 등)
   */
  app.log.error(error);
  await runtime.close();
  process.exit(1);
}
