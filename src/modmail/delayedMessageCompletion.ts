import { JobContext, TriggerContext } from "@devvit/public-api";
import { AppealTrackedOutcome } from "./appealOutcomeTracking.js";
import { markTrackedAppealOutcome } from "../statistics/appealOutcomeStatistics.js";

export interface RecordAppealOutcomeCompletionAction {
    type: "recordAppealOutcome";
    outcome: AppealTrackedOutcome;
    configName: string;
    conversationId: string;
    activeAppealKey: string;
}

export type DelayedMessageCompletionAction = RecordAppealOutcomeCompletionAction;

export async function isDelayedMessageCompletionRelevant (
    action: DelayedMessageCompletionAction,
    context: TriggerContext | JobContext,
): Promise<boolean> {
    return await context.redis.exists(action.activeAppealKey) > 0;
}

export async function runDelayedMessageCompletion (
    action: DelayedMessageCompletionAction,
    context: TriggerContext | JobContext,
): Promise<void> {
    if (!await isDelayedMessageCompletionRelevant(action, context)) {
        return;
    }

    try {
        await markTrackedAppealOutcome(
            action.outcome,
            action.configName,
            action.conversationId,
            context,
        );
        await context.redis.del(action.activeAppealKey);
    } catch (error) {
        console.error(
            `Failed to complete tracked appeal outcome for ${action.configName}:`,
            error instanceof Error ? error.message : String(error),
        );
    }
}
