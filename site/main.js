// HLS Monitor landing scene.
//
// A broadcast tower streams video frames along a glowing pipeline. The
// Inspector - a scientist with her clipboard - checks each frame as it
// flows past her station: good frames earn a "200 OK" and land in a
// floating browser window; bad ones are flagged and ejected from the
// pipeline. The browser feeds a living-room TV, where an old man on his
// couch enjoys the livestream, blissfully unaware of the quality control
// happening upstream.

import * as THREE from "three";

// ---------------------------------------------------------------- setup

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;

const scene = new THREE.Scene();
const BG = new THREE.Color(0x0b0e17);
scene.background = BG;
scene.fog = new THREE.Fog(BG, 34, 90);

const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 200);
const camBase = new THREE.Vector3(1.2, 6.6, 21.5);
const camTarget = new THREE.Vector3(0.6, 3.0, 0);
camera.position.copy(camBase);
camera.lookAt(camTarget);

// The composition is tuned for 16:9. On narrower windows, keep the whole
// scene in frame: widen the vertical fov to preserve the horizontal extent,
// and dolly the camera back once the fov clamp is reached.
const BASE_ASPECT = 16 / 9;
const BASE_HALF_FOV = THREE.MathUtils.degToRad(25); // half of the 50° base fov
let camDolly = 1;
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h); // updateStyle=true: keeps the canvas CSS size at
  // window size while the buffer scales by devicePixelRatio (HiDPI displays)
  camera.aspect = w / h;
  const need = Math.max(1, BASE_ASPECT / camera.aspect);
  const fovScale = Math.min(need, 1.6);
  camera.fov = 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(BASE_HALF_FOV) * fovScale));
  camDolly = need / fovScale; // > 1 only for very narrow (portrait) windows
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- lights

scene.add(new THREE.AmbientLight(0x8899cc, 1.1));
scene.add(new THREE.HemisphereLight(0x3a4a6e, 0x14161f, 1.0));

const moon = new THREE.DirectionalLight(0xbfd4ff, 2.0);
moon.position.set(-14, 22, 10);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.left = -20;
moon.shadow.camera.right = 20;
moon.shadow.camera.top = 20;
moon.shadow.camera.bottom = -20;
scene.add(moon);

const pipelineGlow = new THREE.PointLight(0x37d7ff, 30, 22);
pipelineGlow.position.set(-1, 4.5, 1);
scene.add(pipelineGlow);

const lampLight = new THREE.PointLight(0xffb36b, 30, 15);
lampLight.position.set(3.0, 3.4, 10.0);
scene.add(lampLight);

// ---------------------------------------------------------------- ground & stars

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(60, 48),
  new THREE.MeshStandardMaterial({ color: 0x10131d, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

{
  const starGeo = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i < 700; i++) {
    const r = 60 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.45; // upper sky only
    pts.push(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  scene.add(
    new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xcdd8ff, size: 0.14, sizeAttenuation: true, fog: false })
    )
  );
}

// ---------------------------------------------------------------- materials

const tweed = new THREE.MeshStandardMaterial({ color: 0x6d5537, roughness: 0.9 });
const tweedDark = new THREE.MeshStandardMaterial({ color: 0x57422b, roughness: 0.9 });
const skin = new THREE.MeshStandardMaterial({ color: 0xe8c39a, roughness: 0.7 });
const oldSkin = new THREE.MeshStandardMaterial({ color: 0xe3b591, roughness: 0.75 });
const white = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.9 });
const dark = new THREE.MeshStandardMaterial({ color: 0x23252d, roughness: 0.6 });
const wood = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.85 });
const couchFabric = new THREE.MeshStandardMaterial({ color: 0x7a3b46, roughness: 1 });
const pajama = new THREE.MeshStandardMaterial({ color: 0x7f9fd1, roughness: 0.95 });
const metal = new THREE.MeshStandardMaterial({ color: 0x8f98a8, roughness: 0.35, metalness: 0.8 });

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function sphere(r, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 20), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------- pipeline

// The pipeline dips at the inspection point so the Inspector can reach it.
const curve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-13.0, 7.4, -4.5),
  new THREE.Vector3(-9.0, 5.2, -2.5),
  new THREE.Vector3(-4.5, 3.4, 0.8),
  new THREE.Vector3(-0.5, 2.55, 1.5),
  new THREE.Vector3(3.5, 3.3, 0.4),
  new THREE.Vector3(7.5, 4.1, -1.8),
  new THREE.Vector3(10.4, 4.8, -3.4),
]);

const SCAN_T = 0.47;
const scanPoint = curve.getPointAt(SCAN_T);

{
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x11405a,
    emissive: 0x37d7ff,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.85,
  });
  for (let i = 0; i <= 22; i++) {
    const t = 0.02 + (i / 22) * 0.94;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.035, 10, 32), ringMat);
    const p = curve.getPointAt(t);
    ring.position.copy(p);
    ring.lookAt(p.clone().add(curve.getTangentAt(t)));
    scene.add(ring);
  }
}

// ---------------------------------------------------------------- broadcast tower

{
  const tower = new THREE.Group();
  const mast = cyl(0.16, 0.5, 7, metal, 0, 3.5, 0);
  tower.add(mast);
  for (let i = 0; i < 3; i++) {
    const strut = cyl(0.04, 0.04, 3.6, metal, 0, 1.4 + i * 1.8, 0);
    strut.rotation.z = Math.PI / 4;
    strut.rotation.y = i * 1.1;
    tower.add(strut);
  }
  const dish = sphere(0.42, metal, 0, 7.1, 0);
  dish.scale.set(1, 0.55, 1);
  tower.add(dish);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff5d5d })
  );
  beacon.position.set(0, 7.55, 0);
  tower.add(beacon);
  tower.userData.beacon = beacon;
  tower.position.set(-13, 0, -4.5);
  scene.add(tower);

  // pulsing emission rings around the tip
  const pulseMat = new THREE.MeshBasicMaterial({
    color: 0x37d7ff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
  });
  const pulses = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.03, 8, 32), pulseMat.clone());
    p.position.set(-13, 7.4, -4.5);
    p.rotation.y = Math.PI / 3;
    scene.add(p);
    pulses.push(p);
  }
  scene.userData.pulses = pulses;
}

// ---------------------------------------------------------------- video frames

const FRAME_W = 1.5;
const FRAME_H = 1.0;

function makeFrameCanvas(n) {
  const c = document.createElement("canvas");
  c.width = 192;
  c.height = 128;
  const g = c.getContext("2d");
  // pseudo-random but deterministic scene per frame number
  const hue = (n * 47) % 360;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, `hsl(${hue}, 60%, 55%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 65%, 30%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 192, 128);
  // "content": sun + hills
  g.fillStyle = "rgba(255,255,220,0.9)";
  g.beginPath();
  g.arc(40 + (n % 5) * 22, 38, 14, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `hsl(${(hue + 120) % 360}, 40%, 25%)`;
  g.beginPath();
  g.moveTo(0, 128);
  g.lineTo(0, 95);
  for (let x = 0; x <= 192; x += 16) {
    g.lineTo(x, 95 + 18 * Math.sin(x / 24 + n));
  }
  g.lineTo(192, 128);
  g.fill();
  // color bars strip
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  bars.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(i * (192 / 7), 112, 192 / 7 + 1, 16);
  });
  // frame number
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(120, 6, 66, 22);
  g.fillStyle = "#fff";
  g.font = "bold 14px monospace";
  g.fillText("#" + String(n).padStart(4, "0"), 126, 22);
  return c;
}

const okBorder = new THREE.MeshBasicMaterial({ color: 0x37d7ff });
const goodBorder = new THREE.MeshBasicMaterial({ color: 0x37e08b });
const badBorder = new THREE.MeshBasicMaterial({ color: 0xff5d5d });

function makeFlyingFrame() {
  const group = new THREE.Group();
  const border = new THREE.Mesh(new THREE.BoxGeometry(FRAME_W + 0.1, FRAME_H + 0.1, 0.04), okBorder.clone());
  const tex = new THREE.CanvasTexture(makeFrameCanvas(0));
  tex.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(FRAME_W, FRAME_H),
    new THREE.MeshBasicMaterial({ map: tex })
  );
  face.position.z = 0.025;
  const back = face.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.025;
  group.add(border, face, back);
  return { group, border, tex };
}

let frameCounter = 100;
const frames = [];
const N_FRAMES = 9;
const TRAVEL_SECS = 11;

function spawn(f, t0) {
  frameCounter++;
  f.no = frameCounter;
  f.bad = frameCounter % 7 === 4;
  f.t = t0;
  f.state = "flying"; // flying | falling
  f.scanned = false;
  f.canvas = makeFrameCanvas(f.no);
  f.tex.image = f.canvas;
  f.tex.needsUpdate = true;
  f.border.material.color.set(0x37d7ff);
  f.group.visible = true;
  f.group.scale.setScalar(1);
  f.group.rotation.set(0, 0, 0);
}

for (let i = 0; i < N_FRAMES; i++) {
  const f = makeFlyingFrame();
  scene.add(f.group);
  frames.push(f);
  spawn(f, i / N_FRAMES);
}

// ------------------------------------------- the Inspector (a scientist)

function buildInspector() {
  const g = new THREE.Group();
  const coat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.85 });
  const trousers = new THREE.MeshStandardMaterial({ color: 0x3d4a5c, roughness: 0.9 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9 });

  // lab coat, trousers, shoes
  g.add(cyl(0.28, 0.42, 1.15, coat, 0, 1.1, 0));
  g.add(cyl(0.17, 0.29, 0.16, coat, 0, 1.72, 0)); // collar
  g.add(cyl(0.09, 0.11, 0.55, trousers, -0.14, 0.28, 0));
  g.add(cyl(0.09, 0.11, 0.55, trousers, 0.14, 0.28, 0));
  g.add(box(0.14, 0.08, 0.3, dark, -0.14, 0.05, 0.05));
  g.add(box(0.14, 0.08, 0.3, dark, 0.14, 0.05, 0.05));
  // ID badge on the coat
  g.add(box(0.11, 0.14, 0.02, new THREE.MeshStandardMaterial({ color: 0x2a78d6 }), 0.13, 1.4, 0.27));

  // head group (tracks the frames flowing by)
  const head = new THREE.Group();
  head.position.set(0, 2.0, 0);
  head.add(sphere(0.28, skin));
  // hair: cap swept back into a bun
  const cap = sphere(0.3, hairMat, 0, 0.04, -0.06);
  cap.scale.set(1, 0.95, 0.95);
  head.add(cap);
  const bun = sphere(0.14, hairMat, 0, 0.16, -0.3);
  head.add(bun);
  // glasses
  const rimL = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.014, 8, 24), metal);
  rimL.position.set(-0.11, 0.02, 0.26);
  const rimR = rimL.clone();
  rimR.position.x = 0.11;
  head.add(rimL, rimR);
  head.add(box(0.06, 0.016, 0.016, metal, 0, 0.02, 0.28)); // bridge
  const nose = cyl(0.02, 0.05, 0.14, skin, 0, -0.06, 0.28);
  nose.rotation.x = Math.PI / 2;
  head.add(nose);
  g.add(head);

  // left arm cradling the clipboard against her
  const armL = cyl(0.065, 0.065, 0.55, coat, -0.32, 1.42, 0.18);
  armL.rotation.x = 1.05;
  armL.rotation.z = 0.5;
  g.add(armL);
  g.add(sphere(0.07, skin, -0.14, 1.3, 0.42)); // left hand
  const clipboard = new THREE.Group();
  const board = box(0.42, 0.56, 0.025, wood, 0, 0, 0);
  clipboard.add(board);
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.48),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
  );
  paper.position.z = 0.02;
  clipboard.add(paper);
  clipboard.add(box(0.16, 0.05, 0.05, metal, 0, 0.28, 0.01)); // clip
  clipboard.position.set(-0.02, 1.32, 0.42);
  clipboard.rotation.x = -0.55; // tilted up toward her eyes
  clipboard.rotation.y = 0.15;
  g.add(clipboard);

  // right hand holding a pen over the clipboard
  const armR = cyl(0.065, 0.065, 0.5, coat, 0.32, 1.42, 0.16);
  armR.rotation.x = 0.95;
  armR.rotation.z = -0.55;
  g.add(armR);
  g.add(sphere(0.07, skin, 0.16, 1.28, 0.4)); // right hand
  const pen = cyl(0.015, 0.015, 0.22, dark, 0.13, 1.34, 0.44);
  pen.rotation.x = 0.9;
  pen.rotation.z = -0.5;
  g.add(pen);

  g.traverse((m) => (m.castShadow = true));
  return { group: g, head };
}

const inspector = buildInspector();
inspector.group.scale.setScalar(1.45);
inspector.group.position.set(scanPoint.x - 0.2, 0, scanPoint.z + 1.7);
// body faces the incoming stream (upstream), so the camera sees her in
// side profile with the clipboard held out in front of her
inspector.group.lookAt(scanPoint.x - 4.5, 0, scanPoint.z + 1.7);
scene.add(inspector.group);

// a Victorian street lamp keeps the Inspector out of the shadows
{
  const post = new THREE.Group();
  post.add(cyl(0.07, 0.14, 4.2, dark, 0, 2.1, 0));
  post.add(cyl(0.02, 0.02, 0.7, dark, 0.3, 4.2, 0)).children;
  const arm = post.children[post.children.length - 1];
  arm.rotation.z = Math.PI / 2;
  const lampHead = cyl(0.14, 0.3, 0.42, new THREE.MeshStandardMaterial({
    color: 0xffe3b0,
    emissive: 0xffc98a,
    emissiveIntensity: 2.4,
  }), 0.62, 4.05, 0);
  post.add(lampHead);
  post.add(cyl(0.02, 0.16, 0.14, dark, 0.62, 4.32, 0));
  const glow = new THREE.PointLight(0xffc98a, 70, 15);
  glow.position.set(0.62, 3.8, 0);
  post.add(glow);
  post.position.set(scanPoint.x - 2.6, 0, scanPoint.z + 2.6);
  scene.add(post);
}

// scan beam flashing at the inspection point as frames pass
const beam = new THREE.Mesh(
  new THREE.ConeGeometry(0.75, 2.1, 24, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0x37d7ff,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
beam.position.copy(scanPoint).add(new THREE.Vector3(0.1, -0.45, 0.95));
beam.lookAt(scanPoint);
beam.rotateX(-Math.PI / 2);
scene.add(beam);
let beamFlash = 0;
let beamColor = 0x37d7ff;

// ---------------------------------------------------------------- verdict sprites

function makeVerdictSprite(text, color) {
  const c = document.createElement("canvas");
  c.width = 360;
  c.height = 80;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(10,14,24,0.85)";
  g.beginPath();
  g.roundRect(2, 2, 356, 76, 18);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.stroke();
  g.fillStyle = color;
  g.font = "bold 36px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 180, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  sprite.scale.set(2.9, 0.64, 1);
  return sprite;
}

const verdicts = [];
function showVerdict(text, color, pos) {
  const s = makeVerdictSprite(text, color);
  s.position.copy(pos).add(new THREE.Vector3(0, 1.15, 0.4));
  scene.add(s);
  verdicts.push({ sprite: s, life: 1.7 });
}

// ---------------------------------------------------------------- browser panel

const browserCanvas = document.createElement("canvas");
browserCanvas.width = 512;
browserCanvas.height = 400;
const browserTex = new THREE.CanvasTexture(browserCanvas);
browserTex.colorSpace = THREE.SRGBColorSpace;

function drawBrowser(frameCanvas, frameNo, ttfb, mbps) {
  const g = browserCanvas.getContext("2d");
  g.fillStyle = "#1c2230";
  g.fillRect(0, 0, 512, 400);
  // tab strip + traffic lights
  g.fillStyle = "#141926";
  g.fillRect(0, 0, 512, 46);
  [["#ff5f57", 24], ["#febc2e", 48], ["#28c840", 72]].forEach(([col, x]) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, 23, 7, 0, Math.PI * 2);
    g.fill();
  });
  // address bar
  g.fillStyle = "#232b3d";
  g.beginPath();
  g.roundRect(96, 10, 396, 26, 13);
  g.fill();
  g.fillStyle = "#8fa0c5";
  g.font = "15px monospace";
  g.fillText("https://livestream.example/master_720p.m3u8", 110, 28);
  // viewport
  if (frameCanvas) {
    g.drawImage(frameCanvas, 8, 54, 496, 300);
  } else {
    g.fillStyle = "#0d1119";
    g.fillRect(8, 54, 496, 300);
    g.fillStyle = "#8fa0c5";
    g.font = "20px system-ui";
    g.fillText("waiting for stream…", 170, 210);
  }
  // LIVE badge
  g.fillStyle = "rgba(208,59,59,0.92)";
  g.beginPath();
  g.roundRect(20, 66, 74, 28, 6);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 17px system-ui";
  g.fillText("● LIVE", 30, 86);
  // stats bar (the extension!)
  g.fillStyle = "#10241a";
  g.fillRect(8, 358, 496, 34);
  g.fillStyle = "#37e08b";
  g.font = "bold 16px monospace";
  const line = frameCanvas
    ? `HLS Monitor ✓200 #${frameNo} TTFB ${ttfb}ms ${mbps}Mbps`
    : "HLS Monitor  waiting for segments…";
  g.fillText(line, 20, 381);
  browserTex.needsUpdate = true;
}
drawBrowser(null);

const browserGroup = new THREE.Group();
{
  const panel = box(5.4, 4.3, 0.18, new THREE.MeshStandardMaterial({ color: 0x2a3348, roughness: 0.6 }));
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(5.12, 4.0),
    new THREE.MeshBasicMaterial({ map: browserTex })
  );
  screen.position.z = 0.1;
  browserGroup.add(panel, screen);
  const screenGlow = new THREE.PointLight(0x6fb7ff, 14, 10);
  screenGlow.position.set(0, 0, 1.5);
  browserGroup.add(screenGlow);
  browserGroup.position.set(10.4, 4.8, -3.5);
  browserGroup.rotation.y = -0.42;
  scene.add(browserGroup);
}

// ---------------------------------------------------------------- living room

const tvCanvas = document.createElement("canvas");
tvCanvas.width = 256;
tvCanvas.height = 192;
const tvTex = new THREE.CanvasTexture(tvCanvas);
tvTex.colorSpace = THREE.SRGBColorSpace;
let tvFrameCanvas = null;

function drawTV(time) {
  const g = tvCanvas.getContext("2d");
  if (tvFrameCanvas) {
    g.drawImage(tvFrameCanvas, 0, 0, 256, 192);
  } else {
    // static noise until the first frame arrives
    const img = g.createImageData(256, 192);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  // CRT scanlines + vignette
  g.fillStyle = "rgba(0,0,0,0.22)";
  for (let y = (time * 30) % 4; y < 192; y += 4) g.fillRect(0, y, 256, 1.4);
  g.fillStyle = "rgba(255,255,255,0.06)";
  g.fillRect(0, (time * 90) % 192, 256, 8);
  g.fillStyle = "#fff";
  g.font = "bold 13px monospace";
  g.fillText("CH 3", 214, 20);
  tvTex.needsUpdate = true;
}

const livingRoom = new THREE.Group();
{
  // rug
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(4.4, 40),
    new THREE.MeshStandardMaterial({ color: 0x28304a, roughness: 1 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.02;
  rug.scale.set(1.25, 0.8, 1);
  livingRoom.add(rug);

  // ---- retro TV
  const tv = new THREE.Group();
  tv.add(box(2.0, 1.55, 1.1, wood, 0, 1.13, 0));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.12), new THREE.MeshBasicMaterial({ map: tvTex }));
  screen.position.set(-0.18, 1.18, 0.56);
  tv.add(screen);
  const screenFrame = box(1.7, 1.3, 0.04, dark, -0.18, 1.18, 0.54);
  tv.add(screenFrame);
  screen.position.z = 0.58;
  for (const y of [1.45, 1.15]) {
    const knob = cyl(0.07, 0.07, 0.1, metal, 0.75, y, 0.56);
    knob.rotation.x = Math.PI / 2;
    tv.add(knob);
  }
  // legs
  [[-0.8, 0.45], [0.8, 0.45], [-0.8, -0.45], [0.8, -0.45]].forEach(([x, z]) => {
    const leg = cyl(0.05, 0.03, 0.72, wood, x, 0.34, z);
    leg.rotation.z = x > 0 ? -0.12 : 0.12;
    tv.add(leg);
  });
  // rabbit ears
  const earL = cyl(0.016, 0.016, 1.5, metal, -0.3, 2.55, 0);
  earL.rotation.z = 0.5;
  const earR = cyl(0.016, 0.016, 1.5, metal, 0.3, 2.55, 0);
  earR.rotation.z = -0.5;
  tv.add(earL, earR, sphere(0.05, metal, -0.64, 3.2, 0), sphere(0.05, metal, 0.64, 3.2, 0));
  const tvGlow = new THREE.PointLight(0x9fc4ff, 10, 6);
  tvGlow.position.set(-0.2, 1.3, 1.4);
  tv.add(tvGlow);
  tv.position.set(9.9, 0, 7.0);
  tv.rotation.y = -Math.PI / 4; // screen faces the couch and the camera
  livingRoom.add(tv);

  // ---- couch
  const couch = new THREE.Group();
  couch.add(box(3.1, 0.62, 1.5, couchFabric, 0, 0.45, 0)); // base
  couch.add(box(3.1, 1.0, 0.42, couchFabric, 0, 1.1, -0.62)); // backrest
  couch.add(box(0.42, 0.62, 1.5, couchFabric, -1.62, 0.86, 0)); // arms
  couch.add(box(0.42, 0.62, 1.5, couchFabric, 1.62, 0.86, 0));
  // cushions
  couch.add(box(1.4, 0.22, 1.25, new THREE.MeshStandardMaterial({ color: 0x8d4a56, roughness: 1 }), -0.72, 0.85, 0.05));
  couch.add(box(1.4, 0.22, 1.25, new THREE.MeshStandardMaterial({ color: 0x8d4a56, roughness: 1 }), 0.72, 0.85, 0.05));
  [[-1.4, 0.6], [1.4, 0.6], [-1.4, -0.6], [1.4, -0.6]].forEach(([x, z]) =>
    couch.add(cyl(0.06, 0.06, 0.3, wood, x, 0.15, z))
  );
  couch.position.set(4.6, 0, 7.9);
  couch.rotation.y = Math.PI * 0.32;
  livingRoom.add(couch);

  // ---- the old man (seated, facing the TV)
  const man = new THREE.Group();
  const torso = box(0.62, 0.78, 0.42, pajama, 0, 1.32, -0.12);
  torso.rotation.x = -0.18; // reclined
  man.add(torso);
  // head
  const head = new THREE.Group();
  head.position.set(0, 1.9, -0.16);
  head.add(sphere(0.24, oldSkin));
  const beard = sphere(0.22, white, 0, -0.1, 0.08);
  beard.scale.set(0.95, 0.75, 0.85);
  head.add(beard);
  const hairL = sphere(0.1, white, -0.22, 0.05, -0.02);
  const hairR = sphere(0.1, white, 0.22, 0.05, -0.02);
  hairL.scale.set(0.5, 0.9, 0.9);
  hairR.scale.set(0.5, 0.9, 0.9);
  head.add(hairL, hairR);
  head.add(cyl(0.015, 0.045, 0.12, oldSkin, 0, 0.0, 0.25)).children;
  const noseM = head.children[head.children.length - 1];
  noseM.rotation.x = Math.PI / 2;
  // glasses
  const rimL = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 20), metal);
  rimL.position.set(-0.1, 0.06, 0.22);
  const rimR = rimL.clone();
  rimR.position.x = 0.1;
  const bridge = box(0.06, 0.015, 0.015, metal, 0, 0.06, 0.23);
  head.add(rimL, rimR, bridge);
  man.add(head);
  man.userData.head = head;
  // legs: thighs forward, calves down
  [[-0.17], [0.17]].forEach(([x]) => {
    const thigh = box(0.2, 0.2, 0.6, pajama, x, 0.95, 0.28);
    man.add(thigh);
    man.add(box(0.18, 0.5, 0.18, pajama, x, 0.62, 0.55));
    man.add(box(0.2, 0.12, 0.34, new THREE.MeshStandardMaterial({ color: 0x9b3535, roughness: 1 }), x, 0.4, 0.66)); // slippers
  });
  // arms: left on armrest, right holding remote
  const armL2 = box(0.16, 0.5, 0.16, pajama, -0.42, 1.28, 0.05);
  armL2.rotation.x = 0.7;
  man.add(armL2);
  const armR2 = box(0.16, 0.5, 0.16, pajama, 0.38, 1.2, 0.18);
  armR2.rotation.x = 1.1;
  man.add(armR2);
  man.add(box(0.09, 0.05, 0.26, dark, 0.4, 1.06, 0.44)); // remote
  man.position.set(-0.72, 0.55, 0.05);
  man.scale.setScalar(0.92);
  couch.add(man);
  couch.userData.man = man;

  // floor lamp behind the couch
  const lamp = new THREE.Group();
  lamp.add(cyl(0.04, 0.2, 3.0, metal, 0, 1.5, 0));
  const shade = cyl(0.3, 0.48, 0.55, new THREE.MeshStandardMaterial({
    color: 0xffd9a8,
    emissive: 0xffb36b,
    emissiveIntensity: 0.7,
  }), 0, 3.1, 0);
  lamp.add(shade);
  lamp.position.set(2.4, 0, 9.6);
  livingRoom.add(lamp);

  // mug on the armrest
  const mug = new THREE.Group();
  mug.add(cyl(0.09, 0.08, 0.18, new THREE.MeshStandardMaterial({ color: 0x3d7ea6 })));
  const mugHandle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.015, 8, 16), new THREE.MeshStandardMaterial({ color: 0x3d7ea6 }));
  mugHandle.position.x = 0.1;
  mug.add(mugHandle);
  mug.position.set(-1.62, 1.28, 0.1);
  couch.add(mug);

  livingRoom.position.set(0.6, 0, 0.4);
  scene.add(livingRoom);
  livingRoom.userData = { couch };
}

// sparkle stream: browser -> TV (the livestream reaching the living room)
const sparkCurve = new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(10.4, 3.4, -3.2),
  new THREE.Vector3(12.2, 4.6, 2.2),
  new THREE.Vector3(10.2, 1.9, 7.1)
);
const sparks = [];
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x6fd9ff, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), mat);
    scene.add(s);
    sparks.push({ mesh: s, off: i / 14 });
  }
}

// ---------------------------------------------------------------- HUD

const hud = {
  inspected: 0,
  landed: 0,
  flagged: 0,
  ttfb: 6,
  mbps: 4.2,
};
const $ = (id) => document.getElementById(id);
function updateHUD() {
  $("s-inspected").textContent = hud.inspected;
  $("s-landed").textContent = hud.landed;
  $("s-flagged").textContent = hud.flagged;
  $("s-ttfb").textContent = hud.ttfb.toFixed(0) + " ms";
  $("s-bps").textContent = hud.mbps.toFixed(1) + " Mbps";
}
setInterval(() => {
  hud.ttfb = Math.min(12, Math.max(3, hud.ttfb + (Math.random() - 0.5) * 1.6));
  hud.mbps = Math.min(6.5, Math.max(2.5, hud.mbps + (Math.random() - 0.5) * 0.5));
  updateHUD();
}, 400);

// ---------------------------------------------------------------- interaction

const mouse = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
});

// ---------------------------------------------------------------- animation

const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // frames along the pipeline
  let nearestToScan = null;
  let nearestDist = Infinity;
  for (const f of frames) {
    if (f.state === "flying") {
      const prevT = f.t;
      f.t += dt / TRAVEL_SECS;
      if (prevT < SCAN_T && f.t >= SCAN_T && !f.scanned) {
        f.scanned = true;
        hud.inspected++;
        beamFlash = 1;
        if (f.bad) {
          hud.flagged++;
          beamColor = 0xff5d5d;
          f.border.material.color.set(0xff5d5d);
          showVerdict("✗ 404 dropped", "#ff5d5d", scanPoint);
          f.state = "falling";
          f.vel = new THREE.Vector3(0.6, 1.6, 1.2);
          f.spin = new THREE.Vector3(2.2, 1.4, 3.0);
        } else {
          beamColor = 0x37e08b;
          f.border.material.color.set(0x37e08b);
          showVerdict("✓ 200 OK · " + hud.ttfb.toFixed(0) + "ms", "#37e08b", scanPoint);
        }
      }
      if (f.state === "flying") {
        if (f.t >= 1) {
          // land in the browser
          hud.landed++;
          tvFrameCanvas = f.canvas;
          drawBrowser(f.canvas, f.no, hud.ttfb.toFixed(0), hud.mbps.toFixed(1));
          spawn(f, 0);
        } else {
          curve.getPointAt(f.t, tmpV);
          f.group.position.copy(tmpV);
          f.group.lookAt(camera.position);
          const s = f.t > 0.92 ? 1 - (f.t - 0.92) * 9 : 1; // shrink into the browser
          f.group.scale.setScalar(Math.max(0.28, s));
          const d = Math.abs(f.t - SCAN_T);
          if (d < nearestDist) {
            nearestDist = d;
            nearestToScan = f;
          }
        }
      }
    } else if (f.state === "falling") {
      f.vel.y -= 5.5 * dt;
      f.group.position.addScaledVector(f.vel, dt);
      f.group.rotation.x += f.spin.x * dt;
      f.group.rotation.y += f.spin.y * dt;
      f.group.rotation.z += f.spin.z * dt;
      if (f.group.position.y < 0.15) spawn(f, 0);
    }
  }

  // Inspector: bob gently, head tracks the frame nearest the scan zone
  // (lookAt points the head's +z - her face - at the frame)
  inspector.group.position.y = Math.sin(time * 1.4) * 0.04;
  if (nearestToScan && nearestDist < 0.12) {
    inspector.head.lookAt(nearestToScan.group.position);
  }

  // scan beam flash
  if (beamFlash > 0) {
    beamFlash = Math.max(0, beamFlash - dt * 2.2);
    beam.material.opacity = beamFlash * 0.4;
    beam.material.color.set(beamColor);
  }

  // verdict sprites drift up and fade
  for (let i = verdicts.length - 1; i >= 0; i--) {
    const v = verdicts[i];
    v.life -= dt;
    v.sprite.position.y += dt * 0.7;
    v.sprite.material.opacity = Math.min(1, v.life * 1.4);
    if (v.life <= 0) {
      scene.remove(v.sprite);
      v.sprite.material.map.dispose();
      v.sprite.material.dispose();
      verdicts.splice(i, 1);
    }
  }

  // tower pulses
  for (let i = 0; i < scene.userData.pulses.length; i++) {
    const p = scene.userData.pulses[i];
    const ph = (time * 0.45 + i / 3) % 1;
    p.scale.setScalar(0.4 + ph * 3.2);
    p.material.opacity = 0.55 * (1 - ph);
  }

  // sparkle stream to the TV
  for (const s of sparks) {
    const t = (time * 0.16 + s.off) % 1;
    sparkCurve.getPoint(t, tmpV);
    s.mesh.position.copy(tmpV);
    s.mesh.material.opacity = 0.9 * Math.sin(t * Math.PI);
  }

  // TV refresh + old man breathing / nodding
  drawTV(time);
  const man = livingRoom.userData.couch.userData.man;
  man.scale.y = 0.92 + Math.sin(time * 1.1) * 0.008;
  man.userData.head.rotation.x = Math.sin(time * 0.5) * 0.06;

  // browser panel floats
  browserGroup.position.y = 4.8 + Math.sin(time * 0.9) * 0.08;

  // camera parallax + aspect-based dolly
  camera.position.x = camBase.x + mouse.x * 1.6 + Math.sin(time * 0.12) * 0.4;
  camera.position.y = camBase.y - mouse.y * 0.9;
  camera.position.z = camBase.z * camDolly;
  camera.lookAt(camTarget);

  renderer.render(scene, camera);
}
animate();
updateHUD();
