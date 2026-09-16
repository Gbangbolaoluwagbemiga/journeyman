import { Router } from "express";
import {
  generateCoverLetter,
  generateMilestoneSuggestions,
  rewriteProjectDescription,
} from "../lib/groq.js";

export const aiRouter = Router();

aiRouter.post("/milestones", async (req, res) => {
  try {
    const {
      projectTitle = "",
      projectDescription = "",
      totalBudget = "",
      durationDays = "",
      userPrompt = "",
      milestoneIndex = null,
    } = req.body ?? {};

    if (!String(userPrompt).trim()) {
      res.status(400).json({ error: "userPrompt is required" });
      return;
    }

    const suggestions = await generateMilestoneSuggestions({
      projectTitle: String(projectTitle),
      projectDescription: String(projectDescription),
      totalBudget: String(totalBudget),
      durationDays: String(durationDays),
      userPrompt: String(userPrompt),
      milestoneIndex:
        typeof milestoneIndex === "number" ? milestoneIndex : null,
    });

    res.json({ suggestions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI generation failed";
    const status = msg.includes("GROQ_API_KEY") ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

aiRouter.post("/cover-letter", async (req, res) => {
  try {
    const {
      jobTitle = "",
      jobDescription = "",
      proposedTimelineDays = "",
      tone = "",
      userDraft = "",
    } = req.body ?? {};

    if (!String(jobDescription).trim()) {
      res.status(400).json({ error: "jobDescription is required" });
      return;
    }

    const coverLetter = await generateCoverLetter({
      jobTitle: String(jobTitle),
      jobDescription: String(jobDescription),
      proposedTimelineDays: proposedTimelineDays
        ? String(proposedTimelineDays)
        : undefined,
      tone: tone ? String(tone) : undefined,
      userDraft: userDraft ? String(userDraft) : undefined,
    });

    res.json({ coverLetter });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI generation failed";
    const status = msg.includes("GROQ_API_KEY") ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

aiRouter.post("/rewrite", async (req, res) => {
  try {
    const { text = "" } = req.body ?? {};

    if (!String(text).trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const rewritten = await rewriteProjectDescription({ text: String(text) });
    res.json({ text: rewritten });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI rewrite failed";
    const status = msg.includes("GROQ_API_KEY") ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});
