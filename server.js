/**
 * x402 Testnet Server — Base Sepolia
 * 
 * Provides x402-compliant endpoints for integration partners to test
 * agent wallet → x402 payment flows on Base Sepolia testnet.
 * 
 * Endpoints:
 *   GET  /health           — Health check
 *   GET  /info             — Server info + supported chains
 *   GET  /x402/echo        — x402-protected echo (returns 402, accepts USDC payment)
 *   POST /x402/echo        — Submit payment proof + get response
 *   GET  /x402/gas-price   — x402-protected gas price feed (0.001 USDC)
 *   GET  /x402/agent-score — x402-protected agent reputation score (0.005 USDC)
 *   POST /x402/verify      — Verify a payment receipt
 * 
 * Network: Base Sepolia (chainId: 84532)
 * USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */

const express = require('express');
const cors = require('cors');
const { createPublicClient, http, formatUnits, parseUnits } = require('viem');
const { baseSepolia } = require('viem/chains');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3402;
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532;
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS || '0x0000000000000000000000000000000000000001';
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

// Viem client for Base Sepolia
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC),
});

// Payment receipt store (in-memory for testnet)
const receipts = new Map();

// ─── x402 Payment Header Builder ──────────────────────────────────────────────

function buildX402Headers(price, description) {
  const paymentRequirements = {
    scheme: 'exact',
    network: 'base-sepolia',
    chainId: CHAIN_ID,
    asset: USDC_ADDRESS,
    amount: String(parseUnits(String(price), 6)), // USDC has 6 decimals
    receiver: RECEIVER_ADDRESS,
    description: description || 'x402 testnet payment',
    mimeType: 'application/json',
    outputSchema: null,
    extra: {
      name: 'AgentWallet x402 Testnet',
      version: '1.0.0',
    },
  };

  // Encode as base64 to avoid invalid header chars
  const encoded = Buffer.from(JSON.stringify(paymentRequirements)).toString('base64');
  return {
    'X-Payment-Requirements': encoded,
    'Content-Type': 'application/json',
    paymentRequirements, // raw object for JSON body
  };
}

// ─── x402 Payment Verification ────────────────────────────────────────────────

async function verifyPayment(paymentHeader) {
  try {
    const payment = typeof paymentHeader === 'string' ? JSON.parse(paymentHeader) : paymentHeader;
    
    // For testnet, we accept any well-formed payment proof
    // In production, this would verify the on-chain USDC transfer
    if (!payment.txHash && !payment.signature && !payment.permit) {
      return { valid: false, reason: 'Missing txHash, signature, or permit in payment proof' };
    }

    // If txHash provided, verify on-chain
    if (payment.txHash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: payment.txHash });
        if (receipt.status === 'success') {
          return { valid: true, txHash: payment.txHash, blockNumber: Number(receipt.blockNumber) };
        }
        return { valid: false, reason: 'Transaction reverted' };
      } catch (e) {
        // For testnet, if tx not found yet, accept it optimistically
        return { valid: true, txHash: payment.txHash, note: 'Optimistic acceptance (testnet)' };
      }
    }

    // Accept permit-based payments (testnet mode)
    if (payment.permit || payment.signature) {
      return { valid: true, note: 'Permit/signature accepted (testnet mode)' };
    }

    return { valid: false, reason: 'Invalid payment format' };
  } catch (e) {
    return { valid: false, reason: `Parse error: ${e.message}` };
  }
}

// ─── Middleware: x402 gate ─────────────────────────────────────────────────────

function x402Gate(price, description) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-payment'] || req.headers['x-payment-response'];
    
    if (!paymentHeader) {
      // Return 402 with payment requirements
      const { paymentRequirements, ...headerFields } = buildX402Headers(price, description);
      res.set(headerFields);
      return res.status(402).json({
        status: 402,
        message: 'Payment Required',
        paymentRequirements,
      });
    }

    // Verify payment
    const verification = await verifyPayment(paymentHeader);
    if (!verification.valid) {
      const { paymentRequirements } = buildX402Headers(price, description);
      return res.status(402).json({
        status: 402,
        message: 'Payment verification failed',
        reason: verification.reason,
        paymentRequirements,
      });
    }

    // Store receipt
    const receiptId = `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    receipts.set(receiptId, {
      ...verification,
      price,
      description,
      timestamp: new Date().toISOString(),
      endpoint: req.path,
    });

    req.paymentReceipt = { receiptId, ...verification };
    next();
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check (free)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    network: 'base-sepolia',
    chainId: CHAIN_ID,
    usdc: USDC_ADDRESS,
    timestamp: new Date().toISOString(),
  });
});

// Server info (free)
app.get('/info', (req, res) => {
  res.json({
    name: 'AgentWallet x402 Testnet Server',
    version: '1.0.0',
    description: 'Base Sepolia x402 test endpoints for integration partners',
    network: 'base-sepolia',
    chainId: CHAIN_ID,
    usdc: USDC_ADDRESS,
    receiver: RECEIVER_ADDRESS,
    endpoints: [
      { path: '/x402/echo', method: 'GET', price: '0.01 USDC', description: 'Echo service — returns your payment proof' },
      { path: '/x402/gas-price', method: 'GET', price: '0.001 USDC', description: 'Current Base Sepolia gas price' },
      { path: '/x402/agent-score', method: 'GET', price: '0.005 USDC', description: 'Agent reputation score (mock)' },
    ],
    docs: 'https://github.com/up2itnow0822/agent-wallet-sdk',
    npm: 'https://www.npmjs.com/package/agentwallet-sdk',
  });
});

// x402-protected: Echo (0.01 USDC)
app.get('/x402/echo', x402Gate(0.01, 'Echo service — test your x402 payment flow'), (req, res) => {
  res.json({
    message: 'Payment received! x402 flow working correctly.',
    receipt: req.paymentReceipt,
    echo: {
      yourHeaders: req.headers,
      timestamp: new Date().toISOString(),
    },
  });
});

// x402-protected: Gas Price (0.001 USDC)
app.get('/x402/gas-price', x402Gate(0.001, 'Base Sepolia gas price feed'), async (req, res) => {
  try {
    const gasPrice = await client.getGasPrice();
    const block = await client.getBlockNumber();
    res.json({
      receipt: req.paymentReceipt,
      data: {
        network: 'base-sepolia',
        chainId: CHAIN_ID,
        gasPrice: gasPrice.toString(),
        gasPriceGwei: formatUnits(gasPrice, 9),
        blockNumber: Number(block),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    res.json({
      receipt: req.paymentReceipt,
      data: {
        network: 'base-sepolia',
        gasPrice: '1000000', // fallback
        gasPriceGwei: '0.001',
        note: 'Fallback value — RPC error',
        timestamp: new Date().toISOString(),
      },
    });
  }
});

// x402-protected: Agent Reputation Score (0.005 USDC)
app.get('/x402/agent-score', x402Gate(0.005, 'Agent reputation score'), (req, res) => {
  const agentAddress = req.query.agent || '0x0000000000000000000000000000000000000000';
  // Deterministic mock score based on address
  const hash = agentAddress.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const score = ((hash % 80) + 20) / 100; // 0.20 to 1.00

  res.json({
    receipt: req.paymentReceipt,
    data: {
      agent: agentAddress,
      reputationScore: score,
      tier: score > 0.8 ? 'trusted' : score > 0.5 ? 'verified' : 'new',
      totalTransactions: Math.floor(hash % 500),
      network: 'base-sepolia',
      timestamp: new Date().toISOString(),
    },
  });
});

// Verify a receipt (free)
app.post('/x402/verify', (req, res) => {
  const { receiptId, txHash } = req.body;
  
  if (receiptId && receipts.has(receiptId)) {
    return res.json({ valid: true, receipt: receipts.get(receiptId) });
  }
  
  // Search by txHash
  if (txHash) {
    for (const [id, r] of receipts) {
      if (r.txHash === txHash) {
        return res.json({ valid: true, receipt: r });
      }
    }
  }

  res.json({ valid: false, reason: 'Receipt not found' });
});

// Faucet info (free — helpful for testers)
app.get('/faucet', (req, res) => {
  res.json({
    message: 'Get Base Sepolia testnet tokens here:',
    eth: [
      'https://www.coinbase.com/faucets/base-ethereum-goerli-faucet',
      'https://faucet.quicknode.com/base/sepolia',
    ],
    usdc: 'Mint test USDC by calling the faucet function on 0x036CbD53842c5426634e7929541eC2318f3dCF7e (if available), or use the Coinbase USDC faucet',
    docs: 'https://docs.base.org/docs/tools/network-faucets/',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Export for Vercel serverless
module.exports = app;

// Only listen when run directly (not imported)
if (require.main === module) {
app.listen(PORT, () => {
  console.log(`\n🔥 x402 Testnet Server running on port ${PORT}`);
  console.log(`   Network: Base Sepolia (chainId: ${CHAIN_ID})`);
  console.log(`   USDC: ${USDC_ADDRESS}`);
  console.log(`   Receiver: ${RECEIVER_ADDRESS}`);
  console.log(`\n   Endpoints:`);
  console.log(`   GET  /health            — Health check (free)`);
  console.log(`   GET  /info              — Server info (free)`);
  console.log(`   GET  /x402/echo         — Echo test (0.01 USDC)`);
  console.log(`   GET  /x402/gas-price    — Gas price feed (0.001 USDC)`);
  console.log(`   GET  /x402/agent-score  — Agent reputation (0.005 USDC)`);
  console.log(`   POST /x402/verify       — Verify receipt (free)`);
  console.log(`   GET  /faucet            — Testnet faucet links (free)\n`);
});
}
