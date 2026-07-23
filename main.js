import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import vertex from "./shader/vertex.glsl";
import fragment from "./shader/fragment.glsl";
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import fragmentShaderVelocity from "./shader/simFragmentVelocity.glsl";
import fragmentShaderPosition from "./shader/simFragmentPosition.glsl";
import PoissonDiskSampling from "poisson-disk-sampling";
const t1 = "/1.jpg";
const t2 = "/2.png";
let COUNT = 250;
let TEXTURE_WIDTH = COUNT ** 2;

// public/points/ 内の事前ベイク済み点群(.bin)。label が index.html の .word と、
// shape が data-shape と対応する。.bin は bake.html で GLB から一度だけ生成する。
const MODELS = [
  { shape: "asano", label: "ASANO", url: "/points/asano.bin" },
  { shape: "daijima", label: "DAIJIMA", url: "/points/daijima.bin" },
  { shape: "funahashi", label: "FUNAHASHI", url: "/points/funahashi.bin" },
  { shape: "hara", label: "HARA", url: "/points/hara.bin" },
  { shape: "hasegawa", label: "HASEGAWA", url: "/points/hasegawa.bin" },
  { shape: "ikeda", label: "IKEDA", url: "/points/ikeda.bin" },
  { shape: "minato", label: "MINATO", url: "/points/minato.bin" },
  { shape: "nakagawa", label: "NAKAGAWA", url: "/points/nakagawa.bin" },
  { shape: "nenoki", label: "NENOKI", url: "/points/nenoki.bin" },
  { shape: "yamamoto", label: "YAMAMOTO", url: "/points/yamamoto.bin" },
];

// 画像を読み込んで HTMLImageElement を返す
function load(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

// 点群(Float32Array [x,y,z, x,y,z, ...])をテクスチャの各テクセルに書き込む。
// パーティクル i のデータをテクセル i に 1 対 1 で対応させる。
function fillPositionTexture(texture, points) {
  const arr = texture.image.data;
  const count = arr.length / 4;
  for (let i = 0; i < count; i++) {
    arr[i * 4 + 0] = points[i * 3 + 0];
    arr[i * 4 + 1] = points[i * 3 + 1];
    arr[i * 4 + 2] = points[i * 3 + 2];
    arr[i * 4 + 3] = 1.0;
  }
  texture.needsUpdate = true;
}

// 速度テクスチャを 0 で初期化（静止状態からスタート）
function fillVelocityTexture(texture) {
  const arr = texture.image.data;
  for (let i = 0; i < arr.length; i += 4) {
    arr[i + 0] = 0.0;
    arr[i + 1] = 0.0;
    arr[i + 2] = 0.0;
    arr[i + 3] = 1.0;
  }
  texture.needsUpdate = true;
}

// ---- 立体から点群(Float32Array [x,y,z, ...])を生成するヘルパー群 ----

// 球の表面に一様分布
function spherePoints(count, radius = 0.5) {
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1); // 一様にするため acos
    arr[i * 3 + 0] = radius * Math.sin(phi) * Math.cos(theta);
    arr[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    arr[i * 3 + 2] = radius * Math.cos(phi);
  }
  return arr;
}

// 事前ベイク済みの点群(.bin)を読み込む。中身は Float32 の生バイナリ [x,y,z, x,y,z, ...]。
// GLB のダウンロード・パース・サンプリングは bake.html で一度だけ済ませてあるので、
// 実行時はこの fetch だけ。メインスレッドを止めず、待ち時間もほぼゼロになる。
async function loadPoints(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`点群の取得に失敗: ${url} (${res.status})`);
  const arr = new Float32Array(await res.arrayBuffer());
  // 点数はテクスチャサイズ(COUNT×COUNT)と一致している必要がある。
  // COUNT を変えたら bake.html で再ベイクすること。
  if (arr.length !== TEXTURE_WIDTH * 3) {
    throw new Error(`点数不一致 ${url}: ${arr.length / 3} 点 (期待値 ${TEXTURE_WIDTH})。COUNT変更後は再ベイクが必要。`);
  }
  return arr;
}

export default class Sketch {
  constructor(options) {
    this.scene = new THREE.Scene();

    this.container = options.dom;
    this.width = this.container.offsetWidth;
    this.height = this.container.offsetHeight;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.width, this.height);
    this.renderer.setClearColor(0x000000, 0); // 透過。カード以外は下のページが見える
    this.renderer.autoClear = false; // clear をフレームごとに手動制御（scissor と併用）
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);

    // ホバー中の対象。activeEl=ホバー要素 / activeBox=描画を収めるカードの枠（無ければ全画面）
    this.activeEl = null;
    this.activeBox = null;
    this.activeReady = false; // 対象モデルの読み込みが済み、描画してよいか

    // マウス位置（ホバー方向にモデルを少し傾けるため）
    this.mouseX = 0;
    this.mouseY = 0;
    this.pointer = { x: 0, y: 0 }; // カード中心を基準にした -1〜1 の平滑化値
    window.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    this.camera = new THREE.PerspectiveCamera(70, this.width / this.height, 0.01, 1000);

    this.camera.position.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);

    this.isPlaying = true;

    this.init();
  }

  // テクスチャを非同期で読み込む
  async loadAssets() {
    const loader = new THREE.TextureLoader();
    const [texture1, texture2] = await Promise.all([loader.loadAsync(t1), loader.loadAsync(t2)]);
    this.texture1 = texture1;
    this.texture2 = texture2;
  }

  // アセット読み込み完了を待ってから初期化する
  async init() {
    // 初期位置=球。GLB モデルはホバー時に遅延読み込みする（起動時は待たせない）。
    this.points1 = spherePoints(TEXTURE_WIDTH);
    this.points2 = this.points1; // 初期ターゲット用のダミー（起動時に GLB を読まないため球で代用）
    this.modelPoints = {}; // shape 名 → 点群。読み込めたものからキャッシュ
    this.modelLoading = {}; // shape 名 → 読み込み中の Promise（多重読み込み防止）

    await this.loadAssets();
    this.addObjects();
    this.initGPU();
    this.resize();
    this.setupResize();
    this.setupTextHover();
    this.render();
    this.prefetchModels(); // 背景で順次先読みし、後のホバーを即時化
  }

  // 指定 shape の GLB 点群を必要になった時だけ読み込む（キャッシュ＆多重防止）
  loadModel(shape) {
    if (this.modelPoints[shape]) return Promise.resolve(this.modelPoints[shape]);
    if (!this.modelLoading[shape]) {
      const m = MODELS.find((x) => x.shape === shape);
      if (!m) return Promise.reject(new Error("unknown shape: " + shape));
      this.modelLoading[shape] = loadPoints(m.url)
        .then((pts) => {
          this.modelPoints[shape] = pts;
          return pts;
        })
        .catch((e) => {
          this.modelLoading[shape] = null; // 失敗したら再試行できるように解放
          throw e;
        });
    }
    return this.modelLoading[shape];
  }

  // 全モデルを1体ずつ背景で先読み（帯域を占有しすぎないよう直列）
  async prefetchModels() {
    for (const m of MODELS) {
      try {
        await this.loadModel(m.shape);
      } catch (e) {
        /* 個別の失敗は無視して次へ */
      }
    }
  }

  // カード内にローディング表示（スピナー）を出し入れする
  setLoading(el, on) {
    const box = el.querySelector(".img");
    if (!box) return;
    let sp = box.querySelector(".particle-loading");
    if (on && !sp) {
      sp = document.createElement("div");
      sp.className = "particle-loading";
      box.appendChild(sp);
    } else if (!on && sp) {
      sp.remove();
    }
  }

  // 動的ターゲットを指定点群に更新して、そこへパーティクルを引き寄せる
  showModel(points) {
    fillPositionTexture(this.dynamicTarget, points);
    this.setTarget(this.dynamicTarget);
  }

  // シミュレーションの引き寄せ先テクスチャを差し替える
  setTarget(texture) {
    this.velocityUniforms["uTarget"].value = texture;
  }

  // 各カードにホバーで、その shape の GLB モデルを（遅延読み込みして）表示する
  setupTextHover() {
    // index.html の .word ラベルと about.html のメンバー一覧、両方の data-shape に対応
    const words = document.querySelectorAll("[data-shape]");
    words.forEach((el) => {
      const shape = el.dataset.shape;

      el.addEventListener("mouseenter", () => {
        this.activeEl = el;
        this.activeBox = el.querySelector(".img"); // カード内の写真枠。無ければ全画面表示
        words.forEach((w) => w.classList.remove("active"));
        el.classList.add("active"); // 写真をフェードアウト（CSS 側）

        const points = this.modelPoints[shape];
        if (points) {
          this.showModel(points); // 読み込み済みなら即表示
          this.activeReady = true;
        } else {
          // 未読み込み: スピナーを出し、読めたらまだホバー中なら表示
          this.activeReady = false;
          this.setLoading(el, true);
          this.loadModel(shape)
            .then((pts) => {
              this.setLoading(el, false);
              if (this.activeEl === el) {
                this.showModel(pts);
                this.activeReady = true;
              }
            })
            .catch(() => this.setLoading(el, false));
        }
      });

      // ホバーを外したら写真を戻し、描画を止める
      el.addEventListener("mouseleave", () => {
        el.classList.remove("active");
        this.setLoading(el, false);
        this.setTarget(this.baseTarget);
        if (this.activeEl === el) {
          this.activeEl = null; // 何もホバーしていない間は描画しない（背景を消す）
          this.activeBox = null;
          this.activeReady = false;
        }
      });
    });
  }

  setupResize() {
    window.addEventListener("resize", this.resize.bind(this));
  }
  async getPoints(url) {
    const image = await load(url);

    // 画像をサンプリング用の canvas に描いてピクセルを取得
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    // 0〜1 座標の点における画像の明るさ(0〜255)を返す
    const brightnessAt = (x, y) => {
      const px = Math.min(size - 1, (x * size) | 0);
      const py = Math.min(size - 1, (y * size) | 0);
      const i = (py * size + px) * 4;
      return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };

    // ポアソンディスクサンプリング: 点が重ならず均一に散らばる
    const pds = new PoissonDiskSampling({
      shape: [1, 1], // 0〜1 の正方形空間
      minDistance: 4 / 400, // 点どうしの最小間隔
      maxDistance: 10 / 400, // 最大間隔（密度のばらつき）
      tries: 4,
    });
    // 明るい場所にある点だけ残す = 画像の形になる
    const kept = pds.fill().filter(([x, y]) => brightnessAt(x, y) >= 128);

    // シャッフル（切り捨て時に空間の偏りが出ないように）
    for (let i = kept.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [kept[i], kept[j]] = [kept[j], kept[i]];
    }

    // GPGPU は固定数(TEXTURE_WIDTH)を要求するので点数を揃える。
    // 不足ぶんはシャッフル済みの点を巡回して再利用、超過ぶんは切り捨て。
    const count = TEXTURE_WIDTH;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y] = kept.length ? kept[i % kept.length] : [0.5, 0.5];
      positions[i * 3 + 0] = x - 0.5; // -0.5〜0.5 に正規化
      positions[i * 3 + 1] = -(y - 0.5); // y は上下反転
      positions[i * 3 + 2] = 0;
    }
    return positions;
  }
  resize() {
    this.width = this.container.offsetWidth;
    this.height = this.container.offsetHeight;
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }
  initGPU() {
    this.gpuCompute = new GPUComputationRenderer(COUNT, COUNT, this.renderer);

    const dtPosition = this.gpuCompute.createTexture();
    const dtVelocity = this.gpuCompute.createTexture();
    const dtTargetA = this.gpuCompute.createTexture();
    const dtTargetB = this.gpuCompute.createTexture();

    fillPositionTexture(dtPosition, this.points1); // 初期位置 = 画像A
    fillPositionTexture(dtTargetA, this.points1); // ターゲット候補A = 画像A
    fillPositionTexture(dtTargetB, this.points2); // ターゲット候補B = 画像B
    fillVelocityTexture(dtVelocity); // 速度 = 0（静止からスタート）

    // テキストホバー時に書き換える動的ターゲット（文字の点群をここに流し込む）
    this.dynamicTarget = this.gpuCompute.createTexture();

    // クリックで切り替えるための2つのターゲット
    this.targets = [dtTargetA, dtTargetB];
    this.baseIndex = 0; // 待機時は球（A=points1）。ホバー時だけ GLB 形状が現れる
    this.baseTarget = this.targets[this.baseIndex]; // ホバーを離したら戻る先

    this.velocityVariable = this.gpuCompute.addVariable("textureVelocity", fragmentShaderVelocity, dtVelocity);
    this.positionVariable = this.gpuCompute.addVariable("texturePosition", fragmentShaderPosition, dtPosition);

    this.gpuCompute.setVariableDependencies(this.velocityVariable, [this.positionVariable, this.velocityVariable]);
    this.gpuCompute.setVariableDependencies(this.positionVariable, [this.positionVariable, this.velocityVariable]);

    this.velocityUniforms = this.velocityVariable.material.uniforms;
    this.positionUniforms = this.positionVariable.material.uniforms;

    // ターゲットテクスチャ（初期は baseTarget）
    this.velocityUniforms["uTarget"] = { value: this.baseTarget };
    // バネ係数: ターゲットへ引き寄せる強さ（大きいほど速く動く）
    this.velocityUniforms["attraction"] = { value: 0.005 };
    // 減衰: 1.0 に近いほど摩擦が小さく慣性が強い（オーバーシュートして揺れる）
    this.velocityUniforms["damping"] = { value: 0.96 };
    this.velocityUniforms["time"] = { value: 0.0 };
    this.positionUniforms["time"] = { value: 0.0 };

    const error = this.gpuCompute.init();

    if (error !== null) {
      console.error(error);
    }
  }
  addObjects() {
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: {
        time: { value: 0 },
        uPositions: { value: null },
        uTexture1: { value: this.texture1 },
        uTexture2: { value: this.texture2 },
        resolution: { value: new THREE.Vector4() },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
    });
    this.geometry = new THREE.BufferGeometry();
    let count = TEXTURE_WIDTH;
    let positions = new Float32Array(count * 3);
    let reference = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = Math.random() - 0.5;
      positions[i * 3 + 1] = Math.random() - 0.5;
      positions[i * 3 + 2] = 0;
      // テクセル中心を指すよう +0.5。sim シェーダー側(gl_FragCoord)と一致させる
      reference[i * 2] = ((i % COUNT) + 0.5) / COUNT;
      reference[i * 2 + 1] = (Math.floor(i / COUNT) + 0.5) / COUNT;
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("reference", new THREE.BufferAttribute(reference, 2));

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  // addLights() {
  //   const light1 = new THREE.AmbientLight(0xffffff, 1.5);
  //   this.scene.add(light1);

  //   let directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  //   directionalLight.position.set(10, 10, 10);
  //   directionalLight.target.position.set(0, 0, 0);
  //   this.scene.add(directionalLight);
  // }

  render() {
    if (!this.isPlaying) return;
    this.time = (this.time || 0) + 0.05;
    this.material.uniforms.time.value = this.time;

    // 1. GPUでシミュレーションを1ステップ進める
    this.velocityUniforms["time"].value = this.time;
    this.positionUniforms["time"].value = this.time;
    this.gpuCompute.compute();

    // 2. 計算後の最新の位置テクスチャを描画シェーダーへ渡す
    this.material.uniforms.uPositions.value = this.gpuCompute.getCurrentRenderTarget(this.positionVariable).texture;

    // 3. 描画。まず画面全体を透明にクリアし、ホバー中だけ対象領域に描く
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear();

    if (this.activeEl && this.activeReady) {
      if (this.activeBox) {
        // カードの写真枠だけに切り抜いて描画（＝カードの中にパーティクルが出る）
        const rect = this.activeBox.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const x = rect.left;
          const y = window.innerHeight - rect.bottom; // WebGL は左下原点なので上下反転
          r.setViewport(x, y, rect.width, rect.height);
          r.setScissor(x, y, rect.width, rect.height);
          r.setScissorTest(true);
          this.camera.aspect = rect.width / rect.height; // カードの縦横比に合わせる
          this.camera.updateProjectionMatrix();

          // カード内でのマウス位置(-1〜1)に応じてモデルをカーソル方向へ少し傾ける
          const nx = Math.max(-1, Math.min(1, (this.mouseX - (rect.left + rect.width / 2)) / (rect.width / 2)));
          const ny = Math.max(-1, Math.min(1, (this.mouseY - (rect.top + rect.height / 2)) / (rect.height / 2)));
          this.pointer.x += (nx - this.pointer.x) * 0.08; // 平滑化して滑らかに追従
          this.pointer.y += (ny - this.pointer.y) * 0.08;
          this.points.rotation.y = this.pointer.x * 0.5; // 左右の傾き
          this.points.rotation.x = this.pointer.y * 0.3; // 上下の傾き
          this.points.position.x = this.pointer.x * 0.05; // わずかに平行移動も
          this.points.position.y = -this.pointer.y * 0.05;

          r.render(this.scene, this.camera);
        }
      } else {
        // カード枠が無い場合（index.html のラベル等）は従来どおり全画面表示
        r.setViewport(0, 0, this.width, this.height);
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        r.render(this.scene, this.camera);
      }
    }

    // 4. 次フレームを予約
    requestAnimationFrame(this.render.bind(this));
  }
}

new Sketch({
  dom: document.getElementById("container"),
});
