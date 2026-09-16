/**
 * Evidence Room route
 *
 * Accepts a file upload, pins it to IPFS via the Pinata API, then returns
 * the IPFS CID.  The frontend is responsible for calling the on-chain
 * `submitEvidence(escrowId, cid)` function so the CID is permanently
 * anchored in contract event logs.
 *
 * Required env vars:
 *   PINATA_JWT   – Pinata API JWT (Bearer token)
 */

import { Router } from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";

export const evidenceRouter = Router();

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
  "video/mp4",
  "video/webm",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed for evidence`));
    }
  },
});

/**
 * POST /v1/evidence/upload
 *
 * Body (multipart/form-data):
 *   file           – the evidence file
 *   escrow_id      – the escrow ID (used as Pinata group metadata)
 *   milestone_index – the milestone index (used as metadata)
 *   submitter      – the submitter's wallet address (stored as metadata)
 *
 * Response:
 *   { cid: string, url: string, filename: string, size: number }
 */
evidenceRouter.post("/upload", upload.single("file"), async (req, res) => {
  const pinataJwt = process.env.PINATA_JWT?.trim();
  if (!pinataJwt) {
    res.status(503).json({ error: "IPFS storage not configured (PINATA_JWT missing)" });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  const escrowId = String(req.body.escrow_id ?? "unknown");
  const milestoneIndex = String(req.body.milestone_index ?? "0");
  const submitter = String(req.body.submitter ?? "unknown");

  // Build multipart form for Pinata
  const form = new FormData();
  form.append("file", file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype,
  });

  // Pinata metadata – stored alongside the file, queryable later
  const metadata = JSON.stringify({
    name: `atelier-evidence-${escrowId}-${milestoneIndex}-${Date.now()}`,
    keyvalues: {
      escrowId,
      milestoneIndex,
      submitter,
      uploadedAt: new Date().toISOString(),
    },
  });
  form.append("pinataMetadata", metadata);

  const options = JSON.stringify({ cidVersion: 1 });
  form.append("pinataOptions", options);

  try {
    const pinataRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pinataJwt}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!pinataRes.ok) {
      const errBody = await pinataRes.text();
      console.error("[evidence] Pinata error:", errBody);
      res.status(502).json({ error: "Failed to pin file to IPFS", detail: errBody });
      return;
    }

    const pinataData = (await pinataRes.json()) as { IpfsHash: string; PinSize: number };
    const cid = pinataData.IpfsHash;

    res.status(201).json({
      cid,
      // Cloudflare IPFS gateway – fast and does not require a local node
      url: `https://cloudflare-ipfs.com/ipfs/${cid}`,
      filename: file.originalname,
      size: file.size,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "IPFS upload failed";
    console.error("[evidence]", msg);
    res.status(500).json({ error: msg });
  }
});
