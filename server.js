/*
 * server.js  (crash-resilient, disk-rehydrated chunk store)
 * ------------------------------------------------------------------
 * Endpoints:
 *   POST /upload           (form-data field: pdfFile OR videoFile)
 *   GET  /download/:name   (reconstruct & stream original file)
 *   GET  /list             (helper: list all remembered filenames)
 */

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3000;

/* ────────────────────────────────────────────────────────────
 * 1. Directories
 * ──────────────────────────────────────────────────────────── */
const rootDir     = __dirname;
const chunksDir   = path.join(rootDir, 'chunks');     // chunk blobs
const manifestDir = path.join(rootDir, 'manifests');  // per-file JSON manifests

for (const d of [chunksDir, manifestDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d);
}

/* ────────────────────────────────────────────────────────────
 * 2. In-memory indexes (rebuilt at startup)
 * ──────────────────────────────────────────────────────────── */
const CHUNK_SIZE     = 10 * 10; // 1 MB
const fileMeta       = new Map();   // filename  → { signature, chunkHashes[] }
const fileSignatures = new Set();   // every unique signature we’ve ever stored

bootstrap();

/* ────────────────────────────────────────────────────────────
 * 3. Multer – accept up to 2 GB for any binary file
 *    (keep pdfFile for backward-compat; you may rename)
 * ──────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (req, file, cb) => cb(null, true)  // accept any mimetype
});

/* ────────────────────────────────────────────────────────────
 * 4. Helpers
 * ──────────────────────────────────────────────────────────── */
function chunkAndHash(buf) {
  const out = [];
  for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
    const slice = buf.slice(off, off + CHUNK_SIZE);
    const hash  = crypto.createHash('sha256').update(slice).digest('hex');
    out.push({ hash, data: slice });
  }
  return out;
}

function safeName(name) {
  // simple basename sanitiser (no path traversal)
  return path.basename(name);
}

function saveManifest(filename, signature, chunkHashes) {
  const fn = path.join(manifestDir, `${filename}.json`);
  fs.writeFileSync(fn,
    JSON.stringify({ filename, signature, chunkHashes }, null, 2));
}

/* ────────────────────────────────────────────────────────────
 * 5. POST /upload
 * ──────────────────────────────────────────────────────────── */
app.post('/upload', upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (use field "pdfFile")' });

  const buffer       = req.file.buffer;
  const originalName = safeName(req.file.originalname || 'unnamed');
  const chunks       = chunkAndHash(buffer);
  const hashes       = chunks.map(c => c.hash);
  const signature    = hashes.join('-');

  // 5a. write any brand-new chunks
  let wroteSomething = false;
  if (!fileSignatures.has(signature)) {
    chunks.forEach(({ hash, data }) => {
      const p = path.join(chunksDir, `${hash}.chunk`);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, data);
        wroteSomething = true;
      }
    });
    fileSignatures.add(signature);
  }

  // 5b. record/overwrite manifest for this filename
  fileMeta.set(originalName, { signature, chunkHashes: hashes });
  saveManifest(originalName, signature, hashes);

  return res.json({
    message   : wroteSomething
               ? 'Upload stored (new chunks written)'
               : 'Duplicate content – no chunk rewrite needed',
    filename  : originalName,
    chunkCount: hashes.length
  });
});

/* ────────────────────────────────────────────────────────────
 * 6. GET /download/:filename
 * ──────────────────────────────────────────────────────────── */
app.get('/download/:filename', (req, res) => {
  const name = safeName(req.params.filename);
  const meta = fileMeta.get(name);
  if (!meta) return res.status(404).json({ error: 'Unknown filename' });

  try {
    const buffers = meta.chunkHashes.map(h => {
      const p = path.join(chunksDir, `${h}.chunk`);
      if (!fs.existsSync(p)) throw new Error(`Missing chunk ${h}`);
      return fs.readFileSync(p);
    });

    res.set({
      'Content-Type'       : 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`
    });
    return res.send(Buffer.concat(buffers));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to reconstruct file' });
  }
});

/* ────────────────────────────────────────────────────────────
 * 7. Helper – list all known filenames
 * ──────────────────────────────────────────────────────────── */
app.get('/list', (req, res) => res.json([...fileMeta.keys()]));

/* ────────────────────────────────────────────────────────────
 * 8. Error handler
 * ──────────────────────────────────────────────────────────── */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

/* ────────────────────────────────────────────────────────────
 * 9. Server start
 * ──────────────────────────────────────────────────────────── */
app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);

/* ────────────────────────────────────────────────────────────
 * 10.  BOOTSTRAP  – re-hydrate maps from disk
 * ──────────────────────────────────────────────────────────── */
function bootstrap() {
  // 10a. load manifests → rebuild fileMeta + fileSignatures
  fs.readdirSync(manifestDir).forEach(file => {
    if (!file.endsWith('.json')) return;
    try {
      const { filename, signature, chunkHashes } =
        JSON.parse(fs.readFileSync(path.join(manifestDir, file)));
      fileMeta.set(filename, { signature, chunkHashes });
      fileSignatures.add(signature);
    } catch (_) { /* ignore corrupt manifest */ }
  });

  console.log(`Bootstrapped ${fileMeta.size} file records; `
            + `${fileSignatures.size} unique signatures`);
}
