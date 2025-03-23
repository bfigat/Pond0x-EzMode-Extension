(async function () {
    'use strict';

    const lh = '[Pond0x-AutoSwapper]';

    console.log(`${lh} *** SWAP AUTOMATION RUNNING ***`);

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

    // Utility function to sanitize DOM-derived content
    const sanitizeDomContent = (content) => {
        if (typeof content !== 'string') return '';
        // Allow only alphanumeric, spaces, colons, and basic punctuation
        return content.replace(/[^a-zA-Z0-9\s:.-]/g, '');
    };

    // Utility function to sanitize user inputs
    const sanitizeInput = (value) => {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    };

    // Custom sanitization for wallet addresses (alphanumeric, 32-44 characters as per Solana wallet address spec)
    const sanitizeWalletAddress = (address) => {
        if (typeof address !== 'string') {
            console.error(`${lh} - Wallet address must be a string`);
            return '';
        }
        // Solana wallet addresses are base58 encoded, typically 32-44 characters
        const sanitized = address.replace(/[^A-Za-z0-9]/g, '');
        if (sanitized.length < 32 || sanitized.length > 44) {
            console.error(`${lh} - Invalid wallet address length after sanitization: ${sanitized.length}`);
            return '';
        }
        return sanitized;
    };

    // Hash wallet address to prevent leakage
    const hashWalletAddress = async (address) => {
        const encoder = new TextEncoder();
        const data = encoder.encode(address);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    };

    // Generate CSRF token
    const generateCsrfToken = () => {
        return Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    };

    // Store CSRF token in chrome.storage.local on script load
    let csrfToken = null;
    (async () => {
        csrfToken = await GM.getValue('pond0xCsrfToken', null);
        if (!csrfToken) {
            csrfToken = generateCsrfToken();
            await GM.setValue('pond0xCsrfToken', csrfToken);
        }
    })();

    // Validate CSRF token
    const validateCsrfToken = async (token) => {
        const storedToken = await GM.getValue('pond0xCsrfToken', null);
        return token === storedToken;
    };

    // Rotate CSRF token periodically
    setInterval(async () => {
        csrfToken = generateCsrfToken();
        await GM.setValue('pond0xCsrfToken', csrfToken);
        console.log(`${lh} - Rotated CSRF token`);
    }, 30 * 60 * 1000); // Rotate every 30 minutes

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
        const hasContent = document.querySelector('div') !== null; // Ensure some content exists
        return (hasErrorMessage || (isBlackScreen && errorText.trim().length < 50)) && !hasContent;
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
            logWindow.textContent = `${currentTime}: ${sanitizeDomContent(message)}\n${logWindow.textContent.split('\n')[0] || ''}`.trim();
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
    // [Start of Part 2]
    // Part 2 includes core functions: clickSwapDirectionButton, waitForPageReady, waitForSwapButton, fetchManifestSwaps

    async function clickSwapDirectionButton() {
        console.log(`${lh} - Attempting to click the swap direction button...`);
        const swapDirectionButton = document.querySelector('div.block svg.icons-sc-71agnn-0.KVxRw');
        if (!swapDirectionButton || !swapDirectionButton.isConnected) {
            console.error(`${lh} - Swap direction button not found.`);
            notifyUser('Pond0x Error', 'Swap direction button not found.');
            updateLog('Direction button missing');
            return false;
        }

        const parentDiv = swapDirectionButton.closest('div.block');
        if (!parentDiv || !parentDiv.isConnected) {
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
        return new Promise(async (resolve) => {
            const sanitizedWalletAddress = sanitizeWalletAddress(walletAddress);
            if (!sanitizedWalletAddress) {
                console.error(`${lh} - Invalid wallet address after sanitization`);
                resolve('Error');
                return;
            }
            const hashedWalletAddress = await hashWalletAddress(sanitizedWalletAddress);
            console.log(`${lh} - Opening hidden tab to fetch manifest swaps for [Hashed Wallet Address]`);
            chrome.runtime.sendMessage({ action: 'openTab', url: 'https://cary0x.github.io/docs/info/manifest' }, (tabId) => {
                if (!tabId) {
                    console.error(`${lh} - Failed to open hidden tab`);
                    resolve('Error');
                    return;
                }

                chrome.runtime.sendMessage({
                    action: 'injectManifestScript',
                    tabId: tabId,
                    walletAddress: hashedWalletAddress
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
    // [Start of Part 3]
    // Part 3 includes the initializeControlPanel function

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
                    const tokenSetupSuccess = await setupTokensAndAmount(csrfToken);
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
                let value = parseFloat(sanitizeInput(e.target.value));
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
                const sellValue = sanitizeInput(sellTokenSelect.value);
                const buyValue = sanitizeInput(buyTokenSelect.value);
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
                await setupTokensAndAmount(csrfToken);
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
                    console.log(`${lh} - Adjusted Buy token to ${newBuyToken} to avoid duplicate with Sell ${sellValue}`);
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
                retryInterval = parseInt(sanitizeInput(e.target.value)) * 1000 || 3000;
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
                const walletAddress = sanitizeInput(e.target.value.trim());
                if (walletAddress.length >= 32 && walletAddress.length <= 44) {
                    updateLog('Fetching swaps');
                    console.log(`${lh} - Fetching swaps for wallet: [Redacted]`);
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
    // [Start of Part 4]
    // Part 4 includes token and amount setup functions: updateAmountInput, setupTokensAndAmount

    async function updateAmountInput() {
        console.log(`${lh} - Updating amount input to ${swapAmount} ${selectedSellToken}...`);
        const amountInput = document.querySelector('input[placeholder="0.0"]');
        if (!amountInput || !amountInput.isConnected) {
            console.error(`${lh} - Amount input field not found.`);
            notifyUser('Pond0x Error', 'Amount input field not found.');
            updateLog('Amount input missing');
            return false;
        }

        try {
            amountInput.focus();
            amountInput.value = swapAmount.toString();
            amountInput.dispatchEvent(new Event('focus', { bubbles: true }));
            amountInput.dispatchEvent(new Event('input', { bubbles: true }));
            amountInput.dispatchEvent(new Event('change', { bubbles: true }));
            amountInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
            console.log(`${lh} - Amount input updated to ${swapAmount} ${selectedSellToken}`);
            updateLog(`Amount set: ${swapAmount}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return true;
        } catch (error) {
            console.error(`${lh} - Error updating amount input:`, error);
            notifyUser('Pond0x Error', `Error updating amount: ${error.message}`);
            updateLog(`Amount update error: ${error.message}`);
            return false;
        }
    }

    async function setupTokensAndAmount(csrfTokenParam) {
        console.log(`${lh} - Starting setupTokensAndAmount...`);
        if (isSettingUp) {
            console.log(`${lh} - Setup already in progress, skipping duplicate execution...`);
            return false;
        }

        // Validate CSRF token
        const isValidToken = await validateCsrfToken(csrfTokenParam);
        if (!isValidToken) {
            console.error(`${lh} - Invalid CSRF token. Aborting setup.`);
            notifyUser('Pond0x Error', 'Invalid CSRF token. Setup aborted.');
            updateLog('CSRF validation failed');
            return false;
        }

        isSettingUp = true;
        console.log(`${lh} - Setting up token pair and amount...`);
        updateLog('Setting up');

        const sellToken = TOKEN_CONFIG[selectedSellToken];
        const buyToken = TOKEN_CONFIG[selectedBuyToken];

        if (!sellToken || !buyToken) {
            console.error(`${lh} - Invalid token configuration: Sell=${selectedSellToken}, Buy=${selectedBuyToken}`);
            notifyUser('Pond0x Error', 'Invalid token configuration.');
            updateLog('Invalid tokens');
            isSettingUp = false;
            return false;
        }

        const selectTokenOption = async (tokenName, isSellToken = true, maxAttempts = 5, delay = 1000) => {
            console.log(`${lh} - Starting selectTokenOption for ${tokenName} (isSellToken: ${isSellToken})...`);
            let attempts = 0;
            const normalizedTokenName = tokenName.toUpperCase();
            const tokenConfig = TOKEN_CONFIG[normalizedTokenName];
            if (!tokenConfig || !tokenConfig.address.match(/^[A-Za-z0-9]+$/)) {
                console.error(`${lh} - Invalid token configuration for ${tokenName}`);
                notifyUser('Pond0x Error', `Invalid token configuration for ${tokenName}`);
                updateLog(`No config: ${tokenName}`);
                return false;
            }

            while (attempts < maxAttempts) {
                try {
                    const dropdowns = document.querySelectorAll('button.rounded-full.flex.items-center');
                    if (dropdowns.length < 2) {
                        console.warn(`${lh} - Token dropdowns not found (attempt ${attempts + 1}/${maxAttempts})`);
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    const dropdown = dropdowns[isSellToken ? 0 : 1];
                    if (!dropdown || !dropdown.isConnected) {
                        console.warn(`${lh} - ${isSellToken ? 'Sell' : 'Buy'} token dropdown not found (attempt ${attempts + 1}/${maxAttempts})`);
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    dropdown.click();
                    console.log(`${lh} - Clicked ${isSellToken ? 'sell' : 'buy'} token dropdown`);
                    await new Promise(resolve => setTimeout(resolve, 500));

                    let tokenOption = null;
                    if (tokenConfig.selector) {
                        tokenOption = document.querySelector(tokenConfig.selector);
                    } else if (tokenConfig.descriptionSelector && tokenConfig.descriptionText) {
                        const options = document.querySelectorAll(tokenConfig.descriptionSelector);
                        tokenOption = Array.from(options).find(option => option.textContent.trim() === tokenConfig.descriptionText);
                    }

                    if (!tokenOption || !tokenOption.isConnected) {
                        console.warn(`${lh} - ${tokenName} option not found (attempt ${attempts + 1}/${maxAttempts})`);
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    tokenOption.click();
                    console.log(`${lh} - Selected ${tokenName} as ${isSellToken ? 'sell' : 'buy'} token`);
                    updateLog(`${isSellToken ? 'Sell' : 'Buy'} token: ${tokenName}`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    return true;
                } catch (error) {
                    console.error(`${lh} - Error selecting ${tokenName} (attempt ${attempts + 1}/${maxAttempts}):`, error);
                    attempts++;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            console.error(`${lh} - Failed to select ${tokenName} after ${maxAttempts} attempts`);
            notifyUser('Pond0x Error', `Failed to select ${tokenName}`);
            updateLog(`Failed: ${tokenName}`);
            return false;
        };

        try {
            const sellSuccess = await selectTokenOption(selectedSellToken, true);
            if (!sellSuccess) {
                console.error(`${lh} - Failed to select sell token ${selectedSellToken}`);
                isSettingUp = false;
                return false;
            }

            const buySuccess = await selectTokenOption(selectedBuyToken, false);
            if (!buySuccess) {
                console.error(`${lh} - Failed to select buy token ${selectedBuyToken}`);
                isSettingUp = false;
                return false;
            }

            const amountSuccess = await updateAmountInput();
            if (!amountSuccess) {
                console.error(`${lh} - Failed to update amount to ${swapAmount} ${selectedSellToken}`);
                isSettingUp = false;
                return false;
            }

            console.log(`${lh} - Successfully set up tokens and amount: Sell=${selectedSellToken}, Buy=${selectedBuyToken}, Amount=${swapAmount}`);
            updateLog('Setup complete');
            setupRetryCount = 0;
            isSettingUp = false;
            return true;
        } catch (error) {
            console.error(`${lh} - Error in setupTokensAndAmount:`, error);
            notifyUser('Pond0x Error', `Error setting up tokens: ${error.message}`);
            updateLog(`Setup error: ${error.message}`);
            setupRetryCount++;
            if (setupRetryCount >= MAX_SETUP_RETRIES) {
                console.error(`${lh} - Max setup retries (${MAX_SETUP_RETRIES}) reached. Reloading page...`);
                notifyUser('Pond0x Error', 'Max setup retries reached. Reloading page...');
                updateLog('Max retries, reloading');
                sessionStorage.setItem('pond0xSwapReloaded', 'true');
                window.location.reload();
            }
            isSettingUp = false;
            return false;
        }
    }
    // [Start of Part 5]
    // Part 5 includes swapping logic functions and main execution: startSwapping, performSwap, reInjectControlPanel, and main execution

    async function startSwapping() {
        console.log(`${lh} - Starting swapping process at ${new Date().toISOString()}...`);
        updateLog('Starting swaps');

        const pageReady = await waitForPageReady();
        if (!pageReady) {
            console.error(`${lh} - Page not ready after waiting. Reloading...`);
            notifyUser('Pond0x Error', 'Page not ready. Reloading...');
            updateLog('Page not ready');
            sessionStorage.setItem('pond0xSwapReloaded', 'true');
            window.location.reload();
            return;
        }

        await initializeControlPanel();

        if (!isSwapping) {
            console.log(`${lh} - Swapping stopped before setup. Exiting startSwapping.`);
            updateLog('Swapping stopped');
            return;
        }

        const setupSuccess = await setupTokensAndAmount(csrfToken);
        if (!setupSuccess) {
            console.error(`${lh} - Token and amount setup failed. Reloading...`);
            notifyUser('Pond0x Error', 'Token and amount setup failed. Reloading...');
            updateLog('Setup failed');
            sessionStorage.setItem('pond0xSwapReloaded', 'true');
            window.location.reload();
            return;
        }

        console.log(`${lh} - Setup completed successfully. Beginning swap loop...`);
        updateLog('Swap loop started');
        await performSwap();
    }

    async function performSwap() {
        console.log(`${lh} - Starting performSwap at ${new Date().toISOString()}...`);
        let lastSwapTime = 0;
        const SWAP_COOLDOWN = 5000; // 5 seconds cooldown between swap attempts

        while (isSwapping && !isPaused) {
            const now = Date.now();
            if (now - lastSwapTime < SWAP_COOLDOWN) {
                console.log(`${lh} - Swap attempt throttled. Waiting ${SWAP_COOLDOWN - (now - lastSwapTime)}ms...`);
                await new Promise(resolve => setTimeout(resolve, SWAP_COOLDOWN - (now - lastSwapTime)));
            }
            lastSwapTime = now;

            try {
                if (!swapButton || !swapButton.isConnected) {
                    swapButton = await waitForSwapButton();
                    if (!swapButton) {
                        console.error(`${lh} - Swap button not found during performSwap. Reloading...`);
                        notifyUser('Pond0x Error', 'Swap button not found. Reloading...');
                        updateLog('Swap button missing');
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                }

                if (swapButton.disabled) {
                    console.log(`${lh} - Swap button is disabled, waiting for it to become enabled...`);
                    updateLog('Waiting for button');
                    let attempts = 0;
                    const maxAttempts = 10;
                    while (swapButton.disabled && attempts < maxAttempts && isSwapping && !isPaused) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        attempts++;
                        console.log(`${lh} - Waiting for swap button to enable (attempt ${attempts}/${maxAttempts})...`);
                    }
                    if (swapButton.disabled) {
                        console.error(`${lh} - Swap button still disabled after ${maxAttempts} attempts. Reloading...`);
                        notifyUser('Pond0x Error', 'Swap button disabled. Reloading...');
                        updateLog('Button disabled');
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                }

                console.log(`${lh} - Initiating swap: ${swapAmount} ${selectedSellToken} to ${selectedBuyToken}...`);
                updateLog(`Swapping ${swapAmount} ${selectedSellToken}`);

                let swapCompleted = false;
                const startTime = Date.now();
                swapButton.click();

                while (Date.now() - startTime < SWAP_STUCK_TIMEOUT && !swapCompleted && isSwapping && !isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const confirmButton = document.querySelector('button.text-xl.btntxt:not([disabled])');
                    if (confirmButton && confirmButton.textContent.includes('Confirm')) {
                        console.log(`${lh} - Confirm button found, clicking to confirm swap...`);
                        confirmButton.click();
                        swapCompleted = true;
                    }
                }

                if (!swapCompleted) {
                    console.error(`${lh} - Swap did not complete within ${SWAP_STUCK_TIMEOUT / 1000}s. Reloading...`);
                    notifyUser('Pond0x Error', `Swap timed out after ${SWAP_STUCK_TIMEOUT / 1000}s. Reloading...`);
                    updateLog('Swap timeout');
                    sessionStorage.setItem('pond0xSwapReloaded', 'true');
                    window.location.reload();
                    return;
                }

                swapCounter++;
                await GM.setValue('pond0xSwapCounter', swapCounter);
                console.log(`${lh} - Swap completed successfully. Total swaps: ${swapCounter}`);
                updateLog(`Swap ${swapCounter} done`);
                notifyUser('Pond0x Swap', `Swap ${swapCounter} completed: ${swapAmount} ${selectedSellToken} to ${selectedBuyToken}`);

                const swapCounterElement = document.getElementById('swapCounter');
                if (swapCounterElement) {
                    swapCounterElement.textContent = `Swaps Completed: ${swapCounter}`;
                }

                if (isRewardSwapsMode) {
                    console.log(`${lh} - Reward Swaps mode active, swapping direction for next swap...`);
                    const directionSuccess = await clickSwapDirectionButton();
                    if (!directionSuccess) {
                        console.error(`${lh} - Failed to swap direction in Reward Swaps mode. Reloading...`);
                        notifyUser('Pond0x Error', 'Failed to swap direction. Reloading...');
                        updateLog('Direction swap failed');
                        sessionStorage.setItem('pond0xSwapReloaded', 'true');
                        window.location.reload();
                        return;
                    }
                    lastSwapDirection = lastSwapDirection === 'USDCtoUSDT' ? 'USDTtoUSDC' : 'USDCtoUSDT';
                    await GM.setValue('pond0xLastSwapDirection', lastSwapDirection);
                    console.log(`${lh} - Direction swapped to ${lastSwapDirection}`);
                    updateLog(`Direction: ${lastSwapDirection}`);
                }

                await new Promise(resolve => setTimeout(resolve, retryInterval));
            } catch (error) {
                console.error(`${lh} - Error during swap:`, error);
                notifyUser('Pond0x Error', `Swap error: ${error.message}`);
                updateLog(`Error: ${error.message}`);
                sessionStorage.setItem('pond0xSwapReloaded', 'true');
                window.location.reload();
                return;
            }
        }

        console.log(`${lh} - Exiting performSwap loop: isSwapping=${isSwapping}, isPaused=${isPaused}`);
        updateLog('Swap loop exited');
    }

    async function reInjectControlPanel() {
        console.log(`${lh} - Re-injecting control panel...`);
        if (controlPanel && document.body.contains(controlPanel)) {
            controlPanel.remove();
            console.log(`${lh} - Removed existing control panel`);
        }
        controlPanel = null;
        await initializeControlPanel();
        console.log(`${lh} - Control panel re-injected successfully`);
    }

    // Main execution
    console.log(`${lh} - Starting AutoSwapper at ${new Date().toISOString()}...`);
    await initializeControlPanel();
    if (isAutoMode && isSwapping && !isPaused) {
        console.log(`${lh} - Auto mode active, starting swapping process...`);
        await startSwapping();
    } else {
        console.log(`${lh} - Auto mode inactive or paused, waiting for user interaction...`);
        updateLog('Waiting for start');
    }

    window.addEventListener('beforeunload', async () => {
        await GM.setValue('pond0xLastSwapAmount', swapAmount);
        await GM.setValue('pond0xLastIsSwapping', isSwapping);
        console.log(`${lh} - Saved state before unload: swapAmount=${swapAmount}, isSwapping=${isSwapping}`);
    });
})();