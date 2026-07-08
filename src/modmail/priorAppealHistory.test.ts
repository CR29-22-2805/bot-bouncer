import type { ControlSubSettings } from "../settings.js";
import { getPriorAppealHistoryWarningDays } from "./priorAppealHistory.js";

function settings (priorAppealHistoryWarningDays?: number): ControlSubSettings {
    return {
        evaluationDisabled: false,
        reporterBlacklist: [],
        trustedSubmitters: [],
        priorAppealHistoryWarningDays,
    };
}

test("prior appeal history warning days is disabled when no positive setting is configured", () => {
    expect(getPriorAppealHistoryWarningDays(settings())).toBeUndefined();
    expect(getPriorAppealHistoryWarningDays(settings(0))).toBeUndefined();
    expect(getPriorAppealHistoryWarningDays(settings(-1))).toBeUndefined();
});

test("prior appeal history warning days uses configured positive values", () => {
    expect(getPriorAppealHistoryWarningDays(settings(14))).toBe(14);
    expect(getPriorAppealHistoryWarningDays(settings(45))).toBe(45);
});
