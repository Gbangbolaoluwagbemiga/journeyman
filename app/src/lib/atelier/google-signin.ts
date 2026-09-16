/**
 * Google Sign-In, loaded on demand.
 *
 * The only thing the browser is trusted to do here is obtain a token and hand
 * it over. It never tells the server who the user is — the server reads that
 * out of Google's signature. Which means nothing in this file is a security
 * boundary, and it should not be written as though it were.
 *
 * The script is loaded lazily rather than in index.html because most people
 * never touch this page, and a third-party script on every route is a cost
 * paid by everyone for a feature used by some.
 */

export const GOOGLE_CLIENT_ID = (
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ""
).trim();

export const GOOGLE_SIGNIN_AVAILABLE = GOOGLE_CLIENT_ID.length > 0;

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleAccounts {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (r: GoogleCredentialResponse) => void;
        auto_select?: boolean;
challenge?: string;
      }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
      prompt: () => void;
      cancel: () => void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleAccounts;
  }
}

let loading: Promise<void> | null = null;

/** Load Google's script once, however many times this is called. */
export function loadGoogleScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load Google sign-in. Check your connection."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Render Google's own button into `el` and resolve with an ID token when
 * somebody signs in.
 *
 * Google's rendered button rather than a styled one of our own: their branding
 * rules require it, and a hand-rolled "Sign in with Google" that posts to their
 * endpoint is exactly what a phishing page looks like. Matching the real thing
 * is the point.
 */
export async function renderGoogleButton(
  el: HTMLElement,
  onToken: (idToken: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  if (!GOOGLE_SIGNIN_AVAILABLE) {
    onError("Google sign-in is not configured for this deployment.");
    return;
  }

  try {
    await loadGoogleScript();
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return;
  }

  const id = window.google?.accounts?.id;
  if (!id) {
    onError("Google sign-in failed to initialise.");
    return;
  }

  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => {
      if (response.credential) onToken(response.credential);
      else onError("Google did not return a sign-in token.");
    },
    // No auto-select: signing somebody in because a cookie remembered them, on
    // a page that provisions a WALLET, is not a decision to make for them.
    auto_select: false,
  });

  el.innerHTML = "";
  id.renderButton(el, {
    theme: "filled_black",
    size: "large",
    width: 320,
    text: "continue_with",
    shape: "pill",
  });
}
