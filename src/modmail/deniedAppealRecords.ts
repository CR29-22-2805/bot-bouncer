import type { RedisClient, TriggerContext } from "@devvit/public-api";
import { addDays } from "date-fns";
import json2md from "json2md";
import { UserFlag, UserStatus } from "../dataStore.js";
import type { UserDetails } from "../dataStore.js";
import { getControlSubSettings } from "../settings.js";
import type { ControlSubSettings } from "../settings.js";
import type { ModmailMessage } from "./modmail.js";

interface PriorDeniedAppealRecord {
    username: string;
    appealReceivedAt: number;
    deniedAt: number;
    deniedBy: string;
    deniedConversationId: string;
    appealedSubreddit?: string;
    banDate?: number;
}

export function getPriorDeniedAppealWarningDays (settings: ControlSubSettings): number | undefined {
    if (!settings.priorDeniedAppealWarningDays || settings.priorDeniedAppealWarningDays <= 0) {
        return undefined;
    }

    return settings.priorDeniedAppealWarningDays;
}

export function clearsPriorDeniedAppealRecord (status: string | undefined): boolean {
    return status === UserStatus.Organic
        || status === UserFlag.HackedAndRecovered
        || status === UserFlag.Scammed
        || status === UserFlag.FutureNSFW;
}

function getPriorDeniedAppealKey (username: string): string {
    return `priorDeniedAppeal~${username.toLowerCase()}`;
}

function getPriorDeniedAppealNoticeKey (conversationId: string): string {
    return `priorDeniedAppealNotice~${conversationId}`;
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

export async function recordPriorDeniedAppeal (modmail: ModmailMessage, userDetails: UserDetails, appealReceivedAt: number | undefined, context: TriggerContext) {
    const username = modmail.participant;
    if (!username) {
        return;
    }

    const settings = await getControlSubSettings(context);
    const warningDays = getPriorDeniedAppealWarningDays(settings);
    if (!warningDays) {
        return;
    }

    const record: PriorDeniedAppealRecord = {
        username,
        appealReceivedAt: appealReceivedAt ?? Date.now(),
        deniedAt: Date.now(),
        deniedBy: modmail.messageAuthor,
        deniedConversationId: modmail.conversationId,
        appealedSubreddit: getAppealedSubredditFromSubject(modmail.subject),
        banDate: userDetails.reportedAt ?? userDetails.lastUpdate,
    };

    await context.redis.set(getPriorDeniedAppealKey(username), JSON.stringify(record), { expiration: addDays(new Date(), warningDays) });
}

export async function clearPriorDeniedAppealRecord (username: string, redis: RedisClient) {
    await redis.del(getPriorDeniedAppealKey(username));
}

export async function addPriorDeniedAppealNotice (modmail: ModmailMessage, settings: ControlSubSettings, context: TriggerContext) {
    const username = modmail.participant;
    if (!username) {
        return;
    }

    const noticeKey = getPriorDeniedAppealNoticeKey(modmail.conversationId);
    if (await context.redis.exists(noticeKey)) {
        return;
    }

    const recordData = await context.redis.get(getPriorDeniedAppealKey(username));
    if (!recordData) {
        return;
    }

    let record: PriorDeniedAppealRecord;
    try {
        record = JSON.parse(recordData) as PriorDeniedAppealRecord;
    } catch {
        await context.redis.del(getPriorDeniedAppealKey(username));
        return;
    }

    if (record.deniedConversationId === modmail.conversationId) {
        return;
    }

    const warningDays = getPriorDeniedAppealWarningDays(settings);
    if (!warningDays) {
        return;
    }

    if (record.deniedAt < addDays(new Date(), -warningDays).getTime()) {
        await context.redis.del(getPriorDeniedAppealKey(username));
        return;
    }

    const appealedSubreddit = record.appealedSubreddit ? `/r/${record.appealedSubreddit}` : "an unknown subreddit";
    const message: json2md.DataObject[] = [
        { p: "Prior denied appeal detected." },
        { p: `/u/${record.username} previously submitted a Bot Bouncer appeal on ${formatUtcDate(record.appealReceivedAt)}. That appeal concerned a ban in ${appealedSubreddit} from ${formatUtcDate(record.banDate)}.` },
        { p: `Denied by: /u/${record.deniedBy} on ${formatUtcDate(record.deniedAt)}  \nPrior conversation: ${getConversationLink(record.deniedConversationId)}` },
        { p: "This notice is informational only. It is intended to alert moderators that this user has already had a recent appeal denied, without requiring a manual modmail history check." },
        { p: "If the user’s ban is later reversed, Bot Bouncer will clear this denial flag and stop generating this notice for future appeals from this user." },
    ];

    await context.reddit.modMail.reply({
        conversationId: modmail.conversationId,
        body: json2md(message),
        isInternal: true,
    });

    await context.redis.set(noticeKey, Date.now().toString(), { expiration: addDays(new Date(), warningDays) });
}
