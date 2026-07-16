// 各メンバーカードの写真を、ホバーで粒子化して散らし、ホバー解除で元へ戻す。
// 画面中央の GLB パーティクル(main.js)とは独立した、カードごとの 2D canvas 演出。
// 画像はローカル配信(/members/*)なので getImageData でピクセルを読める。

const CARD_SELECTOR = ".p-mem-list-item";
const STEP = 4; // 粒子1つあたりの元ピクセル間隔(px)。小さいほど細かく重い。
const SPEED = 0.05; // 分解/再構成アニメの速さ(0〜1/frame)

// object-fit: cover と同じ切り取りで画像を canvas に描く
function coverDraw(ctx, img, w, h) {
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

class PhotoDissolve {
  constructor(card) {
    this.card = card;
    this.imgBox = card.querySelector(".img");
    this.img = card.querySelector(".img img");
    this.canvas = null;
    this.ctx = null;
    this.particles = null;
    this.built = false;
    this.progress = 0; // 0=写真そのまま, 1=完全に散った
    this.dir = 0; // +1 散る / -1 戻る
    this.raf = null;

    card.addEventListener("mouseenter", () => this.enter());
    card.addEventListener("mouseleave", () => this.leave());
  }

  ensureCanvas() {
    if (this.canvas) return;
    const c = document.createElement("canvas");
    c.className = "photo-particles";
    this.imgBox.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
  }

  // 表示サイズで画像をサンプリングし、粒子配列を生成する
  build() {
    if (!this.img.complete || this.img.naturalWidth === 0) return false;

    const rect = this.imgBox.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;

    // オフスクリーンに cover で描いてピクセル取得
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d", { willReadFrequently: true });
    coverDraw(octx, this.img, W, H);
    const data = octx.getImageData(0, 0, W, H).data;

    const ps = [];
    for (let y = 0; y < H; y += STEP) {
      for (let x = 0; x < W; x += STEP) {
        const i = (y * W + x) * 4;
        if (data[i + 3] < 8) continue; // 透明はスキップ
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const ang = Math.random() * Math.PI * 2;
        const spd = 8 + Math.random() * 32; // 控えめに漂って消える
        ps.push({
          x,
          y,
          r,
          g,
          b,
          gray: (0.299 * r + 0.587 * g + 0.114 * b) | 0, // 輝度（白黒化用）
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 18, // わずかに上へ
          delay: Math.random() * 0.35, // 粒ごとに散り始めをずらす
        });
      }
    }
    this.particles = ps;
    this.built = true;
    return true;
  }

  enter() {
    this.ensureCanvas();
    if (!this.built && !this.build()) {
      // 画像未ロードならロード後に開始
      this.img.addEventListener("load", () => this.enter(), { once: true });
      return;
    }
    this.card.classList.add("dissolving"); // 元写真を隠す(CSS)
    this.dir = 1;
    this.start();
  }

  leave() {
    if (!this.built) return;
    this.dir = -1;
    this.start();
  }

  start() {
    if (this.raf) cancelAnimationFrame(this.raf);
    const tick = () => {
      this.progress += this.dir * SPEED;

      if (this.progress <= 0) {
        // 完全に再構成 → 元写真へ戻す
        this.progress = 0;
        this.card.classList.remove("dissolving");
        this.clear();
        this.raf = null;
        return;
      }
      if (this.progress >= 1) this.progress = 1;

      this.draw();

      // 散り切って静止したら停止(戻る操作で再開)
      if (this.progress >= 1 && this.dir > 0) {
        this.raf = null;
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  draw() {
    const { ctx, dpr, W, H, particles } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const p = this.progress;
    for (let k = 0; k < particles.length; k++) {
      const pt = particles[k];
      // delay を考慮した各粒子の進行度 0〜1
      const lp = Math.max(0, Math.min(1, (p - pt.delay) / (1 - pt.delay || 1)));
      const alpha = 1 - lp;
      if (alpha <= 0) continue;
      const x = pt.x + pt.vx * lp;
      const y = pt.y + pt.vy * lp + 30 * lp * lp; // 重力で落ちる
      // 散るほど色 → 白黒へ（lp: 0=元色, 1=グレー）
      const cr = (pt.r + (pt.gray - pt.r) * lp) | 0;
      const cg = (pt.g + (pt.gray - pt.g) * lp) | 0;
      const cb = (pt.b + (pt.gray - pt.b) * lp) | 0;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
      ctx.fillRect(x, y, STEP, STEP);
    }
  }

  clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // リサイズで表示サイズが変わったら作り直す
  invalidate() {
    this.built = false;
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
