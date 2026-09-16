/**
 * EIP-2771 Gasless Relayer for Arc EVM
 *
 * The frontend builds and signs an EIP-712 typed-data payload using the
 * user's wallet (zero gas cost for the user).  This route verifies the
 * signature, wraps it into a forwarder `execute()` call, and submits it
 * to the Arc network using a funded relayer wallet.
 *
 * Required env vars:
 *   RELAYER_PRIVATE_KEY      – private key of the gas-paying relayer wallet
 *   ARC_RPC_URL              – Arc EVM JSON-RPC endpoint
 *   TRUSTED_FORWARDER_ADDRESS – deployed ERC-2771 forwarder contract address
 *
 * EIP-712 domain expected from the frontend:
 *   name: "AtelierForwarder"
 *   version: "1"
 *   chainId: <Arc chain ID>
 *   verifyingContract: <TRUSTED_FORWARDER_ADDRESS>
 */

import { Router } from "express";
import { createWalletClient, createPublicClient, http, parseAbi, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const gaslessRouter = Router();

// Minimal ABI for the ERC-2771 MinimalForwarder execute function
const FORWARDER_ABI = parseAbi([
  "function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool, bytes)",
  "function getNonce(address from) view returns (uint256)",
  "function verify((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) view returns (bool)",
]);

// EIP-712 ForwardRequest type
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from",  type: "address" },
    { name: "to",   type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas",  type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

function getRelayerConfig() {
  const privateKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  const rpcUrl = process.env.ARC_RPC_URL?.trim();
  const forwarderAddress = process.env.TRUSTED_FORWARDER_ADDRESS?.trim() as `0x${string}` | undefined;

  if (!privateKey || !rpcUrl || !forwarderAddress) {
    throw new Error(
      "Gasless relayer is not fully configured. Set RELAYER_PRIVATE_KEY, ARC_RPC_URL, and TRUSTED_FORWARDER_ADDRESS in backend/.env",
    );
  }

  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);

  const transport = http(rpcUrl);
  const walletClient = createWalletClient({ account, transport });
  const publicClient = createPublicClient({ transport });

  return { account, walletClient, publicClient, forwarderAddress };
}

/**
 * POST /v1/gasless/apply
 *
 * Body (JSON):
 *   request   – ForwardRequest struct { from, to, value, gas, nonce, data }
 *   signature – EIP-712 signature (hex string) from the user's wallet
 *   chainId   – Arc chain ID (number) – used to build the EIP-712 domain
 *
 * Response:
 *   { txHash: string }
 */
gaslessRouter.post("/apply", async (req, res) => {
  try {
    const { request, signature, chainId } = req.body ?? {};

    // --- Input validation ---
    if (!request || typeof request !== "object") {
      res.status(400).json({ error: "request object is required" });
      return;
    }
    if (!signature || typeof signature !== "string") {
      res.status(400).json({ error: "signature (hex string) is required" });
      return;
    }
    if (!chainId || typeof chainId !== "number") {
      res.status(400).json({ error: "chainId (number) is required" });
      return;
    }

    const { from, to, value, gas, nonce, data } = request;
    if (!from || !to || value === undefined || gas === undefined || nonce === undefined || !data) {
      res.status(400).json({ error: "request must include: from, to, value, gas, nonce, data" });
      return;
    }

    const { account, walletClient, publicClient, forwarderAddress } = getRelayerConfig();

    // --- Build EIP-712 domain ---
    const domain = {
      name: "AtelierForwarder",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: forwarderAddress,
    } as const;

    // --- Verify the user's signature matches the claimed `from` address ---
    const typedRequest = {
      from: from as `0x${string}`,
      to: to as `0x${string}`,
      value: BigInt(value),
      gas: BigInt(gas),
      nonce: BigInt(nonce),
      data: data as `0x${string}`,
    };

    const recoveredAddress = await recoverTypedDataAddress({
      domain,
      types: FORWARD_REQUEST_TYPES,
      primaryType: "ForwardRequest",
      message: typedRequest,
      signature: signature as `0x${string}`,
    });

    if (recoveredAddress.toLowerCase() !== String(from).toLowerCase()) {
      res.status(400).json({ error: "Signature does not match the `from` address" });
      return;
    }

    // --- Verify the on-chain nonce matches to prevent replay attacks ---
    const onChainNonce = await publicClient.readContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: "getNonce",
      args: [from as `0x${string}`],
    });

    if (onChainNonce !== BigInt(nonce)) {
      res.status(400).json({ error: `Nonce mismatch. Expected ${onChainNonce}, got ${nonce}` });
      return;
    }

    // --- On-chain verification via the forwarder contract ---
    const isValid = await publicClient.readContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: "verify",
      args: [typedRequest, signature as `0x${string}`],
    });

    if (!isValid) {
      res.status(400).json({ error: "Forwarder rejected the signature" });
      return;
    }

    // --- Submit the meta-transaction via the relayer wallet ---
    const txHash = await walletClient.writeContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: "execute",
      args: [typedRequest, signature as `0x${string}`],
      account,
      chain: null, // viem infers from the transport
    });

    console.info(`[gasless] Relayed tx ${txHash} for ${from}`);
    res.json({ txHash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gasless relay failed";
    console.error("[gasless]", msg);
    // Don't leak internal config errors to the client
    if (msg.includes("not fully configured")) {
      res.status(503).json({ error: "Gasless transactions are not yet enabled on this deployment." });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

/**
 * GET /v1/gasless/nonce/:address
 * Returns the current on-chain nonce for a given address from the forwarder.
 */
gaslessRouter.get("/nonce/:address", async (req, res) => {
  try {
    const { publicClient, forwarderAddress } = getRelayerConfig();
    const address = req.params.address as `0x${string}`;
    const nonce = await publicClient.readContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: "getNonce",
      args: [address],
    });
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch nonce";
    res.status(500).json({ error: msg });
  }
});
