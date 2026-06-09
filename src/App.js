import React, { useState, useRef, useCallback } from "react";

const PITCH_WIDTH = 680;
const PITCH_HEIGHT = 460;
const PLAYER_R = 20;
const BALL_R = 20;

// xRatio は自チーム基準（0=GKライン側, 1=ハーフライン）
// Aチーム: x = PAD_X + xRatio*(HALF_W - PAD_X)
// Bチーム: x = PITCH_WIDTH - (PAD_X + xRatio*(HALF_W - PAD_X))
const FORMATIONS = {
  "3-3-1": { lines: [{ role:"CB",count:3,xRatio:0.38},{ role:"MF",count:3,xRatio:0.65},{ role:"FW",count:1,xRatio:0.88}] },
  "3-2-2": { lines: [{ role:"CB",count:3,xRatio:0.38},{ role:"MF",count:2,xRatio:0.62},{ role:"FW",count:2,xRatio:0.88}] },
  "2-4-1": { lines: [{ role:"CB",count:2,xRatio:0.38},{ role:"MF",count:4,xRatio:0.63},{ role:"FW",count:1,xRatio:0.88}] },
  "2-3-2": { lines: [{ role:"CB",count:2,xRatio:0.38},{ role:"MF",count:3,xRatio:0.63},{ role:"FW",count:2,xRatio:0.88}] },
  "1-4-2": { lines: [{ role:"CB",count:1,xRatio:0.35},{ role:"MF",count:4,xRatio:0.61},{ role:"FW",count:2,xRatio:0.88}] },
  "4-2-1": { lines: [{ role:"CB",count:4,xRatio:0.38},{ role:"MF",count:2,xRatio:0.63},{ role:"FW",count:1,xRatio:0.88}] },
};

const DEFAULT_F = "3-3-1";
const HALF_W = PITCH_WIDTH / 2; // 340
const PAD_X = 45;

function buildTeam(fKey, team) {
  const f = FORMATIONS[fKey];
  const prefix = team === "A" ? "a" : "b";
  const players = [];
  let idx = 1;
  const gkX = team === "A" ? PAD_X : PITCH_WIDTH - PAD_X;
  players.push({ id:`${prefix}${idx++}`, x:gkX, y:PITCH_HEIGHT/2, label:"GK", team });
  f.lines.forEach(({ role, count, xRatio }) => {
    // 自陣内に収める: PAD_X〜HALF_W-PLAYER_R の範囲
    const localX = PAD_X + xRatio * (HALF_W - PAD_X - PLAYER_R);
    const x = team === "A" ? localX : PITCH_WIDTH - localX;
    const step = PITCH_HEIGHT / (count + 1);
    for (let i = 0; i < count; i++) {
      players.push({ id:`${prefix}${idx++}`, x, y: step*(i+1), label:role, team });
    }
  });
  return players;
}

const INIT_BALL = { x: PITCH_WIDTH/2, y: PITCH_HEIGHT/2 };

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function dist(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }

function projectOnLine(px, py, ax, ay, bx, by) {
  const dx=bx-ax, dy=by-ay, lenSq=dx*dx+dy*dy;
  if (!lenSq) return {x:ax,y:ay};
  const t = clamp(((px-ax)*dx+(py-ay)*dy)/lenSq, 0, 1);
  return { x:ax+t*dx, y:ay+t*dy };
}

function computeAI(ball, allA, allB, homeB) {
  const GX = PITCH_WIDTH - 20, GY = PITCH_HEIGHT/2;
  const ballHolder = allA.reduce((b,a)=>dist(a,ball)<dist(b,ball)?a:b, allA[0]);

  const bYR = (ball.y - GY)/(PITCH_HEIGHT/2);
  const bXR = clamp((ball.x - PITCH_WIDTH/2)/(PITCH_WIDTH/2), -1, 1);
  // ボールが左半分(赤攻撃)なら全体を大きく前進させる
  const blockY = bYR*30;
  const blockX = ball.x < PITCH_WIDTH/2
    ? (ball.x - PITCH_WIDTH/2) * 0.7  // 攻撃時: 大きくスライド
    : bXR * 20;                         // 守備時: 従来通り

  const home = (b) => {
    const h = homeB.find(hb=>hb.id===b.id) || b;
    return { x:clamp(h.x+blockX,PLAYER_R,PITCH_WIDTH-PLAYER_R), y:clamp(h.y+blockY,PLAYER_R,PITCH_HEIGHT-PLAYER_R) };
  };

  const attackers = allA.filter(a=>a.label!=="GK");
  const defenders = allB.filter(b=>b.label!=="GK");

  // ボールに最も近い赤選手 = ボール回収担当（ボールホルダーがいない場合も含む）
  const ballChaser = defenders.reduce((best,b)=>dist(b,ball)<dist(best,ball)?b:best, defenders[0]);
  const ballChaserDist = dist(ballChaser, ball);
  // ボールに近い青選手がいるか（150px以内）
  const attackerNearBall = allA.some(a => dist(a, ball) < 150);

  // presser = closest defender to ball holder
  const presser = defenders.reduce((best,b)=>dist(b,ballHolder)<dist(best,ballHolder)?b:best, defenders[0]);

  // man-mark assignments (greedy, zone-limited)
  const assignments = {};
  const usedA = new Set();
  if (presser) { assignments[presser.id]=ballHolder; usedA.add(ballHolder.id); }
  const ZONE_R = 160;
  for (const b of defenders) {
    if (assignments[b.id]) continue;
    const h = home(b);
    let best=null, bestD=Infinity;
    for (const a of attackers) {
      if (usedA.has(a.id)) continue;
      const d=dist(h,a);
      if (d<ZONE_R && d<bestD) { bestD=d; best=a; }
    }
    if (best) { assignments[b.id]=best; usedA.add(best.id); }
  }

  // compute targets
  const targets = {};
  allB.forEach(b => {
    const h = home(b);
    if (b.label==="GK") {
      const ang = Math.atan2(ball.y-GY, ball.x-GX);
      targets[b.id] = {
        x: clamp(GX+Math.cos(ang)*38, 575, PITCH_WIDTH-PLAYER_R),
        y: clamp(GY+Math.sin(ang)*38, 65, PITCH_HEIGHT-65),
      };
      return;
    }

    // ボール近くに青がいない && この選手がボール最近傍 → ボール回収に向かう
    if (!attackerNearBall && b.id === ballChaser.id && ballChaserDist < 200) {
      let raw = { x: ball.x, y: ball.y };
      if (b.label==="CB") raw.x = clamp(raw.x, PLAYER_R+30, PITCH_WIDTH-PLAYER_R);
      if (b.label==="MF") raw.x = clamp(raw.x, PLAYER_R+20, PITCH_WIDTH-PLAYER_R);
      if (b.label==="FW") raw.x = clamp(raw.x, PLAYER_R+10, PITCH_WIDTH-PLAYER_R);
      targets[b.id] = { x: clamp(raw.x, PLAYER_R, PITCH_WIDTH-PLAYER_R), y: clamp(raw.y, PLAYER_R, PITCH_HEIGHT-PLAYER_R) };
      return;
    }
    const marked = assignments[b.id];
    if (!marked) { targets[b.id]=h; return; }

    const isPresser = presser && b.id===presser.id;
    let raw;
    if (isPresser) {
      const toGX=GX-marked.x, toGY=GY-marked.y, len=Math.hypot(toGX,toGY)||1;
      const depth = clamp(38+(ball.x-PITCH_WIDTH/2)/10, 28, 52);
      raw = { x:marked.x+(toGX/len)*depth, y:marked.y+(toGY/len)*depth };
      const maxD = b.label==="FW"?120:b.label==="MF"?90:65;
      const d=dist(raw,h);
      if (d>maxD) { const dx=raw.x-h.x,dy=raw.y-h.y,dd=Math.hypot(dx,dy)||1; raw={x:h.x+(dx/dd)*maxD,y:h.y+(dy/dd)*maxD}; }
    } else {
      const pb = projectOnLine(h.x,h.y, marked.x,marked.y, ball.x,ball.y);
      const sb = projectOnLine(h.x,h.y, marked.x,marked.y, GX,GY);
      const shotW = clamp((marked.x-420)/160, 0, 0.6);
      const passW = 0.35, homeW = 1-shotW-passW;
      raw = { x:h.x*homeW+pb.x*passW+sb.x*shotW, y:h.y*homeW+pb.y*passW+sb.y*shotW };
      const maxD = b.label==="FW"?100:b.label==="MF"?75:55;
      const d=dist(raw,h);
      if (d>maxD) { const dx=raw.x-h.x,dy=raw.y-h.y,dd=Math.hypot(dx,dy)||1; raw={x:h.x+(dx/dd)*maxD,y:h.y+(dy/dd)*maxD}; }
    }
    // x範囲制限: ボール位置に応じて動的に変える
    // ボールが左半分(赤が攻める)なら制限を大きく緩める
    const ballInAttackHalf = ball.x < PITCH_WIDTH / 2;
    if (b.label==="GK") { /* GKは別処理済み */ }
    else if (ballInAttackHalf) {
      // 攻撃時: 全ピッチ使用可、ただしGKラインは守る
      if (b.label==="CB") raw.x = clamp(raw.x, PLAYER_R + 30, PITCH_WIDTH - PLAYER_R);
      if (b.label==="MF") raw.x = clamp(raw.x, PLAYER_R + 20, PITCH_WIDTH - PLAYER_R);
      if (b.label==="FW") raw.x = clamp(raw.x, PLAYER_R + 10, PITCH_WIDTH - PLAYER_R);
    } else {
      // 守備時: 従来の制限
      if (b.label==="CB") raw.x = clamp(raw.x, 415, 580);
      if (b.label==="MF") raw.x = clamp(raw.x, 350, 545);
      if (b.label==="FW") raw.x = clamp(raw.x, 305, 490);
    }
    // ボールより手前に出ない（守備時のみ）
    if (!ballInAttackHalf) {
      raw.x = clamp(raw.x, ball.x + PLAYER_R, PITCH_WIDTH - PLAYER_R);
    }
    targets[b.id] = { x:clamp(raw.x,PLAYER_R,PITCH_WIDTH-PLAYER_R), y:clamp(raw.y,PLAYER_R,PITCH_HEIGHT-PLAYER_R) };
  });

  // collision separation (red-red)
  const MIN_SEP = PLAYER_R*2+5;
  const pos = {};
  allB.forEach(b=>{ pos[b.id]={...targets[b.id]}; });
  for (let p=0;p<3;p++) {
    const ids=allB.map(b=>b.id);
    for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++) {
      const pi=pos[ids[i]], pj=pos[ids[j]];
      const dx=pj.x-pi.x, dy=pj.y-pi.y, d=Math.hypot(dx,dy);
      if (d<MIN_SEP && d>0) {
        const push=(MIN_SEP-d)/2, nx=dx/d, ny=dy/d;
        const bi=allB.find(x=>x.id===ids[i]), bj=allB.find(x=>x.id===ids[j]);
        if (bi?.label!=="GK") { pi.x-=nx*push; pi.y-=ny*push; }
        if (bj?.label!=="GK") { pj.x+=nx*push; pj.y+=ny*push; }
      }
    }
  }

  // collision separation (red-blue) 
  for (let p=0;p<3;p++) {
    allB.forEach(b=>{
      if (b.label==="GK") return;
      const pb=pos[b.id];
      for (const a of allA) {
        const dx=pb.x-a.x, dy=pb.y-a.y, d=Math.hypot(dx,dy);
        if (d<MIN_SEP && d>0) {
          const push=(MIN_SEP-d), nx=dx/d, ny=dy/d;
          pb.x+=nx*push; pb.y+=ny*push;
        }
      }
      pb.x=clamp(pb.x,PLAYER_R,PITCH_WIDTH-PLAYER_R);
      pb.y=clamp(pb.y,PLAYER_R,PITCH_HEIGHT-PLAYER_R);
    });
  }

  // collision separation (red-ball and blue-ball)
  const BALL_SEP = PLAYER_R + BALL_R + 2;
  for (let p=0;p<2;p++) {
    allB.forEach(b=>{
      const pb=pos[b.id];
      const dx=pb.x-ball.x, dy=pb.y-ball.y, d=Math.hypot(dx,dy);
      if (d<BALL_SEP && d>0) {
        const push=BALL_SEP-d, nx=dx/d, ny=dy/d;
        pb.x+=nx*push; pb.y+=ny*push;
        pb.x=clamp(pb.x,PLAYER_R,PITCH_WIDTH-PLAYER_R);
        pb.y=clamp(pb.y,PLAYER_R,PITCH_HEIGHT-PLAYER_R);
      }
    });
  }

  return allB.map(b=>({ ...b, x:clamp(pos[b.id]?.x??b.x,PLAYER_R,PITCH_WIDTH-PLAYER_R), y:clamp(pos[b.id]?.y??b.y,PLAYER_R,PITCH_HEIGHT-PLAYER_R) }));
}

const btnBase = { padding:"4px 10px", borderRadius:6, fontSize:11, fontWeight:600, cursor:"pointer" };

export default function TacticsBoard() {
  const [fA, setFA] = useState(DEFAULT_F);
  const [fB, setFB] = useState(DEFAULT_F);
  const [teamA, setTeamA] = useState(()=>buildTeam(DEFAULT_F,"A"));
  const [teamB, setTeamB] = useState(()=>buildTeam(DEFAULT_F,"B"));
  const [homeB, setHomeB] = useState(()=>buildTeam(DEFAULT_F,"B"));
  const [ball, setBall] = useState(INIT_BALL);
  const [dragging, setDragging] = useState(null);
  const [animating, setAnimating] = useState(false);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const svgRef = useRef(null);
  const homeBRef = useRef(homeB);
  homeBRef.current = homeB;

  const ballRef = useRef(ball);
  const teamARef = useRef(teamA);
  const teamBRef = useRef(teamB);
  const historyRef = useRef(history);
  const futureRef = useRef(future);
  ballRef.current = ball;
  teamARef.current = teamA;
  teamBRef.current = teamB;
  historyRef.current = history;
  futureRef.current = future;

  const changeFA = (f) => { setFA(f); setTeamA(buildTeam(f,"A")); setHistory([]); setFuture([]); };
  const changeFB = (f) => { const nb=buildTeam(f,"B"); setFB(f); setTeamB(nb); setHomeB(nb); homeBRef.current=nb; setHistory([]); setFuture([]); };

  const getSVGPt = useCallback((cx,cy) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return {x:0,y:0};
    return { x:(cx-r.left)*(PITCH_WIDTH/r.width), y:(cy-r.top)*(PITCH_HEIGHT/r.height) };
  }, []);

  const onDown = useCallback((e) => {
    const tgt = e.target.closest("[data-d]");
    if (!tgt) return;
    e.preventDefault();
    const id = tgt.dataset.d;
    const pt = getSVGPt(e.clientX, e.clientY);
    if (id==="ball") {
      setBall(b=>{ setDragging({id:"ball",startX:b.x,startY:b.y,offsetX:pt.x-b.x,offsetY:pt.y-b.y}); return b; });
    } else {
      // teamA or teamB
      setTeamA(prevA=>{
        const pl=prevA.find(p=>p.id===id);
        if (pl) { setDragging({id,team:"A",startX:pl.x,startY:pl.y,offsetX:pt.x-pl.x,offsetY:pt.y-pl.y}); }
        return prevA;
      });
      setTeamB(prevB=>{
        const pl=prevB.find(p=>p.id===id);
        if (pl) { setDragging({id,team:"B",startX:pl.x,startY:pl.y,offsetX:pt.x-pl.x,offsetY:pt.y-pl.y}); }
        return prevB;
      });
    }
    svgRef.current.setPointerCapture(e.pointerId);
  }, [getSVGPt]);

  const onMove = useCallback((e) => {
    if (!dragging) return;
    const pt = getSVGPt(e.clientX, e.clientY);
    if (dragging.id==="ball") {
      setBall({ x:clamp(pt.x-dragging.offsetX,BALL_R,PITCH_WIDTH-BALL_R), y:clamp(pt.y-dragging.offsetY,BALL_R,PITCH_HEIGHT-BALL_R) });
    } else {
      setBall(curBall => {
        let nx=clamp(pt.x-dragging.offsetX,PLAYER_R,PITCH_WIDTH-PLAYER_R);
        let ny=clamp(pt.y-dragging.offsetY,PLAYER_R,PITCH_HEIGHT-PLAYER_R);
        const BSEP=PLAYER_R+BALL_R+2;
        const dx=nx-curBall.x, dy=ny-curBall.y, d=Math.hypot(dx,dy);
        if (d<BSEP && d>0) { nx=curBall.x+(dx/d)*BSEP; ny=curBall.y+(dy/d)*BSEP; }
        nx=clamp(nx,PLAYER_R,PITCH_WIDTH-PLAYER_R);
        ny=clamp(ny,PLAYER_R,PITCH_HEIGHT-PLAYER_R);
        if (dragging.team==="B") {
          setTeamB(prev=>prev.map(p=>p.id===dragging.id?{...p,x:nx,y:ny}:p));
        } else {
          setTeamA(prev=>prev.map(p=>p.id===dragging.id?{...p,x:nx,y:ny}:p));
        }
        return curBall;
      });
    }
  }, [dragging, getSVGPt]);

  const onUp = useCallback(() => {
    if (!dragging) return;
    const id = dragging.id;
    const team = dragging.team;

    const curA = teamARef.current;
    const curB = teamBRef.current;
    const curBall = ballRef.current;

    // 移動量チェック
    let moved = false;
    if (id === "ball") {
      moved = Math.hypot(curBall.x - dragging.startX, curBall.y - dragging.startY) > 5;
    } else if (team === "B") {
      const mp = curB.find(p => p.id === id);
      moved = mp && Math.hypot(mp.x - dragging.startX, mp.y - dragging.startY) > 5;
    } else {
      const mp = curA.find(p => p.id === id);
      moved = mp && Math.hypot(mp.x - dragging.startX, mp.y - dragging.startY) > 5;
    }

    if (moved) {
      // 履歴保存（各状態の「動かす前」を正確に保存）
      const prevBall = id === "ball" ? { x: dragging.startX, y: dragging.startY } : curBall;
      const prevTeamA = team !== "B" && id !== "ball"
        ? curA.map(p => p.id === id ? { ...p, x: dragging.startX, y: dragging.startY } : p)
        : curA;
      const prevTeamB = team === "B"
        ? curB.map(p => p.id === id ? { ...p, x: dragging.startX, y: dragging.startY } : p)
        : curB;
      setHistory(h => [...h.slice(-19), { teamA: prevTeamA, teamB: prevTeamB, ball: prevBall }]);
      setFuture([]); // 新操作でやり直しをクリア


      // 赤の手動ドラッグ以外はAI発動
      if (team !== "B") {
        setAnimating(true);
        const newB = computeAI(curBall, curA, curB, homeBRef.current);
        setTimeout(() => { setTeamB(newB); setAnimating(false); }, 60);
      }
    }

    setDragging(null);
  }, [dragging]);

  const undo = () => {
    const h = historyRef.current;
    if (!h.length) return;
    const prev = h[h.length - 1];
    // 現在の状態をfutureに積む
    setFuture(f => [...f, { teamA: teamARef.current, teamB: teamBRef.current, ball: ballRef.current }]);
    setTeamA(prev.teamA);
    setTeamB(prev.teamB);
    setBall(prev.ball);
    setHistory(h.slice(0, -1));
  };

  const redo = () => {
    const f = futureRef.current;
    if (!f.length) return;
    const next = f[f.length - 1];
    // 現在の状態をhistoryに積む
    setHistory(h => [...h, { teamA: teamARef.current, teamB: teamBRef.current, ball: ballRef.current }]);
    setTeamA(next.teamA);
    setTeamB(next.teamB);
    setBall(next.ball);
    setFuture(f.slice(0, -1));
  };

  const reset = () => {
    const na=buildTeam(fA,"A"), nb=buildTeam(fB,"B");
    setTeamA(na); setTeamB(nb); setHomeB(nb); homeBRef.current=nb;
    setBall(INIT_BALL); setDragging(null); setHistory([]); setFuture([]);
  };

  const isDragBall = dragging?.id==="ball";

  return (
    <div style={{minHeight:"100vh",background:"#0a1a0a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'Inter','Helvetica Neue',sans-serif",padding:"16px"}}>
      <div style={{marginBottom:12,textAlign:"center"}}>
        <div style={{fontSize:10,letterSpacing:"0.22em",color:"#4ade80",textTransform:"uppercase",marginBottom:3}}>8-a-side · Tactics Board</div>
        <h1 style={{margin:0,fontSize:24,fontWeight:700,color:"#f0fdf4",letterSpacing:"-0.02em"}}>8人制 戦術ボード</h1>
      </div>

      {/* Legend */}
      <div style={{display:"flex",gap:16,marginBottom:10,fontSize:11,color:"#9ca3af",flexWrap:"wrap",justifyContent:"center"}}>
        <span style={{display:"flex",alignItems:"center",gap:5}}>
          <span style={{width:12,height:12,borderRadius:"50%",background:"#2563eb",display:"inline-block",border:"1.5px solid #bfdbfe"}}/>自チーム（ドラッグ可）
        </span>
        <span style={{display:"flex",alignItems:"center",gap:5}}>
          <span style={{width:12,height:12,borderRadius:"50%",background:"#dc2626",display:"inline-block",border:"1.5px solid #fca5a5"}}/>相手（自動移動）
        </span>
        <span>⚽ ボール（ドラッグ可）</span>
      </div>

      {/* Formation selectors */}
      <div style={{display:"flex",gap:20,marginBottom:12,flexWrap:"wrap",justifyContent:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,color:"#93c5fd",fontWeight:600}}>自チーム</span>
          {Object.keys(FORMATIONS).map(f=>(
            <button key={f} onClick={()=>changeFA(f)} style={{...btnBase,border:fA===f?"1.5px solid #3b82f6":"1px solid #374151",background:fA===f?"#1e3a5f":"#111827",color:fA===f?"#93c5fd":"#6b7280"}}>{f}</button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,color:"#fca5a5",fontWeight:600}}>相手</span>
          {Object.keys(FORMATIONS).map(f=>(
            <button key={f} onClick={()=>changeFB(f)} style={{...btnBase,border:fB===f?"1.5px solid #ef4444":"1px solid #374151",background:fB===f?"#3f1a1a":"#111827",color:fB===f?"#fca5a5":"#6b7280"}}>{f}</button>
          ))}
        </div>
      </div>

      {/* Pitch */}
      <svg ref={svgRef} viewBox={`0 0 ${PITCH_WIDTH} ${PITCH_HEIGHT}`}
        style={{width:"100%",maxWidth:720,borderRadius:12,boxShadow:"0 0 40px rgba(74,222,128,0.15),0 4px 24px rgba(0,0,0,0.6)",cursor:dragging?"grabbing":"default",touchAction:"none",userSelect:"none"}}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#166534"/><stop offset="50%" stopColor="#15803d"/><stop offset="100%" stopColor="#166534"/>
          </linearGradient>
          <pattern id="st" width="40" height={PITCH_HEIGHT} patternUnits="userSpaceOnUse">
            <rect width="20" height={PITCH_HEIGHT} fill="rgba(0,0,0,0.07)"/>
          </pattern>
        </defs>
        <rect width={PITCH_WIDTH} height={PITCH_HEIGHT} fill="url(#pg)" rx="10"/>
        <rect width={PITCH_WIDTH} height={PITCH_HEIGHT} fill="url(#st)" rx="10"/>
        <g stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" fill="none">
          <rect x="20" y="20" width={PITCH_WIDTH-40} height={PITCH_HEIGHT-40}/>
          <line x1={PITCH_WIDTH/2} y1="20" x2={PITCH_WIDTH/2} y2={PITCH_HEIGHT-20}/>
          <circle cx={PITCH_WIDTH/2} cy={PITCH_HEIGHT/2} r="52"/>
          <circle cx={PITCH_WIDTH/2} cy={PITCH_HEIGHT/2} r="2.5" fill="rgba(255,255,255,0.5)"/>
          <rect x="20" y={PITCH_HEIGHT/2-85} width="95" height="170"/>
          <rect x="20" y={PITCH_HEIGHT/2-42} width="42" height="84"/>
          <rect x={PITCH_WIDTH-115} y={PITCH_HEIGHT/2-85} width="95" height="170"/>
          <rect x={PITCH_WIDTH-62} y={PITCH_HEIGHT/2-42} width="42" height="84"/>
          <rect x="4" y={PITCH_HEIGHT/2-30} width="16" height="60" strokeWidth="2.5"/>
          <rect x={PITCH_WIDTH-20} y={PITCH_HEIGHT/2-30} width="16" height="60" strokeWidth="2.5"/>
          <circle cx="80" cy={PITCH_HEIGHT/2} r="2.5" fill="rgba(255,255,255,0.55)"/>
          <circle cx={PITCH_WIDTH-80} cy={PITCH_HEIGHT/2} r="2.5" fill="rgba(255,255,255,0.55)"/>
        </g>

        {teamB.map(p=>{
          const isDrag=dragging?.id===p.id;
          return (
            <g key={p.id} data-d={p.id} style={{cursor:isDrag?"grabbing":"grab",transition:animating&&!isDrag?"all 0.5s cubic-bezier(.25,1.4,.5,1)":"none"}}>
              <circle cx={p.x} cy={p.y} r={PLAYER_R} fill={isDrag?"#991b1b":"#dc2626"} stroke={isDrag?"#fca5a5":"#fca5a5"} strokeWidth={isDrag?3:2} opacity="0.93" style={{filter:isDrag?"drop-shadow(0 0 9px #f87171)":"none"}}/>
              <text x={p.x} y={p.y+1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8.5" fontWeight="700" style={{pointerEvents:"none"}}>{p.label}</text>
            </g>
          );
        })}

        {teamA.map(p=>{
          const isDrag=dragging?.id===p.id;
          return (
            <g key={p.id} data-d={p.id} style={{cursor:isDrag?"grabbing":"grab"}}>
              <circle cx={p.x} cy={p.y} r={PLAYER_R} fill={isDrag?"#1d4ed8":"#2563eb"} stroke={isDrag?"#93c5fd":"#bfdbfe"} strokeWidth={isDrag?3:2} opacity="0.95" style={{filter:isDrag?"drop-shadow(0 0 9px #60a5fa)":"none"}}/>
              <text x={p.x} y={p.y+1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize="8.5" fontWeight="700" style={{pointerEvents:"none"}}>{p.label}</text>
            </g>
          );
        })}

        <g data-d="ball" style={{cursor:isDragBall?"grabbing":"grab"}}>
          {isDragBall&&<circle cx={ball.x} cy={ball.y} r={BALL_R+6} fill="rgba(255,255,255,0.2)"/>}
          <text x={ball.x} y={ball.y} textAnchor="middle" dominantBaseline="middle" fontSize={BALL_R*2.2} style={{pointerEvents:"none",userSelect:"none"}}>⚽</text>
          <circle cx={ball.x} cy={ball.y} r={BALL_R} fill="transparent"/>
        </g>
      </svg>

      {/* Buttons */}
      <div style={{display:"flex",gap:10,marginTop:14}}>
        <button onClick={undo} disabled={!history.length} style={{padding:"9px 22px",borderRadius:8,border:"1px solid #374151",background:"#111827",color:history.length?"#fde68a":"#374151",fontSize:13,fontWeight:600,cursor:history.length?"pointer":"default"}}>← 戻す</button>
        <button onClick={redo} disabled={!future.length} style={{padding:"9px 22px",borderRadius:8,border:"1px solid #374151",background:"#111827",color:future.length?"#fde68a":"#374151",fontSize:13,fontWeight:600,cursor:future.length?"pointer":"default"}}>進む →</button>
        <button onClick={reset} style={{padding:"9px 22px",borderRadius:8,border:"1px solid #374151",background:"#111827",color:"#d1fae5",fontSize:13,fontWeight:600,cursor:"pointer"}}>リセット</button>
      </div>
    </div>
  );
}
