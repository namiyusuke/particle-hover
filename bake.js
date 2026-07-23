// 点群ベイクスクリプト（一度だけ使う使い捨てツール）。
//
// public/*.glb を読み込み、表面から TEXTURE_WIDTH 点をサンプリングした結果を
// Float32 の生バイナリ(.bin)としてダウンロードする。ここで生成した .bin を
// public/points/ に置けば、本番(main.js)は GLB を読まずにこの .bin を fetch するだけになる。
//
// 使い方:
//   1. npm run dev
//   2. ブラウザで http://localhost:5173/bake.html を開く
//   3. ボタンを押すと asano.bin 〜 yamamoto.bin が順にダウンロードされる
//   4. それらを public/points/ に移動する
//   5. 確認できたら bake.html / bake.js は削除してよい（public/*.glb も配信から外せる）
//
// 注意: main.js の COUNT と必ず一致させること（点数がテクスチャサイズと結びついている）。

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// ↓ main.js と同じ値にすること
const COUNT = 200;
const TEXTURE_WIDTH = COUNT ** 2;

const MODELS = [
  { shape: "asano", url: "/asano.glb" },
  { shape: "daijima", url: "/daijima.glb" },
  { shape: "funahashi", url: "/funahashi.glb" },
  { shape: "hara", url: "/hara.glb" },
  { shape: "hasegawa", url: "/hasegawa.glb" },
  { shape: "ikeda", url: "/ikeda.glb" },
  { shape: "minato", url: "/minato.glb" },
  { shape: "nakagawa", url: "/nakagawa.glb" },
  { shape: "nenoki", url: "/nenoki.glb" },
  { shape: "yamamoto", url: "/yamamoto.glb" },
];

// main.js の glbPoints() と同一ロジック（実績あるコードをそのまま流用）
async function glbPoints(url, count) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);

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

  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.boundingBox.getSize(size);
  const scale = 1.0 / Math.max(size.x, size.y, size.z);

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

const logEl = document.getElementById("log");
const linksEl = document.getElementById("links");
function log(msg) {
  console.log(msg);
  if (logEl) logEl.textContent += msg + "\n";
}

// 計算した点群ごとに「ダウンロード」ボタンを1つ生成する。
// クリック=ユーザー操作なので、ブラウザの複数自動DLブロックに引っかからない。
function addDownloadButton(name, float32) {
  const url = URL.createObjectURL(new Blob([float32.buffer], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.textContent = `⬇ ${name}`;
  a.className = "dl";
  linksEl.appendChild(a);
}

async function bakeAll() {
  const btn = document.getElementById("run");
  if (btn) btn.disabled = true;
  linksEl.innerHTML = "";
  logEl.textContent = "";
  log(`ベイク開始: COUNT=${COUNT} → ${TEXTURE_WIDTH} 点 / モデル`);
  for (const m of MODELS) {
    try {
      const t0 = performance.now();
      const pts = await glbPoints(m.url, TEXTURE_WIDTH);
      addDownloadButton(`${m.shape}.bin`, pts);
      const kb = Math.round((pts.byteLength / 1024) * 10) / 10;
      log(`✅ ${m.shape}.bin (${kb}KB, ${Math.round(performance.now() - t0)}ms)`);
    } catch (e) {
      log(`❌ ${m.shape}: ${e.message}`);
    }
  }
  log("完了。下のボタンを1つずつ押して10個の .bin を保存し、public/points/ に移動してください。");
  if (btn) btn.disabled = false;
}

document.getElementById("run").addEventListener("click", bakeAll);
// 「全部ダウンロード」: 各ボタンを順にクリック。初回は許可プロンプトが出るので
// 「複数ファイルのダウンロードを許可」を選べば以降まとめて落ちる。
document.getElementById("all").addEventListener("click", () => {
  linksEl.querySelectorAll("a.dl").forEach((a, i) => setTimeout(() => a.click(), i * 300));
});
