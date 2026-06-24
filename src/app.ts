/**
 * Fastify 프레임워크를 기반으로 한 웹 애플리케이션 인스턴스 생성 및 설정 파일입니다.
 * 미들웨어 등록, 플러그인 구성 및 라우팅 경로를 정의합니다.
 */
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppRuntime } from "./app-runtime.js";
import { apiV1Routes } from "./routes/api-v1.js";

export interface CreateAppOptions {
  /** 비즈니스 로직 및 인프라 의존성을 관리하는 런타임 엔진입니다. */
  runtime?: AppRuntime;
}

/**
 * Fastify 서버 인스턴스를 초기화하고 설정을 적용합니다.
 * @param options - 런타임 엔진을 포함한 초기화 옵션
 * @returns 구성이 완료된 FastifyInstance 객체
 */
export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  /**
   * Fastify 인스턴스를 생성합니다.
   * 기본적으로 서버 측 로깅을 활성화하여 요청/응답 및 에러 상태를 기록합니다.
   */
  const app = Fastify({
    logger: true
  });

  /**
   * [플러그인 등록]
   * @fastify/websocket: 실시간 양방향 통신 기능을 제공합니다.
   * 헬스 체크나 실시간 상태 모니터링 등에 활용될 수 있습니다.
   */
  void app.register(websocket);

  /**
   * [라우트 등록]
   * apiV1Routes: '/api/v1' 프리픽스를 가진 모든 REST API 경로를 등록합니다.
   * options.runtime을 통해 도메인 서비스(SttSessionService) 등을 하위 라우트로 전달합니다.
   */
  void app.register(apiV1Routes, {
    prefix: "/api/v1",
    runtime: options.runtime
  });

  return app;
}
