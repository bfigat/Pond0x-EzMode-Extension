(function() {
    const lh = '[Pond0x-Status-Injector]';
    console.log(`${lh} *** STATUS INJECTOR INJECTED ***`);

    // Flag to prevent overlapping status checks
    let isSendingStatus = false;

    // Function to validate and retrieve the mining status from the DOM
    function getStatus() {
        try {
            const statusEl = document.querySelector('div[style*="border:1px solid white"] p');
            // Validate the element: Ensure it exists, is connected to the DOM, and matches expected format
            if (statusEl && statusEl.isConnected && statusEl.textContent.match(/Mining:\s*(Stopped|Struggling|Active)/i)) {
                const status = statusEl.textContent.trim().replace(/\s+/g, ' ');
                console.log(`${lh} - Found status: ${status}, Element: ${statusEl.outerHTML}`);
                return status;
            } else {
                console.log(`${lh} - Status element not found or invalid with selector 'div[style*="border:1px solid white"] p'.`);
                return 'Mining: Unknown';
            }
        } catch (error) {
            console.error(`${lh} - Error retrieving status: ${error.message}`);
            return 'Mining: Unknown';
        }
    }

    // Function to send the status to the opener window
    async function sendStatus() {
        // Prevent overlapping sends
        if (isSendingStatus) {
            console.log(`${lh} - Status check already in progress, skipping...`);
            return;
        }

        isSendingStatus = true;
        try {
            const status = getStatus();
            if (window.opener) {
                // Secure cross-origin messaging by specifying the target origin
                window.opener.postMessage({ type: 'miningStatus', status: status }, 'https://www.pond0x.com');
                console.log(`${lh} - Sent status to opener: ${status}`);
            } else {
                console.warn(`${lh} - No window.opener found, status not sent.`);
            }
        } catch (error) {
            console.error(`${lh} - Error sending status: ${error.message}`);
        } finally {
            isSendingStatus = false;
        }
    }

    // Wait for page load and ensure status element is available
    function startStatusMonitoring() {
        console.log(`${lh} - Waiting for status-mini to load...`);
        const startTime = Date.now();
        const checkInterval = setInterval(() => {
            const statusEl = document.querySelector('div[style*="border:1px solid white"] p');
            if (statusEl && statusEl.isConnected) {
                clearInterval(checkInterval);
                const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
                console.log(`${lh} - Status element detected after ${elapsedTime}s, starting status checks...`);
                sendStatus(); // Initial send
                setInterval(() => {
                    sendStatus();
                }, 2000); // Send status every 2 seconds
            } else {
                const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
                console.log(`${lh} - Still waiting for status element after ${elapsedTime}s...`);
                if (elapsedTime > 30) { // Max wait time of 30 seconds
                    console.warn(`${lh} - Status element not found after 30s, starting checks anyway.`);
                    clearInterval(checkInterval);
                    sendStatus(); // Start with current state
                    setInterval(() => {
                        sendStatus();
                    }, 2000); // Continue checking every 2 seconds
                }
            }
        }, 1000); // Check every 1 second
    }

    // Initial delay and start monitoring
    window.addEventListener('load', () => {
        console.log(`${lh} - Page load event triggered, readyState: ${document.readyState}`);
        setTimeout(() => {
            console.log(`${lh} - Initial 10-second delay complete, checking status element...`);
            startStatusMonitoring();
        }, 10000); // 10-second delay to ensure status-mini loads
    });

    // Log DOM readiness for debugging
    console.log(`${lh} - Document readyState on script start: ${document.readyState}`);
})();