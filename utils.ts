import { Effect } from "effect";

export const nextHourInfo = Effect.fn("nextHourInfo")(function* (hour: number) {
  const now = new Date();
  const target = new Date(now);

  target.setHours(hour, 0, 0, 0);

  if (target <= now) target.setDate(target.getDate() + 1);

  const ms = target.getTime() - now.getTime();
  const at = new Date(Date.now() + ms);

  return { ms, at };
});
