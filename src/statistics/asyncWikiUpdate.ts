import { JobContext, ScheduledJobEvent, UpdateWikiPageOptions } from "@devvit/public-api";
import { differenceInSeconds } from "date-fns";

export async function asyncWikiUpdate (event: ScheduledJobEvent<UpdateWikiPageOptions>, context: JobContext) {
    const now = Date.now();

    try {
        await context.reddit.updateWikiPage(event.data);
    } catch (error) {
        console.error(`Failed to update wiki page after ${differenceInSeconds(new Date(), now)} seconds: ${event.data.page}`, error);
    }
    console.log(`Updated wiki page: ${event.data.page}`);
}
