import * as http from 'http';
import * as WebSocket from 'ws';

export interface CDPConfig {
    host: string;
    port: number;
    undoThreshold: number;
}

export class CDPService {
    public isProcessing: boolean = false;
    
    private ws: WebSocket | null = null;
    private sessionId: string | null = null;
    private msgId = 1;
    private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void, timer: NodeJS.Timeout }>();

    // Store current config to detect if host/port changed and we need to reconnect
    private currentHost: string = '';
    private currentPort: number = 0;

    public async checkAndRetry(config: CDPConfig): Promise<'RETRIED' | 'NO_ERROR' | 'NOT_FOUND'> {
        if (this.isProcessing) return 'NO_ERROR';
        this.isProcessing = true;
        
        try {
            // Reconnect if config changed
            if (this.currentHost !== config.host || this.currentPort !== config.port) {
                this.disconnect();
                this.currentHost = config.host;
                this.currentPort = config.port;
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionId) {
                const connected = await this.connect();
                if (!connected) return 'NOT_FOUND';
            }

            const result = await this.evaluatePayload(config.undoThreshold);
            return result;
        } catch (e) {
            console.error('CDP Error:', e);
            this.disconnect();
            return 'NOT_FOUND';
        } finally {
            this.isProcessing = false;
        }
    }

    public forceDisconnect() {
        this.disconnect();
    }

    private httpGet(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const req = http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', () => resolve(null));
            req.setTimeout(2000, () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    private async connect(): Promise<boolean> {
        this.disconnect();
        
        const baseUrl = `http://${this.currentHost}:${this.currentPort}`;

        // 1. Fetch browser version to get debugger URL
        const versionData = await this.httpGet(`${baseUrl}/json/version`);
        if (!versionData) return false;
        
        let browserWsUrl;
        try {
            browserWsUrl = JSON.parse(versionData).webSocketDebuggerUrl;
        } catch (e) {
            return false;
        }
        if (!browserWsUrl) return false;

        // 2. Fetch all targets
        const targetsData = await this.httpGet(`${baseUrl}/json`);
        if (!targetsData) return false;

        let targets;
        try {
            targets = JSON.parse(targetsData);
        } catch (e) {
            return false;
        }

        let targetId: string | null = null;

        for (const p of targets) {
            if (p.type === 'page' || p.type === 'webview') {
                // Ignore general IDE panels
                if (p.title && (p.title.includes('MCP Server') || p.title.includes('Launchpad') || p.title.includes('Manager'))) continue;
                if (p.webSocketDebuggerUrl) {
                    targetId = p.id;
                    break;
                }
            }
        }

        if (!targetId) return false;

        // 3. Establish persistent WebSocket connection
        return new Promise((resolve) => {
            const ws = new WebSocket(browserWsUrl);
            const connectTimeout = setTimeout(() => {
                ws.terminate();
                resolve(false);
            }, 3000);

            ws.on('open', () => {
                clearTimeout(connectTimeout);
                this.ws = ws;
                
                const id = this.msgId++;
                // 4. Attach to Target (flat session mode)
                // We use a pending request to wait for the attachedToTarget event
                const attachPromise = new Promise<boolean>((resolveAttach) => {
                    this.pendingRequests.set(id, {
                        resolve: (msg) => {
                            if (msg.result && msg.result.sessionId) {
                                this.sessionId = msg.result.sessionId;
                                resolveAttach(true);
                            } else {
                                resolveAttach(false);
                            }
                        },
                        reject: () => resolveAttach(false),
                        timer: setTimeout(() => {
                            this.pendingRequests.delete(id);
                            resolveAttach(false);
                        }, 3000)
                    });
                });

                ws.send(JSON.stringify({
                    id: id,
                    method: 'Target.attachToTarget',
                    params: { targetId: targetId, flatten: true }
                }));

                attachPromise.then(success => {
                    resolve(success);
                });
            });

            ws.on('message', (data: any) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString());
                } catch (e) {
                    console.error('Failed to parse CDP message:', e);
                    return;
                }

                // In flat sessions, sessionId is sometimes delivered before the response to attachToTarget
                if (msg.method === 'Target.attachedToTarget' && !this.sessionId) {
                     this.sessionId = msg.params.sessionId;
                }

                // Resolve any pending requests (like attachToTarget response)
                if (msg.id && this.pendingRequests.has(msg.id)) {
                    const req = this.pendingRequests.get(msg.id)!;
                    clearTimeout(req.timer);
                    this.pendingRequests.delete(msg.id);
                    req.resolve(msg);
                }
            });

            ws.on('error', () => {
                this.disconnect();
                resolve(false);
            });

            ws.on('close', () => {
                this.disconnect();
            });
        });
    }

    private disconnect() {
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
            this.ws = null;
        }
        this.sessionId = null;
        for (const req of this.pendingRequests.values()) {
            clearTimeout(req.timer);
            req.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
    }

    private evaluatePayload(undoThreshold: number): Promise<'RETRIED' | 'NO_ERROR'> {
        return new Promise((resolve, reject) => {
            if (!this.ws || !this.sessionId) {
                return reject(new Error('No WS or sessionId'));
            }

            // We inject the undoThreshold directly into the expression string.
            const expression = `(() => {
                return new Promise(async (resolve) => {
                    async function processChat(doc) {
                        const sleep = ms => new Promise(r => setTimeout(r, ms));
                        const panel = doc.querySelector('.antigravity-agent-side-panel');
                        if (!panel) return null;
                        
                        if (!panel.innerText.includes('Agent terminated due to error')) {
                            return null;
                        }

                        // Determine how many seconds the agent worked before the error
                        const textNodes = [];
                        const walker = doc.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null, false);
                        let node;
                        while ((node = walker.nextNode())) {
                            if (node.nodeValue.includes('Worked for')) {
                                textNodes.push(node.nodeValue);
                            }
                        }

                        if (textNodes.length === 0) return null;

                        const lastWorkedText = textNodes[textNodes.length - 1];
                        const match = lastWorkedText.match(/Worked for (\\d+)s/);
                        let seconds = -1;
                        if (match && match[1]) {
                            seconds = parseInt(match[1], 10);
                        }

                        // Configurable threshold (e.g. 1)
                        const threshold = ${undoThreshold};

                        // Logic for Retry vs Undo
                        if (threshold > 0 && seconds >= 0 && seconds <= threshold) {
                            // Time worked is within the threshold, so we perform the Undo logic
                            const undoButtons = Array.from(panel.querySelectorAll('button, div[role="button"], span[role="button"]')).filter(btn => {
                                const title = btn.getAttribute('title') || '';
                                const ariaLabel = btn.getAttribute('aria-label') || '';
                                const tooltipId = btn.getAttribute('data-tooltip-id') || '';
                                return title.includes('Undo') || ariaLabel.includes('Undo') || tooltipId.includes('undo-') || btn.innerHTML.includes('Undo');
                            });

                            if (undoButtons.length > 0) {
                                const lastUndoBtn = undoButtons[undoButtons.length - 1];
                                lastUndoBtn.click();

                                await sleep(200); 
                                const confirmBtn = Array.from(doc.querySelectorAll('button')).find(btn => 
                                    btn.innerText && btn.innerText.includes('Confirm')
                                );
                                if (confirmBtn) confirmBtn.click();
                                
                                await sleep(1000); 
                                
                                // Robust click helper to ensure React handles the event
                                function robustClick(el) {
                                    const targetWindow = el.ownerDocument.defaultView || window;
                                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: targetWindow }));
                                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: targetWindow }));
                                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: targetWindow }));
                                }

                                const inputBox = panel.querySelector('#antigravity\\\\.agentSidePanelInputBox, textarea, [contenteditable="true"]');
                                if (inputBox) {
                                    robustClick(inputBox);
                                    inputBox.focus();
                                    await sleep(100);
                                }

                                const possibleBtns = Array.from(panel.querySelectorAll('button, [role="button"], a, div.clickable, span.clickable')).filter(btn => {
                                    const html = btn.innerHTML.toLowerCase();
                                    const title = (btn.getAttribute('title') || '').toLowerCase();
                                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                                    const cls = (btn.className || '').toString().toLowerCase();
                                    
                                    return title.includes('send') || title.includes('submit') || 
                                           aria.includes('send') || aria.includes('submit') || 
                                           cls.includes('send') || cls.includes('submit') || 
                                           html.includes('codicon-send') || html.includes('codicon-arrow-right') || html.includes('arrow');
                                });

                                const sendBtn = possibleBtns.filter(btn => btn.offsetParent !== null).pop();

                                if (sendBtn) {
                                    robustClick(sendBtn);
                                } else if (inputBox) {
                                    const enterEvent = new KeyboardEvent('keydown', {
                                        bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter'
                                    });
                                    inputBox.dispatchEvent(enterEvent);
                                }
                                return 'RETRIED';
                            }
                        } else {
                            // If threshold is 0 (Undo disabled) OR worked seconds > threshold, just click Retry
                            const retryButtons = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Retry'));
                            if (retryButtons.length > 0) {
                                retryButtons[0].click();
                                return 'RETRIED';
                            }
                        }

                        return null;
                    }

                    let result = await processChat(document);
                    if (result) {
                        resolve(result);
                        return;
                    }

                    // Also search in iframes
                    for (const frame of document.querySelectorAll('iframe, webview')) {
                        try {
                            if (frame.contentWindow && frame.contentWindow.document) {
                                result = await processChat(frame.contentWindow.document);
                                if (result) {
                                    resolve(result);
                                    return;
                                }
                            }
                        } catch (e) { }
                    }
                    resolve('NO_ERROR');
                });
            })()`;

            const id = this.msgId++;
            this.pendingRequests.set(id, {
                resolve: (msg) => {
                    if (msg.result && msg.result.result) {
                        resolve(msg.result.result.value === 'RETRIED' ? 'RETRIED' : 'NO_ERROR');
                    } else {
                        resolve('NO_ERROR');
                    }
                },
                reject: reject,
                timer: setTimeout(() => {
                    this.pendingRequests.delete(id);
                    reject(new Error('Timeout'));
                }, 5000)
            });

            // Evaluate script in context
            this.ws.send(JSON.stringify({
                sessionId: this.sessionId,
                id: id,
                method: 'Runtime.evaluate',
                params: { expression: expression, awaitPromise: true, returnByValue: true }
            }));
        });
    }
}
