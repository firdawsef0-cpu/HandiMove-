if (typeof fetch !== 'function' || typeof AbortSignal?.timeout !== 'function') {
  console.error('\nVotre version de Node.js est trop ancienne (' + process.version + '). Installez Node.js 18 ou plus récent : https://nodejs.org\n');
  process.exit(1);
}
const http = require('http');
const fs = require('fs');
const path = require('path');

// Réglages locaux optionnels dans .env (aucun paquet npm nécessaire).
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const PORT = Number(process.env.PORT || 3000);
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL_OVERRIDE = (process.env.OLLAMA_MODEL || '').trim();
const ROOT = __dirname;
const MAX_BODY = 100 * 1024;

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) { reject(new Error('Message trop volumineux')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}

async function getModel() {
  if (MODEL_OVERRIDE) return MODEL_OVERRIDE;
  const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Ollama ne répond pas correctement');
  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models : [];
  if (!models.length) throw new Error('Aucun modèle Ollama installé. Lancez d’abord « ollama run NOM_DU_MODELE ».');
  return models[0].name;
}

const systemPrompt = `Tu es HandiMove IA, l’assistant conversationnel d’une plateforme marocaine de sport adapté et inclusif, pensée notamment pour les personnes à mobilité réduite. Réponds de façon chaleureuse, claire, respectueuse et accessible. Réponds dans la langue de la question (français, arabe ou darija marocaine si possible). Aide à comprendre l’interface, les fonctionnalités, les programmes et l’accessibilité. Ne prétends pas connaître des données privées ou des contenus qui ne t’ont pas été fournis. Pour les questions médicales, diagnostics, douleurs ou rééducation individuelle, donne uniquement des informations générales et recommande de demander l’avis d’un professionnel de santé ou d’un enseignant APA. Ne propose pas d’exercices risqués ni de garanties de résultat. N’affirme pas que tu es médecin.`;

async function handleChat(req, res) {
  try {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message) return send(res, 400, { error: 'Écrivez une question avant de l’envoyer.' });
    if (message.length > 6000) return send(res, 413, { error: 'La question est trop longue (maximum 6000 caractères).' });

    const model = await getModel();
    const history = Array.isArray(body.history)
      ? body.history.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 3000) }))
      : [];
    const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: message }];

    // "/no_think" désactive le mode réflexion des modèles qui le gèrent (ex. Qwen3) pour répondre plus vite.
    const fastMessages = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user' ? { ...m, content: '/no_think\n' + m.content } : m
    );

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: fastMessages,
        stream: false,
        keep_alive: '30m',
options: {
  temperature: 0.4,
  num_predict: 150,
  num_ctx: 2048
}
      }),
      signal: AbortSignal.timeout(180000)
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      return send(res, 502, { error: `Erreur Ollama (${response.status}). ${details.slice(0, 300)}` });
    }
    const data = await response.json();
    let reply = data?.message?.content?.trim();
    // Retire un éventuel bloc <think>...</think> renvoyé par certains modèles.
    if (reply) reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!reply) return send(res, 502, { error: 'Le modèle local n’a pas renvoyé de réponse.' });
    return send(res, 200, { reply, model });
  } catch (error) {
    const msg = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'Ollama met trop de temps à répondre. Essayez une question plus courte ou un modèle plus léger.'
      : (error.message || 'Impossible de contacter Ollama.');
    return send(res, 503, { error: msg });
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon'
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  // Empêche de sortir du dossier du projet.
  if (!filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Accès refusé', 'text/plain; charset=utf-8');
  // Ne jamais exposer le code serveur ni les réglages locaux.
  const base = path.basename(filePath).toLowerCase();
  if (base === 'server.js' || base === '.env' || base.endsWith('.sql')) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
    const type = mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/status') {
    try {
      const model = await getModel();
      return send(res, 200, { available: true, model, provider: 'Ollama local' });
    } catch (e) {
      return send(res, 200, { available: false, error: e.message, provider: 'Ollama local' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);

  return send(res, 405, { error: 'Méthode non autorisée' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nHandiMove IA est lancé : http://127.0.0.1:' + PORT);
  console.log('Ollama attendu sur : ' + OLLAMA_URL);
  console.log('Modèle : ' + (MODEL_OVERRIDE || 'détection automatique du premier modèle installé'));
  console.log('Gardez cette fenêtre du terminal ouverte. Ctrl+C pour arrêter.\n');
});
