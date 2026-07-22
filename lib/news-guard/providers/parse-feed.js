'use strict';
// lib/news-guard/providers/parse-feed.js — minimal, dependency-free RSS 2.0 + Atom 1.0 parser.
//
// Handles the two shapes every publisher / Google News / Reddit feed uses:
//   • RSS   <item>  : <title> <link> <description> <pubDate> <guid>
//   • Atom  <entry> : <title> <link href> <summary>|<content> <updated>|<published> <id>
//
// Returns [{ title, url, summary, publishedTs }] with REAL parsed timestamps only — an entry whose
// date can't be parsed gets publishedTs=null (the recency bound then excludes it; we never guess a date).
// Not a full XML parser: it is deliberately small and defensive (regex over the entry block), which is
// all these well-formed syndication feeds need and keeps the guard dependency-free.

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')                       // strip any nested HTML tags in descriptions
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

// Atom <link href="..."/> (prefer rel="alternate" or no rel); fall back to RSS <link>text</link>.
function extractUrl(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>(?:([\s\S]*?)<\/link>)?/gi)];
  let alt = null, any = null;
  for (const m of links) {
    const attrs = m[1] || '';
    const href = (attrs.match(/href\s*=\s*"([^"]+)"/i) || [])[1];
    const rel = (attrs.match(/rel\s*=\s*"([^"]+)"/i) || [])[1];
    const text = (m[2] || '').trim();
    const url = href || text;
    if (!url) continue;
    if (!rel || rel === 'alternate') { alt = alt || url; }
    any = any || url;
  }
  return alt || any;
}

function parseFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map(m => m[0]);
  for (const block of blocks) {
    const title = decodeEntities(firstTag(block, 'title'));
    if (!title) continue;
    const url = extractUrl(block);
    const summary = decodeEntities(firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content') || '');
    const dateRaw = firstTag(block, 'pubDate') || firstTag(block, 'published') || firstTag(block, 'updated') || firstTag(block, 'dc:date');
    const t = dateRaw ? Date.parse(dateRaw.trim()) : NaN;
    out.push({ title, url: url || null, summary, publishedTs: Number.isFinite(t) ? t : null });
  }
  return out;
}

module.exports = { parseFeed, decodeEntities };
