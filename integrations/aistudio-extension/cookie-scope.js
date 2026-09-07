const AI_STUDIO_COOKIE_HOST = "alkalimakersuite-pa.clients6.google.com";
const AI_STUDIO_COOKIE_PATHS = [
  "/v1internal:generateContent",
  "/v1internal:streamGenerateContent",
];

function aiStudioCookieDomainMatches(cookie) {
  if (!cookie || typeof cookie.domain !== "string") return false;
  const domain = cookie.domain.toLowerCase().replace(/^\./, "");
  if (!domain) return false;
  if (cookie.hostOnly === true) return AI_STUDIO_COOKIE_HOST === domain;
  return AI_STUDIO_COOKIE_HOST === domain || AI_STUDIO_COOKIE_HOST.endsWith(`.${domain}`);
}

function aiStudioCookiePathMatches(requestPath, cookiePath) {
  if (typeof cookiePath !== "string" || !cookiePath.startsWith("/")) return false;
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function filterAiStudioCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(cookie =>
    aiStudioCookieDomainMatches(cookie)
    && AI_STUDIO_COOKIE_PATHS.some(path => aiStudioCookiePathMatches(path, cookie.path)));
}
