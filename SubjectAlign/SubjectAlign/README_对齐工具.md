# 模型主体对齐工具

把 AI 生成的带贴图模型图，自动对齐到同视角的白模图（解决 AI 出图时主体位置、大小、轻微旋转的偏移问题）。

## 一、给别人用：两种分发方式

### 方式 1：发源码 + 启动脚本（推荐，简单）
对方电脑需装好 Python，然后：

1. 把这几个文件发给对方放到同一文件夹：
   - `align_subject.py`（核心算法）
   - `align_gui.py`（图形界面）
   - `启动对齐工具.bat`（双击启动）
   - `requirements.txt`
2. 对方首次使用，先装依赖（命令行执行一次）：
   ```
   pip install -r requirements.txt
   ```
3. 之后**双击 `启动对齐工具.bat`** 即可打开界面。

### 方式 2：打包成 exe（对方无需装 Python，最省心）
在你自己机器上执行（需先 `pip install pyinstaller`）：

```bash
pyinstaller -w -F --name 模型对齐工具 ^
  --collect-all rembg --collect-all onnxruntime ^
  align_gui.py
```

- `-w` 不弹黑窗，`-F` 打包成单个 exe
- 生成的 exe 在 `dist/` 目录，直接发给对方双击运行即可
- 注意：含 rembg 模型时 exe 较大（几百 MB 属正常）；若想减小体积，可去掉 rembg，仅用内置 GrabCut 抠图

## 二、界面用法

1. 选择 / 拖入 **白模图**（作为对齐参考）
2. 选择 / 拖入 **AI生成图**（要被对齐的图）
3. 勾选选项（默认即可）：
   - **精对齐(ECC)**：允许微旋转，提高精度
   - **高分辨率**：保留 AI 贴图细节，不被压缩到白模尺寸
   - **输出调试图**：额外导出 mask 和叠加预览
4. 点 **开始对齐**，选择保存位置
5. 右侧显示叠加预览，底部显示 **IoU 重合度**（≥0.9 即对齐良好）

## 三、命令行用法（高级 / 批处理）

```bash
python align_subject.py --ref 白模图.png --mov AI生成图.png --out aligned.png --ecc --hires --debug
```

## 四、依赖说明

| 依赖 | 作用 | 是否必需 |
|------|------|----------|
| opencv-python, numpy, pillow | 图像处理 | 必需 |
| rembg[cpu] | AI 抠图，剪影更准 | 强烈推荐（不装会回退 GrabCut） |
| tkinterdnd2 | 拖拽图片到界面 | 可选 |

## 五、对齐效果不好怎么办

- IoU 偏低多半是**抠图不准**，优先确保装了 `rembg[cpu]`
- 主体是横向物体（如武器）时，可在 `align_subject.py` 的 `coarse_similarity` 里把高度比改成宽度比或 `sqrt(面积比)`
- 若两图存在明显透视差异，需把 ECC 改成 `MOTION_HOMOGRAPHY`（单应变换）
