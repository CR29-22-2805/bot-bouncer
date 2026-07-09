import type { ErrorObject } from "ajv";
import json2md from "json2md";

export type ConfigErrorContext = "appeal" | "evaluator";

export interface ConfigValidationIssue {
    code: string;
    message: string;
    line?: number;
    key?: string;
    suggestion?: string;
}

const configTitles: Record<ConfigErrorContext, string> = {
    appeal: "Appeal Config Error",
    evaluator: "Evaluator Config Error",
};

const configPageNames: Record<ConfigErrorContext, string> = {
    appeal: "appeal config wiki page",
    evaluator: "evaluator config wiki page",
};

const knownAppealKeys = new Set([
    "name", "priority", "submitter", "operator", "usernameRegex", "~usernameRegex", "messageBodyRegex", "banDateFrom", "banDateTo",
    "evaluatorNameRegex", "evaluatorHitReasonRegex", "currentEvaluatorNameRegex", "currentEvaluatorHitReasonRegex", "bioRegex", "~bioRegex",
    "originalBioRegex", "socialLinkRegex", "~socialLinkRegex", "originalSocialLinkRegex", "flags", "~flags", "modNoteTextRegex",
    "~modNoteTextRegex", "hasMoreThanOneCommentOnPost", "setStatus", "privateReply", "reply", "replyDelay", "minMinutes", "maxMinutes",
    "archive", "mute", "highlight",
]);

const appealMatcherKeys = new Set([
    "usernameRegex", "~usernameRegex", "messageBodyRegex", "evaluatorNameRegex", "evaluatorHitReasonRegex", "currentEvaluatorNameRegex",
    "currentEvaluatorHitReasonRegex", "bioRegex", "~bioRegex", "originalBioRegex", "socialLinkRegex", "~socialLinkRegex",
    "originalSocialLinkRegex", "flags", "~flags", "modNoteTextRegex", "~modNoteTextRegex", "submitter", "operator", "banDateFrom", "banDateTo",
    "hasMoreThanOneCommentOnPost",
]);

const appealActionKeys = new Set(["setStatus", "privateReply", "reply", "replyDelay", "archive", "mute", "highlight"]);

const evaluatorSectionChildKeys = new Set([
    "killswitch", "subreddits", "subreddit", "excludeSubreddits", "includedSubreddits", "commentSubreddits", "postSubreddits",
    "regex", "regexes", "usernameRegex", "displayNameRegex", "bioRegex", "postTitleRegex", "postBodyRegex", "commentBodyRegex",
    "hitReason", "hitReasons", "reason", "reasons", "groups", "conditions", "min", "max", "minCount", "maxCount",
]);

function formatIssue (issue: ConfigValidationIssue): string {
    const location = issue.line ? ` at line ${issue.line}` : "";
    const key = issue.key ? ` (${issue.key})` : "";
    const suggestion = issue.suggestion ? ` Suggested fix: ${issue.suggestion}` : "";
    return `${issue.code}${location}${key}: ${issue.message}${suggestion}`;
}

export function buildConfigErrorRedditMessage (context: ConfigErrorContext, issues: ConfigValidationIssue[]): string {
    return json2md([
        { h2: configTitles[context] },
        { p: `The ${configPageNames[context]} could not be saved. Last known good values will be used until this is corrected.` },
        { ul: issues.map(formatIssue) },
    ]);
}

export function buildConfigErrorDiscordMessage (context: ConfigErrorContext, username: string, issues: ConfigValidationIssue[]): string {
    return json2md([
        { p: `${username} updated the ${configPageNames[context]}, but it contains errors.` },
        { p: "Last known good values will be used until this is corrected." },
        { ul: issues.map(formatIssue) },
    ]);
}

export function yamlParseIssue (error: unknown): ConfigValidationIssue {
    const message = error instanceof Error ? error.message : String(error);
    return {
        code: "CONFIG_YAML_PARSE_ERROR",
        message: `YAML could not be parsed: ${message}`,
        suggestion: "Check indentation, list markers, quoted strings, and multiline block formatting.",
    };
}

export function ajvIssuesToConfigIssues (errors: ErrorObject[] | null | undefined): ConfigValidationIssue[] {
    return (errors ?? []).map(error => {
        if (error.keyword === "additionalProperties") {
            const additionalProperty = typeof error.params.additionalProperty === "string" ? error.params.additionalProperty : undefined;
            return {
                code: "CONFIG_UNKNOWN_PROPERTY",
                key: additionalProperty,
                message: additionalProperty ? `The key \`${additionalProperty}\` is not recognized.` : error.message ?? "The config contains an unrecognized key.",
                suggestion: "Check for a typo or move the line under the correct config item.",
            };
        }

        if (error.keyword === "required") {
            const missingProperty = typeof error.params.missingProperty === "string" ? error.params.missingProperty : undefined;
            return {
                code: "CONFIG_REQUIRED_PROPERTY_MISSING",
                key: missingProperty,
                message: missingProperty ? `Missing required key \`${missingProperty}\`.` : error.message ?? "A required key is missing.",
                suggestion: "Add the required key to this config item.",
            };
        }

        if (error.keyword === "type") {
            return {
                code: "CONFIG_INVALID_TYPE",
                message: error.message ?? "A config value has the wrong type.",
                suggestion: "Check whether the value should be a string, number, boolean, or YAML list.",
            };
        }

        return {
            code: "CONFIG_SCHEMA_ERROR",
            message: error.message ?? "The config does not match the expected schema.",
            suggestion: "Review the config wiki page for the expected property and value format.",
        };
    });
}

function isQuoted (value: string): boolean {
    return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
}

function isCommentOrBlank (line: string): boolean {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#") || trimmed === "---";
}

function getKey (line: string): string | undefined {
    const trimmed = line.trim();
    const match = /^(?:-\s*)?(["']?[^"':]+["']?)\s*:/.exec(trimmed);
    return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

function isProbablyRegexKey (key: string | undefined): boolean {
    return key !== undefined && /regex$/i.test(key.replace(/^~/, ""));
}

function sourceLineIssues (source: string, context: ConfigErrorContext): ConfigValidationIssue[] {
    const issues: ConfigValidationIssue[] = [];
    const keyByIndent = new Map<number, Set<string>>();
    let currentAppealRuleKeys = new Set<string>();
    let currentAppealRuleStart: number | undefined;
    let currentAppealRuleName: string | undefined;

    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        const lineNumber = index + 1;
        if (isCommentOrBlank(line)) {
            continue;
        }

        const indent = /^ */.exec(line)?.[0].length ?? 0;
        const trimmed = line.trim();
        const key = getKey(line);

        if (/^-\S/.test(trimmed)) {
            issues.push({
                code: "CONFIG_MALFORMED_LIST_ITEM",
                line: lineNumber,
                message: "A YAML list item is missing a space after the dash.",
                suggestion: "Use `- value` instead of `-value`.",
            });
        }

        if (/^-\s*\d+\s*$/.test(trimmed)) {
            issues.push({
                code: "CONFIG_NUMERIC_SUBREDDIT_NEEDS_QUOTES",
                line: lineNumber,
                message: "A subreddit name with only numerical characters is not enclosed in double quotes.",
                suggestion: "Use double quotes, for example `- \"12345\"`, so YAML does not treat the subreddit name as a number.",
            });
        }

        if (key) {
            for (const trackedIndent of [...keyByIndent.keys()].filter(trackedIndent => trackedIndent > indent)) {
                keyByIndent.delete(trackedIndent);
            }

            const keysAtIndent = keyByIndent.get(indent) ?? new Set<string>();
            if (keysAtIndent.has(key)) {
                issues.push({
                    code: "CONFIG_DUPLICATE_KEY",
                    line: lineNumber,
                    key,
                    message: `The key \`${key}\` appears more than once in the same section.`,
                    suggestion: "Keep one copy of the key or merge the values into one YAML list.",
                });
            }
            keysAtIndent.add(key);
            keyByIndent.set(indent, keysAtIndent);

            const value = trimmed.replace(/^(?:-\s*)?["']?[^"':]+["']?\s*:\s*/, "");
            if (isProbablyRegexKey(key) && value !== "" && !value.startsWith("|") && !value.startsWith(">") && !isQuoted(value) && /[:#{}\[\],&*?]|\|\|/.test(value)) {
                issues.push({
                    code: "CONFIG_UNQUOTED_REGEX_SPECIAL_CHARS",
                    line: lineNumber,
                    key,
                    message: `The regex value for \`${key}\` contains YAML-sensitive characters but is not quoted.`,
                    suggestion: "Wrap the regex in single quotes unless the regex itself contains single quotes.",
                });
            }
        }

        if (context === "appeal") {
            if (/^-\s*name\s*:/.test(trimmed)) {
                if (currentAppealRuleStart !== undefined) {
                    addAppealRuleStructureIssues(issues, currentAppealRuleKeys, currentAppealRuleStart, currentAppealRuleName);
                }
                currentAppealRuleStart = lineNumber;
                currentAppealRuleName = trimmed.replace(/^-\s*name\s*:\s*/, "").replace(/^['"]|['"]$/g, "") || undefined;
                currentAppealRuleKeys = new Set(["name"]);
            } else if (key && currentAppealRuleStart !== undefined) {
                if (!(context === "appeal" && indent === 0 && key !== "name")) {
    currentAppealRuleKeys.add(key);
}
                if (indent === 0 && key !== "name") {
                    issues.push({
                        code: "CONFIG_INDENTATION_ERROR",
                        line: lineNumber,
                        key,
                        message: `The key \`${key}\` appears to be outside the current appeal rule.`,
                        suggestion: "Indent the line under the rule that starts with `- name:`.",
                    });
                }
                if (!knownAppealKeys.has(key)) {
                    issues.push({
                        code: "CONFIG_UNKNOWN_EVALUATOR_PROPERTY",
                        line: lineNumber,
                        key,
                        message: `The key \`${key}\` is not a recognized appeal config property.`,
                        suggestion: "Check for a typo or use one of the documented appeal config properties.",
                    });
                }
            }

            if ((key === "reply" || key === "privateReply") && trimmed.endsWith(":")) {
                const nextContentLine = lines.slice(index + 1).find(nextLine => !isCommentOrBlank(nextLine));
                if (!nextContentLine || (/^ */.exec(nextContentLine)?.[0].length ?? 0) <= indent) {
                    issues.push({
                        code: "CONFIG_EMPTY_REPLY",
                        line: lineNumber,
                        key,
                        message: `The \`${key}\` field does not contain a reply body.`,
                        suggestion: "Add a reply body under the field or remove the empty field.",
                    });
                }
            }

            if (key === "archive" && !/^archive\s*:\s*(true|false)\s*(?:#.*)?$/i.test(trimmed)) {
                issues.push({
                    code: "CONFIG_INVALID_ARCHIVE_VALUE",
                    line: lineNumber,
                    key,
                    message: "The `archive` value must be true or false.",
                    suggestion: "Use `archive: true` or `archive: false`.",
                });
            }
        } else if (context === "evaluator") {
            if (indent === 0 && key && evaluatorSectionChildKeys.has(key)) {
                issues.push({
                    code: "CONFIG_SECTION_INDENTATION_ERROR",
                    line: lineNumber,
                    key,
                    message: `The key \`${key}\` is at the top level and may have broken out of the previous evaluator config section.`,
                    suggestion: "Indent the line under the section it belongs to, or rename it if this is intentionally a top-level evaluator config section.",
                });
            }

            if (key && /subreddit/i.test(key)) {
                const value = trimmed.replace(/^(?:-\s*)?["']?[^"':]+["']?\s*:\s*/, "");
                if (value && !isQuoted(value) && /[^A-Za-z0-9_\-\[\],\s]/.test(value)) {
                    issues.push({
                        code: "CONFIG_INVALID_SUBREDDIT_NAME",
                        line: lineNumber,
                        key,
                        message: "A subreddit name value contains invalid characters.",
                        suggestion: "Use subreddit names without `r/`, spaces, slashes, or URLs.",
                    });
                }
            }
        }
    }

    if (context === "appeal" && currentAppealRuleStart !== undefined) {
        addAppealRuleStructureIssues(issues, currentAppealRuleKeys, currentAppealRuleStart, currentAppealRuleName);
    }

    return issues;
}

function addAppealRuleStructureIssues (issues: ConfigValidationIssue[], keys: Set<string>, line: number, ruleName: string | undefined) {
    if ([...keys].some(key => key.startsWith("~")) && ![...keys].some(key => !key.startsWith("~") && appealMatcherKeys.has(key))) {
        issues.push({
            code: "CONFIG_NEGATION_WITHOUT_POSITIVE_MATCH",
            line,
            message: `Appeal rule${ruleName ? ` \`${ruleName}\`` : ""} contains only negative matchers.`,
            suggestion: "Add at least one positive matcher so the rule defines what it should match before exclusions are applied.",
        });
    }

    if ([...keys].some(key => appealMatcherKeys.has(key)) && ![...keys].some(key => appealActionKeys.has(key))) {
        issues.push({
            code: "CONFIG_MISSING_REPLY_OR_ACTION",
            line,
            message: `Appeal rule${ruleName ? ` \`${ruleName}\`` : ""} has match criteria but no reply or action.`,
            suggestion: "Add `reply`, `privateReply`, `setStatus`, `archive`, `mute`, or another action, or remove the unused rule.",
        });
    }
}

export function validateConfigSource (source: string, context: ConfigErrorContext): ConfigValidationIssue[] {
    return sourceLineIssues(source, context);
}
