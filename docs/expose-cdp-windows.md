# Instructions for Setting Up Remote Access to Chrome DevTools Protocol (CDP) in Windows 11

This guide describes how to make the CDP port (default 9221) accessible to external devices (e.g., from WSL or another machine on the local network) when the standard `--remote-debugging-address=0.0.0.0` flag fails to work.

## 📖 Background: Why is this necessary?

By design, when you start Chrome or Electron-based applications (like VS Code or Antigravity) with the `--remote-debugging-port` flag, the CDP server binds exclusively to the `localhost` (`127.0.0.1`) interface for security reasons. 

While Chrome *does* have a `--remote-debugging-address` flag that theoretically allows you to bind it to `0.0.0.0` (all interfaces), this flag is often ignored or blocked on Windows due to internal security policies or how certain IDEs wrap the Chromium engine.

As a result, if you try to connect to the debugger from a Remote SSH session, another machine on your network, or a WSL instance (which runs on a separate virtual network by default), the connection will be refused because the port is simply not listening on your machine's external IP address.

To bypass this limitation, we use Windows `netsh portproxy` to intercept traffic coming to your external IP address and forward it internally to `127.0.0.1`, effectively tricking Chrome into thinking the connection is originating locally.

---

## ⚡ Automated Setup (Recommended)
For your convenience, there is a `setup-cdp-port.bat` script in this folder that handles everything automatically.

1. Run `setup-cdp-port.bat`.
2. Allow execution as Administrator if prompted.
3. The script will automatically find your local IP address, ask for the port (default 9221), and configure port forwarding and the firewall.

---

## 🛠 Manual Setup

If you prefer to configure everything manually, follow the steps below.

### 1. Configure Port Proxying
Since Chrome often binds only to `127.0.0.1`, you need to configure Windows to redirect incoming traffic from the external interface to the local loopback.

1. Open **PowerShell** as **Administrator**.
2. Run the following command:
```powershell
netsh interface portproxy add v4tov4 listenport=9221 listenaddress=192.168.1.2 connectport=9221 connectaddress=127.0.0.1
```

## 2. Configure Windows Firewall
You need to open port 9221 for inbound connections.

1. In PowerShell (as Administrator), run:
```powershell
New-NetFirewallRule -DisplayName "Allow CDP Remote Debugging" -Direction Inbound -LocalPort 9221 -Protocol TCP -Action Allow
```

## 3. Launch Chrome
Ensure all existing Chrome processes are completely closed before starting.

Launch Chrome with the remote debugging port flag:
```cmd
chrome.exe --remote-debugging-port=9221
```

## 4. Test the Connection
From the remote machine or WSL, make a request to the Windows host's IP address:

*Replace 192.168.1.2 with the actual IP address of your Windows machine*
```bash
curl http://192.168.1.2:9221/json/version
```

If the setup was successful, you will receive a JSON response.

---

## Additional Commands

### View current port proxy rules:
```powershell
netsh interface portproxy show all
```

### Delete a port proxy rule:
```powershell
netsh interface portproxy delete v4tov4 listenport=9221 listenaddress=192.168.1.2
```

## Automation and Persistence

### Do these settings persist after reboot?
*   **Netsh Portproxy:** Yes, it is saved in the registry and persists across reboots.
*   **Firewall Rule:** Yes, the rule remains permanently active.

### What to do if it stops working after a reboot?
Sometimes the `iphlpsvc` (IP Helper) service, which is responsible for port proxying, starts too early. If the connection drops, try restarting the service via PowerShell as Administrator:
```powershell
Restart-Service iphlpsvc
```

To solve this problem permanently, change the service startup type to "Automatic (Delayed Start)":
```powershell
Set-Service iphlpsvc -StartupType AutomaticDelayedStart
```

### How to make Chrome always launch with debugging?
To avoid typing the command every time, edit your Chrome shortcut:
1. Right-click the Chrome shortcut -> **Properties**.
2. In the **Target** field, append the following to the end (separated by a space): `--remote-debugging-port=9221`.
3. Click OK. Chrome will now always launch in debug mode.

### Security
> [!CAUTION]
> The CDP protocol does not require authentication. Any device on your network will be able to gain full control over the browser. Use this setup only in trusted networks.
