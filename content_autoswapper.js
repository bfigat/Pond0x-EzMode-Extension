(async function () {
    'use strict';

    const lh = '[Pond0x-AutoSwapper]';

    console.log(`${lh} *** SWAP AUTOMATION RUNNING ***`);

    // Whitelist for allowed GM keys to prevent IDOR
    const ALLOWED_KEYS = [
        'pond0xSwapAmount', 'pond0xSwapCounter', 'pond0xIsSwapping', 'pond0xRetryInterval',
        'pond0xIsSwapRunning', 'pond0xSwapperIsPaused', 'pond0xLastSwapAmount', 
        'pond0xLastIsSwapping', 'pond0xIsAutoMode', 'pond0xSwapMode', 'pond0xSelectedSellToken',
        'pond0xSelectedBuyToken', 'pond0xIsRewardSwapsMode', 'pond0xLastSwapDirection'
    ];

    // Encryption utilities (simple XOR-based for demo; use a proper library like CryptoJS in production)
    const ENCRYPTION_KEY = 'xai-security-key';
    function encryptData(data) {
        const str = JSON.stringify(data);
        let encrypted = '';
        for (let i = 0; i < str.length; i++) {
            encrypted += String.fromCharCode(str.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length));
        }
        return btoa(encrypted);
    }
    function decryptData(encrypted) {
        const decoded = atob(encrypted);
        let decrypted = '';
        for (let i = 0; i < decoded.length; i++) {
            decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ ENCRYPTION_KEY.charCodeAt(i % ENCRYPTION_KEY.length));
        }
        return JSON.parse(decrypted);
    }

    // Input sanitization
    function sanitizeInput(input) {
        if (typeof input !== 'string') return input;
        return input.replace(/[<>&"']/g, '');
    }

    // DOM content sanitization (Regex fallback instead of DOMPurify)
    function sanitizeDomContent(content) {
        if (typeof content !== 'string') return content;
        return content.replace(/<[^>]*>/g, ''); // Strip HTML tags
    }

    const GM = {
        getValue: (key, defaultValue) => {
            return new Promise((resolve) => {
                if (!ALLOWED_KEYS.includes(key)) {
                    console.error(`${lh} - Unauthorized key access attempt: ${key}`);
                    resolve(defaultValue);
                    return;
                }
                chrome.storage.local.get([key], (result) => {
                    if (chrome.runtime.lastError) {
                        console.error(`${lh} - Error in GM.getValue for ${key}:`, chrome.runtime.lastError);
                        resolve(defaultValue);
                        return;
                    }
                    const value = result[key] !== undefined ? decryptData(result[key]) : defaultValue;
                    resolve(value);
                });
            });
        },
        setValue: (key, value) => {
            return new Promise((resolve) => {
                if (!ALLOWED_KEYS.includes(key)) {
                    console.error(`${lh} - Unauthorized key set attempt: ${key}`);
                    resolve(false);
                    return;
                }
                const encryptedValue = encryptData(value);
                chrome.storage.local.set({ [key]: encryptedValue }, () => {
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

    let swapAmount = await GM.getValue('pond0xSwapAmount', 0.01);
    let swapCounter = await GM.getValue('pond0xSwapCounter', 0);
    let isSwapping = await GM.getValue('pond0xIsSwapping', false);
    let retryInterval = await GM.getValue('pond0xRetryInterval', 3000);
    let swapButton = null;
    let controlPanel = null;
    let initialPanelPosition = null;
    let isSwapRunning = await GM.getValue('pond0xIsSwapRunning', false);
    let hasReloaded = sessionStorage.getItem('pond0xSwapReloaded') === 'true';
    let setupRetryCount = 0;
    const MAX_SETUP_RETRIES = 2;
    const SWAP_STUCK_TIMEOUT = 40000;
    let isSettingUp = false;
    let isAutoMode = await GM.getValue('pond0xIsAutoMode', true);
    let swapMode = await GM.getValue('pond0xSwapMode', 'Boost');
    let isRewardSwapsMode = await GM.getValue('pond0xIsRewardSwapsMode', false);
    let lastSwapDirection = await GM.getValue('pond0xLastSwapDirection', 'USDCtoUSDT');

    const TOKEN_CONFIG = {
        USDC: { name: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', selector: 'img[alt="USDC"]' },
        SOL: { name: 'SOL', address: 'So11111111111111111111111111111111111111112', selector: 'img[alt="SOL"]' },
        WPOND: { 
            name: 'wPOND', 
            address: '3JgFwoYV74f6LwWjQWnr3YDPFnmBdwQfNyubv99jqUoq', 
            descriptionSelector: 'p.text-sm.font-medium.text-white.truncate', 
            descriptionText: 'wPOND' 
        },
        USDT: { name: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', selector: 'img[alt="USDT"]' }
    };

    let selectedSellToken = await GM.getValue('pond0xSelectedSellToken', 'USDC');
    let selectedBuyToken = await GM.getValue('pond0xSelectedBuyToken', 'SOL');

    let lastNotificationTime = 0;
    const NOTIFICATION_INTERVAL = 20000;

    // Improved crash detection with reduced false positives
    const detectCrash = () => {
        const errorText = sanitizeDomContent(document.body.innerText.toLowerCase());
        const isBlackScreen = document.body.style.backgroundColor === 'black' || document.body.style.backgroundColor === '#000000';
        const hasErrorMessage = errorText.includes('application error');
        const hasContent = document.body.innerHTML.length > 100; // Ensure there's some content
        return (hasErrorMessage || (isBlackScreen && !hasContent)) && !document.querySelector('button'); // No interactive elements
    };

    // Periodic crash detection (throttled to 60s)
    setInterval(async () => {
        if (detectCrash()) {
            console.log(`${lh} - Detected application crash. Reloading page...`);
            updateLog('Crash detected');
            notifyUser('Pond0x Warning', 'Application crash detected. Reloading page...');
            await GM.setValue('pond0xLastSwapAmount', swapAmount);
            await GM.setValue('pond0xLastIsSwapping', isSwapping);
            sessionStorage.setItem('pond0xSwapReloaded', 'true');
            window.location.reload();
        }
    }, 60000);

    const notifyUser = (title, body) => {
        const now = Date.now();
        if (now - lastNotificationTime < NOTIFICATION_INTERVAL) {
            console.log(`${lh} - Notification throttled: ${sanitizeInput(title)} - ${sanitizeInput(body)}`);
            return;
        }
        lastNotificationTime = now;
        chrome.runtime.sendMessage({ 
            type: 'notify', 
            title: sanitizeInput(title), 
            body: sanitizeInput(body) 
        });
    };

    const updateLog = (message) => {
        const logWindow = document.getElementById('swapLogWindow');
        if (logWindow && document.body.contains(logWindow)) {
            const currentTime = new Date().toLocaleTimeString();
            logWindow.textContent = `${currentTime}: ${sanitizeInput(message)}\n${sanitizeDomContent(logWindow.textContent.split('\n')[0] || '')}`.trim();
        }
    };

    const redirectWithReferral = () => {
        const referralUrl = 'https://pond0x.com/swap/solana?ref=98UBYhXdXJMhmjE99v9MwTaQery4GeC2dowAtWoJXfavzATMyx7VB7gfVHR';
        const currentUrl = window.location.href;

        if (currentUrl === 'https://pond0x.com/swap/solana' || currentUrl === 'https://www.pond0x.com/swap/solana') {
            console.log(`${lh} - Redirecting to referral link`);
            window.location.replace(referralUrl);
            return true;
        }
        return false;
    };

    if (redirectWithReferral()) {
        console.log(`${lh} - Exiting script after redirect`);
        return;
    }

    const lastIsSwapping = await GM.getValue('pond0xLastIsSwapping', false);
    if (!hasReloaded || !lastIsSwapping) {
        isSwapping = false;
        isSwapRunning = false;
        await GM.setValue('pond0xIsSwapping', false);
        await GM.setValue('pond0xIsSwapRunning', false);
        console.log(`${lh} - Reset swapping state on page load`);
    } else {
        console.log(`${lh} - Preserving swapping state after reload`);
    }

    let isPaused = await GM.getValue('pond0xSwapperIsPaused', false);

    const restoreSwapMode = async () => {
        const savedSwapAmount = await GM.getValue('pond0xLastSwapAmount', null);
        const savedIsSwapping = await GM.getValue('pond0xLastIsSwapping', false);
        if (savedSwapAmount !== null) {
            swapAmount = savedSwapAmount;
            isSwapping = savedIsSwapping;
            await GM.setValue('pond0xSwapAmount', swapAmount);
            await GM.setValue('pond0xIsSwapping', isSwapping);
            console.log(`${lh} - Restored swap mode after reload`);
        }
    };
    if (hasReloaded) await restoreSwapMode();

    async function clickSwapDirectionButton() {
        console.log(`${lh} - Attempting to click swap direction button...`);
        const swapDirectionButton = document.querySelector('div.block svg.icons-sc-71agnn-0.KVxRw');
        if (!swapDirectionButton || !document.body.contains(swapDirectionButton)) {
            console.error(`${lh} - Swap direction button not found`);
            notifyUser('Pond0x Error', 'Swap direction button not found');
            updateLog('Direction button missing');
            return false;
        }

        const parentDiv = swapDirectionButton.closest('div.block');
        if (!parentDiv || !document.body.contains(parentDiv)) {
            console.error(`${lh} - Parent div for swap direction button not found`);
            notifyUser('Pond0x Error', 'Parent div for swap direction button not found');
            updateLog('Direction parent missing');
            return false;
        }

        parentDiv.click();
        console.log(`${lh} - Swap direction button clicked`);
        updateLog('Direction swapped');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
    }

    const waitForPageReady = () => {
        return new Promise((resolve) => {
            const maxWaitTime = 15000;
            const startTime = Date.now();

            const checkReady = () => {
                const button = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                const isVisible = button && button.offsetWidth > 0 && button.offsetHeight > 0 && document.body.contains(button);

                if (document.readyState === 'complete' && button && isVisible) {
                    console.log(`${lh} - Initial page readiness check passed`);
                    swapButton = button;
                    const checkReactReadiness = () => {
                        return new Promise((resolveInner) => {
                            let attempts = 0;
                            const maxAttempts = 10;

                            const check = () => {
                                const dropdowns = document.querySelectorAll('button.rounded-full.flex.items-center');
                                if (dropdowns.length >= 2 && !button.disabled && !dropdowns[0].disabled && document.body.contains(dropdowns[0])) {
                                    console.log(`${lh} - React components ready`);
                                    resolveInner();
                                } else if (attempts >= maxAttempts) {
                                    console.warn(`${lh} - React readiness timeout`);
                                    resolveInner();
                                } else {
                                    attempts++;
                                    setTimeout(check, 500);
                                }
                            };
                            check();
                        });
                    };

                    checkReactReadiness().then(() => {
                        console.log(`${lh} - React components ready after ${Date.now() - startTime}ms`);
                        const observeDOMStability = () => {
                            return new Promise((resolveInner) => {
                                let lastMutationTime = Date.now();
                                const stabilityThreshold = 1000;
                                const maxObservationTime = 5000;

                                const observer = new MutationObserver(() => {
                                    lastMutationTime = Date.now();
                                });

                                const target = document.querySelector('.text-xl.btntxt')?.parentElement || document.body;
                                if (!target || !document.body.contains(target)) {
                                    console.warn(`${lh} - Observation target not found`);
                                    resolveInner();
                                    return;
                                }
                                observer.observe(target, {
                                    childList: true,
                                    subtree: true,
                                    attributes: true
                                });

                                const checkStability = () => {
                                    const timeSinceLastMutation = Date.now() - lastMutationTime;
                                    const totalElapsed = Date.now() - startTime;

                                    if (timeSinceLastMutation >= stabilityThreshold || totalElapsed >= maxObservationTime) {
                                        observer.disconnect();
                                        resolveInner();
                                    } else {
                                        setTimeout(checkStability, 500);
                                    }
                                };

                                setTimeout(checkStability, 500);
                            });
                        };

                        observeDOMStability().then(() => {
                            console.log(`${lh} - DOM stabilized`);
                            resolve(true);
                        }).catch(() => {
                            console.warn(`${lh} - DOM stability timeout`);
                            resolve(true);
                        });
                    }).catch(() => {
                        console.warn(`${lh} - React readiness failed`);
                        resolve(true);
                    });
                } else if (Date.now() - startTime > maxWaitTime) {
                    console.error(`${lh} - Page readiness timeout`);
                    resolve(false);
                } else {
                    console.log(`${lh} - Waiting for page to be ready... (elapsed: ${Date.now() - startTime}ms)`);
                    setTimeout(checkReady, 500);
                }
            };

            setTimeout(checkReady, 1000);
        });
    };

    const waitForSwapButton = () => {
        return new Promise((resolve) => {
            console.log(`${lh} - Waiting for swap button...`);
            let attempts = 0;
            const maxAttempts = 15;

            const checkButton = () => {
                swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                const isVisible = swapButton && swapButton.offsetWidth > 0 && swapButton.offsetHeight > 0 && document.body.contains(swapButton);
                if (swapButton && isVisible) {
                    console.log(`${lh} - Swap button found`);
                    resolve(swapButton);
                    return;
                }
                attempts++;
                if (attempts >= maxAttempts) {
                    console.error(`${lh} - Swap button not found after ${maxAttempts} attempts`);
                    resolve(null);
                    return;
                }
                setTimeout(checkButton, 500);
            };
            checkButton();
        });
    };

    // CSRF token management
    let csrfToken = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
    setInterval(() => {
        csrfToken = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
        console.log(`${lh} - CSRF token rotated`);
    }, 300000); // Rotate every 5 minutes

    const fetchManifestSwaps = async (walletAddress) => {
        return new Promise((resolve) => {
            const sanitizedWallet = sanitizeInput(walletAddress);
            const hashedWallet = btoa(sanitizedWallet.slice(0, 4) + '...');
            console.log(`${lh} - Fetching manifest swaps for wallet: ${hashedWallet}`);
            chrome.runtime.sendMessage({ 
                action: 'openTab', 
                url: 'https://cary0x.github.io/docs/info/manifest',
                csrfToken: csrfToken 
            }, (tabId) => {
                if (!tabId) {
                    console.error(`${lh} - Failed to open hidden tab`);
                    resolve('Error');
                    return;
                }

                chrome.runtime.sendMessage({
                    action: 'injectManifestScript',
                    tabId: tabId,
                    walletAddress: sanitizedWallet,
                    csrfToken: csrfToken
                });

                chrome.runtime.onMessage.addListener(function listener(message) {
                    if (message.action === 'scrapedSwaps' && message.tabId === tabId) {
                        console.log(`${lh} - Received swaps: ${sanitizeInput(message.swaps)}`);
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve(sanitizeInput(message.swaps));
                    }
                });
            });
        });
    };
    async function initializeControlPanel() {
        const attachStartSwappingListener = (startSwappingBtn) => {
            console.log(`${lh} - Attaching event listener to Start Swapping button at ${new Date().toISOString()}`);
            startSwappingBtn.removeEventListener('click', handleStartSwapping);
            startSwappingBtn.addEventListener('click', handleStartSwapping);
        };

        const handleStartSwapping = async () => {
            console.log(`${lh} - Start Swapping button clicked at ${new Date().toISOString()}. Current state: isSwapRunning=${isSwapRunning}, isSwapping=${isSwapping}`);
            if (!isSwapRunning && !isPaused) {
                try {
                    isSwapping = true;
                    isSwapRunning = true;
                    await GM.setValue('pond0xIsSwapping', true);
                    await GM.setValue('pond0xIsSwapRunning', true);
                    console.log(`${lh} - Updated state: isSwapping=${isSwapping}, isSwapRunning=${isSwapRunning}`);
                    const startSwappingBtn = document.getElementById('startSwappingBtn');
                    if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                        startSwappingBtn.textContent = 'Stop Swapping';
                        startSwappingBtn.style.background = '#dc3545';
                    }
                    updateLog('Starting swap process');
                    await startSwapping();
                } catch (error) {
                    console.error(`${lh} - Error in startSwapping at ${new Date().toISOString()}:`, error);
                    notifyUser('Pond0x Error', `Error starting swap: ${sanitizeInput(error.message)}`);
                    updateLog(`Error: ${sanitizeInput(error.message)}`);
                    const startSwappingBtn = document.getElementById('startSwappingBtn');
                    if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                        startSwappingBtn.textContent = 'Start Swapping';
                        startSwappingBtn.style.background = '#28a745';
                        startSwappingBtn.disabled = false;
                    }
                    isSwapping = false;
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    await GM.setValue('pond0xIsSwapRunning', false);
                }
            } else if (isSwapRunning) {
                isSwapping = false;
                isSwapRunning = false;
                await GM.setValue('pond0xIsSwapping', false);
                await GM.setValue('pond0xIsSwapRunning', false);
                console.log(`${lh} - Stopped swapping: isSwapping=${isSwapping}, isSwapRunning=${isSwapRunning}`);
                const startSwappingBtn = document.getElementById('startSwappingBtn');
                if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                    startSwappingBtn.textContent = 'Start Swapping';
                    startSwappingBtn.style.background = '#28a745';
                    startSwappingBtn.disabled = false;
                }
                updateLog('Swapping stopped');
                notifyUser('Pond0x Info', 'Swapping stopped successfully');
            } else {
                console.log(`${lh} - Swap already running or paused, ignoring Start Swapping click`);
            }
        };

        if (!controlPanel || !document.body.contains(controlPanel)) {
            const button = await waitForSwapButton();
            if (!button || !document.body.contains(button)) {
                console.error(`${lh} - Swap button not found for control panel initialization`);
                notifyUser('Pond0x Error', 'Swap button not found. AutoSwapper initialization failed');
                return;
            }

            controlPanel = document.createElement('div');
            controlPanel.id = 'pond0xSwapControlPanel';
            controlPanel.style.cssText = `
                position: fixed;
                background: rgba(74, 29, 125, 1) !important;
                border: 2px solid #000000;
                border-radius: 10px;
                color: #ffffff;
                font-family: Arial, Helvetica, sans-serif;
                padding: 10px;
                z-index: 10000000;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                width: 450px;
                cursor: move;
            `;

            let isDragging = false;
            let currentX, currentY;
            initialPanelPosition = {
                left: `${button.getBoundingClientRect().left + window.scrollX}px`,
                top: `${button.getBoundingClientRect().bottom + window.scrollY + 100}px`
            };

            controlPanel.style.left = initialPanelPosition.left;
            controlPanel.style.top = initialPanelPosition.top;
            console.log(`${lh} - Control panel initial position set:`, initialPanelPosition);

            controlPanel.onmousedown = (e) => {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && 
                    !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) {
                    isDragging = true;
                    currentX = e.clientX - parseInt(controlPanel.style.left);
                    currentY = e.clientY - parseInt(controlPanel.style.top);
                    e.preventDefault();
                }
            };

            document.onmousemove = (e) => {
                if (isDragging) {
                    controlPanel.style.left = `${e.clientX - currentX}px`;
                    controlPanel.style.top = `${e.clientY - currentY}px`;
                    const boxRect = controlPanel.getBoundingClientRect();
                    if (boxRect.left < 0) controlPanel.style.left = '0px';
                    if (boxRect.top < 0) controlPanel.style.top = '0px';
                    if (boxRect.right > window.innerWidth) controlPanel.style.left = `${window.innerWidth - boxRect.width}px`;
                    if (boxRect.bottom > window.innerHeight) controlPanel.style.top = `${window.innerHeight - boxRect.height}px`;
                }
            };

            document.onmouseup = () => {
                isDragging = false;
            };

            const header = document.createElement('div');
            header.style.cssText = `
                font-weight: bold;
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            `;
            header.innerHTML = `
                <div style="display: flex; align-items: center; position: relative;">
                    <input type="checkbox" id="autoToggle" ${isAutoMode ? 'checked' : ''} style="display: none;">
                    <span id="toggleLabel" style="background: ${isAutoMode ? '#28a745' : '#dc3545'}; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px; cursor: pointer;">
                        ${isAutoMode ? 'Auto' : 'Manual'}
                    </span>
                </div>
                <span style="position: absolute; left: 50%; transform: translateX(-50%);">Ez Mode-v4.2.0 🐻🤝💧</span>
                <div style="visibility: hidden; display: flex; align-items: center;">
                    <span style="padding: 3px 8px; border-radius: 3px; font-size: 12px;">${isAutoMode ? 'Auto' : 'Manual'}</span>
                </div>
            `;
            controlPanel.appendChild(header);

            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = `
                display: flex;
                gap: 10px;
                margin-bottom: 10px;
            `;

            let startSwappingBtn = document.createElement('button');
            startSwappingBtn.id = 'startSwappingBtn';
            startSwappingBtn.textContent = 'Start Swapping';
            startSwappingBtn.style.cssText = `
                background: ${isSwapRunning ? '#dc3545' : '#28a745'};
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;

            const pauseResumeBtn = document.createElement('button');
            pauseResumeBtn.id = 'pauseResumeBtn';
            pauseResumeBtn.textContent = isPaused ? 'Resume' : 'Pause';
            pauseResumeBtn.style.cssText = `
                background: ${isPaused ? '#28a745' : '#FFFF00'};
                color: ${isPaused ? 'white' : 'black'};
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;
            pauseResumeBtn.addEventListener('click', async () => {
                isPaused = !isPaused;
                await GM.setValue('pond0xSwapperIsPaused', isPaused);
                pauseResumeBtn.textContent = isPaused ? 'Resume' : 'Pause';
                pauseResumeBtn.style.backgroundColor = isPaused ? '#28a745' : '#FFFF00';
                pauseResumeBtn.style.color = isPaused ? 'white' : 'black';

                const startSwappingBtn = document.getElementById('startSwappingBtn');
                if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                    startSwappingBtn.disabled = isPaused;
                }

                if (isPaused) {
                    console.log(`${lh} - Pausing swapping`);
                    updateLog('Swapping paused');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                } else if (!isSwapRunning) {
                    console.log(`${lh} - Resuming swapping`);
                    updateLog('Swapping resumed');
                    isSwapping = true;
                    await GM.setValue('pond0xIsSwapping', true);
                    isSwapRunning = true;
                    await GM.setValue('pond0xIsSwapRunning', true);
                    try {
                        await startSwapping();
                    } catch (error) {
                        console.error(`${lh} - Error resuming swapping:`, error);
                        notifyUser('Pond0x Error', `Error resuming swap: ${sanitizeInput(error.message)}`);
                        updateLog(`Error: ${sanitizeInput(error.message)}`);
                        isSwapping = false;
                        await GM.setValue('pond0xIsSwapping', false);
                        isSwapRunning = false;
                        await GM.setValue('pond0xIsSwapRunning', false);
                        if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                            startSwappingBtn.disabled = false;
                        }
                    }
                }
            });

            const boostSwapsBtn = document.createElement('button');
            boostSwapsBtn.id = 'boostSwapsBtn';
            boostSwapsBtn.textContent = 'Boost Swaps';
            boostSwapsBtn.style.cssText = `
                background: #00CED1;
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;
            boostSwapsBtn.addEventListener('click', async () => {
                try {
                    boostSwapsBtn.disabled = true;
                    rewardSwapsBtn.disabled = true;
                    customSwapsBtn.disabled = true;
                    swapAmount = 0.01;
                    swapMode = 'Boost';
                    isRewardSwapsMode = false;
                    await GM.setValue('pond0xSwapAmount', swapAmount);
                    await GM.setValue('pond0xLastSwapAmount', swapAmount);
                    await GM.setValue('pond0xSwapMode', swapMode);
                    await GM.setValue('pond0xIsRewardSwapsMode', isRewardSwapsMode);
                    console.log(`${lh} - Boost Swaps activated`);
                    updateLog(`Boost: 0.01 ${selectedSellToken}`);
                    const success = await updateAmountInput();
                    if (!success) {
                        console.error(`${lh} - Failed to update amount`);
                        notifyUser('Pond0x Error', 'Failed to set amount to 0.01');
                        updateLog('Amount update failed');
                    }
                    boostSwapsBtn.style.background = '#28a745';
                    rewardSwapsBtn.style.background = '#00CED1';
                    customSwapsBtn.style.background = '#00CED1';

                    const sellTokenSelect = document.getElementById('sellTokenSelect');
                    const buyTokenSelect = document.getElementById('buyTokenSelect');
                    const updateTokenButton = document.getElementById('updateTokenButton');
                    if (sellTokenSelect && buyTokenSelect && updateTokenButton && 
                        document.body.contains(sellTokenSelect) && document.body.contains(buyTokenSelect) && document.body.contains(updateTokenButton)) {
                        sellTokenSelect.disabled = false;
                        buyTokenSelect.disabled = false;
                        updateTokenButton.disabled = false;
                    }

                    reInjectControlPanel();
                } catch (error) {
                    console.error(`${lh} - Error updating amount:`, error);
                    notifyUser('Pond0x Error', `Error updating amount: ${sanitizeInput(error.message)}`);
                    updateLog(`Error: ${sanitizeInput(error.message)}`);
                } finally {
                    boostSwapsBtn.disabled = false;
                    rewardSwapsBtn.disabled = false;
                    customSwapsBtn.disabled = false;
                }
            });

            const rewardSwapsBtn = document.createElement('button');
            rewardSwapsBtn.id = 'rewardSwapsBtn';
            rewardSwapsBtn.textContent = 'Reward Swaps';
            rewardSwapsBtn.style.cssText = `
                background: #00CED1;
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;
            rewardSwapsBtn.addEventListener('click', async () => {
                try {
                    boostSwapsBtn.disabled = true;
                    rewardSwapsBtn.disabled = true;
                    customSwapsBtn.disabled = true;
                    swapAmount = 9.02;
                    swapMode = 'Reward';
                    isRewardSwapsMode = true;
                    await GM.setValue('pond0xSwapAmount', swapAmount);
                    await GM.setValue('pond0xLastSwapAmount', swapAmount);
                    await GM.setValue('pond0xSwapMode', swapMode);
                    await GM.setValue('pond0xIsRewardSwapsMode', isRewardSwapsMode);

                    selectedSellToken = 'USDC';
                    selectedBuyToken = 'USDT';
                    await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                    await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);

                    console.log(`${lh} - Reward Swaps activated`);
                    updateLog(`Reward: 9.02 ${selectedSellToken} -> ${selectedBuyToken}`);

                    const sellTokenSelect = document.getElementById('sellTokenSelect');
                    const buyTokenSelect = document.getElementById('buyTokenSelect');
                    const updateTokenButton = document.getElementById('updateTokenButton');
                    if (sellTokenSelect && buyTokenSelect && updateTokenButton && 
                        document.body.contains(sellTokenSelect) && document.body.contains(buyTokenSelect) && document.body.contains(updateTokenButton)) {
                        sellTokenSelect.value = selectedSellToken;
                        buyTokenSelect.value = selectedBuyToken;
                        sellTokenSelect.disabled = true;
                        buyTokenSelect.disabled = true;
                        updateTokenButton.disabled = true;
                    }

                    const tokenSetupSuccess = await setupTokensAndAmount();
                    if (!tokenSetupSuccess) {
                        console.error(`${lh} - Failed to set up token pair`);
                        notifyUser('Pond0x Error', 'Failed to set token pair');
                        updateLog('Token setup failed');
                    }

                    const success = await updateAmountInput();
                    if (!success) {
                        console.error(`${lh} - Failed to update amount`);
                        notifyUser('Pond0x Error', 'Failed to set amount to 9.02');
                        updateLog('Amount update failed');
                    }
                    rewardSwapsBtn.style.background = '#28a745';
                    boostSwapsBtn.style.background = '#00CED1';
                    customSwapsBtn.style.background = '#00CED1';
                    reInjectControlPanel();
                } catch (error) {
                    console.error(`${lh} - Error updating amount:`, error);
                    notifyUser('Pond0x Error', `Error updating amount: ${sanitizeInput(error.message)}`);
                    updateLog(`Error: ${sanitizeInput(error.message)}`);
                } finally {
                    boostSwapsBtn.disabled = false;
                    rewardSwapsBtn.disabled = false;
                    customSwapsBtn.disabled = false;
                }
            });

            const customSwapsBtn = document.createElement('button');
            customSwapsBtn.id = 'customSwapsBtn';
            customSwapsBtn.textContent = 'Custom Swap';
            customSwapsBtn.style.cssText = `
                background: #00CED1;
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;
            const customSwapInput = document.createElement('input');
            customSwapInput.id = 'customSwapInput';
            customSwapInput.type = 'number';
            customSwapInput.step = '0.001';
            customSwapInput.min = '0.001';
            customSwapInput.max = '9999.999';
            customSwapInput.value = swapAmount.toFixed(3);
            customSwapInput.style.cssText = `
                width: 60px;
                font-size: 12px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                color: #ffffff;
                border: 1px solid #ffffff;
                border-radius: 5px;
                padding: 2px 5px;
                margin-left: 5px;
            `;
            customSwapInput.addEventListener('change', async (e) => {
                let value = parseFloat(sanitizeInput(e.target.value));
                if (value < 0.001) value = 0.001;
                if (value > 9999.999) value = 9999.999;
                customSwapInput.value = value.toFixed(3);
                swapAmount = value;
                await GM.setValue('pond0xSwapAmount', swapAmount);
                await GM.setValue('pond0xLastSwapAmount', swapAmount);
                console.log(`${lh} - Custom swap amount updated`);
                updateLog(`Custom: ${swapAmount} ${selectedSellToken}`);
            });

            customSwapsBtn.addEventListener('click', async () => {
                try {
                    boostSwapsBtn.disabled = true;
                    rewardSwapsBtn.disabled = true;
                    customSwapsBtn.disabled = true;
                    const customValue = parseFloat(sanitizeInput(customSwapInput.value));
                    if (isNaN(customValue) || customValue < 0.001) {
                        console.error(`${lh} - Invalid custom swap value`);
                        notifyUser('Pond0x Error', 'Invalid custom swap value');
                        updateLog('Invalid custom value');
                        return;
                    }
                    swapAmount = customValue;
                    swapMode = 'Custom';
                    isRewardSwapsMode = false;
                    await GM.setValue('pond0xSwapAmount', swapAmount);
                    await GM.setValue('pond0xLastSwapAmount', swapAmount);
                    await GM.setValue('pond0xSwapMode', swapMode);
                    await GM.setValue('pond0xIsRewardSwapsMode', isRewardSwapsMode);
                    console.log(`${lh} - Custom Swap activated`);
                    updateLog(`Custom: ${swapAmount} ${selectedSellToken}`);
                    const success = await updateAmountInput();
                    if (!success) {
                        console.error(`${lh} - Failed to update amount`);
                        notifyUser('Pond0x Error', `Failed to set amount to ${swapAmount}`);
                        updateLog('Amount update failed');
                    }
                    customSwapsBtn.style.background = '#28a745';
                    boostSwapsBtn.style.background = '#00CED1';
                    rewardSwapsBtn.style.background = '#00CED1';

                    const sellTokenSelect = document.getElementById('sellTokenSelect');
                    const buyTokenSelect = document.getElementById('buyTokenSelect');
                    const updateTokenButton = document.getElementById('updateTokenButton');
                    if (sellTokenSelect && buyTokenSelect && updateTokenButton && 
                        document.body.contains(sellTokenSelect) && document.body.contains(buyTokenSelect) && document.body.contains(updateTokenButton)) {
                        sellTokenSelect.disabled = false;
                        buyTokenSelect.disabled = false;
                        updateTokenButton.disabled = false;
                    }

                    reInjectControlPanel();
                } catch (error) {
                    console.error(`${lh} - Error updating custom amount:`, error);
                    notifyUser('Pond0x Error', `Error updating custom amount: ${sanitizeInput(error.message)}`);
                    updateLog(`Error: ${sanitizeInput(error.message)}`);
                } finally {
                    boostSwapsBtn.disabled = false;
                    rewardSwapsBtn.disabled = false;
                    customSwapsBtn.disabled = false;
                }
            });

            if (swapMode === 'Boost') {
                boostSwapsBtn.style.background = '#28a745';
                rewardSwapsBtn.style.background = '#00CED1';
                customSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Boost Swaps mode in control panel`);
            } else if (swapMode === 'Reward') {
                rewardSwapsBtn.style.background = '#28a745';
                boostSwapsBtn.style.background = '#00CED1';
                customSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Reward Swaps mode in control panel`);
            } else if (swapMode === 'Custom') {
                customSwapsBtn.style.background = '#28a745';
                boostSwapsBtn.style.background = '#00CED1';
                rewardSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Custom Swaps mode in control panel`);
            }

            buttonContainer.appendChild(startSwappingBtn);
            buttonContainer.appendChild(pauseResumeBtn);
            buttonContainer.appendChild(boostSwapsBtn);
            buttonContainer.appendChild(rewardSwapsBtn);
            buttonContainer.appendChild(customSwapsBtn);
            buttonContainer.appendChild(customSwapInput);
            controlPanel.appendChild(buttonContainer);

            const statusContainer = document.createElement('div');
            statusContainer.style.cssText = `
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
                margin-top: 5px;
                font-size: 11px;
            `;
            const swapCounterElement = document.createElement('div');
            swapCounterElement.id = 'swapCounter';
            swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
            statusContainer.appendChild(swapCounterElement);
            controlPanel.appendChild(statusContainer);

            const tokenSelectionContainer = document.createElement('div');
            tokenSelectionContainer.style.cssText = `
                margin-top: 5px;
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
                display: flex;
                gap: 10px;
                align-items: center;
            `;

            const sellTokenLabel = document.createElement('label');
            sellTokenLabel.textContent = 'Sell Token: ';
            sellTokenLabel.style.fontSize = '12px';

            const sellTokenSelect = document.createElement('select');
            sellTokenSelect.id = 'sellTokenSelect';
            sellTokenSelect.style.cssText = `
                font-size: 12px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                color: #ffffff;
                border: 1px solid #ffffff;
                border-radius: 5px;
                padding: 2px 5px;
            `;

            const buyTokenLabel = document.createElement('label');
            buyTokenLabel.textContent = 'Buy Token: ';
            buyTokenLabel.style.fontSize = '12px';

            const buyTokenSelect = document.createElement('select');
            buyTokenSelect.id = 'buyTokenSelect';
            buyTokenSelect.style.cssText = `
                font-size: 12px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                color: #ffffff;
                border: 1px solid #ffffff;
                border-radius: 5px;
                padding: 2px 5px;
            `;

            const updateTokenButton = document.createElement('button');
            updateTokenButton.id = 'updateTokenButton';
            updateTokenButton.textContent = 'Update';
            updateTokenButton.style.cssText = `
                background: #28a745;
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
            `;
            updateTokenButton.addEventListener('click', async () => {
                const sellValue = sanitizeInput(sellTokenSelect.value);
                const buyValue = sanitizeInput(buyTokenSelect.value);
                if (sellValue === buyValue) {
                    console.warn(`${lh} - Cannot update: Sell and Buy tokens cannot be the same (${sellValue})`);
                    notifyUser('Pond0x Warning', 'Sell and Buy tokens cannot be the same');
                    return;
                }
                selectedSellToken = sellValue;
                selectedBuyToken = buyValue;
                await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                console.log(`${lh} - Tokens updated`);
                updateLog(`Tokens: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
                notifyUser('Pond0x Info', `Tokens updated to Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
                await setupTokensAndAmount();
            });

            const tokenKeys = Object.keys(TOKEN_CONFIG);
            tokenKeys.forEach(token => {
                const sellOption = document.createElement('option');
                sellOption.value = token;
                sellOption.textContent = TOKEN_CONFIG[token].name;
                if (token === selectedSellToken && token !== selectedBuyToken) sellOption.selected = true;
                sellTokenSelect.appendChild(sellOption);

                const buyOption = document.createElement('option');
                buyOption.value = token;
                buyOption.textContent = TOKEN_CONFIG[token].name;
                if (token === selectedBuyToken && token !== selectedSellToken) buyOption.selected = true;
                buyTokenSelect.appendChild(buyOption);
            });

            sellTokenSelect.addEventListener('change', (e) => {
                const sellValue = sanitizeInput(e.target.value);
                if (sellValue === buyTokenSelect.value) {
                    const availableTokens = tokenKeys.filter(t => t !== sellValue);
                    const newBuyToken = availableTokens[0] || tokenKeys[0];
                    buyTokenSelect.value = newBuyToken;
                    selectedBuyToken = newBuyToken;
                    GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                }
                selectedSellToken = sellValue;
                GM.setValue('pond0xSelectedSellToken', selectedSellToken);
            });

            buyTokenSelect.addEventListener('change', (e) => {
                const buyValue = sanitizeInput(e.target.value);
                if (buyValue === sellTokenSelect.value) {
                    const availableTokens = tokenKeys.filter(t => t !== buyValue);
                    const newSellToken = availableTokens[0] || tokenKeys[0];
                    sellTokenSelect.value = newSellToken;
                    selectedSellToken = newSellToken;
                    GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                }
                selectedBuyToken = buyValue;
                GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
            });

            if (isRewardSwapsMode) {
                sellTokenSelect.disabled = true;
                buyTokenSelect.disabled = true;
                updateTokenButton.disabled = true;
            }

            tokenSelectionContainer.appendChild(sellTokenLabel);
            tokenSelectionContainer.appendChild(sellTokenSelect);
            tokenSelectionContainer.appendChild(buyTokenLabel);
            tokenSelectionContainer.appendChild(buyTokenSelect);
            tokenSelectionContainer.appendChild(updateTokenButton);
            controlPanel.appendChild(tokenSelectionContainer);

            const settingsContainer = document.createElement('div');
            settingsContainer.style.cssText = `
                margin-top: 5px;
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
                display: flex;
                gap: 10px;
            `;

            const retryIntervalLabel = document.createElement('label');
            retryIntervalLabel.textContent = 'Swap Frequency (sec): ';
            retryIntervalLabel.style.fontSize = '12px';
            const retryIntervalInput = document.createElement('input');
            retryIntervalInput.type = 'number';
            retryIntervalInput.value = retryInterval / 1000;
            retryIntervalInput.style.cssText = `
                width: 50px;
                font-size: 12px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                color: #ffffff;
                border: 1px solid #ffffff;
                border-radius: 5px;
                padding: 2px 5px;
            `;
            retryIntervalInput.addEventListener('change', async (e) => {
                retryInterval = parseInt(sanitizeInput(e.target.value)) * 1000 || 3000;
                await GM.setValue('pond0xRetryInterval', retryInterval);
                console.log(`${lh} - Swap frequency updated`);
                updateLog(`Freq: ${retryInterval / 1000}s`);
            });

            settingsContainer.appendChild(retryIntervalLabel);
            settingsContainer.appendChild(retryIntervalInput);
            controlPanel.appendChild(settingsContainer);

            const logContainer = document.createElement('div');
            logContainer.style.cssText = `
                margin-top: 5px;
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
            `;
            const logWindow = document.createElement('div');
            logWindow.id = 'swapLogWindow';
            logWindow.style.cssText = `
                font-size: 11px;
                color: #ffffff;
                height: 24px;
                overflow-y: hidden;
                white-space: pre-wrap;
            `;
            logWindow.textContent = 'Initializing...';
            logContainer.appendChild(logWindow);
            controlPanel.appendChild(logContainer);

            const totalSwapContainer = document.createElement('div');
            totalSwapContainer.style.cssText = `
                margin-top: 5px;
                background: rgba(0, 0, 0, 0.5);
                padding: 5px;
                border-radius: 5px;
                display: flex;
                flex-direction: column;
                gap: 5px;
            `;

            const walletInputContainer = document.createElement('div');
            walletInputContainer.style.cssText = `
                display: flex;
                align-items: center;
                gap: 5px;
            `;
            const walletLabel = document.createElement('label');
            walletLabel.textContent = 'Wallet Address: ';
            walletLabel.style.fontSize = '12px';
            const walletInput = document.createElement('input');
            walletInput.type = 'text';
            walletInput.placeholder = 'Enter wallet address';
            walletInput.style.cssText = `
                width: 150px;
                font-size: 12px;
                background: linear-gradient(to bottom, #4a1d7d, #8a2be2);
                color: #ffffff;
                border: 1px solid #ffffff;
                border-radius: 5px;
                padding: 2px 5px;
            `;
            walletInput.addEventListener('change', async (e) => {
                const walletAddress = sanitizeInput(e.target.value.trim());
                if (walletAddress.length >= 32 && walletAddress.length <= 44) {
                    updateLog('Fetching swaps');
                    console.log(`${lh} - Fetching swaps for wallet: ${btoa(walletAddress.slice(0, 4) + '...')}`);
                    const swaps = await fetchManifestSwaps(walletAddress);
                    const manifestSwapsElement = document.getElementById('manifestSwaps');
                    if (manifestSwapsElement && document.body.contains(manifestSwapsElement)) {
                        manifestSwapsElement.textContent = `Manifest Swaps: ${sanitizeInput(swaps)}`;
                        console.log(`${lh} - Updated swaps display`);
                        updateLog(`Swaps: ${sanitizeInput(swaps)}`);
                    }
                } else {
                    updateLog('Invalid wallet');
                    console.log(`${lh} - Invalid wallet address length`);
                }
            });

            walletInputContainer.appendChild(walletLabel);
            walletInputContainer.appendChild(walletInput);
            totalSwapContainer.appendChild(walletInputContainer);

            const manifestSwapsElement = document.createElement('div');
            manifestSwapsElement.id = 'manifestSwaps';
            manifestSwapsElement.style.fontSize = '11px';
            manifestSwapsElement.textContent = 'Manifest Swaps: N/A';
            totalSwapContainer.appendChild(manifestSwapsElement);
            controlPanel.appendChild(totalSwapContainer);

            const statsResetBtn = document.createElement('button');
            statsResetBtn.id = 'statsResetBtn';
            statsResetBtn.textContent = 'Stats Reset';
            statsResetBtn.style.cssText = `
                background: #28a745;
                color: white;
                border: none;
                border-radius: 3px;
                padding: 5px 10px;
                cursor: pointer;
                font-size: 12px;
                margin-top: 5px;
            `;
            statsResetBtn.addEventListener('click', async () => {
                swapCounter = 0;
                await GM.setValue('pond0xSwapCounter', swapCounter);
                const swapCounterElement = document.getElementById('swapCounter');
                if (swapCounterElement && document.body.contains(swapCounterElement)) {
                    swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
                }
                console.log(`${lh} - Stats reset`);
                updateLog('Stats reset');
                notifyUser('Pond0x Info', 'Swap stats reset successfully');
            });
            controlPanel.appendChild(statsResetBtn);

            document.body.appendChild(controlPanel);

            const autoToggle = document.getElementById('autoToggle');
            const toggleLabel = document.getElementById('toggleLabel');
            if (toggleLabel && autoToggle && document.body.contains(toggleLabel) && document.body.contains(autoToggle)) {
                toggleLabel.addEventListener('click', async () => {
                    isAutoMode = !isAutoMode;
                    await GM.setValue('pond0xIsAutoMode', isAutoMode);
                    toggleLabel.textContent = isAutoMode ? 'Auto' : 'Manual';
                    toggleLabel.style.background = isAutoMode ? '#28a745' : '#dc3545';
                    autoToggle.checked = isAutoMode;
                    console.log(`${lh} - Mode switched`);
                    updateLog(`Mode: ${isAutoMode ? 'Auto' : 'Manual'}`);
                });
            }

            attachStartSwappingListener(startSwappingBtn);

            const tooltipBox = document.createElement('div');
            tooltipBox.id = 'tooltipBox';
            tooltipBox.style.cssText = `
                display: none;
                opacity: 0;
                transition: opacity 0.3s ease;
                position: fixed;
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
                z-index: 10000001;
            `;
            document.body.appendChild(tooltipBox);

            const style = document.createElement('style');
            style.textContent = `
                #tooltipBox.visible {
                    display: block;
                    opacity: 1;
                }
            `;
            document.head.appendChild(style);

            const tooltipContent = {
                startSwappingBtn: 'Starts the auto-swapping process',
                pauseResumeBtn: 'Pauses or resumes swapping',
                boostSwapsBtn: 'Sets swap to 0.01 USDC',
                rewardSwapsBtn: 'Sets swap to 9.02 USDC',
                customSwapsBtn: 'Sets custom swap amount',
                statsResetBtn: 'Resets swap counter',
                sellTokenSelect: 'Select token to sell',
                buyTokenSelect: 'Select token to buy',
                updateTokenButton: 'Applies token selection'
            };

            const showTooltip = (element) => {
                const content = tooltipContent[element.id];
                if (content) {
                    tooltipBox.textContent = sanitizeInput(content);
                    const rect = element.getBoundingClientRect();
                    tooltipBox.style.top = `${rect.bottom + window.scrollY + 5}px`;
                    tooltipBox.style.left = `${rect.left + window.scrollX}px`;
                    tooltipBox.classList.add('visible');
                }
            };

            const hideTooltip = () => {
                tooltipBox.classList.remove('visible');
            };

            [startSwappingBtn, pauseResumeBtn, boostSwapsBtn, rewardSwapsBtn, customSwapsBtn, statsResetBtn, sellTokenSelect, buyTokenSelect, updateTokenButton].forEach(elem => {
                if (document.body.contains(elem)) {
                    elem.addEventListener('mouseenter', () => showTooltip(elem));
                    elem.addEventListener('mouseleave', hideTooltip);
                }
            });
        } else {
            console.log(`${lh} - Control panel exists, updating`);
            const startSwappingBtn = document.getElementById('startSwappingBtn');
            if (startSwappingBtn && document.body.contains(startSwappingBtn)) {
                startSwappingBtn.textContent = isSwapRunning ? 'Stop Swapping' : 'Start Swapping';
                startSwappingBtn.style.background = isSwapRunning ? '#dc3545' : '#28a745';
                startSwappingBtn.disabled = isPaused || isSwapRunning;
                attachStartSwappingListener(startSwappingBtn);
            }
            const pauseResumeBtn = document.getElementById('pauseResumeBtn');
            if (pauseResumeBtn && document.body.contains(pauseResumeBtn)) {
                pauseResumeBtn.textContent = isPaused ? 'Resume' : 'Pause';
                pauseResumeBtn.style.backgroundColor = isPaused ? '#28a745' : '#FFFF00';
                pauseResumeBtn.style.color = isPaused ? 'white' : 'black';
            }
            const swapCounterElement = document.getElementById('swapCounter');
            if (swapCounterElement && document.body.contains(swapCounterElement)) {
                swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
            }
            const sellTokenSelect = document.getElementById('sellTokenSelect');
            const buyTokenSelect = document.getElementById('buyTokenSelect');
            if (sellTokenSelect && buyTokenSelect && document.body.contains(sellTokenSelect) && document.body.contains(buyTokenSelect)) {
                sellTokenSelect.value = selectedSellToken;
                buyTokenSelect.value = selectedBuyToken;
            }
            const logWindow = document.getElementById('swapLogWindow');
            if (logWindow && document.body.contains(logWindow)) logWindow.textContent = 'Control panel updated';
        }
    }

    async function updateAmountInput() {
        console.log(`${lh} - Starting updateAmountInput...`);
        const amountInput = document.querySelector('input[placeholder="0.00"]');
        if (!amountInput || !document.body.contains(amountInput)) {
            console.error(`${lh} - Amount input not found`);
            notifyUser('Pond0x Warning', 'Amount input not found');
            updateLog('Input not found');
            return false;
        }

        console.log(`${lh} - Updating amount input to ${swapAmount} ${selectedSellToken}...`);
        updateLog(`Set: ${swapAmount}`);

        const setAmount = async () => {
            try {
                amountInput.focus();
                amountInput.value = '';
                await new Promise(resolve => setTimeout(resolve, 100));
                amountInput.value = swapAmount.toString();

                const inputEvent = new Event('input', { bubbles: true });
                amountInput.dispatchEvent(inputEvent);
                const changeEvent = new Event('change', { bubbles: true });
                amountInput.dispatchEvent(changeEvent);
                amountInput.blur();

                await new Promise(resolve => setTimeout(resolve, 500));
                if (amountInput.value !== swapAmount.toString()) {
                    console.warn(`${lh} - Amount input update failed`);
                    return false;
                }
                console.log(`${lh} - Amount verified as ${swapAmount} after update`);
                updateLog(`Verified: ${swapAmount}`);
                return true;
            } catch (e) {
                console.error(`${lh} - Error setting amount:`, e);
                return false;
            }
        };

        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            const success = await setAmount();
            if (success) return true;
            attempts++;
            console.log(`${lh} - Attempt ${attempts}/${maxAttempts} failed`);
            updateLog(`Retry ${attempts} failed`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.error(`${lh} - Failed to update amount after ${maxAttempts} attempts`);
        notifyUser('Pond0x Error', 'Failed to update swap amount');
        updateLog('Amount update failed');
        return false;
    }
    async function setupTokensAndAmount() {
        console.log(`${lh} - Starting token setup...`);
        if (isSettingUp) {
            console.log(`${lh} - Setup in progress, skipping`);
            return false;
        }
        isSettingUp = true;
        console.log(`${lh} - Setting up token pair and amount...`);
        updateLog('Setting up');

        const sellToken = TOKEN_CONFIG[selectedSellToken];
        const buyToken = TOKEN_CONFIG[selectedBuyToken];

        console.log(`${lh} - Waiting for DOM stability before token setup...`);
        try {
            await new Promise((resolve) => {
                let lastMutationTime = Date.now();
                const stabilityThreshold = 500;
                const maxWaitTime = 2000;
                const observer = new MutationObserver(() => {
                    console.log(`${lh} - DOM mutation detected at ${Date.now() - lastMutationTime}ms since last mutation`);
                    lastMutationTime = Date.now();
                });

                const checkDropdownReadiness = () => {
                    const buyDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                    return buyDropdown && buyDropdown.offsetWidth > 0 && buyDropdown.offsetHeight > 0 && document.body.contains(buyDropdown);
                };

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true
                });

                const checkStability = () => {
                    const timeSinceLastMutation = Date.now() - lastMutationTime;
                    const totalElapsed = Date.now() - (lastMutationTime - stabilityThreshold);
                    console.log(`${lh} - Checking stability: timeSinceLastMutation=${timeSinceLastMutation}ms, totalElapsed=${totalElapsed}ms, buyDropdownReady=${checkDropdownReadiness()}`);
                    if ((timeSinceLastMutation >= stabilityThreshold || totalElapsed >= maxWaitTime) && checkDropdownReadiness()) {
                        observer.disconnect();
                        console.log(`${lh} - DOM stabilized`);
                        resolve();
                    } else {
                        setTimeout(checkStability, 500);
                    }
                };

                setTimeout(checkStability, 500);
                setTimeout(() => {
                    observer.disconnect();
                    console.warn(`${lh} - DOM stability timeout`);
                    resolve();
                }, maxWaitTime);
            });
        } catch (error) {
            console.error(`${lh} - DOM stability error:`, error);
            notifyUser('Pond0x Warning', `DOM stabilization error: ${sanitizeInput(error.message)}`);
            updateLog(`DOM error`);
        }

        try {
            const sellDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[0];
            if (!sellDropdown || !document.body.contains(sellDropdown)) {
                console.error(`${lh} - Sell dropdown not found`);
                notifyUser('Pond0x Warning', 'Sell dropdown not found');
                updateLog('Sell dropdown missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Clicking sell dropdown`);
            updateLog(`Sell: ${sellToken.name}`);
            sellDropdown.click();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const searchBar = document.querySelector('input[placeholder="Search"]');
            if (!searchBar || !document.body.contains(searchBar)) {
                console.error(`${lh} - Search bar not found for sell token`);
                notifyUser('Pond0x Warning', 'Search bar not found');
                updateLog('Search bar missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Setting sell token address`);
            searchBar.value = sanitizeInput(sellToken.address);
            searchBar.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1000));

            const selectTokenOption = async (tokenName, isSellToken = true, maxAttempts = 5, delay = 1000) => {
                console.log(`${lh} - Selecting ${tokenName} (isSell: ${isSellToken})`);
                let attempts = 0;
                const normalizedTokenName = tokenName.toUpperCase();
                const tokenConfig = TOKEN_CONFIG[normalizedTokenName];
                if (!tokenConfig) {
                    console.error(`${lh} - Token config not found: ${tokenName}`);
                    notifyUser('Pond0x Error', `Token config missing: ${tokenName}`);
                    updateLog(`No config: ${tokenName}`);
                    return false;
                }

                while (attempts < maxAttempts) {
                    let tokenOption;
                    if (tokenName.toLowerCase() === 'wpond' && tokenConfig.descriptionSelector && tokenConfig.descriptionText) {
                        const descriptionElements = document.querySelectorAll(`div[class*="flex"][class*="items-center"] ${tokenConfig.descriptionSelector}`);
                        tokenOption = Array.from(descriptionElements).find(el => sanitizeDomContent(el.textContent.trim()) === tokenConfig.descriptionText)?.closest('div[class*="flex"][class*="items-center"]');
                    } else if (tokenConfig.selector) {
                        tokenOption = document.querySelector(`div[class*="flex"][class*="items-center"] ${tokenConfig.selector}`)?.closest('div[class*="flex"][class*="items-center"]');
                    }
                    if (tokenOption && document.body.contains(tokenOption)) {
                        console.log(`${lh} - Found ${tokenName} option`);
                        const clickableButton = tokenOption.querySelector('button') || tokenOption;
                        if (clickableButton && document.body.contains(clickableButton)) {
                            const dropdown = isSellToken ? sellDropdown : document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                            if (dropdown && document.body.contains(dropdown)) {
                                dropdown.focus();
                                await new Promise(resolve => setTimeout(resolve, 500));
                                dropdown.blur();
                            }
                            clickableButton.focus();
                            const mousedownEvent = new Event('mousedown', { bubbles: true });
                            const mouseupEvent = new Event('mouseup', { bubbles: true });
                            const clickEvent = new Event('click', { bubbles: true });
                            clickableButton.dispatchEvent(mousedownEvent);
                            clickableButton.dispatchEvent(mouseupEvent);
                            clickableButton.dispatchEvent(clickEvent);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            const verifySelection = () => {
                                return new Promise((resolve) => {
                                    let verifyAttempts = 0;
                                    const maxVerifyAttempts = 5;
                                    const check = () => {
                                        const selectedToken = document.querySelector(`button.rounded-full.flex.items-center ${tokenConfig.selector || `img[alt="${tokenName}"]`}`);
                                        const dropdownButton = isSellToken ? 
                                            document.querySelectorAll('button.rounded-full.flex.items-center')[0] : 
                                            document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                                        const isVisuallySelected = dropdownButton && document.body.contains(dropdownButton) && 
                                            (sanitizeDomContent(dropdownButton.innerHTML).includes(tokenName) || 
                                             sanitizeDomContent(dropdownButton.innerHTML).includes(tokenConfig.descriptionText || tokenName));
                                        if ((selectedToken && isVisuallySelected) || verifyAttempts >= maxVerifyAttempts) {
                                            resolve(selectedToken !== null && isVisuallySelected);
                                        } else {
                                            verifyAttempts++;
                                            setTimeout(check, 500);
                                        }
                                    };
                                    check();
                                });
                            };
                            const isSelected = await verifySelection();
                            if (isSelected) {
                                console.log(`${lh} - ${tokenName} selected`);
                                updateLog(`${tokenName} selected`);
                                return true;
                            } else {
                                console.warn(`${lh} - ${tokenName} selection failed`);
                            }
                        }
                    }
                    console.warn(`${lh} - ${tokenName} not found, attempt ${attempts + 1}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    attempts++;
                }
                console.error(`${lh} - Failed to select ${tokenName}`);
                notifyUser('Pond0x Warning', `${tokenName} not selectable`);
                updateLog(`Failed: ${tokenName}`);
                return false;
            };

            console.log(`${lh} - Setting sell token ${sellToken.name}`);
            if (!(await selectTokenOption(sellToken.name, true))) {
                console.error(`${lh} - Failed to set sell token`);
                isSettingUp = false;
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));

            let buyDropdown;
            for (let attempt = 0; attempt < 5; attempt++) {
                buyDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                if (buyDropdown && buyDropdown.offsetWidth > 0 && buyDropdown.offsetHeight > 0 && document.body.contains(buyDropdown)) {
                    console.log(`${lh} - Buy dropdown found on attempt ${attempt + 1}`);
                    break;
                }
                console.warn(`${lh} - Buy dropdown not ready, retrying (attempt ${attempt + 1}/5)`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (!buyDropdown) {
                console.error(`${lh} - Buy dropdown not found after retries`);
                notifyUser('Pond0x Warning', 'Buy dropdown not found');
                updateLog('Buy dropdown missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Clicking buy dropdown`);
            updateLog(`Buy: ${buyToken.name}`);
            buyDropdown.click();
            await new Promise(resolve => setTimeout(resolve, 1500));

            const searchBarBuy = document.querySelector('input[placeholder="Search"]');
            if (!searchBarBuy || !document.body.contains(searchBarBuy)) {
                console.error(`${lh} - Search bar not found for buy token`);
                notifyUser('Pond0x Warning', 'Search bar not found');
                updateLog('Search bar missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Setting buy token address`);
            searchBarBuy.value = sanitizeInput(buyToken.address);
            searchBarBuy.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1000));

            let buySelectionSuccess = false;
            for (let retry = 0; retry < 5; retry++) {
                console.log(`${lh} - Attempt ${retry + 1} to select buy token ${buyToken.name}`);
                if (await selectTokenOption(buyToken.name, false)) {
                    buySelectionSuccess = true;
                    break;
                }
                console.warn(`${lh} - Buy token ${buyToken.name} selection failed on attempt ${retry + 1}, retrying`);
                await new Promise(resolve => setTimeout(resolve, 2000 + (retry * 1000)));
                buyDropdown.click();
                await new Promise(resolve => setTimeout(resolve, 1500));
                if (searchBarBuy && document.body.contains(searchBarBuy)) {
                    searchBarBuy.value = sanitizeInput(buyToken.address);
                    searchBarBuy.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            if (!buySelectionSuccess) {
                console.error(`${lh} - Failed to select buy token after retries`);
                notifyUser('Pond0x Warning', `Failed to select ${buyToken.name}`);
                updateLog(`Failed: ${buyToken.name}`);
                isSettingUp = false;
                return false;
            }

            const selectedBuy = document.querySelector(`button.rounded-full.flex.items-center ${buyToken.selector || `img[alt="${buyToken.name}"]`}`);
            if (!selectedBuy || !document.body.contains(selectedBuy)) {
                console.error(`${lh} - Buy token not confirmed`);
                notifyUser('Pond0x Warning', `${buyToken.name} not confirmed`);
                updateLog(`${buyToken.name} not confirmed`);
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Buy token confirmed`);
            await initializeControlPanel();
            isSettingUp = false;
            console.log(`${lh} - Token setup complete`);
            updateLog('Ready to swap');
            return true;
        } catch (error) {
            console.error(`${lh} - Token setup error:`, error);
            notifyUser('Pond0x Error', `Token setup error: ${sanitizeInput(error.message)}`);
            updateLog(`Error: ${sanitizeInput(error.message)}`);
            isSettingUp = false;
            return false;
        }
    }

    async function startSwapping() {
        console.log(`${lh} - Inside startSwapping function at ${new Date().toISOString()}...`);
        // Re-query the swap button to ensure it's current
        swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
        console.log(`${lh} - Queried swapButton:`, swapButton); // Debug log
        if (!swapButton || !document.body.contains(swapButton)) {
            // Fallback to a broader selector if primary fails
            swapButton = document.querySelector('button[class*="btn"]') || document.querySelector('button:not([disabled])');
            console.log(`${lh} - Fallback swapButton query:`, swapButton); // Debug log
            if (!swapButton || !document.body.contains(swapButton)) {
                console.error(`${lh} - Swap button not found for swapping`);
                notifyUser('Pond0x Warning', 'Swap button not found');
                updateLog('Button missing');
                isSwapRunning = false;
                await GM.setValue('pond0xIsSwapRunning', false);
                const startBtn = document.getElementById('startSwappingBtn');
                if (startBtn && document.body.contains(startBtn)) startBtn.disabled = false;
                return;
            }
        }

        if (!isSwapping) {
            console.log(`${lh} - isSwapping is false, exiting startSwapping`);
            isSwapRunning = false;
            await GM.setValue('pond0xIsSwapRunning', false);
            const startBtn = document.getElementById('startSwappingBtn');
            if (startBtn && document.body.contains(startBtn)) startBtn.disabled = false;
            return;
        }

        const amountSet = await updateAmountInput();
        if (!amountSet) {
            console.warn(`${lh} - Failed to set swap amount. Retrying once...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!(await updateAmountInput())) {
                console.error(`${lh} - Failed to set swap amount after retry. Stopping`);
                notifyUser('Pond0x Warning', 'Failed to set swap amount after retry. Stopping');
                updateLog('Amount retry failed');
                isSwapping = false;
                await GM.setValue('pond0xIsSwapping', false);
                isSwapRunning = false;
                await GM.setValue('pond0xIsSwapRunning', false);
                const startBtn = document.getElementById('startSwappingBtn');
                if (startBtn && document.body.contains(startBtn)) {
                    startBtn.textContent = 'Start Swapping';
                    startBtn.style.background = '#28a745';
                    startBtn.disabled = false;
                }
                return;
            }
        }

        await performSwap();
        isSwapRunning = false;
        await GM.setValue('pond0xIsSwapRunning', false);
        const startBtn = document.getElementById('startSwappingBtn');
        if (!isSwapping && startBtn && document.body.contains(startBtn)) {
            startBtn.textContent = 'Start Swapping';
            startBtn.style.background = '#28a745';
            startBtn.disabled = false;
            console.log(`${lh} - Re-enabled Start Swapping button after completion`);
            updateLog('Swapping done');
        }
    }

    async function performSwap() {
        if (!isSwapping) {
            isSwapRunning = false;
            await GM.setValue('pond0xIsSwapRunning', false);
            const startBtn = document.getElementById('startSwappingBtn');
            if (startBtn && document.body.contains(startBtn)) startBtn.disabled = false;
            return;
        }

        console.log(`${lh} - Attempting swap #${swapCounter + 1} at ${new Date().toISOString()} (Sell: ${selectedSellToken}, Buy: ${selectedBuyToken})`);
        updateLog(`Swap #${swapCounter + 1}`);

        while (isSwapping) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
            if (!swapButton || !document.body.contains(swapButton)) {
                console.error(`${lh} - Swap button lost`);
                notifyUser('Pond0x Warning', 'Swap button not found');
                updateLog('Button lost');
                isSwapping = false;
                await GM.setValue('pond0xIsSwapping', false);
                isSwapRunning = false;
                await GM.setValue('pond0xIsSwapRunning', false);
                const startBtn = document.getElementById('startSwappingBtn');
                if (startBtn && document.body.contains(startBtn)) {
                    startBtn.textContent = 'Start Swapping';
                    startBtn.style.background = '#28a745';
                    startBtn.disabled = false;
                }
                return;
            }

            if (swapButton.disabled) {
                console.log(`${lh} - Swap button disabled`);
                updateLog('Button disabled');
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (swapButton.disabled) {
                    console.error(`${lh} - Swap button still disabled`);
                    notifyUser('Pond0x Warning', 'Swap button disabled');
                    updateLog('Still disabled');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn && document.body.contains(startBtn)) {
                        startBtn.textContent = 'Start Swapping';
                        startBtn.style.background = '#28a745';
                        startBtn.disabled = false;
                    }
                    return;
                }
            }

            swapButton.click();
            console.log(`${lh} - Swap button clicked at ${new Date().toISOString()}`);
            updateLog('Swap clicked');

            let stuckStartTime = Date.now();
            let isStuck = false;

            while (isSwapping) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                if (!swapButton || !document.body.contains(swapButton)) {
                    console.error(`${lh} - Swap button lost after click`);
                    notifyUser('Pond0x Warning', 'Swap button not found');
                    updateLog('Button lost');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn && document.body.contains(startBtn)) {
                        startBtn.textContent = 'Start Swapping';
                        startBtn.style.background = '#28a745';
                        startBtn.disabled = false;
                    }
                    return;
                }

                const buttonText = sanitizeDomContent(swapButton.textContent.toLowerCase());
                const timeElapsed = Date.now() - stuckStartTime;

                if (buttonText.includes('swap again')) {
                    console.log(`${lh} - Swap again detected`);
                    updateLog('Swap again');
                    let retryAttempts = 0;
                    const maxRetryAttempts = 3;
                    while (retryAttempts < maxRetryAttempts) {
                        swapButton.click();
                        console.log(`${lh} - Retry attempt ${retryAttempts + 1}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                        if (!swapButton || !document.body.contains(swapButton)) {
                            console.error(`${lh} - Swap button lost during retry`);
                            updateLog('Button lost');
                            isSwapping = false;
                            await GM.setValue('pond0xIsSwapping', false);
                            isSwapRunning = false;
                            await GM.setValue('pond0xIsSwapRunning', false);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn && document.body.contains(startBtn)) {
                                startBtn.textContent = 'Start Swapping';
                                startBtn.style.background = '#28a745';
                                startBtn.disabled = false;
                            }
                            return;
                        }
                        const newButtonText = sanitizeDomContent(swapButton.textContent.toLowerCase());
                        if (!newButtonText.includes('swap again')) {
                            console.log(`${lh} - Swap completed`);
                            swapCounter++;
                            await GM.setValue('pond0xSwapCounter', swapCounter);
                            const swapCounterElement = document.getElementById('swapCounter');
                            if (swapCounterElement && document.body.contains(swapCounterElement)) {
                                swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
                            }
                            notifyUser('Pond0x Swap', `Swap #${swapCounter} completed`);
                            updateLog(`Swap #${swapCounter} done`);
                            stuckStartTime = Date.now();

                            if (isRewardSwapsMode) {
                                const directionSuccess = await clickSwapDirectionButton();
                                if (!directionSuccess) {
                                    console.error(`${lh} - Direction swap failed`);
                                    isSwapping = false;
                                    await GM.setValue('pond0xIsSwapping', false);
                                    isSwapRunning = false;
                                    await GM.setValue('pond0xIsSwapRunning', false);
                                    const startBtn = document.getElementById('startSwappingBtn');
                                    if (startBtn && document.body.contains(startBtn)) {
                                        startBtn.textContent = 'Start Swapping';
                                        startBtn.style.background = '#28a745';
                                        startBtn.disabled = false;
                                    }
                                    return;
                                }

                                const tempToken = selectedSellToken;
                                selectedSellToken = selectedBuyToken;
                                selectedBuyToken = tempToken;
                                await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                                await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                                lastSwapDirection = `${selectedSellToken}to${selectedBuyToken}`;
                                await GM.setValue('pond0xLastSwapDirection', lastSwapDirection);
                                console.log(`${lh} - Direction swapped`);

                                const amountSet = await updateAmountInput();
                                if (!amountSet) {
                                    console.error(`${lh} - Amount reinput failed`);
                                    notifyUser('Pond0x Error', 'Failed to reinput amount');
                                    updateLog('Amount reinput failed');
                                    isSwapping = false;
                                    await GM.setValue('pond0xIsSwapping', false);
                                    isSwapRunning = false;
                                    await GM.setValue('pond0xIsSwapRunning', false);
                                    const startBtn = document.getElementById('startSwappingBtn');
                                    if (startBtn && document.body.contains(startBtn)) {
                                        startBtn.textContent = 'Start Swapping';
                                        startBtn.style.background = '#28a745';
                                        startBtn.disabled = false;
                                    }
                                    return;
                                }
                            }
                            break;
                        }
                        retryAttempts++;
                    }
                    if (retryAttempts >= maxRetryAttempts) {
                        console.error(`${lh} - Stuck on swap again`);
                        notifyUser('Pond0x Warning', 'Swap stuck, reloading');
                        updateLog('Stuck, reloading');
                        await GM.setValue('pond0xLastSwapAmount', swapAmount);
                        await GM.setValue('pond0xLastIsSwapping', true);
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                    continue;
                }

                if (buttonText.includes('retry')) {
                    console.log(`${lh} - Retry detected`);
                    updateLog('Retrying');
                    swapButton.click();
                    stuckStartTime = Date.now();
                    continue;
                }

                if (buttonText.includes('swapping') || buttonText.includes('pending') || 
                    buttonText.includes('pending approvals') || buttonText.includes('preparing transactions')) {
                    console.log(`${lh} - Swap in progress: ${buttonText}`);
                    updateLog(`${buttonText}`);
                    if (timeElapsed > SWAP_STUCK_TIMEOUT) {
                        console.warn(`${lh} - Swap stuck for 40s`);
                        notifyUser('Pond0x Warning', 'Swap stuck, reloading');
                        updateLog('Stuck, reloading');
                        await GM.setValue('pond0xLastSwapAmount', swapAmount);
                        await GM.setValue('pond0xLastIsSwapping', true);
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                    isStuck = true;
                } else if (buttonText.includes('loading')) {
                    console.log(`${lh} - Loading state`);
                    updateLog('Loading...');
                    if (timeElapsed > 10000) {
                        console.warn(`${lh} - Stuck in loading`);
                        notifyUser('Pond0x Warning', 'Loading stuck, reloading');
                        updateLog('Stuck, reloading');
                        await GM.setValue('pond0xLastSwapAmount', swapAmount);
                        await GM.setValue('pond0xLastIsSwapping', true);
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                    isStuck = true;
                } else {
                    if (isStuck) {
                        console.log(`${lh} - State resolved`);
                        isStuck = false;
                        stuckStartTime = Date.now();
                    }
                    if (buttonText.includes('swap')) {
                        console.log(`${lh} - Ready for next swap`);
                        updateLog('Ready for swap');
                        swapButton.click();
                        stuckStartTime = Date.now();
                        continue;
                    } else {
                        console.error(`${lh} - Unexpected state: ${buttonText}`);
                        notifyUser('Pond0x Warning', `Unexpected state: ${buttonText}`);
                        updateLog(`State: ${buttonText}`);
                        isSwapping = false;
                        await GM.setValue('pond0xIsSwapping', false);
                        isSwapRunning = false;
                        await GM.setValue('pond0xIsSwapRunning', false);
                        const startBtn = document.getElementById('startSwappingBtn');
                        if (startBtn && document.body.contains(startBtn)) {
                            startBtn.textContent = 'Start Swapping';
                            startBtn.style.background = '#28a745';
                            startBtn.disabled = false;
                        }
                        return;
                    }
                }
            }
        }

        if (isRewardSwapsMode && isSwapping) {
            console.log(`${lh} - Reward mode: Next swap`);
            await new Promise(resolve => setTimeout(resolve, retryInterval));
            await performSwap();
        }
    }
    function reInjectControlPanel() {
        if (!controlPanel || !document.body.contains(controlPanel)) {
            console.log(`${lh} - Re-injecting control panel`);
            document.body.appendChild(controlPanel);
            
            const currentLeft = parseInt(controlPanel.style.left) || parseInt(initialPanelPosition.left);
            const currentTop = parseInt(controlPanel.style.top) || parseInt(initialPanelPosition.top.replace('px', ''));
            controlPanel.style.left = `${currentLeft}px`;
            controlPanel.style.top = `${currentTop}px`;
            
            let isDragging = false;
            let currentX, currentY;
            controlPanel.onmousedown = (e) => {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && 
                    !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) {
                    isDragging = true;
                    currentX = e.clientX - parseInt(controlPanel.style.left);
                    currentY = e.clientY - parseInt(controlPanel.style.top);
                    e.preventDefault();
                }
            };

            document.onmousemove = (e) => {
                if (isDragging) {
                    controlPanel.style.left = `${e.clientX - currentX}px`;
                    controlPanel.style.top = `${e.clientY - currentY}px`;
                    const boxRect = controlPanel.getBoundingClientRect();
                    if (boxRect.left < 0) controlPanel.style.left = '0px';
                    if (boxRect.top < 0) controlPanel.style.top = '0px';
                    if (boxRect.right > window.innerWidth) controlPanel.style.left = `${window.innerWidth - boxRect.width}px`;
                    if (boxRect.bottom > window.innerHeight) controlPanel.style.top = `${window.innerHeight - boxRect.height}px`;
                }
            };

            document.onmouseup = () => {
                isDragging = false;
            };

            const boostSwapsBtn = document.getElementById('boostSwapsBtn');
            const rewardSwapsBtn = document.getElementById('rewardSwapsBtn');
            const customSwapsBtn = document.getElementById('customSwapsBtn');
            if (boostSwapsBtn && rewardSwapsBtn && customSwapsBtn && 
                document.body.contains(boostSwapsBtn) && document.body.contains(rewardSwapsBtn) && document.body.contains(customSwapsBtn)) {
                if (swapMode === 'Boost') {
                    boostSwapsBtn.style.background = '#28a745';
                    rewardSwapsBtn.style.background = '#00CED1';
                    customSwapsBtn.style.background = '#00CED1';
                } else if (swapMode === 'Reward') {
                    rewardSwapsBtn.style.background = '#28a745';
                    boostSwapsBtn.style.background = '#00CED1';
                    customSwapsBtn.style.background = '#00CED1';
                } else if (swapMode === 'Custom') {
                    customSwapsBtn.style.background = '#28a745';
                    boostSwapsBtn.style.background = '#00CED1';
                    rewardSwapsBtn.style.background = '#00CED1';
                }
            }

            updateLog('Panel re-injected');
        }
    }

    window.addEventListener('error', (event) => {
        if (event.message.includes('Cannot read properties of undefined (reading \'syncProps\')')) {
            console.error(`${lh} - Application error detected`);
            updateLog('App error');
            if (!hasReloaded) {
                console.log(`${lh} - Reloading due to error`);
                sessionStorage.setItem('pond0xSwapReloaded', 'true');
                window.location.reload();
            } else if (setupRetryCount < MAX_SETUP_RETRIES) {
                console.log(`${lh} - Retrying setup (${setupRetryCount + 1}/${MAX_SETUP_RETRIES})`);
                setupRetryCount++;
                setTimeout(async () => {
                    try {
                        const success = await setupTokensAndAmount();
                        if (success) {
                            console.log(`${lh} - Setup reinitialized`);
                            sessionStorage.setItem('initialSetupDone', 'true');
                        } else {
                            console.error(`${lh} - Setup reinitialization failed`);
                            notifyUser('Pond0x Error', 'Setup reinitialization failed');
                            updateLog('Setup failed');
                        }
                    } catch (error) {
                        console.error(`${lh} - Error during reinitialization:`, error);
                        notifyUser('Pond0x Error', `Reinitialization error: ${sanitizeInput(error.message)}`);
                        updateLog(`Error: ${sanitizeInput(error.message)}`);
                    }
                }, 3000);
            } else {
                console.error(`${lh} - Max retries reached`);
                notifyUser('Pond0x Error', 'Error persists after retries');
                updateLog('Max retries');
            }
        }
    });

    if (hasReloaded) {
        console.log(`${lh} - Page reloaded`);
        updateLog('Reloaded');
    }

    console.log(`${lh} - Waiting for page readiness`);
    try {
        const pageReady = await waitForPageReady();
        if (!pageReady) {
            console.warn(`${lh} - Page readiness failed`);
            notifyUser('Pond0x Warning', 'Page load timeout');
            updateLog('Page not ready');
        }

        console.log(`${lh} - Scheduling token setup`);
        setTimeout(async () => {
            try {
                console.log(`${lh} - Starting initial setup`);
                if (hasReloaded && isRewardSwapsMode) {
                    if (lastSwapDirection === 'USDCtoUSDT') {
                        selectedSellToken = 'USDC';
                        selectedBuyToken = 'USDT';
                    } else {
                        selectedSellToken = 'USDT';
                        selectedBuyToken = 'USDC';
                    }
                    await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                    await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                    console.log(`${lh} - Restored token pair`);
                }
                const setupSuccess = await setupTokensAndAmount();
                if (setupSuccess) {
                    sessionStorage.setItem('initialSetupDone', 'true');
                    const amountSet = await updateAmountInput();
                    if (!amountSet) {
                        console.error(`${lh} - Amount set failed after setup`);
                        notifyUser('Pond0x Warning', 'Amount set failed');
                        updateLog('Amount failed');
                    } else {
                        console.log(`${lh} - Amount set successfully`);
                    }
                    if (hasReloaded && isSwapping && !isSwapRunning) {
                        if (isAutoMode) {
                            console.log(`${lh} - Auto-resuming swapping`);
                            isSwapRunning = true;
                            await GM.setValue('pond0xIsSwapRunning', true);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn && document.body.contains(startBtn)) {
                                startBtn.textContent = 'Stop Swapping';
                                startBtn.style.background = '#dc3545';
                                startBtn.disabled = true;
                            }
                            await startSwapping();
                            setTimeout(async () => {
                                if (isSwapping && !isSwapRunning) {
                                    console.log(`${lh} - Fallback swap initiation`);
                                    await startSwapping();
                                }
                            }, 2000);
                        } else {
                            console.log(`${lh} - Manual mode, awaiting input`);
                            isSwapping = false;
                            isSwapRunning = false;
                            await GM.setValue('pond0xIsSwapping', false);
                            await GM.setValue('pond0xIsSwapRunning', false);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn && document.body.contains(startBtn)) {
                                startBtn.textContent = 'Start Swapping';
                                startBtn.style.background = '#28a745';
                                startBtn.disabled = false;
                            }
                            updateLog('Awaiting user input');
                            notifyUser('Pond0x Info', 'Manual mode: Swapping stopped');
                        }
                    }
                } else if (setupRetryCount < MAX_SETUP_RETRIES) {
                    setupRetryCount++;
                    console.error(`${lh} - Setup failed, retrying (${setupRetryCount}/${MAX_SETUP_RETRIES})`);
                    notifyUser('Pond0x Warning', `Setup failed, retrying (${setupRetryCount}/${MAX_SETUP_RETRIES})`);
                    updateLog(`Retry ${setupRetryCount}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const retrySuccess = await setupTokensAndAmount();
                    if (retrySuccess) {
                        sessionStorage.setItem('initialSetupDone', 'true');
                        const amountSet = await updateAmountInput();
                        if (!amountSet) {
                            console.error(`${lh} - Amount set failed after retry`);
                            notifyUser('Pond0x Warning', 'Amount set failed');
                            updateLog('Amount failed');
                        }
                        if (hasReloaded && isSwapping && !isSwapRunning) {
                            if (isAutoMode) {
                                console.log(`${lh} - Auto-resuming after retry`);
                                isSwapRunning = true;
                                await GM.setValue('pond0xIsSwapRunning', true);
                                const startBtn = document.getElementById('startSwappingBtn');
                                if (startBtn && document.body.contains(startBtn)) {
                                    startBtn.textContent = 'Stop Swapping';
                                    startBtn.style.background = '#dc3545';
                                    startBtn.disabled = true;
                                }
                                await startSwapping();
                                setTimeout(async () => {
                                    if (isSwapping && !isSwapRunning) {
                                        console.log(`${lh} - Fallback swap initiation after retry`);
                                        await startSwapping();
                                    }
                                }, 2000);
                            } else {
                                console.log(`${lh} - Manual mode after retry`);
                                isSwapping = false;
                                isSwapRunning = false;
                                await GM.setValue('pond0xIsSwapping', false);
                                await GM.setValue('pond0xIsSwapRunning', false);
                                const startBtn = document.getElementById('startSwappingBtn');
                                if (startBtn && document.body.contains(startBtn)) {
                                    startBtn.textContent = 'Start Swapping';
                                    startBtn.style.background = '#28a745';
                                    startBtn.disabled = false;
                                }
                                updateLog('Awaiting user input');
                                notifyUser('Pond0x Info', 'Manual mode: Swapping stopped');
                            }
                        }
                    } else {
                        console.error(`${lh} - Retry ${setupRetryCount} failed`);
                        notifyUser('Pond0x Error', `Setup failed after ${setupRetryCount} retries`);
                        updateLog(`Failed after ${setupRetryCount}`);
                    }
                } else {
                    console.error(`${lh} - Max retries reached`);
                    notifyUser('Pond0x Error', 'Setup failed after max retries');
                    updateLog('Max retries');
                }
            } catch (error) {
                console.error(`${lh} - Setup error:`, error);
                notifyUser('Pond0x Error', `Setup error: ${sanitizeInput(error.message)}`);
                updateLog(`Error: ${sanitizeInput(error.message)}`);
                isSettingUp = false;
            }
        }, 1000);
    } catch (error) {
        console.error(`${lh} - Main execution error:`, error);
        notifyUser('Pond0x Error', `Initialization error: ${sanitizeInput(error.message)}`);
        updateLog(`Init error`);
    }
})();