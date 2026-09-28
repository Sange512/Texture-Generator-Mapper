# ComfyUI 节点 · 模型主体对齐

把 AI 生成的带贴图图，对齐到同视角的白模图，并输出：对齐后的图、主体遮罩(MASK)、叠加预览、以及对齐信息文本。算法与桌面版对齐工具一致（SDF 特征 + 多候选粗对齐 + 金字塔 ECC 择优）。

## 安装

1. 把整个文件夹复制到 ComfyUI 的 `custom_nodes` 目录下。
   - 建议改成**纯英文名**再放进去，例如 `ComfyUI/custom_nodes/ComfyUI-SubjectAlign/`（个别 ComfyUI 加载器对中文文件夹名兼容性不佳）。
2. 安装依赖（用 ComfyUI 所使用的那个 Python 环境）：
   ```bash
   pip install -r requirements.txt
   # 关键是 opencv-python、rembg；rembg 首次运行会自动下载抠图模型
   ```
   - 如果没装 `rembg`，节点仍可运行，会自动回退到 GrabCut/阈值抠图，但边缘质量会下降。
3. 重启 ComfyUI。

## 节点

菜单分类：`image/对齐`

### 1. 主体对齐 (白模↔AI贴图)  `SubjectAlign`
- 输入：
  - `白模图` (IMAGE)：参考图，定义目标坐标系与分辨率
  - `AI生成图` (IMAGE)：待对齐图
  - `精对齐ECC` (BOOLEAN，默认开)：金字塔 ECC 精修（允许微旋转/单应）
  - `高分辨率超采样` (BOOLEAN，默认开)：内部按高分辨率渲染，边缘更干净
  - `输出用白模图分辨率` (BOOLEAN，默认开)：成品缩放回白模图分辨率
- 输出：
  - `对齐图` (IMAGE)：对齐后的 AI 图（白底，RGB）
  - `遮罩` (MASK)：对齐后主体的柔和遮罩（含头发/边缘过渡）
  - `叠加预览` (IMAGE)：白模与对齐结果 50% 叠加，方便肉眼检查
  - `信息` (STRING)：方式 / 缩放 / 尺寸 / 对齐前后 IoU

### 2. 图像+遮罩→透明RGBA  `ApplyAlphaToImage`
- 把 `对齐图` + `遮罩` 合成为 4 通道 RGBA IMAGE。
- 接 `SaveImage` 即可保存**带透明背景的 PNG**（去背景成品）。

## 典型连线

```
Load Image(白模)  ─┐
                    ├─> 主体对齐 ─> 对齐图 ─┐
Load Image(AI图) ─┘              └ 遮罩 ──┴─> 图像+遮罩→透明RGBA ─> SaveImage(透明PNG)
                                  └ 叠加预览 ─> PreviewImage(检查对齐)
```

- 只要不透明的对齐图：直接把`对齐图`接 `SaveImage`。
- 要去背景透明图：`对齐图` + `遮罩` → `图像+遮罩→透明RGBA` → `SaveImage`。

## 说明
- `遮罩` 也可直接喂给其它需要 MASK 的节点（如重绘、合成）。
- 批处理：`AI生成图` 为多张时逐张对齐；`白模图`若只有一张会对所有 AI 图共用。
