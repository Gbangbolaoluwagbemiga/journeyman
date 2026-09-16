import type { RequestHandler } from "express";

export function requireApiSecret(
  apiSecret: string | undefined,
): RequestHandler {
  return (req, res, next) => {
    if (!apiSecret) {
      next();
      return;
    }
    const auth = req.headers.authorization;
    const expected = `Bearer ${apiSecret}`;
    if (auth !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
