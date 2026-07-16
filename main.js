import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import vertex from "./shader/vertex.glsl";
import fragment from "./shader/fragment.glsl";
import { GPUComputationRenderer } from "three/examples/jsm/misc/GPUComputationRenderer.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import fragmentShaderVelocity from "./shader/simFragmentVelocity.glsl";
import fragmentShaderPosition from "./shader/simFragmentPosition.glsl";
import PoissonDiskSampling from "poisson-disk-sampling";
const t1 = "/1.jpg";
const t2 = "/2.png";
let COUNT = 250;
let TEXTURE_WIDTH = COUNT ** 2;

// public/ 内の全 GLB。label が index.html の .word と、shape が data-shape と対応する。
const MODELS = [
  { shape: "asano", label: "ASANO", url: "/asano.glb" },
  { shape: "daijima", label: "DAIJIMA", url: "/daijima.glb" },
  { shape: "funahashi", label: "FUNAHASHI", url: "/funahashi.glb" },
  { shape: "hara", label: "HARA", url: "/hara.glb" },
  { shape: "hasegawa", label: "HASEGAWA", url: "/hasegawa.glb" },
  { shape: "ikeda", label: "IKEDA", url: "/ikeda.glb" },
  { shape: "minato", label: "MINATO", url: "/minato.glb" },
  { shape: "nakagawa", label: "NAKAGAWA", url: "/nakagawa.glb" },
  { shape: "nenoki", label: "NENOKI", url: "/nenoki.glb" },
  { shape: "yamamoto", label: "YAMAMOTO", url: "/yamamoto.glb" },
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

// GLB(glTF)のメッシュ表面から点群(Float32Array [x,y,z, ...])を生成する。
// モデル内の全メッシュをワールド変換して結合し、表面積に応じて一様サンプリングする。
async function glbPoints(url, count) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);

  // 各メッシュを position 属性だけに絞り、ワールド座標へ展開して結合
  const geoms = [];
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const g = child.geometry.clone().applyMatrix4(child.matrixWorld).toNonIndexed();
    const only = new THREE.BufferGeometry();
    only.setAttribute("position", g.getAttribute("position"));
    geoms.push(only);
  });
  if (geoms.length === 0) throw new Error("GLB にメッシュが見つかりません: " + url);
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms);

  // 中心を原点へ、最大辺が 1.0 になるよう正規化（他の立体と同じスケール感に揃える）
  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.boundingBox.getSize(size);
  const scale = 1.0 / Math.max(size.x, size.y, size.z);

  // 面積重み付きサンプリング: 大きい面ほど多くの点が乗る
  const sampler = new MeshSurfaceSampler(new THREE.Mesh(merged)).build();
  const arr = new Float32Array(count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    sampler.sample(p);
    arr[i * 3 + 0] = (p.x - center.x) * scale;
    arr[i * 3 + 1] = (p.y - center.y) * scale;
    arr[i * 3 + 2] = (p.z - center.z) * scale;
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
    // 初期位置=球。ホバーで各 GLB モデルの表面へ切り替わる。
    this.points1 = spherePoints(TEXTURE_WIDTH);
    // 全 GLB の点群を並列生成し、shape 名 → 点群 のマップにする
    const modelPoints = await Promise.all(MODELS.map((m) => glbPoints(m.url, TEXTURE_WIDTH)));
    this.modelPoints = {};
    MODELS.forEach((m, i) => {
      this.modelPoints[m.shape] = modelPoints[i];
    });
    // 初期ターゲット（クリック切り替え用の B）に使う最初のモデル
    this.points2 = modelPoints[0];

    await this.loadAssets();
    this.addObjects();
    this.initGPU();
    this.resize();
    this.setupResize();
    this.setupTextHover();
    this.render();
  }

  // シミュレーションの引き寄せ先テクスチャを差し替える
  setTarget(texture) {
    this.velocityUniforms["uTarget"].value = texture;
  }

  // 各テキストに形状(点群)を紐づけ、ホバーでその形状にパーティクルを切り替える
  setupTextHover() {
    // ラベル名 → 点群。各 GLB モデルに対応する。
    const shapes = {
      ...this.modelPoints, // 全 GLB（init で読み込み済み）
    };

    // index.html の .word ラベルと about.html のメンバー一覧、両方の data-shape に対応
    const words = document.querySelectorAll("[data-shape]");
    words.forEach((el) => {
      const points = shapes[el.dataset.shape];
      if (!points) return;

      el.addEventListener("mouseenter", () => {
        fillPositionTexture(this.dynamicTarget, points); // 動的ターゲットを紐づけ形状に更新
        this.setTarget(this.dynamicTarget);
        this.activeEl = el;
        this.activeBox = el.querySelector(".img"); // カード内の写真枠。無ければ全画面表示
        words.forEach((w) => w.classList.remove("active"));
        el.classList.add("active"); // 写真をフェードアウト（CSS 側）
      });

      // ホバーを外したら写真を戻し、パーティクルも待機状態（球）へ戻す
      el.addEventListener("mouseleave", () => {
        el.classList.remove("active");
        this.setTarget(this.baseTarget);
        if (this.activeEl === el) {
          this.activeEl = null; // 何もホバーしていない間は描画しない（背景を消す）
          this.activeBox = null;
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

    if (this.activeEl) {
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
