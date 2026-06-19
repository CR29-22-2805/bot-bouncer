import { formatConfigErrorForDiscord, formatConfigErrorForReddit, truncateConfigLineText } from "./evaluatorVariablesConfigErrors.js";
import { validateEvaluatorVariablesYamlSource } from "./evaluatorVariablesSourceValidation.js";

function configErrorDetails (yaml: string) {
    return validateEvaluatorVariablesYamlSource(yaml).map(result => result.configError).filter(details => details !== undefined);
}

test("Source validation reports list items that are not indented under their key", () => {
    const yaml = `
name: biotext
bantext:
- '^bad$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "A list item is not indented under its YAML key." && result.configLineNumber === 4 && result.evaluator === "biotext")).toBe(true);
});

test("Source validation reports regex list items with mismatched single quotes", () => {
    const yaml = `
name: badusername
regexes:
    - '^bad$
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "A regex is missing a beginning or ending single quote." && result.configLineNumber === 4 && result.evaluator === "badusername")).toBe(true);
});

test("Source validation reports regex list items that should be quoted", () => {
    const yaml = `
name: snapchatfirstparts
regexes:
    - [A-Za-z0-9_]+(?:_[A-Za-z0-9_]+){2,}$
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "A regex should be enclosed in single quotes." && result.configLineNumber === 4 && result.evaluator === "snapchatfirstparts")).toBe(true);
});

test("Source validation reports numeric subreddit names that are not quoted", () => {
    const yaml = `
name: generic
karmafarminglinksubs:
    - 55555
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "A subreddit name is missing single quotes." && result.configLineText === "- 55555" && result.evaluator === "generic")).toBe(true);
});

test("Source validation reports unexpected Bot Group Advanced attributes with a line number", () => {
    const yaml = `
name: botgroupadvanced
group1:
    name: Test Group
    userNameRegex:
        - '^bad$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "An advanced bot group attribute is invalid." && result.configLineText === "userNameRegex:" && result.configLineNumber === 5 && result.evaluator === "botgroupadvanced")).toBe(true);
});

test("Source validation reports unexpected Bot Group Advanced criteria attributes", () => {
    const yaml = `
name: botgroupadvanced
group1:
    name: Test Group
    criteria:
        every:
            - type: comment
              subredditRegex: '^AskReddit$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "An advanced bot group criteria attribute is invalid." && result.configLineText === "subredditRegex: '^AskReddit$'" && result.configLineNumber === 8 && result.evaluator === "botgroupadvanced")).toBe(true);
});

test("Source validation reports duplicate keys in the same evaluator section", () => {
    const yaml = `
name: definedhandles
regexes:
    - '^first$'
regexes:
    - '^second$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "The config key `regexes` appears more than once in the same section." && result.fix.includes("First seen on config line 3") && result.configLineNumber === 5 && result.evaluator === "definedhandles")).toBe(true);
});

test("Source validation reports duplicate Bot Group Advanced keys in the same group", () => {
    const yaml = `
name: botgroupadvanced
group1:
    name: Test Group
    usernameRegex:
        - '^first$'
    usernameRegex:
        - '^second$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "The config key `usernameRegex` appears more than once in the same section." && result.fix.includes("First seen on config line 5") && result.configLineNumber === 7 && result.evaluator === "botgroupadvanced")).toBe(true);
});

test("Source validation reports duplicate Bot Group Advanced group headers", () => {
    const yaml = `
name: botgroupadvanced
group_comments_AskReddit:
    name: First Group
group_comments_AskReddit:
    name: Second Group
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "The Bot Group Advanced group `group_comments_AskReddit` appears more than once." && result.fix.includes("First seen on config line 3") && result.configLineNumber === 5 && result.evaluator === "botgroupadvanced")).toBe(true);
});

test("Source validation reports Bot Group Advanced group headers that do not begin with group", () => {
    const yaml = `
name: botgroupadvanced
comments_AskReddit:
    name: Test Group
    usernameRegex:
        - '^bad$'
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details === "A Bot Group Advanced group header does not begin with `group`." && result.configLineText === "comments_AskReddit:" && result.configLineNumber === 3 && result.evaluator === "botgroupadvanced")).toBe(true);
});

test("Source validation does not report duplicate keys across separate criteria list items", () => {
    const yaml = `
name: botgroupadvanced
group1:
    name: Test Group
    criteria:
        every:
            - type: post
              subredditName:
                  - AskReddit
            - type: comment
              subredditName:
                  - AskReddit
`;

    const details = configErrorDetails(yaml);
    expect(details.some(result => result.details.includes("config key `type` appears more than once"))).toBe(false);
    expect(details.some(result => result.details.includes("config key `subredditName` appears more than once"))).toBe(false);
});

test("Config line text is truncated to 50 characters including the ellipsis", () => {
    const lineText = "- '^Very_Long_Regex_With_Many_Characters_1234567890$'";
    const truncated = truncateConfigLineText(lineText);

    expect(truncated.length).toBe(50);
    expect(truncated.endsWith("…")).toBe(true);
});

test("Config errors can be formatted differently for Reddit and Discord", () => {
    const yaml = `
name: botgroupadvanced
comments_AskReddit:
    name: Test Group
`;

    const [details] = configErrorDetails(yaml);
    expect(formatConfigErrorForReddit(details)).toContain("Evaluator: botgroupadvanced");
    expect(formatConfigErrorForDiscord(details)).toContain("Evaluator:        botgroupadvanced");
    expect(formatConfigErrorForDiscord(details)).toContain("```text");
});
