/**
 * video-embed.js — turn a video link into a player. Shared by the facilitator
 * portal (session film, physical task videos) and the admin console (Session
 * videos, where admins preview a link before saving it).
 *
 * YouTube and Vimeo links become their privacy-friendly embeds; any other https
 * link is treated as a video file (.mp4 etc.). Only https links are accepted —
 * the same rule firestore.rules applies when an admin saves one.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** What kind of link this is: 'youtube' | 'vimeo' | 'file' | 'invalid' | '' (empty). */
export function videoKind(url) {
  url = String(url || '').trim();
  if (!url) return '';
  let u;
  try { u = new URL(url); } catch { return 'invalid'; }
  if (u.protocol !== 'https:') return 'invalid';
  if (youTubeId(url)) return 'youtube';
  if (vimeoId(url)) return 'vimeo';
  return 'file';
}
const youTubeId = (url) => (String(url).match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/) || [])[1];
const vimeoId = (url) => (String(url).match(/vimeo\.com\/(?:video\/)?(\d+)/) || [])[1];

/** A short description of a link, for the admin page ("YouTube video"). */
export const VIDEO_KIND_LABEL = {
  youtube: 'YouTube video', vimeo: 'Vimeo video', file: 'Video file link',
  invalid: 'Not a usable link — it must start with https://', '': 'No video yet'
};

/** The player's HTML (an iframe or <video>), or a "to be added" panel. */
export function videoEmbed(url, title = 'Video') {
  const kind = videoKind(url);
  if (!kind || kind === 'invalid') return '<div class="none">Video to be added</div>';
  if (kind === 'youtube') return `<iframe src="https://www.youtube-nocookie.com/embed/${youTubeId(url)}" title="${esc(title)}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  if (kind === 'vimeo') return `<iframe src="https://player.vimeo.com/video/${vimeoId(url)}" title="${esc(title)}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  return `<video src="${esc(url)}" controls preload="metadata" title="${esc(title)}"></video>`;
}
