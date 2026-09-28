# Marigold-IID 贴图去光工具

调用官方 **Marigold 内在图像分解（IID）** 模型，把带光影的贴图（如 `QwenEdit_白模上色` 工作流输出）分解出**去光后的 albedo（纯固有色）**，作为流水线里独立的一步使用。

> 官方仓库：https://github.com/prs-eth/Marigold
> 在线体验：https://huggingface.co/spaces/prs-eth/marigold-intrinsics

---

## 原理

一张带光影的图 = `albedo（固有色） × shading（光影）`。
Marigold-IID 用扩散模型把两者分离，我们取 **albedo** 就是去光后的结果。

两个可选模型：

| 模型 | model id | 输出 |
|---|---|---|
| **appearance**（默认） | `prs-eth/marigold-iid-appearance-v1-1` | albedo / roughness / metallicity |
| **lighting** | `prs-eth/marigold-iid-lighting-v1-1` | albedo / shading / residual |

单纯去光 → 用默认 appearance 即可。想顺带拿 PBR/光影图 → 见下方参数。

---

## 安装

在你的 Python 环境（建议和 ComfyUI 同一个 venv 或独立 venv）里：

```bash
pip install -U torch diffusers transformers accelerate pillow
```

> 首次运行会自动从 HuggingFace 下载模型（约 数 GB），需联网。
> 国内网络慢可设镜像：`set HF_ENDPOINT=https://hf-mirror.com`（Windows CMD）。

---

## 使用

### 最简单：拖拽运行
把图片文件（或文件夹）直接拖到 `启动去光.bat` 图标上。
输出为同目录下 `原名_albedo.png`（文件夹则输出到 `_delight/` 子目录）。

### 命令行

```bash
# 单张图去光
python delight_marigold.py input.png

# 指定输出
python delight_marigold.py input.png -o albedo.png

# 批量整个文件夹
python delight_marigold.py ./textures

# lighting 模型，并额外导出 shading 图
python delight_marigold.py input.png --model lighting --save-extra

# 输出保持与原图相同尺寸（回贴 3D 模型必开）
python delight_marigold.py input.png --keep-size
```

---

## 参数说明

| 参数 | 默认 | 作用 |
|---|---|---|
| `input` | 必填 | 图片文件 **或** 文件夹路径 |
| `-o/--output` | 自动 | 输出路径（单图时有效） |
| `--model` | appearance | `appearance` 或 `lighting` |
| `--steps` | 4 | 去噪步数（1–50，越大越精细越慢） |
| `--ensemble` | 1 | 集成次数（>1 更稳更慢） |
| `--resolution` | 768 | 处理分辨率长边（模型最佳 768） |
| `--keep-size` | 关 | 输出缩放回原图尺寸（**贴图回贴 3D 建议开**） |
| `--save-extra` | 关 | 同时保存其它模态（shading/roughness…） |
| `--device` | auto | `auto/cuda/mps/cpu` |
| `--dtype` | fp16 | `fp16/bf16/fp32` |

---

## 接进你现有流程

```
[QwenEdit_白模上色.json] → 出"带光影"贴图 (xxx.png)
        ↓
python delight_marigold.py xxx.png --keep-size   ← 本工具
        ↓
xxx_albedo.png（去光纯色贴图）→ 导入 3D 引擎，随意打光
```

---

## 调优建议

- **去光不够干净**：调大 `--steps`（如 10–20），或改用 `--model lighting`。
- **细节/颜色被改动太多**：Marigold 是分析型模型，一般能较好保留结构；若仍偏差，降 steps。
- **显存不足**：用 `--dtype fp16`，或 `--resolution 512`，或 `--device cpu`（慢）。
- **贴图尺寸要对齐 UV**：务必加 `--keep-size`，输出会缩放回输入原始分辨率。

---

## 注意

- Marigold 最佳有效分辨率约 **768**，超大图会先缩放到 768 处理，再（可选）放大回原尺寸。
- 模型基于 **Stable Diffusion 2** 微调，许可 CreativeML Open RAIL++-M。
- 该模型面向自然图像内在分解，对"贴图/UV展开图"这种非自然图像效果因图而异，建议先用一两张验证。
