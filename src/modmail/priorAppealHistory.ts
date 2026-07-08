import type { TriggerContext } from "@devvit/public-api";
import { addDays } from "date-fns";
import json2md from "json2md";
import { UserStatus } from "../dataStore.js";
import type { UserDetails } from "../dataStore.js";
import { getControlSubSettings } from "../settings.js";
import type { ControlSubSettings } from "../settings.js";
import type { ModmailMessage } from "./modmail.js";

const MAX_PRIOR_APPEALS_TO_SHOW = 5;

interface PriorAppealRecord {
    username: string;
    receivedAt: number;
    conversationId: string;
    userStatusAtAppeal: UserStatus.Banned | UserStatus.Purged;
    appealedSubreddit?: string;
    banDate?: number;
}

export function getPriorAppealHistoryWarningDays (settings: ControlSubSettings): number | undefined {
    if (!settings.priorAppealHistoryWarningDays || settings.priorAppealHistoryWarningDays <= 0) {
        return undefined;
    }

    return settings.priorAppealHistoryWarningDays;
}

function getPriorAppealHistoryKey (username: string): string {
    return `priorAppealHistory~${username.toLowerCase()}`;
}

function getPriorAppealHistoryNoticeKey (conversationId: string): string {
    return `priorAppealHistoryNotice~${conversationId}`;
}

function getAppealedSubredditFromSubject (subject: string): string | undefined {
    const match = /\bon\s+\/r\/([A-Za-z0-9_]+)/i.exec(subject);
    return match?.[1];
}

function formatUtcDate (timestamp: number | undefined): string {
    if (!timestamp) {
        return "unknown date";
    }

    return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function getConversationLink (conversationId: string): string {
    return `https://mod.reddit.com/mail/all/${conversationId}`;
}

function parsePriorAppealHistory (recordData: string | undefined): PriorAppealRecord[] {
    if (!recordData) {
        return [];
    }

    try {
        const records = JSON.parse(recordData) as unknown;
        if (!Array.isArray(records)) {
            return [];
        }

        return records.filter((record): record is PriorAppealRecord => {
            if (!record || typeof record !== "object") {
                return false;
            }

            const candidate = record as Partial<PriorAppealRecord>;
            return typeof candidate.username === "string"
                && typeof candidate.receivedAt === "number"
                && typeof candidate.conversationId === "string"
                && (candidate.userStatusAtAppeal === UserStatus.Banned || candidate.userStatusAtAppeal === UserStatus.Purged);
        });
    } catch {
        return [];
    }
}

function filterRecentPriorAppeals (records: PriorAppealRecord[], warningDays: number, currentConversationId: string): PriorAppealRecord[] {
    const cutoff = addDays(new Date(), -warningDays).getTime();
    return records
        .filter(record => record.conversationId !== currentConversationId)
        .filter(record => record.receivedAt >= cutoff)
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, MAX_PRIOR_APPEALS_TO_SHOW);
}

export async function recordPriorAppealSubmission (modmail: ModmailMessage, userDetails: UserDetails, context: TriggerContext) {
    const username = modmail.participant;
    if (!username || (userDetails.userStatus !== UserStatus.Banned && userDetails.userStatus !== UserStatus.Purged)) {
        return;
    }

    const settings = await getControlSubSettings(context);
    const warningDays = getPriorAppealHistoryWarningDays(settings);
    if (!warningDays) {
        return;
    }

    const historyKey = getPriorAppealHistoryKey(username);
    const existingRecords = parsePriorAppealHistory(await context.redis.get(historyKey));
    const recentRecords = filterRecentPriorAppeals(existingRecords, warningDays, modmail.conversationId);
    const currentRecord: PriorAppealRecord = {
        username,
        receivedAt: Date.now(),
        conversationId: modmail.conversationId,
        userStatusAtAppeal: userDetails.userStatus,
        appealedSubreddit: getAppealedSubredditFromSubject(modmail.subject),
        banDate: userDetails.reportedAt ?? userDetails.lastUpdate,
    };

    await context.redis.set(historyKey, JSON.stringify([currentRecord, ...recentRecords]), { expiration: addDays(new Date(), warningDays) });
}

export async function addPriorAppealHistoryNotice (modmail: ModmailMessage, settings: ControlSubSettings, context: TriggerContext) {
    const username = modmail.participant;
    if (!username) {
        return;
    }

    const noticeKey = getPriorAppealHistoryNoticeKey(modmail.conversationId);
    if (await context.redis.exists(noticeKey)) {
        return;
    }

    const warningDays = getPriorAppealHistoryWarningDays(settings);
    if (!warningDays) {
        return;
    }

    const historyKey = getPriorAppealHistoryKey(username);
    const recentRecords = filterRecentPriorAppeals(parsePriorAppealHistory(await context.redis.get(historyKey)), warningDays, modmail.conversationId);
    if (recentRecords.length === 0) {
        return;
    }

    const appealBullets = recentRecords.map(record => {
        const appealedSubreddit = record.appealedSubreddit ? `/r/${record.appealedSubreddit}` : "unknown subreddit";
        return `${formatUtcDate(record.receivedAt)} — ${appealedSubreddit} — account status at appeal: ${record.userStatusAtAppeal} — ban recorded: ${formatUtcDate(record.banDate)} — ${getConversationLink(record.conversationId)}`;
    });

    const message: json2md.DataObject[] = [
        { p: "Prior appeal history detected." },
        { p: `/u/${username} has submitted ${recentRecords.length} previous Bot Bouncer ${recentRecords.length === 1 ? "appeal" : "appeals"} within the configured lookback window.` },
        { ul: appealBullets },
        { p: "This notice is informational only. It does not indicate whether any prior appeal was granted, denied, or resolved." },
        { p: "Appeals that receive the automated recent-appeal reply are not recorded in this history and do not receive this notice." },
    ];

    await context.reddit.modMail.reply({
        conversationId: modmail.conversationId,
        body: json2md(message),
        isInternal: true,
    });

    await context.redis.set(noticeKey, Date.now().toString(), { expiration: addDays(new Date(), warningDays) });
}
