import { UserStatus } from "../dataStore.js";
import { AppealTrackedOutcome, getAppealOutcomeTrackingIssues } from "./appealOutcomeTracking.js";

test("accepts a fully resolving automatic grant config", () => {
    const issues = getAppealOutcomeTrackingIssues({
        name: "Grant recovered accounts",
        setStatus: UserStatus.Organic,
        reply: "Your appeal was granted.",
        archive: true,
        trackOutcome: AppealTrackedOutcome.AutomaticGrant,
    });

    expect(issues).toEqual([]);
});

test("accepts a fully resolving automatic denial config", () => {
    const issues = getAppealOutcomeTrackingIssues({
        name: "Deny ineligible appeals",
        reply: "Your appeal was denied.",
        archive: true,
        trackOutcome: AppealTrackedOutcome.AutomaticDenial,
    });

    expect(issues).toEqual([]);
});

test("requires tracked outcomes to send a public reply and archive the conversation", () => {
    const issues = getAppealOutcomeTrackingIssues({
        name: "Incomplete grant",
        setStatus: UserStatus.Organic,
        trackOutcome: AppealTrackedOutcome.AutomaticGrant,
    });

    expect(issues).toEqual([
        "Appeal config Incomplete grant uses trackOutcome but does not define a public reply.",
        "Appeal config Incomplete grant uses trackOutcome but does not set archive: true.",
    ]);
});

test("requires automatic grants to set a grant-producing status", () => {
    const issues = getAppealOutcomeTrackingIssues({
        name: "Invalid grant",
        setStatus: UserStatus.Banned,
        reply: "Your appeal was granted.",
        archive: true,
        trackOutcome: AppealTrackedOutcome.AutomaticGrant,
    });

    expect(issues).toEqual([
        "Appeal config Invalid grant tracks an automatic grant but does not set a grant-producing status.",
    ]);
});

test("rejects denial tracking when the config grants the appeal", () => {
    const issues = getAppealOutcomeTrackingIssues({
        name: "Conflicting denial",
        setStatus: UserStatus.Organic,
        reply: "Your appeal was denied.",
        archive: true,
        trackOutcome: AppealTrackedOutcome.AutomaticDenial,
    });

    expect(issues).toEqual([
        "Appeal config Conflicting denial tracks an automatic denial but sets a grant-producing status.",
    ]);
});
