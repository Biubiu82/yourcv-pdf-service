const express = require('express');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.PDF_API_KEY || '';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);

// Trust proxy (Render runs behind a reverse proxy)
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '2mb' }));

// Rate limiting: 20 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/pdf', limiter);

// ─── Browser Management ─────────────────────────────────────────────

let browser;
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--no-first-run',
  '--no-zygote',
  '--mute-audio',
  '--hide-scrollbars',
];

async function getBrowser() {
  if (!browser || !browser.connected) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    browser = await puppeteer.launch({
      headless: true,
      args: BROWSER_ARGS,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    console.log('Browser launched');
  }
  return browser;
}

// ─── Concurrency Queue ──────────────────────────────────────────────
// Limits concurrent PDF generations to prevent OOM on free tier

let activeJobs = 0;
const waitQueue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeJobs < MAX_CONCURRENT) {
      activeJobs++;
      resolve();
    } else {
      waitQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next(); // don't decrement, slot transfers to next waiter
  } else {
    activeJobs--;
  }
}

// ─── Font CSS Cache ─────────────────────────────────────────────────
// Cache Google Fonts CSS in memory to avoid network requests per PDF

const fontCSSCache = new Map();

const FONT_URLS = {
  'Inter': 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'Roboto': 'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap',
  'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap',
  'Lato': 'https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap',
  'Montserrat': 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap',
  'Playfair Display': 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap',
};

async function getFontCSS(fontName) {
  if (!FONT_URLS[fontName]) return '';
  if (fontCSSCache.has(fontName)) return fontCSSCache.get(fontName);

  try {
    const res = await fetch(FONT_URLS[fontName], {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    });
    const css = await res.text();
    fontCSSCache.set(fontName, css);
    return css;
  } catch {
    return '';
  }
}

// Pre-warm font cache at startup
async function prewarmFontCache() {
  await Promise.all(Object.keys(FONT_URLS).map((f) => getFontCSS(f)));
  console.log(`Font cache warmed: ${fontCSSCache.size} fonts`);
}

// ─── Health Check ───────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeJobs,
    queued: waitQueue.length,
    browserConnected: browser?.connected ?? false,
  });
});

// ─── PDF Generation ─────────────────────────────────────────────────

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

  const startTime = Date.now();

  // Wait for a concurrency slot (queues if all slots busy)
  const slotTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('QUEUE_TIMEOUT')), 60000)
  );
  try {
    await Promise.race([acquireSlot(), slotTimeout]);
  } catch (e) {
    if (e.message === 'QUEUE_TIMEOUT') {
      return res.status(504).json({ error: 'Request timed out, please try again' });
    }
    throw e;
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Disable JS execution (not needed for static HTML)
    await page.setJavaScriptEnabled(false);

    // Set viewport to A4-ish size for consistent rendering
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });

    // Build font CSS inline (no network requests needed)
    let fontCSS = await getFontCSS('Inter');
    if (fontFamily && fontFamily !== 'Inter' && FONT_URLS[fontFamily]) {
      fontCSS += '\n' + await getFontCSS(fontFamily);
    }

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    ${fontCSS}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: white; }
    ${css || ''}
  </style>
</head>
<body>
  ${html}
</body>
</html>`;

    // setContent with domcontentloaded is faster — fonts are inlined
    await page.setContent(fullHtml, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Generate PDF
    const pdf = await page.pdf({
      format: format === 'Letter' ? 'letter' : 'a4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false,
    });

    const pdfBuffer = Buffer.from(pdf);
    const elapsed = Date.now() - startTime;
    console.log(`PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)}KB in ${elapsed}ms`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error) {
    console.error('PDF generation error:', error.message);
    // If browser crashed, reset it for next request
    if (error.message && (error.message.includes('detached') || error.message.includes('closed') || error.message.includes('crashed'))) {
      try { if (browser) await browser.close(); } catch {}
      browser = null;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF generation failed' });
    }
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    releaseSlot();
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────────────

async function shutdown() {
  console.log('Shutting down...');
  if (browser) {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Keep Alive (prevent Render free tier sleep) ────────────────────

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL; // e.g. https://yourcv-pdf-service.onrender.com
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutes

function startKeepAlive() {
  if (!KEEP_ALIVE_URL) return;
  setInterval(async () => {
    try {
      await fetch(`${KEEP_ALIVE_URL}/health`);
    } catch {}
  }, KEEP_ALIVE_INTERVAL);
  console.log(`Keep-alive enabled: pinging ${KEEP_ALIVE_URL} every 14min`);
}

// ─── Start Server ───────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT} (max concurrent: ${MAX_CONCURRENT})`);
  // Pre-warm browser + font cache in parallel
  Promise.all([getBrowser(), prewarmFontCache()])
    .then(() => {
      console.log('Ready');
      startKeepAlive();
    })
    .catch((err) => console.error('Warmup error:', err.message));
});
