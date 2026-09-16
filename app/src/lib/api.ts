/** Local Atelier API default when VITE_API_URL is omitted (dev only). */
const DEFAULT_DEV_API_URL = "http://localhost:8787";

function getApiBase(): string {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  const trimmed = raw?.trim().replace(/\/$/, "") ?? "";
  if (trimmed) return trimmed;
  if (import.meta.env.DEV) return DEFAULT_DEV_API_URL;
  return "";
}

const apiSecret = () =>
  (import.meta.env.VITE_API_SECRET as string | undefined) ?? "";

function authHeaders(): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = apiSecret();
  if (secret) {
    h.Authorization = `Bearer ${secret}`;
  }
  return h;
}

export function isApiConfigured(): boolean {
  return Boolean(getApiBase());
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new Error("VITE_API_URL is not set (required for production builds)");
  }
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const errBody = await res.text();
    let message = res.statusText;
    try {
      const j = JSON.parse(errBody) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      if (errBody) message = errBody;
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function postMilestoneSuggestions(body: {
  projectTitle: string;
  projectDescription: string;
  totalBudget: string;
  durationDays: string;
  userPrompt: string;
  milestoneIndex: number | null;
}): Promise<{ suggestions: string[] }> {
  return apiFetch("/v1/ai/milestones", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function postCoverLetterDraft(body: {
  jobTitle: string;
  jobDescription: string;
  proposedTimelineDays?: string;
  tone?: string;
  /** If provided the AI will enhance this draft rather than write from scratch */
  userDraft?: string;
}): Promise<{ coverLetter: string }> {
  return apiFetch("/v1/ai/cover-letter", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function postRewriteText(body: { text: string }): Promise<{
  text: string;
}> {
  return apiFetch("/v1/ai/rewrite", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Submit a user-signed EIP-2771 meta-transaction to the backend relayer.
 * The relayer wraps it in a `MinimalForwarder.execute()` call and pays gas.
 * Used for gasless operations such as job applications on Arc.
 */
export async function submitGaslessTransaction(body: {
  request: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    data: string;
  };
  signature: string;
  chainId: number;
}): Promise<{ txHash: string }> {
  return apiFetch("/v1/gasless/apply", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type RemoteNotificationRow = {
  id: string;
  type:
    | "milestone"
    | "dispute"
    | "escrow"
    | "application"
    | "message"
    | "rating";
  title: string;
  message: string;
  read: boolean;
  timestamp: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
};

export async function getNotifications(wallet: string): Promise<
  RemoteNotificationRow[]
> {
  const q = new URLSearchParams({ wallet });
  const json = await apiFetch<{ notifications: RemoteNotificationRow[] }>(
    `/v1/notifications?${q.toString()}`,
    { method: "GET" },
  );
  return json.notifications ?? [];
}

export async function patchNotificationRead(
  wallet: string,
  id: string,
): Promise<void> {
  const q = new URLSearchParams({ wallet });
  await apiFetch(`/v1/notifications/${encodeURIComponent(id)}/read?${q.toString()}`, {
    method: "PATCH",
  });
}

export async function postNotification(body: {
  wallet_address: string;
  type:
    | "milestone"
    | "dispute"
    | "escrow"
    | "application"
    | "message"
    | "rating";
  title: string;
  message: string;
  action_url?: string;
  data?: Record<string, unknown>;
}): Promise<{ id: string }> {
  return apiFetch("/v1/notifications", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Messaging ──────────────────────────────────────────────────────────────

export type ChatMessage = {
  id: string;
  sender_address: string;
  recipient_address: string;
  content: string;
  read_at: string | null;
  created_at: string;
};

export type Conversation = {
  conversation_id: string;
  other_address: string;
  latest_message: string;
  latest_at: string;
  unread: number;
};

export async function sendMessage(body: {
  sender_address: string;
  recipient_address: string;
  content: string;
}): Promise<{ id: string; created_at: string }> {
  return apiFetch("/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getConversation(
  a: string,
  b: string,
  since?: string,
): Promise<ChatMessage[]> {
  const q = new URLSearchParams({ a, b });
  if (since) q.set("since", since);
  const json = await apiFetch<{ messages: ChatMessage[] }>(
    `/v1/messages/conversation?${q.toString()}`,
    { method: "GET" },
  );
  return json.messages ?? [];
}

export async function getInbox(wallet: string): Promise<Conversation[]> {
  const q = new URLSearchParams({ wallet });
  const json = await apiFetch<{ conversations: Conversation[] }>(
    `/v1/messages/inbox?${q.toString()}`,
    { method: "GET" },
  );
  return json.conversations ?? [];
}

export async function getUnreadMessageCount(wallet: string): Promise<number> {
  const q = new URLSearchParams({ wallet });
  const json = await apiFetch<{ count: number }>(
    `/v1/messages/unread-count?${q.toString()}`,
    { method: "GET" },
  );
  return json.count ?? 0;
}

export async function markConversationRead(
  a: string,
  b: string,
  wallet: string,
): Promise<void> {
  const q = new URLSearchParams({ a, b, wallet });
  await apiFetch(`/v1/messages/conversation/read?${q.toString()}`, {
    method: "PATCH",
  });
}

export const notificationIdIsRemote = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );

export type UploadedFile = {
  url: string;
  filename: string;
  size: number;
  mimeType: string;
};

/**
 * Must produce byte-identical output to `buildUploadAuthMessage` in
 * backend/src/routes/upload.ts — the backend verifies this exact string
 * against the wallet signature to authorize the upload.
 */
export function buildUploadAuthMessage(
  escrowId: string | number,
  milestoneIndex: number,
  walletAddress: string,
  timestamp: number,
): string {
  return [
    "Atelier file upload authorization",
    `Escrow: ${escrowId}`,
    `Milestone: ${milestoneIndex}`,
    `Wallet: ${walletAddress.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

export interface UploadAuth {
  address: string;
  message: string;
  signature: string;
  timestamp: string;
}

/**
 * Upload a deliverable using an authorisation somebody else produced.
 *
 * A managed freelancer holds no key, so they cannot sign in the browser — and
 * the backend rightly refuses an upload without a signature from the escrow's
 * beneficiary. The daemon signs on their instruction with the Circle wallet it
 * already holds for them, and this posts the file with that signature attached.
 *
 * The backend's rule does not change and is not softened: it still verifies a
 * real EIP-191 signature from the real beneficiary, over this escrow, this
 * milestone and a timestamp that expires. Only the hand holding the pen differs.
 */
export async function uploadMilestoneFileWithAuth(
  file: File,
  escrowId: string | number,
  milestoneIndex: number,
  auth: UploadAuth,
): Promise<UploadedFile> {
  const base = getApiBase();
  if (!base) throw new Error("VITE_API_URL is not set");

  const form = new FormData();
  form.append("file", file);
  form.append("escrow_id", String(escrowId));
  form.append("milestone_index", String(milestoneIndex));
  form.append("wallet_address", auth.address);
  form.append("signature", auth.signature);
  form.append("timestamp", auth.timestamp);

  const secret = apiSecret();
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const res = await fetch(`${base}/v1/upload/milestone`, { method: "POST", body: form, headers });

  if (!res.ok) {
    const errBody = await res.text();
    let message = res.statusText;
    try {
      const j = JSON.parse(errBody) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      if (errBody) message = errBody;
    }
    throw new Error(message);
  }

  return res.json() as Promise<UploadedFile>;
}

export async function uploadMilestoneFile(
  file: File,
  escrowId: string | number,
  milestoneIndex: number,
  walletAddress: string,
  signMessageAsync: (args: { message: string }) => Promise<string>,
): Promise<UploadedFile> {
  const base = getApiBase();
  if (!base) throw new Error("VITE_API_URL is not set");

  const timestamp = Date.now();
  const message = buildUploadAuthMessage(escrowId, milestoneIndex, walletAddress, timestamp);
  const signature = await signMessageAsync({ message });

  const form = new FormData();
  form.append("file", file);
  form.append("escrow_id", String(escrowId));
  form.append("milestone_index", String(milestoneIndex));
  form.append("wallet_address", walletAddress);
  form.append("signature", signature);
  form.append("timestamp", String(timestamp));

  const secret = apiSecret();
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const res = await fetch(`${base}/v1/upload/milestone`, {
    method: "POST",
    body: form,
    headers,
  });

  if (!res.ok) {
    const errBody = await res.text();
    let message = res.statusText;
    try {
      const j = JSON.parse(errBody) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      if (errBody) message = errBody;
    }
    throw new Error(message);
  }

  return res.json() as Promise<UploadedFile>;
}

/* ── An arbiter's reasoning, where both sides can read it ─────────────────── */

export interface DisputeResolutionNote {
  milestone_index: number;
  arbiter_address: string;
  reason: string;
  /** The split, copied from the event so reading it never needs a log scan. */
  freelancer_amount?: number | null;
  client_amount?: number | null;
  resolved_at: string;
}

/**
 * Must produce byte-identical output to `buildResolutionAuthMessage` in
 * backend/src/routes/disputes.ts — the backend verifies this exact string.
 */
export function buildResolutionAuthMessage(
  escrowId: string | number,
  milestoneIndex: string | number,
  arbiter: string,
  timestamp: string | number,
): string {
  return [
    "Atelier dispute resolution note",
    `Escrow: ${escrowId}`,
    `Milestone: ${milestoneIndex}`,
    `Arbiter: ${arbiter.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

/**
 * Record why a dispute was settled, so the other side can read it.
 *
 * The reason used to live in localStorage on the resolver's own machine, and
 * the contract's DisputeResolved event carries the amounts but not the words —
 * so the freelancer whose payment it decided could never see it, anywhere.
 *
 * Signed, and the backend additionally checks the signer is the arbiter named
 * in the on-chain event for that milestone. Without that, the reasoning behind
 * somebody else's payment would be a thing strangers could author.
 */
export async function saveDisputeResolutionNote(input: {
  escrowId: string | number;
  milestoneIndex: number;
  arbiter: string;
  reason: string;
  /** What each side received, so the record does not depend on a log scan. */
  freelancerAmount?: number;
  clientAmount?: number;
  signMessageAsync: (args: { message: string }) => Promise<string>;
}): Promise<void> {
  const base = getApiBase();
  if (!base) throw new Error("VITE_API_URL is not set");

  const timestamp = Date.now();
  const message = buildResolutionAuthMessage(
    input.escrowId,
    input.milestoneIndex,
    input.arbiter,
    timestamp,
  );
  const signature = await input.signMessageAsync({ message });

  const secret = apiSecret();
  const res = await fetch(`${base}/v1/disputes/resolution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      escrow_id: String(input.escrowId),
      milestone_index: String(input.milestoneIndex),
      arbiter_address: input.arbiter,
      reason: input.reason,
      freelancer_amount: input.freelancerAmount,
      client_amount: input.clientAmount,
      signature,
      timestamp: String(timestamp),
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not save the resolution note (${res.status})`);
  }
}

/** Every recorded reason for one escrow. Empty when none were written. */
export async function fetchDisputeResolutionNotes(
  escrowId: string | number,
): Promise<DisputeResolutionNote[]> {
  const base = getApiBase();
  if (!base) return [];

  const secret = apiSecret();
  const res = await fetch(
    `${base}/v1/disputes/resolution?escrow_id=${encodeURIComponent(String(escrowId))}`,
    { headers: secret ? { Authorization: `Bearer ${secret}` } : {} },
  );
  if (!res.ok) return [];

  const body = (await res.json().catch(() => ({}))) as { resolutions?: DisputeResolutionNote[] };
  return body.resolutions ?? [];
}
