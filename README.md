# Arcane City RSS Scraper

This project is a **Node.js command-line scraper** for [Arcane City](https://arcane.city). It reads `https://arcane.city/calendar`, finds the embedded `var calendar = new FullCalendar.Calendar(...)` initialization, parses the FullCalendar event data, filters `/events/` pages for the next two weeks, visits each event page to retrieve the venue and flier image, and writes a standards-compatible RSS feed.

The scraper has **no web interface**. It is designed to run locally, in cron, or in **GitHub Actions**. Progress is written to stderr so the generated RSS can remain clean if stdout is redirected.

## Requirements

| Requirement | Details |
|---|---|
| Runtime | Node.js 20 or newer; Node.js 22 is recommended. |
| Dependencies | None beyond Node’s built-in `fetch` and standard library. |
| Network scope | The scraper only fetches `arcane.city` URLs for calendar and event pages. Flier image URLs are included in RSS descriptions but are not downloaded. |

## Usage

```bash
npm run scrape
```

This creates `feed.xml` in the current directory. The scraper logs progress like this while it runs:

```text
[1/70] Scraping "Bazaar Bazaar: All Of Your Favorite Things" - http://arcane.city/events/bazaar-bazaar-spirit-2026-05-17
```

You can override the output path, date window, or start date:

```bash
node scrape-arcane-rss.mjs --output public/arcane.xml
node scrape-arcane-rss.mjs --days 14 --start-date 2026-05-17 --output feed.xml
node scrape-arcane-rss.mjs --concurrency 6 --output feed.xml
node scrape-arcane-rss.mjs --dry-run > feed.xml
```

## RSS Behavior

For each item, the RSS title includes the formatted event date followed by the event title. If the event page exposes a venue, the title appends `@ Venue Name`. Each item link is normalized to begin with `http://arcane.city`, as requested. The item `pubDate` is set to **fourteen days before the event date**, and the description includes the flier image when available.

## GitHub Actions

The included workflow runs the scraper every day and commits `feed.xml` back to the repository when it changes. If you publish the repository with GitHub Pages, configure Pages to serve from the branch and path that contains `feed.xml`.
