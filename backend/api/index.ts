/**
 * Serverless entry point.
 *
 * Vercel turns a file under api/ into a function and mounts it at that path;
 * vercel.json then rewrites every request here, so the Express router keeps
 * owning its own URL space (/v1/...) instead of being reshaped to match a
 * directory layout.
 *
 * src/index.ts guards its app.listen() on process.env.VERCEL for the same
 * reason this file is a re-export rather than a second server: there must be
 * exactly one app, and the platform decides how it is served.
 */
export { default } from "../src/index.js";
