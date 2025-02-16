export interface FarcasterEventBusInterface {
    broadcastMessage(eventName: string, data: any): void;
    onMessageReceived(eventName: string, handler: (data: any) => void): void;
}

// Implement EventBus
export class FarcasterEventBus implements FarcasterEventBusInterface {
    private messageHandlers: Map<string, ((messageData: any) => void)[]>;

    constructor() {
        this.messageHandlers = new Map();
    }

    broadcastMessage(messageType: string, messageData: any): void {
        const handlers = this.messageHandlers.get(messageType);
        if (handlers) {
            handlers.forEach((handler) => handler(messageData));
        }
    }

    onMessageReceived(messageType: string, messageHandler: (messageData: any) => void): void {
        const handlers = this.messageHandlers.get(messageType);
        if (handlers) {
            handlers.push(messageHandler);
        } else {
            this.messageHandlers.set(messageType, [messageHandler]);
        }
    }
}