import { TriggerContext } from "@devvit/public-api";
import { AppealTrackedOutcome } from "../modmail/appealOutcomeTracking.js";
import {
    formatAppealConfigNameForTable,
    markTrackedAppealOutcome,
    parseTrackedAppealOutcomeEvent,
    summarizeTrackedAppealOutcomeEntries,
} from "./appealOutcomeStatistics.js";

function eventMetadata (
    conversationId: string,
    outcome: AppealTrackedOutcome,
    configName: string,
): string {
    return JSON.stringify({ conversationId, outcome, configName });
}

test("summarizes one 30-day read into all configured windows", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    const summaries = summarizeTrackedAppealOutcomeEntries([
        {
            score: now.getTime() - hour,
            metadata: eventMetadata("conversation-1", AppealTrackedOutcome.AutomaticGrant, "Grant rule"),
        },
        {
            score: now.getTime() - (2 * day),
            metadata: eventMetadata("conversation-2", AppealTrackedOutcome.AutomaticDenial, "Denial rule"),
        },
        {
            score: now.getTime() - (10 * day),
            metadata: eventMetadata("conversation-3", AppealTrackedOutcome.AutomaticDenial, "Denial rule"),
        },
        {
            score: now.getTime() - (31 * day),
            metadata: eventMetadata("conversation-4", AppealTrackedOutcome.AutomaticGrant, "Old grant rule"),
        },
    ], now);

    expect(summaries.map(summary => ({
        label: summary.label,
        grants: summary.automaticGrants,
        denials: summary.automaticDenials,
    }))).toEqual([
        { label: "Past 24 hours", grants: 1, denials: 0 },
        { label: "Past 7 days", grants: 1, denials: 1 },
        { label: "Past 30 days", grants: 1, denials: 2 },
    ]);

    expect(summaries[2].byConfig["Denial rule"][AppealTrackedOutcome.AutomaticDenial]).toBe(2);
});

test("ignores malformed or incomplete outcome metadata", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const summaries = summarizeTrackedAppealOutcomeEntries([
        { score: now.getTime(), metadata: "not-json" },
        { score: now.getTime(), metadata: JSON.stringify({ outcome: AppealTrackedOutcome.AutomaticGrant }) },
        { score: now.getTime(), metadata: undefined },
    ], now);

    expect(summaries.every(summary => summary.automaticGrants === 0 && summary.automaticDenials === 0)).toBe(true);
    expect(parseTrackedAppealOutcomeEvent("not-json")).toBeUndefined();
});

test("stores at most one event for each conversation and outcome", async () => {
    const scores = new Map<string, number>();
    const metadata = new Map<string, string>();
    const redis = {
        hSetNX: vi.fn((_key: string, member: string, value: string) => {
            if (metadata.has(member)) {
                return false;
            }
            metadata.set(member, value);
            return true;
        }),
        hDel: vi.fn((_key: string, members: string[]) => {
            members.forEach(member => metadata.delete(member));
        }),
        zAdd: vi.fn((_key: string, entry: { member: string; score: number }) => {
            scores.set(entry.member, entry.score);
        }),
    };
    const context = { redis } as unknown as TriggerContext;
    const now = new Date("2026-07-12T12:00:00.000Z");

    const first = await markTrackedAppealOutcome(
        AppealTrackedOutcome.AutomaticDenial,
        "Denial rule",
        "conversation-1",
        context,
        now,
    );
    const second = await markTrackedAppealOutcome(
        AppealTrackedOutcome.AutomaticDenial,
        "Denial rule",
        "conversation-1",
        context,
        new Date(now.getTime() + 1000),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(redis.zAdd).toHaveBeenCalledTimes(1);
    expect(metadata.size).toBe(1);
});

test("sanitizes appeal config names for Reddit markdown tables", () => {
    expect(formatAppealConfigNameForTable("First | rule\nsecond line")).toBe("First ¦ rule second line");
});
