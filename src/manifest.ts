/**
 * The yt-dlp addon's protocol manifest. Served verbatim as JSON from
 * `GET /addon/v1/manifest`. `priority: -10` makes it the low-priority catch-all
 * (`urlPatterns: ['^https?://']`), so specific resolve addons (archive, spotdl)
 * beat it for their URLs and yt-dlp takes everything else.
 */
export const YTDLP_MANIFEST = {
  id: 'ytdlp-addon',
  name: 'yt-dlp',
  description: 'Download audio from any yt-dlp-supported URL (YouTube, SoundCloud, Bandcamp, …).',
  version: '0.1.0',
  protocolVersion: '1.0.0',
  kind: 'acquisition',
  capabilities: ['resolve'],
  urlPatterns: ['^https?://'],
  priority: -10,
  configFields: [
    { key: 'binaryPath', label: 'yt-dlp binary path', type: 'text' },
    { key: 'cookiesFile', label: 'Cookies file (Netscape format) path', type: 'text' },
    { key: 'format', label: 'yt-dlp format selector (optional)', type: 'text' },
  ],
  compliance: {
    disclaimer:
      'yt-dlp downloads from third-party sites. You are responsible for complying with each ' +
      "site's terms of service and with copyright law in your jurisdiction.",
    requiresConsent: true,
  },
} as const;
