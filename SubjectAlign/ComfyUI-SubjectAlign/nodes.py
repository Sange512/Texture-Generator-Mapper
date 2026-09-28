# -*- coding: utf-8 -*-
"""
ComfyUI 节点: 模型主体对齐 (Subject Align)
把 AI 生成的带贴图图, 对齐到同视角白模图, 并输出对齐图 / 遮罩 / 叠加预览。

采用经典节点结构(NODE_CLASS_MAPPINGS), 兼容各版本 ComfyUI。
"""
import numpy as np
import torch
import cv2

from .align_core import align_core


# ---------- ComfyUI 张量 <-> OpenCV(BGR) 互转 ----------
def _tensor_to_bgr(img_hwc):
    """ComfyUI 单张 IMAGE ([H,W,3] float 0..1, RGB) -> OpenCV BGR uint8。"""
    arr = img_hwc.detach().cpu().numpy()
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _bgr_to_tensor(bgr):
    """OpenCV BGR uint8 -> ComfyUI 单张 IMAGE 张量 [H,W,3] float 0..1 RGB。"""
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return torch.from_numpy(rgb)


def _alpha_to_mask(alpha_u8):
    """单通道 alpha(uint8) -> ComfyUI MASK 张量 [H,W] float 0..1。"""
    return torch.from_numpy(alpha_u8.astype(np.float32) / 255.0)


def _resize_bgr(bgr, w, h):
    if bgr.shape[1] == w and bgr.shape[0] == h:
        return bgr
    interp = cv2.INTER_AREA if (w < bgr.shape[1] or h < bgr.shape[0]) else cv2.INTER_LANCZOS4
    return cv2.resize(bgr, (w, h), interpolation=interp)


class SubjectAlignNode:
    """将 AI 生成贴图对齐到白模图。输出对齐图、遮罩(MASK)、叠加预览、信息。"""

    CATEGORY = "image/对齐"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "STRING")
    RETURN_NAMES = ("对齐图", "遮罩", "叠加预览", "信息")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "白模图": ("IMAGE",),
                "AI生成图": ("IMAGE",),
                "精对齐ECC": ("BOOLEAN", {"default": True}),
                "高分辨率超采样": ("BOOLEAN", {"default": True}),
                "输出用白模图分辨率": ("BOOLEAN", {"default": True}),
            }
        }

    def run(self, 白模图, AI生成图, 精对齐ECC, 高分辨率超采样, 输出用白模图分辨率):
        ref_batch = 白模图
        mov_batch = AI生成图
        n = int(mov_batch.shape[0])
        n_ref = int(ref_batch.shape[0])

        aligned_list, mask_list, overlay_list, infos = [], [], [], []
        for i in range(n):
            ref_bgr = _tensor_to_bgr(ref_batch[min(i, n_ref - 1)])
            mov_bgr = _tensor_to_bgr(mov_batch[i])
            r = align_core(ref_bgr, mov_bgr,
                           ecc=bool(精对齐ECC),
                           hires=bool(高分辨率超采样),
                           match_ref_res=bool(输出用白模图分辨率))
            aligned_list.append(r["aligned"])
            overlay_list.append(r["overlay"])
            mask_list.append(r["alpha"])
            infos.append(
                f"[{i}] 方式={r['method']} 缩放={r['scale']:.3f} 有效缩放={r['eff_scale']:.3f} "
                f"尺寸={r['out_size'][0]}x{r['out_size'][1]} IoU {r['iou_before']:.3f}->{r['iou_after']:.3f}"
            )

        # 统一到第一张的尺寸, 保证可堆叠成一个批次张量
        th, tw = aligned_list[0].shape[:2]
        aligned_t, mask_t, overlay_t = [], [], []
        for a, m, o in zip(aligned_list, mask_list, overlay_list):
            a = _resize_bgr(a, tw, th)
            o = _resize_bgr(o, tw, th)
            if m.shape[1] != tw or m.shape[0] != th:
                m = cv2.resize(m, (tw, th), interpolation=cv2.INTER_AREA)
            aligned_t.append(_bgr_to_tensor(a))
            overlay_t.append(_bgr_to_tensor(o))
            mask_t.append(_alpha_to_mask(m))

        aligned = torch.stack(aligned_t, dim=0)
        overlay = torch.stack(overlay_t, dim=0)
        mask = torch.stack(mask_t, dim=0)
        info = "\n".join(infos)
        return (aligned, mask, overlay, info)


class ApplyAlphaToImageNode:
    """把 IMAGE 和 MASK 合成为带透明通道的 RGBA IMAGE(4通道), 便于保存透明PNG。
    (SaveImage 保存 4 通道 IMAGE 时会写出带 alpha 的 PNG)"""

    CATEGORY = "image/对齐"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("RGBA图",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "遮罩": ("MASK",),
            }
        }

    def run(self, 图像, 遮罩):
        img = 图像  # [B,H,W,3]
        m = 遮罩     # [B,H,W]
        if m.dim() == 2:
            m = m.unsqueeze(0)
        # 尺寸对齐(遮罩缩放到图像大小)
        b, h, w, _ = img.shape
        if m.shape[1] != h or m.shape[2] != w:
            m = torch.nn.functional.interpolate(
                m.unsqueeze(1), size=(h, w), mode="bilinear", align_corners=False
            ).squeeze(1)
        if m.shape[0] != b:
            m = m[:1].repeat(b, 1, 1)
        rgba = torch.cat([img, m.unsqueeze(-1)], dim=-1)  # [B,H,W,4]
        return (rgba,)


NODE_CLASS_MAPPINGS = {
    "SubjectAlign": SubjectAlignNode,
    "ApplyAlphaToImage": ApplyAlphaToImageNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SubjectAlign": "主体对齐 (白模↔AI贴图)",
    "ApplyAlphaToImage": "图像+遮罩→透明RGBA",
}
