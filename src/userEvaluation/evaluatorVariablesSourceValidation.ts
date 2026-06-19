import { createConfigErrorIssue, type EvaluatorVariablesValidationIssue } from "./evaluatorVariablesConfigErrors.js";

const REGEX_LIST_KEY_REGEX = /(?:regex(?:es)?|bantext|badtext|matchtext)$/i;
const SUBREDDIT_LIST_KEYS = new Set([
    "karmafarminglinksubs",
    "karmafarminglinksubsnsfw",
    "nonretrievablesubs",
    "subreddits",
    "subredditName",
    "notSubredditName",
]);
const BOT_GROUP_ADVANCED_MODULE_NAMES = new Set(["botgroupadvanced", "advancedbotgroup"]);
const BOT_GROUP_ADVANCED_ROOT_KEYS = new Set(["name", "killswitch", "verboseLogging"]);
const BOT_GROUP_ADVANCED_GROUP_KEYS = new Set([
    "name",
    "descriptionForAI",
    "usernameRegex",
    "matchesDefaultUsernameRegex",
    "maxCommentKarma",
    "maxLinkKarma",
    "minCommentKarma",
    "minLinkKarma",
    "age",
    "nsfw",
    "bioRegex",
    "displayNameRegex",
    "socialLinkRegex",
    "socialLinkTitleRegex",
    "hasVerifiedEmail",
    "hasRedditPremium",
    "isSubredditModerator",
    "hasMoreThanOneCommentOnPosts",
    "criteria",
]);
const BOT_GROUP_ADVANCED_CRITERIA_KEYS = new Set([
    "not",
    "every",
    "some",
    "type",
    "pinned",
    "matchesNeeded",
    "distinctSubsNeeded",
    "age",
    "edited",
    "subredditName",
    "notSubredditName",
    "bodyRegex",
    "titleRegex",
    "nsfw",
    "urlRegex",
    "domain",
    "postId",
    "isTopLevel",
    "isCommentOnOwnPost",
    "minBodyLength",
    "maxBodyLength",
    "minParaCount",
    "maxParaCount",
    "minKarma",
    "maxKarma",
    "postAuthorNameRegex",
    "postTitleRegex",
    "postBodyRegex",
    "postUrlRegex",
    "postCreatedAtAge",
    "isCrossPost",
]);
const BOT_GROUP_ADVANCED_AGE_KEYS = new Set(["dateFrom", "dateTo", "maxAgeInDays", "minAgeInDays", "maxAgeInMinutes", "minAgeInMinutes"]);

interface SourceKeyContext {
    key: string;
    indent: number;
    childScopeId: string;
    isSequenceItem?: boolean;
}

interface SeenKey {
    lineNumber: number;
    lineText: string;
}

function getYamlKeyFromTrimmedLine (trimmed: string): string | undefined {
    const withoutListMarker = trimmed.startsWith("- ") ? trimmed.substring(2).trimStart() : trimmed;
    const keyMatch = withoutListMarker.match(/^(?:["']?)([A-Za-z0-9_~-]+)(?:["']?)\s*:/);
    return keyMatch?.[1];
}

function getInlineYamlValue (trimmed: string): string | undefined {
    const valueMatch = trimmed.match(/^([^:#]+):\s*(.+)$/);
    return valueMatch?.[2]?.trim();
}

function isQuotedScalar (value: string): boolean {
    return (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
}

function stripYamlScalarComment (value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("'")) {
        for (let i = 1; i < trimmed.length; i++) {
            if (trimmed[i] !== "'") {
                continue;
            }

            if (trimmed[i + 1] === "'") {
                i++;
                continue;
            }

            return trimmed.substring(0, i + 1);
        }
    }

    if (trimmed.startsWith('"')) {
        let escaped = false;
        for (let i = 1; i < trimmed.length; i++) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (trimmed[i] === "\\") {
                escaped = true;
                continue;
            }

            if (trimmed[i] === '"') {
                return trimmed.substring(0, i + 1);
            }
        }
    }

    return trimmed.replace(/\s+#.*$/, "");
}

function yamlPlainScalarNeedsQuotes (value: string): boolean {
    return /^[\[\]{}#&*!|>"%@`]/.test(value) || /:\s/.test(value) || /\s#/.test(value);
}

function singleQuoteForSuggestion (value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function nearestParentKey (context: SourceKeyContext[], indent: number): SourceKeyContext | undefined {
    return [...context].reverse().find(item => item.indent < indent);
}

function currentPath (context: SourceKeyContext[], indent: number): string[] {
    return context.filter(item => item.indent < indent && !item.isSequenceItem).map(item => item.key);
}

function mappingScopeForIndent (context: SourceKeyContext[], indent: number, documentScopeId: string): string {
    return [...context].reverse().find(item => item.indent < indent)?.childScopeId ?? documentScopeId;
}

function recordYamlKeySource (key: string, lineNumber: number, lineText: string, scopeId: string, seenKeysByScope: Map<string, Map<string, SeenKey>>, evaluator: string | undefined, isBotGroupAdvancedRootKey: boolean, results: EvaluatorVariablesValidationIssue[]) {
    let seenKeys = seenKeysByScope.get(scopeId);
    if (!seenKeys) {
        seenKeys = new Map<string, SeenKey>();
        seenKeysByScope.set(scopeId, seenKeys);
    }

    const previous = seenKeys.get(key);
    if (!previous) {
        seenKeys.set(key, { lineNumber, lineText });
        return;
    }

    if (isBotGroupAdvancedRootKey && key.startsWith("group")) {
        results.push(createConfigErrorIssue(
            `The Bot Group Advanced group \`${key}\` appears more than once.`,
            `Rename one group or merge both groups under one \`${key}\` section. First seen on config line ${previous.lineNumber}.`,
            lineText,
            lineNumber,
            evaluator,
        ));
        return;
    }

    results.push(createConfigErrorIssue(
        `The config key \`${key}\` appears more than once in the same section.`,
        `Merge the values under one \`${key}\` key or remove one duplicate key. First seen on config line ${previous.lineNumber}.`,
        lineText,
        lineNumber,
        evaluator,
    ));
}

function validateRegexListItemSource (lineNumber: number, parentKey: string | undefined, lineText: string, rawValue: string, evaluator: string | undefined, results: EvaluatorVariablesValidationIssue[]) {
    if (!parentKey || !REGEX_LIST_KEY_REGEX.test(parentKey)) {
        return;
    }

    const scalarValue = stripYamlScalarComment(rawValue);
    const startsWithSingleQuote = scalarValue.startsWith("'");
    const endsWithSingleQuote = scalarValue.endsWith("'");
    if (startsWithSingleQuote !== endsWithSingleQuote) {
        results.push(createConfigErrorIssue(
            "A regex is missing a beginning or ending single quote.",
            "Add the missing single quote so the regex is fully enclosed in single quotes.",
            lineText,
            lineNumber,
            evaluator,
        ));
        return;
    }

    if (!isQuotedScalar(scalarValue) && yamlPlainScalarNeedsQuotes(scalarValue)) {
        results.push(createConfigErrorIssue(
            "A regex should be enclosed in single quotes.",
            `Enclose this regex in single quotes, for example \`- ${singleQuoteForSuggestion(scalarValue)}\`.`,
            lineText,
            lineNumber,
            evaluator,
        ));
    }
}

function validateSubredditListItemSource (lineNumber: number, parentKey: string | undefined, lineText: string, rawValue: string, evaluator: string | undefined, results: EvaluatorVariablesValidationIssue[]) {
    const scalarValue = stripYamlScalarComment(rawValue);
    if (!parentKey || !SUBREDDIT_LIST_KEYS.has(parentKey) || isQuotedScalar(scalarValue)) {
        return;
    }

    if (/^(?:r\/)?\d+$/i.test(scalarValue)) {
        results.push(createConfigErrorIssue(
            "A subreddit name is missing single quotes.",
            "Enclose this subreddit name in single quotes.",
            lineText,
            lineNumber,
            evaluator,
        ));
    }
}

function validateBotGroupAdvancedKeySource (lineNumber: number, key: string, indent: number, lineText: string, path: string[], evaluator: string | undefined, results: EvaluatorVariablesValidationIssue[]) {
    if (indent === 0) {
        if (!BOT_GROUP_ADVANCED_ROOT_KEYS.has(key) && !key.startsWith("group")) {
            results.push(createConfigErrorIssue(
                "A Bot Group Advanced group header does not begin with `group`.",
                "Rename the group header so it begins with `group`, such as `group_comments_AskReddit`.",
                lineText,
                lineNumber,
                evaluator,
            ));
        }
        return;
    }

    const rootGroup = path.find(item => item.startsWith("group"));
    if (!rootGroup) {
        return;
    }

    if (indent === 4 && !BOT_GROUP_ADVANCED_GROUP_KEYS.has(key)) {
        results.push(createConfigErrorIssue(
            "An advanced bot group attribute is invalid.",
            `Replace \`${key}\` with a supported Bot Group Advanced key or fix the indentation.`,
            lineText,
            lineNumber,
            evaluator,
        ));
        return;
    }

    if (!path.includes("criteria")) {
        return;
    }

    const parentKey = path[path.length - 1];
    if (parentKey === "age" || parentKey === "postCreatedAtAge") {
        if (!BOT_GROUP_ADVANCED_AGE_KEYS.has(key)) {
            results.push(createConfigErrorIssue(
                "An advanced bot group age attribute is invalid.",
                `Replace \`${key}\` with a supported age key, such as \`maxAgeInDays\` or \`minAgeInDays\`.`,
                lineText,
                lineNumber,
                evaluator,
            ));
        }
        return;
    }

    if (!BOT_GROUP_ADVANCED_CRITERIA_KEYS.has(key) && !BOT_GROUP_ADVANCED_AGE_KEYS.has(key)) {
        results.push(createConfigErrorIssue(
            "An advanced bot group criteria attribute is invalid.",
            `Replace \`${key}\` with a supported criteria key or fix the indentation.`,
            lineText,
            lineNumber,
            evaluator,
        ));
    }
}

export function validateEvaluatorVariablesYamlSource (yamlStr: string): EvaluatorVariablesValidationIssue[] {
    const results: EvaluatorVariablesValidationIssue[] = [];
    const keyContext: SourceKeyContext[] = [];
    const seenKeysByScope = new Map<string, Map<string, SeenKey>>();
    let currentModuleName: string | undefined;
    let documentNumber = 1;
    let documentScopeId = `document-${documentNumber}`;

    yamlStr.split(/\r?\n/).forEach((line, index) => {
        const lineNumber = index + 1;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }

        if (/^---\s*(?:#.*)?$/.test(trimmed)) {
            keyContext.length = 0;
            currentModuleName = undefined;
            documentNumber++;
            documentScopeId = `document-${documentNumber}`;
            return;
        }

        const indent = line.length - line.trimStart().length;
        while (keyContext.length > 0 && keyContext[keyContext.length - 1].indent >= indent) {
            keyContext.pop();
        }

        const listItemMatch = trimmed.match(/^-\s+(.+)$/);
        let keyScopeId = mappingScopeForIndent(keyContext, indent, documentScopeId);
        let keyIndent = indent;
        let keyHasSequenceItemParent = false;
        if (listItemMatch) {
            const parent = nearestParentKey(keyContext, indent);
            if (!parent) {
                results.push(createConfigErrorIssue(
                    "A list item is not indented under its YAML key.",
                    "Move the list item under the correct key and indent it.",
                    line,
                    lineNumber,
                    currentModuleName,
                ));
            } else if (indent !== parent.indent + 4) {
                results.push(createConfigErrorIssue(
                    "A list item has the wrong indentation level.",
                    `Indent this list item ${parent.indent + 4} spaces so it is nested under \`${parent.key}\`.`,
                    line,
                    lineNumber,
                    currentModuleName,
                ));
            }

            const rawValue = listItemMatch[1].trim();
            validateRegexListItemSource(lineNumber, parent?.key, line, rawValue, currentModuleName, results);
            validateSubredditListItemSource(lineNumber, parent?.key, line, rawValue, currentModuleName, results);

            if (parent) {
                keyScopeId = `${parent.childScopeId}/item@${lineNumber}`;
                keyContext.push({ key: `@item:${lineNumber}`, indent, childScopeId: keyScopeId, isSequenceItem: true });
                keyHasSequenceItemParent = true;
                keyIndent = indent + 2;
            }
        }

        const key = getYamlKeyFromTrimmedLine(trimmed);
        if (!key) {
            return;
        }

        const path = currentPath(keyContext, indent);
        const isBotGroupAdvancedRootKey = Boolean(currentModuleName && BOT_GROUP_ADVANCED_MODULE_NAMES.has(currentModuleName) && indent === 0);
        recordYamlKeySource(key, lineNumber, line, keyScopeId, seenKeysByScope, currentModuleName, isBotGroupAdvancedRootKey, results);

        if (indent === 0 && key === "name") {
            currentModuleName = getInlineYamlValue(trimmed)?.replace(/^["']|["']$/g, "");
        } else if (currentModuleName && BOT_GROUP_ADVANCED_MODULE_NAMES.has(currentModuleName)) {
            validateBotGroupAdvancedKeySource(lineNumber, key, indent, line, path, currentModuleName, results);
        }

        const inlineValue = getInlineYamlValue(trimmed);
        if (!keyHasSequenceItemParent || inlineValue === undefined) {
            keyContext.push({ key, indent: keyIndent, childScopeId: `${keyScopeId}/${key}@${lineNumber}` });
        }
    });

    const seenMessages = new Set<string>();
    return results.filter((issue) => {
        const messageKey = issue.configError ? JSON.stringify(issue.configError) : issue.message;
        if (seenMessages.has(messageKey)) {
            return false;
        }

        seenMessages.add(messageKey);
        return true;
    });
}
