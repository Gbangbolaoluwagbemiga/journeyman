/**
 * Proving an email belongs to the person claiming it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HOLE THIS CLOSES
 *
 * The first version of the managed-worker door took an email as a plain string
 * and looked up the account. That is not authentication, it is a directory: a
 * worker id grants the right to WITHDRAW, so anyone who knew a freelancer's
 * email address could take their money. It shipped, and it was wrong.
 *
 * An email is now only ever accepted inside a token Google signed. The claim
 * "I am ada@example.com" is verified against Google's public keys before it is
 * allowed to select a wallet — the client never gets to assert an identity, it
 * can only present evidence of one.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";

/** Google's rotating signing keys. Cached and refreshed by jose itself. */
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export class AuthError extends Error {}

export interface VerifiedIdentity {
  /** Lowercased, and verified — not whatever the client typed. */
  email: string;
  /** Google's stable user id. Survives an email change; the email may not. */
  subject: string;
  name?: string;
}

/**
 * Verify a Google ID token and return the identity inside it.
 *
 * Checks, in order, because each one is a way in if skipped:
 *   - the signature, against Google's published keys
 *   - the issuer, so a token from somewhere else cannot be replayed here
 *   - the audience, so a token minted for a DIFFERENT app cannot be used
 *     against ours — this is the check people leave out, and it turns any
 *     Google-signed token on the internet into a valid login
 *   - email_verified, because an unverified Google address proves nothing about
 *     who controls the mailbox
 *
 * Expiry is enforced by jwtVerify.
 */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<VerifiedIdentity> {
  if (!config.googleClientId) {
    throw new AuthError(
      "Sign-in is not configured on this server (GOOGLE_CLIENT_ID is unset).",
    );
  }
  if (!idToken || typeof idToken !== "string") {
    throw new AuthError("No sign-in token was provided.");
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: config.googleClientId,
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    // Deliberately not echoing the library's reason. "Signature invalid" versus
    // "expired" versus "wrong audience" is a useful oracle for someone probing,
    // and useless to the person who just needs to press the button again.
    throw new AuthError("That sign-in could not be verified. Please try again.");
  }

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new AuthError("That Google account has no email address on it.");

  if (payload.email_verified !== true) {
    throw new AuthError(
      "That Google account's email is not verified, so it cannot be used to hold a wallet.",
    );
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!subject) throw new AuthError("That sign-in token is missing a subject.");

  return {
    email,
    subject,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}
