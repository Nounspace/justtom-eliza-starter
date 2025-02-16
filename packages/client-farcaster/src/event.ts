let latestEventId: number | undefined = undefined;

/**
 * TODO: Insert an event ID in the database
 * @param eventId Hub event ID
 */
export async function saveLatestEventId(eventId: number) {
  latestEventId = eventId;
}

/**
 * TODO: Get the latest event ID from the database
 * @returns Latest event ID
 */
export async function getLatestEvent(): Promise<number | undefined> {
  return latestEventId ? latestEventId : undefined
  
}
