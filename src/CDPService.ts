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

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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

    public async checkAvailability(host: string, port: number): Promise<boolean> {
        const baseUrl = `http://${host}:${port}`;
        const versionData = await this.httpGet(`${baseUrl}/json/version`);
        return !!versionData;
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

    private sendCdp(method: string, params: any = {}, sessionId?: string): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket not open'));
            }

            const id = this.msgId++;
            this.pendingRequests.set(id, {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Timeout for CDP command: ${method}`));
                }, 5000) // 5s timeout
            });

            try {
                const payload: any = { id, method, params };
                if (sessionId) {
                    payload.sessionId = sessionId;
                }
                this.ws.send(JSON.stringify(payload), (err) => {
                    if (err) {
                        const req = this.pendingRequests.get(id);
                        if (req) {
                            clearTimeout(req.timer);
                            this.pendingRequests.delete(id);
                            req.reject(err);
                        }
                    }
                });
            } catch (e) {
                const req = this.pendingRequests.get(id);
                if (req) {
                    clearTimeout(req.timer);
                    this.pendingRequests.delete(id);
                    req.reject(e);
                }
            }
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

        // 2. Establish persistent WebSocket connection to the browser (root target)
        return new Promise((resolve) => {
            const ws = new WebSocket(browserWsUrl);
            const connectTimeout = setTimeout(() => {
                ws.terminate();
                resolve(false);
            }, 3000);

            ws.on('open', () => {
                clearTimeout(connectTimeout);
                this.ws = ws;
                resolve(true);
            });

            ws.on('message', (data: any) => {
                let msg;
                try {
                    msg = JSON.parse(data.toString());
                } catch (e) {
                    console.error('Failed to parse CDP message:', e);
                    return;
                }

                // Resolve any pending requests
                if (msg.id && this.pendingRequests.has(msg.id)) {
                    const req = this.pendingRequests.get(msg.id)!;
                    clearTimeout(req.timer);
                    this.pendingRequests.delete(msg.id);

                    if (msg.error) {
                        req.reject(new Error(msg.error.message));
                    } else {
                        req.resolve(msg.result);
                    }
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
        for (const req of this.pendingRequests.values()) {
            clearTimeout(req.timer);
            req.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
    }

    private async evaluatePayload(undoThreshold: number): Promise<'RETRIED' | 'NO_ERROR' | 'NOT_FOUND'> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }

        // 1. Get all available targets
        const targetsRes = await this.sendCdp('Target.getTargets');
        if (!targetsRes || !targetsRes.targetInfos) {
            return 'NO_ERROR';
        }

        // 2. Filter relevant targets (webviews or main pages)
        const relevantTargets = targetsRes.targetInfos.filter((p: any) => {
            if (p.type !== 'page' && p.type !== 'webview' && p.type !== 'iframe') return false;
            // Ignore general IDE panels that are known not to be the agent
            if (p.title && (p.title.includes('MCP Server') || p.title.includes('Launchpad') || p.title.includes('Manager'))) return false;
            return true;
        });

        // 3. The injected script
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

                    const threshold = ${undoThreshold};

                    // Helper to click securely
                    function robustClick(el) {
                        const targetWindow = el.ownerDocument.defaultView || window;
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: targetWindow }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: targetWindow }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: targetWindow }));
                    }

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
                            robustClick(lastUndoBtn);

                            await sleep(200); 
                            const confirmBtn = Array.from(doc.querySelectorAll('button')).find(btn => 
                                btn.innerText && btn.innerText.includes('Confirm')
                            );
                            if (confirmBtn) robustClick(confirmBtn);
                            
                            await sleep(1000); 

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
                            robustClick(retryButtons[0]);
                            return 'RETRIED';
                        }
                    }

                    return null;
                }

                // We evaluate exactly in the target's document
                const result = await processChat(document);
                resolve(result || 'NOT_FOUND');
            });
        })()`;

        // 4. Try evaluating in each relevant target until we find the panel
        let panelFound = false;
        
        for (const target of relevantTargets) {
            let sessionId: string | undefined;
            try {
                // Attach
                const attachRes = await this.sendCdp('Target.attachToTarget', { 
                    targetId: target.targetId, 
                    flatten: true 
                });
                if (!attachRes || !attachRes.sessionId) continue;
                
                sessionId = attachRes.sessionId;

                // Evaluate
                const evalRes = await this.sendCdp('Runtime.evaluate', { 
                    expression: expression, 
                    awaitPromise: true, 
                    returnByValue: true 
                }, sessionId);

                const resultValue = evalRes?.result?.value;

                // Detach
                await this.sendCdp('Target.detachFromTarget', { sessionId });

                if (resultValue === 'RETRIED') {
                    return 'RETRIED';
                }
                if (resultValue === 'NO_ERROR') {
                    panelFound = true; // Found the panel, but no error
                    return 'NO_ERROR';
                }
            } catch (e) {
                // Ignore attachment or evaluation errors for this target, just move to the next
                if (sessionId) {
                    try { await this.sendCdp('Target.detachFromTarget', { sessionId }); } catch (_) {}
                }
            }
        }

        return panelFound ? 'NO_ERROR' : 'NOT_FOUND';
    }
}
