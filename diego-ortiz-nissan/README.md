# Diego Ortiz — Younger Nissan of Frederick

Personal website for Diego Ortiz, Nissan Sales Specialist at Younger Nissan of Frederick, MD.
Bilingual (Spanish/English), live vAuto inventory, contact form, testimonials.

## Stack
- **Backend**: Node.js + Express
- **Inventory**: vAuto API (with mock fallback for dev)
- **Email**: Nodemailer (SMTP)
- **Security**: Helmet, express-rate-limit, express-validator, xss, honeypot
- **Hosting**: Railway

---

## Local Setup

```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```

Open http://localhost:3000

## Deploy to Railway

1. Push repo to GitHub
2. New Project → Deploy from GitHub
3. Add all variables from `.env.example` in Railway dashboard → Variables
4. Railway auto-deploys on push

## vAuto Integration

Set these in Railway Variables:
```
VAUTO_API_KEY=your_key
VAUTO_DEALER_ID=your_dealer_id
VAUTO_API_BASE_URL=https://api.vauto.com/v1
```

When `VAUTO_API_KEY` is not set or is the placeholder, the site runs in **mock mode** showing sample inventory — safe for dev/staging.

## Email Setup (Gmail)

1. Enable 2FA on Gmail
2. Generate an App Password: Google Account → Security → App Passwords
3. Set `SMTP_USER` and `SMTP_PASS` in Railway Variables

## Environment Variables

| Variable | Description |
|---|---|
| `SALESMAN_NAME` | Full name displayed site-wide |
| `SALESMAN_TITLE_ES/EN` | Job title in each language |
| `SALESMAN_PHONE` | Phone number |
| `SALESMAN_EMAIL` | Email address |
| `SALESMAN_PHOTO_URL` | Path or URL to photo |
| `SALESMAN_BIO_ES/EN` | Bio paragraph in each language |
| `DEALERSHIP_NAME` | Dealership display name |
| `DEALERSHIP_ADDRESS` | Full street address |
| `DEALERSHIP_PHONE` | Dealership phone |
| `DEALERSHIP_WEBSITE` | Dealership URL |
| `DEALERSHIP_GOOGLE_MAPS_URL` | Google Maps link |
| `VAUTO_API_KEY` | vAuto API key |
| `VAUTO_DEALER_ID` | vAuto dealer ID |
| `VAUTO_CACHE_TTL_SECONDS` | Inventory cache TTL (default 300) |
| `SMTP_HOST/PORT/USER/PASS` | Email credentials |
| `CONTACT_RECIPIENT` | Who receives contact form emails |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |

## Security Features

- Helmet HTTP headers (CSP, HSTS, etc.)
- Rate limiting: 100 req/15min global, 5 contact submissions/15min
- All inputs sanitized with `xss` library + express-validator
- Honeypot field on contact form (bot trap)
- `escapeHTML()` used everywhere DOM text is set (XSS prevention)
- CORS restricted to configured origins in production
- Body size limited to 50kb
