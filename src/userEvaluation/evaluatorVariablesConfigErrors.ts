import type { ValidationIssue } from "@fsvreddit/bot-bouncer-evaluation";

export interface ConfigErrorDetails {
    evaluator?: string;
    details: string;
    fix: string;
    configLineText: string;
    configLineNumber: number;
}

export interface EvaluatorVariablesValidationIssue extends ValidationIssue {
    configError?: ConfigErrorDetails;
}

const CONFIG_LINE_TEXT_MAX_LENGTH = 50;
const DISCORD_CONFIG_ERROR_LABEL_WIDTH = 18;

export function truncateConfigLineText (lineText: string): string {
    const trimmed = lineText.trim();
    if (trimmed.length <= CONFIG_LINE_TEXT_MAX_LENGTH) {
        return trimmed;
    }

    return `${trimmed.substring(0, CONFIG_LINE_TEXT_MAX_LENGTH - 1)}…`;
}

function alignedConfigErrorLine (label: string, value: string | number): string {
    return `${label.padEnd(DISCORD_CONFIG_ERROR_LABEL_WIDTH)}${value}`;
}

export function createConfigErrorIssue (details: string, fix: string, configLineText: string, configLineNumber: number, evaluator: string | undefined): EvaluatorVariablesValidationIssue {
    const issue: EvaluatorVariablesValidationIssue = {
        severity: "error",
        message: details,
        configError: {
            evaluator,
            details,
            fix,
            configLineText: truncateConfigLineText(configLineText),
            configLineNumber,
        },
    };

    return issue;
}

export function formatConfigErrorForReddit (issue: ConfigErrorDetails): string {
    return [
        "**Config Error**",
        "",
        `Evaluator: ${issue.evaluator ?? "unknown"}`,
        `Details: ${issue.details}`,
        `Fix: ${issue.fix}`,
        `Config line text: ${issue.configLineText}`,
        `Config line #: ${issue.configLineNumber}`,
    ].join("\n");
}

export function formatConfigErrorForDiscord (issue: ConfigErrorDetails): string {
    return [
        "**Config Error**",
        "```text",
        alignedConfigErrorLine("Evaluator:", issue.evaluator ?? "unknown"),
        alignedConfigErrorLine("Details:", issue.details),
        alignedConfigErrorLine("Fix:", issue.fix),
        alignedConfigErrorLine("Config line text:", issue.configLineText),
        alignedConfigErrorLine("Config line #:", issue.configLineNumber),
        "```",
    ].join("\n");
}

export function formatValidationIssueForReddit (issue: EvaluatorVariablesValidationIssue): string {
    if (issue.configError) {
        return formatConfigErrorForReddit(issue.configError);
    }

    return `${issue.severity}: ${issue.message}`;
}

export function formatValidationIssueForDiscord (issue: EvaluatorVariablesValidationIssue): string {
    if (issue.configError) {
        return formatConfigErrorForDiscord(issue.configError);
    }

    return `**${issue.severity}:** ${issue.message}`;
}

export function buildEvaluatorVariablesErrorRedditMessage (issues: EvaluatorVariablesValidationIssue[]): string {
    return [
        "There are problems in the evaluator variables config. Please check the wiki page and try again.",
        "",
        issues.map(formatValidationIssueForReddit).join("\n\n---\n\n"),
        "",
        "Last known good values will be used until the issue is resolved.",
    ].join("\n");
}

export function buildEvaluatorVariablesErrorDiscordMessage (username: string, issues: EvaluatorVariablesValidationIssue[]): string {
    return [
        `/u/${username} has updated the evaluator config, but there is an error. Please check and correct it as soon as possible.`,
        "",
        issues.map(formatValidationIssueForDiscord).join("\n\n"),
        "",
        "Last known good values will be used until the issue is resolved.",
    ].join("\n");
}
