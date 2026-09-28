
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
    import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

    // ===================== 基础场景 =====================
    const canvas = document.getElementById('app');
    const viewport = document.getElementById('viewport');
    // preserveDrawingBuffer: true 才能 toDataURL 截图
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const BG_COLOR = 0x4a4e57; // 深中性灰背景
    scene.background = new THREE.Color(BG_COLOR);

    const camera = new THREE.PerspectiveCamera(45, viewport.clientWidth / viewport.clientHeight, 0.01, 1000);
    camera.position.set(0, 0.6, 3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.75;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.75;
    controls.minDistance = 0.35;
    controls.maxDistance = 12;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(5, 8, 6);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir2.position.set(-5, 2, -4);
    scene.add(dir2);

    const grid = new THREE.GridHelper(10, 20, 0x5a5e67, 0x565a63);
    grid.position.y = -1.0;
    scene.add(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ color: 0x252832, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.002;
    scene.add(ground);

    // ===================== 烘焙材质 (Shader) =====================
    // 这套材质有两种渲染模式：
    //  - 正常显示模式(uBakeMode=0)：正常渲染到屏幕，显示已烘焙的 accumulated 纹理
    //  - 烘焙模式(uBakeMode=1)：顶点输出位置改成 UV 坐标(摊平)，片元按存的相机矩阵投影采样 PNG，写入离屏纹理
    const uniforms = {
      uBakeMode:        { value: 0 },        // 0=显示, 1=烘焙
      uAccumMap:        { value: null },     // 已累积的烘焙纹理(显示用)
      uHasAccum:        { value: 0 },
      uProjMap:         { value: null },     // 后端返回的 PNG (烘焙用)
      uProjViewMatrix:  { value: new THREE.Matrix4() },
      uProjProjMatrix:  { value: new THREE.Matrix4() },
      uProjCamPos:      { value: new THREE.Vector3() },
      uPrevAccum:       { value: null },     // 烘焙时读取的上一次累积(用于叠加)
      uHasPrev:         { value: 0 },
      uFalloff:         { value: 0.05 },
      uFeather:         { value: 0.25 },
      uBaseColor:       { value: new THREE.Color(0xd2d2d2) }, // Modddif 风格：浅灰白
      uBrightness:      { value: 1.35 },                       // 贴图整体提亮系数
      // 深度遮挡测试：从投影相机视角渲染的“到相机距离”深度图，
      // 烘焙时比较，剔除被前方表面遮挡的点(解决投影穿透)。
      uDepthMap:        { value: null },
      uUseDepth:        { value: 0 },
      uDepthBias:       { value: 0.02 },  // 深度偏差，防自遮挡(z-fighting)
      uAccumTexel:      { value: new THREE.Vector2(1/1024, 1/1024) }, // 显示就近采样用
      uPreviewMode:     { value: 0 }, // 0=正常展示，1=贴图原色预览
    };

    const vertexShader = /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      uniform int uBakeMode;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        if (uBakeMode == 1) {
          // 烘焙：把顶点摆到它的 UV 坐标 [0,1] -> 裁剪空间 [-1,1]
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        } else {
          // 正常显示
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      }
    `;

    const fragmentShader = /* glsl */`
      precision highp float;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec2 vUv;

      uniform int uBakeMode;
      uniform sampler2D uAccumMap;
      uniform int uHasAccum;
      uniform sampler2D uProjMap;
      uniform mat4 uProjViewMatrix;
      uniform mat4 uProjProjMatrix;
      uniform vec3 uProjCamPos;
      uniform sampler2D uPrevAccum;
      uniform int uHasPrev;
      uniform float uFalloff;
      uniform float uFeather;
      uniform vec3 uBaseColor;
      uniform float uBrightness;
      uniform sampler2D uDepthMap;
      uniform int uUseDepth;
      uniform float uDepthBias;
      uniform vec2 uAccumTexel;
      uniform int uPreviewMode;

      void main() {
        if (uBakeMode == 1) {
          // ====== 烘焙模式(单图层)：只写本次投影结果，不依赖上次累积 ======
          // 每次烘焙产出一张独立图层(RGB=贴图色, A=朝向权重/覆盖)，
          // 多图层的叠加合成在 JS 端做(上层覆盖下层)。
          vec4 clip = uProjProjMatrix * uProjViewMatrix * vec4(vWorldPos, 1.0);
          vec3 ndc = clip.xyz / clip.w;
          vec2 imgUV = ndc.xy * 0.5 + 0.5;

          bool inFront = clip.w > 0.0;
          bool inFrustum = imgUV.x >= 0.0 && imgUV.x <= 1.0 && imgUV.y >= 0.0 && imgUV.y <= 1.0 && ndc.z <= 1.0;

          vec3 toCam = normalize(uProjCamPos - vWorldPos);
          float facing = dot(normalize(vWorldNormal), toCam);

          // 深度遮挡测试：剔除被前方表面遮挡的点(解决穿透)。
          bool occluded = false;
          if (uUseDepth == 1 && inFrustum) {
            float nearestDist = texture2D(uDepthMap, imgUV).r;
            float myDist = distance(vWorldPos, uProjCamPos);
            if (nearestDist > 0.0001 && myDist > nearestDist + uDepthBias) occluded = true;
          }

          if (inFront && inFrustum && facing > uFalloff && !occluded) {
            vec4 texel = texture2D(uProjMap, imgUV);
            if (texel.a <= 0.02) {
              gl_FragColor = vec4(0.0);
              return;
            }
            float w = smoothstep(uFalloff, uFalloff + uFeather, facing) * texel.a;
            gl_FragColor = vec4(texel.rgb, max(w, 0.001));
          } else {
            gl_FragColor = vec4(0.0); // 本视角看不到 -> 该图层此处透明
          }
        } else {
          // ====== 显示模式：平滑着色 + 增强明暗对比(不碎面) ======
          vec3 N = normalize(vWorldNormal);

          // 1) 半球环境打底：整体调暗
          float hemi = N.y * 0.5 + 0.5;
          float envTerm = mix(0.32, 0.62, hemi);    // 下限/上限均下调，整体更暗

          // 2) 主光(key)：一个明确方向的漫反射，贡献主要的亮暗对比、突出肌肉结构
          vec3 keyDir = normalize(vec3(0.35, 0.65, 0.7));
          float key = max(dot(N, keyDir), 0.0);
          key = pow(key, 1.3);                       // 收紧高光过渡，对比更硬朗

          // 3) 辅光(fill)：反方向弱补光，避免暗部死黑但不削弱对比
          vec3 fillDir = normalize(vec3(-0.5, 0.2, -0.4));
          float fill = max(dot(N, fillDir), 0.0) * 0.14;

          // 4) AO：凹陷更暗，增强结构
          float ao = mix(0.7, 1.0, smoothstep(-0.6, 0.4, N.y));

          // 合成：环境打底 + 主光 + 弱辅光(主光权重下调)
          float shade = clamp(envTerm * ao + key * 0.5 + fill, 0.0, 1.0);
          vec3 lit = uBaseColor * shade;

          vec3 color = lit;
          if (uHasAccum == 1) {
            // uAccumMap 为多视角加权融合结果：rgb=Σ(色×权重)(预乘), a=Σ权重。
            // 方案 B：只采中心点，不再做邻域补色。
            //   - 黑线已由多视角融合从根上解决，邻域(5×5)借色只剩副作用：会跨过 UV 接缝
            //     把隔壁岛屿的有效色拉到背面，沿接缝形成线状碎片。
            //   - 背面纹素自身在烘焙阶段已被深度遮挡剔除(权重=0)，直接读中心点即是干净数据。
            //   - 额外收益：去掉邻域平均后画面更锐利。
            vec4 s = texture2D(uAccumMap, vUv);
            float wAcc = s.a;                                            // 本点累加权重
            vec3 normRGB = (wAcc > 0.0001) ? (s.rgb / wAcc) : vec3(0.0); // 归一化真实色
            float cov = clamp(wAcc, 0.0, 1.0);
            // 单条件显隐：仅按本点覆盖度。不再有邻域泄漏需要高阈值过滤，
            // 故下限可放宽，避免主体/接缝边缘的部分覆盖点收缩出黑边。
            float t = smoothstep(0.08, 0.30, cov);

            vec3 rawColor = pow(max(normRGB, vec3(0.0)), vec3(1.0 / 2.2));
            vec3 texColor = rawColor * uBrightness;
            color = (uPreviewMode == 1)
              ? ((wAcc > 0.0001) ? rawColor : lit)
              : mix(lit, texColor, t);
          }
          gl_FragColor = vec4(color, 1.0);
        }
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader,
      side: THREE.DoubleSide, // 烘焙摊平到 UV 时三角形绕序可能反向，双面避免被剔除
    });

    // ===================== 深度材质 (用于遮挡测试) =====================
    // 从投影相机视角渲染模型，每个片元输出“它到投影相机的距离(线性)”。
    // 烘焙时用它判断某点是否被前方表面遮挡。
    const depthUniforms = { uCamPos: { value: new THREE.Vector3() } };
    const depthMaterial = new THREE.ShaderMaterial({
      uniforms: depthUniforms,
      vertexShader: /* glsl */`
        varying vec3 vWPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vWPos;
        uniform vec3 uCamPos;
        void main() {
          float d = distance(vWPos, uCamPos); // 到投影相机的线性距离
          gl_FragColor = vec4(d, d, d, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });

    // 深度图 RT：用浮点纹理存距离，保证精度
    const DEPTH_SIZE = 2048;
    let depthRT = null;
    function ensureDepthRT() {
      if (depthRT) return depthRT;
      depthRT = new THREE.WebGLRenderTarget(DEPTH_SIZE, DEPTH_SIZE, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.FloatType,
        depthBuffer: true,
      });
      return depthRT;
    }

    // ===================== 离屏烘焙目标 (双缓冲) =====================
    const BAKE_SIZE = 2048; // 高分辨率：UV 岛屿间距相对更大，减少接缝渗色与跨岛屿碎片
    function makeRT() {
      return new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      });
    }
    let rtA = makeRT();
    let rtB = makeRT();
    let accumRT = null; // 合成后的总纹理(供显示)
    const bakeCamera = new THREE.Camera(); // 烘焙用占位相机(顶点已自行输出裁剪坐标)

    // ===================== 图层系统 =====================
    // 每次烘焙产出一个独立图层 { id, rt(独立纹理RT), thumb(缩略图dataURL), visible }。
    // 显示时把所有 visible 图层从下到上合成到 composedRT(上层覆盖下层)。
    const layers = [];        // 图层数组，索引小=底层，索引大=上层(后烘焙)
    let layerSeq = 0;
    // 合成 RT 用 FloatType：加权累加时权重和/预乘色会 >1，需浮点避免截断
    function makeFloatRT() {
      // 用 Nearest 过滤：float 纹理线性过滤需扩展支持，且显示 shader 自己做邻域平滑，无需硬件线性
      return new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.FloatType,
      });
    }
    let composedRT = makeFloatRT(); // 合成结果(预乘色, 累加权重)
    let composedTmp = makeFloatRT();// 合成用临时(双缓冲)

    // 合成材质：多视角【加权融合】。
    // 每个图层的 alpha = 该点的朝向权重 w(越正对相机越大)。
    // 合成做加权累加：RGB += 图层色 × 权重；A += 权重。
    // 最终显示时再用 RGB/A 归一化 -> 越正对的视角贡献越大，接缝处多视角平滑过渡。
    // 注意：用 FloatType 累加 RT 避免 A>1 被截断。
    const composeUniforms = {
      uBase:  { value: null }, // 下层已累加结果(预乘色, 累加权重)
      uLayer: { value: null }, // 当前图层(色, 朝向权重a)
      uHasBase: { value: 0 },
      uGamma:   { value: 1.6 }, // 权重锐化指数:越大越偏向最正对视角(减少多视角发灰)
    };
    const composeMaterial = new THREE.ShaderMaterial({
      uniforms: composeUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uBase;
        uniform sampler2D uLayer;
        uniform int uHasBase;
        uniform float uGamma;
        void main(){
          vec4 base = (uHasBase==1) ? texture2D(uBase, vUv) : vec4(0.0);
          vec4 lay  = texture2D(uLayer, vUv);
          // 权重锐化：w^gamma，让最正对的视角主导，避免多视角平均发灰
          float w = pow(clamp(lay.a, 0.0, 1.0), uGamma);
          // 加权累加(预乘)：rgb 累加 色×权重，a 累加 权重
          vec3 rgb = base.rgb + lay.rgb * w;
          float a  = base.a + w;
          gl_FragColor = vec4(rgb, a);
        }
      `,
    });

    // 重新合成所有可见图层 -> composedRT，并更新显示纹理
    function recomposeLayers() {
      const visibleLayers = layers.filter(l => l.visible);
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      if (visibleLayers.length === 0) {
        // 无可见图层：清空，回退灰模
        renderer.setRenderTarget(composedRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.setRenderTarget(null);
        renderer.autoClear = oldAutoClear;
        uniforms.uHasAccum.value = 0;
        uniforms.uAccumMap.value = null;
        return;
      }

      // 逐层合成：read(底) + 当前层 -> write，交替
      let writeRT = composedRT, readRT = composedTmp;
      let hasBase = false;
      for (let i = 0; i < visibleLayers.length; i++) {
        composeUniforms.uHasBase.value = hasBase ? 1 : 0;
        composeUniforms.uBase.value = hasBase ? readRT.texture : null;
        composeUniforms.uLayer.value = visibleLayers[i].rt.texture;
        fsQuad.material = composeMaterial;
        renderer.setRenderTarget(writeRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(fsScene, fsCam);
        renderer.setRenderTarget(null);
        // 交换
        const t = writeRT; writeRT = readRT; readRT = t;
        hasBase = true;
      }
      renderer.autoClear = oldAutoClear;

      // 最终结果在 readRT(最后写入的)
      uniforms.uAccumMap.value = readRT.texture;
      uniforms.uHasAccum.value = 1;
      uniforms.uAccumTexel.value.set(1 / BAKE_SIZE, 1 / BAKE_SIZE);
      accumRT = readRT;
    }

    // 渲染图层面板 UI
    function renderLayerPanel() {
      const listEl = document.getElementById('layersList');
      const emptyEl = document.getElementById('layersEmpty');
      const countEl = document.getElementById('layerCount');
      countEl.textContent = layers.length;
      listEl.innerHTML = '';
      if (layers.length === 0) { emptyEl.style.display = 'block'; return; }
      emptyEl.style.display = 'none';
      // 顶层显示在最上面(倒序)
      for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        const item = document.createElement('div');
        item.className = 'layer-item' + (L.visible ? '' : ' hidden-layer');
        item.innerHTML = `
          <img class="layer-thumb" src="${L.thumb || ''}" alt=""/>
          <span class="layer-name">${L.name}</span>
          <button class="layer-btn vis" title="显示/隐藏">${L.visible ? '👁' : '◌'}</button>
          <button class="layer-btn del" title="删除">🗑</button>
        `;
        // 显示/隐藏
        item.querySelector('.vis').addEventListener('click', () => {
          L.visible = !L.visible;
          recomposeLayers();
          renderLayerPanel();
        });
        // 删除
        item.querySelector('.del').addEventListener('click', () => {
          const idx = layers.indexOf(L);
          if (idx >= 0) {
            layers[idx].rt.dispose();
            layers.splice(idx, 1);
            recomposeLayers();
            renderLayerPanel();
          }
        });
        listEl.appendChild(item);
      }
    }

    // 面板折叠
    document.getElementById('layersHeader').addEventListener('click', () => {
      document.getElementById('layersPanel').classList.toggle('collapsed');
    });

    // ===================== UV 边缘扩张 (dilation) =====================
    // 烘焙后用全屏 shader 多次迭代：对空白像素(alpha≈0)，从邻域取已烘焙的
    // 有效像素填充，把 UV 岛屿颜色向外扩张，填满接缝缝隙，消除插值渗色黑线。
    let dilA = makeRT();
    let dilB = makeRT();
    const dilateUniforms = {
      uTex:        { value: null },
      uTexel:      { value: new THREE.Vector2(1/BAKE_SIZE, 1/BAKE_SIZE) },
    };
    const dilateMaterial = new THREE.ShaderMaterial({
      uniforms: dilateUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform vec2 uTexel;
        void main() {
          vec4 c = texture2D(uTex, vUv);
          if (c.a > 0.001) { gl_FragColor = c; return; } // 本身有效，保留
          // 空白像素：从 8 邻域找有效像素，取其平均色填充
          vec3 sum = vec3(0.0);
          float cnt = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              if (dx == 0 && dy == 0) continue;
              vec2 o = vec2(float(dx), float(dy)) * uTexel;
              vec4 n = texture2D(uTex, vUv + o);
              if (n.a > 0.001) { sum += n.rgb; cnt += 1.0; }
            }
          }
          if (cnt > 0.0) gl_FragColor = vec4(sum / cnt, 1.0); // 扩张出的像素标记为有效
          else gl_FragColor = c;                              // 邻域也空，保持
        }
      `,
    });
    // 全屏 quad 场景(用一个覆盖 NDC 的三角/四边形)
    const fsScene = new THREE.Scene();
    const fsGeo = new THREE.PlaneGeometry(2, 2);
    const fsQuad = new THREE.Mesh(fsGeo, dilateMaterial);
    fsScene.add(fsQuad);
    const fsCam = new THREE.Camera();

    // 对一张烘焙纹理执行 N 次 dilation，返回最终所在的 RT
    function dilateTexture(srcTex, iterations) {
      let read = srcTex;
      let writeRT = dilA, otherRT = dilB;
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      for (let i = 0; i < iterations; i++) {
        dilateUniforms.uTex.value = read;
        fsQuad.material = dilateMaterial;
        renderer.setRenderTarget(writeRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(fsScene, fsCam);
        renderer.setRenderTarget(null);
        read = writeRT.texture;
        // 交换
        const t = writeRT; writeRT = otherRT; otherRT = t;
      }
      renderer.autoClear = oldAutoClear;
      // 最终结果在 otherRT(上一次写入的)
      return otherRT;
    }

    // 纯拷贝：把一张纹理原样画到目标 RT(用于把 dilation 结果固化回图层 RT)
    const copyUniforms = { uTex: { value: null } };
    const copyMaterial = new THREE.ShaderMaterial({
      uniforms: copyUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        void main(){ gl_FragColor = texture2D(uTex, vUv); }
      `,
    });
    function copyTexToRT(srcTex, dstRT) {
      copyUniforms.uTex.value = srcTex;
      fsQuad.material = copyMaterial;
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(dstRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(fsScene, fsCam);
      renderer.setRenderTarget(null);
      renderer.autoClear = oldAutoClear;
    }

    // 把 Float 加权融合结果归一化成普通 RGBA 贴图，供预览/后续导出复用。
    // composedRT 中存的是 rgb=Σ(色×权重)、a=Σ权重，不能直接当普通图片读取。
    const normalizeUniforms = {
      uTex: { value: null },
      uBrightness: { value: 1.0 },
    };
    const normalizeMaterial = new THREE.ShaderMaterial({
      uniforms: normalizeUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D uTex;
        uniform float uBrightness;
        void main(){
          vec4 s = texture2D(uTex, vUv);
          if (s.a <= 0.0001) { gl_FragColor = vec4(0.0); return; }
          vec3 rgb = s.rgb / s.a;
          float alpha = smoothstep(0.08, 0.30, clamp(s.a, 0.0, 1.0));
          vec3 color = pow(max(rgb, vec3(0.0)), vec3(1.0 / 2.2)) * uBrightness;
          gl_FragColor = vec4(clamp(color, 0.0, 1.0), alpha);
        }
      `,
    });

    function renderNormalizedAccumToRT(srcRT) {
      const outRT = makeRT();
      normalizeUniforms.uTex.value = srcRT.texture;
      normalizeUniforms.uBrightness.value = uniforms.uBrightness.value;
      fsQuad.material = normalizeMaterial;
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(outRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(fsScene, fsCam);
      renderer.setRenderTarget(null);
      renderer.autoClear = oldAutoClear;
      return outRT;
    }

    // 接缝填充步数：黑线缝隙约 1px，取 2 步只补缝、不跨岛屿(避免线状碎片复发)
    const SEAM_DILATE_STEPS = 2;

    // ===================== 模型管理 =====================
    let currentModel = null;
    const meshes = [];

    function clearModel() {
      if (currentModel) { scene.remove(currentModel); }
      document.getElementById('resetBakeBtn').click();
      savedCam = null;
      pngImage = null;
      resultContext = null;
      document.getElementById('resultPanel').style.display = 'none';
      document.getElementById('thumb').style.display = 'none';
      document.getElementById('alignPanel').style.display = 'none';
      document.getElementById('pngInput').disabled = true;
      document.getElementById('downloadCamBtn').disabled = true;
      meshes.length = 0;
      currentModel = null;
      currentEditLayerId = null;
    }

    let modelHasUV = true;
    function applyBakeMaterial(root) {
      let total = 0, noUV = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          total++;
          if (!o.geometry.attributes.uv) {
            noUV++;
            console.warn('该网格没有 UV：', o.name);
          }
          // 每个 mesh 用材质的克隆，避免共享 uniforms 时互相干扰
          o.material = material;
          o.frustumCulled = false;
          meshes.push(o);
        }
      });
      modelHasUV = (total > 0 && noUV === 0);
      if (noUV > 0) {
        setStatus('modelStatus', `模型已加载，但 ${noUV}/${total} 个网格缺少 UV，无法映射！需要带 UV 的模型。`, true);
      }
      return { total, noUV };
    }

    function fitToView(root) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 1.6 / maxDim;
      root.scale.setScalar(scale);
      root.position.sub(center.multiplyScalar(scale));
      root.updateMatrixWorld(true);

      const fittedBox = new THREE.Box3().setFromObject(root);
      const bottomY = fittedBox.min.y;
      grid.position.y = bottomY - 0.015;
      ground.position.y = bottomY - 0.018;
      focusModel('front');
    }

    function onModelLoaded(root) {
      clearModel();
      currentModel = root;
      applyBakeMaterial(root);
      fitToView(root);
      scene.add(root);
      enableAfterModel();
      document.getElementById('viewportEmpty').style.display = 'none';
      if (modelHasUV) setStatus('modelStatus', '模型已加载 ✓ 请检查 UV 不重叠', false);
      else setStatus('modelStatus', '模型没有可烘焙的完整 UV，请先展开 UV', true);
      refreshGenerate();
    }

    // 文件加载
    document.getElementById('modelInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const ext = file.name.split('.').pop().toLowerCase();
      setStatus('modelStatus', '加载中...', false);
      if (ext === 'glb' || ext === 'gltf') {
        new GLTFLoader().load(url, (gltf) => { URL.revokeObjectURL(url); onModelLoaded(gltf.scene); },
          undefined, (err) => { URL.revokeObjectURL(url); setStatus('modelStatus', '加载失败: ' + err.message, true); });
      } else if (ext === 'obj') {
        new OBJLoader().load(url, (obj) => { URL.revokeObjectURL(url); onModelLoaded(obj); },
          undefined, (err) => { URL.revokeObjectURL(url); setStatus('modelStatus', '加载失败: ' + err.message, true); });
      } else {
        setStatus('modelStatus', '不支持的格式', true);
      }
    });

    // 计算像素数据中“非透明主体”的包围盒(归一化到 0~1)。
    // data: RGBA Uint8 数组(行优先, y 从上到下), 返回 {x,y,w,h,cx,cy} 归一化坐标。
    function computeAlphaBBox(data, w, h, alphaThreshold = 16) {
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = data[(y * w + x) * 4 + 3];
          if (a > alphaThreshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null; // 全透明
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      return {
        x: minX / w, y: minY / h,
        w: bw / w, h: bh / h,
        cx: (minX + bw / 2) / w, cy: (minY + bh / 2) / h,
      };
    }

    function computeAlphaStats(data, w, h, alphaThreshold = 16) {
      const total = w * h;
      let transparent = 0, semi = 0, opaque = 0, subject = 0;
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (a <= 2) transparent++;
        else if (a >= 250) opaque++;
        else semi++;
        if (a > alphaThreshold) subject++;
      }
      return {
        transparentRatio: transparent / total,
        semiRatio: semi / total,
        opaqueRatio: opaque / total,
        subjectRatio: subject / total,
      };
    }

    // ===================== 第2步：截图 + 保存相机 =====================
    let savedCam = null;
    let lastPngDataURL = null; // 最近上传的 PNG(作图层缩略图)

    // 截图留白比例：模型贴边后，四周各留的相对边距(0.04 ≈ 4%)。仿 Modddif 的小留白。
    const FRAME_PAD = 0.04;
    const CAPTURE_LONG = 1024; // 截图长边像素

    // 构建“按模型实际投影长宽比”的截图相机(仿 Modddif)。
    // 思路：保留当前视角方向，先用一个常规相机把模型包围盒 8 角投影到该视角，
    // 求出模型实际占据的矩形(含长宽比与中心偏移)，再用非对称透视投影精确框住它+小留白。
    // 返回 { cam, outW, outH }，outW/outH 为按比例确定的截图像素尺寸。
    function buildCaptureCamera() {
      const box = new THREE.Box3().setFromObject(currentModel);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere(center.clone()));
      const radius = sphere.radius || 1;

      // 1) 相机方向沿用当前视角，距离取“能完整容纳外接球”的安全距离
      const viewDir = new THREE.Vector3();
      camera.getWorldDirection(viewDir);
      const fov = camera.fov;
      const halfFov = THREE.MathUtils.degToRad(fov * 0.5);
      const dist = radius / Math.sin(halfFov) * 1.2; // 略远，确保不裁切
      const camPos = center.clone().addScaledVector(viewDir, -dist);

      // 2) 先建一个临时相机(用当前 up/方向)，求其 view 矩阵
      const tmp = new THREE.PerspectiveCamera(fov, 1, Math.max(dist - radius*2, 0.001), dist + radius*2);
      tmp.position.copy(camPos);
      tmp.up.copy(camera.up);
      tmp.lookAt(center);
      tmp.updateMatrixWorld();
      const viewM = tmp.matrixWorldInverse;

      // 3) 把包围盒 8 个角变换到“相机视图空间”，求 X/Y/Z 范围
      const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];
      let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,minZ=1e9,maxZ=-1e9;
      for (const c of corners) {
        const v = c.clone().applyMatrix4(viewM); // 视图空间(相机看向 -Z)
        minX=Math.min(minX,v.x); maxX=Math.max(maxX,v.x);
        minY=Math.min(minY,v.y); maxY=Math.max(maxY,v.y);
        const depth = -v.z; // 相机前方距离
        minZ=Math.min(minZ,depth); maxZ=Math.max(maxZ,depth);
      }

      // 4) 在近裁剪面上，按模型 X/Y 范围 + 留白，构建非对称透视视锥(makePerspective)
      const near = Math.max(minZ * 0.9, 0.001);
      const far  = maxZ * 1.2 + 0.001;
      // 把视图空间的 X/Y 范围投影到 near 平面：比例 = near / 物体所在深度(用 minZ 最稳妥贴边)
      const refDepth = minZ; // 用最近深度，保证模型完全在视锥内且贴边
      const s = near / refDepth;
      // 加留白：把范围按 (1+2*pad) 扩张
      const padX = (maxX - minX) * FRAME_PAD;
      const padY = (maxY - minY) * FRAME_PAD;
      const left   = (minX - padX) * s;
      const right  = (maxX + padX) * s;
      const bottom = (minY - padY) * s;
      const top    = (maxY + padY) * s;

      const cam = new THREE.PerspectiveCamera();
      cam.position.copy(camPos);
      cam.up.copy(camera.up);
      cam.lookAt(center);
      cam.near = near; cam.far = far;
      cam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      cam.updateMatrixWorld();

      // 5) 截图像素尺寸：按投影矩形长宽比，长边固定 CAPTURE_LONG
      const wRange = right - left;
      const hRange = top - bottom;
      const ar = wRange / hRange; // >1 宽图，<1 竖图
      let outW, outH;
      if (ar >= 1) { outW = CAPTURE_LONG; outH = Math.round(CAPTURE_LONG / ar); }
      else         { outH = CAPTURE_LONG; outW = Math.round(CAPTURE_LONG * ar); }

      return { cam, outW, outH, aspect: ar, center };
    }

    function captureView(download = false) {
      if (!currentModel) return;

      // 1) 构建“按模型实际长宽比”的截图相机 + 截图尺寸
      const { cam: capCam, outW, outH, center } = buildCaptureCamera();

      // 让主相机也对齐到该取景位置(保留角度)，便于直观
      camera.position.copy(capCam.position);
      controls.target.copy(center);
      controls.update();

      // 2) 按动态宽高创建离屏 RT，渲染(隐藏辅助网格/地面、背景透明)
      const w = outW, h = outH;
      const previousAccum = uniforms.uHasAccum.value;
      uniforms.uHasAccum.value = 0;
      const dynRT = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      });
      const gridVisible = grid.visible;
      const groundVisible = ground.visible;
      grid.visible = false;
      ground.visible = false;
      const oldBg = scene.background;
      scene.background = null;
      uniforms.uBakeMode.value = 0;

      renderer.setRenderTarget(dynRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, capCam);
      renderer.setRenderTarget(null);

      grid.visible = gridVisible;
      ground.visible = groundVisible;
      scene.background = oldBg;
      uniforms.uHasAccum.value = previousAccum;

      // 3) 读像素 -> canvas -> dataURL（WebGL 上下翻转）
      const pixels = new Uint8Array(w * h * 4);
      renderer.setRenderTarget(dynRT);
      renderer.readRenderTargetPixels(dynRT, 0, 0, w, h, pixels);
      renderer.setRenderTarget(null);
      dynRT.dispose();

      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const imgData = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const src = ((h - 1 - y) * w + x) * 4;
          const dst = (y * w + x) * 4;
          imgData.data[dst]   = pixels[src];
          imgData.data[dst+1] = pixels[src+1];
          imgData.data[dst+2] = pixels[src+2];
          imgData.data[dst+3] = pixels[src+3];
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const dataURL = cv.toDataURL('image/png');

      // 计算截图里主体(非透明区)的包围盒，作为自动校准的基准
      const shotBBox = computeAlphaBBox(imgData.data, w, h);

      // 4) 下载
      const a = document.createElement('a');
      a.href = dataURL;
      a.download = 'view_capture.png';
      if (download) a.click();

      // 缩略图
      const thumb = document.getElementById('thumb');
      thumb.src = dataURL;
      thumb.style.display = 'block';

      // 5) 锁存截图相机参数(aspect=outW/outH，与截图一致 -> 烘焙精准对齐)
      capCam.updateMatrixWorld();
      savedCam = {
        viewMatrix: capCam.matrixWorldInverse.toArray(),
        projectionMatrix: capCam.projectionMatrix.toArray(),
        cameraPosition: capCam.position.toArray(),
        aspect: w / h,
        near: capCam.near, far: capCam.far,
        outW, outH,
        shotBBox, // 截图主体包围盒(像素)，用于自动校准
      };

      document.getElementById('downloadCamBtn').disabled = false;
      document.getElementById('pngInput').disabled = false;
      setStatus('captureStatus', `已锁定 ${outW}×${outH} 当前视角，生成结果使用此相机映射。`, false);
      return { capture: dataURL, camera: structuredClone(savedCam) };
    }
    document.getElementById('captureBtn').addEventListener('click', () => captureView(true));

    document.getElementById('downloadCamBtn').addEventListener('click', () => {
      if (!savedCam) return;
      const blob = new Blob([JSON.stringify(savedCam, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'camera_params.json';
      a.click();
    });

    // ===================== 第3步：上传 PNG + 自动校准 + 烘焙 =====================
    // 校准状态：保存当前 PNG 图像、其主体包围盒、自动对齐基准、手动微调偏移
    let pngImage = null;       // 上传的 PNG (Image 对象)
    let pngBBox = null;        // PNG 主体包围盒(归一化)
    let autoFit = null;        // 自动对齐参数 { scale, offsetX, offsetY }(归一化)
    let currentEditLayerId = null; // 当前 PNG/微调对应的图层；重新映射时替换它，避免重叠
    let pngDiagText = '';      // 最近一次 PNG 透明度/对齐诊断
    let pngAlphaWarning = false;
    const manualAdjust = { dx: 0, dy: 0, scale: 1 }; // 手动微调(相对自动结果)

    document.getElementById('pngInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!savedCam) { setStatus('bakeStatus', '请先完成第2步截图', true); return; }
      if (!modelHasUV) { setStatus('bakeStatus', '当前模型缺少 UV，无法映射。请换带 UV 的模型，或先做 UV 展开。', true); return; }

      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          pngImage = img;
          currentEditLayerId = null;
          // 提取 PNG 主体包围盒
          const tcv = document.createElement('canvas');
          tcv.width = img.width; tcv.height = img.height;
          const tctx = tcv.getContext('2d');
          tctx.drawImage(img, 0, 0);
          const idata = tctx.getImageData(0, 0, img.width, img.height);
          pngBBox = computeAlphaBBox(idata.data, img.width, img.height);
          const alphaStats = computeAlphaStats(idata.data, img.width, img.height);

          // 计算自动对齐：让 PNG 主体包围盒 对齐到 截图主体包围盒
          computeAutoFit();
          const bboxFull = !!pngBBox && pngBBox.w > 0.96 && pngBBox.h > 0.96;
          pngAlphaWarning = alphaStats.transparentRatio < 0.02 || bboxFull;
          pngDiagText = `透明=${(alphaStats.transparentRatio * 100).toFixed(1)}% 主体=${(alphaStats.subjectRatio * 100).toFixed(1)}% 缩放=${(autoFit?.scale || 1).toFixed(2)}`;
          console.log('[PNG对齐诊断]', { shotBBox: savedCam.shotBBox, pngBBox, alphaStats, autoFit, pngAlphaWarning });

          // 重置手动微调
          manualAdjust.dx = 0; manualAdjust.dy = 0; manualAdjust.scale = 1;
          syncAdjustUI();

          // 显示校准面板
          document.getElementById('alignPanel').style.display = 'block';

          // 用对齐后的图烘焙
          bakeAligned();
        };
        img.src = ev.target.result;
        lastPngDataURL = ev.target.result;
      };
      reader.readAsDataURL(file);
    });

    // 计算自动对齐参数：把 PNG 主体缩放/平移，使其包围盒与截图主体包围盒重合
    function computeAutoFit() {
      const shot = savedCam.shotBBox;
      if (!shot || !pngBBox) { autoFit = { scale: 1, offsetX: 0, offsetY: 0 }; return; }
      // 缩放：综合宽高做视觉面积匹配。相比 Math.min(sx, sy)，不会因单边略大而整体缩得过小。
      const sx = shot.w / pngBBox.w;
      const sy = shot.h / pngBBox.h;
      const scale = Math.sqrt(Math.max(sx * sy, 0.0001));
      // 平移：让缩放后 PNG 主体中心 = 截图主体中心(都按归一化, 以输出画布为基准)
      autoFit = { scale, sx, sy, shot, png: pngBBox };
    }

    // 把 PNG 经「自动对齐 + 手动微调」绘制到与截图同尺寸的 canvas，返回该 canvas
    function buildAlignedCanvas() {
      const W = savedCam.outW, H = savedCam.outH;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      if (!pngImage || !autoFit) return cv;

      const shot = savedCam.shotBBox;
      // 自动等比缩放 × 手动缩放
      const scale = autoFit.scale * manualAdjust.scale;
      // PNG 主体中心(像素) -> 期望落到截图主体中心(像素) + 手动偏移
      const pngCx = pngBBox.cx * pngImage.width;
      const pngCy = pngBBox.cy * pngImage.height;
      const targetCx = (shot.cx + manualAdjust.dx) * W;
      const targetCy = (shot.cy + manualAdjust.dy) * H;

      // 以 PNG 主体中心为锚点，缩放后平移到目标中心
      ctx.save();
      ctx.translate(targetCx, targetCy);
      ctx.scale(scale, scale);
      ctx.translate(-pngCx, -pngCy);
      ctx.drawImage(pngImage, 0, 0);
      ctx.restore();
      return cv;
    }

    // 用对齐后的 canvas 作为贴图映射输入
    function bakeAligned() {
      const cv = buildAlignedCanvas();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = true;
      tex.needsUpdate = true;
      uniforms.uProjMap.value?.dispose();
      uniforms.uProjMap.value = tex;
      const bakedLayerId = bake(currentEditLayerId);
      if (bakedLayerId !== null) {
        currentEditLayerId = bakedLayerId;
        const warn = pngAlphaWarning ? ' ⚠ 透明通道疑似异常，自动对齐可能不准。' : '';
        const diag = pngDiagText ? `（${pngDiagText}）` : '';
        setStatus('bakeStatus', `PNG 已自动校准并映射 ✓${diag}${warn}`, pngAlphaWarning);
      } else {
        setStatus('bakeStatus', '映射未写入像素：检查模型/角度/校准。', true);
      }
    }

    // 同步微调 UI 显示值
    function syncAdjustUI() {
      document.getElementById('adjDx').value = manualAdjust.dx;
      document.getElementById('adjDy').value = manualAdjust.dy;
      document.getElementById('adjScale').value = Math.min(3.0, Math.max(0.3, manualAdjust.scale));
      document.getElementById('adjScaleInput').value = manualAdjust.scale.toFixed(2);
      document.getElementById('adjDxVal').textContent = manualAdjust.dx.toFixed(3);
      document.getElementById('adjDyVal').textContent = manualAdjust.dy.toFixed(3);
    }
    // 微调滑块绑定(仅更新值，点“重新映射”才应用，避免频繁处理卡顿)
    document.getElementById('adjDx').addEventListener('input', (e) => {
      manualAdjust.dx = parseFloat(e.target.value);
      document.getElementById('adjDxVal').textContent = manualAdjust.dx.toFixed(3);
    });
    document.getElementById('adjDy').addEventListener('input', (e) => {
      manualAdjust.dy = parseFloat(e.target.value);
      document.getElementById('adjDyVal').textContent = manualAdjust.dy.toFixed(3);
    });
    document.getElementById('adjScale').addEventListener('input', (e) => {
      manualAdjust.scale = parseFloat(e.target.value);
      document.getElementById('adjScaleInput').value = manualAdjust.scale.toFixed(2);
    });
    // 缩放输入框：手动输入倍数(范围比滑块更大)，与滑块联动
    document.getElementById('adjScaleInput').addEventListener('change', (e) => {
      let v = parseFloat(e.target.value);
      if (isNaN(v) || v <= 0) v = 1;
      v = Math.min(10, Math.max(0.05, v));
      manualAdjust.scale = v;
      e.target.value = v.toFixed(2);
      // 同步滑块(超出滑块范围时夹到端点，但实际值仍用输入框的)
      document.getElementById('adjScale').value = Math.min(3.0, Math.max(0.3, v));
    });
    document.getElementById('rebakeBtn').addEventListener('click', () => {
      if (!pngImage) { setStatus('bakeStatus', '请先上传 PNG', true); return; }
      bakeAligned();
    });

    // 从投影相机视角渲染深度图：用 savedCam 矩阵，输出每点到相机的线性距离
    const depthCamPos = new THREE.Vector3();
    function renderDepthMap() {
      ensureDepthRT();
      const rt = depthRT;

      // 用 savedCam 的 view/proj 矩阵构建一个相机
      const dcam = new THREE.PerspectiveCamera();
      const viewM = new THREE.Matrix4().fromArray(savedCam.viewMatrix);
      const worldM = viewM.clone().invert();
      dcam.matrixWorld.copy(worldM);
      dcam.matrixWorldInverse.copy(viewM);
      dcam.projectionMatrix.fromArray(savedCam.projectionMatrix);
      dcam.projectionMatrixInverse.copy(dcam.projectionMatrix).invert();
      dcam.matrixAutoUpdate = false;

      depthCamPos.fromArray(savedCam.cameraPosition);
      depthUniforms.uCamPos.value.copy(depthCamPos);

      // 用深度材质渲染所有 mesh 到深度 RT
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      // 清成 0：表示该方向没有任何表面(无遮挡)。shader 里把 ~0 视为无效跳过。
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      for (const m of meshes) {
        m.updateMatrixWorld(true);
        const orig = m.material;
        m.material = depthMaterial;
        renderer.render(m, dcam);
        m.material = orig;
      }
      renderer.setRenderTarget(null);
      renderer.autoClear = oldAutoClear;

      // 启用深度遮挡测试
      uniforms.uDepthMap.value = rt.texture;
      uniforms.uUseDepth.value = 1;
    }

    function bake(replaceLayerId = null) {
      if (meshes.length === 0) return null;

      // 用锁存的相机参数填充投影矩阵
      uniforms.uProjViewMatrix.value.fromArray(savedCam.viewMatrix);
      uniforms.uProjProjMatrix.value.fromArray(savedCam.projectionMatrix);
      uniforms.uProjCamPos.value.fromArray(savedCam.cameraPosition);

      // ===== 步骤A：从投影相机视角渲染深度图(到相机的线性距离) =====
      // 用 savedCam 的矩阵构建一个相机来渲染深度。
      renderDepthMap();

      // ===== 烘焙到一张【独立图层 RT】(不再累积，单图层) =====
      const layerRT = makeRT();
      uniforms.uBakeMode.value = 1;

      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(layerRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      for (const m of meshes) {
        m.updateMatrixWorld(true);
        renderer.render(m, bakeCamera);
      }
      renderer.setRenderTarget(null);
      renderer.autoClear = oldAutoClear;
      uniforms.uBakeMode.value = 0;

      // 检测是否真的写入了像素：读取【整张】图(降采样判断)，
      // 不能只看中心——不同视角覆盖的 UV 区域不同，中心可能恰好为空导致误判。
      const fullBuf = new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4);
      renderer.setRenderTarget(layerRT);
      renderer.readRenderTargetPixels(layerRT, 0, 0, BAKE_SIZE, BAKE_SIZE, fullBuf);
      renderer.setRenderTarget(null);
      let written = 0;
      // 每隔若干像素抽样，统计 alpha>5 的数量
      for (let i = 3; i < fullBuf.length; i += 4 * 37) {
        if (fullBuf[i] > 5) { written++; if (written > 10) break; }
      }
      if (written === 0) { layerRT.dispose(); return null; }

      // ===== 接缝填充(dilation) =====
      // 方案 B 的显示只采中心点，UV 接缝缝隙处纹素权重=0，会露出底色形成黑线。
      // 在烘焙阶段(有完整几何信息)把缝隙向外扩张少量像素填上，是填洞的正确位置——
      // 而非回到显示阶段做邻域借色(那会跨接缝拉色 -> 线状碎片)。
      // 步数取 SEAM_DILATE_STEPS(=2)：只补 ~1px 黑线缝，扩不到邻岛 padding，不污染背面。
      const dilatedRT = dilateTexture(layerRT.texture, SEAM_DILATE_STEPS);
      copyTexToRT(dilatedRT.texture, layerRT);

      // 生成缩略图(用本次上传的 PNG 作为图层缩略图，直观)
      const thumb = lastPngDataURL || null;

      let layerId;
      const replaceIdx = replaceLayerId !== null ? layers.findIndex(l => l.id === replaceLayerId) : -1;
      if (replaceIdx >= 0) {
        const oldLayer = layers[replaceIdx];
        layerId = oldLayer.id;
        oldLayer.rt.dispose();
        layers[replaceIdx] = {
          id: layerId,
          rt: layerRT,
          thumb,
          visible: oldLayer.visible,
          name: oldLayer.name,
        };
      } else {
        // 加入图层(置于顶层)
        layerSeq++;
        layerId = layerSeq;
        layers.push({ id: layerId, rt: layerRT, thumb, visible: true, name: '贴图 ' + layerId });
      }

      // 重新合成并刷新图层面板
      dilatedRT.dispose();
      recomposeLayers();
      renderLayerPanel();
      return layerId;
    }

    // ===================== 控件 =====================
    function setStatus(id, msg, isErr) {
      const el = document.getElementById(id);
      el.textContent = msg;
      el.className = 'status' + (isErr ? ' err' : '');
    }
    function enableAfterModel() {
      document.getElementById('captureBtn').disabled = false;
    }

    const VIEW_PRESETS = {
      front:  { dir: new THREE.Vector3( 0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
      back:   { dir: new THREE.Vector3( 0, 0,-1), up: new THREE.Vector3(0, 1, 0) },
      left:   { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
      right:  { dir: new THREE.Vector3( 1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
      top:    { dir: new THREE.Vector3( 0, 1, 0), up: new THREE.Vector3(0, 0,-1) },
      bottom: { dir: new THREE.Vector3( 0,-1, 0), up: new THREE.Vector3(0, 0, 1) },
    };

    function getModelFrame() {
      if (!currentModel) return null;
      currentModel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(currentModel);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere(center.clone()));
      return { box, center, radius: Math.max(sphere.radius, 0.001) };
    }

    function focusModel(viewKey = null) {
      const frame = getModelFrame();
      if (!frame) return;
      const preset = viewKey ? VIEW_PRESETS[viewKey] : null;
      const dir = preset
        ? preset.dir.clone().normalize()
        : camera.position.clone().sub(controls.target).normalize();
      if (dir.lengthSq() < 0.0001) dir.set(0, 0, 1);
      const fov = THREE.MathUtils.degToRad(camera.fov || 45);
      const dist = Math.max(frame.radius / Math.sin(fov * 0.5) * 1.15, frame.radius * 2.2);
      camera.position.copy(frame.center).addScaledVector(dir, dist);
      camera.near = Math.max(dist - frame.radius * 3.0, 0.001);
      camera.far = dist + frame.radius * 5.0 + 10;
      camera.up.copy(preset ? preset.up : new THREE.Vector3(0, 1, 0));
      controls.target.copy(frame.center);
      controls.minDistance = Math.max(frame.radius * 0.15, 0.05);
      controls.maxDistance = Math.max(frame.radius * 8.0, 8);
      camera.lookAt(frame.center);
      camera.updateProjectionMatrix();
      controls.update();
    }

    document.querySelectorAll('#viewportTools [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => focusModel(btn.dataset.view));
    });
    document.getElementById('focusModelBtn').addEventListener('click', () => focusModel());
    document.getElementById('resetViewBtn').addEventListener('click', () => focusModel('front'));
    document.getElementById('toggleGridBtn').addEventListener('click', (e) => {
      const visible = !grid.visible;
      grid.visible = visible;
      ground.visible = visible;
      e.currentTarget.classList.toggle('active', visible);
    });
    document.getElementById('rawPreviewBtn').addEventListener('click', (e) => {
      const enabled = uniforms.uPreviewMode.value === 0;
      uniforms.uPreviewMode.value = enabled ? 1 : 0;
      e.currentTarget.classList.toggle('active', enabled);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key.toLowerCase() === 'f') focusModel();
    });

    document.getElementById('falloff').addEventListener('input', (e) => {
      uniforms.uFalloff.value = parseFloat(e.target.value);
      document.getElementById('falloffVal').textContent = e.target.value;
    });
    document.getElementById('feather').addEventListener('input', (e) => {
      uniforms.uFeather.value = parseFloat(e.target.value);
      document.getElementById('featherVal').textContent = e.target.value;
    });
    document.getElementById('brightness').addEventListener('input', (e) => {
      uniforms.uBrightness.value = parseFloat(e.target.value);
      document.getElementById('brightVal').textContent = e.target.value;
    });
    document.getElementById('resetBakeBtn').addEventListener('click', () => {
      // 清空所有图层
      for (const L of layers) L.rt.dispose();
      layers.length = 0;
      currentEditLayerId = null;
      uniforms.uHasAccum.value = 0;
      uniforms.uAccumMap.value = null;
      recomposeLayers();
      renderLayerPanel();
      accumRT = null;
      setStatus('bakeStatus', '已清空所有图层', false);
    });
    document.getElementById('showUVBtn').addEventListener('click', () => {
      if (!accumRT) { alert('还没有映射结果'); return; }

      // accumRT 是 Float 加权累加结果，需先归一化为普通 RGBA 贴图：
      // rgb = Σ(色×权重) / Σ权重，alpha = 覆盖度。不能直接 readRenderTargetPixels(accumRT)。
      const previewRT = renderNormalizedAccumToRT(accumRT);
      const w = BAKE_SIZE, h = BAKE_SIZE;
      const pixels = new Uint8Array(w * h * 4);
      renderer.setRenderTarget(previewRT);
      renderer.readRenderTargetPixels(previewRT, 0, 0, w, h, pixels);
      renderer.setRenderTarget(null);
      previewRT.dispose();

      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const imgData = ctx.createImageData(w, h);
      // WebGL 的纹理是上下翻转的，翻回来
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const src = ((h - 1 - y) * w + x) * 4;
          const dst = (y * w + x) * 4;
          imgData.data[dst] = pixels[src];
          imgData.data[dst+1] = pixels[src+1];
          imgData.data[dst+2] = pixels[src+2];
          imgData.data[dst+3] = pixels[src+3];
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const win = window.open('');
      win.document.write('<title>映射生成的贴图</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img src="'+cv.toDataURL()+'" style="max-width:90vw;max-height:90vh;border:1px solid #444"/></body>');
    });

    // ===================== 渲染循环 =====================
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      uniforms.uBakeMode.value = 0; // 始终以显示模式渲染主画面
      renderer.setClearColor(BG_COLOR, 1);
      renderer.render(scene, camera);
    }
    animate();

    // 取景框尺寸：正方形，边长 = 屏幕高度。
    // 因为正方形相机沿用主相机的“垂直 fov”，其垂直可见范围与屏幕一致，
    // 故取景框高度=屏幕高度时，框内即正方形相机所截范围(左右对称裁掉宽屏多余部分)。
    function updateFramer() {
      const side = Math.min(window.innerHeight, window.innerWidth); // 不超过屏宽
      const f = document.getElementById('framer');
      f.style.width = side + 'px';
      f.style.height = side + 'px';
    }
    updateFramer();

    window.addEventListener('resize', () => {
      camera.aspect = viewport.clientWidth / viewport.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(viewport.clientWidth, viewport.clientHeight);
      updateFramer();
    });
  
// ===================== Local ComfyUI integration =====================
let references = [];
let generating = false;
let connected = false;
let workflowReady = false;
let resultContext = null;
let pendingContext = null;
const $ = id => document.getElementById(id);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function refreshGenerate() {
  $('generateBtn').disabled = generating || !connected || !workflowReady || !currentModel || !modelHasUV || !references.length;
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || '服务请求失败');
  return data;
}
async function checkConnection() {
  setStatus('connectionStatus', '正在连接 ComfyUI…');
  try {
    const data = await api('/api/health');
    connected = true;
    workflowReady = data.workflow_ready;
    if (!workflowReady) setStatus('generationStatus', '工作流未就绪：' + data.workflow_error, true);
    setStatus('connectionStatus', '● ComfyUI 已连接');
    $('connectionStatus').title = `${data.comfy_url} · ${data.workflow} · ${data.device}`;
  } catch (error) {
    connected = false;
    setStatus('connectionStatus', '● ComfyUI 未连接', true);
    $('connectionStatus').title = error.message;
  }
  refreshGenerate();
}
$('healthBtn').addEventListener('click', checkConnection);

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(blob);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法加载'));
    img.src = src;
  });
}
function renderReferences() {
  $('refsPreview').replaceChildren();
  for (const ref of references) {
    const img = document.createElement('img');
    img.src = ref; img.alt = '角色参考图';
    img.style.cssText = 'width:70px;height:80px;object-fit:contain;background:#383842;border-radius:5px';
    $('refsPreview').appendChild(img);
  }
  setStatus('refsStatus', `已选择 ${references.length} 张，作为同一角色的参考板`);
  refreshGenerate();
}
$('refsInput').addEventListener('change', async event => {
  try {
    const files = [...event.target.files];
    if (files.length < 1 || files.length > 6) throw new Error('请选择 1–6 张设计图');
    if (files.some(file => file.size > 12 * 1024 * 1024)) throw new Error('每张设计图请小于 12MB');
    const next = [];
    for (const file of files) {
      const img = await loadImage(await dataURL(file));
      const scale = Math.min(1, 1536 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      next.push(cv.toDataURL('image/png'));
    }
    references = next; renderReferences();
  } catch (error) { setStatus('refsStatus', error.message, true); }
});

let disabledStates = [];
function lockGeneration(locked) {
  generating = locked;
  if (locked) {
    disabledStates = [...document.querySelectorAll('#panel button, #panel input, #panel textarea, #panel select, #layersPanel button')]
      .map(el => [el, el.disabled]);
    disabledStates.forEach(([el]) => { el.disabled = true; });
  } else {
    disabledStates.forEach(([el, disabled]) => { el.disabled = disabled; });
    disabledStates = [];
  }
  $('jobProgress').style.display = locked ? 'block' : 'none';
  refreshGenerate();
}
async function applyGenerated() {
  if (!resultContext || currentModel !== resultContext.model) throw new Error('模型已改变，请重新生成');
  const img = await loadImage(resultContext.result);
  savedCam = structuredClone(resultContext.camera);
  pngImage = img;
  currentEditLayerId = resultContext.layerId ?? null;
  // Bridge output preserves the capture coordinate system and exact model alpha.
  // Do not fit an opaque AI image's bounding box: that would shift the projection.
  const alignedSource = document.createElement('canvas');
  alignedSource.width = img.width; alignedSource.height = img.height;
  const alignedCtx = alignedSource.getContext('2d');
  alignedCtx.drawImage(img, 0, 0);
  const sourcePixels = alignedCtx.getImageData(0, 0, img.width, img.height);
  pngBBox = computeAlphaBBox(sourcePixels.data, img.width, img.height);
  if (!pngBBox) throw new Error('89 号节点返回的图像没有可见主体');
  computeAutoFit();
  manualAdjust.dx = 0; manualAdjust.dy = 0; manualAdjust.scale = 1;
  pngAlphaWarning = false;
  pngDiagText = '89 号节点输出 · 按透明主体对齐截图';
  lastPngDataURL = resultContext.result;
  syncAdjustUI();
  $('alignPanel').style.display = 'block';
  bakeAligned();
  resultContext.layerId = currentEditLayerId;
  if (currentEditLayerId === null) throw new Error('没有写入 UV，请检查模型 UV 和视角');
}
$('applyResultBtn').addEventListener('click', () => applyGenerated().catch(e => setStatus('generationStatus', e.message, true)));

async function followJob(id, context) {
  let failures = 0;
  for (;;) {
    let job;
    try { job = await api('/api/jobs/' + id); failures = 0; }
    catch (error) {
      failures++;
      setStatus('generationStatus', `连接暂时中断，正在重试（${failures}）…`, true);
      if (failures >= 20) throw new Error('服务连接中断；任务编号 ' + id + '。点击恢复任务继续查询。');
      await wait(3000); continue;
    }
    setStatus('generationStatus', `${job.message}${job.elapsed_seconds !== undefined ? ` · ${job.elapsed_seconds} 秒` : ''}${job.seed !== undefined ? ` · 种子 ${job.seed}` : ''}`, job.status === 'failed');
    if (job.status === 'failed') { localStorage.removeItem('bakeStudioJob'); throw new Error(job.message); }
    if (job.status === 'completed') {
      localStorage.removeItem('bakeStudioJob');
      $('resultPanel').style.display = 'block';
      $('resultImage').src = job.result;
      $('resultDownload').href = job.result;
      $('workflowDownload').href = `/runs/${id}/workflow_api.json`;
      if (context && currentModel === context.model) {
        resultContext = { ...context, result: job.result };
        if (context.autoMap) {
          await applyGenerated();
          setStatus('generationStatus', `生成并映射完成 · ${job.elapsed_seconds} 秒 · 种子 ${job.seed}`);
        }
      } else {
        resultContext = null;
        setStatus('generationStatus', '任务已完成，可下载结果。页面重载后模型与相机未恢复，请勿直接映射到其他视角。');
      }
      return;
    }
    await wait(2500);
  }
}
$('generateBtn').addEventListener('click', async () => {
  try {
    const shot = captureView();
    if (!shot) throw new Error('请先加载模型');
    const autoMap = $('autoMap').checked;
    const payload = { ...shot, references, resolution: Number($('resolutionInput').value),
      seed: Number($('seedInput').value), prompt: $('promptInput').value };
    if (!Number.isSafeInteger(payload.seed) || payload.seed < -1) throw new Error('种子需要为 -1 或非负整数');
    lockGeneration(true);
    $('resultPanel').style.display = 'none';
    setStatus('generationStatus', '正在提交当前视角…');
    pendingContext = { camera: shot.camera, model: currentModel, autoMap };
    const job = await api('/api/jobs', payload);
    localStorage.setItem('bakeStudioJob', job.id);
    resumeBtn.style.display = 'block';
    await followJob(job.id, pendingContext);
    resumeBtn.style.display = 'none';
  } catch (error) { setStatus('generationStatus', error.message, true); }
  finally { lockGeneration(false); $('applyResultBtn').disabled = !resultContext; }
});

$('demoBtn').addEventListener('click', async () => {
  $('demoBtn').disabled = true;
  try {
    const demo = await api('/api/demo');
    const response = await fetch(demo.reference);
    if (!response.ok) throw new Error('示例设计图不存在');
    const ref = await dataURL(await response.blob());
    const gltf = await new GLTFLoader().loadAsync(demo.model);
    onModelLoaded(gltf.scene);
    references = [ref]; renderReferences();
  } catch (error) { setStatus('modelStatus', '示例加载失败：' + error.message, true); }
  finally { $('demoBtn').disabled = false; }
});

function textureCanvas() {
  if (!accumRT || !layers.some(layer => layer.visible)) throw new Error('请先生成并映射至少一个可见图层');
  const target = renderNormalizedAccumToRT(accumRT);
  const buf = new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4);
  renderer.readRenderTargetPixels(target, 0, 0, BAKE_SIZE, BAKE_SIZE, buf);
  target.dispose();
  const cv = document.createElement('canvas'); cv.width = cv.height = BAKE_SIZE;
  const ctx = cv.getContext('2d'), pixels = ctx.createImageData(BAKE_SIZE, BAKE_SIZE);
  for (let y = 0; y < BAKE_SIZE; y++) {
    pixels.data.set(buf.subarray((BAKE_SIZE - 1 - y) * BAKE_SIZE * 4, (BAKE_SIZE - y) * BAKE_SIZE * 4), y * BAKE_SIZE * 4);
  }
  ctx.putImageData(pixels, 0, 0);
  return cv;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
$('exportUVBtn').addEventListener('click', () => {
  try { textureCanvas().toBlob(blob => downloadBlob(blob, 'character_albedo.png')); }
  catch (error) { setStatus('bakeStatus', error.message, true); }
});
$('exportGLBBtn').addEventListener('click', async () => {
  let tex, mat;
  try {
    if (!currentModel) throw new Error('请先加载模型');
    const cv = textureCanvas();
    // Fill unseen UV regions with neutral gray in the exported model.
    const ctx = cv.getContext('2d'); ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#d2d2d2'; ctx.fillRect(0, 0, cv.width, cv.height);
    tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = true;
    mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const root = currentModel.clone(true);
    root.traverse(obj => { if (obj.isMesh) obj.material = mat; });
    const buffer = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
    downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), 'character_textured.glb');
    setStatus('bakeStatus', '已导出带贴图 GLB；未覆盖区域保留灰色');
  } catch (error) { setStatus('bakeStatus', '导出失败：' + error.message, true); }
  finally { tex?.dispose(); mat?.dispose(); }
});

const resumeBtn = document.createElement('button');
resumeBtn.textContent = '恢复上次生成任务'; resumeBtn.className = 'secondary';
resumeBtn.style.marginTop = '8px';
$('generationStatus').after(resumeBtn);
resumeBtn.style.display = localStorage.getItem('bakeStudioJob') ? 'block' : 'none';
resumeBtn.addEventListener('click', async () => {
  const id = localStorage.getItem('bakeStudioJob');
  if (!id) return;
  lockGeneration(true);
  try { await followJob(id, pendingContext); resumeBtn.style.display = 'none'; }
  catch (error) { setStatus('generationStatus', error.message, true); }
  finally { lockGeneration(false); $('applyResultBtn').disabled = !resultContext; }
});
checkConnection();


// Bottom diagnostics: app connection, persisted tasks and ComfyUI exception details.
const consoleEntries = [];
const consoleSeen = new Set();
function appendConsole(key, message, isError = false) {
  if (consoleSeen.has(key)) return;
  consoleSeen.add(key);
  consoleEntries.push(`[${new Date().toLocaleTimeString()}] ${isError ? 'ERROR' : 'INFO'} ${message}`);
  if (consoleEntries.length > 150) consoleEntries.shift();
  $('consoleLog').textContent = consoleEntries.join('\n\n');
  $('consoleSummary').textContent = message.split('\n')[0];
  $('consoleBody').scrollTop = $('consoleBody').scrollHeight;
  if (isError) toggleConsole(true);
}
function toggleConsole(open) {
  document.body.classList.toggle('console-open', open);
  $('consoleBody').hidden = !open;
  $('consoleToggle').setAttribute('aria-expanded', String(open));
  $('consoleToggle').textContent = `${open ? '▾' : '▸'} 控制台`;
  window.dispatchEvent(new Event('resize'));
}
$('consoleToggle').addEventListener('click', () => toggleConsole($('consoleBody').hidden));
$('consoleClear').addEventListener('click', () => {
  consoleEntries.length = 0; $('consoleLog').textContent = ''; $('consoleSummary').textContent = '显示已清空，任务记录仍保留';
});
$('consoleCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(consoleEntries.join('\n\n')); $('consoleSummary').textContent = '日志已复制'; }
  catch { $('consoleSummary').textContent = '复制失败，请在控制台中选择文字复制'; }
});
async function refreshConsole() {
  try {
    const data = await api('/api/console');
    appendConsole('bridge-ready', '前端服务在线 · ComfyUI ' + data.comfy_url);
    for (const job of data.jobs) {
      const detail = job.error_detail;
      let message = `任务 ${job.id} · ${job.status}\n${job.message || ''}`;
      if (job.prompt_id) message += `\nComfyUI prompt_id: ${job.prompt_id}`;
      if (detail) message += `\n失败节点: ${detail.node_id} (${detail.node_type})\n${detail.exception_message}\n${(detail.traceback || []).join('')}`;
      if ((job.message || '').includes('HostBuffer.read_file_slice')) message += '\n诊断：模型权重的磁盘读取/内存传输失败。截图中的 Windows 1450 表示系统资源不足；这次未进入正常采样。';
      appendConsole(job.id + ':' + job.status, message, job.status === 'failed');
    }
  } catch (error) { appendConsole('bridge-error:' + error.message, '控制台读取失败：' + error.message, true); }
}
window.addEventListener('error', event => appendConsole('js:' + event.message, event.message, true));
window.addEventListener('unhandledrejection', event => appendConsole('promise:' + event.reason, String(event.reason), true));
refreshConsole();
setInterval(refreshConsole, 5000);
