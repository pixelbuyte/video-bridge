const express = require('express');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist
[DOWNLOADS_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Job state store (in-memory)
const jobs = {};

// Resolve yt-dlp binary path
const YTDLP_PATH = (() => {
  const candidates = [
    'yt-dlp',
    path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.14-64', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.APPDATA || '', 'Python', 'Scripts', 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    try {
      const resolved = require('child_process').execSync(`where ${c.includes(' ') ? '"' + c + '"' : c} 2>nul`, { encoding: 'utf8' }).trim().split('\n')[0];
      if (resolved) return resolved;
    } catch (_) {}
    if (c !== 'yt-dlp' && fs.existsSync(c)) return c;
  }
  return 'yt-dlp'; // fallback, rely on PATH
})();

// GET / — homepage
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>video-bridge</title>
<style>body{font-family:monospace;max-width:600px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
h1{color:#fff}a{color:#7cf}table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:6px 10px;border-bottom:1px solid #333}th{color:#aaa}</style></head>
<body><h1>video-bridge</h1><p>Server is running.</p>
<table><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
<tr><td>GET</td><td><a href="/status">/status</a></td><td>All jobs, downloads, outputs</td></tr>
<tr><td>POST</td><td>/download</td><td>Start a yt-dlp download</td></tr>
<tr><td>POST</td><td>/edit</td><td>Cut + concat clips with FFmpeg</td></tr>
<tr><td>GET</td><td>/job/:jobId</td><td>Poll a specific job</td></tr>
<tr><td>GET</td><td>/file/:filename</td><td>Download an output file</td></tr>
</table></body></html>`);
});

// POST /download
app.post('/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'downloading', url, startedAt: new Date().toISOString() };

  const outputTemplate = path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s');
  const args = [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    url,
  ];

  const proc = spawn(YTDLP_PATH, args);
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });

  proc.on('close', code => {
    if (code !== 0) {
      jobs[jobId] = { status: 'error', error: stderr.slice(-500), completedAt: new Date().toISOString() };
      return;
    }
    // Find the newest file in downloads
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    const latestFile = files.length ? path.join(DOWNLOADS_DIR, files[0].name) : null;
    jobs[jobId] = { status: 'done', filePath: latestFile, completedAt: new Date().toISOString() };
  });

  res.json({ jobId, status: 'downloading', message: 'Download started' });
});

// POST /edit
app.post('/edit', async (req, res) => {
  const { filePath, clips } = req.body;

  if (!filePath || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'Missing filePath or clips array' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }

  const jobId = uuidv4();
  jobs[jobId] = { status: 'editing', startedAt: new Date().toISOString() };
  res.json({ jobId, status: 'editing', message: 'Edit job started' });

  try {
    const tempFiles = [];

    // Step 1: Cut each clip
    for (let i = 0; i < clips.length; i++) {
      const { start, end } = clips[i];
      const tempOut = path.join(OUTPUT_DIR, `clip_${jobId}_${i}.mp4`);
      tempFiles.push(tempOut);
      await runFfmpeg([
        '-y',
        '-i', filePath,
        '-ss', String(start),
        '-to', String(end),
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
        tempOut,
      ]);
    }

    // Step 2: Concatenate clips
    const concatList = path.join(OUTPUT_DIR, `concat_${jobId}.txt`);
    fs.writeFileSync(concatList, tempFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    const outputFile = path.join(OUTPUT_DIR, `output_${jobId}.mp4`);
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      outputFile,
    ]);

    // Cleanup temp clips and concat list
    tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.unlinkSync(concatList); } catch (_) {}

    jobs[jobId] = {
      status: 'done',
      outputFile,
      url: `http://localhost:${PORT}/file/${path.basename(outputFile)}`,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    jobs[jobId] = { status: 'error', error: String(err), completedAt: new Date().toISOString() };
  }
});

// GET + POST /status (GET so it works in browser too)
const statusHandler = (req, res) => {
  const downloads = fs.existsSync(DOWNLOADS_DIR) ? fs.readdirSync(DOWNLOADS_DIR) : [];
  const outputs = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR) : [];
  res.json({
    jobs,
    downloads: downloads.map(f => ({
      name: f,
      path: path.join(DOWNLOADS_DIR, f),
      size: fs.statSync(path.join(DOWNLOADS_DIR, f)).size,
    })),
    outputs: outputs.map(f => ({
      name: f,
      path: path.join(OUTPUT_DIR, f),
      url: `http://localhost:${PORT}/file/${f}`,
      size: fs.statSync(path.join(OUTPUT_DIR, f)).size,
    })),
  });
};
app.get('/status', statusHandler);
app.post('/status', statusHandler);

// GET /file/:filename
app.get('/file/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// GET /job/:jobId — convenience endpoint to poll a specific job
app.get('/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Helper: run ffmpeg with args, return promise
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
    const proc = spawn(ffmpegBin, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`));
      else resolve();
    });
  });
}

app.listen(PORT, () => {
  console.log(`video-bridge running at http://localhost:${PORT}`);
  console.log(`  Downloads: ${DOWNLOADS_DIR}`);
  console.log(`  Output:    ${OUTPUT_DIR}`);
  console.log(`  yt-dlp:    ${YTDLP_PATH}`);
  console.log(`  FFmpeg:    ${process.env.FFMPEG_PATH || 'ffmpeg (from PATH)'}`);
});
