// @ts-nocheck
export function getAgentScriptExpression(undoThreshold: number): string {
    const injectedFunction = async function(threshold: number) {
        // Utility function to wait for a condition instead of hard sleep
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        function robustClick(el: Element) {
            const targetWindow = el.ownerDocument?.defaultView || window;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: targetWindow }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: targetWindow }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: targetWindow }));
        }

        const panels = Array.from(document.querySelectorAll('.antigravity-agent-side-panel'));
        if (panels.length === 0) return { action: 'NOT_FOUND' };
        
        let foundPanelWithoutError = false;

        for (const panel of panels) {
            const retryBtns = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Retry'));
            const errorBannerExists = panel.textContent?.includes('Agent terminated due to error');
            
            if (!errorBannerExists || retryBtns.length === 0) {
                foundPanelWithoutError = true;
                continue; // Check next panel
            }
        
            const retryBtn = retryBtns[retryBtns.length - 1];

            const chatTurns = Array.from(panel.querySelectorAll('.flex.items-start')).filter(el => {
                const text = el.textContent || '';
                if (text.includes('Ask anything') || text.includes('PlanMediaMentionsWorkflows')) return false;
                if (text.trim().length === 0) return false;
                return true;
            });

            let seconds = -1;
            let logMsg = "No 'Worked for' found in the last message block. Performing Retry.";

            if (chatTurns.length > 0) {
                const lastTurn = chatTurns[chatTurns.length - 1];
                const match = (lastTurn.textContent || '').match(/Worked for (\d+)(s|m)/);
                
                if (match && match[1]) {
                    const val = parseInt(match[1], 10);
                    seconds = match[2] === 'm' ? val * 60 : val;
                    logMsg = `Found time in last message block: Worked for ${match[1]}${match[2]} (${seconds}s). `;
                }
            }

            if (seconds >= 0 && threshold > 0 && seconds <= threshold) {
                logMsg += `Time is within threshold (${threshold}s). Performing Undo.`;
                
                const targetBlock = chatTurns.length > 0 ? chatTurns[chatTurns.length - 1] : panel;
                const undoButtons = Array.from(targetBlock.querySelectorAll('button, div[role="button"], span[role="button"], i, span')).filter(btn => {
                    const title = (btn.getAttribute('title') || '').toLowerCase();
                    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const tooltipId = (btn.getAttribute('data-tooltip-id') || '').toLowerCase();
                    const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                    const cls = (btn.className || '').toString().toLowerCase();
                    const txt = (btn.textContent || '').trim().toLowerCase();

                    // Explicitly avoid clicking Accept all / Reject all
                    if (txt.includes('accept all') || txt.includes('reject all')) return false;

                    if (title.includes('undo') || ariaLabel.includes('undo') || tooltipId.includes('undo') || testId.includes('undo') || testId.includes('revert')) return true;

                    if (btn.tagName.toLowerCase() === 'i' || btn.tagName.toLowerCase() === 'span') {
                        if (cls.includes('undo') || cls.includes('revert')) return true;
                        if (txt === 'undo' || txt === 'revert') return true;
                    }
                    return false;
                });

                if (undoButtons.length > 0) {
                    // First dismiss the error banner to unblock UI
                    const dismissBtns = Array.from(panel.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Dismiss'));
                    if (dismissBtns.length > 0) {
                        robustClick(dismissBtns[dismissBtns.length - 1]);
                        await sleep(300);
                    }

                    const lastUndoBtn = undoButtons[undoButtons.length - 1];
                    robustClick(lastUndoBtn);

                    // Smart wait for Confirm button
                    const getConfirmBtn = () => Array.from(document.querySelectorAll('button')).filter(btn => btn.innerText && btn.innerText.includes('Confirm')).pop();
                    let confirmBtn = getConfirmBtn();
                    if (!confirmBtn) {
                        const startWait = Date.now();
                        while (Date.now() - startWait < 2000) {
                            await sleep(100);
                            confirmBtn = getConfirmBtn();
                            if (confirmBtn) break;
                        }
                    }

                    if (confirmBtn) robustClick(confirmBtn);
                    
                    // Smart wait for Input box
                    let inputBox = panel.querySelector('#antigravity\\.agentSidePanelInputBox, textarea, [contenteditable="true"]');
                    if (!inputBox) {
                        const startWait = Date.now();
                        while (Date.now() - startWait < 2000) {
                            await sleep(100);
                            inputBox = panel.querySelector('#antigravity\\.agentSidePanelInputBox, textarea, [contenteditable="true"]');
                            if (inputBox) break;
                        }
                    }

                    if (inputBox) {
                        robustClick(inputBox);
                        (inputBox as HTMLElement).focus();
                        await sleep(100);
                    }

                    const possibleBtns = Array.from(panel.querySelectorAll('button, [role="button"], a, div.clickable, span.clickable')).filter(btn => {
                        const title = (btn.getAttribute('title') || '').toLowerCase();
                        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                        const cls = (btn.className || '').toString().toLowerCase();
                        const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        
                        // Explicitly avoid clicking Accept all / Reject all
                        if (txt.includes('accept all') || txt.includes('reject all')) return false;

                        if (title.includes('send') || title.includes('submit') || 
                               aria.includes('send') || aria.includes('submit') || 
                               testId.includes('send') || testId.includes('submit') ||
                               cls.includes('send') || cls.includes('submit')) return true;
                        
                        const html = btn.innerHTML.toLowerCase();
                        if (html.includes('codicon-send') || html.includes('codicon-arrow-right')) return true;

                        return false;
                    }) as HTMLElement[];

                    const sendBtn = possibleBtns.filter(btn => btn.offsetParent !== null).pop();

                    if (sendBtn) {
                        robustClick(sendBtn);
                    } else if (inputBox) {
                        const enterEvent = new KeyboardEvent('keydown', {
                            bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter'
                        });
                        inputBox.dispatchEvent(enterEvent);
                    }
                    return { action: 'RETRIED', logMsg };
                } else {
                    logMsg += " But no Undo button found. Performing Retry instead.";
                    robustClick(retryBtn);
                    return { action: 'RETRIED', logMsg };
                }
            } else {
                if (seconds > threshold) {
                    logMsg += `Time exceeds threshold (${threshold}s). Performing Retry.`;
                }
                robustClick(retryBtn);
                return { action: 'RETRIED', logMsg };
            }
        } // End of panel loop
        
        return foundPanelWithoutError ? { action: 'NO_ERROR' } : { action: 'NOT_FOUND' };
    };

    return `(${injectedFunction.toString()})(${undoThreshold})`;
}
