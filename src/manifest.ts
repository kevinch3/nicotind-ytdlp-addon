/**
 * The yt-dlp addon's protocol manifest. Served verbatim as JSON from
 * `GET /addon/v1/manifest`. `priority: -10` makes it the low-priority catch-all
 * (`urlPatterns: ['^https?://']`), so specific resolve addons (archive, spotdl)
 * beat it for their URLs and yt-dlp takes everything else.
 */
export const YTDLP_MANIFEST = {
  id: "ytdlp-addon",
  name: "yt-dlp",
  description:
    "Download audio from any yt-dlp-supported URL (YouTube, SoundCloud, Bandcamp, …).",
  version: "0.3.0",
  // 1.1: this addon fills `AddonJob.title` (the playlist title).
  protocolVersion: "1.1.0",
  kind: "acquisition",
  capabilities: ["resolve"],
  urlPatterns: ["^https?://"],
  priority: -10,
  // binaryPath is env-only (YTDLP_ADDON_BINARY): which program runs is the
  // operator's call, not a web form's, and the field was never honoured.
  configFields: [
    {
      key: "cookies",
      label: "YouTube cookies (cookies.txt)",
      type: "password",
      multiline: true,
      placeholder: "# Netscape HTTP Cookie File",
      help:
        "Fixes \"Sign in to confirm you're not a bot\". In a private browser window, sign in to " +
        "YouTube with a spare Google account (heavy downloading can get an account flagged), open " +
        "youtube.com/robots.txt in that same tab, export its cookies with a cookies.txt extension " +
        "(Netscape format), then close the window without browsing further and paste the whole " +
        "file here. Stored only on the addon; leave blank to keep the current cookies.",
    },
    {
      key: "format",
      label: "yt-dlp format selector (optional)",
      type: "text",
      help: "Leave blank for the best available audio.",
    },
  ],
  statusFields: [{ key: "cookies", label: "YouTube cookies" }],
  compliance: {
    disclaimer:
      "yt-dlp downloads from third-party sites. You are responsible for complying with each " +
      "site's terms of service and with copyright law in your jurisdiction.",
    requiresConsent: true,
  },
} as const;
