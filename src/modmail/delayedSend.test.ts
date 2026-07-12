const { isDelayedMessageCompletionRelevantMock, runDelayedMessageCompletionMock } = vi.hoisted(() => ({
    isDelayedMessageCompletionRelevantMock: vi.fn(),
    runDelayedMessageCompletionMock: vi.fn(),
}));

vi.mock("./delayedMessageCompletion.js", () => ({
    isDelayedMessageCompletionRelevant: isDelayedMessageCompletionRelevantMock,
    runDelayedMessageCompletion: runDelayedMessageCompletionMock,
}));

import { JobContext, TriggerContext } from "@devvit/public-api";
import { AppealTrackedOutcome } from "./appealOutcomeTracking.js";
import { processDelayedMessages, sendMessageOnDelay } from "./delayedSend.js";

const completionAction = {
    type: "recordAppealOutcome" as const,
    outcome: AppealTrackedOutcome.AutomaticDenial,
    configName: "Denial rule",
    conversationId: "conversation-1",
    activeAppealKey: "appeal~conversation-1",
};

beforeEach(() => {
    vi.clearAllMocks();
    isDelayedMessageCompletionRelevantMock.mockResolvedValue(true);
});

test("runs completion only after an immediate reply is sent and archived", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const archiveConversation = vi.fn().mockResolvedValue(undefined);
    const context = {
        reddit: { modMail: { reply, archiveConversation } },
    } as unknown as TriggerContext;

    await sendMessageOnDelay(context, {
        conversationId: "conversation-1",
        message: "Your appeal was denied.",
        archive: true,
        sendAt: new Date(),
        completionAction,
    });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(archiveConversation).toHaveBeenCalledTimes(1);
    expect(runDelayedMessageCompletionMock).toHaveBeenCalledWith(completionAction, context);
    const replyOrder = reply.mock.invocationCallOrder[0];
    const archiveOrder = archiveConversation.mock.invocationCallOrder[0];
    const completionOrder = runDelayedMessageCompletionMock.mock.invocationCallOrder[0];
    expect(replyOrder).toBeLessThan(archiveOrder);
    expect(archiveOrder).toBeLessThan(completionOrder);
});

test("runs completion after a queued reply is sent and archived", async () => {
    const queuedMessage = {
        conversationId: "conversation-1",
        message: "Your appeal was denied.",
        archive: true,
        sendAt: new Date().toISOString(),
        completionAction,
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const archiveConversation = vi.fn().mockResolvedValue(undefined);
    const redis = {
        exists: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
        zRange: vi.fn().mockResolvedValue([{ member: JSON.stringify(queuedMessage), score: Date.now() }]),
        zRem: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
        reddit: { modMail: { reply, archiveConversation } },
        redis,
        scheduler: { runJob: vi.fn() },
    } as unknown as JobContext;

    await processDelayedMessages({ data: { firstRun: true } } as never, context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(archiveConversation).toHaveBeenCalledTimes(1);
    expect(runDelayedMessageCompletionMock).toHaveBeenCalledWith(completionAction, context);
    expect(redis.zRem).toHaveBeenCalledTimes(1);
});

test("skips an automatic reply after the appeal has already been handled", async () => {
    isDelayedMessageCompletionRelevantMock.mockResolvedValue(false);
    const reply = vi.fn().mockResolvedValue(undefined);
    const archiveConversation = vi.fn().mockResolvedValue(undefined);
    const context = {
        reddit: { modMail: { reply, archiveConversation } },
    } as unknown as TriggerContext;

    await sendMessageOnDelay(context, {
        conversationId: "conversation-1",
        message: "Your appeal was denied.",
        archive: true,
        sendAt: new Date(),
        completionAction,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(archiveConversation).not.toHaveBeenCalled();
    expect(runDelayedMessageCompletionMock).not.toHaveBeenCalled();
});
