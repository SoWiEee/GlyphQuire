import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const errorHandler: ErrorHandler = (err, c) => {
  console.error(`[API Error]`, err);

  const status: ContentfulStatusCode =
    "status" in err && typeof err.status === "number" ? (err.status as ContentfulStatusCode) : 500;

  return c.json(
    {
      error: {
        message: status === 500 ? "Internal Server Error" : err.message,
        code: "code" in err && typeof err.code === "string" ? err.code : "INTERNAL_ERROR",
      },
    },
    status,
  );
};
