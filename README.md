# Antigravity Auto-Retry

A highly reliable, automated recovery plugin for the **Google Antigravity** IDE. This plugin leverages the Chrome DevTools Protocol (CDP) to monitor the agent's side panel and automatically click **"Retry"** or perform an **"Undo & Resubmit"** flow when the agent terminates unexpectedly due to server or network errors.

## 🚀 Features

*   **Zero-Click Recovery:** Automatically detects when the Antigravity agent crashes ("Agent terminated due to error").
*   **Smart "Undo" Handling:** If the agent fails almost immediately (e.g., within 1 second of working), the plugin can automatically Undo the prompt, confirm the deletion, and resubmit it, preventing garbage history buildup.
*   **Persistent Polling:** Background polling checks the agent state silently without stealing focus.
*   **Status Bar Integration:** Easily toggle Auto-Retry on or off directly from the Antigravity status bar. Tracks the number of successful automated retries.
*   **Cross-Panel Support:** Uses precise CDP `Target` API to find the correct agent Webview, even if multiple panels or markdown previews are open.
*   **Safe Startup Check:** Automatically verifies if CDP is available on startup and warns the user if the debugging port is closed.

## 🛠 Prerequisites

Because this extension uses the Chrome DevTools Protocol to inspect and interact with the isolated Webview DOM, **the Antigravity IDE must be launched with remote debugging enabled.**

*(Tested on Antigravity Version: 1.23.2)*

You can do this by launching the IDE from your terminal or command prompt:

```bash
code --remote-debugging-port=9222
```

*(You can also modify your Antigravity shortcut to always include this flag).*

## ⚙️ Configuration Settings

This extension contributes the following settings. You can customize them in your `settings.json`:

*   `autoRetry.cdpHost`: The host address for the Chrome DevTools Protocol. **Default: `127.0.0.1`**
*   `autoRetry.cdpPort`: The port number you passed to Antigravity via the `--remote-debugging-port` flag. **Default: `9222`**
*   `autoRetry.pollInterval`: The interval (in seconds) at which the plugin checks the agent's status. **Default: `5`**
*   `autoRetry.undoThresholdSeconds`: The time threshold (in seconds) to perform the Undo flow. If the agent crashes and worked for `<= threshold` seconds, the plugin will click *Undo*, confirm, and resubmit the prompt. If the agent worked for longer, it will just click *Retry*. Set to `0` to completely disable the Undo flow and always use Retry. **Default: `1`**

## 🎮 How to Use

1. Start Antigravity with the `--remote-debugging-port=9222` flag.
2. Open the Antigravity agent.
3. Look at the bottom right of the Antigravity Status Bar. You will see `$(sync) Auto-Retry: OFF`.
4. Click the status bar item to toggle it `ON`. The icon will spin.
5. Go grab a coffee! If the agent crashes, the plugin will handle it automatically and increment the retry counter on the status bar.

## 🐛 Known Issues & Limitations

*   **Language Dependency:** The script relies on matching English text (e.g., "Agent terminated due to error", "Worked for Xs"). If the Antigravity interface radically changes its text structure, the plugin may need an update.
*   **Requires Debugging Port:** The plugin cannot function without the `--remote-debugging-port` flag.

## 📝 License

MIT
