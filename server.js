const express = require('express');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.PDF_API_KEY || '';

// Middleware
app.use(express.json({ limit: '5mb' }));

// Rate limiting: 10 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/pdf', limiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Browser instance (reused across requests)
let browser;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browser;
}

// Font URL map for common resume fonts
const FONT_URLS = {
  'Inter': 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'Calibri': null, // system font, no URL needed
  'Georgia': null,
  'Times New Roman': null,
  'Arial': null,
  'Roboto': 'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap',
  'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap',
  'Lato': 'https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap',
  'Montserrat': 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap',
  'Playfair Display': 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap',
};

// PDF generation endpoint
app.post('/api/pdf', async (req, res) => {
  // Verify API key
  const apiKey = req.headers['x-api-key'];
  if (API_KEY && apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { html, css, format = 'A4', fontFamily } = req.body;

  if (!html) {
    return res.status(400).json({ error: 'HTML content is required' });
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Build font links
    const fontLinks = [];
    // Always include Inter (default font)
    fontLinks.push(`<link href="${FONT_URLS['Inter']}" rel="stylesheet">`);
    // Add requested font if it has a Google Fonts URL
    if (fontFamily && FONT_URLS[fontFamily]) {
      fontLinks.push(`<link href="${FONT_URLS[fontFamily]}" rel="stylesheet">`);
    }

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${fontLinks.join('\n  ')}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: white; }
    ${css || ''}
  </style>
</head>
<body>
  ${html}
</body>
</html>`;

    await page.setContent(fullHtml, {
      waitUntil: ['load', 'networkidle0'],
      timeout: 30000,
    });

    // Wait for fonts to load
    await page.evaluateHandle('document.fonts.ready');

    // Generate PDF
    const pdf = await page.pdf({
      format: format === 'Letter' ? 'letter' : 'a4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
    });

    const pdfBuffer = Buffer.from(pdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error) {
    console.error('PDF generation error:', error);
    res.status(500).json({ error: 'PDF generation failed' });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

// Start server immediately (health check must respond before browser is ready)
app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
  // Pre-warm browser in the background (non-blocking)
  getBrowser()
    .then(() => console.log('Browser ready'))
    .catch((err) => console.error('Browser pre-warm failed:', err));
});
