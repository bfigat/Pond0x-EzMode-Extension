(async function () {
    'use strict';

    const lh = '[Pond0x-AutoSwapper]';

    console.log(`${lh} *** SWAP AUTOMATION RUNNING ***`);

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
    let isRewardSwapsMode = await GM.getValue('pond0xIsRewardSwapsMode', false); // Track if Reward Swaps mode is active
    let lastSwapDirection = await GM.getValue('pond0xLastSwapDirection', 'USDCtoUSDT'); // Default to USDC -> USDT

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

    // Crash detection function
    const detectCrash = () => {
        const errorText = document.body.innerText.toLowerCase();
        const isBlackScreen = document.body.style.backgroundColor === 'black' || document.body.style.backgroundColor === '#000000';
        const hasErrorMessage = errorText.includes('application error');
        return hasErrorMessage || (isBlackScreen && errorText.trim().length < 50);
    };

    // Periodic crash detection
    setInterval(async () => {
        if (detectCrash()) {
            console.log(`${lh} - Detected application crash (black screen or error message). Reloading page...`);
            updateLog('Crash detected, reloading');
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
            console.log(`${lh} - Notification throttled to avoid overload: ${title} - ${body}`);
            return;
        }
        lastNotificationTime = now;
        chrome.runtime.sendMessage({ type: 'notify', title, body });
    };

    const updateLog = (message) => {
        const logWindow = document.getElementById('swapLogWindow');
        if (logWindow) {
            const currentTime = new Date().toLocaleTimeString();
            logWindow.textContent = `${currentTime}: ${message}\n${logWindow.textContent.split('\n')[0] || ''}`.trim();
        }
    };

    const redirectWithReferral = () => {
        const referralUrl = 'https://pond0x.com/swap/solana?ref=98UBYhXdXJMhmjE99v9MwTaQery4GeC2dowAtWoJXfavzATMyx7VB7gfVHR';
        const currentUrl = window.location.href;

        if (currentUrl === 'https://pond0x.com/swap/solana' || currentUrl === 'https://www.pond0x.com/swap/solana') {
            console.log(`${lh} - Redirecting to include referral link: ${referralUrl}`);
            window.location.replace(referralUrl);
            return true;
        }
        return false;
    };

    if (redirectWithReferral()) {
        console.log(`${lh} - Exiting script after initiating redirect.`);
        return;
    }

    const lastIsSwapping = await GM.getValue('pond0xLastIsSwapping', false);
    if (!hasReloaded || !lastIsSwapping) {
        isSwapping = false;
        isSwapRunning = false;
        await GM.setValue('pond0xIsSwapping', false);
        await GM.setValue('pond0xIsSwapRunning', false);
        console.log(`${lh} - Reset swapping state on page load: isSwapping=${isSwapping}, isSwapRunning=${isSwapRunning}`);
    } else {
        console.log(`${lh} - Detected reload with prior swapping state. Preserving isSwapping=${isSwapping}, isSwapRunning=${isSwapRunning}`);
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
            console.log(`${lh} - Restored swap mode after reload: swapAmount=${swapAmount}, isSwapping=${isSwapping}`);
        }
    };
    if (hasReloaded) await restoreSwapMode();

    async function clickSwapDirectionButton() {
        console.log(`${lh} - Attempting to click the swap direction button...`);
        const swapDirectionButton = document.querySelector('div.block svg.icons-sc-71agnn-0.KVxRw');
        if (!swapDirectionButton) {
            console.error(`${lh} - Swap direction button not found.`);
            notifyUser('Pond0x Error', 'Swap direction button not found.');
            updateLog('Direction button missing');
            return false;
        }

        const parentDiv = swapDirectionButton.closest('div.block');
        if (!parentDiv) {
            console.error(`${lh} - Parent div for swap direction button not found.`);
            notifyUser('Pond0x Error', 'Parent div for swap direction button not found.');
            updateLog('Direction parent missing');
            return false;
        }

        parentDiv.click();
        console.log(`${lh} - Swap direction button clicked at ${new Date().toISOString()}.`);
        updateLog('Direction swapped');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for UI to update
        return true;
    }
    const waitForPageReady = () => {
        return new Promise((resolve) => {
            const maxWaitTime = 15000;
            const startTime = Date.now();

            const checkReady = () => {
                const button = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                const isVisible = button && button.offsetWidth > 0 && button.offsetHeight > 0;

                if (document.readyState === 'complete' && button) {
                    console.log(`${lh} - Initial page readiness check passed after ${Date.now() - startTime}ms.`);
                    swapButton = button;
                    const checkReactReadiness = () => {
                        return new Promise((resolveInner) => {
                            let attempts = 0;
                            const maxAttempts = 10;

                            const check = () => {
                                const dropdowns = document.querySelectorAll('button.rounded-full.flex.items-center');
                                if (dropdowns.length >= 2 && !button.disabled && !dropdowns[0].disabled) {
                                    console.log(`${lh} - React components appear ready after ${attempts * 500}ms.`);
                                    resolveInner();
                                } else if (attempts >= maxAttempts) {
                                    console.warn(`${lh} - React readiness check timed out after ${maxAttempts * 500}ms.`);
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
                        console.log(`${lh} - React components ready after ${Date.now() - startTime}ms.`);
                        const observeDOMStability = () => {
                            return new Promise((resolveInner) => {
                                let lastMutationTime = Date.now();
                                const stabilityThreshold = 1000;
                                const maxObservationTime = 5000;

                                const observer = new MutationObserver(() => {
                                    lastMutationTime = Date.now();
                                });

                                const target = document.querySelector('.text-xl.btntxt')?.parentElement || document.body;
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
                            console.log(`${lh} - DOM stabilized, page is fully interactive after ${Date.now() - startTime}ms.`);
                            resolve(true);
                        }).catch(() => {
                            console.warn(`${lh} - DOM stability check timed out after ${Date.now() - startTime}ms. Proceeding anyway...`);
                            resolve(true);
                        });
                    }).catch(() => {
                        console.warn(`${lh} - React readiness check failed after ${Date.now() - startTime}ms. Proceeding anyway...`);
                        resolve(true);
                    });
                } else if (Date.now() - startTime > maxWaitTime) {
                    console.error(`${lh} - Page readiness timeout after ${maxWaitTime}ms. Proceeding anyway...`);
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
            console.log(`${lh} - Waiting for swap button in DOM...`);
            let attempts = 0;
            const maxAttempts = 15;

            const checkButton = () => {
                swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                const isVisible = swapButton && swapButton.offsetWidth > 0 && swapButton.offsetHeight > 0;
                if (swapButton && isVisible) {
                    console.log(`${lh} - Swap button found in DOM after ${attempts * 500}ms`);
                    resolve(swapButton);
                    return;
                }
                attempts++;
                if (attempts >= maxAttempts) {
                    console.error(`${lh} - Swap button not found after ${maxAttempts * 500}ms, resolving with null...`);
                    resolve(null);
                    return;
                }
                setTimeout(checkButton, 500);
            };
            checkButton();
        });
    };

    const fetchManifestSwaps = async (walletAddress) => {
        return new Promise((resolve) => {
            console.log(`${lh} - Opening hidden tab to fetch manifest swaps for ${walletAddress}`);
            chrome.runtime.sendMessage({ action: 'openTab', url: 'https://cary0x.github.io/docs/info/manifest' }, (tabId) => {
                if (!tabId) {
                    console.error(`${lh} - Failed to open hidden tab`);
                    resolve('Error');
                    return;
                }

                chrome.runtime.sendMessage({
                    action: 'injectManifestScript',
                    tabId: tabId,
                    walletAddress: walletAddress
                });

                chrome.runtime.onMessage.addListener(function listener(message) {
                    if (message.action === 'scrapedSwaps' && message.tabId === tabId) {
                        console.log(`${lh} - Received scraped swaps: ${message.swaps} for tab ${tabId}`);
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve(message.swaps);
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
                    if (startSwappingBtn) {
                        startSwappingBtn.textContent = 'Stop Swapping';
                        startSwappingBtn.style.background = '#dc3545';
                    }
                    updateLog('Starting swap process');
                    await startSwapping();
                } catch (error) {
                    console.error(`${lh} - Error in startSwapping at ${new Date().toISOString()}:`, error);
                    notifyUser('Pond0x Error', `Error starting swap: ${error.message}`);
                    updateLog(`Error: ${error.message}`);
                    const startSwappingBtn = document.getElementById('startSwappingBtn');
                    if (startSwappingBtn) {
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
                if (startSwappingBtn) {
                    startSwappingBtn.textContent = 'Start Swapping';
                    startSwappingBtn.style.background = '#28a745';
                    startSwappingBtn.disabled = false;
                }
                updateLog('Swapping stopped');
                notifyUser('Pond0x Info', 'Swapping stopped successfully');
            } else {
                console.log(`${lh} - Swap already running or paused, ignoring Start Swapping click.`);
            }
        };

        if (!controlPanel || !document.body.contains(controlPanel)) {
            const button = await waitForSwapButton();
            if (!button) {
                console.error(`${lh} - Swap button not found for control panel initialization.`);
                notifyUser('Pond0x Error', 'Swap button not found. AutoSwapper initialization failed.');
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
            let initialPanelPosition = {
                left: `${button.getBoundingClientRect().left + window.scrollX}px`,
                top: `${button.getBoundingClientRect().bottom + window.scrollY + 100}px`
            };

            controlPanel.style.left = initialPanelPosition.left;
            controlPanel.style.top = initialPanelPosition.top;
            console.log(`${lh} - Control panel initial position set:`, initialPanelPosition);

            controlPanel.onmousedown = (e) => {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) {
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
                    <span id="toggleLabel" style="background: ${isAutoMode ? '#28a745' : '#dc3545'}; color: white; padding: 3px 8px; border-radius: 3px; font-size: 12px; cursor: pointer; position: relative;">
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
                if (startSwappingBtn) {
                    startSwappingBtn.disabled = isPaused;
                }

                if (isPaused) {
                    console.log(`${lh} - Pausing swapping...`);
                    updateLog('Swapping paused');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn) startBtn.disabled = true;
                } else if (!isSwapRunning) {
                    console.log(`${lh} - Resuming swapping...`);
                    updateLog('Swapping resumed');
                    isSwapping = true;
                    await GM.setValue('pond0xIsSwapping', true);
                    isSwapRunning = true;
                    await GM.setValue('pond0xIsSwapRunning', true);
                    try {
                        await startSwapping();
                    } catch (error) {
                        console.error(`${lh} - Error resuming swapping:`, error);
                        notifyUser('Pond0x Error', `Error resuming swap: ${error.message}`);
                        updateLog(`Error: ${error.message}`);
                        isSwapping = false;
                        await GM.setValue('pond0xIsSwapping', false);
                        isSwapRunning = false;
                        await GM.setValue('pond0xIsSwapRunning', false);
                        if (startSwappingBtn) startSwappingBtn.disabled = false;
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
                    console.log(`${lh} - Boost Swaps activated. Amount set to 0.01 ${selectedSellToken}.`);
                    updateLog(`Boost: 0.01 ${selectedSellToken}`);
                    const success = await updateAmountInput();
                    if (!success) {
                        console.error(`${lh} - Failed to update amount to 0.01 ${selectedSellToken}`);
                        notifyUser('Pond0x Error', `Failed to set amount to 0.01 ${selectedSellToken}`);
                        updateLog('Amount update failed');
                    }
                    boostSwapsBtn.style.background = '#28a745';
                    rewardSwapsBtn.style.background = '#00CED1';
                    customSwapsBtn.style.background = '#00CED1';

                    // Re-enable token selection UI
                    const sellTokenSelect = document.getElementById('sellTokenSelect');
                    const buyTokenSelect = document.getElementById('buyTokenSelect');
                    const updateTokenButton = document.getElementById('updateTokenButton');
                    if (sellTokenSelect && buyTokenSelect && updateTokenButton) {
                        sellTokenSelect.disabled = false;
                        buyTokenSelect.disabled = false;
                        updateTokenButton.disabled = false;
                    }

                    reInjectControlPanel();
                } catch (error) {
                    console.error(`${lh} - Error updating amount:`, error);
                    notifyUser('Pond0x Error', `Error updating amount: ${error.message}`);
                    updateLog(`Error: ${error.message}`);
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

        // Force token pair to USDC (sell) and USDT (buy)
        selectedSellToken = 'USDC';
        selectedBuyToken = 'USDT';
        await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
        await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);

        console.log(`${lh} - Reward Swaps activated. Amount set to 9.02 ${selectedSellToken}. Token pair locked to USDC -> USDT.`);
        updateLog(`Reward: 9.02 ${selectedSellToken} -> ${selectedBuyToken}`);

        // Update the UI to reflect the locked token pair
        const sellTokenSelect = document.getElementById('sellTokenSelect');
        const buyTokenSelect = document.getElementById('buyTokenSelect');
        const updateTokenButton = document.getElementById('updateTokenButton');
        if (sellTokenSelect && buyTokenSelect && updateTokenButton) {
            sellTokenSelect.value = selectedSellToken;
            buyTokenSelect.value = selectedBuyToken;
            sellTokenSelect.disabled = true;
            buyTokenSelect.disabled = true;
            updateTokenButton.disabled = true;
        }

        // Immediately apply the token pair change to the swap site
        const tokenSetupSuccess = await setupTokensAndAmount();
        if (!tokenSetupSuccess) {
            console.error(`${lh} - Failed to set up token pair USDC -> USDT on the swap site after activating Reward Swaps mode.`);
            notifyUser('Pond0x Error', 'Failed to set token pair to USDC -> USDT on the swap site.');
            updateLog('Token setup failed');
        } else {
            console.log(`${lh} - Successfully set token pair to USDC -> USDT on the swap site.`);
            updateLog('Token pair set');
        }

        const success = await updateAmountInput();
        if (!success) {
            console.error(`${lh} - Failed to update amount to 9.02 ${selectedSellToken}`);
            notifyUser('Pond0x Error', `Failed to set amount to 9.02 ${selectedSellToken}`);
            updateLog('Amount update failed');
        }
        rewardSwapsBtn.style.background = '#28a745';
        boostSwapsBtn.style.background = '#00CED1';
        customSwapsBtn.style.background = '#00CED1';
        reInjectControlPanel();
    } catch (error) {
        console.error(`${lh} - Error updating amount:`, error);
        notifyUser('Pond0x Error', `Error updating amount: ${error.message}`);
        updateLog(`Error: ${error.message}`);
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
                let value = parseFloat(e.target.value);
                if (value < 0.001) value = 0.001;
                if (value > 9999.999) value = 9999.999;
                customSwapInput.value = value.toFixed(3);
                swapAmount = value;
                await GM.setValue('pond0xSwapAmount', swapAmount);
                await GM.setValue('pond0xLastSwapAmount', swapAmount);
                console.log(`${lh} - Custom swap amount updated to ${swapAmount} ${selectedSellToken}`);
                updateLog(`Custom: ${swapAmount} ${selectedSellToken}`);
            });

            customSwapsBtn.addEventListener('click', async () => {
                try {
                    boostSwapsBtn.disabled = true;
                    rewardSwapsBtn.disabled = true;
                    customSwapsBtn.disabled = true;
                    const customValue = parseFloat(customSwapInput.value);
                    if (isNaN(customValue) || customValue < 0.001) {
                        console.error(`${lh} - Invalid custom swap value: ${customValue}`);
                        notifyUser('Pond0x Error', 'Invalid custom swap value. Must be at least 0.001.');
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
                    console.log(`${lh} - Custom Swap activated. Amount set to ${swapAmount} ${selectedSellToken}.`);
                    updateLog(`Custom: ${swapAmount} ${selectedSellToken}`);
                    const success = await updateAmountInput();
                    if (!success) {
                        console.error(`${lh} - Failed to update amount to ${swapAmount} ${selectedSellToken}`);
                        notifyUser('Pond0x Error', `Failed to set amount to ${swapAmount} ${selectedSellToken}`);
                        updateLog('Amount update failed');
                    }
                    customSwapsBtn.style.background = '#28a745';
                    boostSwapsBtn.style.background = '#00CED1';
                    rewardSwapsBtn.style.background = '#00CED1';

                    // Re-enable token selection UI
                    const sellTokenSelect = document.getElementById('sellTokenSelect');
                    const buyTokenSelect = document.getElementById('buyTokenSelect');
                    const updateTokenButton = document.getElementById('updateTokenButton');
                    if (sellTokenSelect && buyTokenSelect && updateTokenButton) {
                        sellTokenSelect.disabled = false;
                        buyTokenSelect.disabled = false;
                        updateTokenButton.disabled = false;
                    }

                    reInjectControlPanel();
                } catch (error) {
                    console.error(`${lh} - Error updating custom amount:`, error);
                    notifyUser('Pond0x Error', `Error updating custom amount: ${error.message}`);
                    updateLog(`Error: ${error.message}`);
                } finally {
                    boostSwapsBtn.disabled = false;
                    rewardSwapsBtn.disabled = false;
                    customSwapsBtn.disabled = false;
                }
            });

            // Restore button states based on swapMode
            if (swapMode === 'Boost') {
                boostSwapsBtn.style.background = '#28a745';
                rewardSwapsBtn.style.background = '#00CED1';
                customSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Boost Swaps mode in control panel.`);
            } else if (swapMode === 'Reward') {
                rewardSwapsBtn.style.background = '#28a745';
                boostSwapsBtn.style.background = '#00CED1';
                customSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Reward Swaps mode in control panel.`);
            } else if (swapMode === 'Custom') {
                customSwapsBtn.style.background = '#28a745';
                boostSwapsBtn.style.background = '#00CED1';
                rewardSwapsBtn.style.background = '#00CED1';
                console.log(`${lh} - Restored Custom Swaps mode in control panel.`);
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
                const sellValue = sellTokenSelect.value;
                const buyValue = buyTokenSelect.value;
                if (sellValue === buyValue) {
                    console.warn(`${lh} - Cannot update: Sell and Buy tokens cannot be the same (${sellValue}).`);
                    notifyUser('Pond0x Warning', 'Sell and Buy tokens cannot be the same.');
                    return;
                }
                selectedSellToken = sellValue;
                selectedBuyToken = buyValue;
                await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                console.log(`${lh} - Tokens updated: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
                updateLog(`Tokens updated: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
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
                const sellValue = e.target.value;
                if (sellValue === buyTokenSelect.value) {
                    const availableTokens = tokenKeys.filter(t => t !== sellValue);
                    const newBuyToken = availableTokens[0] || tokenKeys[0];
                    buyTokenSelect.value = newBuyToken;
                    selectedBuyToken = newBuyToken;
                    GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                    console.log(`${lh} - Adjusted Buy token to ${newBuyToken} to avoid duplicate with Sell ${sellValue}`);
                }
                selectedSellToken = sellValue;
                GM.setValue('pond0xSelectedSellToken', selectedSellToken);
            });

            buyTokenSelect.addEventListener('change', (e) => {
                const buyValue = e.target.value;
                if (buyValue === sellTokenSelect.value) {
                    const availableTokens = tokenKeys.filter(t => t !== buyValue);
                    const newSellToken = availableTokens[0] || tokenKeys[0];
                    sellTokenSelect.value = newSellToken;
                    selectedSellToken = newSellToken;
                    GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                    console.log(`${lh} - Adjusted Sell token to ${newSellToken} to avoid duplicate with Buy ${buyValue}`);
                }
                selectedBuyToken = buyValue;
                GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
            });

            tokenSelectionContainer.appendChild(sellTokenLabel);
            tokenSelectionContainer.appendChild(sellTokenSelect);
            tokenSelectionContainer.appendChild(buyTokenLabel);
            tokenSelectionContainer.appendChild(buyTokenSelect);
            tokenSelectionContainer.appendChild(updateTokenButton);
            controlPanel.appendChild(tokenSelectionContainer);

            // Disable token selection UI if in Reward Swaps mode
            if (isRewardSwapsMode) {
                sellTokenSelect.disabled = true;
                buyTokenSelect.disabled = true;
                updateTokenButton.disabled = true;
                console.log(`${lh} - Restored Reward Swaps mode: Token selection UI disabled.`);
            }

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
                retryInterval = parseInt(e.target.value) * 1000 || 3000;
                await GM.setValue('pond0xRetryInterval', retryInterval);
                console.log(`${lh} - Swap frequency updated to ${retryInterval / 1000} seconds.`);
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
                const walletAddress = e.target.value.trim();
                if (walletAddress.length >= 32 && walletAddress.length <= 44) {
                    updateLog('Fetching swaps');
                    console.log(`${lh} - Fetching swaps for wallet: ${walletAddress}`);
                    const swaps = await fetchManifestSwaps(walletAddress);
                    console.log(`${lh} - Fetched swaps value: ${swaps}`);
                    const manifestSwapsElement = document.getElementById('manifestSwaps');
                    if (manifestSwapsElement) {
                        manifestSwapsElement.textContent = `Manifest Swaps: ${swaps}`;
                        console.log(`${lh} - Updated control panel to: Manifest Swaps: ${swaps}`);
                        updateLog(`Swaps: ${swaps}`);
                    } else {
                        console.error(`${lh} - manifestSwapsElement not found`);
                    }
                } else {
                    updateLog('Invalid wallet');
                    console.log(`${lh} - Invalid wallet address length: ${walletAddress.length}`);
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
                document.getElementById('swapCounter').textContent = `Swaps Completed: ${swapCounter}`;
                console.log(`${lh} - Stats reset: swapCounter set to ${swapCounter}`);
                updateLog('Stats reset');
                notifyUser('Pond0x Info', 'Swap stats reset successfully.');
            });
            controlPanel.appendChild(statsResetBtn);

            document.body.appendChild(controlPanel);

            const autoToggle = document.getElementById('autoToggle');
            const toggleLabel = document.getElementById('toggleLabel');
            if (toggleLabel && autoToggle) {
                toggleLabel.addEventListener('click', async () => {
                    isAutoMode = !isAutoMode;
                    await GM.setValue('pond0xIsAutoMode', isAutoMode);
                    toggleLabel.textContent = isAutoMode ? 'Auto' : 'Manual';
                    toggleLabel.style.background = isAutoMode ? '#28a745' : '#dc3545';
                    autoToggle.checked = isAutoMode;
                    console.log(`${lh} - Mode switched to ${isAutoMode ? 'Auto' : 'Manual'}`);
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
                startSwappingBtn: 'Starts the auto-swapping process with the current settings. Disable this button when paused.',
                pauseResumeBtn: 'Pauses or resumes the auto-swapping process. Only Resume will re-enable swapping when paused.',
                boostSwapsBtn: 'Sets the swap amount to 0.01 USDC for faster, lower-value swaps.',
                rewardSwapsBtn: 'Sets the swap amount to 9.02 USDC for higher-value reward swaps.',
                customSwapsBtn: 'Sets the swap amount to a custom value entered in the adjacent field for user-defined swaps.',
                statsResetBtn: 'Resets the swap counter to zero and updates the display.',
                sellTokenSelect: 'Select the token to sell. Updates the swapping pair automatically after pressing Update.',
                buyTokenSelect: 'Select the token to buy. Updates the swapping pair automatically after pressing Update.',
                updateTokenButton: 'Confirms and applies the selected Sell and Buy tokens to the swap interface.'
            };

            const showTooltip = (element) => {
                const content = tooltipContent[element.id];
                if (content) {
                    tooltipBox.textContent = content;
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
                elem.addEventListener('mouseenter', () => showTooltip(elem));
                elem.addEventListener('mouseleave', hideTooltip);
            });
        } else {
            console.log(`${lh} - Control panel already exists, updating elements...`);
            const startSwappingBtn = document.getElementById('startSwappingBtn');
            if (startSwappingBtn) {
                startSwappingBtn.textContent = isSwapRunning ? 'Stop Swapping' : 'Start Swapping';
                startSwappingBtn.style.background = isSwapRunning ? '#dc3545' : '#28a745';
                startSwappingBtn.disabled = isPaused || isSwapRunning;
                attachStartSwappingListener(startSwappingBtn);
            }
            const pauseResumeBtn = document.getElementById('pauseResumeBtn');
            if (pauseResumeBtn) {
                pauseResumeBtn.textContent = isPaused ? 'Resume' : 'Pause';
                pauseResumeBtn.style.backgroundColor = isPaused ? '#28a745' : '#FFFF00';
                pauseResumeBtn.style.color = isPaused ? 'white' : 'black';
            }
            const swapCounterElement = document.getElementById('swapCounter');
            if (swapCounterElement) {
                swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
            }
            const sellTokenSelect = document.getElementById('sellTokenSelect');
            const buyTokenSelect = document.getElementById('buyTokenSelect');
            if (sellTokenSelect && buyTokenSelect) {
                sellTokenSelect.value = selectedSellToken;
                buyTokenSelect.value = selectedBuyToken;
            }
            const logWindow = document.getElementById('swapLogWindow');
            if (logWindow) logWindow.textContent = 'Control panel updated';
        }
    }

    async function updateAmountInput() {
        console.log(`${lh} - Starting updateAmountInput...`);
        const amountInput = document.querySelector('input[placeholder="0.00"]');
        if (!amountInput) {
            console.error(`${lh} - Amount input not found.`);
            notifyUser('Pond0x Warning', 'Amount input not found.');
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
                    console.warn(`${lh} - Amount input update failed. Retrying...`);
                    return false;
                }
                console.log(`${lh} - Amount verified as ${swapAmount} after update.`);
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
            console.log(`${lh} - Attempt ${attempts}/${maxAttempts} failed. Retrying after delay...`);
            updateLog(`Retry ${attempts} failed`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.error(`${lh} - Failed to update amount after ${maxAttempts} attempts. Final value: ${amountInput.value}`);
        notifyUser('Pond0x Error', 'Failed to update swap amount after multiple attempts.');
        updateLog('Amount update failed');
        return false;
    }
    async function setupTokensAndAmount() {
        console.log(`${lh} - Starting setupTokensAndAmount...`);
        if (isSettingUp) {
            console.log(`${lh} - Setup already in progress, skipping duplicate execution...`);
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
                    console.log(`${lh} - DOM mutation detected at ${Date.now() - lastMutationTime}ms since last mutation.`);
                    lastMutationTime = Date.now();
                });

                const checkDropdownReadiness = () => {
                    const buyDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                    return buyDropdown && buyDropdown.offsetWidth > 0 && buyDropdown.offsetHeight > 0;
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
                        console.log(`${lh} - DOM stability achieved or timeout reached after ${totalElapsed}ms.`);
                        resolve();
                    } else {
                        setTimeout(checkStability, 500);
                    }
                };

                setTimeout(checkStability, 500);
                setTimeout(() => {
                    observer.disconnect();
                    console.warn(`${lh} - DOM stability check timed out after ${maxWaitTime}ms. Proceeding with token setup.`);
                    resolve();
                }, maxWaitTime);
            });
        } catch (error) {
            console.error(`${lh} - Error in waitForDOMStability:`, error);
            notifyUser('Pond0x Warning', `Error stabilizing DOM: ${error.message}. Proceeding anyway.`);
            updateLog(`DOM error`);
        }

        try {
            const sellDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[0];
            if (!sellDropdown) {
                console.error(`${lh} - Top dropdown not found.`);
                notifyUser('Pond0x Warning', 'Sell dropdown not found.');
                updateLog('Sell dropdown missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Clicking top dropdown for ${sellToken.name}...`);
            updateLog(`Sell: ${sellToken.name}`);
            sellDropdown.click();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const searchBar = document.querySelector('input[placeholder="Search"]');
            if (!searchBar) {
                console.error(`${lh} - Search bar not found for ${sellToken.name}.`);
                notifyUser('Pond0x Warning', `Search bar not found for ${sellToken.name}.`);
                updateLog('Search bar missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Found search bar, inputting ${sellToken.name} address...`);
            searchBar.value = sellToken.address;
            searchBar.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1000));

            const selectTokenOption = async (tokenName, isSellToken = true, maxAttempts = 5, delay = 1000) => {
                console.log(`${lh} - Starting selectTokenOption for ${tokenName} (isSellToken: ${isSellToken})...`);
                let attempts = 0;
                const normalizedTokenName = tokenName.toUpperCase();
                const tokenConfig = TOKEN_CONFIG[normalizedTokenName];
                if (!tokenConfig) {
                    console.error(`${lh} - Token configuration for ${tokenName} not found in TOKEN_CONFIG.`);
                    notifyUser('Pond0x Error', `Token configuration for ${tokenName} not found.`);
                    updateLog(`No config: ${tokenName}`);
                    return false;
                }

                while (attempts < maxAttempts) {
                    let tokenOption;
                    if (tokenName.toLowerCase() === 'wpond' && tokenConfig.descriptionSelector && tokenConfig.descriptionText) {
                        const descriptionElements = document.querySelectorAll(`div[class*="flex"][class*="items-center"] ${tokenConfig.descriptionSelector}`);
                        tokenOption = Array.from(descriptionElements).find(el => el.textContent.trim() === tokenConfig.descriptionText)?.closest('div[class*="flex"][class*="items-center"]');
                        if (!tokenOption) {
                            console.warn(`${lh} - wPOND description selector not found.`);
                            return false;
                        }
                    } else if (tokenConfig.selector) {
                        tokenOption = document.querySelector(`div[class*="flex"][class*="items-center"] ${tokenConfig.selector}`)?.closest('div[class*="flex"][class*="items-center"]');
                    }
                    if (tokenOption) {
                        console.log(`${lh} - Found ${tokenName} option in DOM:`, tokenOption.outerHTML);
                        const clickableButton = tokenOption.querySelector('button') || tokenOption;
                        if (clickableButton) {
                            const dropdown = isSellToken ? sellDropdown : document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                            if (dropdown) {
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
                                        const isVisuallySelected = dropdownButton && (dropdownButton.innerHTML.includes(tokenName) || dropdownButton.innerHTML.includes(tokenConfig.descriptionText || tokenName));
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
                                console.log(`${lh} - Successfully selected ${tokenName} after click.`);
                                updateLog(`${tokenName} selected`);
                                return true;
                            } else {
                                console.warn(`${lh} - ${tokenName} click did not result in selection, retrying...`);
                                if (!isSellToken) {
                                    const buyDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                                    if (buyDropdown) {
                                        console.log(`${lh} - Re-opening Buy dropdown to retry ${tokenName} selection...`);
                                        buyDropdown.click();
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                        const searchBarRetry = document.querySelector('input[placeholder="Search"]');
                                        if (searchBarRetry) {
                                            searchBarRetry.value = tokenConfig.address;
                                            searchBarRetry.dispatchEvent(new Event('input', { bubbles: true }));
                                            await new Promise(resolve => setTimeout(resolve, 1000));
                                        }
                                    }
                                }
                            }
                        } else {
                            console.warn(`${lh} - No clickable button found for ${tokenName}, retrying...`);
                        }
                    } else {
                        console.warn(`${lh} - ${tokenName} option not found (attempt ${attempts + 1}/${maxAttempts}). Retrying...`);
                    }
                    await new Promise(resolve => setTimeout(resolve, delay));
                    attempts++;
                }
                console.error(`${lh} - Failed to find or select ${tokenName} option after ${maxAttempts} attempts.`);
                notifyUser('Pond0x Warning', `${tokenName} option not found or not selectable after multiple attempts.`);
                updateLog(`Failed: ${tokenName}`);
                return false;
            };

            console.log(`${lh} - Setting up Sell token ${sellToken.name}...`);
            if (!(await selectTokenOption(sellToken.name, true))) {
                console.error(`${lh} - Failed to set up Sell token ${sellToken.name}.`);
                isSettingUp = false;
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));

            let buyDropdown;
            for (let attempt = 0; attempt < 3; attempt++) {
                buyDropdown = document.querySelectorAll('button.rounded-full.flex.items-center')[1];
                if (buyDropdown && buyDropdown.offsetWidth > 0 && buyDropdown.offsetHeight > 0) {
                    console.log(`${lh} - Buy dropdown found on attempt ${attempt + 1}.`);
                    break;
                }
                console.warn(`${lh} - Buy dropdown not ready, retrying... (attempt ${attempt + 1}/3)`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (!buyDropdown) {
                console.error(`${lh} - Bottom dropdown not found after retries.`);
                notifyUser('Pond0x Warning', 'Buy dropdown not found after retries.');
                updateLog('Buy dropdown missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Clicking bottom dropdown for ${buyToken.name}...`);
            updateLog(`Buy: ${buyToken.name}`);
            buyDropdown.click();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const searchBarBuy = document.querySelector('input[placeholder="Search"]');
            if (!searchBarBuy) {
                console.error(`${lh} - Search bar not found for ${buyToken.name}.`);
                notifyUser('Pond0x Warning', `Search bar not found for ${buyToken.name}.`);
                updateLog('Search bar missing');
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - Found search bar, inputting ${buyToken.name} address...`);
            searchBarBuy.value = buyToken.address;
            searchBarBuy.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1000));

            let buySelectionSuccess = false;
            for (let retry = 0; retry < 4; retry++) {
                console.log(`${lh} - Attempt ${retry + 1} to select Buy token ${buyToken.name}...`);
                if (await selectTokenOption(buyToken.name, false)) {
                    buySelectionSuccess = true;
                    break;
                }
                console.warn(`${lh} - Buy token ${buyToken.name} selection failed on attempt ${retry + 1}, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000 + (retry * 1000)));
                buyDropdown.click();
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (searchBarBuy) {
                    searchBarBuy.value = buyToken.address;
                    searchBarBuy.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            if (!buySelectionSuccess) {
                console.error(`${lh} - Failed to select Buy token ${buyToken.name} after multiple retries.`);
                notifyUser('Pond0x Warning', `Failed to select Buy token ${buyToken.name} after multiple retries.`);
                updateLog(`Failed: ${buyToken.name}`);
                isSettingUp = false;
                return false;
            }

            const selectedBuy = document.querySelector(`button.rounded-full.flex.items-center ${buyToken.selector || `img[alt="${buyToken.name}"]`}`);
            if (!selectedBuy) {
                console.error(`${lh} - ${buyToken.name} not confirmed as selected after click.`);
                notifyUser('Pond0x Warning', `${buyToken.name} not confirmed as selected.`);
                updateLog(`${buyToken.name} not confirmed`);
                isSettingUp = false;
                return false;
            }
            console.log(`${lh} - ${buyToken.name} confirmed as selected.`);
            await initializeControlPanel();
            isSettingUp = false;
            console.log(`${lh} - Completed setupTokensAndAmount successfully.`);
            updateLog('Ready to swap');
            return true;
        } catch (error) {
            console.error(`${lh} - Error in setupTokensAndAmount at ${new Date().toISOString()}:`, error);
            notifyUser('Pond0x Error', `Error during token setup: ${error.message}`);
            updateLog(`Error: ${error.message}`);
            isSettingUp = false;
            return false;
        }
    }

    async function startSwapping() {
        console.log(`${lh} - Inside startSwapping function at ${new Date().toISOString()}...`);

        if (!swapButton) {
            console.error(`${lh} - Swap button not found for swapping.`);
            notifyUser('Pond0x Warning', 'Swap button not found.');
            updateLog('Button missing');
            isSwapRunning = false;
            await GM.setValue('pond0xIsSwapRunning', false);
            const startBtn = document.getElementById('startSwappingBtn');
            if (startBtn) startBtn.disabled = false;
            return;
        }

        if (!isSwapping) {
            console.log(`${lh} - isSwapping is false, exiting startSwapping.`);
            isSwapRunning = false;
            await GM.setValue('pond0xIsSwapRunning', false);
            const startBtn = document.getElementById('startSwappingBtn');
            if (startBtn) startBtn.disabled = false;
            return;
        }

        const amountSet = await updateAmountInput();
        if (!amountSet) {
            console.warn(`${lh} - Failed to set swap amount. Retrying once...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!(await updateAmountInput())) {
                console.error(`${lh} - Failed to set swap amount after retry. Stopping.`);
                notifyUser('Pond0x Warning', 'Failed to set swap amount after retry. Stopping.');
                updateLog('Amount retry failed');
                isSwapping = false;
                await GM.setValue('pond0xIsSwapping', false);
                isSwapRunning = false;
                await GM.setValue('pond0xIsSwapRunning', false);
                const startBtn = document.getElementById('startSwappingBtn');
                if (startBtn) {
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
        if (!isSwapping && startBtn) {
            startBtn.textContent = 'Start Swapping';
            startBtn.style.background = '#28a745';
            startBtn.disabled = false;
            console.log(`${lh} - Re-enabled Start Swapping button after completion.`);
            updateLog('Swapping done');
        }
    }

    async function performSwap() {
        if (!isSwapping) {
            isSwapRunning = false;
            await GM.setValue('pond0xIsSwapRunning', false);
            const startBtn = document.getElementById('startSwappingBtn');
            if (startBtn) startBtn.disabled = false;
            return;
        }

        console.log(`${lh} - Attempting swap #${swapCounter + 1} at ${new Date().toISOString()} (Sell: ${selectedSellToken}, Buy: ${selectedBuyToken})`);
        updateLog(`Swap #${swapCounter + 1}`);

        while (isSwapping) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
            if (!swapButton || !document.body.contains(swapButton)) {
                swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                if (!swapButton) {
                    console.error(`${lh} - Swap button not found after click. Possible rejection or page change. Stopping.`);
                    notifyUser('Pond0x Warning', 'Swap button not found after click. Stopping.');
                    updateLog('Button lost');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn) {
                        startBtn.textContent = 'Start Swapping';
                        startBtn.style.background = '#28a745';
                        startBtn.disabled = false;
                    }
                    return;
                }
            }

            if (swapButton.disabled) {
                console.log(`${lh} - Swap button disabled. Waiting 1 second...`);
                updateLog('Button disabled');
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (swapButton.disabled) {
                    console.error(`${lh} - Swap button still disabled. Stopping.`);
                    notifyUser('Pond0x Warning', 'Swap button still disabled. Stopping.');
                    updateLog('Still disabled');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn) {
                        startBtn.textContent = 'Start Swapping';
                        startBtn.style.background = '#28a745';
                        startBtn.disabled = false;
                    }
                    return;
                }
            }

            swapButton.click();
            console.log(`${lh} - Swap button clicked at ${new Date().toISOString()}.`);
            updateLog('Swap clicked');

            let stuckStartTime = Date.now();
            let isStuck = false;

            while (isSwapping) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                if (!swapButton) {
                    console.error(`${lh} - Swap button not found after click. Possible rejection or page change. Stopping.`);
                    notifyUser('Pond0x Warning', 'Swap button not found after click. Stopping.');
                    updateLog('Button lost');
                    isSwapping = false;
                    await GM.setValue('pond0xIsSwapping', false);
                    isSwapRunning = false;
                    await GM.setValue('pond0xIsSwapRunning', false);
                    const startBtn = document.getElementById('startSwappingBtn');
                    if (startBtn) {
                        startBtn.textContent = 'Start Swapping';
                        startBtn.style.background = '#28a745';
                        startBtn.disabled = false;
                    }
                    return;
                }

                const buttonText = swapButton.textContent.toLowerCase();
                const timeElapsed = Date.now() - stuckStartTime;

                if (buttonText.includes('swap again')) {
                    console.log(`${lh} - Swap button on 'swap again'. Clicking immediately...`);
                    updateLog('Swap again');
                    let retryAttempts = 0;
                    const maxRetryAttempts = 3;
                    while (retryAttempts < maxRetryAttempts) {
                        swapButton.click();
                        console.log(`${lh} - Attempt ${retryAttempts + 1}/${maxRetryAttempts}: Clicked 'Swap Again' at ${new Date().toISOString()}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        swapButton = document.querySelector('.text-xl.btntxt') || document.querySelector('[class*="btntxt"]');
                        if (!swapButton) {
                            console.error(`${lh} - Swap button disappeared after clicking 'Swap Again'. Stopping.`);
                            updateLog('Button lost');
                            isSwapping = false;
                            await GM.setValue('pond0xIsSwapping', false);
                            isSwapRunning = false;
                            await GM.setValue('pond0xIsSwapRunning', false);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn) {
                                startBtn.textContent = 'Start Swapping';
                                startBtn.style.background = '#28a745';
                                startBtn.disabled = false;
                            }
                            return;
                        }
                        const newButtonText = swapButton.textContent.toLowerCase();
                        if (!newButtonText.includes('swap again')) {
                            console.log(`${lh} - Successfully transitioned from 'Swap Again' to '${newButtonText}' after ${retryAttempts + 1} attempts.`);
                            swapCounter++;
                            await GM.setValue('pond0xSwapCounter', swapCounter);
                            document.getElementById('swapCounter').textContent = `Swaps Completed: ${swapCounter}`;
                            notifyUser('Pond0x Swap', `Swap #${swapCounter} completed successfully (Sell: ${selectedSellToken}, Buy: ${selectedBuyToken}).`);
                            updateLog(`Swap #${swapCounter} done`);
                            stuckStartTime = Date.now();

                            // Reward Swaps mode: Swap direction and reinput amount
                            if (isRewardSwapsMode) {
                                // Click the swap direction button
                                const directionSuccess = await clickSwapDirectionButton();
                                if (!directionSuccess) {
                                    console.error(`${lh} - Failed to swap direction. Stopping.`);
                                    isSwapping = false;
                                    await GM.setValue('pond0xIsSwapping', false);
                                    isSwapRunning = false;
                                    await GM.setValue('pond0xIsSwapRunning', false);
                                    const startBtn = document.getElementById('startSwappingBtn');
                                    if (startBtn) {
                                        startBtn.textContent = 'Start Swapping';
                                        startBtn.style.background = '#28a745';
                                        startBtn.disabled = false;
                                    }
                                    return;
                                }

                                // Swap the selected tokens in memory
                                const tempToken = selectedSellToken;
                                selectedSellToken = selectedBuyToken;
                                selectedBuyToken = tempToken;
                                await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                                await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                                lastSwapDirection = `${selectedSellToken}to${selectedBuyToken}`;
                                await GM.setValue('pond0xLastSwapDirection', lastSwapDirection);
                                console.log(`${lh} - Swapped direction: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);

                                // Reinput the amount (9.02) for the new sell token
                                const amountSet = await updateAmountInput();
                                if (!amountSet) {
                                    console.error(`${lh} - Failed to reinput amount after direction swap. Stopping.`);
                                    notifyUser('Pond0x Error', 'Failed to reinput amount after direction swap.');
                                    updateLog('Amount reinput failed');
                                    isSwapping = false;
                                    await GM.setValue('pond0xIsSwapping', false);
                                    isSwapRunning = false;
                                    await GM.setValue('pond0xIsSwapRunning', false);
                                    const startBtn = document.getElementById('startSwappingBtn');
                                    if (startBtn) {
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
                        console.error(`${lh} - Failed to transition out of 'Swap Again' after ${maxRetryAttempts} attempts. Reloading page...`);
                        notifyUser('Pond0x Warning', `Swap stuck on 'Swap Again' after multiple attempts. Reloading page...`);
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
                    console.log(`${lh} - Swap button stuck on 'retry'. Clicking immediately...`);
                    updateLog('Retrying');
                    swapButton.click();
                    stuckStartTime = Date.now();
                    continue;
                }

                if (buttonText.includes('swapping') || buttonText.includes('pending') || buttonText.includes('pending approvals') || buttonText.includes('preparing transactions')) {
                    console.log(`${lh} - Swap in ${buttonText} state for ${timeElapsed}ms...`);
                    updateLog(`${buttonText}`);
                    if (timeElapsed > SWAP_STUCK_TIMEOUT) {
                        console.warn(`${lh} - Swap stuck in ${buttonText} state for over 40 seconds. Reloading page...`);
                        notifyUser('Pond0x Warning', `Swap stuck in ${buttonText} state for over 40 seconds. Reloading page...`);
                        updateLog('Stuck, reloading');
                        await GM.setValue('pond0xLastSwapAmount', swapAmount);
                        await GM.setValue('pond0xLastIsSwapping', true);
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                    isStuck = true;
                } else if (buttonText.includes('loading')) {
                    console.log(`${lh} - Swap button in 'loading...' state for ${timeElapsed}ms...`);
                    updateLog('Loading...');
                    if (timeElapsed > 10000) {
                        console.warn(`${lh} - Swap stuck in 'loading...' state for over 10 seconds. Reloading page...`);
                        notifyUser('Pond0x Warning', `Swap stuck in 'loading...' state for over 10 seconds. Reloading page...`);
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
                        console.log(`${lh} - Swap state resolved after ${timeElapsed}ms.`);
                        isStuck = false;
                        stuckStartTime = Date.now();
                    }
                    if (buttonText.includes('swap')) {
                        console.log(`${lh} - Swap button ready. Initiating next swap...`);
                        updateLog('Ready for swap');
                        swapButton.click();
                        stuckStartTime = Date.now();
                        continue;
                    } else {
                        console.error(`${lh} - Unexpected button state after click:`, buttonText, 'Stopping.');
                        notifyUser('Pond0x Warning', `Unexpected button state: ${buttonText}. Stopping.`);
                        updateLog(`State: ${buttonText}`);
                        isSwapping = false;
                        await GM.setValue('pond0xIsSwapping', false);
                        isSwapRunning = false;
                        await GM.setValue('pond0xIsSwapRunning', false);
                        const startBtn = document.getElementById('startSwappingBtn');
                        if (startBtn) {
                            startBtn.textContent = 'Start Swapping';
                            startBtn.style.background = '#28a745';
                            startBtn.disabled = false;
                        }
                        return;
                    }
                }
            }
        }

        // In Reward Swaps mode, continue the loop indefinitely by initiating the next swap
        if (isRewardSwapsMode && isSwapping) {
            console.log(`${lh} - Reward Swaps mode: Initiating next swap in the cycle...`);
            await new Promise(resolve => setTimeout(resolve, retryInterval));
            await performSwap();
        }
    }

    function reInjectControlPanel() {
        if (!controlPanel || !document.body.contains(controlPanel)) {
            console.log(`${lh} - Control panel missing, re-injecting at initial position...`);
            document.body.appendChild(controlPanel);
            
            const currentLeft = parseInt(controlPanel.style.left) || parseInt(initialPanelPosition.left);
            const currentTop = parseInt(controlPanel.style.top) || parseInt(initialPanelPosition.top.replace('px', ''));
            controlPanel.style.left = `${currentLeft}px`;
            controlPanel.style.top = `${currentTop}px`;
            
            let isDragging = false;
            let currentX, currentY;
            controlPanel.onmousedown = (e) => {
                if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && !e.target.closest('button') && !e.target.closest('input') && !e.target.closest('select')) {
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

            // Restore button states after re-injecting
            const boostSwapsBtn = document.getElementById('boostSwapsBtn');
            const rewardSwapsBtn = document.getElementById('rewardSwapsBtn');
            const customSwapsBtn = document.getElementById('customSwapsBtn');
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

            updateLog('Panel re-injected');
        }
    }

    window.addEventListener('error', (event) => {
        if (event.message.includes('Cannot read properties of undefined (reading \'syncProps\')')) {
            console.error(`${lh} - Detected application error (syncProps) at ${new Date().toISOString()}. Stack:`, event.error?.stack);
            updateLog('App error');
            if (!hasReloaded) {
                console.log(`${lh} - Reloading page to recover from application error...`);
                sessionStorage.setItem('pond0xSwapReloaded', 'true');
                window.location.reload();
            } else if (setupRetryCount < MAX_SETUP_RETRIES) {
                console.log(`${lh} - Page already reloaded, attempting to reinitialize setup (retry ${setupRetryCount + 1}/${MAX_SETUP_RETRIES})...`);
                setupRetryCount++;
                setTimeout(async () => {
                    try {
                        const success = await setupTokensAndAmount();
                        if (success) {
                            console.log(`${lh} - Setup reinitialized successfully after error at ${new Date().toISOString()}.`);
                            sessionStorage.setItem('initialSetupDone', 'true');
                        } else {
                            console.error(`${lh} - Setup reinitialization failed at ${new Date().toISOString()}.`);
                            notifyUser('Pond0x Error', 'Failed to reinitialize setup after error.');
                            updateLog('Setup failed');
                        }
                    } catch (error) {
                        console.error(`${lh} - Error during setup reinitialization at ${new Date().toISOString()}:`, error);
                        notifyUser('Pond0x Error', `Error reinitializing setup: ${error.message}`);
                        updateLog(`Error: ${error.message}`);
                    }
                }, 3000);
            } else {
                console.error(`${lh} - Max setup retries reached at ${new Date().toISOString()}. Cannot proceed.`);
                notifyUser('Pond0x Error', 'Application error persists after reload and retries. Please try again later.');
                updateLog('Max retries');
            }
        }
    });

    if (hasReloaded) {
        console.log(`${lh} - Page has already been reloaded once. Proceeding with caution...`);
        updateLog('Reloaded');
    }

    console.log(`${lh} - Waiting for page to be ready before starting swap automation...`);
    try {
        const pageReady = await waitForPageReady();
        if (!pageReady) {
            console.warn(`${lh} - Page readiness check failed. Attempting to proceed anyway...`);
            notifyUser('Pond0x Warning', 'Page took too long to load. Proceeding with swap setup, but functionality may be limited.');
            updateLog('Page not ready');
        }

        console.log(`${lh} - Page readiness check completed. Scheduling token setup...`);
        setTimeout(async () => {
            try {
                console.log(`${lh} - Starting token setup...`);
                if (hasReloaded && isRewardSwapsMode) {
                    // Restore the last known token pair direction
                    if (lastSwapDirection === 'USDCtoUSDT') {
                        selectedSellToken = 'USDC';
                        selectedBuyToken = 'USDT';
                    } else {
                        selectedSellToken = 'USDT';
                        selectedBuyToken = 'USDC';
                    }
                    await GM.setValue('pond0xSelectedSellToken', selectedSellToken);
                    await GM.setValue('pond0xSelectedBuyToken', selectedBuyToken);
                    console.log(`${lh} - Restored token pair after reload: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
                }
                const setupSuccess = await setupTokensAndAmount();
                if (setupSuccess) {
                    sessionStorage.setItem('initialSetupDone', 'true');
                    const amountSet = await updateAmountInput();
                    if (!amountSet) {
                        console.error(`${lh} - Failed to set swap amount after token setup during reload at ${new Date().toISOString()}.`);
                        notifyUser('Pond0x Warning', 'Failed to set swap amount after reload. Please check manually.');
                        updateLog('Amount failed');
                    } else {
                        console.log(`${lh} - Successfully set swap amount to ${swapAmount} after reload at ${new Date().toISOString()}.`);
                    }
                    if (hasReloaded && isSwapping && !isSwapRunning) {
                        if (isAutoMode) {
                            console.log(`${lh} - Auto mode: Auto-resuming swapping after reload at ${new Date().toISOString()}...`);
                            isSwapRunning = true;
                            await GM.setValue('pond0xIsSwapRunning', true);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn) {
                                startBtn.textContent = 'Stop Swapping';
                                startBtn.style.background = '#dc3545';
                                startBtn.disabled = true;
                            }
                            await startSwapping();
                            setTimeout(async () => {
                                if (isSwapping && !isSwapRunning) {
                                    console.log(`${lh} - Fallback: Re-initiating swap loop after reload delay at ${new Date().toISOString()}...`);
                                    await startSwapping();
                                }
                            }, 2000);
                        } else {
                            console.log(`${lh} - Manual mode: Awaiting user input after reload at ${new Date().toISOString()}...`);
                            isSwapping = false;
                            isSwapRunning = false;
                            await GM.setValue('pond0xIsSwapping', false);
                            await GM.setValue('pond0xIsSwapRunning', false);
                            const startBtn = document.getElementById('startSwappingBtn');
                            if (startBtn) {
                                startBtn.textContent = 'Start Swapping';
                                startBtn.style.background = '#28a745';
                                startBtn.disabled = false;
                            }
                            updateLog('Awaiting user input');
                            notifyUser('Pond0x Info', 'Manual mode: Swapping stopped after reload. Please start swapping manually.');
                        }
                    }
                } else if (setupRetryCount < MAX_SETUP_RETRIES) {
                    setupRetryCount++;
                    console.error(`${lh} - Initial setup failed at ${new Date().toISOString()}. Retrying (${setupRetryCount}/${MAX_SETUP_RETRIES}) in 5 seconds...`);
                    notifyUser('Pond0x Warning', `Initial setup failed. Retrying (${setupRetryCount}/${MAX_SETUP_RETRIES})...`);
                    updateLog(`Retry ${setupRetryCount}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    const retrySuccess = await setupTokensAndAmount();
                    if (retrySuccess) {
                        sessionStorage.setItem('initialSetupDone', 'true');
                        const amountSet = await updateAmountInput();
                        if (!amountSet) {
                            console.error(`${lh} - Failed to set swap amount after token setup during retry at ${new Date().toISOString()}.`);
                            notifyUser('Pond0x Warning', 'Failed to set swap amount after retry. Please check manually.');
                            updateLog('Amount failed');
                        } else {
                            console.log(`${lh} - Successfully set swap amount to ${swapAmount} after retry at ${new Date().toISOString()}.`);
                        }
                        if (hasReloaded && isSwapping && !isSwapRunning) {
                            if (isAutoMode) {
                                console.log(`${lh} - Auto mode: Auto-resuming swapping after successful retry at ${new Date().toISOString()}...`);
                                isSwapRunning = true;
                                await GM.setValue('pond0xIsSwapRunning', true);
                                const startBtn = document.getElementById('startSwappingBtn');
                                if (startBtn) {
                                    startBtn.textContent = 'Stop Swapping';
                                    startBtn.style.background = '#dc3545';
                                    startBtn.disabled = true;
                                }
                                await startSwapping();
                                setTimeout(async () => {
                                    if (isSwapping && !isSwapRunning) {
                                        console.log(`${lh} - Fallback: Re-initiating swap loop after retry delay at ${new Date().toISOString()}...`);
                                        await startSwapping();
                                    }
                                }, 2000);
                            } else {
                                console.log(`${lh} - Manual mode: Awaiting user input after retry at ${new Date().toISOString()}...`);
                                isSwapping = false;
                                isSwapRunning = false;
                                await GM.setValue('pond0xIsSwapping', false);
                                await GM.setValue('pond0xIsSwapRunning', false);
                                const startBtn = document.getElementById('startSwappingBtn');
                                if (startBtn) {
                                    startBtn.textContent = 'Start Swapping';
                                    startBtn.style.background = '#28a745';
                                    startBtn.disabled = false;
                                }
                                updateLog('Awaiting user input');
                                notifyUser('Pond0x Info', 'Manual mode: Swapping stopped after retry. Please start swapping manually.');
                            }
                        }
                    } else {
                        console.error(`${lh} - Initial setup failed after retry ${setupRetryCount} at ${new Date().toISOString()}.`);
                        notifyUser('Pond0x Error', `Initial setup failed after ${setupRetryCount} retries.`);
                        updateLog(`Failed after ${setupRetryCount}`);
                    }
                } else {
                    console.error(`${lh} - Max setup retries reached at ${new Date().toISOString()}. Aborting.`);
                    notifyUser('Pond0x Error', 'Initial setup failed after maximum retries.');
                    updateLog('Max retries');
                }
            } catch (error) {
                console.error(`${lh} - Error in token setup at ${new Date().toISOString()}:`, error);
                notifyUser('Pond0x Error', `Error during token setup: ${error.message}`);
                updateLog(`Error: ${error.message}`);
                isSettingUp = false;
            }
        }, 1000);
    } catch (error) {
        console.error(`${lh} - Error in main execution flow at ${new Date().toISOString()}:`, error);
        notifyUser('Pond0x Error', `Error initializing swapper: ${error.message}`);
        updateLog(`Init error`);
    }
})();