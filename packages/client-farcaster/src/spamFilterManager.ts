import { UUID } from "@elizaos/core";

class SpamFilterManager {
    private static instance: SpamFilterManager;
    private blockedUsers: { [key: string]: { username: string; count: number, lastBlockedTimestamp: number } } = {};
    private blockedUsersCount: number = 0;
    private lastReportedCount: number = 0;
    private lastReportedTimestamp: number = 0;

    // Private constructor
    private constructor() {}

    // Static method to get the instance
    public static getInstance(): SpamFilterManager {
        if (!SpamFilterManager.instance) {
            SpamFilterManager.instance = new SpamFilterManager();
        }
        return SpamFilterManager.instance;
    }

    public addUserToBlockList(username: string, senderId: string): void {
        const now = Date.now();
        this.cleanupBlockedUsers();

        if (!this.blockedUsers[senderId]) {
            this.blockedUsers[senderId] = {
                username: username,
                count: 1,
                lastBlockedTimestamp: now,
            };
            this.blockedUsersCount++;
        } else {
            this.blockedUsers[senderId].count++;
        }

        this.logBlockedUsersReport();
    }

    public isUserBlocked(senderId: UUID): boolean {
        return !!this.blockedUsers[senderId];
    }

    private cleanupBlockedUsers(): void {
        const now = Date.now();
        const cleanupThreshold = 48 * 60 * 60 * 1000;

        for (const userId in this.blockedUsers) {
            const user = this.blockedUsers[userId];
            if (now - user.lastBlockedTimestamp > cleanupThreshold) {
                delete this.blockedUsers[userId];
                this.blockedUsersCount--;
            }
        }
    }

    private logBlockedUsersReport(): void {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        const shouldLogReport = (this.blockedUsersCount - this.lastReportedCount >= 10) || (now - this.lastReportedTimestamp > oneHour);
        if (shouldLogReport) {
            const filteredReport = Object.entries(this.blockedUsers).map(([key, user]) => ({
                username: user.username,
                count: user.count
            }));

            console.warn(`Spam Filter report ${this.blockedUsersCount}: ${JSON.stringify(filteredReport)}`);
            this.lastReportedCount = this.blockedUsersCount;
            this.lastReportedTimestamp = now;
        }
    }
}

export default SpamFilterManager;
