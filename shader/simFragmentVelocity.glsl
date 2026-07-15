uniform float time;
uniform sampler2D uTarget;   // ターゲット位置(画像B)
uniform float attraction;    // バネ係数
uniform float damping;       // 減衰(摩擦)

// texturePosition / textureVelocity / resolution は
// GPUComputationRenderer が自動で用意してくれる

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;

  vec3 pos = texture2D(texturePosition, uv).xyz;
  vec3 vel = texture2D(textureVelocity, uv).xyz;
  vec3 target = texture2D(uTarget, uv).xyz;
  vel *= .85;
  vel += (target - pos) * 2.;
  // バネ力: ターゲットへ引き寄せる（フックの法則）
  // vel += (target - pos) * attraction;

  // 減衰: これが無いと永久に振動する。1.0 に近いほど慣性が強い
  // vel *= damping;

  gl_FragColor = vec4(vel, 1.0);
}
