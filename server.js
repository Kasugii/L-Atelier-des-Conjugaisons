/* =========================================================================
   L'ATELIER DES CONJUGAISONS — Serveur de Liaison (PvP / Échanges / Raid coop)
   -------------------------------------------------------------------------
   Serveur unique Node + WebSocket. AUCUNE base de données nécessaire.
   - Duel PvP 1v1 (salon à code ou match rapide), tour par tour, autoritatif serveur.
   - Échanges d'objets / skins / familiers (PAS de personnages), à double validation.
   - Raid coop temps réel à 2 contre un boss hebdomadaire + ses sbires.
   Déploiement : voir README.md (Render, gratuit).
   ========================================================================= */
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.get('/', (_req, res) => res.send('Atelier — Tour de Liaison : en ligne ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ----------------------------- utilitaires ----------------------------- */
const STRONG = { feu: 'vent', vent: 'terre', terre: 'eau', eau: 'feu', lumiere: null };
function elMult(a, d) {
  if (!a || !d) return 1;
  if (STRONG[a] === d) return 1.5;
  if (STRONG[d] === a) return 0.75;
  return 1;
}
function rid(n = 4) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function roomSend(room, obj) { room.members.forEach(m => send(m.ws, obj)); }

/* ------------------------ boss hebdomadaire (déterministe) ------------------------ */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = d.getTime();
  d.setUTCMonth(0, 1);
  if (d.getUTCDay() !== 4) d.setUTCMonth(0, 1 + ((4 - d.getUTCDay()) + 7) % 7);
  return 1 + Math.ceil((firstThursday - d.getTime()) / 604800000);
}
const WEEKLY_BOSSES = [
  { nom: 'Le Colosse de Parchemin',  el: 'terre',   icon: '🗿' },
  { nom: 'Le Léviathan d\'Encre',    el: 'eau',     icon: '🐉' },
  { nom: 'La Salamandre des Braises',el: 'feu',     icon: '🔥' },
  { nom: 'Le Roi des Tempêtes',      el: 'vent',    icon: '🌪️' },
  { nom: 'L\'Astre Déchu',           el: 'lumiere', icon: '🌟' },
];
const RAID_MOBS = [
  { nom: 'Page Maudite',  el: 'lumiere', icon: '📜' },
  { nom: 'Encrelin',      el: 'eau',     icon: '🫧' },
  { nom: 'Braisillon',    el: 'feu',     icon: '✨' },
];
function weeklyRaidId() {
  const now = new Date();
  return now.getUTCFullYear() * 100 + isoWeek(now);
}
function buildRaidEnemies(playerCount) {
  const seed = weeklyRaidId();
  const boss = WEEKLY_BOSSES[seed % WEEKLY_BOSSES.length];
  const scale = 1 + (playerCount - 1) * 0.6;
  const enemies = [{
    key: 'boss', nom: boss.nom, el: boss.el, icon: boss.icon, boss: true,
    hpMax: Math.round((1400 + (seed % 7) * 120) * scale),
    atk: 34 + (seed % 5) * 3,
  }];
  const mobN = 1 + (seed % 2); // 1 ou 2 sbires
  for (let i = 0; i < mobN; i++) {
    const m = RAID_MOBS[(seed + i) % RAID_MOBS.length];
    enemies.push({
      key: 'mob' + i, nom: m.nom, el: m.el, icon: m.icon, boss: false,
      hpMax: Math.round((260 + (seed % 4) * 30) * scale), atk: 16 + (seed % 4) * 2,
    });
  }
  enemies.forEach(e => { e.hp = e.hpMax; });
  return { id: seed, name: boss.nom, enemies };
}

/* ============================== ÉTAT GLOBAL ============================== */
const rooms = new Map();   // code -> room
let duelQueue = null;      // {ws, roster} en attente de match rapide

function makeRoom(kind, hostWs, host) {
  const code = rid();
  const room = { code, kind, members: [{ ws: hostWs, ...host }], state: null, started: false };
  rooms.set(code, room);
  hostWs.roomCode = code;
  return room;
}
function leaveRoom(ws) {
  const code = ws.roomCode; if (!code) return;
  const room = rooms.get(code); if (!room) return;
  room.members = room.members.filter(m => m.ws !== ws);
  roomSend(room, { t: 'peer_left' });
  if (room.members.length === 0) rooms.delete(code);
  ws.roomCode = null;
}

/* =============================== COMBAT =============================== */
/* roster client : { pseudo, fighters:[{id,nom,el,art,hpMax,
     spells:[{id,nom,el,type,kind,icon,ppMax,power}]}] }  */

function initFighter(f) {
  const pp = {}; (f.spells || []).forEach(s => { pp[s.id] = s.ppMax; });
  return { id: f.id, nom: f.nom, el: f.el, art: f.art, hpMax: f.hpMax, hp: f.hpMax,
           shield: 0, spells: f.spells || [], pp };
}

/* ---- DUEL : 2 joueurs, 3 combattants chacun, actif/réserve ---- */
function startDuel(room) {
  room.started = true;
  const sides = room.members.map(m => ({
    pid: m.pid, pseudo: m.roster.pseudo || m.pseudo,
    fighters: (m.roster.fighters || []).slice(0, 3).map(initFighter), active: 0,
  }));
  room.state = { mode: 'duel', sides, turn: sides[Math.floor(Math.random() * 2)].pid, log: [], over: false };
  pushDuel(room, `Le duel commence ! ${activeName(sides[0])} vs ${activeName(sides[1])}.`);
}
function activeName(side) { const f = side.fighters[side.active]; return f ? f.nom : '?'; }
function duelSnapshot(s) {
  return { mode: 'duel', turn: s.turn, over: s.over, winner: s.winner || null,
    sides: s.sides.map(sd => ({ pid: sd.pid, pseudo: sd.pseudo, active: sd.active,
      fighters: sd.fighters.map(f => ({ id: f.id, nom: f.nom, el: f.el, art: f.art,
        hp: f.hp, hpMax: f.hpMax, shield: f.shield,
        spells: f.spells.map(sp => ({ ...sp, pp: f.pp[sp.id] })) })) })) };
}
function pushDuel(room, msg) {
  const s = room.state; if (msg) s.log.push(msg);
  roomSend(room, { t: 'combat_state', snap: duelSnapshot(s), log: msg });
}
function duelAction(room, ws, act) {
  const s = room.state; if (!s || s.over) return;
  const me = s.sides.find(x => x.pid === ws.pid);
  const foe = s.sides.find(x => x.pid !== ws.pid);
  if (!me || s.turn !== ws.pid) { send(ws, { t: 'error', msg: "Ce n'est pas ton tour." }); return; }

  if (act.type === 'switch') {
    const i = act.index | 0;
    if (i === me.active || !me.fighters[i] || me.fighters[i].hp <= 0) return;
    me.active = i;
    s.turn = foe.pid;
    pushDuel(room, `${me.pseudo} envoie ${me.fighters[i].nom} !`);
    if (!maybeDuelEnd(room)) pushDuel(room, null);
    return;
  }
  // sort
  const f = me.fighters[me.active]; const sp = f.spells.find(x => x.id === act.spellId);
  if (!sp) return;
  if (f.pp[sp.id] <= 0) { send(ws, { t: 'error', msg: 'Plus de PP.' }); return; }
  f.pp[sp.id]--;
  const tgt = foe.fighters[foe.active];
  if (sp.kind === 'attaque') {
    const variance = 0.6 + Math.random() * 0.5; const crit = Math.random() < 0.15;
    let dmg = sp.power * variance * elMult(sp.el, tgt.el); if (crit) dmg *= 1.4;
    dmg = Math.max(1, Math.round(dmg));
    if (tgt.shield > 0) { const ab = Math.min(tgt.shield, dmg); tgt.shield -= ab; dmg -= ab; }
    tgt.hp = Math.max(0, tgt.hp - dmg);
    pushDuel(room, `${sp.icon} ${f.nom} lance ${sp.nom} : ${crit ? 'CRITIQUE ! ' : ''}${dmg} dégâts à ${tgt.nom}.`);
  } else if (sp.kind === 'soin') {
    const heal = Math.round(sp.power * (0.6 + Math.random() * 0.5));
    f.hp = Math.min(f.hpMax, f.hp + heal);
    pushDuel(room, `💚 ${f.nom} récupère ${heal} PV.`);
  } else {
    const sh = Math.round(sp.power * (0.7 + Math.random() * 0.5)); f.shield += sh;
    pushDuel(room, `🛡️ ${f.nom} se protège (+${sh}).`);
  }
  // KO de l'adversaire actif -> switch auto
  if (tgt.hp <= 0) {
    const next = foe.fighters.findIndex(x => x.hp > 0);
    if (next >= 0) { foe.active = next; pushDuel(room, `${tgt.nom} est K.O. ! ${foe.pseudo} envoie ${foe.fighters[next].nom}.`); }
  }
  s.turn = foe.pid;
  if (!maybeDuelEnd(room)) pushDuel(room, null);
}
function maybeDuelEnd(room) {
  const s = room.state;
  s.sides.forEach(sd => {
    if (sd.fighters[sd.active].hp <= 0) {
      const n = sd.fighters.findIndex(x => x.hp > 0); if (n >= 0) sd.active = n;
    }
  });
  const dead = s.sides.filter(sd => sd.fighters.every(f => f.hp <= 0));
  if (dead.length) {
    s.over = true;
    const winner = s.sides.find(sd => sd.fighters.some(f => f.hp > 0));
    s.winner = winner ? winner.pid : null;
    pushDuel(room, winner ? `🏆 ${winner.pseudo} remporte le duel !` : 'Égalité !');
    roomSend(room, { t: 'combat_end', mode: 'duel', winner: s.winner });
    return true;
  }
  return false;
}

/* ---- RAID coop : N joueurs (1 combattant chacun) vs boss + sbires ---- */
function startRaid(room) {
  room.started = true;
  const players = room.members.map(m => {
    const f = initFighter((m.roster.fighters || [])[0] || { id: 'x', nom: m.pseudo, el: 'lumiere', hpMax: 120, spells: [] });
    return { pid: m.pid, pseudo: m.roster.pseudo || m.pseudo, fighter: f };
  });
  const raid = buildRaidEnemies(players.length);
  // ordre des tours : chaque joueur, puis les ennemis
  const order = players.map(p => p.pid).concat(['ENEMIES']);
  room.state = { mode: 'raid', raidId: raid.id, raidName: raid.name, players,
    enemies: raid.enemies, order, oi: 0, over: false, log: [], round: 1 };
  pushRaid(room, `Raid hebdomadaire : « ${raid.name} » ! Préparez vos sorts.`);
  advanceRaid(room, false);
}
function raidSnapshot(s) {
  return { mode: 'raid', raidName: s.raidName, raidId: s.raidId, round: s.round,
    turn: s.order[s.oi], over: s.over, win: s.win || false,
    players: s.players.map(p => ({ pid: p.pid, pseudo: p.pseudo,
      fighter: { id: p.fighter.id, nom: p.fighter.nom, el: p.fighter.el, art: p.fighter.art,
        hp: p.fighter.hp, hpMax: p.fighter.hpMax, shield: p.fighter.shield,
        spells: p.fighter.spells.map(sp => ({ ...sp, pp: p.fighter.pp[sp.id] })) } })),
    enemies: s.enemies.map(e => ({ key: e.key, nom: e.nom, el: e.el, icon: e.icon, boss: e.boss,
      hp: e.hp, hpMax: e.hpMax })) };
}
function pushRaid(room, msg) {
  const s = room.state; if (msg) s.log.push(msg);
  roomSend(room, { t: 'combat_state', snap: raidSnapshot(s), log: msg });
}
function advanceRaid(room, step = true) {
  const s = room.state; if (s.over) return;
  if (step) s.oi++;
  // boucle de tour, en sautant les joueurs K.O.
  let guard = 0;
  while (guard++ < 20) {
    if (s.oi >= s.order.length) { s.oi = 0; s.round++; }
    const who = s.order[s.oi];
    if (who === 'ENEMIES') { enemyRaidTurn(room); if (s.over) return; s.oi++; continue; }
    const p = s.players.find(x => x.pid === who);
    if (p && p.fighter.hp > 0) break;       // c'est au tour d'un joueur vivant
    s.oi++;                                  // joueur K.O. -> on saute
  }
  pushRaid(room, null);
}
function raidAction(room, ws, act) {
  const s = room.state; if (!s || s.over) return;
  if (s.order[s.oi] !== ws.pid) { send(ws, { t: 'error', msg: "Patiente, ce n'est pas ton tour." }); return; }
  const me = s.players.find(p => p.pid === ws.pid); const f = me.fighter;
  if (f.hp <= 0) { advanceRaid(room); return; }
  const sp = f.spells.find(x => x.id === act.spellId); if (!sp) return;
  if (f.pp[sp.id] <= 0) { send(ws, { t: 'error', msg: 'Plus de PP.' }); return; }
  f.pp[sp.id]--;

  if (sp.kind === 'attaque') {
    const e = s.enemies.find(x => x.key === act.target && x.hp > 0);
    if (!e) { f.pp[sp.id]++; send(ws, { t: 'error', msg: 'Cible invalide.' }); return; }
    const variance = 0.6 + Math.random() * 0.5; const crit = Math.random() < 0.15;
    let dmg = sp.power * variance * elMult(sp.el, e.el); if (crit) dmg *= 1.4;
    dmg = Math.max(1, Math.round(dmg)); e.hp = Math.max(0, e.hp - dmg);
    pushRaid(room, `${sp.icon} ${f.nom} frappe ${e.nom} : ${crit ? 'CRITIQUE ! ' : ''}${dmg} dégâts.`);
    if (e.hp <= 0) pushRaid(room, `💥 ${e.nom} est vaincu !`);
  } else {
    // soin / bouclier : cible un allié (ou soi)
    const ally = s.players.find(p => p.pid === act.target) || me;
    if (sp.kind === 'soin') {
      const heal = Math.round(sp.power * (0.6 + Math.random() * 0.5));
      ally.fighter.hp = Math.min(ally.fighter.hpMax, ally.fighter.hp + heal);
      pushRaid(room, `💚 ${f.nom} soigne ${ally.fighter.nom} (+${heal} PV).`);
    } else {
      const sh = Math.round(sp.power * (0.7 + Math.random() * 0.5)); ally.fighter.shield += sh;
      pushRaid(room, `🛡️ ${f.nom} protège ${ally.fighter.nom} (+${sh}).`);
    }
  }
  if (s.enemies.every(e => e.hp <= 0)) { endRaid(room, true); return; }
  advanceRaid(room);
}
function enemyRaidTurn(room) {
  const s = room.state;
  s.enemies.filter(e => e.hp > 0).forEach(e => {
    const alive = s.players.filter(p => p.fighter.hp > 0); if (!alive.length) return;
    const target = alive[Math.floor(Math.random() * alive.length)].fighter;
    let dmg = e.atk + Math.floor(Math.random() * 6); dmg *= elMult(e.el, target.el);
    dmg = Math.max(1, Math.round(dmg));
    if (target.shield > 0) { const ab = Math.min(target.shield, dmg); target.shield -= ab; dmg -= ab; }
    target.hp = Math.max(0, target.hp - dmg);
    pushRaid(room, `${e.icon} ${e.nom} attaque ${target.nom} : −${dmg} PV.`);
  });
  if (s.players.every(p => p.fighter.hp <= 0)) endRaid(room, false);
}
function endRaid(room, win) {
  const s = room.state; s.over = true; s.win = win;
  // récompense : jetons de raid proportionnels aux dégâts/participation
  const reward = win ? (8 + (s.raidId % 5)) : 2;
  pushRaid(room, win ? `🏆 Le raid est vaincu ! Chaque sorcière gagne ${reward} jetons 🎟️.`
                     : 'Votre équipe est tombée… retentez le raid !');
  roomSend(room, { t: 'combat_end', mode: 'raid', win, reward });
}

/* =============================== ÉCHANGES =============================== */
/* offre = liste d'objets { kind:'item'|'skin'|'familier', id, qty, nom } */
function tradeState(room) {
  return { codes: room.members.map(m => ({ pid: m.pid, pseudo: m.pseudo,
    offer: m.tradeOffer || [], locked: !!m.tradeLocked })) };
}
function pushTrade(room) { roomSend(room, { t: 'trade_state', snap: tradeState(room) }); }
function tradeTryComplete(room) {
  if (room.members.length === 2 && room.members.every(m => m.tradeLocked)) {
    const [a, b] = room.members;
    send(a.ws, { t: 'trade_done', give: a.tradeOffer || [], receive: b.tradeOffer || [] });
    send(b.ws, { t: 'trade_done', give: b.tradeOffer || [], receive: a.tradeOffer || [] });
    room.members.forEach(m => { m.tradeOffer = []; m.tradeLocked = false; });
    setTimeout(() => pushTrade(room), 100);
  }
}

/* ============================== CONNEXIONS ============================== */
wss.on('connection', (ws) => {
  ws.pid = rid(8);
  send(ws, { t: 'welcome', pid: ws.pid, weeklyRaid: weeklyRaidId() });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const me = room ? room.members.find(m => m.ws === ws) : null;

    switch (msg.t) {
      case 'hello': ws.pseudo = (msg.pseudo || 'Sorcière').slice(0, 16); break;

      /* -------- création / jointure de salon -------- */
      case 'create': {
        leaveRoom(ws);
        const r = makeRoom(msg.kind, ws, { pid: ws.pid, pseudo: ws.pseudo, roster: msg.roster });
        send(ws, { t: 'room', code: r.code, kind: r.kind, host: true });
        break;
      }
      case 'join': {
        const r = rooms.get((msg.code || '').toUpperCase());
        if (!r) { send(ws, { t: 'error', msg: 'Salon introuvable.' }); break; }
        if (r.kind === 'duel' && r.members.length >= 2) { send(ws, { t: 'error', msg: 'Salon complet.' }); break; }
        if (r.kind === 'raid' && r.members.length >= 2) { send(ws, { t: 'error', msg: 'Raid complet.' }); break; }
        if (r.kind === 'trade' && r.members.length >= 2) { send(ws, { t: 'error', msg: 'Échange complet.' }); break; }
        leaveRoom(ws); ws.roomCode = r.code;
        r.members.push({ ws, pid: ws.pid, pseudo: ws.pseudo, roster: msg.roster });
        roomSend(r, { t: 'room', code: r.code, kind: r.kind,
          peers: r.members.map(m => m.pseudo) });
        if (r.kind === 'duel' && r.members.length === 2) startDuel(r);
        if (r.kind === 'raid' && r.members.length === 2) startRaid(r);
        if (r.kind === 'trade') pushTrade(r);
        break;
      }
      case 'leave': leaveRoom(ws); break;

      /* -------- match rapide duel -------- */
      case 'quick': {
        leaveRoom(ws);
        if (duelQueue && duelQueue.ws.readyState === 1 && duelQueue.ws !== ws) {
          const host = duelQueue; duelQueue = null;
          const r = makeRoom('duel', host.ws, { pid: host.ws.pid, pseudo: host.ws.pseudo, roster: host.roster });
          ws.roomCode = r.code;
          r.members.push({ ws, pid: ws.pid, pseudo: ws.pseudo, roster: msg.roster });
          roomSend(r, { t: 'room', code: r.code, kind: 'duel', peers: r.members.map(m => m.pseudo) });
          startDuel(r);
        } else {
          duelQueue = { ws, roster: msg.roster };
          send(ws, { t: 'queued' });
        }
        break;
      }
      case 'quick_cancel': if (duelQueue && duelQueue.ws === ws) duelQueue = null; break;

      /* -------- actions de combat -------- */
      case 'combat_action': {
        if (!room || !room.state) break;
        if (room.state.mode === 'duel') duelAction(room, ws, msg.act);
        else if (room.state.mode === 'raid') raidAction(room, ws, msg.act);
        break;
      }

      /* -------- échanges -------- */
      case 'trade_offer': if (me) { me.tradeOffer = msg.offer || []; me.tradeLocked = false;
        room.members.forEach(m => { if (m !== me) m.tradeLocked = false; }); pushTrade(room); } break;
      case 'trade_lock': if (me) { me.tradeLocked = true; pushTrade(room); tradeTryComplete(room); } break;
      case 'trade_unlock': if (me) { me.tradeLocked = false; pushTrade(room); } break;
    }
  });

  ws.on('close', () => {
    if (duelQueue && duelQueue.ws === ws) duelQueue = null;
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (room && room.state && !room.state.over) {
      room.state.over = true;
      roomSend(room, { t: 'combat_end', mode: room.state.mode, winner: null, disconnect: true });
    }
    leaveRoom(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Tour de Liaison à l\'écoute sur :' + PORT));
