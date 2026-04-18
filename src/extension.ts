import * as vscode from 'vscode';
import { AutoRetryManager } from './AutoRetryManager';

export function activate(context: vscode.ExtensionContext) {
    console.log('Auto-Retry Plugin is now active');

    const autoRetryManager = new AutoRetryManager();

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
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('autoRetry.pollInterval')) {
            autoRetryManager.reloadConfig();
        }
    });

    context.subscriptions.push(autoRetryManager);
}

function updateStatusBar(statusBarItem: vscode.StatusBarItem, manager: AutoRetryManager) {
    const status = manager.isEnabled ? '$(sync~spin) Auto-Retry: Вкл' : '$(sync) Auto-Retry: Выкл';
    statusBarItem.text = `${status} | Повторов: ${manager.getRetryCount()}`;
    statusBarItem.tooltip = manager.isEnabled ? 'Нажмите, чтобы выключить автоповтор' : 'Нажмите, чтобы включить автоповтор';
}

export function deactivate() {}
