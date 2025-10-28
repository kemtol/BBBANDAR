const fs = require('fs');
const path = require('path');

const beritaDir = path.join(__dirname, '..', 'berita');
const outFile = path.join(beritaDir, 'index.html');

function stripTags(s){ return s.replace(/<[^>]*>/g,'').trim(); }

function extractMeta(content){
  let titleMatch = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let title = titleMatch ? stripTags(titleMatch[1]) : null;

  // look for a div or p with class text-muted and small
  let dateMatch = content.match(/<div[^>]*class="[^"]*text-muted[^"]*small[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
                || content.match(/<p[^>]*class="[^"]*text-muted[^"]*small[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  let date = dateMatch ? stripTags(dateMatch[1]) : null;

  // fallback: first <p> text
  if(!date){
    let pMatch = content.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if(pMatch) date = stripTags(pMatch[1]).slice(0,80) + '...';
  }

  return { title, date };
}

(async function(){
  const files = await fs.promises.readdir(beritaDir);
  const htmlFiles = files.filter(f => f.endsWith('.html') && f !== 'index.html' && f !== 'view.html');

  const items = [];
  for(const file of htmlFiles){
    try{
      const content = await fs.promises.readFile(path.join(beritaDir, file), 'utf8');
      const meta = extractMeta(content);
      items.push({ file, title: meta.title || file, date: meta.date || '' });
    }catch(e){
      console.error('read error', file, e.message);
    }
  }

  // sort by filename (could be improved by date parsing)
  items.sort((a,b) => a.file.localeCompare(b.file));

  const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#ffffff">
  <link rel="manifest" href="/site.webmanifest">
  <title>Berita — BBBANDAR</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" rel="stylesheet">
  <link rel="stylesheet" href="/style.css?v=1.4">
</head>
<body>
  <div class="container my-4">
    <a href="/" class="d-inline-block mb-3" style="text-decoration:none;color:var(--primary);">← Kembali ke Beranda</a>

    <h1 class="mb-4">Berita & Analisis</h1>

    <ul class="list-unstyled">
${items.map(it => `      <li class="mb-3">
        <a href="/berita/view.html?src=${encodeURIComponent(it.file)}" class="text-decoration-none">
          <strong>${it.title}</strong>
          <div class="text-muted small">${it.date}</div>
        </a>
      </li>`).join('\n')}
    </ul>

    <div class="text-center mt-4">
      ${items.length === 0 ? '<span class="text-muted">Tidak ada artikel saat ini.</span>' : '<span class="text-muted">Menampilkan semua artikel di folder /berita/</span>'}
    </div>

  </div>

  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/script.js?v=1.5"></script>
</body>
</html>`;

  await fs.promises.writeFile(outFile, html, 'utf8');
  console.log('Wrote', outFile, 'with', items.length, 'items');
})();
