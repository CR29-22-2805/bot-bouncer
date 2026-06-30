import { Comment, JSONValue, Post, TriggerContext } from "@devvit/public-api";
import { median } from "../utility.js";
import { addMilliseconds, differenceInDays, differenceInHours, differenceInMilliseconds, differenceInMinutes, differenceInSeconds, Duration, format, formatDuration, getYear, intervalToDuration, startOfDecade } from "date-fns";
import _ from "lodash";
import { count } from "@wordpress/wordcount";
import { isUserPotentiallyBlockingBot } from "./blockChecker.js";
import pluralize from "pluralize";
import { isLinkId } from "@devvit/public-api/types/tid.js";
import { getUserExtended, UserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import markdownEscape from "markdown-escape";
import { BIO_TEXT_STORE, getUserStatus } from "../dataStore.js";
import { getUserSocialLinks } from "devvit-helpers";
import { getSubmitterSuccessRate } from "../statistics/submitterStatistics.js";
import { getSummaryExtras } from "./summaryExtras.js";
import { ALL_RELEVANT_EVALUTORS, CONTROL_SUBREDDIT } from "../constants.js";

function formatDifferenceInDates (start: Date, end: Date) {
    const units: (keyof Duration)[] = ["years", "months", "days"];
    if (differenceInDays(end, start) < 2) {
        units.push("hours");
    }
    if (differenceInHours(end, start) < 6) {
        units.push("minutes");
    }
    if (differenceInMinutes(end, start) < 4) {
        units.push("seconds");
    }
    if (differenceInSeconds(end, start) < 1) {
        return "less than a second";
    }

    const duration = intervalToDuration({ start, end });
    return formatDuration(duration, { format: units });
}

function timeBetween (history: (Post | Comment)[], type: "min" | "max" | "10th") {
    if (history.length < 2) {
        return;
    }

    const diffs: number[] = [];

    for (let i = 0; i < history.length - 1; i++) {
        const first = history[i];
        const second = history[i + 1];
        diffs.push(differenceInMilliseconds(first.createdAt, second.createdAt));
    }

    if (diffs.length === 0) {
        return undefined;
    }

    // Order diffs from smallest to largest
    diffs.sort((a, b) => a - b);
    let diff: number;

    if (type === "min") {
        diff = diffs[0];
    } else if (type === "max") {
        diff = diffs[diffs.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (type === "10th") {
        const tenthIndex = Math.floor(diffs.length * 0.1);
        diff = diffs[tenthIndex];
    } else {
        return;
    }

    const start = startOfDecade(new Date());
    const end = addMilliseconds(start, diff);

    return formatDifferenceInDates(start, end);
}

function averageInterval (history: (Post | Comment)[], mode: "mean" | "median") {
    if (history.length < 2) {
        return;
    }

    const differences: number[] = [];

    for (let i = 0; i < history.length - 1; i++) {
        const first = history[i];
        const second = history[i + 1];
        differences.push(differenceInMilliseconds(first.createdAt, second.createdAt));
    }

    const start = startOfDecade(new Date());
    const end = addMilliseconds(start, Math.round(mode === "mean" ? _.mean(differences) : median(differences)));

    return formatDifferenceInDates(start, end);
}

function minMaxAvg (numbers: number[]) {
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const avg = Math.round(_.mean(numbers));
    const mdn = Math.round(median(numbers));

    if (min === max) {
        return `All ${min.toLocaleString()}`;
    }

    return `Min: ${min.toLocaleString()}, `
        + `Max: ${max.toLocaleString()}, `
        + `Average: ${avg.toLocaleString()}, `
        + `Median: ${mdn.toLocaleString()}`;
}

type AlignedSummaryRow = [string, string] | undefined;

function summaryCodeBlock (rows: AlignedSummaryRow[]): json2md.DataObject {
    const labelWidth = Math.max(...rows.map(row => row ? `${row[0]}:`.length : 0));
    const content = rows
        .map(row => row ? `${`${row[0]}:`.padEnd(labelWidth)} ${row[1]}` : "")
        .join("\n");

    return { code: { content } };
}

function addSummaryRows (summary: json2md.DataObject[], rows: AlignedSummaryRow[]) {
    if (rows.some(row => row !== undefined)) {
        summary.push(summaryCodeBlock(rows));
    }
}

function numberToBlock (input: number): string {
    switch (input) {
        case 0: return "";
        case 1: return "▁";
        case 2: return "▂";
        case 3: return "▃";
        case 4: return "▄";
        case 5: return "▅";
        case 6: return "▆";
        case 7: return "▇";
        case 8: return "█";
        default: throw new Error("Number out of range");
    }
}

function activityByTimeOfDay (history: (Post | Comment)[]): json2md.DataObject[] {
    const hours = _.countBy(history.map(item => item.createdAt.getHours()));
    const max = Math.max(...Object.values(hours));

    const headers: string[] = [];
    const values: string[] = [];

    for (let i = 0; i < 24; i++) {
        const value = hours[i] || 0;
        const blockHeight = Math.round(8 * value / max);
        headers.push(i.toString().padStart(2, "0"));
        values.push(numberToBlock(blockHeight).padStart(2));
    }

    const result: json2md.DataObject[] = [
        { h2: "Activity by time of day" },
        summaryCodeBlock([
            ["Hour", headers.join(" ")],
            ["Activity", values.join(" ")],
        ]),
    ];

    return result;
}

function cleanedBio (bio: string, bannedDomains: string[]): string {
    let result = bio;
    for (const domain of bannedDomains) {
        result = result.replaceAll(domain, "[redacted]");
    }
    return result;
}

function getCommonEntriesForContent (items: Post[] | Comment[]): AlignedSummaryRow[] {
    const kind = items[0] instanceof Post ? "post" : "comment";

    const rows: AlignedSummaryRow[] = [];
    if (items.length > 2) {
        rows.push([`Min time between ${kind}s`, timeBetween(items, "min") ?? "unknown"]);
        rows.push([`10th percentile time between ${kind}s`, timeBetween(items, "10th") ?? "unknown"]);
        rows.push([`Max time between ${kind}s`, timeBetween(items, "max") ?? "unknown"]);
        rows.push([`Average time between ${kind}s`, `${averageInterval(items, "mean")} (median: ${averageInterval(items, "median")})`]);
    } else if (items.length === 2) {
        rows.push([`Time between ${kind}s`, timeBetween(items, "min") ?? "unknown"]);
    }

    return rows;
}

export function evaluationResultsToBullets (results: EvaluationResult[]) {
    const markdown: json2md.DataObject[] = [];

    for (const result of results) {
        const rows: AlignedSummaryRow[] = [["Evaluator", `${result.botName} matched`]];
        if (result.hitReason) {
            let reasonToStore: string;
            if (typeof result.hitReason === "string") {
                reasonToStore = result.hitReason;
            } else {
                reasonToStore = result.hitReason.reason;
            }
            rows.push(["Hit reason", reasonToStore.length > 500 ? `${reasonToStore.substring(0, 500)}...` : reasonToStore]);
        }

        if (typeof result.hitReason === "object") {
            rows.push(undefined);
            for (const detail of result.hitReason.details) {
                rows.push([detail.key, detail.value.length > 500 ? `${detail.value.substring(0, 500)}...` : detail.value]);
            }
        }

        markdown.push(summaryCodeBlock(rows));
    }
    return markdown;
}

export async function getSummaryForUser (username: string, source: "modmail" | "submission", context: TriggerContext): Promise<json2md.DataObject[]> {
    const extendedUser = await getUserExtended(username, context);

    const userStatus = await getUserStatus(extendedUser?.username ?? username, context);
    const summary: json2md.DataObject[] = [];

    const altSources = `Archive.org: [www](https://web.archive.org/web/${getYear(new Date())}0000000000*/https://www.reddit.com/user/${username}) | [old](https://web.archive.org/web/${getYear(new Date())}0000000000*/https://old.reddit.com/user/${username}) | [sh](https://web.archive.org/web/${getYear(new Date())}0000000000*/https://sh.reddit.com/user/${username}) | [Pushshift](https://shiruken.github.io/chearch/?kind=comment&author=${username}&limit=100) | [Arctic Shift](https://fsvreddit.github.io/arcticredir/?author=${username}&type=posts)`;

    if (userStatus && source === "modmail") {
        const post = await context.reddit.getPostById(userStatus.trackingPostId);

        let firstLine = `/u/${username} is currently listed as ${userStatus.userStatus}, set by ${markdownEscape(userStatus.operator ?? "unknown")} at ${new Date(userStatus.lastUpdate).toUTCString()}`;
        if (userStatus.submitter) {
            firstLine += ` and reported by ${markdownEscape(userStatus.submitter)}`;
            const successRate = await getSubmitterSuccessRate(userStatus.submitter, context);
            if (successRate !== undefined) {
                firstLine += ` (${successRate}%)`;
            }
        }

        summary.push(
            { p: firstLine },
            { p: `[Link to submission](https://www.reddit.com${post.permalink}) | ${altSources}` },
        );
    } else if (source === "modmail") {
        summary.push({ p: `/u/${username} is not currently in r/BotBouncer's data store.` });
        summary.push({ p: altSources });
    } else /* source === "submission" */ {
        summary.push({ p: altSources });
    }

    if (!extendedUser) {
        summary.push({ p: `User Summary: User ${username} is already shadowbanned or suspended, so summary will not be created.` });
        return summary;
    }

    console.log(`User Summary: Creating summary for ${username}`);

    const evaluatorVariables = await getEvaluatorVariables(context);

    const accountAge = formatDifferenceInDates(extendedUser.createdAt, new Date());

    const accountPropsRows: AlignedSummaryRow[] = [
        ["Account age", accountAge],
        ["Comment karma", extendedUser.commentKarma.toLocaleString()],
        ["Post karma", extendedUser.linkKarma.toLocaleString()],
        ["Verified Email", extendedUser.hasVerifiedEmail ? "Yes" : "No"],
        ["Subreddit Moderator", extendedUser.isModerator ? "Yes" : "No"],
    ];

    if (userStatus?.flags && userStatus.flags.length > 0) {
        accountPropsRows.push(["Account flags", userStatus.flags.join(", ")]);
    }

    const socialLinks = await getUserSocialLinks(username, context.metadata);
    const uniqueSocialLinks = _.compact(_.uniq(socialLinks.map(link => link.outboundUrl)));
    if (uniqueSocialLinks.length > 0) {
        if (source === "modmail") {
            accountPropsRows.push(["Social links", uniqueSocialLinks.join(", ")]);
        } else {
            accountPropsRows.push(["Social links", uniqueSocialLinks.length.toLocaleString()]);
        }
    }

    const userHasGold = extendedUser.isGold;
    if (userHasGold) {
        accountPropsRows.push(["User has Reddit Premium", "Yes"]);
    }

    const userDisplayName = extendedUser.displayName;
    if (userDisplayName) {
        accountPropsRows.push(["Display name", userDisplayName]);
    }

    const userBio = extendedUser.userDescription;
    const sitewideBannedDomains = evaluatorVariables["generic:sitewidebanneddomains"] as string[] | undefined ?? [];

    if (userBio && !userBio.includes("\n")) {
        accountPropsRows.push(["Bio", cleanedBio(userBio, sitewideBannedDomains)]);
    }

    const originalBio = source === "modmail" ? await context.redis.hGet(BIO_TEXT_STORE, username) : undefined;
    let accountPropertiesAdded = false;
    function addAccountPropertiesToSummary () {
        if (accountPropertiesAdded) {
            return;
        }
        accountPropertiesAdded = true;

        summary.push({ h2: "Account Properties" });
        addSummaryRows(summary, accountPropsRows);

        if (userBio?.includes("\n")) {
            summary.push({ blockquote: cleanedBio(userBio, sitewideBannedDomains) });
        }

        if (originalBio && originalBio.trim() !== userBio?.trim()) {
            if (userBio?.includes("\n")) {
                summary.push({ p: "Original bio:" });
                summary.push({ blockquote: cleanedBio(originalBio, sitewideBannedDomains) });
            } else {
                summary.push(summaryCodeBlock([["Original bio", cleanedBio(originalBio, sitewideBannedDomains)]]));
            }
        }
    }

    let userComments: Comment[];
    let userPosts: Post[];

    try {
        [userComments, userPosts] = await Promise.all([
            context.reddit.getCommentsByUser({
                username,
                sort: "new",
                limit: 100,
            }).all(),
            context.reddit.getPostsByUser({
                username,
                sort: "new",
                limit: 100,
            }).all(),
        ]);
    } catch {
        addAccountPropertiesToSummary();

        if (source === "modmail") {
            const initialEvaluatorsMatched = await getAccountInitialEvaluationResults(username, context);
            summary.push({ p: `At the point of initial evaluation, user matched ${initialEvaluatorsMatched.length} ${pluralize("evaluator", initialEvaluatorsMatched.length)}` });

            summary.push(...evaluationResultsToBullets(initialEvaluatorsMatched));
        }

        summary.push({ h2: "User Activity" });
        summary.push({ p: "An error occurred when fetching user activity. This may be due to the user being shadowbanned or suspended, or due to a Reddit bug that prevents some posts from being retrieved by the Dev Platform." });
        return summary;
    }

    const potentiallyBlocking = await isUserPotentiallyBlockingBot([...userComments, ...userPosts], context);
    if (potentiallyBlocking) {
        accountPropsRows.push(["Blocking u/bot-bouncer", "Potentially blocking; visible history only shows subs where app is installed"]);
    } else if (potentiallyBlocking === undefined) {
        accountPropsRows.push(["Blocking u/bot-bouncer", "Could not determine; less than 5 distinct subreddits in visible history"]);
    } else {
        accountPropsRows.push(["Blocking u/bot-bouncer", "No"]);
    }

    addAccountPropertiesToSummary();

    if (source === "modmail") {
        const initialEvaluatorsMatched = await getAccountInitialEvaluationResults(username, context);
        const matchedEvaluators = await evaluatorsMatched(extendedUser, [...userComments, ...userPosts], evaluatorVariables, context);
        if (matchedEvaluators.length > 0 || initialEvaluatorsMatched.length > 0) {
            summary.push({ h2: "Evaluation results" });
        }

        if (initialEvaluatorsMatched.length > 0) {
            summary.push({ p: `At the point of initial evaluation, user matched ${initialEvaluatorsMatched.length} ${pluralize("evaluator", initialEvaluatorsMatched.length)}` });

            summary.push(...evaluationResultsToBullets(initialEvaluatorsMatched));
        }

        if (matchedEvaluators.length > 0) {
            summary.push({ p: `User currently matches ${matchedEvaluators.length} ${pluralize("evaluator", matchedEvaluators.length)}` });

            const evaluationResults: EvaluationResult[] = [];

            for (const evaluator of matchedEvaluators) {
                if (!evaluator.hitReasons || evaluator.hitReasons.length === 0) {
                    evaluationResults.push({
                        botName: evaluator.name,
                        canAutoBan: evaluator.canAutoBan,
                        metThreshold: true,
                    });
                } else {
                    for (const hitReason of evaluator.hitReasons) {
                        evaluationResults.push({
                            botName: evaluator.name,
                            hitReason,
                            canAutoBan: evaluator.canAutoBan,
                            metThreshold: true,
                        });
                    }
                }
            }

            summary.push(...evaluationResultsToBullets(evaluationResults));
        }

        if (matchedEvaluators.length > 0 || initialEvaluatorsMatched.length > 0) {
            summary.push({ p: `[Evaluator Accuracy Stats](https://www.reddit.com/r/${CONTROL_SUBREDDIT}/wiki/statistics/evaluator-accuracy)` });
        }
    }

    try {
        const allModNotes = await context.reddit.getModNotes({
            user: username,
            limit: 100,
            subreddit: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            filter: "NOTE",
        }).all();

        const relevantModNotes = allModNotes.filter(note => note.userNote?.note && note.operator.name && note.operator.name !== context.appSlug);

        if (relevantModNotes.length > 0) {
            summary.push({ h2: "Mod Notes" });
            for (const note of relevantModNotes) {
                summary.push({ p: `**${markdownEscape(note.operator.name ?? "unknown")}** on ${format(note.createdAt, "yyyy-MM-dd")}` });
                summary.push({ blockquote: note.userNote?.note ?? "" });
            }
        }
    } catch {
        // This seems to fail a fair bit. Just ignore it if mod notes don't load.
    }

    const extras = getSummaryExtras(evaluatorVariables);

    if (userComments.length > 0) {
        summary.push({ h2: "Comments" });
        summary.push({ p: `User has ${userComments.length} ${pluralize("comment", userComments.length)}` });

        const rows = getCommonEntriesForContent(userComments);

        rows.push(["Length", minMaxAvg(userComments.map(comment => comment.body.length))]);
        rows.push(["Word count", minMaxAvg(userComments.map(comment => count(comment.body, "words", {})))]);
        rows.push(["Paragraphs", minMaxAvg(userComments.map(comment => comment.body.split("\n\n").length))]);

        const commentsExtras = extras.filter(extra => extra.type === "comment");
        for (const extra of commentsExtras) {
            const regex = new RegExp(extra.regex, "u");
            const matchCount = userComments.filter(comment => regex.test(comment.body)).length;
            if (matchCount > 0) {
                rows.push([extra.title, `${matchCount} (${Math.round(100 * matchCount / userComments.length)}%)`]);
            }
        }

        const topLevelPercentage = Math.floor(100 * userComments.filter(comment => isLinkId(comment.parentId)).length / userComments.length);
        rows.push(["Top level comments", `${topLevelPercentage}% of total`]);

        const editedCommentPercentage = Math.round(100 * userComments.filter(comment => comment.edited).length / userComments.length);
        if (editedCommentPercentage > 0) {
            rows.push(["Edited comments", `${editedCommentPercentage}% of total`]);
        }

        const subreddits = _.countBy(_.compact(userComments.map(comment => comment.subredditName)));
        rows.push(["Comment subreddits", Object.entries(subreddits).map(([subreddit, count]) => `${markdownEscape(subreddit)}: ${count}`).join(", ")]);

        const commentsPerPost = _.countBy(Object.values(_.countBy(userComments.map(comment => comment.postId))));
        rows.push(["Comments per post", Object.entries(commentsPerPost).map(([count, posts]) => `${count} comments: ${posts}`).join(", ")]);

        if (userComments.length < 90) {
            rows.push(["First comment", `${formatDifferenceInDates(extendedUser.createdAt, userComments[userComments.length - 1].createdAt)} after account creation`]);
        }

        addSummaryRows(summary, rows);
    }

    if (userPosts.length > 0) {
        summary.push({ h2: "Posts" });
        summary.push({ p: `User has ${userPosts.length} ${pluralize("post", userPosts.length)}` });

        const nonStickied = userPosts
            .filter(post => !post.stickied)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        const rows = getCommonEntriesForContent(nonStickied);

        const editedPostPercentage = Math.round(100 * userPosts.filter(post => post.edited).length / userPosts.length);
        if (editedPostPercentage > 0) {
            rows.push(["Edited posts", `${editedPostPercentage}% of total`]);
        }

        const postsExtras = extras.filter(extra => extra.type === "post");
        for (const extra of postsExtras) {
            const regex = new RegExp(extra.regex, "u");
            const matchCount = userPosts.filter(post => post.body && regex.test(post.body)).length;
            if (matchCount > 0) {
                rows.push([extra.title, `${matchCount} (${Math.round(100 * matchCount / userPosts.length)}%)`]);
            }
        }

        const subreddits = _.countBy(_.compact(userPosts.map(post => post.subredditName)));
        rows.push(["Post subreddits", Object.entries(subreddits).map(([subreddit, count]) => `${markdownEscape(subreddit)}: ${count}`).join(", ")]);
        if (userPosts.length < 90) {
            rows.push(["First post", `${formatDifferenceInDates(extendedUser.createdAt, userPosts[userPosts.length - 1].createdAt)} after account creation`]);
        }

        addSummaryRows(summary, rows);
    }

    if (userComments.length > 0 || userPosts.length > 0) {
        summary.push(activityByTimeOfDay([...userComments, ...userPosts]));
    } else {
        summary.push({ h2: "Activity" });
        summary.push({ p: "User has no comments or posts visible on their profile" });
    }

    return summary;
}

export async function createUserSummary (username: string, postId: string, context: TriggerContext) {
    const summary = await getSummaryForUser(username, "submission", context);

    const newComment = await context.reddit.submitComment({
        id: postId,
        text: json2md(summary),
    });
    await newComment.remove();

    console.log(`User Summary: Summary created for ${username}`);
}

async function evaluatorsMatched (user: UserExtended, userHistory: (Post | Comment)[], evaluatorVariables: Record<string, JSONValue>, context: TriggerContext): Promise<InstanceType<typeof ALL_RELEVANT_EVALUTORS[number]>[]> {
    const evaluatorsMatched: InstanceType<typeof ALL_RELEVANT_EVALUTORS[number]>[] = [];

    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator(context, userHistory, undefined, evaluatorVariables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }

        const userEvaluate = await Promise.resolve(evaluator.preEvaluateUser(user));
        if (!userEvaluate) {
            continue;
        }

        const fullEvaluate = await Promise.resolve(evaluator.evaluate(user));
        if (fullEvaluate) {
            evaluatorsMatched.push(evaluator);
        }
    }

    return evaluatorsMatched;
}
