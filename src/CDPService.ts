import * as http from 'http';
import * as WebSocket from 'ws';

export class CDPService {
    public isProcessing: boolean = false;

    public async checkAndRetry(): Promise<'RETRIED' | 'NO_ERROR' | 'NOT_FOUND'> {
        this.isProcessing = true;
        try {
            // 1. Get browser websocket url and target id
            const versionData = await this.httpGet('http://127.0.0.1:9222/json/version');
            if (!versionData) return 'NOT_FOUND';
            
            const browserWsUrl = JSON.parse(versionData).webSocketDebuggerUrl;
            if (!browserWsUrl) return 'NOT_FOUND';

            const targetsData = await this.httpGet('http://127.0.0.1:9222/json');
            if (!targetsData) return 'NOT_FOUND';

            const targets = JSON.parse(targetsData);
            let targetId: string | null = null;

            for (const p of targets) {
                if (p.type === 'page' || p.type === 'webview') {
                    if (p.title && (p.title.includes('MCP Server') || p.title.includes('Launchpad') || p.title.includes('Manager'))) continue;
                    // Usually the Antigravity agent panel will match this if it has webSocketDebuggerUrl
                    if (p.webSocketDebuggerUrl) {
                        targetId = p.id;
                        break;
                    }
                }
            }

            if (!targetId) return 'NOT_FOUND';

            return await this.executeFlatSession(browserWsUrl, targetId);

        } catch (e) {
            console.error('CDP Error:', e);
            return 'NOT_FOUND';
        } finally {
            this.isProcessing = false;
        }
    }

    private httpGet(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const req = http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', () => resolve(null));
        });
    }

    private executeFlatSession(browserWsUrl: string, targetId: string): Promise<'RETRIED' | 'NO_ERROR'> {
        return new Promise((resolve) => {
            const ws = new WebSocket(browserWsUrl);
            let msgId = 1;
            let sessionId: string | null = null;
            let resolvePromise = resolve;

            // Define the payload script
            const expression = `(() => {
                return new Promise((resolve) => {
                    async function processChat(doc) {
                        const sleep = ms => new Promise(r => setTimeout(r, ms));
                        const panel = doc.querySelector('.antigravity-agent-side-panel');
                        if (!panel) return null;
                        
                        if (!doc.body.innerText.includes('Agent terminated due to error')) {
                            return null;
                        }

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

                        if (seconds === 1) {
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
                                
                                function robustClick(el) {
                                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
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
                        } else if (seconds > 1) {
                            const retryButtons = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Retry'));
                            if (retryButtons.length > 0) {
                                retryButtons[0].click();
                                return 'RETRIED';
                            }
                        }

                        return null;
                    }

                    let result = processChat(document);
                    if (result) {
                        resolve(result);
                        return;
                    }

                    (async () => {
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
                    })();
                });
            })()`;

            ws.on('open', () => {
                // Attach to Target (flat session mode)
                ws.send(JSON.stringify({
                    id: msgId++,
                    method: 'Target.attachToTarget',
                    params: { targetId: targetId, flatten: true }
                }));
            });

            const timeoutId = setTimeout(() => {
                ws.close();
                resolvePromise('NO_ERROR');
            }, 5000);

            ws.on('message', (data: any) => {
                const msg = JSON.parse(data.toString());
                
                // When attached to target
                if (msg.method === 'Target.attachedToTarget') {
                    sessionId = msg.params.sessionId;
                    // Evaluate script in context
                    ws.send(JSON.stringify({
                        sessionId: sessionId,
                        id: msgId++,
                        method: 'Runtime.evaluate',
                        params: { expression: expression, awaitPromise: true, returnByValue: true }
                    }));
                }

                // Handling evaluate result
                if (msg.id && msg.result && msg.result.result) {
                    const resultVal = msg.result.result.value;
                    if (resultVal === 'RETRIED') {
                        clearTimeout(timeoutId);
                        ws.close();
                        resolvePromise('RETRIED');
                    } else if (resultVal === 'NO_ERROR') {
                        clearTimeout(timeoutId);
                        ws.close();
                        resolvePromise('NO_ERROR');
                    }
                }
            });

            ws.on('error', () => {
                clearTimeout(timeoutId);
                resolvePromise('NO_ERROR');
            });
        });
    }
}
