import { UserFlag, UserStatus } from "../dataStore.js";
import type { ControlSubSettings } from "../settings.js";
import { clearsPriorDeniedAppealRecord, getPriorDeniedAppealWarningDays } from "./deniedAppealRecords.js";

function settings (priorDeniedAppealWarningDays?: number): ControlSubSettings {
    return {
        evaluationDisabled: false,
        reporterBlacklist: [],
        trustedSubmitters: [],
        priorDeniedAppealWarningDays,
    };
}

test("prior denied appeal warning days is disabled when no positive setting is configured", () => {
    expect(getPriorDeniedAppealWarningDays(settings())).toBeUndefined();
    expect(getPriorDeniedAppealWarningDays(settings(0))).toBeUndefined();
    expect(getPriorDeniedAppealWarningDays(settings(-1))).toBeUndefined();
});

test("prior denied appeal warning days uses configured positive values", () => {
    expect(getPriorDeniedAppealWarningDays(settings(14))).toBe(14);
    expect(getPriorDeniedAppealWarningDays(settings(45))).toBe(45);
});

test("grant statuses clear prior denied appeal records", () => {
    expect(clearsPriorDeniedAppealRecord(UserStatus.Organic)).toBe(true);
    expect(clearsPriorDeniedAppealRecord(UserFlag.HackedAndRecovered)).toBe(true);
    expect(clearsPriorDeniedAppealRecord(UserFlag.Scammed)).toBe(true);
    expect(clearsPriorDeniedAppealRecord(UserFlag.FutureNSFW)).toBe(true);
});

test("non-grant statuses do not clear prior denied appeal records", () => {
    expect(clearsPriorDeniedAppealRecord(UserStatus.Banned)).toBe(false);
    expect(clearsPriorDeniedAppealRecord(UserStatus.Purged)).toBe(false);
    expect(clearsPriorDeniedAppealRecord(UserStatus.Pending)).toBe(false);
    expect(clearsPriorDeniedAppealRecord(UserFlag.Locked)).toBe(false);
});
