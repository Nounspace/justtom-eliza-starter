# SpamFilterManager Class

The `SpamFilterManager` class is responsible for managing the spam filter functionality, including blocking users, checking if users are blocked, cleaning up inactive users, and logging reports.

## Class Structure

```typescript
class SpamFilterManager {
    private blockedUsers: { [key: string]: { username: string; count: number, lastBlockedTimestamp: number } } = {};
    private blockedUsersCount: number = 0;
    private lastReportedCount: number = 0;
    private lastReportedTimestamp: number = 0;

    public addUserToBlockList(username: string, senderId: string): void {
        // Implementation for adding user to block list
    }

    public isUserBlocked(senderId: string): boolean {
        // Implementation for checking if user is blocked
    }

    public cleanupBlockedUsers(): void {
        // Implementation for cleaning up blocked users
    }

    public logBlockedUsersReport(): void {
        // Implementation for logging blocked users report
    }
}
```

## Methods

### `addUserToBlockList(username: string, senderId: string)`

- **Description**: Adds a user to the block list if they are not already blocked.
- **Parameters**:
  - `username`: The username of the user to block.
  - `senderId`: The ID of the user to block.

### `isUserBlocked(senderId: string): boolean`

- **Description**: Checks if a user is on the block list.
- **Parameters**:
  - `senderId`: The ID of the user to check.
- **Returns**: `true` if the user is blocked, otherwise `false`.

### `cleanupBlockedUsers()`

- **Description**: Cleans up blocked users who have not been active for a specified duration.

### `logBlockedUsersReport()`

- **Description**: Logs a report of blocked users if certain conditions are met.