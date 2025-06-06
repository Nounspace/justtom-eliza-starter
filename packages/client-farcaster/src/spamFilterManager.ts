class SpamFilterManager {
    private blockedUsers: { [key: string]: { username: string; count: number, lastBlockedTimestamp: number } } = {};
    private blockedUsersCount: number = 0;
    private lastReportedCount: number = 0;
    private lastReportedTimestamp: number = 0;

    public addUserToBlockList(username: string, senderId: string): void {
        const now = Date.now();

        // Cleanup blocked users who have not been active for a specified duration
        this.cleanupBlockedUsers();

        if (!this.blockedUsers[senderId]) {
            this.blockedUsers[senderId] = {
                username: username,
                count: 1, // Initialize count to 1 when first blocked
                lastBlockedTimestamp: now, // Track when the user was blocked
            };
            this.blockedUsersCount++;
        } else {
            this.blockedUsers[senderId].count++; // Increment count if already blocked
        }

        this.logBlockedUsersReport();
    }

    public isUserBlocked(senderId: string): boolean {
        return !!this.blockedUsers[senderId];
    }

    public cleanupBlockedUsers(): void {
        const now = Date.now();
        const cleanupThreshold = 48 * 60 * 60 * 1000; // 48 hours in milliseconds

        // Remove users who have not been blocked for more than the threshold
        for (const userId in this.blockedUsers) {
            const user = this.blockedUsers[userId];
            if (now - user.lastBlockedTimestamp > cleanupThreshold) {
                delete this.blockedUsers[userId];
                this.blockedUsersCount--;
            }
        }
    }

    public logBlockedUsersReport(): void {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000; // One hour in milliseconds

        // Check if we need to log a warning
        const shouldLogReport = (this.blockedUsersCount - this.lastReportedCount >= 10) || (now - this.lastReportedTimestamp > oneHour);
        if (shouldLogReport) {
            const filteredReport = Object.entries(this.blockedUsers).map(([key, user]) => ({
                username: user.username,
                count: user.count
            }));

            console.warn(`Spam Filter report ${this.blockedUsersCount}: ${JSON.stringify(filteredReport)}`);
            this.lastReportedCount = this.blockedUsersCount; // Update last reported count
            this.lastReportedTimestamp = now; // Update last reported timestamp
        }
    }
}

export default SpamFilterManager;
