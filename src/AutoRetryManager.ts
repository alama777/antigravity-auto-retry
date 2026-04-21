import * as vscode from 'vscode';
import { CDPService, Logger } from './CDPService';

export class AutoRetryManager {
    public isEnabled: boolean = false;
    private retryCount: number = 0;
    private pollIntervalMinSec: number = 5;
    private pollIntervalMaxSec: number = 10;
    
    private cdpHost: string = '127.0.0.1';
    private cdpPort: number = 9221;
    private undoThresholdSeconds: number = 1;

    private timer: NodeJS.Timeout | null = null;
    private cdpService: CDPService;
    private onCounterUpdatedCallback: (() => void) | null = null;

    constructor(private logger?: Logger) {
        this.cdpService = new CDPService(logger);
        this.reloadConfig();
        this.logger?.log('AutoRetryManager initialized.');
    }

    public async checkAvailability(): Promise<boolean> {
        return await this.cdpService.checkAvailability(this.cdpHost, this.cdpPort);
    }

    public toggle() {
        this.isEnabled = !this.isEnabled;
        this.logger?.log(`Auto-Retry toggled: ${this.isEnabled ? 'ON' : 'OFF'}`);
        if (this.isEnabled) {
            this.startPolling();
        } else {
            this.stopPolling();
        }
    }

    public getRetryCount(): number {
        return this.retryCount;
    }

    public reloadConfig() {
        const config = vscode.workspace.getConfiguration('autoRetry');
        this.pollIntervalMinSec = config.get<number>('pollIntervalMin', 5);
        this.pollIntervalMaxSec = config.get<number>('pollIntervalMax', 10);
        this.cdpHost = config.get<string>('cdpHost', '127.0.0.1');
        this.cdpPort = config.get<number>('cdpPort', 9221);
        this.undoThresholdSeconds = config.get<number>('undoThresholdSeconds', 1);

        this.logger?.log(`Configuration loaded: Host=${this.cdpHost}, Port=${this.cdpPort}, PollIntervalMin=${this.pollIntervalMinSec}s, PollIntervalMax=${this.pollIntervalMaxSec}s, UndoThreshold=${this.undoThresholdSeconds}s`);
        
        // Restart timer if running to apply new interval
        if (this.isEnabled) {
            this.stopPolling();
            this.startPolling();
        }
    }

    public onCounterUpdated(callback: () => void) {
        this.onCounterUpdatedCallback = callback;
    }

    private startPolling() {
        this.stopPolling();
        // Do immediately once
        this.tick().finally(() => {
            this.scheduleNextPoll();
        });
    }

    private scheduleNextPoll() {
        if (!this.isEnabled) return;
        
        const min = this.pollIntervalMinSec;
        const max = Math.max(min, this.pollIntervalMaxSec);
        const delaySec = Math.floor(Math.random() * (max - min + 1)) + min;
        
        this.timer = setTimeout(() => {
            this.tick().finally(() => {
                this.scheduleNextPoll();
            });
        }, delaySec * 1000);
    }

    private stopPolling() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Force disconnect so host/port changes can take effect next time
        this.cdpService.forceDisconnect();
    }

    private async tick() {
        // Prevent overlapping ticks
        if (this.cdpService.isProcessing) return;

        try {
            const config = {
                host: this.cdpHost,
                port: this.cdpPort,
                undoThreshold: this.undoThresholdSeconds
            };

            const result = await this.cdpService.checkAndRetry(config);
            if (result.action === 'RETRIED') {
                if (result.logMsg) {
                    this.logger?.log(`Auto-Retry Info: ${result.logMsg}`);
                }
                this.logger?.log('Error detected! Performed Auto-Retry.');
                this.retryCount++;
                if (this.onCounterUpdatedCallback) {
                    this.onCounterUpdatedCallback();
                }
            }
        } catch (error) {
            this.logger?.error('AutoRetryManager check failed:', error);
            console.error('AutoRetryManager check failed:', error);
        }
    }

    public dispose() {
        this.stopPolling();
    }
}
