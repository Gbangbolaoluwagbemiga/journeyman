import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CATEGORIES,
  categoryLabel,
  categoryMarker,
  categoryOf,
  withoutMarker,
} from "@/lib/atelier/categories";

/**
 * The category rides in the job's description as a marker, because it changes
 * nothing about how money moves and the escrow had no room to spend a storage
 * slot on a browsing aid.
 *
 * Two things have to hold for that to be a fair trade: a reader must never see
 * the marker, and an uncategorised job must come back as uncategorised rather
 * than as a guess. Everything below is one of those two.
 */

describe("writing and reading the marker", () => {
  it("round-trips every category in the vocabulary", () => {
    for (const c of CATEGORIES) {
      const description = `${categoryMarker(c.id)}\nA job about something.`;
      expect(categoryOf(description)).toBe(c.id);
    }
  });

  it("finds the marker wherever it sits, not only at the start", () => {
    expect(categoryOf("Some preamble\n[category:writing]\nmore")).toBe("writing");
  });

  it("is case-insensitive, since descriptions get edited by hand", () => {
    expect(categoryOf("[CATEGORY:DESIGN] a logo")).toBe("design");
  });
});

describe("when there is no category to report", () => {
  /* Every escrow created before this existed. Guessing from the prose would be
     worse than saying nothing: someone filtering for design work should not be
     shown a job that merely mentions a logo. */
  it("returns null for a job posted before categories existed", () => {
    expect(categoryOf("A logo for a coffee roastery. Budget $50, 3 days.")).toBeNull();
  });

  it("returns null for a marker that is not in the vocabulary", () => {
    expect(categoryOf("[category:underwater-basket-weaving] hello")).toBeNull();
  });

  it("handles an absent description without throwing", () => {
    expect(categoryOf(undefined)).toBeNull();
    expect(withoutMarker(undefined)).toBe("");
  });
});

describe("what a person actually reads", () => {
  it("strips the marker out of the description", () => {
    const description = `${categoryMarker("design")}\nA logo for a coffee roastery.`;
    expect(withoutMarker(description)).toBe("A logo for a coffee roastery.");
    expect(withoutMarker(description)).not.toContain("[category:");
  });

  it("leaves a description with no marker exactly as it was", () => {
    const plain = "A logo for a coffee roastery.";
    expect(withoutMarker(plain)).toBe(plain);
  });

  it("gives a human label rather than the id", () => {
    expect(categoryLabel("video-audio")).toBe("Video & audio");
    expect(categoryLabel(null)).toBeNull();
  });
});

/**
 * The daemon keeps its own copy, because the app and the daemon are separate
 * deployables with no build step between them. That is a deliberate trade, and
 * this is the thing that makes it safe: the marker format is a contract between
 * three writers and two readers, and a category the web board knows about but
 * Telegram does not is a job nobody can find.
 */
describe("the daemon's copy", () => {
  it("has not drifted from the app's", () => {
    const here = resolve(__dirname, "../..");
    const app = readFileSync(resolve(here, "src/lib/atelier/categories.ts"), "utf8");
    const daemon = readFileSync(resolve(here, "../agent/daemon/src/categories.ts"), "utf8");

    // Compare the vocabulary itself, not the header comments, which differ on
    // purpose — the daemon's explains why it is a copy.
    const vocab = (src: string) => src.slice(src.indexOf("export const CATEGORIES"));
    expect(vocab(daemon)).toBe(vocab(app));
  });
});
