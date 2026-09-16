import { Router } from "express";
import multer from "multer";
import { createPublicClient, http, verifyMessage } from "viem";
import { getSupabase } from "../lib/supabase.js";
import { attempt, isUnreachable } from "../lib/degrade.js";

export const uploadRouter = Router();

const BUCKET = "milestone-attachments";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  },
});

// ── Per-wallet upload authorization ─────────────────────────────────────────
// Closes the gap where the shared static API secret (extractable from the
// frontend bundle) was the only auth — anyone holding it could upload onto
// any job's milestone slot. Now the caller must also sign a message with the
// wallet they claim to be, and — once a job has a real assigned freelancer —
// that wallet must actually be the depositor or beneficiary of the escrow.
// Jobs still open for applications (no beneficiary yet) accept any signed
// wallet, since anyone is allowed to apply and attach a portfolio file.
const ARC_RPC_URL = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}` | undefined;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UPLOAD_AUTH_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const publicClient = createPublicClient({ transport: http(ARC_RPC_URL) });

const GET_ESCROW_ABI = [
  {
    inputs: [{ name: "escrowId", type: "uint256" }],
    name: "getEscrow",
    outputs: [
      {
        components: [
          { name: "depositor", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "token", type: "address" },
          { name: "totalAmount", type: "uint256" },
          { name: "paidAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "workStarted", type: "bool" },
          { name: "platformFee", type: "uint256" },
          { name: "arbiters", type: "address[]" },
          { name: "requiredConfirmations", type: "uint256" },
          { name: "isOpenJob", type: "bool" },
          { name: "projectTitle", type: "string" },
          { name: "projectDescription", type: "string" },
        ],
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function buildUploadAuthMessage(
  escrowId: string,
  milestoneIndex: string,
  walletAddress: string,
  timestamp: string,
): string {
  return [
    "Atelier file upload authorization",
    `Escrow: ${escrowId}`,
    `Milestone: ${milestoneIndex}`,
    `Wallet: ${walletAddress.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

uploadRouter.post(
  "/milestone",
  upload.single("file"),
  async (req, res) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ error: "Storage not configured" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const escrowId = String(req.body.escrow_id ?? "");
    const milestoneIndex = String(req.body.milestone_index ?? "0");
    const walletAddress = String(req.body.wallet_address ?? "");
    const signature = String(req.body.signature ?? "");
    const timestamp = String(req.body.timestamp ?? "");

    if (!/^\d+$/.test(escrowId)) {
      res.status(400).json({ error: "escrow_id must be a valid numeric escrow ID" });
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: "wallet_address must be a valid Arc EVM address (0x…)" });
      return;
    }
    if (!signature || !timestamp) {
      res.status(400).json({ error: "signature and timestamp are required" });
      return;
    }
    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > UPLOAD_AUTH_MAX_AGE_MS) {
      res.status(401).json({ error: "Upload authorization expired — please retry" });
      return;
    }

    const message = buildUploadAuthMessage(escrowId, milestoneIndex, walletAddress, timestamp);
    const signatureValid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    }).catch(() => false);
    if (!signatureValid) {
      res.status(401).json({ error: "Invalid upload signature" });
      return;
    }

    if (CONTRACT_ADDRESS) {
      try {
        const escrow = await publicClient.readContract({
          address: CONTRACT_ADDRESS,
          abi: GET_ESCROW_ABI,
          functionName: "getEscrow",
          args: [BigInt(escrowId)],
        });
        const depositor = escrow.depositor.toLowerCase();
        const beneficiary = escrow.beneficiary.toLowerCase();
        const isAssigned = beneficiary !== ZERO_ADDRESS;
        const caller = walletAddress.toLowerCase();
        if (isAssigned && caller !== depositor && caller !== beneficiary) {
          res.status(403).json({ error: "You are not a party to this escrow" });
          return;
        }
      } catch {
        res.status(400).json({ error: "Could not verify escrow — check escrow_id" });
        return;
      }
    }

    const ext = file.originalname.split(".").pop() ?? "bin";
    const path = `${escrowId}/${milestoneIndex}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${ext}`;

    // Ensure bucket exists (idempotent – ignore "already exists" errors)
    await attempt(
      supabase.storage.createBucket(BUCKET, {
        public: true,
        allowedMimeTypes: Array.from(ALLOWED_MIME_TYPES),
        fileSizeLimit: MAX_FILE_SIZE,
      }),
    );

    /*
     * There is no degrading a file upload. If the store is gone the bytes have
     * nowhere to live, and telling the freelancer their deliverable is attached
     * when it is not would be the worst of the three answers available.
     */
    const { error: uploadError } = await attempt(
      supabase.storage.from(BUCKET).upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true, // upsert=true avoids duplicate-key errors on retry
      }),
    );

    if (uploadError) {
      const hint =
        uploadError.message.includes("row-level security") ||
        uploadError.message.includes("violates")
          ? " — ensure the Supabase storage RLS policy allows inserts, or use the service_role key"
          : "";
      res.status(isUnreachable(uploadError) ? 503 : 500).json({ error: uploadError.message + hint });
      return;
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(BUCKET).getPublicUrl(path);

    res.status(201).json({
      url: publicUrl,
      filename: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });
  },
);
