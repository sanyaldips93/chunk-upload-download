Crash-Resilient Chunk-Based Deduplicating File Store (Node .js)
Tiny proof-of-concept server that:

Accepts large binary uploads (PDFs only).

Splits each file into fixed-size 1 MB (configurable) chunks.

Stores every unique chunk exactly once on disk (./chunks/).

Saves a tiny JSON manifest per file (./manifests/) that records the ordered list of chunk hashes.

After a crash or restart, rebuilds all in-memory indexes by scanning those manifests—so deduplication continues to work with no external database.

Reconstructs and streams any stored file on demand.

Project layout
text
chunk-uploader/
├── server.js        ← main application
├── package.json
├── chunks/          ← binary chunk blobs   (auto-created)
└── manifests/       ← per-file JSON docs  (auto-created)
Prerequisites
Node .js 16 + (or 14 + with ES2019 support)

npm (comes with Node)

Quick start
bash
git clone <repo-or-paste-code> chunk-uploader
cd pdffileuploader
npm install
npm start              # server listens on http://localhost:3000



API reference
1. POST /upload
Uploads a file and stores only brand-new chunks.

Content-Type: multipart/form-data

Form field: pdfFile (keep the name even for videos—rename in code if you wish)

Example with curl:

bash
curl -F "pdfFile=@/path/to/MyDoc.pdf" http://localhost:3000/upload
Success response:

json
{
  "message": "Upload stored (new chunks written)",
  "filename": "MyDoc.pdf",
  "chunkCount": 3
}
If the content already exists you’ll see:

json
{
  "message": "Duplicate content – no chunk rewrite needed",
  "filename": "MyDoc.pdf",
  "chunkCount": 3
}
2. GET /download/:filename
Re-assembles the requested file from its chunks and streams it back.

bash
curl -O -J http://localhost:3000/download/MyDoc.pdf
Headers:

text
Content-Type: application/pdf   # or original MIME type
Content-Disposition: inline; filename="MyDoc.pdf"
In Postman choose Send and Download if you don’t want to view raw bytes.

3. GET /list
Returns every filename currently known to the server (handy for testing).

bash
curl http://localhost:3000/list
["MyDoc.pdf"]
How it works
Chunk & hash

1 MB (1024 × 1024 bytes) slices

Hash = SHA-256 (crypto.createHash('sha256')…)

Deduplicate

Chunk written only if <hash>.chunk does not exist.

Whole-file signature = all chunk hashes concatenated.

Set fileSignatures blocks re-ingestion of byte-for-byte duplicates.

Persist metadata

After every successful upload a manifest like
manifests/MyDoc.pdf.json

json
{
  "filename": "MyDoc.pdf",
  "signature": "<hash1-hash2-…>",
  "chunkHashes": ["hash1","hash2",…]
}
is flushed to disk.

Crash recovery (bootstrap() on startup)

Reads every manifest file.

Rebuilds fileMeta (filename → hashes) and fileSignatures.

Logs:

text
Bootstrapped 42 file records; 17 unique signatures
Download

Looks up chunk list, fs.readFileSync’s each <hash>.chunk, Buffer.concat, streams result.

Configuration knobs
Environment variable	Default	Meaning
PORT	3000	HTTP listen port
CHUNK_SIZE	1048576	bytes per chunk (change only if you wipe existing data)
MAX_FILE_SIZE	2147483648	2 GB upload cap (set in multer)
Change them by editing server.js or exporting env vars before npm start.

Limitations / TODO
Single process / single host – no clustering; use a DB/DHT for multi-node dedup.

Manifests load into RAM – fine for thousands of files; migrate to SQLite/LevelDB for millions.

No authentication – anybody can upload/download.

No virus scanning / MIME validation – add as middleware if your use-case demands it.

Fixed-size chunks – switch to content-defined chunking for better overlap on edited videos.

Extending
Persist to SQLite – Replace the manifest scan with SQL tables for O(1) startup.

Content-type aware – Store req.file.mimetype in the manifest and send it back in the download route.

Resumable uploads – Accept chunk streams one-by-one and commit manifests when all pieces arrive.

S3 / GCS backend – Write chunks to object storage; keep only the manifest DB local.

JWT auth + user quotas – Track who owns which files, throttle by storage used.

License
MIT – do anything you want, at your own risk.
