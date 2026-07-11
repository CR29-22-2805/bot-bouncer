import type { JSONValue } from "@devvit/public-api";
import {
    buildBioTextClusters,
    type UserBioText,
} from "./bioTextFinder.js";
import { getSubstitutedText } from "./substitutions.js";

test("getSubstitutedText normalizes spacing, case, and configured values", () => {
    expect(getSubstitutedText("  HEY   from Texas  ")).toBe("{{GREETING}} from {{STATE}}");
});

test("getSubstitutedText normalizes common smart punctuation", () => {
    expect(getSubstitutedText("I’m in “Texas”")).toBe("I'm in \"{{STATE}}\"");
});

test("buildBioTextClusters groups normalized variants and reports evaluator coverage", () => {
    const entries: UserBioText[] = [
        {
            username: "CoveredUser",
            bioText: "Hey from Texas",
            sourceSubreddits: ["SourceOne"],
        },
        {
            username: "UncoveredUser",
            bioText: "hiya from Alaska",
            sourceSubreddits: ["SourceTwo"],
        },
    ];

    const variables: Record<string, JSONValue> = {
        "biotext:bantext": ["^Hey"],
    };

    const { clusters } = buildBioTextClusters(
        entries,
        variables,
        2,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
        users: [
            "CoveredUser",
            "UncoveredUser",
        ],
        sourceSubreddits: [
            "SourceOne",
            "SourceTwo",
        ],
        coveredUsers: [
            "CoveredUser",
        ],
        uncoveredUsers: [
            "UncoveredUser",
        ],
        matchType: "normalized",
        highestSimilarity: 1,
        lowestSimilarity: 1,
    });
});

test("buildBioTextClusters omits clusters fully covered by the evaluator", () => {
    const entries: UserBioText[] = [
        {
            username: "FirstUser",
            bioText: "Hey from Texas",
            sourceSubreddits: ["SourceOne"],
        },
        {
            username: "SecondUser",
            bioText: "Hi from Alaska",
            sourceSubreddits: ["SourceTwo"],
        },
    ];

    const variables: Record<string, JSONValue> = {
        "biotext:bantext": [".+"],
    };

    expect(buildBioTextClusters(
        entries,
        variables,
        2,
    ).clusters).toEqual([]);
});

test("buildBioTextClusters enforces the minimum cluster size", () => {
    const entries: UserBioText[] = [
        {
            username: "FirstUser",
            bioText: "Hey from Texas",
            sourceSubreddits: ["SourceOne"],
        },
        {
            username: "SecondUser",
            bioText: "Hi from Alaska",
            sourceSubreddits: ["SourceTwo"],
        },
    ];

    expect(buildBioTextClusters(
        entries,
        {},
        3,
    ).clusters).toEqual([]);
});
