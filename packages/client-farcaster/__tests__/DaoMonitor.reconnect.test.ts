import { describe, it, expect, vi, beforeEach, afterEach, Mocked } from 'vitest';
import Web3 from 'web3';
import { DaoMonitor } from '../src/DaoMonitor.web3';
import { FarcasterClient } from '../src/client';
import { IAgentRuntime, elizaLogger } from '@elizaos/core';

// --- Mocks ---
vi.mock('web3');
vi.mock('../src/client');
vi.mock('@elizaos/core', async () => {
    const original = await vi.importActual('@elizaos/core');
    return {
        ...original,
        elizaLogger: { // Mock logger to spy on it
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            log: vi.fn(),
        },
    };
});
global.fetch = vi.fn();
// --- End Mocks ---


describe('DaoMonitor Watchdog and Reconnect Logic', () => {
    let daoMonitor: DaoMonitor;
    let mockFarcasterClient: Mocked<FarcasterClient>;
    let mockRuntime: Partial<IAgentRuntime>;
    
    // Mock instances that will be created by Web3
    const mockProvider = {
        on: vi.fn(),
        disconnect: vi.fn(),
    };
    const mockLogSubscription = {
        on: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const mockBlockSubscription = {
        on: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const mockWeb3Instance = {
        eth: {
            subscribe: vi.fn(),
            Contract: vi.fn(),
            getStorageAt: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000000000000000000000000000000'),
            abi: { encodeEventSignature: vi.fn().mockReturnValue('0x123') },
        },
        utils: { toChecksumAddress: vi.fn(addr => addr) },
        currentProvider: mockProvider
    };

    beforeEach(() => {
        process.env.TEST_DAOMONITOR = 'false'; // Ensure we don't run the block scanner
        vi.useFakeTimers();
        vi.clearAllMocks();

        // Setup mock for `new Web3()` and `new Web3.providers.WebsocketProvider()`
        (Web3 as any).mockReturnValue(mockWeb3Instance);
        (Web3 as any).providers = {
            WebsocketProvider: vi.fn().mockReturnValue(mockProvider),
        };
        
        // Re-mock subscribe for each test to reset the `mockResolvedValueOnce` calls
        mockWeb3Instance.eth.subscribe
            .mockResolvedValueOnce(mockLogSubscription)
            .mockResolvedValueOnce(mockBlockSubscription);

        // Mock fetch to return a valid ABI
        (fetch as vi.Mock).mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                status: "1",
                result: JSON.stringify([{ type: "event", name: "ProposalCreated", inputs: [] }]),
            }),
        });

        // Setup Farcaster and Runtime mocks
        mockFarcasterClient = new FarcasterClient({} as any, {} as any) as Mocked<FarcasterClient>;
        mockFarcasterClient.farcasterConfig = { FARCASTER_FID: 527313 };

        mockRuntime = {
            agentId: 'test-agent',
            messageManager: { getMemoryById: vi.fn() } as any,
            composeState: vi.fn(),
            character: { name: "Test Character", style: { post: [] } } as any,
        };

        daoMonitor = new DaoMonitor(mockFarcasterClient, mockRuntime as IAgentRuntime);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('should trigger watchdog and reconnect after inactivity', { timeout: 20000 }, async () => {
        const reconnectSpy = vi.spyOn(daoMonitor, 'reconnect');
        const stopSpy = vi.spyOn(daoMonitor, 'stop');
        const startSpy = vi.spyOn(daoMonitor, 'start');
        
        // Initial start
        await daoMonitor.start();
        expect(startSpy).toHaveBeenCalledTimes(1);

        // Clear mocks that may have been called during start()
        vi.mocked(elizaLogger.warn).mockClear();

        // We need to advance time enough for the setInterval to run multiple times
        // and for the condition `now - lastBlockTime > WATCHDOG_TIMEOUT_MS` to be true.
        // The interval runs every 60s. The condition becomes true on the 3rd run (t=180s).
        await vi.advanceTimersByTimeAsync(185 * 1000); // 185 seconds

        // Check that the reconnection process was initiated
        expect(elizaLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Watchdog triggered'));
        expect(reconnectSpy).toHaveBeenCalledTimes(1);
        
        // `reconnect` calls `stop`, then `start` after a delay
        expect(stopSpy).toHaveBeenCalledTimes(1);
        
        // Wait for the 5s reconnect delay timer
        await vi.advanceTimersByTimeAsync(5000);
        
        expect(startSpy).toHaveBeenCalledTimes(2);
    });

    it('should call unsubscribe on subscriptions during stop', { timeout: 20000 }, async () => {
        await daoMonitor.start(); // This sets up the subscriptions
        await daoMonitor.stop();

        expect(mockLogSubscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(mockBlockSubscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should handle errors from unsubscribe gracefully without crashing', { timeout: 20000 }, async () => {
        // Make unsubscribe reject for both subscriptions
        mockLogSubscription.unsubscribe.mockRejectedValueOnce(new Error('Connection already closed'));
        mockBlockSubscription.unsubscribe.mockRejectedValueOnce(new Error('Connection already closed'));

        await daoMonitor.start();

        // We expect stop() to complete without throwing an unhandled rejection.
        // vitest automatically fails tests on unhandled rejections, so if this test passes, the fix is working.
        await daoMonitor.stop();

        // Check that the errors were logged
        expect(elizaLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Error during log subscription unsubscribe')
        );
        expect(elizaLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Error during block subscription unsubscribe')
        );
    });
});
