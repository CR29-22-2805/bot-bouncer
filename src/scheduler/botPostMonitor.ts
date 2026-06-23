import { JobContext, Post } from "@devvit/public-api";
import { differenceInMinutes } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { ControlSubSettings } from "../settings.js";
import { postIdToShortLink, sendMessageToWebhook } from "../utility.js";

const BOT_POST_MONITOR_ALERT_KEY = "botPostMonitorAlertSent";
const BOT_POST_MONITOR_LOOKBACK_LIMIT = 25;
export const BOT_POST_MONITOR_THRESHOLD_MINUTES = 5;

type MonitorablePost = Pick<Post, "authorName" | "createdAt" | "id" | "subredditName">;

export interface BotPostFreshnessResult {
    latestPost?: MonitorablePost;
    minutesSinceLatestPost?: number;
    stale: boolean;
}

export function getBotPostFreshness (posts: MonitorablePost[], botUsername: string, now = new Date()): BotPostFreshnessResult {
    const latestPost = posts
        .filter(post => post.authorName.toLowerCase() === botUsername.toLowerCase() && post.subredditName.toLowerCase() === CONTROL_SUBREDDIT.toLowerCase())
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    if (!latestPost) {
        return { stale: true };
    }

    const minutesSinceLatestPost = differenceInMinutes(now, latestPost.createdAt);
    return {
        latestPost,
        minutesSinceLatestPost,
        stale: minutesSinceLatestPost >= BOT_POST_MONITOR_THRESHOLD_MINUTES,
    };
}

function botPostAlertMessage (botUsername: string, freshness: BotPostFreshnessResult): string {
    if (!freshness.latestPost || freshness.minutesSinceLatestPost === undefined) {
        return `🚨 No recent r/${CONTROL_SUBREDDIT} posts by u/${botUsername} were found in the newest ${BOT_POST_MONITOR_LOOKBACK_LIMIT} posts from the account. Post creation may be stalled.`;
    }

    const postCreatedAtUnix = Math.floor(freshness.latestPost.createdAt.getTime() / 1000);
    return `🚨 u/${botUsername} has not created a new r/${CONTROL_SUBREDDIT} post in ${freshness.minutesSinceLatestPost.toLocaleString()} minutes. Latest detected post: <${postIdToShortLink(freshness.latestPost.id)}> created <t:${postCreatedAtUnix}:R>.`;
}

function botPostRecoveryMessage (botUsername: string, freshness: BotPostFreshnessResult): string {
    if (!freshness.latestPost) {
        return `✅ u/${botUsername} has resumed creating r/${CONTROL_SUBREDDIT} posts.`;
    }

    const postCreatedAtUnix = Math.floor(freshness.latestPost.createdAt.getTime() / 1000);
    return `✅ u/${botUsername} created a new r/${CONTROL_SUBREDDIT} post at <t:${postCreatedAtUnix}:T>: <${postIdToShortLink(freshness.latestPost.id)}>.`;
}

export async function checkBotPostFreshness (settings: ControlSubSettings, context: JobContext) {
    if (!settings.botPostMonitoringEnabled) {
        console.log("Bot Post Monitor: Monitor is disabled.");
        return;
    }

    const webhookUrl = settings.botNotificationsWebhook;
    if (!webhookUrl) {
        console.log("Bot Post Monitor: No bot notifications webhook configured.");
        return;
    }

    const botUsername = context.appSlug;
    let posts: Post[];
    try {
        posts = await context.reddit.getPostsByUser({
            username: botUsername,
            sort: "new",
            limit: BOT_POST_MONITOR_LOOKBACK_LIMIT,
        }).all();
    } catch (error) {
        console.error("Bot Post Monitor: Error fetching recent bot posts.", error);
        return;
    }

    const freshness = getBotPostFreshness(posts, botUsername);
    const existingAlertSentAt = await context.redis.get(BOT_POST_MONITOR_ALERT_KEY);

    if (!freshness.stale) {
        if (existingAlertSentAt) {
            await sendMessageToWebhook(webhookUrl, botPostRecoveryMessage(botUsername, freshness));
            await context.redis.del(BOT_POST_MONITOR_ALERT_KEY);
        }
        return;
    }

    if (existingAlertSentAt) {
        console.log("Bot Post Monitor: Stale bot post alert already sent.");
        return;
    }

    const messageId = await sendMessageToWebhook(webhookUrl, botPostAlertMessage(botUsername, freshness));
    if (messageId) {
        await context.redis.set(BOT_POST_MONITOR_ALERT_KEY, Date.now().toString());
    }
}
