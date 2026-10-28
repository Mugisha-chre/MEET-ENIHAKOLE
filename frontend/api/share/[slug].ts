type Request = { headers: Record<string, string | string[] | undefined>; query: Record<string, string | string[] | undefined>; url?: string };
type Response = { status: (code: number) => Response; setHeader: (key: string, value: string) => void; send: (body: string) => void; redirect: (code: number, url: string) => void };

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export default async function handler(req: Request, res: Response) {
  const rawSlug = Array.isArray(req.query.slug) ? req.query.slug[0] : req.query.slug;
  const slug = String(rawSlug || "").trim();
  const isPublicFrontendUrl = (value: string | undefined): value is string => {
    if (!value?.trim()) return false;
    try {
      const parsed = new URL(value.trim());
      return (parsed.protocol === "https:" || parsed.protocol === "http:")
        && !["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)
        && !parsed.hostname.endsWith(".onrender.com");
    } catch { return false; }
  };
  const vercelUrl = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)?.trim();
  // Never use a local or Render API URL as the public invitation origin.
  const appUrl = (
    isPublicFrontendUrl(process.env.FRONTEND_APP_URL) ? process.env.FRONTEND_APP_URL
      : vercelUrl ? `https://${vercelUrl.replace(/^https?:\/\//, "")}`
        : isPublicFrontendUrl(process.env.APP_URL) ? process.env.APP_URL
          : isPublicFrontendUrl(process.env.VITE_APP_URL) ? process.env.VITE_APP_URL
            : "https://meet-enihakole.vercel.app"
  ).replace(/\/$/, "");
  if (!slug || !/^[a-zA-Z0-9-]{2,180}$/.test(slug)) {
    res.status(400).send("<!doctype html><html><title>Invalid invitation</title><body><p>This meeting invitation link is invalid.</p></body></html>");
    return;
  }
  const userAgent = String(req.headers["user-agent"] || "");
  const isPreviewCrawler = /WhatsApp|facebookexternalhit|facebookcatalog|Facebot|meta-externalagent|Twitterbot|LinkedInBot|Slackbot|Slack-ImgProxy|TelegramBot|Discordbot|Googlebot|Applebot|SkypeUriPreview|Pinterest|redditbot|vkShare|Iframely|Signal|Viber|Mastodon|Embedly|Bingbot|bot\b|crawler|spider|preview/i.test(userAgent);
  const detailsUrl = `${appUrl}/meeting/${encodeURIComponent(slug)}`;
  if (!isPreviewCrawler) {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, detailsUrl);
    return;
  }

  const configuredApiUrl = (process.env.BACKEND_API_URL || process.env.VITE_API_URL || process.env.API_PUBLIC_URL || "https://meet-enihakole-api.onrender.com").trim().replace(/\/+$/, "");
  const apiUrl = configuredApiUrl
    ? (configuredApiUrl.endsWith("/api") ? configuredApiUrl : `${configuredApiUrl}/api`)
    : "";
  let title = "You're invited · MEET ENIHAKOLE";
  let description = "Join ENIHAKOLE CHOIR for an online prayer, rehearsal, or gathering.";
  let image = `${appUrl}/og-default.png`;
  let owner = "ENIHAKOLE CHOIR";
  let start = "Open the invitation to see meeting details";
  let robots = "noindex,nofollow";
  if (apiUrl) {
    try {
      const response = await fetch(`${apiUrl}/meetings/${encodeURIComponent(slug)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (response.ok) {
        const payload = await response.json() as { meeting?: { title?: string; description?: string; thumbnailUrl?: string; ownerName?: string; startsAt?: string; timezone?: string; visibility?: string } };
        const meeting = payload.meeting;
        if (meeting) {
          title = `${meeting.title || "Meeting invitation"} · MEET ENIHAKOLE`;
          description = (meeting.description || `Join ${meeting.ownerName || "ENIHAKOLE CHOIR"} for an online prayer or meeting on MEET ENIHAKOLE.`).slice(0, 240);
          if (meeting.thumbnailUrl && /^https:\/\//i.test(meeting.thumbnailUrl)) {
            // Messaging apps (WhatsApp wants roughly <300 KB) reject huge images: serve an optimised 1200x630 JPG for Cloudinary covers.
            const untransformed = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/|meet-enihakole\/)/i.test(meeting.thumbnailUrl);
            image = untransformed
              ? meeting.thumbnailUrl.replace("/image/upload/", "/image/upload/c_fill,w_1200,h_630,q_auto:good,f_jpg/")
              : meeting.thumbnailUrl;
          }
          owner = meeting.ownerName || owner;
          start = meeting.startsAt ? new Date(meeting.startsAt).toLocaleString("en-RW", { dateStyle: "full", timeStyle: "short", timeZone: meeting.timezone || "Africa/Kigali" }) : start;
          robots = meeting.visibility === "public" ? "index,follow" : "noindex,nofollow";
        }
      }
    } catch (error) {
      console.error("[share-preview] failed to fetch meeting metadata", error instanceof Error ? error.message : "unknown error");
    }
  }
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeImage = escapeHtml(image);
  const safeDetails = escapeHtml(detailsUrl);
  const safeOwner = escapeHtml(owner);
  const safeStart = escapeHtml(start);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  res.setHeader("X-Robots-Tag", robots);
  res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><meta name="description" content="${safeDescription}"><meta name="robots" content="${robots}"><meta property="og:type" content="website"><meta property="og:site_name" content="MEET ENIHAKOLE"><meta property="og:title" content="${safeTitle}"><meta property="og:description" content="${safeDescription}"><meta property="og:url" content="${escapeHtml(`${appUrl}/share/${encodeURIComponent(slug)}`)}"><meta property="og:image" content="${safeImage}"><meta property="og:image:secure_url" content="${safeImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="MEET ENIHAKOLE meeting cover"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${safeTitle}"><meta name="twitter:description" content="${safeDescription}"><meta name="twitter:image" content="${safeImage}"><meta http-equiv="refresh" content="0;url=${safeDetails}"></head><body><main><p>Hosted by ${safeOwner}</p><p>${safeStart}</p><a href="${safeDetails}">Open meeting details</a></main><script>location.replace(${JSON.stringify(detailsUrl)})</script></body></html>`);
}
