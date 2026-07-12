import { UserFlag, UserStatus } from "../dataStore.js";

export enum AppealTrackedOutcome {
    AutomaticDenial = "automaticDenial",
    AutomaticGrant = "automaticGrant",
}

export interface AppealOutcomeTrackingConfig {
    name: string;
    setStatus?: string;
    reply?: string;
    archive?: boolean;
    trackOutcome?: AppealTrackedOutcome;
}

export function isAppealGrantStatus (status: string | undefined): boolean {
    return status === UserStatus.Organic
        || status === UserFlag.HackedAndRecovered
        || status === UserFlag.Scammed
        || status === UserFlag.FutureNSFW;
}

export function getAppealOutcomeTrackingIssues (config: AppealOutcomeTrackingConfig): string[] {
    if (!config.trackOutcome) {
        return [];
    }

    const issues: string[] = [];
    const configLabel = `Appeal config ${config.name}`;

    if (!config.reply) {
        issues.push(`${configLabel} uses trackOutcome but does not define a public reply.`);
    }

    if (config.archive !== true) {
        issues.push(`${configLabel} uses trackOutcome but does not set archive: true.`);
    }

    const grantsAppeal = isAppealGrantStatus(config.setStatus);
    if (config.trackOutcome === AppealTrackedOutcome.AutomaticGrant && !grantsAppeal) {
        issues.push(`${configLabel} tracks an automatic grant but does not set a grant-producing status.`);
    }

    if (config.trackOutcome === AppealTrackedOutcome.AutomaticDenial && grantsAppeal) {
        issues.push(`${configLabel} tracks an automatic denial but sets a grant-producing status.`);
    }

    return issues;
}
