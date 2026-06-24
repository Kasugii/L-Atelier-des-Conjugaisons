/* ============================================================
   Serveur EDM — PvP live + leaderboard partagé
   Déploiement Render : Node.js. Dépendance unique : "ws".
   ============================================================ */
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// ---- état en mémoire ----
const leaderboard = {};            // { pseudo: score }
const players = new Map();         // ws -> { pseudo }
const duels = new Map();           // code -> { host, guest, theme }

function topBoard(n = 20) {
  return Object.entries(leaderboard)
    .map(([pseudo, score]) => ({ pseudo, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of players.keys()) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
function sendBoard() { broadcast({ type: "board", board: topBoard() }); }

// ---- HTTP (Render a besoin d'un port ouvert + health check) ----
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("EDM server OK\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  players.set(ws, { pseudo: null });
  ws.send(JSON.stringify({ type: "board", board: topBoard() }));

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const me = players.get(ws);

    switch (m.type) {
      case "hello":
        me.pseudo = String(m.pseudo || "Anonyme").slice(0, 16);
        if (!(me.pseudo in leaderboard)) leaderboard[me.pseudo] = 0;
        sendBoard();
        break;

      case "score":
        // score absolu envoyé par le client (meilleur score conservé)
        if (me.pseudo) {
          const s = Math.max(0, Math.min(99999, m.score | 0));
          if (s > (leaderboard[me.pseudo] || 0)) leaderboard[me.pseudo] = s;
          sendBoard();
        }
        break;

      // --- duel : l'hôte crée une partie ---
      case "duel_create": {
        const code = Math.random().toString(36).slice(2, 6).toUpperCase();
        duels.set(code, { host: ws, guest: null, theme: m.theme });
        ws.send(JSON.stringify({ type: "duel_created", code, theme: m.theme }));
        break;
      }
      // --- duel : l'invité rejoint avec le code ---
      case "duel_join": {
        const d = duels.get(m.code);
        if (!d) { ws.send(JSON.stringify({ type: "duel_error", msg: "Code introuvable." })); break; }
        if (d.guest) { ws.send(JSON.stringify({ type: "duel_error", msg: "Duel déjà complet." })); break; }
        d.guest = ws;
        const start = { type: "duel_start", theme: d.theme,
          hostName: players.get(d.host)?.pseudo || "Hôte",
          guestName: me.pseudo || "Invité" };
        d.host.send(JSON.stringify({ ...start, role: "host" }));
        d.guest.send(JSON.stringify({ ...start, role: "guest" }));
        break;
      }
      // --- duel : un joueur répond, on relaie son avancement à l'adversaire ---
      case "duel_progress": {
        const d = duels.get(m.code);
        if (!d) break;
        const other = (ws === d.host) ? d.guest : d.host;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: "duel_opp", q: m.q, correct: m.correct, score: m.score }));
        }
        break;
      }
      // --- duel : fin de partie d'un joueur ---
      case "duel_done": {
        const d = duels.get(m.code);
        if (!d) break;
        const other = (ws === d.host) ? d.guest : d.host;
        if (other && other.readyState === 1) {
          other.send(JSON.stringify({ type: "duel_opp_done", score: m.score }));
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    // prévenir l'adversaire si un duel était en cours
    for (const [code, d] of duels) {
      if (d.host === ws || d.guest === ws) {
        const other = (d.host === ws) ? d.guest : d.host;
        if (other && other.readyState === 1) other.send(JSON.stringify({ type: "duel_left" }));
        duels.delete(code);
      }
    }
    players.delete(ws);
  });
});

server.listen(PORT, () => console.log("EDM server on :" + PORT));
