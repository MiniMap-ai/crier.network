import { env } from "./env";
import { HttpError, bearer } from "./http";
import { safeEqual } from "./ids";

/** Admin endpoints are protected by ADMIN_KEY. If it is unset, they are disabled. */
export function requireAdmin(req: Request) {
  const key = bearer(req);
  if (!env.ADMIN_KEY || !key || !safeEqual(key, env.ADMIN_KEY)) {
    throw new HttpError(401, "unauthorized", "Admin only.");
  }
}
