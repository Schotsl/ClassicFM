import * as Sentry from "@sentry/bun";
import type { Scope } from "@sentry/bun";
import { Effect } from "effect";

export type SentryLevel = Exclude<Parameters<typeof Sentry.captureMessage>[1], undefined>;

export type SentryContext = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
};

let initialized = false;

export const initSentryOnce = () => {
  if (initialized) return;
  initialized = true;

  Sentry.init({
    dsn: "https://12dcb7991e48499ff5c9c1741e448d9f@o4505897577414656.ingest.us.sentry.io/4510685903716352",
    environment: process.env.NODE_ENV ?? "development",
  });

  Sentry.setTag("service", "classicfm-buffer");
  Sentry.setTag("runtime", "bun");
};

const applyContext = (scope: Scope, context?: SentryContext) => {
  if (!context) return;
  if (context.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      scope.setTag(key, value);
    }
  }
  if (context.extra) {
    scope.setExtras(context.extra);
  }
  if (context.contexts) {
    for (const [name, value] of Object.entries(context.contexts)) {
      scope.setContext(name, value);
    }
  }
};

export const captureExceptionSync = (error: unknown, context?: SentryContext) => {
  initSentryOnce();
  Sentry.withScope((scope) => {
    applyContext(scope, context);
    Sentry.captureException(error);
  });
};

export const captureMessageSync = (
  message: string,
  level: SentryLevel = "info",
  context?: SentryContext,
) => {
  initSentryOnce();
  Sentry.withScope((scope) => {
    applyContext(scope, context);
    Sentry.captureMessage(message, level);
  });
};

export const initSentry = Effect.fn("sentry.init")(() => Effect.sync(initSentryOnce));

export const captureException = Effect.fn("sentry.captureException")(
  (error: unknown, context?: SentryContext) =>
    Effect.sync(() => {
      captureExceptionSync(error, context);
    }),
);

export const captureMessage = Effect.fn("sentry.captureMessage")(
  (message: string, level: SentryLevel = "info", context?: SentryContext) =>
    Effect.sync(() => {
      captureMessageSync(message, level, context);
    }),
);

export const addBreadcrumb = Effect.fn("sentry.addBreadcrumb")(
  (breadcrumb: Parameters<typeof Sentry.addBreadcrumb>[0]) =>
    Effect.sync(() => {
      initSentryOnce();
      Sentry.addBreadcrumb(breadcrumb);
    }),
);

export const flushSentry = Effect.fn("sentry.flush")(function* (timeoutMs = 2000) {
  initSentryOnce();
  yield* Effect.tryPromise({
    try: () => Sentry.flush(timeoutMs),
    catch: (e) => new Error(`Sentry flush failed: ${e}`),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );
});
