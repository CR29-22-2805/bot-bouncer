import { expect, test } from "vitest";
import { buildConfigErrorDiscordMessage, buildConfigErrorRedditMessage, validateConfigSource, type ConfigValidationIssue } from "./configValidationMessages.js";

const issues: ConfigValidationIssue[] = [
    {
        code: "CONFIG_UNKNOWN_PROPERTY",
        key: "postTtileRegex",
        message: "The key `postTtileRegex` is not recognized.",
        suggestion: "Check for a typo or move the line under the correct config item.",
    },
];

test("labels appeal config errors distinctly", () => {
    const message = buildConfigErrorRedditMessage("appeal", issues);
    expect(message).toContain("Appeal Config Error");
    expect(message).toContain("appeal config wiki page");
    expect(message).toContain("CONFIG_UNKNOWN_PROPERTY");
});

test("labels evaluator config errors distinctly", () => {
    const message = buildConfigErrorDiscordMessage("evaluator", "some_mod", issues);
    expect(message).toContain("some_mod updated the evaluator config wiki page");
    expect(message).toContain("CONFIG_UNKNOWN_PROPERTY");
});

test("detects evaluator config numeric subreddit names and section indentation issues", () => {
    const issues = validateConfigSource(`subreddits:\n  - 12345\nregex: foo`, "evaluator");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_NUMERIC_SUBREDDIT_NEEDS_QUOTES");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_SECTION_INDENTATION_ERROR");
});

test("detects appeal config indentation and missing action issues", () => {
    const issues = validateConfigSource(`- name: test\n  evaluatorNameRegex:\n    - 'Bot Group Advanced'\narchive: true`, "appeal");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_INDENTATION_ERROR");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_MISSING_REPLY_OR_ACTION");
});

test("detects shared source-level config mistakes", () => {
    const issues = validateConfigSource(`- name: test\n  reply:\n  archive: maybe\n  messageBodyRegex: foo||bar\n  archive: true`, "appeal");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_EMPTY_REPLY");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_INVALID_ARCHIVE_VALUE");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_UNQUOTED_REGEX_SPECIAL_CHARS");
    expect(issues.map(issue => issue.code)).toContain("CONFIG_DUPLICATE_KEY");
});
