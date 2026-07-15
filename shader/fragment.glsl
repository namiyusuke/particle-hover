uniform float time;

varying vec2 vUv;
varying vec3 vPosition;

void main() {
   vec3 color = vec3(.2);
  // 円形のポイントにする

  float alpha =1.- length(gl_PointCoord.xy - 0.5) * 2.;
  // 円の外側（alphaが負 = 中心から半径0.5より外）は描画しない
  if (alpha < 0.) {
    discard;
  }
  float finalAlpha =  .5 * smoothstep(.9-fwidth(alpha),.9,alpha);
  gl_FragColor = vec4(color, finalAlpha);
}
