import { JobContext, TriggerContext } from "@devvit/public-api";
import { subDays, subHours } from "date-fns";
import json2md from "json2md";
import { AppealTrackedOutcome } from "../modmail/appealOutcomeTracking.js";

const TRACKED_APPEAL_OUTCOME_STATISTICS_KEY = "trackedAppealOutcomeStatistics";
const TRACKED_APPEAL_OUTCOME_METADATA_KEY = "trackedAppealOutcomeMetadata";
const TRACKED_APPEAL_OUTCOME_RETENTION_DAYS = 31;

export interface TrackedAppealOutcomeEvent {
    conversationId: string;
    outcome: AppealTrackedOutcome;
    configName: string;
}

interface TrackedAppealOutcomeWindow {
    label: string;
    since: Date;
}

export interface TrackedAppealOutcomeSummary {
    label: string;
    automaticGrants: number;
    automaticDenials: number;
    byConfig: Record<string, Record<AppealTrackedOutcome, number>>;
}

export interface StoredTrackedAppealOutcomeEntry {
    score: number;
    metadata: string | undefined;
}

function getTrackedAppealOutcomeMember (conversationId: string, outcome: AppealTrackedOutcome): string {
    return `${conversationId}:${outcome}`;
}

export async function markTrackedAppealOutcome (
    outcome: AppealTrackedOutcome,
    configName: string,
    conversationId: string,
    context: TriggerContext | JobContext,
    now = new Date(),
): Promise<boolean> {
    const member = getTrackedAppealOutcomeMember(conversationId, outcome);
    const event: TrackedAppealOutcomeEvent = {
        conversationId,
        outcome,
        configName,
    };
    const stored = await context.redis.hSetNX(
        TRACKED_APPEAL_OUTCOME_METADATA_KEY,
        member,
        JSON.stringify(event),
    );
    if (!stored) {
        return false;
    }

    try {
        await context.redis.zAdd(TRACKED_APPEAL_OUTCOME_STATISTICS_KEY, {
            member,
            score: now.getTime(),
        });
    } catch (error) {
        await context.redis.hDel(TRACKED_APPEAL_OUTCOME_METADATA_KEY, [member]);
        throw error;
    }

    return true;
}

export async function cleanupTrackedAppealOutcomeStatistics (
    context: JobContext,
    now = new Date(),
): Promise<void> {
    const cutoff = subDays(now, TRACKED_APPEAL_OUTCOME_RETENTION_DAYS).getTime();
    const expiredEntries = await context.redis.zRange(
        TRACKED_APPEAL_OUTCOME_STATISTICS_KEY,
        0,
        cutoff,
        { by: "score" },
    );

    if (expiredEntries.length === 0) {
        return;
    }

    await context.redis.zRemRangeByScore(TRACKED_APPEAL_OUTCOME_STATISTICS_KEY, 0, cutoff);
    await context.redis.hDel(
        TRACKED_APPEAL_OUTCOME_METADATA_KEY,
        expiredEntries.map(entry => entry.member),
    );
}

export function parseTrackedAppealOutcomeEvent (metadata: string | undefined): TrackedAppealOutcomeEvent | undefined {
    if (!metadata) {
        return;
    }

    try {
        const parsed = JSON.parse(metadata) as Partial<TrackedAppealOutcomeEvent>;
        if (
            !parsed.conversationId
            || !parsed.configName
            || !parsed.outcome
            || !Object.values(AppealTrackedOutcome).includes(parsed.outcome)
        ) {
            return;
        }

        return {
            conversationId: parsed.conversationId,
            outcome: parsed.outcome,
            configName: parsed.configName,
        };
    } catch {
        return;
    }
}

export function summarizeTrackedAppealOutcomeEntries (
    entries: StoredTrackedAppealOutcomeEntry[],
    now = new Date(),
): TrackedAppealOutcomeSummary[] {
    const windows: TrackedAppealOutcomeWindow[] = [
        { label: "Past 24 hours", since: subHours(now, 24) },
        { label: "Past 7 days", since: subDays(now, 7) },
        { label: "Past 30 days", since: subDays(now, 30) },
    ];

    const summaries: TrackedAppealOutcomeSummary[] = windows.map(window => ({
        label: window.label,
        automaticGrants: 0,
        automaticDenials: 0,
        byConfig: {},
    }));

    for (const entry of entries) {
        const event = parseTrackedAppealOutcomeEvent(entry.metadata);
        if (!event) {
            continue;
        }

        for (let i = 0; i < windows.length; i++) {
            if (entry.score < windows[i].since.getTime() || entry.score > now.getTime()) {
                continue;
            }

            const summary = summaries[i];
            if (event.outcome === AppealTrackedOutcome.AutomaticGrant) {
                summary.automaticGrants++;
            } else {
                summary.automaticDenials++;
            }

            summary.byConfig[event.configName] ??= {
                [AppealTrackedOutcome.AutomaticGrant]: 0,
                [AppealTrackedOutcome.AutomaticDenial]: 0,
            };
            summary.byConfig[event.configName][event.outcome]++;
        }
    }

    return summaries;
}

export async function getTrackedAppealOutcomeSummaries (
    context: JobContext,
    now = new Date(),
): Promise<TrackedAppealOutcomeSummary[]> {
    const entries = await context.redis.zRange(
        TRACKED_APPEAL_OUTCOME_STATISTICS_KEY,
        subDays(now, 30).getTime(),
        now.getTime(),
        { by: "score" },
    );
    const metadata = await context.redis.hMGet(
        TRACKED_APPEAL_OUTCOME_METADATA_KEY,
        entries.map(entry => entry.member),
    );

    return summarizeTrackedAppealOutcomeEntries(
        entries.map((entry, index) => ({
            score: entry.score,
            metadata: metadata[index] ?? undefined,
        })),
        now,
    );
}

export function formatAppealConfigNameForTable (configName: string): string {
    return configName.replaceAll("|", "¦").replace(/\r?\n/g, " ");
}

function formatOutcome (outcome: AppealTrackedOutcome): string {
    switch (outcome) {
        case AppealTrackedOutcome.AutomaticGrant:
            return "Automatic grant";
        case AppealTrackedOutcome.AutomaticDenial:
            return "Automatic denial";
    }
}

export async function pushTrackedAppealOutcomeStatistics (
    wikiContent: json2md.DataObject[],
    context: JobContext,
): Promise<void> {
    const now = new Date();
    await cleanupTrackedAppealOutcomeStatistics(context, now);
    const summaries = await getTrackedAppealOutcomeSummaries(context, now);

    wikiContent.push({ h2: "Automatically resolved appeal outcomes" });
    wikiContent.push({
        p: "These statistics count tracked appeal configs only after the public reply is sent, the conversation is archived, and the active appeal marker is cleared.",
    });

    wikiContent.push({
        table: {
            headers: ["Window", "Automatic grants", "Automatic denials", "Total automatically resolved"],
            rows: summaries.map(summary => [
                summary.label,
                summary.automaticGrants.toLocaleString(),
                summary.automaticDenials.toLocaleString(),
                (summary.automaticGrants + summary.automaticDenials).toLocaleString(),
            ]),
        },
    });

    const configRows = summaries.flatMap(summary => Object.entries(summary.byConfig).flatMap(([configName, outcomeCounts]) => [
        [
            summary.label,
            formatOutcome(AppealTrackedOutcome.AutomaticGrant),
            formatAppealConfigNameForTable(configName),
            outcomeCounts[AppealTrackedOutcome.AutomaticGrant].toLocaleString(),
        ],
        [
            summary.label,
            formatOutcome(AppealTrackedOutcome.AutomaticDenial),
            formatAppealConfigNameForTable(configName),
            outcomeCounts[AppealTrackedOutcome.AutomaticDenial].toLocaleString(),
        ],
    ])).filter(([, , , count]) => count !== "0");

    if (configRows.length > 0) {
        wikiContent.push({ h3: "Automatically resolved outcomes by appeal config" });
        wikiContent.push({
            table: {
                headers: ["Window", "Outcome", "Appeal config", "Count"],
                rows: configRows,
            },
        });
    }
}
