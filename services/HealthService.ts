import { Context, Duration, Effect, Fiber, Layer, Ref } from "effect";
import { BufferHealth, BufferService } from "./BufferService";
import { PlaybackService } from "./PlaybackService";
import { SchedulerService } from "./SchedulerService";
import { AppConfig } from "../config";
import { addBreadcrumb, captureException } from "../utils/sentry";

export class HealthService extends Context.Tag("HealthService")<
  HealthService,
  {
    readonly start: () => Effect.Effect<void>;
    readonly stop: () => Effect.Effect<void>;
  }
>() {}

export const HealthServiceLive = Layer.effect(
  HealthService,
  Effect.gen(function* () {
    const buffer = yield* BufferService;
    const playback = yield* PlaybackService;
    const scheduler = yield* SchedulerService;

    const port = yield* AppConfig.HealthPort;

    const thresholdRef = yield* Ref.make({ armed: false });
    const serverRef = yield* Ref.make<ReturnType<typeof Bun.serve> | null>(
      null
    );
    const monitorRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);

    const updateThresholds = Effect.fn("health.updateThresholds")(function* (
      health: BufferHealth,
      state: string,
      nextRebuild: Date
    ) {
      const action = yield* Ref.modify(thresholdRef, (threshold) => {
        if (health.percentage >= 80) {
          if (!threshold.armed) {
            return ["armed" as const, { armed: true }];
          }
          return ["noop" as const, threshold];
        }

        if (threshold.armed && health.percentage < 20) {
          return ["alert" as const, { armed: false }];
        }

        return ["noop" as const, threshold];
      });

      if (action === "armed") {
        yield* addBreadcrumb({
          category: "buffer",
          message: "Buffer healthy threshold reached",
          level: "info",
          data: { percentage: health.percentage },
        });
      }

      if (action === "alert") {
        yield* addBreadcrumb({
          category: "buffer",
          message: "Buffer health dropped below threshold",
          level: "error",
          data: { percentage: health.percentage },
        });
        yield* captureException(
          new Error("Buffer health dropped below 20% after being healthy"),
          {
            tags: { component: "health", event: "buffer_threshold" },
            extra: {
              percentage: health.percentage,
              currentSize: health.currentSize,
              targetSize: health.targetSize,
              durationMinutes: health.durationMinutes,
              playbackState: state,
              nextRebuild: nextRebuild.toISOString(),
            },
          }
        );
      }
    });

    const getHealth = Effect.gen(function* () {
      const health = yield* buffer.getHealth();
      const state = yield* playback.getState();
      const nextRebuild = yield* scheduler.getNextRebuildTime();

      yield* updateThresholds(health, state, nextRebuild);

      return {
        status: health.isHealthy
          ? "healthy"
          : health.percentage >= 30
          ? "degraded"
          : "unhealthy",
        buffer: {
          sizeMB: Math.round((health.currentSize / 1024 / 1024) * 100) / 100,
          targetMB: Math.round((health.targetSize / 1024 / 1024) * 100) / 100,
          percentage: health.percentage,
          minutes: health.durationMinutes,
        },
        playback: state,
        nextRebuild: nextRebuild.toISOString(),
      };
    });

    const monitorLoop = Effect.gen(function* () {
      while (true) {
        yield* getHealth;
        yield* Effect.sleep(Duration.seconds(30));
      }
    });

    const start = () =>
      Effect.gen(function* () {
        if (yield* Ref.get(serverRef)) return;

        const server = Bun.serve({
          port,
          fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname !== "/" && url.pathname !== "/health") {
              return new Response("Not Found", { status: 404 });
            }

            return Effect.runPromise(
              getHealth.pipe(
                Effect.map(
                  (h) =>
                    new Response(JSON.stringify(h, null, 2), {
                      headers: { "Content-Type": "application/json" },
                      status: h.status === "unhealthy" ? 503 : 200,
                    })
                ),
                Effect.catchAll((e) =>
                  captureException(e, {
                    tags: { component: "health", event: "handler_error" },
                  }).pipe(
                    Effect.zipRight(
                      Effect.succeed(
                        new Response(
                          JSON.stringify(
                            {
                              status: "unhealthy",
                              error: e instanceof Error ? e.message : String(e),
                            },
                            null,
                            2
                          ),
                          {
                            headers: { "Content-Type": "application/json" },
                            status: 503,
                          }
                        )
                      )
                    )
                  )
                )
              )
            );
          },
        });

        yield* Ref.set(serverRef, server);

        if (!(yield* Ref.get(monitorRef))) {
          const fiber = yield* Effect.fork(monitorLoop);
          yield* Ref.set(monitorRef, fiber);
        }

        yield* Effect.log(`Health: http://localhost:${port}/health`);
      });

    const stop = () =>
      Effect.gen(function* () {
        const server = yield* Ref.get(serverRef);
        if (server) {
          server.stop();
          yield* Ref.set(serverRef, null);
        }

        const monitor = yield* Ref.get(monitorRef);
        if (monitor) {
          yield* Fiber.interrupt(monitor);
          yield* Ref.set(monitorRef, null);
        }
      });

    return { start, stop };
  })
);
