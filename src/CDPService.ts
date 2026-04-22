import * as http from 'http';
import * as WebSocket from 'ws';
import { getAgentScriptExpression } from './agent-script';

export interface CDPConfig {
    host: string;
    port: number;
    undoThreshold: number;
}

export interface Logger {
    log: (msg: string) => void;
    error: (msg: string, err?: any) => void;
}

export class CDPService {
    public isProcessing: boolean = false;

    constructor(private logger?: Logger) {}
    
    private ws: WebSocket | null = null;
    private msgId = 1;
    private pendingRequests = new Map<number, { resolve: (val: any) => void, reject: (err: any) => void, timer: NodeJS.Timeout }>();

    // Store current config to detect if host/port changed and we need to reconnect
    private currentHost: string = '';
    private currentPort: number = 0;
    private lastConnectionFailed: boolean = false;

    public async checkAndRetry(config: CDPConfig): Promise<{ action: 'RETRIED' | 'NO_ERROR' | 'NOT_FOUND', logMsg?: string }> {
        if (this.isProcessing) return { action: 'NO_ERROR' };
        this.isProcessing = true;
        
        try {
            // Reconnect if config changed
            if (this.currentHost !== config.host || this.currentPort !== config.port) {
                this.logger?.log(`Config changed, reconnecting to ${config.host}:${config.port}`);
                this.disconnect();
                this.currentHost = config.host;
                this.currentPort = config.port;
                this.lastConnectionFailed = false;
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                if (!this.lastConnectionFailed) {
                    this.logger?.log(`Connecting to CDP at ${config.host}:${config.port}...`);
                }
                
                const connected = await this.connect();
                if (!connected) {
                    if (!this.lastConnectionFailed) {
                        this.logger?.error('Failed to connect to CDP. Polling will continue silently.');
                        this.lastConnectionFailed = true;
                    }
                    return { action: 'NOT_FOUND' };
                }
                
                if (this.lastConnectionFailed) {
                    this.logger?.log('Successfully reconnected to CDP.');
                } else {
                    this.logger?.log('Connected to CDP successfully.');
                }
                this.lastConnectionFailed = false;
            }

            const result = await this.evaluatePayload(config.undoThreshold);
            return result;
        } catch (e) {
            this.logger?.error('CDP Error:', e);
            console.error('CDP Error:', e);
            this.disconnect();
            return { action: 'NOT_FOUND' };
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
                    this.logger?.error('Failed to parse CDP message:', e);
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
            this.logger?.log('CDP connection closed.');
        }
        for (const req of this.pendingRequests.values()) {
            clearTimeout(req.timer);
            req.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
    }

    private async evaluatePayload(undoThreshold: number): Promise<{ action: 'RETRIED' | 'NO_ERROR' | 'NOT_FOUND', logMsg?: string }> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }

        // 1. Get all available targets
        const targetsRes = await this.sendCdp('Target.getTargets');
        if (!targetsRes || !targetsRes.targetInfos) {
            return { action: 'NO_ERROR' };
        }

        // 2. Filter relevant targets (webviews or main pages)
        const relevantTargets = targetsRes.targetInfos.filter((p: any) => {
            if (p.type !== 'page' && p.type !== 'webview' && p.type !== 'iframe') return false;
            // Ignore general IDE panels that are known not to be the agent
            if (p.title && (p.title.includes('MCP Server') || p.title.includes('Launchpad') || p.title.includes('Manager'))) return false;
            return true;
        });

        // 3. The injected script
        const expression = getAgentScriptExpression(undoThreshold);

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

                if (resultValue && resultValue.action === 'RETRIED') {
                    return resultValue;
                }
                if (resultValue && resultValue.action === 'NO_ERROR') {
                    panelFound = true; // Found the panel, but no error
                    return { action: 'NO_ERROR' };
                }
            } catch (e) {
                // Ignore attachment or evaluation errors for this target, just move to the next
                if (sessionId) {
                    try { await this.sendCdp('Target.detachFromTarget', { sessionId }); } catch (_) {}
                }
            }
        }

        return panelFound ? { action: 'NO_ERROR' } : { action: 'NOT_FOUND' };
    }
}
