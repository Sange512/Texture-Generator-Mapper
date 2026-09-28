# -*- coding: utf-8 -*-
"""
Marigold-IID 贴图去光脚本
=========================
调用官方 Marigold 内在图像分解（Intrinsic Image Decomposition, IID）模型，
把带光影的贴图（如 Qwen 白模上色输出）分解出去光后的 albedo（纯固有色）图。

模型：
  - appearance 版：prs-eth/marigold-iid-appearance-v1-1  → albedo / roughness / metallicity
  - lighting  版：prs-eth/marigold-iid-lighting-v1-1     → albedo / shading / residual

用法示例：
  # 单张图去光
  python delight_marigold.py input.png

  # 指定输出文件
  python delight_marigold.py input.png -o albedo.png

  # 批量处理整个文件夹（输出到 xxx_delight 子目录）
  python delight_marigold.py ./textures

  # 用 lighting 模型 + 同时导出 shading 图
  python delight_marigold.py input.png --model lighting --save-extra

  # 输出保持与原图相同尺寸（贴图回贴 3D 时建议开）
  python delight_marigold.py input.png --keep-size

依赖：
  pip install -U torch diffusers transformers accelerate pillow
"""

import argparse
import os
import sys

import torch
from PIL import Image

MODEL_IDS = {
    "appearance": "prs-eth/marigold-iid-appearance-v1-1",
    "lighting": "prs-eth/marigold-iid-lighting-v1-1",
}

IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")


def pick_device(user_choice: str) -> str:
    if user_choice != "auto":
        return user_choice
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def build_pipeline(model_key: str, device: str, dtype: torch.dtype):
    import diffusers

    model_id = MODEL_IDS[model_key]
    print(f"[加载模型] {model_id}  (device={device}, dtype={dtype})")
    pipe = diffusers.MarigoldIntrinsicsPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
    )
    pipe = pipe.to(device)
    # 关闭进度条噪声（可选）
    try:
        pipe.set_progress_bar_config(disable=False)
    except Exception:
        pass
    return pipe


def resize_long_edge(img: Image.Image, target: int) -> Image.Image:
    """把长边缩放到 target（Marigold 有效分辨率约 768），短边等比。"""
    w, h = img.size
    long_edge = max(w, h)
    if long_edge <= target:
        return img
    scale = target / float(long_edge)
    new_size = (round(w * scale), round(h * scale))
    return img.resize(new_size, Image.LANCZOS)


def extract_maps(pipe, prediction):
    """
    调用官方可视化接口，返回 {模态名: PIL.Image} 字典。
    兼容不同 diffusers 版本的返回结构。
    """
    vis = pipe.image_processor.visualize_intrinsics(
        prediction.prediction,
        pipe.target_properties,
    )
    # vis 通常是 list（batch 维度），取第一张
    first = vis[0] if isinstance(vis, (list, tuple)) else vis

    maps = {}
    if isinstance(first, dict):
        for k, v in first.items():
            # v 可能是 PIL.Image，也可能是 [PIL.Image] 列表
            if isinstance(v, (list, tuple)):
                v = v[0]
            if isinstance(v, Image.Image):
                maps[k] = v
    return maps


def process_one(pipe, in_path: str, out_path: str, args):
    image = Image.open(in_path).convert("RGB")
    orig_size = image.size

    proc_img = image if args.keep_size and args.resolution <= 0 else resize_long_edge(
        image, args.resolution if args.resolution > 0 else 768
    )

    with torch.no_grad():
        prediction = pipe(
            proc_img,
            num_inference_steps=args.steps,
            ensemble_size=args.ensemble,
        )

    maps = extract_maps(pipe, prediction)
    if not maps:
        raise RuntimeError("未能从模型输出中解析出任何贴图，请检查 diffusers 版本。")

    # 选取 albedo（不同版本键名统一为 albedo）
    albedo_key = None
    for k in maps:
        if "albedo" in k.lower():
            albedo_key = k
            break
    if albedo_key is None:
        albedo_key = list(maps.keys())[0]
        print(f"[警告] 未找到 albedo 键，退化使用第一个输出：{albedo_key}")

    albedo = maps[albedo_key]
    if args.keep_size:
        albedo = albedo.resize(orig_size, Image.LANCZOS)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    albedo.save(out_path)
    print(f"[完成] 去光贴图 -> {out_path}")

    if args.save_extra:
        stem, ext = os.path.splitext(out_path)
        for k, v in maps.items():
            if k == albedo_key:
                continue
            extra_path = f"{stem}_{k}{ext}"
            if args.keep_size:
                v = v.resize(orig_size, Image.LANCZOS)
            v.save(extra_path)
            print(f"[附加] {k} -> {extra_path}")


def gather_inputs(path: str):
    if os.path.isfile(path):
        return [path]
    if os.path.isdir(path):
        files = []
        for name in sorted(os.listdir(path)):
            if name.lower().endswith(IMG_EXTS):
                files.append(os.path.join(path, name))
        return files
    return []


def default_out_path(in_path: str, is_batch: bool):
    stem, ext = os.path.splitext(in_path)
    if is_batch:
        d = os.path.dirname(in_path)
        out_dir = os.path.join(d, "_delight")
        base = os.path.basename(stem)
        return os.path.join(out_dir, f"{base}_albedo.png")
    return f"{stem}_albedo.png"


def main():
    parser = argparse.ArgumentParser(
        description="Marigold-IID 贴图去光：输出去除光影后的 albedo 图"
    )
    parser.add_argument("input", help="输入图片文件 或 文件夹路径")
    parser.add_argument("-o", "--output", default=None, help="输出文件路径（单图时有效）")
    parser.add_argument(
        "--model", choices=["appearance", "lighting"], default="appearance",
        help="appearance=出albedo/粗糙度/金属度；lighting=出albedo/shading/residual（默认 appearance）",
    )
    parser.add_argument("--steps", type=int, default=4, help="去噪步数（1-50，默认 4，越大越精细越慢）")
    parser.add_argument("--ensemble", type=int, default=1, help="集成次数（>1 更稳但更慢，默认 1）")
    parser.add_argument("--resolution", type=int, default=768, help="处理分辨率长边（默认 768，模型最佳分辨率）")
    parser.add_argument("--keep-size", action="store_true", help="输出缩放回原图尺寸（贴图回贴 3D 建议开）")
    parser.add_argument("--save-extra", action="store_true", help="同时保存其它模态（shading/roughness 等）")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"], help="计算设备")
    parser.add_argument("--dtype", default="fp16", choices=["fp16", "bf16", "fp32"], help="精度（默认 fp16）")
    args = parser.parse_args()

    inputs = gather_inputs(args.input)
    if not inputs:
        print(f"[错误] 找不到输入图片：{args.input}")
        sys.exit(1)

    device = pick_device(args.device)
    dtype_map = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}
    dtype = dtype_map[args.dtype]
    if device == "cpu" and dtype != torch.float32:
        print("[提示] CPU 下强制使用 fp32")
        dtype = torch.float32

    try:
        pipe = build_pipeline(args.model, device, dtype)
    except AttributeError:
        print("[错误] 当前 diffusers 版本不含 MarigoldIntrinsicsPipeline，请升级：")
        print("       pip install -U diffusers")
        sys.exit(1)

    is_batch = len(inputs) > 1
    for in_path in inputs:
        if is_batch:
            out_path = default_out_path(in_path, is_batch=True)
        else:
            out_path = args.output or default_out_path(in_path, is_batch=False)
        try:
            process_one(pipe, in_path, out_path, args)
        except Exception as e:
            print(f"[失败] {in_path} : {e}")

    print("全部处理完成。")


if __name__ == "__main__":
    main()
