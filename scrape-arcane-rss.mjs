#!/usr/bin/env node

process.env.TZ = process.env.TZ || 'America/New_York';

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CALENDAR_URL = 'https://arcane.city/calendar';
const ARCANE_HTTP_ORIGIN = 'http://arcane.city';
const ARCANE_ALLOWED_HOST = 'arcane.city';
const DEFAULT_OUTPUT = 'feed.xml';
const DEFAULT_DAYS = 14;

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output || args.o || DEFAULT_OUTPUT;
const days = Number.parseInt(args.days || String(DEFAULT_DAYS), 10);
const startDate = args['start-date'] || todayInTimeZone('America/New_York');
const dryRun = Boolean(args['dry-run']);
const concurrency = Number.parseInt(args.concurrency || '6', 10);

if (!Number.isFinite(days) || days <= 0) {
  throw new Error('--days must be a positive integer');
}
if (!Number.isFinite(concurrency) || concurrency <= 0) {
  throw new Error('--concurrency must be a positive integer');
}

main().catch((error) => {
  console.error(`Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const cache = await loadCache(outputPath);
  if (cache.size > 0) {
    console.error(`Loaded ${cache.size} items from cache: ${outputPath}`);
  }

  console.error(`Fetching calendar source: ${CALENDAR_URL}`);
  const calendarHtml = await fetchText(CALENDAR_URL);
  const calendarEvents = extractFullCalendarEvents(calendarHtml);
  console.error(`Parsed ${calendarEvents.length} FullCalendar entries from calendar source.`);

  const windowStart = `${startDate} 00:00`;
  const windowEnd = `${addDaysToDateString(startDate, days)} 00:00`;

  const events = calendarEvents
    .filter((event) => isCalendarEventPage(event))
    .filter((event) => typeof event.start === 'string' && event.start >= windowStart && event.start < windowEnd)
    .sort((a, b) => a.start.localeCompare(b.start));

  console.error(`Found ${events.length} /events/ entries from ${windowStart} through before ${windowEnd}.`);

  const enriched = await mapWithConcurrency(events, concurrency, async (event, index) => {
    const eventUrl = toArcaneHttpUrl(event.url);
    if (!eventUrl || !isAllowedArcaneUrl(eventUrl)) {
      console.error(`[${index + 1}/${events.length}] Skipping non-arcane URL for "${event.title || '(untitled)'}": ${event.url || '(missing)'}`);
      return null;
    }

    // Check cache
    const cached = cache.get(eventUrl);
    // Use cache if we already successfully scraped it (even if it didn't have a flier or venue on the page)
    // We assume if it's in the cache, we've visited it, unless we want to keep retrying missing fliers.
    // The user requested: "skip any events it has already seen (unless it is missing data, like flier info)"
    if (cached && cached.flierUrl) {
      console.error(`[${index + 1}/${events.length}] Using cached data for "${event.title || '(untitled)'}"`);
      return {
        ...event,
        eventUrl,
        venue: cached.venue,
        flierUrl: cached.flierUrl,
        pageSummary: cached.summary,
        cachedPubDate: cached.pubDate,
      };
    }

    console.error(`[${index + 1}/${events.length}] Scraping "${event.title || '(untitled)'}" - ${eventUrl}`);

    let pageData = { venue: '', flierUrl: '', summary: '' };
    try {
      const eventHtml = await fetchText(eventUrl);
      pageData = extractEventPageData(eventHtml, event.title || '');
    } catch (error) {
      console.error(`  Warning: failed to scrape ${eventUrl}: ${error.message}`);
    }

    return {
      ...event,
      eventUrl,
      venue: pageData.venue,
      flierUrl: pageData.flierUrl,
      pageSummary: pageData.summary,
    };
  });

  const rss = buildRss(enriched.filter(Boolean), { startDate, days });

  if (dryRun) {
    process.stdout.write(rss);
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rss, 'utf8');
  console.error(`Wrote RSS feed: ${outputPath}`);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

async function loadCache(path) {
  const cache = new Map();
  try {
    const xml = await readFile(path, 'utf8');
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const content = match[1];
      const link = matchFirst(content, /<link>([^<]+)<\/link>/);
      const title = matchFirst(content, /<title>([^<]+)<\/title>/);
      let description = matchFirst(content, /<description>([\s\S]*?)<\/description>/);

      // Extract from CDATA if present
      if (description.includes('<![CDATA[')) {
        description = matchFirst(description, /<!\[CDATA\[([\s\S]*?)\]\]>/);
      } else {
        description = decodeHtmlEntities(description);
      }

      const flierUrl = matchFirst(description, /<img\b[^>]*src=["']([^"']+)["']/i);
      const venueMatch = title.match(/\s@\s(.+)$/);
      const venue = venueMatch ? venueMatch[1] : '';
      const summaryMatch = description.match(/<p>(?!<img)([\s\S]*?)<\/p>/i);
      const summary = summaryMatch ? summaryMatch[1] : '';

      const pubDate = matchFirst(content, /<pubDate>([^<]+)<\/pubDate>/);
      if (link) {
        cache.set(link, { flierUrl: flierUrl || '', venue, summary, pubDate });
      }
    }
  } catch (error) {
    // Ignore if file doesn't exist
  }
  return cache;
}

async function fetchText(url) {
  if (!isAllowedArcaneUrl(url) && url !== CALENDAR_URL) {
    throw new Error(`Refusing to scrape non-arcane URL: ${url}`);
  }

  const networkUrl = normalizeNetworkUrl(url);
  const response = await fetch(networkUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
    headers: {
      'user-agent': 'arcane-rss-scraper/1.0 (+https://github.com/; RSS generator)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function extractFullCalendarEvents(html) {
  const calendarNeedle = 'var calendar = new FullCalendar.Calendar';
  const calendarIndex = html.indexOf(calendarNeedle);
  if (calendarIndex === -1) {
    throw new Error(`Could not find ${calendarNeedle} in calendar source`);
  }

  const eventsIndex = html.indexOf('events:', calendarIndex);
  if (eventsIndex === -1) {
    throw new Error('Could not find events: array in FullCalendar initialization');
  }

  const arrayStart = html.indexOf('[', eventsIndex);
  if (arrayStart === -1) {
    throw new Error('Could not find opening [ for FullCalendar events array');
  }

  const arrayEnd = findMatchingBracket(html, arrayStart);
  const jsonText = html.slice(arrayStart, arrayEnd + 1);
  return JSON.parse(jsonText);
}

function findMatchingBracket(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error('Could not find closing ] for FullCalendar events array');
}

function isCalendarEventPage(event) {
  return event && typeof event.url === 'string' && event.url.startsWith('/events/');
}

function toArcaneHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return '';

  if (value.startsWith('/')) {
    return `${ARCANE_HTTP_ORIGIN}${value}`;
  }

  try {
    const url = new URL(value);
    if (url.hostname !== ARCANE_ALLOWED_HOST) return '';
    return `${ARCANE_HTTP_ORIGIN}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '';
  }
}

function isAllowedArcaneUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === ARCANE_ALLOWED_HOST;
  } catch {
    return false;
  }
}

function normalizeNetworkUrl(value) {
  const url = new URL(value);
  if (url.hostname === ARCANE_ALLOWED_HOST) {
    url.protocol = 'https:';
  }
  return url.toString();
}

function extractEventPageData(html, fallbackTitle) {
  const flierUrl = extractFlierUrl(html);
  const venue = extractVenue(html, fallbackTitle);
  const summary = extractSummary(html);
  return { flierUrl, venue, summary };
}

function extractFlierUrl(html) {
  const metaImage = matchFirst(html, /<meta\s+(?:property|name)=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["'][^>]*>/i)
    || matchFirst(html, /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i);
  if (metaImage) return decodeHtmlEntities(metaImage);

  const linkedPhoto = matchFirst(html, /<a\b[^>]*href=["']([^"']*\/prod\/photos\/(?!tn-)[^"']+)["'][^>]*>/i);
  if (linkedPhoto) return decodeHtmlEntities(linkedPhoto);

  const imagePhoto = matchFirst(html, /<img\b[^>]*src=["']([^"']*\/prod\/photos\/[^"']+)["'][^>]*>/i);
  if (imagePhoto) return decodeHtmlEntities(imagePhoto).replace('/prod/photos/tn-', '/prod/photos/');

  return '';
}

function extractVenue(html, fallbackTitle) {
  const calendarHref = matchFirst(html, /href=["']([^"']*google\.com\/calendar\/render[^"']*)["']/i);
  if (calendarHref) {
    const decodedHref = decodeHtmlEntities(calendarHref);
    const locationMatch = decodedHref.match(/[?&]location=([^&]+)/);
    if (locationMatch) {
      const venue = cleanVenue(decodeURIComponentSafe(locationMatch[1].replace(/\+/g, ' ')));
      if (isKnownVenue(venue)) return venue;
    }
  }

  const titleText = cleanText(matchFirst(html, /<title>([\s\S]*?)<\/title>/i) || '');
  const titleVenue = matchFirst(titleText, /\sat\s(.+?)\son\s/i);
  if (isKnownVenue(titleVenue)) return cleanVenue(titleVenue);

  const altVenue = matchFirst(html, new RegExp(`${escapeRegExp(fallbackTitle)}\\s*@\\s*([^"'<]+)`, 'i'));
  if (isKnownVenue(altVenue)) return cleanVenue(altVenue);

  return '';
}

function extractSummary(html) {
  const description = matchFirst(html, /<meta\s+(?:name|property)=["']description["']\s+content=["']([^"']+)["'][^>]*>/i)
    || matchFirst(html, /<meta\s+content=["']([^"']+)["']\s+(?:name|property)=["']description["'][^>]*>/i);
  return cleanText(decodeHtmlEntities(description || ''));
}

function buildRss(events, options) {
  const now = new Date();
  const items = events.map(buildRssItem).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>Arcane City Events - Next ${xmlEscape(String(options.days))} Days</title>\n    <link>${ARCANE_HTTP_ORIGIN}/calendar</link>\n    <atom:link href="${ARCANE_HTTP_ORIGIN}/calendar" rel="self" type="application/rss+xml" />\n    <description>Upcoming Arcane City events from ${xmlEscape(options.startDate)} through the next ${xmlEscape(String(options.days))} days.</description>\n    <language>en-us</language>\n    <lastBuildDate>${now.toUTCString()}</lastBuildDate>\n${items}\n  </channel>\n</rss>\n`;
}

function buildRssItem(event) {
  const eventDate = parseCalendarDate(event.start);
  const titleDate = formatEventDate(eventDate);
  const titleVenue = event.venue ? ` @ ${event.venue}` : '';
  const title = `${titleDate} ${event.title || 'Untitled event'}${titleVenue}`;
  const guid = event.eventUrl || `${ARCANE_HTTP_ORIGIN}${event.url}`;
  const htmlDescription = buildHtmlDescription(event);

  // Use cached pubDate if available, otherwise use current time for new events
  const pubDateStr = event.cachedPubDate || new Date().toUTCString();

  return `    <item>\n      <title>${xmlEscape(title)}</title>\n      <link>${xmlEscape(event.eventUrl)}</link>\n      <guid isPermaLink="true">${xmlEscape(guid)}</guid>\n      <pubDate>${pubDateStr}</pubDate>\n      <description><![CDATA[${htmlDescription}]]></description>\n    </item>`;
}

function buildHtmlDescription(event) {
  const parts = [];
  if (event.flierUrl) {
    parts.push(`<p><img src="${htmlAttributeEscape(event.flierUrl)}" alt="${htmlAttributeEscape(event.title || 'Event flier')} flier" /></p>`);
  }

  const summary = event.pageSummary || event.description || '';
  if (summary) {
    parts.push(`<p>${htmlTextEscape(summary)}</p>`);
  }

  if (event.venue) {
    parts.push(`<p><strong>Venue:</strong> ${htmlTextEscape(event.venue)}</p>`);
  }

  parts.push(`<p><a href="${htmlAttributeEscape(event.eventUrl)}">View event on Arcane City</a></p>`);
  return parts.join('\n');
}

function parseCalendarDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  const [, y, m, d, hh = '00', mm = '00'] = match;
  return zonedWallTimeToUtcDate({
    year: Number(y),
    month: Number(m),
    day: Number(d),
    hour: Number(hh),
    minute: Number(mm),
    timeZone: 'America/New_York',
  });
}

function zonedWallTimeToUtcDate({ year, month, day, hour, minute, timeZone }) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const guess = new Date(targetAsUtc);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(guess);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const actualAsUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    0,
    0,
  );
  return new Date(targetAsUtc + (targetAsUtc - actualAsUtc));
}

function formatEventDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/New_York',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `[${byType.month}/${byType.day}]`;
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDaysToDateString(dateString, dayCount) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + dayCount, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function matchFirst(text, regex) {
  const match = String(text || '').match(regex);
  return match ? match[1] : '';
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanVenue(value) {
  return cleanText(value).replace(/^@\s*/, '').trim();
}

function isKnownVenue(value) {
  const venue = cleanVenue(value);
  return Boolean(venue && !/^(tba|unknown|n\/a|none)$/i.test(venue));
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function htmlTextEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlAttributeEscape(value) {
  return htmlTextEscape(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
