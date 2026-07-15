uniform float time;
uniform sampler2D uPositions;

attribute vec2 reference;

varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vUv = uv;

  // 計算結果テクスチャから、この頂点に対応する位置を読み取る
  vec3 pos = texture2D(uPositions, reference).xyz;
  vPosition = pos;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = 2.0 * (1.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
