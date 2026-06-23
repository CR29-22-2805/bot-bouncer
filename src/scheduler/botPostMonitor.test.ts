import { BOT_POST_MONITOR_THRESHOLD_MINUTES, getBotPostFreshness } from "./botPostMonitor.js";
import { CONTROL_SUBREDDIT } from "../constants.js";

function post (createdAt: Date, overrides = {}) {
    return {
        authorName: "bot-bouncer",
        createdAt,
        id: "t3_test",
        subredditName: CONTROL_SUBREDDIT,
        ...overrides,
    };
}

test("bot post freshness is fresh when latest control sub post is newer than threshold", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness([
        post(new Date("2026-06-23T14:56:00Z")),
    ], "bot-bouncer", now);

    expect(result.stale).toBe(false);
    expect(result.minutesSinceLatestPost).toBe(BOT_POST_MONITOR_THRESHOLD_MINUTES - 1);
});

test("bot post freshness is stale when latest control sub post is at threshold", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness([
        post(new Date("2026-06-23T14:55:00Z")),
    ], "bot-bouncer", now);

    expect(result.stale).toBe(true);
    expect(result.minutesSinceLatestPost).toBe(BOT_POST_MONITOR_THRESHOLD_MINUTES);
});

test("bot post freshness ignores posts outside the control subreddit", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness([
        post(new Date("2026-06-23T14:59:00Z"), { subredditName: "SomeClientSub" }),
        post(new Date("2026-06-23T14:50:00Z")),
    ], "bot-bouncer", now);

    expect(result.stale).toBe(true);
    expect(result.minutesSinceLatestPost).toBe(10);
});

test("bot post freshness is stale when no bot post is found", () => {
    const result = getBotPostFreshness([
        post(new Date("2026-06-23T14:59:00Z"), { authorName: "other-user" }),
    ], "bot-bouncer", new Date("2026-06-23T15:00:00Z"));

    expect(result.stale).toBe(true);
    expect(result.latestPost).toBeUndefined();
});
