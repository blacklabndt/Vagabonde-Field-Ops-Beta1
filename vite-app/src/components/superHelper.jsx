// The second easter egg. Double-click your own name in the top bar.
//
// A side-scroller in the family tradition: run right, mind the gaps, stomp
// the gophers, collect the film, find the job-complete sign. The runner is
// a helper — blue coveralls, white hardhat, the 880 in one hand — because
// somebody has to carry the camera, and it is never the technician.
//
// Ten shifts, defined as tile grids in superHelperLevels.js where node can
// validate them. Loaded as its own chunk and only when somebody finds it.
// It forgets everything when the dialog closes except two numbers: the
// local best in localStorage, and the crew leaderboard in arcade_scores
// under 'superhelper' — written on game over, never through the offline
// queue. A score is not work.

import React, { useRef, useEffect, useState, useCallback } from "react";
import { Btn } from "./common.jsx";
import { Store } from "../data.js";
import { Db } from "../db.js";
import { LEVELS, TILE, ROWS } from "../superHelperLevels.js";

const VIEW_W = 480;
const HUD_H = 24;
const VIEW_H = ROWS * TILE + HUD_H;           // 312
const GRAV = 1900;                            // px/s²
const JUMP = -700;                            // apex ~129px: a four-tile climb, a three-tile pit
const RUN = 170;                              // px/s top speed
const ACCEL = 1400;
const FRICTION = 1200;
const PLAYER_W = 18;
const PLAYER_H = 26;
const GOPHER_SPEED = 42;
const BARREL_SPEED = 86;
const LIVES = 5;
const BEST_KEY = "superhelper.best";
const GAME = "superhelper";

const solid = ch => ch === "#" || ch === "=";

// A level string grid becomes live objects once per attempt: the grid stays
// immutable for collision, the movable things come out as entities so dying
// and retrying resets them by rebuilding. Three kinds of trouble: gophers
// patrol and stomp flat, hornets bob about their anchor and also stomp,
// barrels roll fast and are armoured — any touch at all costs a helper.
function spawn(grid) {
  const out = { startX: 0, startY: 0, gophers: [], hornets: [], barrels: [], coins: [], flag: null, width: grid[0].length * TILE };
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const x = c * TILE, y = r * TILE;
      const ch = grid[r][c];
      if (ch === "S") { out.startX = x + 3; out.startY = y + TILE - PLAYER_H; }
      else if (ch === "E") out.gophers.push({ x: x + 3, y: y + TILE - 14, w: 18, h: 14, dir: -1, alive: true });
      else if (ch === "B") out.barrels.push({ x: x + 3, y: y + TILE - 18, w: 18, h: 18, dir: -1, roll: 0 });
      else if (ch === "W") out.hornets.push({ ax: x + 3, ay: y + 4, x: x + 3, y: y + 4, w: 18, h: 14, phase: Math.random() * 6.28, alive: true });
      else if (ch === "o") out.coins.push({ x: x + 6, y: y + 6, taken: false });
      else if (ch === "F") out.flag = { x, y };
    }
  }
  return out;
}

// ── the sprites ─────────────────────────────────────────────────────────
// Flat fills, one shade tone per surface, one dark outline — the house
// style of the other cabinet, with a little more time spent on it.

function drawHelper(g, x, y, facing, walkPhase, airborne) {
  g.save();
  g.translate(x + PLAYER_W / 2, y);
  g.scale(facing, 1);
  g.translate(-PLAYER_W / 2, 0);
  g.lineWidth = 1.5;
  g.strokeStyle = "#22262a";
  g.lineJoin = "round";

  // legs — two-frame shuffle, frozen mid-stride in the air
  const stride = airborne ? 3 : Math.sin(walkPhase) * 4;
  g.fillStyle = "#17406f";
  g.fillRect(4, 18, 4.5, 8 + Math.max(0, stride));
  g.fillRect(10, 18, 4.5, 8 + Math.max(0, -stride));
  g.fillStyle = "#3a3d40";                      // boots
  g.fillRect(3.5, 24 + Math.max(0, stride), 5.5, 3);
  g.fillRect(9.5, 24 + Math.max(0, -stride), 5.5, 3);

  // coveralls, with a shaded side and a zip seam
  g.fillStyle = "#2266b3";
  g.fillRect(3, 8, 12, 11);
  g.fillStyle = "#1b559b";
  g.fillRect(3, 8, 3, 11);
  g.strokeRect(3, 8, 12, 11);
  g.strokeStyle = "#17406f";
  g.beginPath(); g.moveTo(9, 8.5); g.lineTo(9, 18.5); g.stroke();
  g.strokeStyle = "#22262a";
  g.fillStyle = "#f2c14e";                      // hi-vis chest stripe
  g.fillRect(3, 15, 12, 2);

  // trailing arm behind the body
  const swing = airborne ? -2 : Math.sin(walkPhase) * 2.5;
  g.fillStyle = "#1b559b";
  g.fillRect(2, 9.5 + swing, 3, 7);

  // face with an ear line, under the brim
  g.fillStyle = "#e8b48c";
  g.fillRect(5, 4, 8, 5);
  g.fillStyle = "#22262a";
  g.fillRect(11, 6, 1.4, 1.4);                  // eye, leading side

  // white hardhat: dome, ridge, brim with a shadow line
  g.fillStyle = "#f4f5f6";
  g.beginPath();
  g.arc(9, 5, 5.8, Math.PI, 0);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = "#dfe2e4";
  g.fillRect(7.5, -0.8, 3, 2.2);                // ridge cap
  g.fillStyle = "#f4f5f6";
  g.fillRect(2.5, 4, 13.5, 2);
  g.strokeRect(2.5, 4, 13.5, 2);

  // the 880 in the leading hand: yellow shell, label band, guide-tube nub
  const carry = 12.5 + (airborne ? -1 : Math.sin(walkPhase) * 1.5);
  g.fillStyle = "#1b559b";                      // forearm
  g.fillRect(12.5, 11, 3.5, 4);
  g.fillStyle = "#efb01d";
  g.fillRect(13, carry, 9, 7);
  g.strokeRect(13, carry, 9, 7);
  g.fillStyle = "#f7d400";
  g.fillRect(15, carry + 1.5, 5, 4);
  g.fillStyle = "#a4208c";
  g.beginPath(); g.arc(17.5, carry + 3.5, 1.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#6b6d6e";
  g.fillRect(22, carry + 2.5, 2, 2);

  g.restore();
}

function drawGopher(g, x, y, dir, t) {
  g.save();
  g.lineWidth = 1.5;
  g.strokeStyle = "#22262a";
  const bob = Math.sin(t * 9) * 1;
  g.fillStyle = "#8a6b45";
  g.beginPath();
  g.ellipse(x + 9, y + 8 + bob, 9, 7 - bob, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = "#a8875e";                      // belly
  g.beginPath();
  g.ellipse(x + 9, y + 11 + bob, 6, 3.5, 0, 0, Math.PI);
  g.fill();
  g.fillStyle = "#6d5233";                      // ear
  g.beginPath(); g.arc(x + 9 - dir * 5, y + 3 + bob, 1.8, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#22262a";
  g.beginPath(); g.arc(x + 9 + dir * 4.5, y + 6 + bob, 1.4, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#f4f5f6";                      // the teeth of a digger
  g.fillRect(x + 8 + dir * 6, y + 9 + bob, 2, 2.5);
  g.restore();
}

function drawHornet(g, x, y, t) {
  g.save();
  g.lineWidth = 1.5;
  g.strokeStyle = "#22262a";
  // wings, a two-phase blur
  const flap = Math.sin(t * 42) > 0;
  g.fillStyle = "rgba(240,244,246,.8)";
  g.beginPath();
  g.ellipse(x + 6, y + (flap ? -3 : 0), 6, 3, -0.5, 0, Math.PI * 2);
  g.ellipse(x + 13, y + (flap ? -3 : 0), 6, 3, 0.5, 0, Math.PI * 2);
  g.fill();
  // banded body with a stinger
  g.fillStyle = "#e0a41c";
  g.beginPath();
  g.ellipse(x + 9, y + 7, 9, 6, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = "#2a2d2f";
  g.fillRect(x + 4, y + 2.5, 3, 9);
  g.fillRect(x + 10, y + 2, 3, 10);
  g.beginPath();
  g.moveTo(x + 18, y + 7); g.lineTo(x + 22, y + 8.5); g.lineTo(x + 18, y + 10);
  g.closePath(); g.fill();
  g.fillStyle = "#22262a";
  g.beginPath(); g.arc(x + 2.5, y + 5.5, 1.3, 0, Math.PI * 2); g.fill();
  g.restore();
}

function drawBarrel(g, x, y, roll) {
  g.save();
  g.lineWidth = 1.5;
  g.strokeStyle = "#22262a";
  g.fillStyle = "#5d666c";
  g.beginPath();
  g.arc(x + 9, y + 9, 9, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // rotating rib, so the rolling reads as rolling
  g.save();
  g.translate(x + 9, y + 9);
  g.rotate(roll);
  g.strokeStyle = "#454c51";
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(-8, 0); g.lineTo(8, 0); g.stroke();
  g.beginPath(); g.moveTo(0, -8); g.lineTo(0, 8); g.stroke();
  g.restore();
  // hazard band — the "do not touch" is part of the drawing
  g.fillStyle = "#e07820";
  g.beginPath();
  g.arc(x + 9, y + 9, 4.2, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.restore();
}

function drawTrefoil(g, x, y, t) {
  // The pickup is the symbol on every source container the crew handles:
  // a yellow disc, three magenta blades, spinning slowly on its post.
  g.save();
  g.translate(x + 6, y + 6);
  const squish = 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2));
  g.scale(squish, 1);
  g.lineWidth = 1.4;
  g.strokeStyle = "#22262a";
  g.fillStyle = "#f7d400";
  g.beginPath(); g.arc(0, 0, 7, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = "#a4208c";
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / 3) + t * 0.8;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 6, a - 0.5, a + 0.5);
    g.closePath();
    g.fill();
  }
  g.beginPath(); g.arc(0, 0, 1.6, 0, Math.PI * 2); g.fill();
  g.restore();
}

function drawTile(g, ch, x, y, t) {
  if (ch === "#") {
    // prairie ground: sod on top, packed dirt below, the odd stone
    g.fillStyle = "#8a6f4d";
    g.fillRect(x, y, TILE, TILE);
    g.fillStyle = "#7c6343";
    g.fillRect(x + 4, y + 10, 5, 4);
    g.fillRect(x + 14, y + 17, 6, 4);
    g.fillStyle = "#5d8a4a";
    g.fillRect(x, y, TILE, 5);
    g.fillStyle = "#4d7540";
    g.fillRect(x, y + 3, TILE, 2);
    g.fillStyle = "#6da35a";                    // grass blades
    g.fillRect(x + 3, y - 2, 2, 3);
    g.fillRect(x + 11, y - 3, 2, 4);
    g.fillRect(x + 18, y - 2, 2, 3);
  } else if (ch === "=") {
    // scaffold plank on steel: wood grain, bolted ends
    g.fillStyle = "#b58a5f";
    g.fillRect(x, y, TILE, 9);
    g.fillStyle = "#9e774f";
    g.fillRect(x, y + 5, TILE, 2);
    g.strokeStyle = "#6d5233";
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, TILE - 1, 8);
    g.fillStyle = "#4d565c";
    g.fillRect(x + 2, y + 2.5, 2.5, 2.5);
    g.fillRect(x + TILE - 4.5, y + 2.5, 2.5, 2.5);
  } else if (ch === "^") {
    // welding sparks, flickering: two triangle sets breathing against
    // each other plus embers, so the hazard never sits still
    const f = Math.sin(t * 13 + x) * 3;
    g.fillStyle = "#e07820";
    g.beginPath();
    g.moveTo(x + 2, y + TILE);
    g.lineTo(x + 7, y + 9 + f);
    g.lineTo(x + 12, y + TILE);
    g.lineTo(x + 17, y + 12 - f);
    g.lineTo(x + 22, y + TILE);
    g.closePath();
    g.fill();
    g.fillStyle = "#f2c14e";
    g.beginPath();
    g.moveTo(x + 5, y + TILE);
    g.lineTo(x + 9.5, y + 15 - f);
    g.lineTo(x + 14, y + TILE);
    g.closePath();
    g.fill();
    g.fillStyle = "#fce9b0";
    g.fillRect(x + 8 + f, y + 8, 1.6, 1.6);
    g.fillRect(x + 15 - f, y + 11, 1.4, 1.4);
  }
}

// The prairie behind everything: a far treeline, a grain elevator on the
// horizon because there is always one somewhere, clouds that keep their own
// pace. Two parallax speeds are enough to make the ground feel like it is
// the thing moving.
function drawBackdrop(g, camX, levelW) {
  // treeline, slowest
  const far = -(camX * 0.2) % 240;
  g.fillStyle = "#b9cdb4";
  for (let x = far - 240; x < VIEW_W + 240; x += 240) {
    g.beginPath();
    g.moveTo(x, 210);
    g.quadraticCurveTo(x + 60, 168, x + 120, 205);
    g.quadraticCurveTo(x + 180, 178, x + 240, 210);
    g.lineTo(x + 240, VIEW_H); g.lineTo(x, VIEW_H);
    g.closePath();
    g.fill();
  }
  // the elevator
  const ex = 340 - (camX * 0.2) % (levelW * 0.2 + VIEW_W);
  g.fillStyle = "#a3b3a9";
  g.fillRect(ex, 150, 26, 60);
  g.beginPath();
  g.moveTo(ex - 2, 150); g.lineTo(ex + 13, 136); g.lineTo(ex + 28, 150);
  g.closePath(); g.fill();
  g.fillRect(ex + 26, 170, 10, 40);
  // clouds, half-speed
  const cx = -(camX * 0.45) % 420;
  g.fillStyle = "rgba(255,255,255,.75)";
  for (let x = cx - 420; x < VIEW_W + 420; x += 420) {
    g.beginPath();
    g.ellipse(x + 90, 62, 34, 12, 0, 0, Math.PI * 2);
    g.ellipse(x + 116, 54, 24, 10, 0, 0, Math.PI * 2);
    g.ellipse(x + 300, 96, 28, 10, 0, 0, Math.PI * 2);
    g.fill();
  }
}

export function SuperHelper({ onClose, me }) {
  const canvasRef = useRef(null);
  const [best, setBest] = useState(() => Number(Store.load(BEST_KEY, 0)) || 0);
  const [hud, setHud] = useState({ score: 0, lives: 3, level: 1 });
  const [state, setState] = useState("ready");   // ready | playing | gameover | won
  const [board, setBoard] = useState(null);
  const [boardNote, setBoardNote] = useState("");

  const submit = useCallback(async runScore => {
    try {
      if (me && me.id && runScore > 0) await Db.saveArcadeScore({ game: GAME, profileId: me.id, best: runScore });
      setBoard(await Db.listArcadeScores(GAME));
      setBoardNote("");
    } catch {
      setBoardNote("Scoreboard unavailable.");
    }
  }, [me]);
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // The whole run lives in a ref — see flappy880 for why a game loop must
  // not re-render React per frame. `held` is the input state shared by the
  // keyboard and the on-screen pad.
  const game = useRef(null);
  const held = useRef({ left: false, right: false, jump: false, jumpLatch: false });
  const stateRef = useRef(state);
  stateRef.current = state;

  const freshRun = useCallback(() => {
    game.current = {
      level: 0, score: 0, lives: LIVES, over: false,
      grid: LEVELS[0], ent: spawn(LEVELS[0]),
      x: 0, y: 0, vx: 0, vy: 0, onGround: false, facing: 1, walk: 0
    };
    const s = game.current;
    s.x = s.ent.startX; s.y = s.ent.startY;
    setHud({ score: 0, lives: LIVES, level: 1 });
    setState("ready");
  }, []);

  const enterLevel = (s, idx) => {
    s.level = idx;
    s.grid = LEVELS[idx];
    s.ent = spawn(s.grid);
    s.x = s.ent.startX; s.y = s.ent.startY;
    s.vx = 0; s.vy = 0; s.onGround = false;
    setHud(h => ({ ...h, level: idx + 1 }));
  };

  const begin = useCallback(() => {
    if (stateRef.current === "gameover" || stateRef.current === "won") { freshRun(); return; }
    if (stateRef.current === "ready") setState("playing");
  }, [freshRun]);

  useEffect(() => { freshRun(); }, [freshRun]);

  // Keyboard: arrows or WASD, space to jump, escape to leave. Same typing
  // guard as the other cabinet — the egg never steals focus.
  useEffect(() => {
    const typing = t => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = e => {
      if (e.key === "Escape") { onClose(); return; }
      if (typing(e.target)) return;
      if (e.key === "ArrowLeft" || e.key === "a") held.current.left = true;
      else if (e.key === "ArrowRight" || e.key === "d") held.current.right = true;
      else if (e.key === " " || e.key === "ArrowUp" || e.key === "w") {
        e.preventDefault();
        if (!e.repeat) { held.current.jump = true; begin(); }
      } else return;
      e.preventDefault();
    };
    const up = e => {
      if (e.key === "ArrowLeft" || e.key === "a") held.current.left = false;
      else if (e.key === "ArrowRight" || e.key === "d") held.current.right = false;
      else if (e.key === " " || e.key === "ArrowUp" || e.key === "w") held.current.jump = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [begin, onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");

    // Buffer matched to the screen's pixels — the washed-out-canvas lesson
    // from the other cabinet, applied from day one here.
    let lastDpr = 0;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      if (dpr === lastDpr) return;
      lastDpr = dpr;
      canvas.width = Math.round(VIEW_W * dpr);
      canvas.height = Math.round(VIEW_H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);

    let raf = 0;
    let last = performance.now();
    let stopped = false;

    const tileAt = (s, px, py) => {
      const c = Math.floor(px / TILE), r = Math.floor(py / TILE);
      if (r < 0 || r >= ROWS || c < 0) return ".";
      const row = s.grid[r];
      return c >= row.length ? "." : row[c];
    };

    const die = s => {
      s.lives -= 1;
      if (s.lives < 0) {
        if (!s.over) {
          s.over = true;
          setState("gameover");
          if (s.score > (Number(Store.load(BEST_KEY, 0)) || 0)) {
            Store.save(BEST_KEY, s.score);
            setBest(s.score);
          }
          setBoardNote("");
          submitRef.current(s.score);
        }
        return;
      }
      setHud(h => ({ ...h, lives: s.lives }));
      // same level, same coins, gophers back on patrol
      const keep = s.ent.coins;
      s.ent = spawn(s.grid);
      s.ent.coins = keep;
      s.x = s.ent.startX; s.y = s.ent.startY;
      s.vx = 0; s.vy = 0;
      setState("ready");
    };

    const win = s => {
      if (s.over) return;
      s.over = true;
      setState("won");
      if (s.score > (Number(Store.load(BEST_KEY, 0)) || 0)) {
        Store.save(BEST_KEY, s.score);
        setBest(s.score);
      }
      setBoardNote("");
      submitRef.current(s.score);
    };

    const step = now => {
      if (stopped) return;
      const dt = Math.min((now - last) / 1000, 0.04);
      last = now;
      const s = game.current;
      if (!s) { raf = requestAnimationFrame(step); return; }

      if (stateRef.current === "playing") {
        const h = held.current;

        // run
        if (h.left) { s.vx = Math.max(-RUN, s.vx - ACCEL * dt); s.facing = -1; }
        else if (h.right) { s.vx = Math.min(RUN, s.vx + ACCEL * dt); s.facing = 1; }
        else if (s.vx !== 0) {
          const f = FRICTION * dt;
          s.vx = Math.abs(s.vx) <= f ? 0 : s.vx - Math.sign(s.vx) * f;
        }
        if (s.vx !== 0) s.walk += dt * 14;

        // jump: latched so holding the key does not bounce off every floor
        if (h.jump && !h.jumpLatch && s.onGround) { s.vy = JUMP; s.onGround = false; h.jumpLatch = true; }
        if (!h.jump) h.jumpLatch = false;

        s.vy = Math.min(s.vy + GRAV * dt, 900);

        // axis-separated collisions against the grid
        s.x += s.vx * dt;
        if (s.vx > 0) {
          const edge = s.x + PLAYER_W;
          if (solid(tileAt(s, edge, s.y + 2)) || solid(tileAt(s, edge, s.y + PLAYER_H - 2))) {
            s.x = Math.floor(edge / TILE) * TILE - PLAYER_W - 0.01; s.vx = 0;
          }
        } else if (s.vx < 0) {
          if (solid(tileAt(s, s.x, s.y + 2)) || solid(tileAt(s, s.x, s.y + PLAYER_H - 2))) {
            s.x = (Math.floor(s.x / TILE) + 1) * TILE + 0.01; s.vx = 0;
          }
        }
        if (s.x < 0) s.x = 0;

        s.y += s.vy * dt;
        s.onGround = false;
        if (s.vy > 0) {
          const feet = s.y + PLAYER_H;
          if (solid(tileAt(s, s.x + 2, feet)) || solid(tileAt(s, s.x + PLAYER_W - 2, feet))) {
            s.y = Math.floor(feet / TILE) * TILE - PLAYER_H - 0.01;
            s.vy = 0; s.onGround = true;
          }
        } else if (s.vy < 0) {
          if (solid(tileAt(s, s.x + 2, s.y)) || solid(tileAt(s, s.x + PLAYER_W - 2, s.y))) {
            s.y = (Math.floor(s.y / TILE) + 1) * TILE + 0.01; s.vy = 0;
          }
        }

        // sparks and the void
        const cx = s.x + PLAYER_W / 2, cy = s.y + PLAYER_H - 3;
        if (tileAt(s, cx, cy) === "^" || s.y > ROWS * TILE + 40) { die(s); }

        const hits = e => s.x < e.x + e.w && s.x + PLAYER_W > e.x &&
                          s.y < e.y + e.h && s.y + PLAYER_H > e.y;
        const stomping = e => s.vy > 0 && (s.y + PLAYER_H - e.y) < 12;
        const bump = pts => { s.score += pts; setHud(h2 => ({ ...h2, score: s.score })); };

        // gophers patrol between walls and edges; a stomp flattens them
        for (const e of s.ent.gophers) {
          if (!e.alive) continue;
          e.x += e.dir * GOPHER_SPEED * dt;
          const ahead = e.x + (e.dir > 0 ? e.w + 1 : -1);
          const wall = solid(tileAt(s, ahead, e.y + e.h - 2));
          const cliff = !solid(tileAt(s, ahead, e.y + e.h + 2));
          if (wall || cliff || e.x < 0) e.dir *= -1;
          if (hits(e)) {
            if (stomping(e)) { e.alive = false; s.vy = -300; bump(100); }
            else die(s);
          }
        }

        // barrels roll faster and are armoured: there is no safe side
        for (const e of s.ent.barrels) {
          e.x += e.dir * BARREL_SPEED * dt;
          e.roll += e.dir * dt * 9;
          const ahead = e.x + (e.dir > 0 ? e.w + 1 : -1);
          const wall = solid(tileAt(s, ahead, e.y + e.h - 2));
          const cliff = !solid(tileAt(s, ahead, e.y + e.h + 2));
          if (wall || cliff || e.x < 0) e.dir *= -1;
          if (hits(e)) die(s);
        }

        // hornets bob about their anchor; worth more, harder to line up
        const now2 = now / 1000;
        for (const e of s.ent.hornets) {
          if (!e.alive) continue;
          e.x = e.ax + Math.sin(e.phase + now2 * 1.3) * 34;
          e.y = e.ay + Math.sin(e.phase * 2 + now2 * 2.7) * 11;
          if (hits(e)) {
            if (stomping(e)) { e.alive = false; s.vy = -320; bump(150); }
            else die(s);
          }
        }

        // trefoil source tags
        for (const c of s.ent.coins) {
          if (c.taken) continue;
          if (s.x < c.x + 12 && s.x + PLAYER_W > c.x && s.y < c.y + 12 && s.y + PLAYER_H > c.y) {
            c.taken = true;
            bump(50);
          }
        }

        // The sign — and it has to be reached, not walked under: level 10
        // hangs it at the top of the tower, and an x-only check would let
        // a ground-floor stroll count as the climb.
        const f = s.ent.flag;
        if (f && s.x + PLAYER_W > f.x + 4 && s.x < f.x + TILE &&
            s.y + PLAYER_H > f.y - TILE && s.y < f.y + TILE * 2) {
          s.score += 500;
          setHud(h2 => ({ ...h2, score: s.score }));
          if (s.level + 1 >= LEVELS.length) win(s);
          else { enterLevel(s, s.level + 1); setState("ready"); }
        }
      }

      draw(g, game.current, now / 1000);
      raf = requestAnimationFrame(step);
    };

    const draw = (g2, s, t) => {
      // prairie sky, as seen from every site the crew has ever stood on
      const sky = g2.createLinearGradient(0, 0, 0, VIEW_H);
      sky.addColorStop(0, "#bcd6e8");
      sky.addColorStop(0.7, "#dfeaf1");
      sky.addColorStop(1, "#eef2f4");
      g2.fillStyle = sky;
      g2.fillRect(0, 0, VIEW_W, VIEW_H);
      if (!s) return;

      const camX = Math.max(0, Math.min(s.x - VIEW_W * 0.4, s.ent.width - VIEW_W));
      drawBackdrop(g2, camX, s.ent.width);

      g2.save();
      g2.translate(-camX, HUD_H);

      const c0 = Math.floor(camX / TILE), c1 = Math.ceil((camX + VIEW_W) / TILE);
      for (let r = 0; r < ROWS; r++) {
        const row = s.grid[r];
        for (let c = c0; c <= c1 && c < row.length; c++) {
          drawTile(g2, row[c], c * TILE, r * TILE, t);
        }
      }

      for (const c of s.ent.coins) if (!c.taken) drawTrefoil(g2, c.x, c.y, t);

      const f = s.ent.flag;
      if (f) {
        g2.fillStyle = "#4d565c";
        g2.fillRect(f.x + 10, f.y - TILE, 4, TILE * 2);
        // the pennant waves — a quiet reward for getting close enough to see
        const w = Math.sin(t * 4) * 3;
        g2.fillStyle = "#2f9e4f";
        g2.beginPath();
        g2.moveTo(f.x + 14, f.y - TILE);
        g2.quadraticCurveTo(f.x + 26, f.y - TILE + 3 + w, f.x + 34, f.y - TILE + 7 + w);
        g2.quadraticCurveTo(f.x + 26, f.y - TILE + 10 + w, f.x + 14, f.y - TILE + 14);
        g2.closePath();
        g2.fill();
        g2.strokeStyle = "#22262a";
        g2.lineWidth = 1.2;
        g2.stroke();
      }

      for (const e of s.ent.gophers) if (e.alive) drawGopher(g2, e.x, e.y, e.dir, t);
      for (const e of s.ent.barrels) drawBarrel(g2, e.x, e.y, e.roll);
      for (const e of s.ent.hornets) if (e.alive) drawHornet(g2, e.x, e.y, t);

      drawHelper(g2, s.x, s.y, s.facing, s.walk, !s.onGround);
      g2.restore();

      // HUD strip
      g2.fillStyle = "rgba(29,31,32,.85)";
      g2.fillRect(0, 0, VIEW_W, HUD_H);
      g2.fillStyle = "#f4f7f8";
      g2.font = "600 12px Helvetica, Arial, sans-serif";
      g2.textAlign = "left";
      g2.fillText(`Score ${s.score}`, 10, 16);
      g2.textAlign = "center";
      g2.fillText(`Shift ${s.level + 1} / ${LEVELS.length}`, VIEW_W / 2, 16);
      g2.textAlign = "right";
      g2.fillText(`Helpers ${"▲".repeat(Math.max(0, s.lives))}`, VIEW_W - 10, 16);
    };

    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  // The on-screen pad. Pointer events with capture so a finger sliding off
  // a button still releases it, and everything routes through the same
  // `held` flags the keyboard sets.
  const padBtn = (label, key, style) => (
    <button
      className="egg-pad-btn"
      style={style}
      onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); held.current[key] = true; if (key === "jump") begin(); }}
      onPointerUp={() => { held.current[key] = false; }}
      onPointerCancel={() => { held.current[key] = false; }}
      aria-label={key}
    >{label}</button>
  );

  const overlayNote =
    state === "ready" ? `Shift ${hud.level} — jump to start`
    : state === "gameover" ? "Sent home. Jump to clock in again."
    : state === "won" ? "All ten shifts worked. The helper is now a technician."
    : null;

  return (
    <div className="egg-backdrop" onClick={onClose}>
      <div className="egg-box" onClick={e => e.stopPropagation()}>
        <div className="egg-head">
          <strong>Super Helper</strong>
          <span>Carry the 880. Mind the gophers.</span>
          <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Close</Btn>
        </div>

        <div className="egg-stage">
          <canvas
            ref={canvasRef}
            className="egg-canvas egg-canvas-wide"
            onPointerDown={e => { e.preventDefault(); begin(); }}
            aria-label="Super Helper, a small platform game. Arrows to run, space to jump."
            role="img"
          />
          {(state === "gameover" || state === "won") && (
            <div className="egg-board">
              <strong>Best shifts</strong>
              {boardNote ? <p className="egg-board-note">{boardNote}</p>
                : !board ? <p className="egg-board-note">Loading…</p>
                : board.length === 0 ? <p className="egg-board-note">Nobody has scored yet.</p>
                : (
                  <ol>
                    {board.map((r, i) => (
                      <li key={r.id} className={me && r.id === me.id ? "mine" : ""}>
                        <span className="pos">{i + 1}</span>
                        <span className="who">{r.name || "—"}</span>
                        <span className="pts">{r.best}</span>
                      </li>
                    ))}
                  </ol>
                )}
            </div>
          )}
          {overlayNote && state !== "gameover" && state !== "won" && (
            <div className="egg-note">{overlayNote}</div>
          )}
        </div>

        <div className="egg-pad">
          {padBtn("◀", "left")}
          {padBtn("▶", "right")}
          {padBtn("⤒", "jump", { marginLeft: "auto" })}
        </div>

        <div className="egg-foot">
          <span>{overlayNote || "Arrows run, space jumps"}</span>
          <span style={{ marginLeft: "auto" }}>Best {best}</span>
        </div>
      </div>
    </div>
  );
}
