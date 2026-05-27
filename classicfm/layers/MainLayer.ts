import { Layer } from "effect";
import { BufferServiceLive } from "../services/BufferService";
import { StreamServiceLive } from "../services/StreamService";
import { PlaybackServiceLive } from "../services/PlaybackService";
import { SchedulerServiceLive } from "../services/SchedulerService";
import { HealthServiceLive } from "../services/HealthService";

const Base = Layer.merge(BufferServiceLive, StreamServiceLive);
const Playback = Layer.provideMerge(Base)(PlaybackServiceLive);
const Scheduler = Layer.provideMerge(Playback)(SchedulerServiceLive);
const Health = Layer.provideMerge(Scheduler)(HealthServiceLive);

export const MainLayer = Health;
