import * as vscode from 'vscode';
import { AutoRetryManager } from './AutoRetryManager';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Auto-Retry Plugin is now active');

    const outputChannel = vscode.window.createOutputChannel('Auto-Retry');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] INFO: Auto-Retry Plugin activated.`);

    const logger = {
        log: (msg: string) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] INFO: ${msg}`),
        error: (msg: string, e?: any) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ERROR: ${msg} ${e ? e : ''}`)
    };

    const autoRetryManager = new AutoRetryManager(logger);

    // Check CDP availability
    const isAvailable = await autoRetryManager.checkAvailability();
    
    if (!isAvailable) {
        logger.error('CDP WebSocket is unavailable. Please ensure VS Code was started with --remote-debugging-port.');
        vscode.window.showErrorMessage('Auto-Retry: CDP WebSocket is unavailable. Please ensure VS Code was started with --remote-debugging-port.');
        return;
    }

    logger.log('CDP WebSocket is available.');

    // Create status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'autoRetry.toggle';
    context.subscriptions.push(statusBarItem);

    // Initial update of the UI
    updateStatusBar(statusBarItem, autoRetryManager);
    statusBarItem.show();

    // Register toggle command
    const toggleCommand = vscode.commands.registerCommand('autoRetry.toggle', () => {
        autoRetryManager.toggle();
        updateStatusBar(statusBarItem, autoRetryManager);
    });
    context.subscriptions.push(toggleCommand);

    // Listen to retry counter updates to refresh the UI
    autoRetryManager.onCounterUpdated(() => {
        updateStatusBar(statusBarItem, autoRetryManager);
    });

    // Handle configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('autoRetry.pollIntervalMin') ||
            e.affectsConfiguration('autoRetry.pollIntervalMax') ||
            e.affectsConfiguration('autoRetry.cdpHost') ||
            e.affectsConfiguration('autoRetry.cdpPort') ||
            e.affectsConfiguration('autoRetry.undoThresholdSeconds')) {
            autoRetryManager.reloadConfig();
        }
    }));

    context.subscriptions.push(autoRetryManager);
}

function updateStatusBar(statusBarItem: vscode.StatusBarItem, manager: AutoRetryManager) {
    const status = manager.isEnabled ? '$(sync~spin) Auto-Retry: ON' : '$(sync) Auto-Retry: OFF';
    statusBarItem.text = `${status} | R: ${manager.getRetryCount()}`;
    statusBarItem.tooltip = manager.isEnabled ? 'Click to disable Auto-Retry' : 'Click to enable Auto-Retry';
}

export function deactivate() {}
