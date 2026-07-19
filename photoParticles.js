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
const ACTIVE = new Set(); // アニメーション中のインスタンス
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

// アニメーション中のインスタンスをまとめて描く単一ループ
function loop() {
  const r = getRenderer();
  r.setScissorTest(false);
  r.clear(); // 画面全体を透明にクリアしてから各カードを描く

  ACTIVE.forEach((inst) => inst.renderFrame(r));

  rafId = ACTIVE.size > 0 ? requestAnimationFrame(loop) : null;
}

function ensureLoop() {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

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

    // 有効ピクセル数を数えてから typed array を確保
    const homes = [];
    const vels = [];
    const delays = [];
    const colors = [];
    const grays = [];
    // 角丸(border-radius)の外側は粒子を作らない＝輪郭を写真と同じ角丸にする
    const cornerOutside = (x, y) => {
      const cx = Math.min(Math.max(x, RADIUS), W - RADIUS);
      const cy = Math.min(Math.max(y, RADIUS), H - RADIUS);
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy > RADIUS * RADIUS;
    };

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

        homes.push(x, y, 0);
        // 散る方向。y は上方向へバイアス（画面座標は下向き＋なので負で上）
        vels.push(Math.cos(ang) * spd, Math.sin(ang) * spd - RISE);
        delays.push(Math.random() * 0.35);
        colors.push(r / 255, g / 255, b / 255);
        grays.push((0.299 * r + 0.587 * g + 0.114 * b) / 255);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(homes, 3));
    geo.setAttribute("aVel", new THREE.Float32BufferAttribute(vels, 2));
    geo.setAttribute("aDelay", new THREE.Float32BufferAttribute(delays, 1));
    geo.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("aGray", new THREE.Float32BufferAttribute(grays, 1));

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
    return true;
  }

  enter() {
    if (!this.built && !this.build()) {
      // 画像未ロードならロード後に開始
      this.img.addEventListener("load", () => this.enter(), { once: true });
      return;
    }
    this.card.classList.add("dissolving"); // 元写真を隠す(CSS)
    this.dir = 1;
    ACTIVE.add(this);
    ensureLoop();
  }

  leave() {
    if (!this.built) return;
    this.dir = -1;
    ACTIVE.add(this);
    ensureLoop();
  }

  // 共有ループから毎フレーム呼ばれる。進行度を進めて自分の矩形へ描く。
  renderFrame(r) {
    this.progress += this.dir * SPEED;

    let stop = false;
    if (this.progress <= 0) {
      // 完全に再構成 → 元写真へ戻す
      this.progress = 0;
      this.card.classList.remove("dissolving");
      stop = true;
    } else if (this.progress >= 1) {
      this.progress = 1;
      if (this.dir > 0) stop = true; // 散り切って静止（全粒が透明）
    }

    // progress>0 のときだけ描画（0 のときは写真に戻すので描かない）
    if (this.progress > 0) {
      const rect = this.imgBox.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
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
    }

    if (stop) ACTIVE.delete(this);
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
    ACTIVE.delete(this);
    this.card.classList.remove("dissolving");
  }
}

function init() {
  const instances = [];
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    if (card.querySelector(".img img")) instances.push(new PhotoDissolve(card));
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => instances.forEach((i) => i.invalidate()), 200);
  });
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
