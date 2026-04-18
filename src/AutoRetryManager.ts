import * as vscode from 'vscode';
import { CDPService } from './CDPService';

export class AutoRetryManager {
    public isEnabled: boolean = false;
    private retryCount: number = 0;
    private pollIntervalSec: number = 2;
    private timer: NodeJS.Timeout | null = null;
    private cdpService: CDPService;
    private onCounterUpdatedCallback: (() => void) | null = null;

    constructor() {
        this.cdpService = new CDPService();
        this.reloadConfig();
    }

    public toggle() {
        this.isEnabled = !this.isEnabled;
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
        this.pollIntervalSec = config.get<number>('pollInterval', 2);
        
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
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = setInterval(() => this.tick(), this.pollIntervalSec * 1000);
        // Do immediately once
        this.tick();
    }

    private stopPolling() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick() {
        // Prevent overlapping ticks
        if (this.cdpService.isProcessing) return;

        try {
            const result = await this.cdpService.checkAndRetry();
            if (result === 'RETRIED') {
                this.retryCount++;
                if (this.onCounterUpdatedCallback) {
                    this.onCounterUpdatedCallback();
                }
            }
        } catch (error) {
            console.error('AutoRetryManager check failed:', error);
        }
    }

    public dispose() {
        this.stopPolling();
    }
}
