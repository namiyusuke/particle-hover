// 各メンバーカードの写真を、ホバーで粒子化して散らし、ホバー解除で元へ戻す。
// 旧実装は 2D canvas に矩形(fillRect)を毎フレーム描いていて、四角い粒＝荒く・重かった。
// ここでは THREE.js の GPU パーティクルに置き換え、丸くソフトに発光する粒が弾けて散る。
//
// 描画コンテキストはカードごとに作らず、画面全体に固定した「共有オーバーレイ」1枚に集約し、
// main.js と同じく各カードの矩形へ scissor で描く（WebGLコンテキスト数の上限対策＆軽量化）。
// 画像はローカル配信(/members/*)なので getImageData でピクセル色を読める。

import * as THREE from "three";

const CARD_SELECTOR = ".p-mem-list-item";
const STEP = 1; // 粒子1つあたりの元ピクセル間隔(px)。小さいほど細かく重い。
const SPEED = 0.03; // 分解/再構成アニメの速さ(0〜1/frame)

// 弾け(散り)の勢い。旧実装より大きめにして「バッと弾ける」感を出す。
const BURST_MIN = 54; // 散る距離の最小(px)
const BURST_RANGE = 130; // 散る距離のばらつき(px)
const RISE = 26; // 上方向へのバイアス(px)。ふわっと舞い上がる
const GRAVITY = 16; // 落下量(px)。lp^2 で効かせる
const MARGIN = 160; // カード枠の外へ粒が飛べる余白(px)。描画領域をこのぶん広げる
const RADIUS = 4; // 写真の角丸半径(px)。CSS の .p-mem-list-item .img と一致させる

const vertexShader = /* glsl */ `
  attribute vec2 aVel;    // 散る方向・速度(px)
  attribute float aDelay; // 散り始めの遅れ(0〜0.35)
  attribute vec3 aColor;  // 元のピクセル色(0〜1)
  attribute float aGray;  // 輝度グレー(0〜1)

  uniform float uProgress; // 0=写真そのまま, 1=完全に散った
  uniform float uSize;     // 粒の基本サイズ(デバイスpx)
  uniform float uGravity;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // delay を考慮した各粒子の進行度 0〜1
    float denom = max(1.0 - aDelay, 0.0001);
    float lp = clamp((uProgress - aDelay) / denom, 0.0, 1.0);

    // 移動量はイーズイン(lp^2)。始めは動かず写真とシームレス、後半で一気に弾ける。
    // 戻りは逆再生で着地が緩やか＝カクつき(ガタッ)を無くす。
    float move = lp * lp;

    vec3 pos = position;
    pos.x += aVel.x * move;
    pos.y += aVel.y * move + uGravity * move * move; // 重力で落ちる

    // 散るほど 元色 → 白黒 へ寄せる
    vColor = mix(aColor, vec3(aGray), lp);
    vAlpha = 1.0 - lp; // 散り切るほど透明

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    // 散るにつれ少し大きく＝弾けて広がる印象
    gl_PointSize = uSize * (1.0 + lp * 0.6);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 丸いソフト粒。中心はほぼ不透明、縁だけ柔らかく落として四角さ(荒さ)を消す
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float edge = smoothstep(1.0, 0.75, d);
    float a = vAlpha * edge;
    if (a <= 0.001) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// ---- 共有オーバーレイ（レンダラーは全カードで1つだけ）----
let RENDERER = null;
// 写真は常に粒子(テクスチャ)で表示する。ビルド済みカードは常時この集合に入り、
// 毎フレーム自分の現在 progress で描かれる（静止時=progress0=写真そのもの）。
// こうして「写真⇄粒子」の切り替えを無くし、戻り時のつなぎ目(動き)を消す。
const RENDERSET = new Set();
let rafId = null;

function dpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function getRenderer() {
  if (RENDERER) return RENDERER;
  const r = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  r.setPixelRatio(dpr());
  r.setSize(window.innerWidth, window.innerHeight);
  r.setClearColor(0x000000, 0);
  r.autoClear = false; // クリアを手動制御（scissor と併用）

  const c = r.domElement;
  // 従来の .photo-particles と同じ重なり（コンテンツ=1 の前・#container=3 の後ろ）
  c.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;";
  document.body.appendChild(c);

  window.addEventListener("resize", () => {
    r.setPixelRatio(dpr());
    r.setSize(window.innerWidth, window.innerHeight);
  });

  RENDERER = r;
  return r;
}

// ビルド済みの全カードを毎フレーム描く単一ループ（常時表示なので回し続ける）
function loop() {
  const r = getRenderer();
  r.setScissorTest(false);
  r.clear(); // 画面全体を透明にクリアしてから各カードを描く

  RENDERSET.forEach((inst) => inst.renderFrame(r));

  // タブが見えている限り回し続ける。非表示になったら止める。
  rafId = RENDERSET.size > 0 && document.visibilityState !== "hidden" ? requestAnimationFrame(loop) : null;
}

function ensureLoop() {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

// タブ復帰時にループを再開
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") ensureLoop();
});

class PhotoDissolve {
  constructor(card) {
    this.card = card;
    this.imgBox = card.querySelector(".img");
    this.img = card.querySelector(".img img");
    this.built = false;
    this.progress = 0; // 0=写真そのまま, 1=完全に散った
    this.dir = 0; // +1 散る / -1 戻る

    this.scene = null;
    this.camera = null;
    this.points = null;
    this.material = null;

    card.addEventListener("mouseenter", () => this.enter());
    card.addEventListener("mouseleave", () => this.leave());
  }

  // object-fit: cover と同じ切り取りで画像をオフスクリーンに描く
  coverDraw(ctx, w, h) {
    const img = this.img;
    const ir = img.naturalWidth / img.naturalHeight;
    const cr = w / h;
    let dw, dh, dx, dy;
    if (ir > cr) {
      dh = h;
      dw = h * ir;
      dx = (w - dw) / 2;
      dy = 0;
    } else {
      dw = w;
      dh = w / ir;
      dx = 0;
      dy = (h - dh) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // 表示サイズで画像をサンプリングし、粒子ジオメトリを生成する
  build() {
    if (!this.img.complete || this.img.naturalWidth === 0) return false;

    const rect = this.imgBox.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    this.W = W;
    this.H = H;

    // オフスクリーンに cover で描いてピクセル取得
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d", { willReadFrequently: true });
    this.coverDraw(octx, W, H);
    const data = octx.getImageData(0, 0, W, H).data;

    // 角丸(border-radius)の外側は粒子を作らない＝輪郭を写真と同じ角丸にする
    const cornerOutside = (x, y) => {
      const cx = Math.min(Math.max(x, RADIUS), W - RADIUS);
      const cy = Math.min(Math.max(y, RADIUS), H - RADIUS);
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy > RADIUS * RADIUS;
    };

    // 2パス方式: まず有効ピクセル数を数え、TypedArray を1回だけ確保して直接書く。
    // （動的 push + Float32BufferAttribute のコピーは粒子数が多いと重く、ホバーが固まる）
    let n = 0;
    for (let y = 0; y < H; y += STEP) {
      for (let x = 0; x < W; x += STEP) {
        if (data[(y * W + x) * 4 + 3] < 8) continue;
        if (cornerOutside(x, y)) continue;
        n++;
      }
    }

    const homes = new Float32Array(n * 3);
    const vels = new Float32Array(n * 2);
    const delays = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const grays = new Float32Array(n);

    let k = 0;
    for (let y = 0; y < H; y += STEP) {
      for (let x = 0; x < W; x += STEP) {
        const i = (y * W + x) * 4;
        if (data[i + 3] < 8) continue; // 透明はスキップ
        if (cornerOutside(x, y)) continue; // 角丸の外はスキップ
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const ang = Math.random() * Math.PI * 2;
        const spd = BURST_MIN + Math.random() * BURST_RANGE;

        homes[k * 3] = x;
        homes[k * 3 + 1] = y;
        // 散る方向。y は上方向へバイアス（画面座標は下向き＋なので負で上）
        vels[k * 2] = Math.cos(ang) * spd;
        vels[k * 2 + 1] = Math.sin(ang) * spd - RISE;
        delays[k] = Math.random() * 0.35;
        colors[k * 3] = r / 255;
        colors[k * 3 + 1] = g / 255;
        colors[k * 3 + 2] = b / 255;
        grays[k] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        k++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(homes, 3));
    geo.setAttribute("aVel", new THREE.BufferAttribute(vels, 2));
    geo.setAttribute("aDelay", new THREE.BufferAttribute(delays, 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aGray", new THREE.BufferAttribute(grays, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uProgress: { value: 0 },
        // 粒サイズ。グリッド(STEP)を少し上回らせて、静止時に隙間なく写真を覆う
        uSize: { value: STEP * dpr() * 1.8 },
        uGravity: { value: GRAVITY },
      },
      vertexShader,
      fragmentShader,
    });

    this.points = new THREE.Points(geo, this.material);

    this.scene = new THREE.Scene();
    this.scene.add(this.points);

    // 画像ピクセル座標(左上原点・y下向き)に合わせた正射影カメラ。
    // 上下左右へ MARGIN ぶん広げ、枠外へ飛んだ粒も見えるようにする。
    this.camera = new THREE.OrthographicCamera(-MARGIN, W + MARGIN, -MARGIN, H + MARGIN, -1000, 1000);

    this.built = true;
    RENDERSET.add(this);

    const r = getRenderer();
    // シェーダー/ジオメトリを事前にGPUへアップロード＆コンパイルしておく。
    r.compile(this.scene, this.camera);

    // 実写真を隠す“前”に粒子を1回描いておく。隠す→次フレームで描画、の間に
    // 生じる空白フレーム（一瞬パッと入れ替わって動いて見える）を防ぐ。
    r.setScissorTest(false);
    this.renderFrame(r); // dir=0 なので progress0 のまま描画される

    // 以降は常に粒子(テクスチャ)を表示。位置はピクセル一致なので差し替えはシームレス。
    this.card.classList.add("dissolving");
    ensureLoop();

    return true;
  }

  // 画像が使えるならビルドする（読み込み後のアイドル時に呼ぶ先読み用）
  prebuild() {
    if (this.built) return;
    if (this.img.complete && this.img.naturalWidth > 0) {
      this.build();
    } else {
      this.img.addEventListener("load", () => this.prebuild(), { once: true });
    }
  }

  enter() {
    if (!this.built && !this.build()) {
      // 画像未ロードならロード後に開始
      this.img.addEventListener("load", () => this.enter(), { once: true });
      return;
    }
    this.dir = 1; // 散らす
  }

  leave() {
    if (!this.built) return;
    this.dir = -1; // 定位置(progress0)へ戻す
  }

  // 登場演出: 散った状態(progress1=透明)から集合(0)へ。粒子が集まって像を結ぶ。
  intro() {
    if (!this.built) return;
    this.progress = 1;
    this.dir = -1;
  }

  // 共有ループから毎フレーム呼ばれる。常に自分の現在 progress で描く。
  // progress0=写真そのもの / 途中=散る / 1=散り切って透明。
  renderFrame(r) {
    if (this.dir !== 0) {
      this.progress += this.dir * SPEED;
      if (this.progress <= 0) {
        this.progress = 0;
        this.dir = 0; // 定位置で静止（写真として表示し続ける。集合からは外さない）
      } else if (this.progress >= 1) {
        this.progress = 1;
        this.dir = 0; // 散り切って静止（ホバー保持中）
      }
    }

    const rect = this.imgBox.getBoundingClientRect();
    // 画面外なら描かない（可視カードだけ描画してGPUを節約）
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return;
    }

    // カード矩形を MARGIN ぶん広げた領域に描く（枠外へ弾けた粒も表示）。
    // カメラも同じだけ広げてあるので、写真部分の画面上の大きさ・位置は変わらない。
    const x = rect.left - MARGIN;
    const y = window.innerHeight - rect.bottom - MARGIN; // WebGL は左下原点
    const w = rect.width + MARGIN * 2;
    const h = rect.height + MARGIN * 2;
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);

    this.material.uniforms.uProgress.value = this.progress;
    r.render(this.scene, this.camera);
  }

  // リサイズで表示サイズが変わったら作り直す
  invalidate() {
    if (this.points) {
      this.points.geometry.dispose();
      this.material.dispose();
    }
    this.built = false;
    this.progress = 0;
    this.dir = 0;
    RENDERSET.delete(this);
    this.card.classList.remove("dissolving"); // ビルドし直すまでは実写真を表示
  }
}

// 読み込み後のアイドル時間に1カードずつ先読みビルドする。
// ホバー時にはビルド済みなので、重い処理でカクつく(ガタッ)ことがない。
function schedulePrebuild(instances) {
  const idle =
    window.requestIdleCallback || ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 32));
  let i = 0;
  const step = () => {
    if (i >= instances.length) return;
    instances[i++].prebuild();
    idle(step); // 1カードずつ。1フレームに詰め込まず負荷を分散
  };
  idle(step);
}

function setupResize(instances) {
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      instances.forEach((i) => i.invalidate());
      schedulePrebuild(instances); // 新しいサイズで再び先読みしておく
    }, 200);
  });
}

// 横長プログレスバーのローディング画面。各メンバー画像の読み込み＋粒子ビルドの
// 進捗でゲージを満タンにし、満タン後にフェードアウトして粒子（＝写真）を登場させる。
function runLoader(instances) {
  const style = document.createElement("style");
  style.textContent = `
    .pp-loader{position:fixed;inset:0;z-index:2147483647;background:#000;
      display:flex;align-items:center;justify-content:center;
      transition:opacity .6s ease;}
    .pp-loader.-hide{opacity:0;pointer-events:none;}
    .pp-loader__bar{position:relative;width:min(30vw,220px);height:12px;
      background:rgba(255,255,255,.14);overflow:hidden;border-radius:2px;}
    .pp-loader__fill{position:absolute;inset:0;transform-origin:left center;
      transform:scaleX(0);background:#fff;will-change:transform,opacity;
      transition:transform .35s ease-out;}
    /* 満タン後の完了フラッシュ。不規則なリズム＋発光で単調にしない（ワンショット） */
    .pp-loader__fill.-blink{animation:pp-blink .9s linear 1 both;}
    @keyframes pp-blink{
      0%  {opacity:1;   box-shadow:0 0 0 0 rgba(255,255,255,0);}
      7%  {opacity:.1;}
      12% {opacity:1;   box-shadow:0 0 14px 2px rgba(255,255,255,.9);}
      18% {opacity:.15; box-shadow:0 0 0 0 rgba(255,255,255,0);}
      24% {opacity:1;}
      40% {opacity:.1;}
      48% {opacity:1;   box-shadow:0 0 20px 4px rgba(255,255,255,1);}
      56% {opacity:.2;  box-shadow:0 0 0 0 rgba(255,255,255,0);}
      64% {opacity:1;}
      72% {opacity:.15;}
      80% {opacity:1;   box-shadow:0 0 16px 3px rgba(255,255,255,.95);}
      90% {opacity:.35; box-shadow:0 0 0 0 rgba(255,255,255,0);}
      100%{opacity:1;   box-shadow:0 0 0 0 rgba(255,255,255,0);}
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.className = "pp-loader";
  overlay.innerHTML = '<div class="pp-loader__bar"><div class="pp-loader__fill"></div></div>';
  document.body.appendChild(overlay);
  const fill = overlay.querySelector(".pp-loader__fill");

  // 演出タイムライン（急ぎすぎないよう各フェーズに時間を確保）
  const MIN_FILL = 1000; // ①満タンになるまで最低これだけ充填を見せる(ms)
  const BLINK_HOLD = 900; // ②満タン後に点滅を見せる時間(ms)
  const HOLD_LIT = 250; // ③点滅を止めて点灯を見せてから
  const startT = performance.now();

  const total = Math.max(1, instances.length);
  let done = 0;
  let finished = false;
  // バー幅は CSS トランジションで滑らかに伸ばす（ビルドでメインスレッドが詰まっても
  // コンポジタ側で動くのでカクつかない）
  const setBar = () => {
    fill.style.transform = `scaleX(${Math.min(1, done / total)})`;
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    fill.style.transform = "scaleX(1)"; // ①満タン
    // ②満タンになってから点滅させる
    fill.classList.add("-blink");
    setTimeout(() => {
      // ③点滅を止めて点灯
      fill.classList.remove("-blink");
      fill.style.opacity = "1";
      setTimeout(() => {
        // ④粒子を集めて登場（散った状態→集合）させつつ、黒幕をフェードアウト。
        //    暗闇から粒子が集まって写真を結ぶ見せ方。
        instances.forEach((inst) => inst.intro());
        overlay.classList.add("-hide");
        overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      }, HOLD_LIT);
    }, BLINK_HOLD);
  };

  // 満タン到達後、最低充填時間を満たしてから finish（＝早すぎる表示を防ぐ）
  let completing = false;
  const tryComplete = () => {
    if (completing) return;
    completing = true;
    const wait = Math.max(0, MIN_FILL - (performance.now() - startT));
    setTimeout(finish, wait);
  };

  // 画像は並列で確実に読み込む（eager化）。読めたものからビルド待ち行列へ。
  const queue = [];
  instances.forEach((inst) => {
    const img = inst.img;
    try { img.loading = "eager"; } catch (e) {}
    if (img.complete && img.naturalWidth > 0) {
      queue.push(inst);
    } else {
      img.addEventListener("load", () => queue.push(inst), { once: true });
      // 読めない画像は進捗だけ進める（詰まり防止）
      img.addEventListener("error", () => { done++; setBar(); }, { once: true });
    }
  });

  // ビルドは1フレーム1件ずつ（間に描画を挟んでバーを滑らかに）
  const pump = () => {
    if (queue.length) {
      const inst = queue.shift();
      try { inst.prebuild(); } catch (e) {}
      done++;
      setBar();
    }
    if (done >= total) return tryComplete();
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);

  // 保険: 何かで詰まっても一定時間で強制的に完了させる
  setTimeout(tryComplete, 8000);
}

function boot() {
  const instances = [];
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    if (card.querySelector(".img img")) instances.push(new PhotoDissolve(card));
  });
  setupResize(instances);
  runLoader(instances);
}

if (document.readyState !== "loading") boot();
else document.addEventListener("DOMContentLoaded", boot);
