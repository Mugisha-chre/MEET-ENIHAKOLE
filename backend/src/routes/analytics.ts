import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../middleware/auth.js";
import { PlatformEvent } from "../models/PlatformEvent.js";

const router = Router();
router.use(optionalAuth);
const pageViewSchema = z.object({ path: z.string().trim().min(1).max(300), pageLoad: z.boolean().optional().default(false) });
router.post("/page-view", async (req, res) => {
  const parsed = pageViewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid page-view event." });
  try {
    await PlatformEvent.create({ category: "page_view", action: parsed.data.pageLoad ? "page_load" : "page_view", actorId: req.auth?.userId || "", actorName: req.auth?.displayName || "", path: parsed.data.path.split("?")[0] });
    return res.status(202).json({ accepted: true });
  } catch { return res.status(503).json({ error: "Analytics event could not be saved." }); }
});
export default router;
