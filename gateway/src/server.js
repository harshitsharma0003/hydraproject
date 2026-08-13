'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '8mb' }));   // sync batches
app.use(cors({
  origin: (origin, cb) => cb(null, true),  // per-key origin lock happens in auth
  credentials: false
}));

app.get('/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

// Contract is versioned so a gateway deploy cannot break a cartridge in the field.
app.use('/v1', require('./routes/query'));
app.use('/v1', require('./routes/refine'));
app.use('/v1', require('./routes/sync'));
app.use('/v1', require('./routes/discover'));
app.use('/v1', require('./routes/event'));
app.use('/v1', require('./routes/health'));
app.use('/v1', require('./routes/bulk'));
app.use('/v1', require('./routes/provision').router);
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/portal').router);
app.use('/api', require('./routes/admin').router);

app.use((err, req, res, next) => {
  console.error('[hydra]', err);
  // Storefront callers treat any non-ok as "fall back to native search",
  // so a 500 here degrades gracefully rather than breaking a page.
  res.status(500).json({ ok: false, error: 'internal' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Hydra gateway on :${port}`));
