/**
 * dealerrater.js — scrapes reviews mentioning the salesman from their DealerRater page
 *
 * Configurable via Railway Variables:
 *   DEALERRATER_URL    = full URL to the dealer or employee page
 *   DEALERRATER_NAME   = name to filter reviews by (e.g. "Diego Ortiz")
 *   DEALERRATER_PAGES  = how many pages to scrape (default: 3)
 *   DEALERRATER_TTL_MS = cache TTL in ms (default: 6 hours)
 *
 * If Diego changes dealerships he just updates DEALERRATER_URL in Railway —
 * no code changes needed.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

const DEFAULT_URL   = 'https://www.dealerrater.com/dealer/Younger-Nissan-of-Frederick-dealer-reviews-18014/';
const DEFAULT_NAME  = 'Diego Ortiz';
const DEFAULT_PAGES = 3;
const TTL_MS        = parseInt(process.env.DEALERRATER_TTL_MS) || 6 * 60 * 60 * 1000; // 6h

let _cache     = null;
let _cacheTime = 0;

// ── Fetch one page and return its HTML ────────────────────
const fetchPage = async (url) => {
  const res = await axios.get(url, {
    timeout: 10000,
    headers: {
      // Polite browser-like UA
      'User-Agent': 'Mozilla/5.0 (compatible; DiegoOrtizNissan/1.0; +https://diegoortiz.com)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    },
    maxRedirects: 5,
  });
  return res.data;
};

// ── Parse reviews from a single page HTML ─────────────────
const parseReviews = (html, filterName) => {
  const $       = cheerio.load(html);
  const reviews = [];
  const nameLower = filterName.toLowerCase();

  // DealerRater review cards
  $('.review-entry, .review-wrapper, [class*="review-"]').each((_, el) => {
    const card = $(el);
    const text = card.text().toLowerCase();

    // Only keep reviews that mention the salesman's name
    if (!text.includes(nameLower)) return;

    // Extract review body
    const bodyEl = card.find('.review-content, .review-text, p').first();
    let body = bodyEl.text().trim();
    if (!body) body = card.find('p').first().text().trim();
    if (!body || body.length < 20) return;

    // Extract rating
    let rating = 5;
    const ratingEl = card.find('[class*="rating"], [class*="stars"], .dealership-rating');
    const ratingText = ratingEl.attr('title') || ratingEl.text();
    const ratingMatch = ratingText.match(/(\d+(\.\d+)?)/);
    if (ratingMatch) rating = parseFloat(ratingMatch[1]);

    // Extract author
    const authorEl = card.find('.review-author, .reviewer-name, [class*="author"]');
    let author = authorEl.text().trim().replace(/^by\s+/i, '');
    if (!author) {
      const match = card.text().match(/by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+)?)\s/);
      if (match) author = match[1];
    }
    if (!author) author = 'Cliente Verificado';

    // Extract date
    const dateEl = card.find('.review-date, time, [class*="date"]');
    let date = dateEl.attr('datetime') || dateEl.text().trim();
    if (!date) {
      const dMatch = card.text().match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
      if (dMatch) date = dMatch[0];
    }

    // Extract vehicle if present
    const vehicleMatch = card.text().match(/\b(Nissan\s+\w+|\d{4}\s+\w+\s+\w+)/i);
    const vehicle = vehicleMatch ? vehicleMatch[0] : null;

    reviews.push({
      author:  sanitizeText(author),
      rating:  Math.min(5, Math.max(1, rating)),
      date:    sanitizeText(date) || '',
      text:    sanitizeText(body),
      vehicle: vehicle ? sanitizeText(vehicle) : null,
      source:  'DealerRater',
    });
  });

  return reviews;
};

// ── Strip any HTML/script from scraped text ───────────────
const sanitizeText = (str) => {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')            // strip tags
    .replace(/[<>'"&]/g, '')            // strip dangerous chars
    .replace(/\s+/g, ' ')              // normalize whitespace
    .trim()
    .slice(0, 1000);                    // hard length cap
};

// ── Main: fetch N pages and return merged unique reviews ──
const fetchReviews = async () => {
  // Return cached result if still fresh
  if (_cache && Date.now() - _cacheTime < TTL_MS) {
    return { reviews: _cache, fromCache: true };
  }

  const baseUrl  = (process.env.DEALERRATER_URL || DEFAULT_URL).replace(/\/$/, '');
  const name     = process.env.DEALERRATER_NAME  || DEFAULT_NAME;
  const pages    = Math.min(parseInt(process.env.DEALERRATER_PAGES) || DEFAULT_PAGES, 10);

  const allReviews = [];
  const seen = new Set();

  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? `${baseUrl}/` : `${baseUrl}/page${p}/`;
    try {
      const html    = await fetchPage(url);
      const reviews = parseReviews(html, name);
      for (const r of reviews) {
        // Deduplicate by first 80 chars of text
        const key = r.text.slice(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          allReviews.push(r);
        }
      }
      // Small delay between pages — be a polite scraper
      if (p < pages) await new Promise(res => setTimeout(res, 800));
    } catch (e) {
      console.warn(`[DealerRater] Page ${p} fetch failed: ${e.message}`);
      // Continue — partial results are still useful
    }
  }

  if (allReviews.length > 0) {
    _cache     = allReviews;
    _cacheTime = Date.now();
    console.log(`[DealerRater] Fetched ${allReviews.length} reviews for "${name}"`);
  } else {
    console.warn(`[DealerRater] No reviews found for "${name}" — check DEALERRATER_URL and DEALERRATER_NAME`);
  }

  return { reviews: allReviews, fromCache: false };
};

// ── Warm the cache on startup (non-blocking) ─────────────
const warmCache = () => {
  setTimeout(() => {
    fetchReviews().catch(e => console.warn('[DealerRater] Warm cache failed:', e.message));
  }, 5000); // wait 5s after boot so server is fully up
};

module.exports = { fetchReviews, warmCache };
