(async function() {
    'use strict';

    const lh = '[Pond0x-Miner]';

    // Define GM.setValue and GM.getValue using chrome.storage.local for native Chrome extension compatibility
    // Note: GM object is defined in permissions.js with security enhancements (key validation, encryption)
    const GM = {
        getValue: (key, defaultValue) => {
            return new Promise((resolve) => {
                chrome.storage.local.get([key], (result) => {
                    if (chrome.runtime.lastError) {
                        console.error(`${lh} - Error in GM.getValue for ${key}:`, chrome.runtime.lastError);
                        resolve(defaultValue);
                        return;
                    }
                    resolve(result[key] !== undefined ? result[key] : defaultValue);
                });
            });
        },
        setValue: (key, value) => {
            return new Promise((resolve) => {
                chrome.storage.local.set({ [key]: value }, () => {
                    if (chrome.runtime.lastError) {
                        console.error(`${lh} - Error in GM.setValue for ${key}:`, chrome.runtime.lastError);
                        resolve(false);
                        return;
                    }
                    resolve(true);
                });
            });
        }
    };

    console.log(`${lh} *** MINER AUTOMATION RUNNING ***`);

    window.addEventListener('error', (event) => {
        console.warn(`${lh} - External script error: ${event.message} at ${event.filename}:${event.lineno}`);
    });

    // Utility function to sanitize DOM-derived content
    const sanitizeDomContent = (content) => {
        if (typeof content !== 'string') return '';
        // Allow alphanumeric, spaces, colons, basic punctuation, decimals, and units like "h/s"
        return content.replace(/[^a-zA-Z0-9\s:.-\/]/g, '');
    };

    // Utility function to sanitize user inputs
    const sanitizeInput = (value) => {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    };

    const getTime = () => Math.floor(new Date().getTime() / 1000);

    const searchNodeByContent = (selector, text) => {
        const nodes = document.querySelectorAll(selector);
        for (let n = 0; n < nodes.length; n++) {
            const nodeText = nodes[n].textContent?.trim();
            if (nodeText === text && nodes[n].isConnected) { // Ensure node is still in DOM
                return nodes[n];
            }
        }
        return null;
    };

    const getLCDParams = () => {
        const params = {};
        const nodeLines = document.querySelectorAll('.lcdbox');
        for (let l = 0; l < nodeLines.length; l++) {
            const nodeLine = nodeLines[l];
            const nodeChars = nodeLine.childNodes;
            let paramName = '', paramValue = '', nameOk = false;
            for (let c = 0; c < nodeChars.length; c++) {
                const content = sanitizeDomContent((nodeChars[c].textContent || '').trim().toLowerCase());
                if (!nameOk) {
                    if (content === ':') { nameOk = true; continue; }
                    if (content && content !== ' ') paramName += content;
                } else if (content && content !== ' ') paramValue += content;
            }
            if (paramName && nameOk) {
                // Special handling for hashrate to extract numeric value
                if (paramName === 'hashrate') {
                    // Extract numeric part, e.g., "123.45 h/s" -> "123.45"
                    const match = paramValue.match(/(\d*\.?\d+)/);
                    params[paramName] = match ? match[0] : '0';
                } else {
                    params[paramName] = paramValue;
                }
            }
        }
        return params;
    };

    const getTimeMS = (seconds) => seconds * 1000;

    // Add throttling variables for notifyUser
    let lastNotificationTime = 0;
    const NOTIFICATION_INTERVAL = 20000; // 20 seconds

    // Updated notifyUser function with throttling
    const notifyUser = (title, body) => {
        const now = Date.now();
        if (now - lastNotificationTime < NOTIFICATION_INTERVAL) {
            console.log(`${lh} - Notification throttled to avoid overload: ${title} - ${body}`);
            return;
        }
        lastNotificationTime = now;
        chrome.runtime.sendMessage({ type: 'notify', title, body });
    };

    const waitForPageLoad = async (maxAttempts = 30, retryDelay = 1000) => {
        let attempts = 0;
        while (document.readyState !== 'complete' && attempts < maxAttempts) {
            console.log(`${lh} - Waiting for page to fully load (attempt ${attempts + 1}/${maxAttempts})...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            attempts++;
        }
        if (document.readyState !== 'complete') {
            console.error(`${lh} - Page did not fully load after ${maxAttempts} attempts. Proceeding anyway...`);
            notifyUser('Pond0x Warning', 'Page did not fully load. Some features may not work correctly.');
        } else {
            console.log(`${lh} - Page fully loaded.`);
        }
    };
    // [Start of Part 2]
    // Part 2 includes core functions: performDailyReset, observeLCDContainer, createClaimSummaryBox

    // Initialize window.pond0xO early to avoid undefined errors
    window.pond0xO = {
        claimInterval: 30,
        runInterval: 5,
        noClaimMaxTime: 3600,
        startTime: getTime()
    };

    // Initialize variables that don't depend on async calls
    let isMiningActive = false;
    let isMiningRunning = false;
    let isClaiming = false;
    let statusLock = false; // This will be reset on reload
    let lastStatusCheckTime = 0;
    let pageReloads = 0;
    let lastClaimValue = 0;
    let lastClaimTime;
    let lastStatusMessage = '';
    let reloadReason;
    let summaryBoxCreated = false;
    let miningStatuses = [];
    let isPaused;
    let consecutiveStoppedCount = 0;
    let currentGlobalStatus = 'Unknown';
    let nextRetryTime = null;
    let runTimeout = null;
    let isAutoMode;
    let isControlPanelReady = false;
    let claimCount;
    let totalClaimed;
    let lastClaimStored;
    let pageReloadsStored;
    let reloadReasonStored;
    let claimTimes;
    let historicalClaims;
    let dailyClaims;
    let autominerManuallyStarted;
    let watchdogInterval;
    let claimIntervalMinutes;
    let smartClaimThreshold;
    let smartClaimUnit;
    let isSmartClaimEnabled;
    let lastRenderedTotalClaimed;
    let lastRenderedLastClaim;
    let isClaimWaitMode; // New variable for Claim + Wait mode

    // Reset statusLock on script initialization if a reload occurred
    if (sessionStorage.getItem('pond0xReloaded')) {
        statusLock = false;
        console.log(`${lh} - Reset statusLock due to page reload`);
        sessionStorage.removeItem('pond0xReloaded'); // Clean up
    }

    // Async function to initialize variables that depend on GM.getValue
    const initializeVariables = async () => {
        lastClaimTime = await GM.getValue('pond0xLastClaimTime', 0);
        reloadReason = await GM.getValue('pond0xReloadReason', 'Initial Load');
        isPaused = await GM.getValue('pond0xMinerIsPaused', false); // Changed to unique key for AutoMiner
        isAutoMode = await GM.getValue('pond0xIsAutoMode', true);
        claimCount = await GM.getValue('pond0xClaimCount', 0);
        totalClaimed = await GM.getValue('pond0xTotalClaimed', 0);
        lastClaimStored = await GM.getValue('pond0xLastClaim', 0);
        pageReloadsStored = await GM.getValue('pond0xPageReloads', 0);
        reloadReasonStored = await GM.getValue('pond0xReloadReason', 'Initial Load');
        claimTimes = JSON.parse(await GM.getValue('pond0xClaimTimes', '[]'));
        historicalClaims = JSON.parse(await GM.getValue('pond0xHistoricalClaims', '[]'));
        dailyClaims = JSON.parse(await GM.getValue('pond0xDailyClaims', '{}'));
        autominerManuallyStarted = await GM.getValue('pond0xAutominerStarted', false);
        watchdogInterval = await GM.getValue('pond0xWatchdogInterval', 5 * 60 * 1000);
        claimIntervalMinutes = await GM.getValue('pond0xClaimIntervalMinutes', 150);
        smartClaimThreshold = await GM.getValue('pond0xSmartClaimThreshold', 200000000);
        smartClaimUnit = await GM.getValue('pond0xSmartClaimUnit', 'Million');
        isSmartClaimEnabled = await GM.getValue('pond0xIsSmartClaimEnabled', false);
        isClaimWaitMode = await GM.getValue('pond0xIsClaimWaitMode', false); // Initialize new variable

        // Post-initialization adjustments
        lastRenderedTotalClaimed = totalClaimed;
        lastRenderedLastClaim = lastClaimValue;

        if (totalClaimed < 10000 && totalClaimed > 0) {
            console.log(`${lh} - Converting totalClaimed from ${totalClaimed} million to ${totalClaimed * 1000000} raw tokens`);
            totalClaimed *= 1000000;
            await GM.setValue('pond0xTotalClaimed', totalClaimed);
        }
        if (lastClaimStored < 10000 && lastClaimStored > 0) {
            console.log(`${lh} - Converting lastClaim from ${lastClaimStored} million to ${lastClaimStored * 1000000} raw tokens`);
            lastClaimValue = lastClaimStored * 1000000;
            await GM.setValue('pond0xLastClaim', lastClaimValue);
        } else {
            lastClaimValue = lastClaimStored;
        }

        pageReloads = pageReloadsStored + 1;
        await GM.setValue('pond0xPageReloads', pageReloads);
    };
    await initializeVariables();

    // Check if we're on the status-mini page
    if (window.location.href.startsWith('https://cary0x.github.io/status-mini/')) {
        console.log(`${lh} - Running on status-mini page, starting continuous status polling...`);

        const scrapeStatusContinuously = () => {
            let lastStatus = null;
            let intervalId = null;
            let attempt = 0;

            const pollStatus = () => {
                attempt++;
                try {
                    const statusElement = document.querySelector('p[style="font-size: 1em; font-weight: bold; margin: 1px 10px 0px 0px;"]');
                    if (statusElement && statusElement.isConnected) {
                        const statusText = sanitizeDomContent(statusElement.textContent.trim());
                        const statusMatch = statusText.match(/Mining:\s*(Stopped|Struggling|Active)/i);
                        const status = statusMatch ? `Mining: ${statusMatch[1]}` : 'Unknown';
                        console.log(`${lh} - Attempt ${attempt}: Scraped status from status-mini page: ${status}`);

                        if (status !== lastStatus) {
                            chrome.runtime.sendMessage({ type: 'statusFromTab', status: status }, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.error(`${lh} - Attempt ${attempt}: Failed to send status to background: ${chrome.runtime.lastError.message}`);
                                } else {
                                    console.log(`${lh} - Attempt ${attempt}: Sent status to background successfully: ${status}`);
                                }
                            });
                            lastStatus = status;
                        } else {
                            console.log(`${lh} - Attempt ${attempt}: Status unchanged: ${status}, skipping send`);
                        }

                        if (status === 'Mining: Active') {
                            clearInterval(intervalId);
                            console.log(`${lh} - Attempt ${attempt}: Detected "Mining: Active", stopping continuous polling`);
                        }
                    } else {
                        console.warn(`${lh} - Attempt ${attempt}: Status element not found, retrying...`);
                    }
                } catch (error) {
                    console.error(`${lh} - Attempt ${attempt}: Error in status polling loop: ${error.message}, retrying...`);
                }
            };

            intervalId = setInterval(pollStatus, 1000); // Poll every 1 second
        };

        // Start polling after the page loads
        if (document.readyState === 'complete') {
            scrapeStatusContinuously();
        } else {
            window.addEventListener('load', scrapeStatusContinuously);
        }

        // Exit the script to avoid running mining logic on the status page
        return;
    }

    const performDailyReset = async () => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const lastResetDate = new Date(await GM.getValue('pond0xLastResetDate', '1970-01-01'));
        const todayStr = today.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        const lastResetStr = lastResetDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        console.log(`${lh} - Checking last reset date: ${lastResetStr} against today: ${todayStr}`);

        if (lastResetStr !== todayStr) {
            console.log(`${lh} - New day detected. Last reset (${lastResetStr}) differs from today (${todayStr}). Performing reset now...`);
            claimCount = 0;
            totalClaimed = 0;
            pageReloads = 0;
            lastClaimValue = 0;
            await GM.setValue('pond0xClaimCount', 0);
            await GM.setValue('pond0xTotalClaimed', 0);
            await GM.setValue('pond0xPageReloads', 0);
            await GM.setValue('pond0xLastClaim', 0);
            await GM.setValue('pond0xLastResetDate', today.toISOString());
            await GM.setValue('pond0xClaimTimes', JSON.stringify([]));
            console.log(`${lh} - Reset claimCount, totalClaimed, pageReloads, lastClaimValue, and claimTimes to 0 for today: ${todayStr}`);
            await updateClaimSummaryBox();
        } else {
            console.log(`${lh} - Last reset (${lastResetStr}) is today. No reset needed.`);
        }
    };

    const observeLCDContainer = () => {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length || mutation.type === 'attributes' || mutation.type === 'characterData') {
                    // Ensure mutation.target is an Element
                    if (mutation.target.nodeType === Node.ELEMENT_NODE) {
                        const lcdContainer = mutation.target.querySelector('.screenshadow') ||
                                            mutation.target.querySelector('.bg-\\[\\#414f76\\]') ||
                                            mutation.target.querySelector('.mining-display') ||
                                            mutation.target.querySelector('.lcd-container') ||
                                            mutation.target.querySelector('.mining-section') ||
                                            mutation.target.querySelector('[class*="mining"]') ||
                                            document.querySelector('.mining-section') ||
                                            document.querySelector('[class*="mining"]');
                        if (lcdContainer && !summaryBoxCreated) {
                            const isVisible = lcdContainer.offsetWidth > 0 && lcdContainer.offsetHeight > 0;
                            console.log(`${lh} - LCD container found via observer: ${lcdContainer.tagName}.${Array.from(lcdContainer.classList).join('.')}, Visible: ${isVisible}`);
                            if (isVisible) {
                                observer.disconnect();
                                const existingBox = document.getElementById('pond0xClaimSummary');
                                if (existingBox) {
                                    existingBox.remove();
                                    console.log(`${lh} - Removed existing summary box before repositioning`);
                                }
                                createSummaryBoxNow(lcdContainer);
                                summaryBoxCreated = true;
                            } else {
                                console.log(`${lh} - LCD container found but not visible, continuing to observe...`);
                            }
                        }
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, attributes: true, characterData: true, subtree: true });
        setTimeout(() => {
            if (!summaryBoxCreated) {
                console.log(`${lh} - Observer timed out after 30 seconds, disconnecting...`);
                observer.disconnect();
                if (!document.getElementById('pond0xClaimSummary')) {
                    console.log(`${lh} - No valid LCD container found. Appending summary box to document.body as fallback...`);
                    createSummaryBoxNow(document.body);
                    summaryBoxCreated = true;
                } else {
                    console.log(`${lh} - Summary box already exists, skipping fallback creation`);
                }
            }
        }, 30000);
        return observer;
    };

    const createClaimSummaryBox = async () => {
        if (document.getElementById('pond0xClaimSummary') || summaryBoxCreated) {
            console.log(`${lh} - Summary box already created or in progress, skipping...`);
            return;
        }

        console.log(`${lh} - Attempting to create claim summary box...`);

        let lcdContainer = document.querySelector('.screenshadow') ||
                          document.querySelector('.bg-\\[\\#414f76\\]') ||
                          document.querySelector('.mining-display') ||
                          document.querySelector('.lcd-container') ||
                          document.querySelector('.mining-section') ||
                          document.querySelector('[class*="mining"]');
        let attempts = 0;
        const maxAttempts = 5;
        const retryDelay = 1000;

        while (!lcdContainer && attempts < maxAttempts) {
            console.log(`${lh} - LCD container not found (attempt ${attempts + 1}/${maxAttempts}). Retrying...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            lcdContainer = document.querySelector('.screenshadow') ||
                          document.querySelector('.bg-\\[\\#414f76\\]') ||
                          document.querySelector('.mining-display') ||
                          document.querySelector('.lcd-container') ||
                          document.querySelector('.mining-section') ||
                          document.querySelector('[class*="mining"]');
            attempts++;
        }

        if (!lcdContainer) {
            console.log(`${lh} - LCD container not found after ${maxAttempts} attempts. Starting observer and falling back to document.body...`);
            createSummaryBoxNow(document.body); // Immediate fallback
            summaryBoxCreated = true; // Mark as created to prevent duplicates
            const observer = observeLCDContainer();
            return;
        }

        const isVisible = lcdContainer.offsetWidth > 0 && lcdContainer.offsetHeight > 0;
        console.log(`${lh} - LCD container found: ${lcdContainer.tagName}.${Array.from(lcdContainer.classList).join('.')}, Visible: ${isVisible}, Dimensions: ${lcdContainer.offsetWidth}x${lcdContainer.offsetHeight}`);
        
        if (!isVisible) {
            console.log(`${lh} - LCD container is not visible, starting observer and falling back to document.body...`);
            createSummaryBoxNow(document.body); // Immediate fallback
            summaryBoxCreated = true; // Mark as created to prevent duplicates
            const observer = observeLCDContainer();
            return;
        }

        createSummaryBoxNow(lcdContainer);
        summaryBoxCreated = true; // Mark as created to prevent duplicates
    };
    // [Start of Part 3]
    // Part 3 includes the createControlPanel function

    const createControlPanel = async () => {
        if (document.getElementById('pond0xControlPanel')) {
            console.log(`${lh} - Control panel already exists, skipping creation...`);
            isControlPanelReady = true;
            return;
        }

        console.log(`${lh} - Creating control panel...`);

        try {
            await waitForPageLoad();

            const controlPanel = document.createElement('div');
            controlPanel.id = 'pond0xControlPanel';
            controlPanel.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                border: 2px solid #000000;
                border-radius: 10px;
                color: #ffffff;
                font-family: Arial, Helvetica, sans-serif;
                padding: 10px;
                z-index: 10000;
                cursor: move;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
            `;

            const formatTime = (timestamp) => {
                if (!timestamp) return 'N/A';
                const date = new Date(timestamp * 1000);
                return date.toLocaleTimeString('en-US', { hour12: false });
            };

            controlPanel.innerHTML = `
                <div style="font-weight: bold; background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
                    <div style="display: flex; align-items: center; position: relative;">
                        <span style="margin-right: 5px;">Mode:</span>
                        <input type="checkbox" id="autoToggle" ${isAutoMode ? 'checked' : ''} style="display: none;">
                        <span id="toggleLabel" style="background: ${isAutoMode ? '#28a745' : '#dc3545'}; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px; cursor: pointer; position: relative;">
                            ${isAutoMode ? 'Auto' : 'Manual'}
                        </span>
                    </div>
                    <span style="position: absolute; left: 50%; transform: translateX(-50%);">Control Panel</span>
                    <div style="visibility: hidden; display: flex; align-items: center;">
                        <span style="margin-right: 5px;">Mode:</span>
                        <span style="padding: 3px 8px; border-radius: 3px; font-size: 12px;">${isAutoMode ? 'Auto' : 'Manual'}</span>
                    </div>
                </div>
                <button id="toggleMiningBtn" style="margin-right: 5px; background: ${isMiningRunning ? '#dc3545' : '#28a745'}; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">
                    ${isMiningRunning ? (isAutoMode ? 'Stop Auto Mining' : 'Stop Manual Mining') : (isAutoMode ? 'Start Auto Mining' : 'Start Manual Mining')}
                </button>
                <button id="claimAnywayBtn" style="margin-right: 5px; background: #dc3545; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">Claim Anyway</button>
                <button id="pauseResumeBtn" style="margin-right: 5px; background: ${isPaused ? '#28a745' : '#ffc107'}; color: ${isPaused ? 'white' : 'black'}; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">${isPaused ? 'Resume' : 'Pause'}</button>
                <button id="claimWaitBtn" style="background: ${isClaimWaitMode ? '#28a745' : '#17a2b8'}; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px; position: relative;">
                    ${isClaimWaitMode ? 'Disable Claim + Wait' : 'Enable Claim + Wait'}
                </button>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-top: 5px; font-size: 11px;">
                    <strong>Global Mining Status:</strong> <span id="globalStatus">${currentGlobalStatus}</span><br>
                    <strong>Next Retry:</strong> <span id="nextRetry">${formatTime(nextRetryTime)}</span>
                </div>
                <div style="margin-top: 5px; background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px;">
                    <strong style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.replace(/.$/, this.nextElementSibling.style.display === 'none' ? '▼' : '▲');">
                        Settings ▼
                    </strong>
                    <div style="display: block;">
                        <div style="margin-top: 5px;">
                            <label id="watchdogIntervalLabel" for="watchdogIntervalInput" style="font-size: 12px;">Watchdog Interval (min):</label>
                            <input id="watchdogIntervalInput" type="number" min="0.5" max="10" step="0.1" value="${watchdogInterval / (60 * 1000)}" style="width: 50px; font-size: 12px; margin-left: 5px; background: linear-gradient(to bottom, #4a1d7d, #8a2be2); color: #ffffff; border: 1px solid #ffffff; border-radius: 5px; padding: 2px 5px;">
                        </div>
                        <div style="margin-top: 5px;">
                            <label id="claimIntervalLabel" for="claimIntervalInput" style="font-size: 12px;">Claim Interval (min):</label>
                            <input id="claimIntervalInput" type="number" min="10" max="240" value="${claimIntervalMinutes}" style="width: 50px; font-size: 12px; margin-left: 5px; background: linear-gradient(to bottom, #4a1d7d, #8a2be2); color: #ffffff; border: 1px solid #ffffff; border-radius: 5px; padding: 2px 5px;">
                        </div>
                        <div style="margin-top: 5px; display: flex; align-items: center;">
                            <label id="smartClaimThresholdLabel" for="smartClaimThresholdInput" style="font-size: 12px;">Smart Claim (<span id="smartClaimUnitLabel">${smartClaimUnit}</span>):</label>
                            <input id="smartClaimThresholdInput" type="number" min="${smartClaimUnit === 'Million' ? 200 : 0.2}" value="${smartClaimUnit === 'Million' ? smartClaimThreshold / 1000000 : smartClaimThreshold / 1000000000}" style="width: 50px; font-size: 12px; margin-left: 5px; background: linear-gradient(to bottom, #4a1d7d, #8a2be2); color: #ffffff; border: 1px solid #ffffff; border-radius: 5px; padding: 2px 5px;">
                            <select id="smartClaimUnitSelect" style="font-size: 12px; margin-left: 5px; background: linear-gradient(to bottom, #4a1d7d, #8a2be2); color: #ffffff; border: 1px solid #ffffff; border-radius: 5px; padding: 2px 5px;">
                                <option value="Million" ${smartClaimUnit === 'Million' ? 'selected' : ''}>Million</option>
                                <option value="Billion" ${smartClaimUnit === 'Billion' ? 'selected' : ''}>Billion</option>
                            </select>
                            <input type="checkbox" id="smartClaimToggle" ${isSmartClaimEnabled ? 'checked' : ''} style="display: none;">
                            <span id="smartClaimToggleLabel" style="background: ${isSmartClaimEnabled ? '#28a745' : '#dc3545'}; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px; cursor: pointer; margin-left: 5px;">
                                ${isSmartClaimEnabled ? 'On' : 'Off'}
                            </span>
                        </div>
                    </div>
                </div>
                <div style="margin-top: 5px;">
                    <button id="exportHistoryBtn" style="background: #6c757d; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">Export History</button>
                </div>
            `;

            document.body.appendChild(controlPanel);

            const tooltipBox = document.createElement('div');
            tooltipBox.id = 'tooltipBox';
            tooltipBox.style.display = 'none';
            document.body.appendChild(tooltipBox);

            const style = document.createElement('style');
            style.textContent = `
                #tooltipBox {
                    display: none;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    position: absolute;
                    background: #333;
                    color: #fff;
                    padding: 5px 10px;
                    border-radius: 5px;
                    font-size: 11px;
                    max-width: 200px;
                    max-height: 100px;
                    overflow-y: auto;
                    white-space: pre-wrap;
                    overflow-wrap: break-word;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                    z-index: 10001;
                }
                #tooltipBox.visible {
                    display: block;
                    opacity: 1;
                }
            `;
            document.head.appendChild(style);

            let isDragging = false, currentX, currentY;
            controlPanel.onmousedown = (e) => {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && e.target.id !== 'toggleLabel' && e.target.id !== 'smartClaimToggleLabel') {
                    isDragging = true;
                    currentX = e.clientX - parseInt(controlPanel.style.right);
                    currentY = e.clientY - parseInt(controlPanel.style.top);
                }
            };
            document.onmousemove = (e) => {
                if (isDragging) {
                    controlPanel.style.right = (window.innerWidth - e.clientX - controlPanel.offsetWidth) + 'px';
                    controlPanel.style.top = (e.clientY - currentY) + 'px';
                }
            };
            document.onmouseup = () => { isDragging = false; };

            const toggleMiningBtn = document.getElementById('toggleMiningBtn');
            toggleMiningBtn.addEventListener('click', async () => {
                if (isMiningRunning) {
                    const stopBtn = searchNodeByContent('button', 'STOP ANYWAYS');
                    if (stopBtn) stopBtn.click();
                    isMiningRunning = false;
                    await GM.setValue('pond0xIsMiningRunning', false);
                    notifyUser('Pond0x Mining', `Mining stopped ${isAutoMode ? 'automatically' : 'manually'}`);
                    toggleMiningBtn.textContent = isAutoMode ? 'Start Auto Mining' : 'Start Manual Mining';
                    toggleMiningBtn.style.background = '#28a745';
                } else if (!isPaused) {
                    if (isAutoMode) {
                        autominerManuallyStarted = true;
                        await GM.setValue('pond0xAutominerStarted', true);
                        console.log(`${lh} - Starting autominer, checking global status...`);
                        lastStatusMessage = 'Starting autominer, checking global status';
                        // Disable Claim + Wait mode before starting
                        if (isClaimWaitMode) {
                            isClaimWaitMode = false;
                            await GM.setValue('pond0xIsClaimWaitMode', false);
                            const claimWaitBtn = document.getElementById('claimWaitBtn');
                            if (claimWaitBtn) {
                                claimWaitBtn.textContent = 'Enable Claim + Wait';
                                claimWaitBtn.style.background = '#17a2b8';
                            }
                            console.log(`${lh} - Disabled Claim + Wait mode before starting mining session`);
                            notifyUser('Pond0x Info', 'Claim + Wait mode disabled before starting mining. Re-enable it during the session if needed.');
                        }
                        isMiningActive = await checkMiningStatus();
                        if (isMiningActive) {
                            await startMining();
                        } else {
                            console.log(`${lh} - Global mining not active. Waiting for status change...`);
                            lastStatusMessage = 'Global mining not active. Waiting for status change';
                        }
                    } else {
                        await startMining();
                    }
                    if (isMiningRunning) {
                        toggleMiningBtn.textContent = isAutoMode ? 'Stop Auto Mining' : 'Stop Manual Mining';
                        toggleMiningBtn.style.background = '#dc3545';
                    }
                }
                await updateClaimSummaryBox();
            });

            document.getElementById('claimAnywayBtn').addEventListener('click', async () => {
                const claimBtn = searchNodeByContent('button', 'STOP & Claim');
                if (claimBtn) {
                    claimBtn.click();
                    notifyUser('Pond0x Claim', 'Claim triggered manually');
                } else {
                    notifyUser('Pond0x Warning', 'No claim button found for Claim Anyway');
                }
            });

            document.getElementById('pauseResumeBtn').addEventListener('click', async () => {
                isPaused = !isPaused;
                await GM.setValue('pond0xMinerIsPaused', isPaused); // Changed to unique key for AutoMiner
                document.getElementById('pauseResumeBtn').textContent = isPaused ? 'Resume' : 'Pause';
                document.getElementById('pauseResumeBtn').style.background = isPaused ? '#28a745' : '#ffc107';
                document.getElementById('pauseResumeBtn').style.color = isPaused ? 'white' : 'black';
                notifyUser('Pond0x Status', `Autominer ${isPaused ? 'paused' : 'resumed'}`);
                if (isPaused && runTimeout) {
                    clearTimeout(runTimeout);
                    runTimeout = null;
                    nextRetryTime = null;
                    console.log(`${lh} - Cleared scheduled status check due to pause`);
                } else if (!isPaused && !runTimeout) {
                    await run();
                }
            });

            document.getElementById('claimWaitBtn').addEventListener('click', async () => {
                isClaimWaitMode = !isClaimWaitMode;
                await GM.setValue('pond0xIsClaimWaitMode', isClaimWaitMode);
                const claimWaitBtn = document.getElementById('claimWaitBtn');
                claimWaitBtn.textContent = isClaimWaitMode ? 'Disable Claim + Wait' : 'Enable Claim + Wait';
                claimWaitBtn.style.background = isClaimWaitMode ? '#28a745' : '#17a2b8';
                console.log(`${lh} - Claim + Wait mode ${isClaimWaitMode ? 'enabled' : 'disabled'}`);
                notifyUser('Pond0x Status', `Claim + Wait mode ${isClaimWaitMode ? 'enabled' : 'disabled'}`);

                if (isClaimWaitMode && !isMiningRunning && isAutoMode) {
                    // Start mining immediately if not already running
                    isMiningActive = await checkMiningStatus();
                    if (isMiningActive) {
                        console.log(`${lh} - Mining status active after enabling Claim + Wait, starting mining...`);
                        await startMining();
                    } else {
                        console.log(`${lh} - Mining status not active after enabling Claim + Wait, waiting for next check...`);
                    }
                }
            });

            document.getElementById('watchdogIntervalInput').addEventListener('change', async (e) => {
                let minutes = parseFloat(sanitizeInput(e.target.value));
                if (minutes < 0.5) minutes = 0.5;
                if (minutes > 10) minutes = 10;
                watchdogInterval = minutes * 60 * 1000;
                await GM.setValue('pond0xWatchdogInterval', watchdogInterval);
                console.log(`${lh} - Watchdog interval updated to ${watchdogInterval / (60 * 1000)} minutes`);
            });

            document.getElementById('claimIntervalInput').addEventListener('change', async (e) => {
                claimIntervalMinutes = parseInt(sanitizeInput(e.target.value));
                if (claimIntervalMinutes < 10) claimIntervalMinutes = 10; // Changed from 60 to 10
                if (claimIntervalMinutes > 240) claimIntervalMinutes = 240;
                await GM.setValue('pond0xClaimIntervalMinutes', claimIntervalMinutes);
                console.log(`${lh} - Claim interval updated to ${claimIntervalMinutes} minutes`);
            });

            document.getElementById('smartClaimThresholdInput').addEventListener('change', async (e) => {
                let value = parseFloat(sanitizeInput(e.target.value));
                const unit = document.getElementById('smartClaimUnitSelect').value;
                if (unit === 'Million') {
                    smartClaimThreshold = value * 1000000;
                    if (smartClaimThreshold < 200000000) smartClaimThreshold = 200000000;
                } else {
                    smartClaimThreshold = value * 1000000000;
                    if (smartClaimThreshold < 200000000) smartClaimThreshold = 200000000;
                }
                await GM.setValue('pond0xSmartClaimThreshold', smartClaimThreshold);
                console.log(`${lh} - Smart claim threshold updated to ${smartClaimThreshold} tokens (${formatClaimValue(smartClaimThreshold)})`);
            });

            document.getElementById('smartClaimUnitSelect').addEventListener('change', async (e) => {
                smartClaimUnit = e.target.value;
                await GM.setValue('pond0xSmartClaimUnit', smartClaimUnit);
                document.getElementById('smartClaimUnitLabel').textContent = smartClaimUnit;
                const input = document.getElementById('smartClaimThresholdInput');
                input.value = smartClaimUnit === 'Million' ? smartClaimThreshold / 1000000 : smartClaimThreshold / 1000000000;
                input.min = smartClaimUnit === 'Million' ? 200 : 0.2;
                console.log(`${lh} - Smart claim unit updated to ${smartClaimUnit}`);
            });

            document.getElementById('exportHistoryBtn').addEventListener('click', () => {
                exportClaimHistoryToCSV();
                notifyUser('Pond0x History', 'Claim history exported successfully as CSV');
            });

            const autoToggle = document.getElementById('autoToggle');
            const toggleLabel = document.getElementById('toggleLabel');
            const claimWaitBtn = document.getElementById('claimWaitBtn');
            const smartClaimToggle = document.getElementById('smartClaimToggle');
            const smartClaimToggleLabel = document.getElementById('smartClaimToggleLabel');
            const claimIntervalLabel = document.getElementById('claimIntervalLabel');
            const watchdogIntervalLabel = document.getElementById('watchdogIntervalLabel');
            const smartClaimThresholdLabel = document.getElementById('smartClaimThresholdLabel');
            const pauseResumeBtn = document.getElementById('pauseResumeBtn');

            const tooltipContent = {
                toggleMiningBtn: () => isAutoMode ? 'Auto Mode: Automatically checks mining status and starts mining when available. Handles claiming based on set thresholds.' : 'Manual Mode: Manually start and stop mining. Claiming still occurs automatically based on set thresholds.',
                claimWaitBtn: () => isClaimWaitMode ? 'Claim + Wait mode is active. The miner will mine, claim, wait 20 minutes, and repeat until this mode is disabled.' : 'Enable Claim + Wait mode to mine, claim, wait 20 minutes, and repeat automatically until disabled.',
                smartClaimToggleLabel: 'When enabled, claims occur at the set Smart Claim threshold or when hash rate hits zero. When disabled, claims only occur when hash rate hits zero.',
                claimIntervalLabel: 'Sets the maximum time interval (in minutes) after which a claim will be triggered, regardless of other conditions.',
                watchdogIntervalLabel: 'Sets how often (in minutes) the script checks for mining inactivity (0 hash rate) and restarts if needed.',
                smartClaimThresholdLabel: 'Sets the unclaimed token threshold at which a claim is triggered when Smart Claim is enabled.',
                pauseResumeBtn: 'Pauses or resumes the autominer. When paused, all automatic actions (mining, claiming, status checks) are halted until resumed.'
            };

            const showTooltip = (element) => {
                try {
                    const content = tooltipContent[element.id];
                    tooltipBox.textContent = typeof content === 'function' ? content() : content;
                    const rect = element.getBoundingClientRect();
                    tooltipBox.style.top = `${rect.bottom + window.scrollY + 5}px`;
                    tooltipBox.style.left = `${rect.left + window.scrollX}px`;
                    tooltipBox.classList.add('visible');
                    tooltipBox.style.display = 'block';
                    tooltipBox.style.opacity = '1';
                } catch (error) {
                    console.error(`${lh} - Error in showTooltip:`, error);
                }
            };

            const hideTooltip = () => {
                try {
                    tooltipBox.classList.remove('visible');
                    tooltipBox.style.display = 'none';
                    tooltipBox.style.opacity = '0';
                } catch (error) {
                    console.error(`${lh} - Error in hideTooltip:`, error);
                }
            };

            toggleMiningBtn.addEventListener('mouseenter', () => showTooltip(toggleMiningBtn));
            toggleMiningBtn.addEventListener('mouseleave', hideTooltip);
            claimWaitBtn.addEventListener('mouseenter', () => showTooltip(claimWaitBtn));
            claimWaitBtn.addEventListener('mouseleave', hideTooltip);
            smartClaimToggleLabel.addEventListener('mouseenter', () => showTooltip(smartClaimToggleLabel));
            smartClaimToggleLabel.addEventListener('mouseleave', hideTooltip);
            claimIntervalLabel.addEventListener('mouseenter', () => showTooltip(claimIntervalLabel));
            claimIntervalLabel.addEventListener('mouseleave', hideTooltip);
            watchdogIntervalLabel.addEventListener('mouseenter', () => showTooltip(watchdogIntervalLabel));
            watchdogIntervalLabel.addEventListener('mouseleave', hideTooltip);
            smartClaimThresholdLabel.addEventListener('mouseenter', () => showTooltip(smartClaimThresholdLabel));
            smartClaimThresholdLabel.addEventListener('mouseleave', hideTooltip);
            pauseResumeBtn.addEventListener('mouseenter', () => showTooltip(pauseResumeBtn));
            pauseResumeBtn.addEventListener('mouseleave', hideTooltip);

            if (toggleLabel && autoToggle) {
                toggleLabel.addEventListener('click', async () => {
                    isAutoMode = !isAutoMode;
                    await GM.setValue('pond0xIsAutoMode', isAutoMode);
                    toggleLabel.textContent = isAutoMode ? 'Auto' : 'Manual';
                    toggleLabel.style.background = isAutoMode ? '#28a745' : '#dc3545';
                    autoToggle.checked = isAutoMode;
                    toggleMiningBtn.textContent = isMiningRunning ? (isAutoMode ? 'Stop Auto Mining' : 'Stop Manual Mining') : (isAutoMode ? 'Start Auto Mining' : 'Start Manual Mining');
                    toggleMiningBtn.style.background = isMiningRunning ? '#dc3545' : '#28a745';
                });
            }

            if (smartClaimToggleLabel && smartClaimToggle) {
                smartClaimToggleLabel.addEventListener('click', async () => {
                    isSmartClaimEnabled = !isSmartClaimEnabled;
                    await GM.setValue('pond0xIsSmartClaimEnabled', isSmartClaimEnabled);
                    smartClaimToggleLabel.textContent = isSmartClaimEnabled ? 'On' : 'Off';
                    smartClaimToggleLabel.style.background = isSmartClaimEnabled ? '#28a745' : '#dc3545';
                    smartClaimToggle.checked = isSmartClaimEnabled;
                    console.log(`${lh} - Smart Claim toggle set to ${isSmartClaimEnabled ? 'enabled' : 'disabled'}`);
                });
            }

            setInterval(async () => {
                const statusSpan = document.getElementById('globalStatus');
                const retrySpan = document.getElementById('nextRetry');
                if (statusSpan) statusSpan.textContent = currentGlobalStatus;
                if (retrySpan) retrySpan.textContent = formatTime(nextRetryTime);
                await updateClaimSummaryBox();
                const toggleMiningBtn = document.getElementById('toggleMiningBtn');
                if (toggleMiningBtn) {
                    toggleMiningBtn.textContent = isMiningRunning 
                        ? (isAutoMode ? 'Stop Auto Mining' : 'Stop Manual Mining') 
                        : (isAutoMode ? 'Start Auto Mining' : 'Start Manual Mining');
                    toggleMiningBtn.style.background = isMiningRunning ? '#dc3545' : '#28a745';
                }
            }, 5000);

            console.log(`${lh} - Control panel created successfully`);
            isControlPanelReady = true;
        } catch (e) {
            console.error(`${lh} - Error creating control panel: ${e.message}`);
            notifyUser('Pond0x Error', `Error creating control panel: ${e.message}`);
            isControlPanelReady = true;
        }
    };
            // [Start of Part 4]
    // Part 4 includes the mining logic functions: checkMiningStatus, startMining, scheduleStatusCheck, run

    const checkMiningStatus = async () => {
        return new Promise(async (resolve) => {
            if (isMiningRunning) {
                console.log(`${lh} - Status check skipped: isMiningRunning=${isMiningRunning}`);
                resolve(false);
                return;
            }
            console.log(`${lh} - Checking global mining status via background polling...`);
            statusLock = true;

            const pollingStarted = await new Promise((resolvePoll) => {
                chrome.runtime.sendMessage({ type: 'startStatusPolling' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(`${lh} - Failed to send startStatusPolling message: ${chrome.runtime.lastError.message}`);
                        resolvePoll(false);
                        return;
                    }
                    if (!response?.success) {
                        console.error(`${lh} - Failed to start status polling: ${response?.error || 'Unknown error'}`);
                        resolvePoll(false);
                    } else {
                        console.log(`${lh} - Requested status polling via background script, tabId: ${response.tabId}`);
                        resolvePoll(true);
                    }
                });
            });

            if (!pollingStarted) {
                console.warn(`${lh} - Status polling failed to start. Retrying in 5 seconds...`);
                statusLock = false;
                setTimeout(() => checkMiningStatus().then(resolve), 5000);
                resolve(false);
                return;
            }

            let startedMining = false;
            let lastStatus = null;

            const handler = (message, sender, sendResponse) => {
                console.log(`${lh} - Received message from background:`, message);
                if (message.type !== 'miningStatus' || !message.status) {
                    console.warn(`${lh} - Invalid message format:`, message);
                    return;
                }

                const status = message.status;
                if (lastStatus !== status) {
                    console.log(`${lh} - Global mining status changed to "${status}"`);
                    lastStatus = status;
                }
                currentGlobalStatus = status;

                miningStatuses.push({ status, time: getTime() });
                if (miningStatuses.length > 10) miningStatuses.shift();

                const statusSpan = document.getElementById('globalStatus');
                if (statusSpan) statusSpan.textContent = currentGlobalStatus;
                updateClaimSummaryBox();

                if (status === 'Mining: Active' && !isMiningRunning && !startedMining && !isPaused) {
                    startedMining = true;
                    console.log(`${lh} - Global mining active. Starting session and stopping polling...`);
                    chrome.runtime.sendMessage({ type: 'stopStatusPolling' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error(`${lh} - Failed to send stopStatusPolling message: ${chrome.runtime.lastError.message}`);
                        } else {
                            console.log(`${lh} - Stopped status polling successfully`);
                        }
                    });
                    chrome.runtime.sendMessage({ type: 'closeStatusTab' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error(`${lh} - Failed to send closeStatusTab message: ${chrome.runtime.lastError.message}`);
                        } else {
                            console.log(`${lh} - Status-mini tab closed successfully`);
                        }
                    });
                    chrome.runtime.onMessage.removeListener(handler);
                    statusLock = false;
                    startMining().then(() => {
                        console.log(`${lh} - Mining started successfully, initiating run loop...`);
                        run(); // Start the run loop immediately after mining begins
                        resolve(true);
                    }).catch((error) => {
                        console.error(`${lh} - Error starting mining: ${error.message}`);
                        notifyUser('Pond0x Error', `Error starting mining: ${error.message}`);
                        chrome.runtime.sendMessage({ type: 'closeStatusTab' }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error(`${lh} - Failed to send closeStatusTab message: ${chrome.runtime.lastError.message}`);
                            } else {
                                console.log(`${lh} - Status-mini tab closed successfully after mining failure`);
                            }
                        });
                        statusLock = false;
                        resolve(false);
                    });
                }
            };

            chrome.runtime.onMessage.addListener(handler);
            console.log(`${lh} - Message event listener added. Waiting for continuous miningStatus messages...`);
        });
    };

    const startMining = async () => {
        if (isMiningRunning) {
            console.log(`${lh} - Mining already running, skipping startMining...`);
            statusLock = false;
            return;
        }

        statusLock = true;

        // Track retries for Auto Mode
        let mineButtonRetries = 0;
        const maxMineButtonRetries = 4;
        const retryDelay = 2000;

        let mineBtn = searchNodeByContent('button', 'Mine');
        while (!mineBtn && mineButtonRetries < maxMineButtonRetries && isAutoMode) {
            console.log(`${lh} - Mine button not found (attempt ${mineButtonRetries + 1}/${maxMineButtonRetries}). Retrying in ${retryDelay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            mineBtn = searchNodeByContent('button', 'Mine');
            mineButtonRetries++;
        }

        if (!mineBtn && mineButtonRetries >= maxMineButtonRetries && isAutoMode) {
            console.warn(`${lh} - Mine button not found after ${maxMineButtonRetries} retries in Auto Mode. Scheduling another status check...`);
            notifyUser('Pond0x Warning', `Mine button not found after ${maxMineButtonRetries} retries. Retrying status check...`);
            statusLock = false;
            setTimeout(scheduleStatusCheck, 5000);
            return;
        }

        if (!mineBtn && !isAutoMode) {
            console.warn(`${lh} - No Mine button found in Manual Mode. Reloading page...`);
            notifyUser('Pond0x Warning', 'No Mine button found in Manual Mode. Reloading page...');
            pageReloads++;
            reloadReason = 'Mine Button Not Found (Manual Mode)';
            await GM.setValue('pond0xPageReloads', pageReloads);
            await GM.setValue('pond0xReloadReason', reloadReason);
            sessionStorage.setItem('pond0xReloaded', 'true');
            window.location.href = 'https://www.pond0x.com/mining';
            statusLock = false;
            return;
        }

        if (mineBtn) {
            console.log(`${lh} - Starting mining session...`);
            mineBtn.click();

            let lcdContainer = null;
            let attempts = 0;
            const maxAttempts = 20;
            const retryDelay = 1000;

            while (!lcdContainer && attempts < maxAttempts) {
                console.log(`${lh} - Waiting for LCD container after mine click (attempt ${attempts + 1}/${maxAttempts})...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                lcdContainer = document.querySelector('.screenshadow') ||
                              document.querySelector('.bg-\\[\\#414f76\\]') ||
                              document.querySelector('.mining-display') ||
                              document.querySelector('.lcd-container') ||
                              document.querySelector('.mining-section') ||
                              document.querySelector('[class*="mining"]');
                attempts++;
            }

            if (lcdContainer) {
                console.log(`${lh} - LCD container found after ${attempts} attempts`);
                let unclaimed = '';
                const maxWaitAttempts = 120;
                let waitAttempts = 0;

                while (waitAttempts < maxWaitAttempts && !unclaimed) {
                    console.log(`${lh} - Waiting for unclaimed value (attempt ${waitAttempts + 1}/${maxWaitAttempts})...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    const params = getLCDParams();
                    unclaimed = (params.unclaimed || '').trim().toLowerCase();
                    waitAttempts++;
                }

                let hashrate = parseFloat(getLCDParams().hashrate) || 0;
                let hashrateRetries = 0;
                const maxHashrateRetries = 5;
                while (hashrate === 0 && hashrateRetries < maxHashrateRetries) {
                    console.log(`${lh} - Hashrate is 0 (attempt ${hashrateRetries + 1}/${maxHashrateRetries}). Retrying in ${retryDelay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    hashrate = parseFloat(getLCDParams().hashrate) || 0;
                    hashrateRetries++;
                }

                const invalidUnclaimedValues = ['100k', '1m', '1.1m'];

                if (hashrate > 0 && unclaimed && !invalidUnclaimedValues.includes(unclaimed)) {
                    console.log(`${lh} - Mining started successfully with hashrate ${hashrate}h/s, unclaimed: ${unclaimed}`);
                    notifyUser('Pond0x Mining', 'Mining started successfully');
                    if (!summaryBoxCreated) {
                        createSummaryBoxNow(lcdContainer);
                        summaryBoxCreated = true;
                    } else {
                        await updateClaimSummaryBox();
                    }
                    if (!autominerManuallyStarted) {
                        autominerManuallyStarted = true;
                        await GM.setValue('pond0xAutominerStarted', true);
                    }
                    window.pond0xO.startTime = getTime();
                    isMiningRunning = true;
                    await GM.setValue('pond0xIsMiningRunning', true);
                } else if (invalidUnclaimedValues.includes(unclaimed)) {
                    console.warn(`${lh} - Mining start failed: Invalid unclaimed value ${unclaimed}`);
                    notifyUser('Pond0x Warning', `Mining start failed: Invalid unclaimed value ${unclaimed}`);
                    isMiningRunning = false;
                    await GM.setValue('pond0xIsMiningRunning', false);
                    window.pond0xO.startTime = null;
                    pageReloads++;
                    reloadReason = 'Invalid Unclaimed Value Reload';
                    await GM.setValue('pond0xPageReloads', pageReloads);
                    await GM.setValue('pond0xReloadReason', reloadReason);
                    sessionStorage.setItem('pond0xReloaded', 'true');
                    window.location.href = 'https://www.pond0x.com/mining';
                    return;
                } else {
                    console.warn(`${lh} - Mining start failed: Hashrate=${hashrate}, Unclaimed=${unclaimed}`);
                    notifyUser('Pond0x Warning', `Mining start failed: Hashrate=${hashrate}, Unclaimed=${unclaimed}`);
                    isMiningRunning = false;
                    await GM.setValue('pond0xIsMiningRunning', false);
                    window.pond0xO.startTime = null;
                    setTimeout(scheduleStatusCheck, 5000);
                }
            } else {
                console.warn(`${lh} - LCD container not found after ${maxAttempts} attempts`);
                notifyUser('Pond0x Warning', 'LCD container not found after mine click');
                observeLCDContainer();
                isMiningRunning = false;
                await GM.setValue('pond0xIsMiningRunning', false);
                window.pond0xO.startTime = null;
                setTimeout(scheduleStatusCheck, 5000);
            }
        }
        statusLock = false;
    };

    const scheduleStatusCheck = async () => {
        if (isPaused || isMiningRunning) {
            console.log(`${lh} - Status check skipped: isPaused=${isPaused}, isMiningRunning=${isMiningRunning}`);
            return;
        }
        const now = getTime();
        const timeSinceLastCheck = now - lastStatusCheckTime;
        const MIN_CHECK_INTERVAL = 30;
        if (timeSinceLastCheck < MIN_CHECK_INTERVAL) {
            console.log(`${lh} - Status check throttled. Next check in ${MIN_CHECK_INTERVAL - timeSinceLastCheck} seconds`);
            setTimeout(scheduleStatusCheck, (MIN_CHECK_INTERVAL - timeSinceLastCheck) * 1000);
            return;
        }
        lastStatusCheckTime = now;
        await checkMiningStatus();
        if (!isMiningRunning) {
            setTimeout(scheduleStatusCheck, MIN_CHECK_INTERVAL * 1000); // Only reschedule if mining isn’t active
        }
    };

    const run = async () => {
        if (!isAutoMode && !isMiningRunning && !autominerManuallyStarted) {
            console.log(`${lh} - Manual mode inactive, awaiting user start. Skipping run cycle...`);
            runTimeout = setTimeout(run, getTimeMS(window.pond0xO.runInterval)); // Reschedule even in idle state
            return;
        }

        if (isPaused) {
            console.log(`${lh} - Autominer paused. Waiting to resume...`);
            nextRetryTime = null;
            runTimeout = setTimeout(run, getTimeMS(window.pond0xO.runInterval)); // Keep loop alive
            return;
        }

        // Always log the current state for debugging and monitoring
        let lcdContainer = document.querySelector('.screenshadow') ||
                          document.querySelector('.bg-\\[\\#414f76\\]') ||
                          document.querySelector('.mining-display') ||
                          document.querySelector('.lcd-container') ||
                          document.querySelector('.mining-section') ||
                          document.querySelector('[class*="mining"]');
        const params = lcdContainer ? getLCDParams() : { hashrate: '0', unclaimed: '' };
        let hashrate = parseFloat(params.hashrate) || 0;
        const currentUnclaimed = (params.unclaimed || '').trim().toLowerCase();
        const runTime = getTime();
        const timeSinceStart = window.pond0xO.startTime ? (runTime - window.pond0xO.startTime) : 0;

        console.log(`${lh} - Run cycle state: hashrate=${hashrate}h/s, unclaimed=${currentUnclaimed}, autominerManuallyStarted=${autominerManuallyStarted}, claimCount=${claimCount}, isAutoMode=${isAutoMode}, pageReloads=${pageReloads}, isClaimWaitMode=${isClaimWaitMode}, timeSinceStart=${timeSinceStart}s`);

        // Check network status
        const isOnline = navigator.onLine;
        if (!isOnline) {
            console.warn(`${lh} - Network disconnected. Attempting to recover...`);
            notifyUser('Pond0x Warning', 'Network disconnected. Waiting for reconnection...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (!navigator.onLine) {
                console.error(`${lh} - Network still disconnected. Reloading page to recover...`);
                pageReloads++;
                reloadReason = 'Network Disconnection Recovery';
                await GM.setValue('pond0xPageReloads', pageReloads);
                await GM.setValue('pond0xReloadReason', reloadReason);
                sessionStorage.setItem('pond0xReloaded', 'true');
                window.location.href = 'https://www.pond0x.com/mining';
                return; // Exit to prevent rescheduling until reload completes
            } else {
                console.log(`${lh} - Network reconnected. Continuing...`);
            }
        }

        // Retry hash rate check if it drops unexpectedly (possible network issue)
        if (hashrate === 0 && lcdContainer && isMiningRunning) {
            console.warn(`${lh} - Hash rate dropped to 0 unexpectedly. Retrying to confirm...`);
            let retryAttempts = 0;
            const maxRetryAttempts = 3;
            const retryDelay = 2000;

            while (retryAttempts < maxRetryAttempts) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                const retryParams = lcdContainer ? getLCDParams() : { hashrate: '0', unclaimed: '' };
                hashrate = parseFloat(retryParams.hashrate) || 0;
                console.log(`${lh} - Retry ${retryAttempts + 1}/${maxRetryAttempts}: Hashrate=${hashrate}h/s`);
                if (hashrate > 0) {
                    console.log(`${lh} - Hash rate recovered to ${hashrate}h/s. Continuing...`);
                    break;
                }
                retryAttempts++;
            }
        }

        // Update mining status and UI if hashrate > 0
        if (hashrate > 0 && isMiningRunning) {
            if (!window.pond0xO.startTime) {
                window.pond0xO.startTime = runTime;
            }
            lastStatusMessage = `Status: Unclaimed: "${currentUnclaimed}", Hashrate: ${hashrate}h/s, Time: ${timeSinceStart}s`;
            console.log(`${lh} - ${lastStatusMessage}`);
            notifyUser('Pond0x Mining Status', lastStatusMessage);
            if (!summaryBoxCreated && lcdContainer) {
                createSummaryBoxNow(lcdContainer);
                summaryBoxCreated = true;
            } else if (summaryBoxCreated) {
                await updateClaimSummaryBox();
            }
            isMiningRunning = true;
            await GM.setValue('pond0xIsMiningRunning', true);
        } else if (!autominerManuallyStarted && claimCount === 0 && pageReloads === 0) {
            console.log(`${lh} - No hashrate detected and first run, waiting for manual start...`);
            runTimeout = setTimeout(run, getTimeMS(window.pond0xO.runInterval));
            return;
        }

        // Auto mode: Check global mining status only if not already running or on page reload
        if (isAutoMode && !isMiningRunning) {
            if (getTime() - lastStatusCheckTime >= 30 || lastStatusCheckTime === 0 || pageReloads > 0) {
                lastStatusCheckTime = getTime();
                console.log(`${lh} - Starting status check at ${new Date().toISOString()} due to ${lastStatusCheckTime === 0 ? 'initial run' : pageReloads > 0 ? 'page reload' : '30-second interval'}`);
                isMiningActive = await checkMiningStatus();
                if (isMiningActive) {
                    consecutiveStoppedCount = 0;
                    nextRetryTime = null;
                    await startMining();
                } else {
                    consecutiveStoppedCount++;
                    console.log(`${lh} - Global mining status not active (${consecutiveStoppedCount} consecutive cycles)`);
                    const retryDelay = consecutiveStoppedCount >= 3 ? 300000 : 5000;
                    nextRetryTime = getTime() + (retryDelay / 1000);
                    console.log(`${lh} - Retrying status check in ${retryDelay / 1000}s...`);
                    runTimeout = setTimeout(run, retryDelay);
                    return;
                }
            }
        } else if (!isAutoMode && !hashrate && !isMiningRunning) {
            await startMining();
        }

        // Validate unclaimed value (only if LCD is available)
        let currentUnclaimedNum = 0;
        if (lcdContainer && currentUnclaimed && !['100k', '1m', '1.1m'].includes(currentUnclaimed)) {
            currentUnclaimedNum = parseFloat(currentUnclaimed.replace('m', '')) || 0;
            if (currentUnclaimed.includes('m')) {
                currentUnclaimedNum *= 1000000;
            } else if (currentUnclaimed.includes('b')) {
                currentUnclaimedNum *= 1000000000;
            }
        }

        // Determine which button to look for based on unclaimed value
        const buttons = {
            stop: currentUnclaimedNum < 100000000 ? searchNodeByContent('button', 'STOP ANYWAYS') : null,
            claim: searchNodeByContent('button', 'STOP & Claim')
        };

        // Retry button detection if hash rate is 0
        if (lcdContainer && hashrate === 0 && isMiningRunning && (!buttons.stop && !buttons.claim)) {
            console.log(`${lh} - No claim/stop button found with hashrate 0, retrying detection...`);
            let buttonRetries = 0;
            const maxButtonRetries = 3;
            const buttonRetryDelay = 1000;
            while ((!buttons.stop && !buttons.claim) && buttonRetries < maxButtonRetries) {
                await new Promise(resolve => setTimeout(resolve, buttonRetryDelay));
                buttons.stop = currentUnclaimedNum < 100000000 ? searchNodeByContent('button', 'STOP ANYWAYS') : null;
                buttons.claim = searchNodeByContent('button', 'STOP & Claim');
                buttonRetries++;
                console.log(`${lh} - Button retry ${buttonRetries}/${maxButtonRetries}: stop=${!!buttons.stop}, claim=${!!buttons.claim}`);
            }
        }

        const effectiveClaimIntervalSeconds = Math.min(claimIntervalMinutes * 60, 150 * 60);
        console.log(`${lh} - Effective claim interval: ${effectiveClaimIntervalSeconds / 60} minutes (user-set: ${claimIntervalMinutes} minutes)`);

        // Priority 1: Claim and reload if hash rate is 0
        if (lcdContainer && hashrate === 0 && (buttons.stop || buttons.claim)) {
            console.log(`${lh} - Hash rate is 0, initiating claim and reload...`);
            const claimButton = buttons.claim || buttons.stop; // Prefer "STOP & Claim" if available
            if (claimButton) {
                isClaiming = true;
                lastClaimTime = getTime();
                await GM.setValue('pond0xLastClaimTime', lastClaimTime);
                claimTimes.push(lastClaimTime);
                await GM.setValue('pond0xClaimTimes', JSON.stringify(claimTimes));
                await GM.setValue('pond0xLastClaimTime', lastClaimTime);

                historicalClaims.push({ date: lastClaimTime, amount: currentUnclaimedNum });
                await updateDailyClaims(lastClaimTime, currentUnclaimedNum);
                await GM.setValue('pond0xHistoricalClaims', JSON.stringify(historicalClaims.slice(-100)));

                console.log(`${lh} - Clicking ${claimButton.textContent} due to hash rate 0...`);
                claimButton.click();
                await new Promise(resolve => setTimeout(resolve, getTimeMS(6))); // Wait for claim to process

                // Update claim stats
                claimCount++;
                totalClaimed += currentUnclaimedNum;
                lastClaimValue = currentUnclaimedNum;
                console.log(`${lh} - Updated totalClaimed to ${totalClaimed}, lastClaimValue to ${lastClaimValue}`);
                await GM.setValue('pond0xClaimCount', claimCount);
                await GM.setValue('pond0xTotalClaimed', totalClaimed);
                await GM.setValue('pond0xLastClaim', lastClaimValue);

                // Reset mining state
                isMiningRunning = false;
                await GM.setValue('pond0xIsMiningRunning', false);
                window.pond0xO.startTime = null;

                if (!isAutoMode) {
                    console.log(`${lh} - Manual mode: Claim completed, stopping autominer...`);
                    if (runTimeout) {
                        clearTimeout(runTimeout);
                        runTimeout = null;
                        console.log(`${lh} - Cleared runTimeout in manual mode after claim`);
                    }
                    const toggleMiningBtn = document.getElementById('toggleMiningBtn');
                    if (toggleMiningBtn) {
                        toggleMiningBtn.textContent = 'Start Manual Mining';
                        toggleMiningBtn.style.background = '#28a745';
                    }
                    notifyUser('Pond0x Claim', `Claim successful in manual mode: ${formatClaimValue(currentUnclaimedNum)} tokens. Awaiting user action...`);
                }

                // Handle Claim + Wait mode
                if (isClaimWaitMode && isAutoMode) {
                    console.log(`${lh} - Claim + Wait mode active, pausing for 20 minutes...`);
                    notifyUser('Pond0x Claim', `Claim successful due to hash rate 0: ${formatClaimValue(currentUnclaimedNum)} tokens. Waiting 20 minutes...`);
                    isPaused = true;
                    await GM.setValue('pond0xMinerIsPaused', true);
                    document.getElementById('pauseResumeBtn').textContent = 'Resume';
                    document.getElementById('pauseResumeBtn').style.background = '#28a745';
                    document.getElementById('pauseResumeBtn').style.color = 'white';
                    await new Promise(resolve => setTimeout(resolve, getTimeMS(20 * 60)));
                    isPaused = false;
                    await GM.setValue('pond0xMinerIsPaused', false);
                    document.getElementById('pauseResumeBtn').textContent = 'Pause';
                    document.getElementById('pauseResumeBtn').style.background = '#ffc107';
                    document.getElementById('pauseResumeBtn').style.color = 'black';
                } else if (isAutoMode) {
                    notifyUser('Pond0x Claim', `Claim successful due to hash rate 0: ${formatClaimValue(currentUnclaimedNum)} tokens`);
                }

                lastStatusCheckTime = 0;
                pageReloads++;
                reloadReason = isClaimWaitMode ? 'Claim + Wait 20 Mins' : 'Hash Rate Zero Claim';
                await GM.setValue('pond0xPageReloads', pageReloads);
                await GM.setValue('pond0xReloadReason', reloadReason);
                console.log(`${lh} - Reloading page to start next session...`);
                sessionStorage.setItem('pond0xReloaded', 'true');
                window.location.href = 'https://www.pond0x.com/mining';
                return; // Exit to prevent rescheduling until reload completes
            } else {
                console.warn(`${lh} - No claim button found despite hash rate 0 after retries`);
                notifyUser('Pond0x Warning', 'No claim button found despite hash rate 0');
            }
        }

        // Skip reload if unclaimed value is invalid (only if LCD is available)
        if (lcdContainer && ['100k', '1m', '1.1m'].includes(currentUnclaimed)) {
            console.warn(`${lh} - Detected invalid unclaimed value ${currentUnclaimed}, reloading page...`);
            pageReloads++;
            reloadReason = 'Invalid Unclaimed Value Reload';
            await GM.setValue('pond0xPageReloads', pageReloads);
            await GM.setValue('pond0xReloadReason', reloadReason);
            sessionStorage.setItem('pond0xReloaded', 'true');
            window.location.href = 'https://www.pond0x.com/mining';
            return; // Exit to prevent rescheduling until reload completes
        }

        // Priority 2: Smart claim or time-based claim if hash rate is not 0 and conditions are met
        if (lcdContainer && hashrate > 0 && (buttons.stop || buttons.claim)) {
            const shouldClaim =
                timeSinceStart > effectiveClaimIntervalSeconds || // Enforce effective claim interval (capped at 150 minutes)
                (isSmartClaimEnabled && currentUnclaimedNum >= smartClaimThreshold); // Smart Claim when enabled and threshold met

            if (shouldClaim) {
                const claimButton = buttons.claim || buttons.stop; // Prefer "STOP & Claim" if available
                if (claimButton) {
                    if (currentUnclaimedNum <= 0) {
                        console.warn(`${lh} - Skipping claim due to invalid unclaimed amount: ${currentUnclaimed}`);
                        runTimeout = setTimeout(run, getTimeMS(window.pond0xO.runInterval));
                        return;
                    }
                    isClaiming = true;
                    lastClaimTime = getTime();
                    await GM.setValue('pond0xLastClaimTime', lastClaimTime);
                    claimTimes.push(lastClaimTime);
                    await GM.setValue('pond0xClaimTimes', JSON.stringify(claimTimes));
                    await GM.setValue('pond0xLastClaimTime', lastClaimTime);

                    historicalClaims.push({ date: lastClaimTime, amount: currentUnclaimedNum });
                    await updateDailyClaims(lastClaimTime, currentUnclaimedNum);
                    await GM.setValue('pond0xHistoricalClaims', JSON.stringify(historicalClaims.slice(-100)));

                    const claimReason = timeSinceStart > effectiveClaimIntervalSeconds
                        ? `time threshold (${effectiveClaimIntervalSeconds / 60} minutes)`
                        : `smart claim threshold (${formatClaimValue(smartClaimThreshold)})`; 
                    console.log(`${lh} - Clicking ${claimButton.textContent} due to ${claimReason}...`);
                    claimButton.click();
                    await new Promise(resolve => setTimeout(resolve, getTimeMS(6))); // Wait for claim to process

                    // Update claim stats
                    claimCount++;
                    totalClaimed += currentUnclaimedNum;
                    lastClaimValue = currentUnclaimedNum;
                    console.log(`${lh} - Updated totalClaimed to ${totalClaimed}, lastClaimValue to ${lastClaimValue}`);
                    await GM.setValue('pond0xClaimCount', claimCount);
                    await GM.setValue('pond0xTotalClaimed', totalClaimed);
                    await GM.setValue('pond0xLastClaim', lastClaimValue);

                    // Reset mining state
                    isMiningRunning = false;
                    await GM.setValue('pond0xIsMiningRunning', false);
                    window.pond0xO.startTime = null;

                    if (!isAutoMode) {
                        console.log(`${lh} - Manual mode: Claim completed, stopping autominer...`);
                        if (runTimeout) {
                            clearTimeout(runTimeout);
                            runTimeout = null;
                            console.log(`${lh} - Cleared runTimeout in manual mode after claim`);
                        }
                        const toggleMiningBtn = document.getElementById('toggleMiningBtn');
                        if (toggleMiningBtn) {
                            toggleMiningBtn.textContent = 'Start Manual Mining';
                            toggleMiningBtn.style.background = '#28a745';
                        }
                        notifyUser('Pond0x Claim', `Claim successful in manual mode: ${formatClaimValue(currentUnclaimedNum)} tokens. Awaiting user action...`);
                    }

                    // Handle Claim + Wait mode
                    if (isClaimWaitMode && isAutoMode) {
                        console.log(`${lh} - Claim + Wait mode active, pausing for 20 minutes...`);
                        notifyUser('Pond0x Claim', `Claim successful: ${formatClaimValue(currentUnclaimedNum)} tokens. Waiting 20 minutes...`);
                        isPaused = true;
                        await GM.setValue('pond0xMinerIsPaused', true);
                        document.getElementById('pauseResumeBtn').textContent = 'Resume';
                        document.getElementById('pauseResumeBtn').style.background = '#28a745';
                        document.getElementById('pauseResumeBtn').style.color = 'white';
                        await new Promise(resolve => setTimeout(resolve, getTimeMS(20 * 60)));
                        isPaused = false;
                        await GM.setValue('pond0xMinerIsPaused', false);
                        document.getElementById('pauseResumeBtn').textContent = 'Pause';
                        document.getElementById('pauseResumeBtn').style.background = '#ffc107';
                        document.getElementById('pauseResumeBtn').style.color = 'black';
                    } else if (isAutoMode) {
                        notifyUser('Pond0x Claim', `Claim successful: ${formatClaimValue(currentUnclaimedNum)} tokens`);
                    }

                    lastStatusCheckTime = 0;
                    pageReloads++;
                    reloadReason = isClaimWaitMode ? 'Claim + Wait 20 Mins' : (timeSinceStart > effectiveClaimIntervalSeconds ? 'Time Threshold Claim' : 'Smart Claim');
                    await GM.setValue('pond0xPageReloads', pageReloads);
                    await GM.setValue('pond0xReloadReason', reloadReason);
                    console.log(`${lh} - Reloading page after claim...`);
                    sessionStorage.setItem('pond0xReloaded', 'true');
                    window.location.href = 'https://www.pond0x.com/mining';
                    return; // Exit to prevent rescheduling until reload completes
                } else {
                    console.warn(`${lh} - No claim button found for smart/time-based claim`);
                    notifyUser('Pond0x Warning', 'No claim button found for smart/time-based claim');
                }
            }
        }

        // Schedule the next run regardless of action taken, unless a reload occurred
        console.log(`${lh} - Scheduling next run cycle in ${window.pond0xO.runInterval} seconds...`);
        runTimeout = setTimeout(run, getTimeMS(window.pond0xO.runInterval));
    };
    // [Start of Part 5]
    // Part 5 includes remaining utility functions and main execution

    const resetDailyStats = async () => {
        claimCount = 0;
        totalClaimed = 0;
        pageReloads = 0;
        lastClaimValue = 0;
        await GM.setValue('pond0xClaimCount', 0);
        await GM.setValue('pond0xTotalClaimed', 0);
        await GM.setValue('pond0xPageReloads', 0);
        await GM.setValue('pond0xLastClaim', 0);
        const todayMidnight = new Date().setHours(0, 0, 0, 0);
        await GM.setValue('pond0xLastResetDate', new Date(todayMidnight).toISOString());
        await GM.setValue('pond0xClaimTimes', JSON.stringify([]));
        console.log(`${lh} - Manual reset of claimCount, totalClaimed, pageReloads, and lastClaimValue to 0`);
        await updateClaimSummaryBox();
    };

    const calculateAverageClaimTime = () => {
        if (claimTimes.length < 2) return 0;
        const timeDifferences = [];
        for (let i = 1; i < claimTimes.length; i++) {
            const diff = (claimTimes[i] - claimTimes[i - 1]) / 60;
            timeDifferences.push(diff);
        }
        const average = timeDifferences.reduce((sum, val) => sum + val, 0) / timeDifferences.length;
        return Math.round(average * 100) / 100;
    };

    const getPreviousThreeDaysClaims = () => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const fourDaysAgo = new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000);
        const filteredClaims = {};
        Object.keys(dailyClaims).forEach(date => {
            const claimDate = new Date(date);
            if (claimDate >= fourDaysAgo) {
                filteredClaims[date] = dailyClaims[date];
            }
        });
        const sortedDays = Object.entries(filteredClaims)
            .sort((a, b) => new Date(b[0]) - new Date(a[0]))
            .map(([date, total]) => `${date}: ${formatClaimValue(total)}`)
            .join('<br>');
        return sortedDays || 'No claims in the last 4 days';
    };

    const calculateAverageClaimAmount = () => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const fourDaysAgo = new Date(today.getTime() - 4 * 24 * 60 * 60 * 1000);
        const recentClaims = historicalClaims.filter(claim => new Date(claim.date * 1000) >= fourDaysAgo);
        const avgClaimAmount = recentClaims.length > 0 ? recentClaims.reduce((sum, claim) => sum + claim.amount, 0) / recentClaims.length : 0;
        return avgClaimAmount;
    };

    const formatClaimValue = (value) => {
        if (value >= 1000000000) {
            return `${(value / 1000000000).toFixed(2)}B`;
        } else if (value >= 1000000) {
            return `${(value / 1000000).toFixed(2)}M`;
        } else {
            return `${value.toFixed(2)}`;
        }
    };

    const updateDailyClaims = async (claimTime, amount) => {
        const claimDate = new Date(claimTime * 1000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        dailyClaims[claimDate] = (dailyClaims[claimDate] || 0) + amount;
        await GM.setValue('pond0xDailyClaims', JSON.stringify(dailyClaims));
    };

    const exportClaimHistoryToCSV = () => {
        let csvContent = 'data:text/csv;charset=utf-8,';

        csvContent += 'Historical Claims\n';
        csvContent += 'Date,Amount\n';
        historicalClaims.forEach(claim => {
            const date = new Date(claim.date * 1000).toISOString();
            const amount = formatClaimValue(claim.amount);
            csvContent += `${date},${amount}\n`;
        });

        csvContent += '\nDaily Claims\n';
        csvContent += 'Date,Total Amount\n';
        Object.entries(dailyClaims).forEach(([date, total]) => {
            const formattedTotal = formatClaimValue(total);
            csvContent += `${date},${formattedTotal}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', 'pond0x_claim_history.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const createSummaryBoxNow = (container) => {
        try {
            const summaryBox = document.createElement('div');
            summaryBox.id = 'pond0xClaimSummary';

            let topPosition = 10; // Default top position near the top, anchored to left
            let leftPosition = 10; // Default left position anchored to the left
            let positionStyle = 'fixed';

            if (container !== document.body && container.offsetWidth > 0 && container.offsetHeight > 0) {
                positionStyle = 'absolute';
                topPosition = container.offsetTop + 10; // Offset from the top of the container
                leftPosition = container.offsetLeft + 10; // Offset from the left of the container
            }

            summaryBox.style.cssText = `
                position: ${positionStyle};
                left: ${leftPosition}px;
                top: ${topPosition}px;
                width: 300px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                border: 2px solid #000000;
                border-radius: 10px;
                color: #ffffff;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 14px;
                padding: 10px;
                z-index: 1000;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                overflow: auto;
                resize: both;
                min-width: 300px;
                min-height: 200px;
                display: block;
                visibility: visible;
                cursor: move;
                user-select: none; /* Prevent text selection */
            `;

            let isDragging = false, initialX, initialY;
            summaryBox.addEventListener('mousedown', (e) => {
                if (e.target.tagName !== 'BUTTON' && !e.target.closest('button') && !e.target.closest('strong')) {
                    isDragging = true;
                    initialX = e.clientX - parseInt(summaryBox.style.left);
                    initialY = e.clientY - parseInt(summaryBox.style.top);
                    e.preventDefault(); // Prevent text selection or other interference
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    summaryBox.style.left = `${e.clientX - initialX}px`;
                    summaryBox.style.top = `${e.clientY - initialY}px`;
                    // Ensure it stays within viewport
                    const boxRect = summaryBox.getBoundingClientRect();
                    if (boxRect.left < 0) summaryBox.style.left = '0px';
                    if (boxRect.top < 0) summaryBox.style.top = '0px';
                    if (boxRect.right > window.innerWidth) summaryBox.style.left = `${window.innerWidth - boxRect.width}px`;
                    if (boxRect.bottom > window.innerHeight) summaryBox.style.top = `${window.innerHeight - boxRect.height}px`;
                }
            });

            document.addEventListener('mouseup', () => {
                isDragging = false;
            });

            const today = new Date();
            const dateString = today.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
            const averageClaimTime = calculateAverageClaimTime();
            const previousThreeDaysClaims = getPreviousThreeDaysClaims();
            const formattedTotalClaimed = formatClaimValue(totalClaimed);
            const formattedLastClaim = formatClaimValue(lastClaimValue);
            const avgClaimAmount = calculateAverageClaimAmount();
            const formattedAvgClaimAmount = formatClaimValue(avgClaimAmount);

            let miningStatusMessage = isMiningRunning ? 'Mining' : 'Idle';
            if (!isMiningRunning) {
                miningStatusMessage = statusLock ? `Checking status...` :
                                      (nextRetryTime ? `Next cycle in ${(nextRetryTime - getTime()) > 60 ? Math.floor((nextRetryTime - getTime()) / 60) + ' mins' : (nextRetryTime - getTime()) + ' secs'}` : 'Idle');
            }

            if (lastRenderedTotalClaimed !== totalClaimed || lastRenderedLastClaim !== lastClaimValue) {
                console.log(`${lh} - Rendering summary: Total Claimed = ${totalClaimed} (formatted as ${formattedTotalClaimed}), Last Claim = ${lastClaimValue} (formatted as ${formattedLastClaim})`);
                lastRenderedTotalClaimed = totalClaimed;
                lastRenderedLastClaim = lastClaimValue;
            }

            summaryBox.innerHTML = `
                <div style="font-weight: bold; background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-bottom: 10px; text-align: center;">
                    Ez Mode - v4.2.0 🐻 ⛏️💧
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Date:</strong> ${sanitizeDomContent(dateString)}<br>
                    <strong>Claims:</strong> ${claimCount}<br>
                    <strong>Total Claimed:</strong> ${sanitizeDomContent(formattedTotalClaimed)}<br>
                    <strong>Last Claim:</strong> ${sanitizeDomContent(formattedLastClaim)}<br>
                    <strong>Last Claim Time:</strong> ${lastClaimTime ? new Date(lastClaimTime * 1000).toLocaleTimeString() : 'N/A'}<br>
                    <strong>Average Claim Time:</strong> ${averageClaimTime > 0 ? `${averageClaimTime} mins` : 'N/A'}<br>
                    <strong>Average Claim Amount (4 days):</strong> ${avgClaimAmount > 0 ? sanitizeDomContent(formattedAvgClaimAmount) : 'N/A'}<br>
                    <strong>Page Reloads:</strong> ${pageReloads}<br>
                    <strong>Page Reload Reason:</strong> <span title="Reason for the last page reload: ${sanitizeDomContent(reloadReasonStored)}">${sanitizeDomContent(reloadReasonStored)}</span><br>
                    <strong>Mining Status:</strong> <span style="color: ${isMiningRunning ? '#28a745' : '#dc3545'}">${sanitizeDomContent(miningStatusMessage)}</span><br>
                    <strong>Global Mining Status:</strong> <span style="color: ${currentGlobalStatus === 'Mining: Active' ? '#28a745' : currentGlobalStatus === 'Mining: Struggling' ? '#ffc107' : '#dc3545'}">${sanitizeDomContent(currentGlobalStatus)}</span>
                </div>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px;">
                    <strong style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.replace(/.$/, this.nextElementSibling.style.display === 'none' ? '▼' : '▲');">
                        Total Daily Claims ▼
                    </strong>
                    <div style="display: block;">
                        ${sanitizeDomContent(previousThreeDaysClaims)}
                    </div>
                </div>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-top: 10px;">
                    <strong style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.replace(/.$/, this.nextElementSibling.style.display === 'none' ? '▼' : '▲');">
                        Status Log ▼
                    </strong>
                    <div style="display: block;">
                        ${sanitizeDomContent(lastStatusMessage) || 'No recent status'}
                    </div>
                </div>
                <div style="text-align: center; margin-top: 10px;">
                    <button id="resetDailyStatsBtn" style="background: #28a745; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">Stats Reset</button>
                </div>
            `;

            if (container !== document.body) {
                container.parentNode.appendChild(summaryBox);
                console.log(`${lh} - Summary box appended to container's parent: ${container.parentNode.tagName}.${Array.from(container.parentNode.classList).join('.')}`);
            } else {
                document.body.appendChild(summaryBox);
                console.log(`${lh} - Summary box appended to document.body as fallback`);
            }

            const boxRect = summaryBox.getBoundingClientRect();
            console.log(`${lh} - Summary box created at position: top=${boxRect.top}px, left=${boxRect.left}px, visible=${boxRect.width > 0 && boxRect.height > 0}`);

            const resetButton = summaryBox.querySelector('#resetDailyStatsBtn');
            resetButton.addEventListener('click', resetDailyStats);
        } catch (e) {
            console.error(`${lh} - Error inserting summary box: ${e.message}`);
            notifyUser('Pond0x Error', `Error inserting summary box: ${e.message}`);
        }
    };

    const updateClaimSummaryBox = async () => {
        const box = document.getElementById('pond0xClaimSummary');
        if (!box) {
            await createClaimSummaryBox(); // Attempt to create if it doesn't exist
            return;
        }

        try {
            const today = new Date();
            const dateString = today.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
            const averageClaimTime = calculateAverageClaimTime();
            const previousThreeDaysClaims = getPreviousThreeDaysClaims();
            const formattedTotalClaimed = formatClaimValue(totalClaimed);
            const formattedLastClaim = formatClaimValue(lastClaimValue);
            const avgClaimAmount = calculateAverageClaimAmount();
            const formattedAvgClaimAmount = formatClaimValue(avgClaimAmount);

            let miningStatusMessage = isMiningRunning ? 'Mining' : 'Idle';
            if (!isMiningRunning) {
                miningStatusMessage = statusLock ? `Checking status...` :
                                      (nextRetryTime ? `Next cycle in ${(nextRetryTime - getTime()) > 60 ? Math.floor((nextRetryTime - getTime()) / 60) + ' mins' : (nextRetryTime - getTime()) + ' secs'}` : 'Idle');
            }

            if (lastRenderedTotalClaimed !== totalClaimed || lastRenderedLastClaim !== lastClaimValue) {
                console.log(`${lh} - Rendering summary: Total Claimed = ${totalClaimed} (formatted as ${formattedTotalClaimed}), Last Claim = ${lastClaimValue} (formatted as ${formattedLastClaim})`);
                lastRenderedTotalClaimed = totalClaimed;
                lastRenderedLastClaim = lastClaimValue;
            }

            box.innerHTML = `
                <div style="font-weight: bold; background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-bottom: 10px; text-align: center;">
                    Ez Mode - v4.2.0 🐻 ⛏️💧
                </div>
                <div style="margin-bottom: 10px;">
                    <strong>Date:</strong> ${sanitizeDomContent(dateString)}<br>
                    <strong>Claims:</strong> ${claimCount}<br>
                    <strong>Total Claimed:</strong> ${sanitizeDomContent(formattedTotalClaimed)}<br>
                    <strong>Last Claim:</strong> ${sanitizeDomContent(formattedLastClaim)}<br>
                    <strong>Last Claim Time:</strong> ${lastClaimTime ? new Date(lastClaimTime * 1000).toLocaleTimeString() : 'N/A'}<br>
                    <strong>Average Claim Time:</strong> ${averageClaimTime > 0 ? `${averageClaimTime} mins` : 'N/A'}<br>
                    <strong>Average Claim Amount (4 days):</strong> ${avgClaimAmount > 0 ? sanitizeDomContent(formattedAvgClaimAmount) : 'N/A'}<br>
                    <strong>Page Reloads:</strong> ${pageReloads}<br>
                    <strong>Page Reload Reason:</strong> <span title="Reason for the last page reload: ${sanitizeDomContent(reloadReasonStored)}">${sanitizeDomContent(reloadReasonStored)}</span><br>
                    <strong>Mining Status:</strong> <span style="color: ${isMiningRunning ? '#28a745' : '#dc3545'}">${sanitizeDomContent(miningStatusMessage)}</span><br>
                    <strong>Global Mining Status:</strong> <span style="color: ${currentGlobalStatus === 'Mining: Active' ? '#28a745' : currentGlobalStatus === 'Mining: Struggling' ? '#ffc107' : '#dc3545'}">${sanitizeDomContent(currentGlobalStatus)}</span>
                </div>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px;">
                    <strong style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.replace(/.$/, this.nextElementSibling.style.display === 'none' ? '▼' : '▲');">
                        Total Daily Claims ▼
                    </strong>
                    <div style="display: block;">
                        ${sanitizeDomContent(previousThreeDaysClaims)}
                    </div>
                </div>
                <div style="background: rgba(0, 0, 0, 0.5); padding: 5px; border-radius: 5px; margin-top: 10px;">
                    <strong style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent.replace(/.$/, this.nextElementSibling.style.display === 'none' ? '▼' : '▲');">
                        Status Log ▼
                    </strong>
                    <div style="display: block;">
                        ${sanitizeDomContent(lastStatusMessage) || 'No recent status'}
                    </div>
                </div>
                <div style="text-align: center; margin-top: 10px;">
                    <button id="resetDailyStatsBtn" style="background: #28a745; color: white; border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 12px;">Stats Reset</button>
                </div>
            `;

            const resetButton = box.querySelector('#resetDailyStatsBtn');
            resetButton.addEventListener('click', resetDailyStats);
        } catch (e) {
            console.error(`${lh} - Error updating summary box: ${e.message}`);
            notifyUser('Pond0x Error', `Error updating summary box: ${e.message}`);
        }
    };

    // Main execution
    console.log(`${lh} - Starting monitoring cycle (waiting for manual start if first run)...`);
    await performDailyReset();
    await createClaimSummaryBox();
    await createControlPanel();
    if (isAutoMode) {
        await scheduleStatusCheck(); // Initial status check for Auto Mode
    } else {
        await run(); // Start run loop for Manual Mode
    }

    // Add event listener for page reloads
    window.addEventListener('beforeunload', async () => {
        await GM.setValue('pond0xReloadReason', reloadReason || 'User Navigation');
    });
})();
