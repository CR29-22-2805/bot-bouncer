import {
    buildCountOnlyActionSummary,
    buildCumulativeStatsSummary,
    buildDigestSummaryComment,
} from "./actionSummary.js";

test("buildCountOnlyActionSummary uses singular grammar", () => {
    expect(buildCountOnlyActionSummary(
        "banned",
        1,
        "ExampleSub",
        "during the past 24 hours",
    )).toBe("1 user was banned by Bot Bouncer on /r/ExampleSub during the past 24 hours.");
});

test("buildCountOnlyActionSummary uses plural grammar", () => {
    expect(buildCountOnlyActionSummary(
        "unbanned",
        3,
        "ExampleSub",
        "during the past week",
    )).toBe("3 users were unbanned by Bot Bouncer on /r/ExampleSub during the past week.");
});

test("buildCumulativeStatsSummary describes upgrade-based tracking limits", () => {
    const result = buildCumulativeStatsSummary(
        {
            banCount: 10,
            unbanCount: 3,
            startDate: new Date(2026, 6, 1, 12, 0, 0),
            startReason: "upgrade",
        },
        true,
        true,
    );

    expect(result).toBe("Cumulative total: 10 bans and 3 unbans since Bot Bouncer began tracking cumulative summary stats for this subreddit on 2026-07-01 after the app was updated. Earlier actions are not included.");
});

test("buildDigestSummaryComment does not claim that a full account list was included when counts are used", () => {
    const result = buildDigestSummaryComment(
        "ExampleSub",
        "during the past 24 hours",
        {
            reported: 2,
            banned: 3,
            unbanned: 1,
        },
        {
            fullAccountListIncluded: false,
        },
    );

    expect(result).toBe("Digest summary for /r/ExampleSub during the past 24 hours: 2 reported; 3 banned; 1 unbanned. See the previous message for details.");
});
