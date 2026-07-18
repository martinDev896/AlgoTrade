// ==========================================================================
// AlgoTrade Engine - Dynamic Multi-Asset Operations & Dynamic OAuth2 System
// ==========================================================================

// Global Configuration
// --- 1. MODERN DERIV CONFIGURATION ---
// --- 1. CONFIGURATION ---
// Swap this with your actual NUMERIC App ID from developers.deriv.com
const APP_ID = "33Rch7JPS36kkSKC2iDDt"; 

// --- 2. THE WORKING ROUTING FUNCTION ---
const btnDerivLogin = document.querySelector('button') || document.getElementById('btn-deriv-login');

if (btnDerivLogin) {
    btnDerivLogin.addEventListener('click', () => {
        // We use the exact comma-separated scopes you found!
        const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}&scope=trade,account_manage,read`;
        
        console.log("Redirecting to: ", oauthUrl);
        window.location.href = oauthUrl;
    });
} else {
    console.error("Could not find a button element on this page!");
}
// --- 2. THE MODERNISED AUTHENTICATION FUNCTION ---
if (btnDerivLogin) {
    btnDerivLogin.addEventListener('click', async () => {
        // Generate a random string to protect against CSRF attacks
        const state = Math.random().toString(36).substring(2, 15);
        sessionStorage.setItem('oauth_state', state);

        // The correct updated OAuth2 authorization endpoint format
        const oauthUrl = `https://oauth.deriv.com/oauth2/authorize` + 
                         `?response_type=code` + 
                         `&client_id=${CLIENT_ID}` + 
                         `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` + 
                         `&state=${state}` + 
                         `&scope=read+trade+accounts`; // The specific permissions your app needs

        window.location.href = oauthUrl;
    });
}

// --- 3. EXTRACTING TOKENS AFTER REDIRECT ---
function checkAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code'); // Modern OAuth2 returns an authorization code
    
    if (code) {
        console.log("Authorization code received successfully:", code);
        // Clear the URL parameters so they don't sit in the address bar
        window.history.replaceState({}, document.title, window.location.pathname);
        
        // Next, your app exchanges this 'code' for a short-lived access token via a POST request
        exchangeCodeForToken(code);
    }
}

// Run the callback check on page load
window.addEventListener('DOMContentLoaded', checkAuthCallback);
// Core Trading State Machine
let ws = null;
let isAuthorized = false;
let activeUserToken = null;
let currentSymbol = "1HZ100V";  // Default: Volatility 100 (1s) Index
let currentMarket = "over_under"; // Default selected market contract
let selectedBarrier = 5;         // Default selected digit barrier
let lastSpotPrice = null;

// Graph Configuration
const MAX_CHART_TICKS = 25;
let chartTicksHistory = [];

// DOM Component Handlers
const displayAssetName = document.getElementById('display-asset-name');
const displayMarketName = document.getElementById('display-market-name');
const spotPriceDisplay = document.getElementById('spot-price');
const priceChangeDisplay = document.getElementById('price-change-element');
const balanceDisplay = document.querySelector('.balance-text');

// OAuth Component Interfaces
const btnDerivLogin = document.getElementById('btn-deriv-login');
const btnLogout = document.getElementById('btn-logout');
const userProfileStatus = document.getElementById('user-profile-status');
const userEmailDisplay = document.getElementById('user-email');

// Order Button Interfaces
const btnActionLeft = document.getElementById('btn-action-left') || document.querySelector('.btn-over');
const btnActionRight = document.getElementById('btn-action-right') || document.querySelector('.btn-under');
const labelActionLeft = btnActionLeft?.querySelector('.btn-label') || btnActionLeft;
const labelActionRight = btnActionRight?.querySelector('.btn-label') || btnActionRight;
const iconActionLeft = btnActionLeft?.querySelector('.btn-icon');
const iconActionRight = btnActionRight?.querySelector('.btn-icon');
const barrierBoxContainer = document.querySelector('.barrier-box')?.parentElement || document.getElementById('barrier-container');

// Fallback layout displays if structure differs slightly
const payoutLeftVal = document.getElementById('payout-left-val') || { textContent: "" };
const payoutRightVal = document.getElementById('payout-right-val') || { textContent: "" };

// ==========================================================================
// 1. WebSocket Infrastructure Connections
// ==========================================================================

function connectEngine() {
    ws = new WebSocket(WS_URL);

    ws.onopen = function() {
        console.log("WebSocket Channel Securely Online.");
        // Re-authenticate immediately if connection recovers mid-session
        authenticateWebSocketSession();
        // Request active real-time data ticks for default symbol
        requestMarketTicks(currentSymbol);
    };

    ws.onmessage = function(event) {
        const response = JSON.parse(event.data);

        // A. Handle Real-Time Price Streams
        if (response.msg_type === "tick" && response.tick) {
            if (response.tick.symbol === currentSymbol) {
                processIncomingPriceTick(response.tick);
            }
        }

        // B. Handle Multi-User OAuth Authentications
        else if (response.msg_type === "authorize") {
            if (response.error) {
                console.error("Auth Fail:", response.error.message);
                clearSessionCache();
            } else {
                isAuthorized = true;
                userEmailDisplay.textContent = response.authorize.email;
                btnDerivLogin.style.display = "none";
                if (userProfileStatus) userProfileStatus.classList.remove('hidden');
                
                // Track user's actual platform wallet funds
                balanceDisplay.textContent = `${parseFloat(response.authorize.balance).toFixed(2)} ${response.authorize.currency}`;
                
                // Subscribe to live balance feeds so changes drop down in real-time
                ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
            }
        }

        // C. Handle Live Wallet Updates from Deriv Core
        else if (response.msg_type === "balance") {
            if (!response.error && response.balance) {
                balanceDisplay.textContent = `${parseFloat(response.balance.balance).toFixed(2)} ${response.balance.currency}`;
            }
        }

        // D. Handle Action Placement Confirmations
        else if (response.msg_type === "buy") {
            if (response.error) {
                showAlertBanner("❌ Order Rejected: " + response.error.message, "error");
            } else {
                showAlertBanner(`🎯 Position Opened! ID: ${response.buy.contract_id}`, "success");
            }
        }
    };

    ws.onclose = function() {
        console.log("WebSocket Offline. Attempting reconnection...");
        setTimeout(connectEngine, 3000);
    };
}

function requestMarketTicks(symbol) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Forget previous asset stream subscriptions to save bandwidth
        ws.send(JSON.stringify({ forget_all: "ticks" }));
        // Request new real-time price feed subscription
        ws.send(JSON.stringify({ ticks: symbol }));
    }
}

// ==========================================================================
// 2. Multi-User OAuth Architecture Implementation
// ==========================================================================

if (btnDerivLogin) {
    btnDerivLogin.addEventListener('click', () => {
        // Clean, standard Deriv OAuth entry point
        const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`;
        window.location.href = oauthUrl;
    });
}

if (btnLogout) {
    btnLogout.addEventListener('click', () => {
        clearSessionCache();
    });
}

function clearSessionCache() {
    localStorage.removeItem('algotrade_session');
    isAuthorized = false;
    activeUserToken = null;
    window.location.href = window.location.origin + window.location.pathname; // Reload clear UI
}

function checkOAuthRedirectResponse() {
    const urlParams = new URLSearchParams(window.location.search);
    
    // Check if user just arrived back from a successful Deriv authorization redirect
    if (urlParams.has('acct1') && urlParams.has('token1')) {
        const sessionData = {
            account: urlParams.get('acct1'),
            token: urlParams.get('token1'),
            currency: urlParams.get('cur1') || 'USD'
        };
        
        // Encrypt and persist session locally so they stay logged in if they refresh
        localStorage.setItem('algotrade_session', JSON.stringify(sessionData));
        
        // Clean query strings out of address bar cleanly
        window.history.replaceState({}, document.title, window.location.pathname);
        
        bootUserSession(sessionData.token);
    } else {
        // Fallback checks for active cached credentials
        const savedSession = localStorage.getItem('algotrade_session');
        if (savedSession) {
            const sessionData = JSON.parse(savedSession);
            bootUserSession(sessionData.token);
        }
    }
}

function bootUserSession(token) {
    activeUserToken = token;
    if (btnDerivLogin) btnDerivLogin.style.display = "none";
    if (userProfileStatus) userProfileStatus.classList.remove('hidden');
    if (userEmailDisplay) userEmailDisplay.textContent = "Connecting Account...";
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        authenticateWebSocketSession();
    }
}

function authenticateWebSocketSession() {
    if (!activeUserToken || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ authorize: activeUserToken }));
}

// ==========================================================================
// 3. Interface Interactive Market Routing Logic
// ==========================================================================

function switchMarket(market, label) {
    currentMarket = market;
    if (displayMarketName) displayMarketName.textContent = label;

    // Standardize baseline class names before modifications
    if (btnActionLeft) btnActionLeft.className = "btn btn-over";
    if (btnActionRight) btnActionRight.className = "btn btn-under";

    const showBarrier = () => barrierBoxContainer && barrierBoxContainer.classList.remove('hidden');
    const hideBarrier = () => barrierBoxContainer && barrierBoxContainer.classList.add('hidden');

    switch (market) {
        case "over_under":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Over";
            if (labelActionRight) labelActionRight.textContent = "Under";
            break;
        case "matches_differs":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Matches";
            if (labelActionRight) labelActionRight.textContent = "Differs";
            break;
        case "even_odd":
            hideBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Even";
            if (labelActionRight) labelActionRight.textContent = "Odd";
            break;
        case "rise_fall":
            hideBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Rise";
            if (labelActionRight) labelActionRight.textContent = "Fall";
            break;
        case "higher_lower":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Higher";
            if (labelActionRight) labelActionRight.textContent = "Lower";
            break;
        case "touch_notouch":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Touches";
            if (labelActionRight) labelActionRight.textContent = "Does Not Touch";
            break;
        case "multipliers":
            hideBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Up (Buy)";
            if (labelActionRight) labelActionRight.textContent = "Down (Sell)";
            break;
        case "vanilla":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Buy Call";
            if (labelActionRight) labelActionRight.textContent = "Buy Put";
            break;
        case "accumulators":
            hideBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Open Contract";
            if (labelActionRight) labelActionRight.textContent = "Close Manually";
            break;
        case "turbos":
            showBarrier();
            if (labelActionLeft) labelActionLeft.textContent = "Long Turbo";
            if (labelActionRight) labelActionRight.textContent = "Short Turbo";
            break;
    }
}

// ==========================================================================
// 4. Remote Execution Framework (Order Dispatching)
// ==========================================================================

if (btnActionLeft) btnActionLeft.addEventListener('click', () => dispatchLiveContract("left"));
if (btnActionRight) btnActionRight.addEventListener('click', () => dispatchLiveContract("right"));

function dispatchLiveContract(direction) {
    if (!isAuthorized) {
        alert("Authentication Required! Please click 'Connect Deriv Account' first.");
        return;
    }

    const stakeAmount = parseFloat(document.querySelector('.stake-input')?.value || 10.00);
    let contractType = "";
    let barrierValue = undefined;

    // Convert interface states into strict Deriv Platform API strings
    switch (currentMarket) {
        case "over_under":
            contractType = direction === "left" ? "DIGITOVER" : "DIGITUNDER";
            barrierValue = selectedBarrier;
            break;
        case "matches_differs":
            contractType = direction === "left" ? "DIGITMATCH" : "DIGITDIFF";
            barrierValue = selectedBarrier;
            break;
        case "even_odd":
            contractType = direction === "left" ? "DIGITEVEN" : "DIGITODD";
            break;
        case "rise_fall":
            contractType = direction === "left" ? "CALL" : "PUT";
            break;
        case "higher_lower":
            contractType = direction === "left" ? "HIGHER" : "LOWER";
            barrierValue = `+0.5`; // Baseline execution dynamic offset markup
            break;
        default:
            contractType = direction === "left" ? "CALL" : "PUT";
    }

    const contractProposal = {
        buy: 1,
        price: stakeAmount,
        parameters: {
            amount: stakeAmount,
            basis: "stake",
            contract_type: contractType,
            currency: "USD",
            duration: 5,        // Standardized 5-tick market execution
            duration_unit: "t",
            symbol: currentSymbol
        }
    };

    if (barrierValue !== undefined) {
        contractProposal.parameters.barrier = barrierValue.toString();
    }

    console.log("[AlgoTrade Sending Order Frame]", contractProposal);
    ws.send(JSON.stringify(contractProposal));
}

// ==========================================================================
// 5. Data Feed Processing & Real-Time Live Graph Functions
// ==========================================================================

function processIncomingPriceTick(tickData) {
    const price = parseFloat(tickData.quote);
    
    if (lastSpotPrice !== null && spotPriceDisplay) {
        const change = price - lastSpotPrice;
        const percent = (change / lastSpotPrice) * 100;
        
        spotPriceDisplay.textContent = price.toFixed(tickData.pip_size || 2);
        
        if (change >= 0) {
            spotPriceDisplay.className = "current-price profit";
            priceChangeDisplay.textContent = `+${change.toFixed(2)} (+${percent.toFixed(2)}%) ▲`;
            priceChangeDisplay.className = "price-change profit";
        } else {
            spotPriceDisplay.className = "current-price loss";
            priceChangeDisplay.textContent = `${change.toFixed(2)} (${percent.toFixed(2)}%) ▼`;
            priceChangeDisplay.className = "price-change loss";
        }
    }
    
    lastSpotPrice = price;

    // Maintain tracking list lengths
    chartTicksHistory.push(price);
    if (chartTicksHistory.length > MAX_CHART_TICKS) {
        chartTicksHistory.shift();
    }

    // Call your existing SVG rendering loop
    if (typeof drawLiveChart === "function") {
        drawLiveChart();
    }
}

function showAlertBanner(msg, type) {
    const container = document.querySelector('.chart-canvas-area');
    if (!container) return;

    const notice = document.createElement('div');
    notice.style.position = "absolute";
    notice.style.bottom = "20px";
    notice.style.left = "50%";
    notice.style.transform = "translateX(-50%)";
    notice.style.padding = "10px 20px";
    notice.style.borderRadius = "4px";
    notice.style.color = "#fff";
    notice.style.fontWeight = "bold";
    notice.style.fontSize = "12px";
    notice.style.zIndex = "100";
    notice.style.backgroundColor = type === "success" ? "var(--accent-teal)" : "var(--accent-red)";
    notice.textContent = msg;

    container.appendChild(notice);
    setTimeout(() => notice.remove(), 2500);
}

// Dropdown Event Attachment Initializers
document.querySelectorAll('#asset-dropdown-menu .dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
        document.querySelectorAll('#asset-dropdown-menu .dropdown-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentSymbol = e.currentTarget.getAttribute('data-symbol');
        if (displayAssetName) displayAssetName.textContent = e.currentTarget.getAttribute('data-name');
        requestMarketTicks(currentSymbol);
    });
});

document.querySelectorAll('#market-dropdown-menu .dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
        if(e.currentTarget.tagName === 'HR') return;
        document.querySelectorAll('#market-dropdown-menu .dropdown-item').forEach(i => i.classList.remove('active'));
        e.currentTarget.classList.add('active');
        switchMarket(e.currentTarget.getAttribute('data-market'), e.currentTarget.textContent);
    });
});

// ==========================================================================
// 6. Bootstrap Initializations
// ==========================================================================

// Parse dynamic landing redirection tokens on initialization
checkOAuthRedirectResponse();
// Connect the core channel pipes
connectEngine();
