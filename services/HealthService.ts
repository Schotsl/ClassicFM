import { Context, Effect, Layer, Ref } from "effect";
import { BufferService } from "./BufferService";
import { PlaybackService } from "./PlaybackService";
import { SchedulerService } from "./SchedulerService";
import { AppConfig } from "../config";

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

    const serverRef = yield* Ref.make<ReturnType<typeof Bun.serve> | null>(
      null
    );

    const getHealth = Effect.gen(function* () {
      const health = yield* buffer.getHealth();
      const state = yield* playback.getState();
      const nextRebuild = yield* scheduler.getNextRebuildTime();

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

    const start = () =>
      Effect.gen(function* () {
        if (yield* Ref.get(serverRef)) return;

        const server = Bun.serve({
          port,
          fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname !== "/") {
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
            );
          },
        });

        yield* Ref.set(serverRef, server);
        yield* Effect.log(`Health: http://localhost:${port}/`);
      });

    const stop = () =>
      Ref.get(serverRef).pipe(
        Effect.tap((s) => (s ? Effect.sync(() => s.stop()) : Effect.void)),
        Effect.tap(() => Ref.set(serverRef, null))
      );

    return { start, stop };
  })
);
