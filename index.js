/********************************************************************
 * index.js
 * OpenLedger Rewards Bot
 * update
 ********************************************************************/

import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import dotenv from 'dotenv';

import banner from './utils/banner.js';
import log from './utils/logger.js';

/********************************************************************
 * 1. .env (if the file exists)
 ********************************************************************/
dotenv.config();

/********************************************************************
 * 2. (Endpoint, files, etc.)
 ********************************************************************/
const API_ENDPOINT     = process.env.API_ENDPOINT     || 'https://apitn.openledger.xyz';
const REWARDS_ENDPOINT = process.env.REWARDS_ENDPOINT || 'https://rewardstn.openledger.xyz';
const WS_ENDPOINT      = process.env.WS_ENDPOINT      || 'wss://apitn.openledger.xyz/ws/v1';
const WALLETS_FILE     = process.env.WALLETS_FILE     || 'wallets.txt';
const PROXY_FILE       = process.env.PROXY_FILE       || 'proxy.txt';

// HTTP // (Headers) 
const headers = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A_Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

/********************************************************************
 * 3. Helper functions (reading a file, creating an agent, etc.)
 ********************************************************************/

function readFile(pathFile) {
  try {
    const data = fs.readFileSync(pathFile, 'utf8');
    return data
      .split('\n')
      .map(str => str.trim())
      .filter(str => str.length > 0);
  } catch (error) {
    log.error(`Error reading file: ${error.message}`);
    return [];
  }
}

/**
 * Creates an HTTPS or SOCKS agent if a proxy is specified
 * @param {string|null} proxy 
 * @returns {HttpsProxyAgent|SocksProxyAgent|null}
 */
function createAgent(proxy = null) {
  if (!proxy) return null;

  if (proxy.startsWith('http://') || proxy.startsWith('https://')) {
    return new HttpsProxyAgent(proxy);
  } else if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
    return new SocksProxyAgent(proxy);
  }
  return null;
}

/**
 * Generates a random Capacity value
 * @returns {Object}
 */
function generateRandomCapacity() {
  /**
   * The internal function is a random number with a certain accuracy
   */
  function getRandomFloat(min, max, decimals = 2) {
    return (Math.random() * (max - min) + min).toFixed(decimals);
  }

  return {
    AvailableMemory: parseFloat(getRandomFloat(10, 64)),
    AvailableStorage: parseFloat(getRandomFloat(10, 500)),
    AvailableGPU: '',
    AvailableModels: []
  };
}

/********************************************************************
 * 4. Setting up axiosRetry (retry in case of network errors)
 ********************************************************************/
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000, // Each subsequent attempt is one second longer
  retryCondition: (error) =>
    error.response?.status >= 400 || error.code === 'ECONNABORTED'
});

/********************************************************************
 * 5. Functions for working with the server (receiving a token, user information, etc.)
 ********************************************************************/

/**
 * Генерує токен для вказаної адреси
 * @param {Object} data { address: string }
 * @param {string|null} proxy
 * @returns {Promise<any|null>}
 */
async function generateToken(data, proxy) {
  try {
    const agent = createAgent(proxy);
    const response = await axios.post(`${API_ENDPOINT}/api/v1/auth/generate_token`, data, {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      httpsAgent: agent
    });
    return response.data.data; // { token: "...", ... }
  } catch (error) {
    log.error(`Error generating token: ${error.message}`);
    return null;
  }
}

/**
 * Receives information about the user (number of points)
 * @param {string} token 
 * @param {string|null} proxy 
 * @param {number} index 
 * @returns {Promise<any>}
 */
async function getUserInfo(token, proxy, index) {
  try {
    const agent = createAgent(proxy);
    const response = await axios.get(`${REWARDS_ENDPOINT}/api/v1/reward_realtime`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`
      },
      httpsAgent: agent
    });
    const { total_heartbeats } = response.data?.data?.[0] || { total_heartbeats: '0' };
    log.info(`Account ${index} has gained points today: ${total_heartbeats}`);
    return response.data.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      log.error(`Unauthorized (401): Token invalid/expired for account ${index}`);
      return 'unauthorized';
    }
    log.error(`Error fetching user info for account ${index}: ${error.message}`);
    return null;
  }
}

/**
 * Receives details about the opportunity to “claim” daily rewards
 * @param {string} token 
 * @param {string|null} proxy 
 * @param {number} index 
 * @returns {Promise<any>}
 */
async function getClaimDetails(token, proxy, index) {
  try {
    const agent = createAgent(proxy);
    const response = await axios.get(`${REWARDS_ENDPOINT}/api/v1/claim_details`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`
      },
      httpsAgent: agent
    });
    const { tier, dailyPoint, claimed, nextClaim = 'Not Claimed' } = response.data?.data || {};
    log.info(`Details for Account ${index}: tier=${tier}, dailyPoint=${dailyPoint}, claimed=${claimed}, nextClaim=${nextClaim}`);
    return response.data.data;
  } catch (error) {
    log.error(`Error fetching claim info for account ${index}: ${error.message}`);
    return null;
  }
}

/**
 * Causes an endpoint to receive (claim) rewards
 * @param {string} token 
 * @param {string|null} proxy 
 * @param {number} index 
 * @returns {Promise<any>}
 */
async function claimRewards(token, proxy, index) {
  try {
    const agent = createAgent(proxy);
    const response = await axios.get(`${REWARDS_ENDPOINT}/api/v1/claim_reward`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`
      },
      httpsAgent: agent
    });
    log.info(`Daily Rewards Claimed for Account ${index}: ${JSON.stringify(response.data.data)}`);
    return response.data.data;
  } catch (error) {
    log.error(`Error claiming daily reward for account ${index}: ${error.message}`);
    return null;
  }
}

/********************************************************************
 * 6. The WebSocketClient class - the logic of a WebSocket connection
 ********************************************************************/
class WebSocketClient {
  constructor(authToken, address, proxy, index) {
    this.address = address;
    this.authToken = authToken;
    this.proxy = proxy;
    this.index = index;

    // Generate unique values
    this.identity = btoa(address); // base64
    this.capacity = generateRandomCapacity();
    this.id = crypto.randomUUID();

    // Basic settings
    this.url = `${WS_ENDPOINT}/orch?authToken=${authToken}`;
    this.ws = null;
    this.intervalId = null;
    this.reconnect = true;
    this.registered = false;

    // Messages for heartbeat
    this.heartbeat = {
      message: {
        Worker: {
          Identity: this.identity,
          ownerAddress: this.address,
          type: "LWEXT",
          Host: "chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc"
        },
        Capacity: this.capacity
      },
      msgType: "HEARTBEAT",
      workerType: "LWEXT",
      workerID: this.identity
    };

    // Message for registration
    this.regWorkerID = {
      workerID: this.identity,
      msgType: "REGISTER",
      workerType: "LWEXT",
      message: {
        id: this.id,
        type: "REGISTER",
        worker: {
          host: "chrome-extension://ekbbplmjjgoobhdlffmgeokalelnmjjc",
          identity: this.identity,
          ownerAddress: this.address,
          type: "LWEXT"
        }
      }
    };
  }

  /**
   * Processing messages from a socket (JOB, other)
   * @param {object} message
   */
  loadJobData = (message) => {
    // If you receive a “JOB”
    if (message?.MsgType === "JOB") {
      this.ws.send(JSON.stringify({
        workerID: this.identity,
        msgType: "JOB_ASSIGNED",
        workerType: "LWEXT",
        message: {
          Status: true,
          Ref: message?.UUID
        }
      }));
    }
  }

  /**
   * Start a connection (event subscription and processing)
   */
  connect() {
    const agent = createAgent(this.proxy);
    const wsOptions = agent ? { agent } : {};

    this.ws = new WebSocket(this.url, wsOptions);

    this.ws.on('open', () => {
      log.info(`[#${this.index}] WebSocket connection established`);

      // We register (send data) only once
      if (!this.registered) {
        log.info(`[#${this.index}] Trying to register worker ID...`);
        this.sendMessage(this.regWorkerID);
        this.registered = true;
      }

      // We send heartbeats every 30 seconds
      this.intervalId = setInterval(() => {
        log.info(`[#${this.index}] Sending heartbeat...`);
        this.sendMessage(this.heartbeat);
      }, 30 * 1000);
    });

    this.ws.on('message', (rawData) => {
      try {
        const message = JSON.parse(rawData);
        log.info(`[#${this.index}] Received message: ${JSON.stringify(message)}`);

        // If it is “JOB” - call the handler
        if (message?.data?.MsgType === "JOB") {
          this.loadJobData(message.data);
        } else {
          // You can send a reply or take other actions
        }
      } catch (err) {
        log.error(`[#${this.index}] Error parsing WebSocket message: ${err.message}`);
      }
    });

    this.ws.on('error', (error) => {
      log.error(`[#${this.index}] WebSocket error: ${error.message}`);
    });

    this.ws.on('close', () => {
      clearInterval(this.intervalId);

      if (this.reconnect) {
        log.warn(`[#${this.index}] WebSocket closed, reconnecting in 5s...`);
        setTimeout(() => this.connect(), 5000);
      } else {
        log.warn(`[#${this.index}] WebSocket closed, no reconnect`);
      }
    });
  }

  /**
   * Securely send a message to a WebSocket
   * @param {any} message
   */
  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      log.error(`[#${this.index}] WebSocket not open, cannot send: ${JSON.stringify(message)}`);
    }
  }

  /**
   * Close the connection and stop reconnects
   */
  close() {
    if (this.ws) {
      this.reconnect = false;
      this.ws.close();
    }
  }
}

/********************************************************************
 * 7. Main logic - sequential processing of wallets
 ********************************************************************/
async function main() {
  // 1. Displaying the banner
  log.info(banner);

  // 2. Read the wallet and proxy
  const wallets = readFile(WALLETS_FILE);
  const proxies = readFile(PROXY_FILE);

  if (wallets.length === 0) {
    log.error('No wallets found in file!');
    return;
  }

  log.info(`Starting program for all accounts. Count: ${wallets.length}`);

  // 3. Go through each wallet (asynchronously)
  const accountsProcessing = wallets.map(async (address, idx) => {
    // Select a proxy (cyclically if the list of proxies is shorter)
    const proxy = proxies.length > 0 ? proxies[idx % proxies.length] : null;
    const accountIndex = idx + 1; // so that the account starts with 1

    log.info(`Account #${accountIndex} => Address: ${address} | Proxy: ${proxy || 'No proxy'}`);

    let isConnected = false;
    let userInfoInterval;
    let claimDetailsInterval;

    while (!isConnected) {
      try {
        // 1. Get the token
        let tokenResp = await generateToken({ address }, proxy);
        // Check until success (tokenResp?.token exists)
        while (!tokenResp || !tokenResp.token) {
          log.warn(`[#${accountIndex}] Retry generating token in 3s...`);
          await new Promise((res) => setTimeout(res, 3000));
          tokenResp = await generateToken({ address }, proxy);
        }
        const token = tokenResp.token;

        // 2. We withdraw part of the token (for security)
        const obfuscatedToken = token.slice(0, 36) + '...' + token.slice(-8);
        log.info(`[#${accountIndex}] Login success. token=${obfuscatedToken}`);

        // 3. Check daily rewards
        const claimDaily = await getClaimDetails(token, proxy, accountIndex);
        if (claimDaily && !claimDaily.claimed) {
          log.info(`[#${accountIndex}] Trying to claim daily rewards...`);
          await claimRewards(token, proxy, accountIndex);
        }

        // Print the number of points scored
        await getUserInfo(token, proxy, accountIndex);

        // 4. Create a WS client and connect
        const socket = new WebSocketClient(token, address, proxy, accountIndex);
        socket.connect();
        isConnected = true;

        // 5. Start the intervals:
        // a) We update information about points every 10 minutes
        userInfoInterval = setInterval(async () => {
          log.info(`[#${accountIndex}] Fetching total points...`);
          const userData = await getUserInfo(token, proxy, accountIndex);
          if (userData === 'unauthorized') {
            log.warn(`[#${accountIndex}] Token expired/invalid, need re-login...`);
            isConnected = false;
            socket.close();
            clearInterval(userInfoInterval);
            clearInterval(claimDetailsInterval);
          }
        }, 10 * 60 * 1000);

        // b) Every 60 minutes, we check to see if the reward can be reclaimed
        claimDetailsInterval = setInterval(async () => {
          try {
            log.info(`[#${accountIndex}] Checking daily rewards...`);
            const cDetails = await getClaimDetails(token, proxy, accountIndex);
            if (cDetails && !cDetails.claimed) {
              log.info(`[#${accountIndex}] Trying to claim daily rewards...`);
              await claimRewards(token, proxy, accountIndex);
            }
          } catch (err) {
            log.error(`[#${accountIndex}] Error in claim details: ${err.message}`);
          }
        }, 60 * 60 * 1000);

        /*******************************************************
         * Process termination handler (ctrl+c / kill, etc.)
         *******************************************************/
        process.on('SIGINT', () => {
          log.warn(`[#${accountIndex}] Received SIGINT. Exiting...`);
          clearInterval(userInfoInterval);
          clearInterval(claimDetailsInterval);
          socket.close();
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          log.warn(`[#${accountIndex}] Received SIGTERM. Exiting...`);
          clearInterval(userInfoInterval);
          clearInterval(claimDetailsInterval);
          socket.close();
          process.exit(0);
        });

      } catch (err) {
        log.error(`[#${accountIndex}] Main cycle error: ${err.message}`);
        isConnected = false;
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  });

  await Promise.all(accountsProcessing);
}

/********************************************************************
 * 8. Launching the main
 ********************************************************************/
main().catch(err => {
  log.error(`Main function error: ${err.message}`);
});
